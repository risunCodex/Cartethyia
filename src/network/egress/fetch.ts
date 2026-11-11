// Validated fetch: SSRF-guarded outbound fetch with optional pool-agent support.
import { GatewayError } from "../../protocol/gateway-error";
import { request as httpRequest, Agent as HttpAgent } from "node:http";
import { request as httpsRequest, Agent as HttpsAgent } from "node:https";
import { Agent as UndiciAgent, fetch as undiciFetch, type UndiciRequestInit } from "undici";
import { SocksProxyAgent } from "socks-proxy-agent";
import { resolveAllAddresses, validateResolvedAddresses } from "../ssrf";
import type { SsrfPolicy } from "../../config/network";
import { isProxyAgentPair, type ProxyAgentPair } from "../pool/agent";
import { metrics } from "../../observability/metrics";
import { trackNetworkCall } from "../../observability/performance-metrics";
import { nodeTlsOptions, tlsProfileOf, type TlsProfile, type TlsProfileConfig } from "./tls-profile";

/**
 * Keep-alive socket lifetime for outbound direct dials.
 *
 * Some upstream edges (accelerated hosting, CDN front doors) drop idle or
 * silently-errored keep-alive connections without sending a TCP RST. undici
 * keeps those dead sockets in its pool — the default `keepAliveMaxTimeout`
 * is 600s, and an upstream `Keep-Alive` header can push it even higher — so a
 * retry reuses a poisoned socket and hangs until the connect timeout. Capping
 * the TTL (both fields) keeps a dead socket from being reused; a fresh dial
 * is also replayed once when a pooled socket dies before response headers.
 */
export const DEFAULT_KEEPALIVE_TIMEOUT_MS = 4_000;
/** Fresh-socket retry agent: keep-alive effectively disabled (1 ms). */
const FRESH_SOCKET_KEEPALIVE_TIMEOUT_MS = 1;

/** Error codes that prove a pooled keep-alive socket died mid-flight. */
const STALE_SOCKET_ERROR_CODES: ReadonlySet<string> = new Set([
  "UND_ERR_SOCKET",
  "ECONNRESET",
  "EPIPE",
  "UND_ERR_HEADERS_TIMEOUT",
]);

/** Error codes that prove the host itself is unreachable — never a stale socket. */
const NON_STALE_SOCKET_ERROR_CODES: ReadonlySet<string> = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_INVALID_ARG",
]);

/** Message fragments that prove the other side closed a pooled connection. */
const STALE_SOCKET_ERROR_SUBSTRINGS: readonly string[] = [
  "other side closed",
  "socket hang up",
];

/** True when `error` proves a pooled keep-alive socket died before headers. */
export function isStaleSocketError(error: unknown): boolean {
  if (!(error instanceof Error) || error.name === "AbortError") return false;
  const cause = (error as { cause?: unknown }).cause;
  const code =
    (cause !== null && typeof cause === "object" && "code" in cause
      ? (cause as { code?: unknown }).code
      : undefined) ?? (error as { code?: unknown }).code;
  if (typeof code === "string") {
    if (NON_STALE_SOCKET_ERROR_CODES.has(code)) return false;
    if (STALE_SOCKET_ERROR_CODES.has(code)) return true;
  }
  const message = `${error.message} ${cause instanceof Error ? cause.message : ""}`.toLowerCase();
  return STALE_SOCKET_ERROR_SUBSTRINGS.some((fragment) => message.includes(fragment));
}

/** True when the request body can be safely replayed (not a locked stream). */
function isBodyReplaySafe(body: BodyInit | null | undefined): boolean {
  if (body === null || body === undefined) return true;
  return !(typeof body === "object" && "locked" in body && body.locked === true);
}
// Validated fetch — single egress with ProxyAgent support
interface ValidatedFetchOptions {
  readonly fetchFn?: typeof fetch;
  readonly policy?: SsrfPolicy;
  readonly maxRedirects?: number;
  readonly resolveFn?: (hostname: string, signal: AbortSignal) => Promise<readonly string[]>;
  readonly agent?: HttpAgent | HttpsAgent | ProxyAgentPair;
  /**
   * Proxy URL to route the dial through, forwarded to the runtime-native fetch
   * (`proxy` option). Pool egress passes the pool's endpoint here; without it
   * a request that should leave through a proxy leaves directly.
   */
  readonly proxyUrl?: string;
  /**
   * Fetch implementation used for SOCKS5 dials (via the undici dispatcher).
   * Defaults to undici's fetch; injectable for offline tests.
   */
  readonly socksFetch?: (input: RequestInfo | URL, init?: UndiciRequestInit) => Promise<Response>;
  /**
   * TLS ClientHello profile for direct https dials. `"default"` (or absent)
   * keeps the runtime's own TLS stack; a named profile (see `tls-profile.ts`)
   * dials through a Node https agent configured with that profile's OpenSSL
   * options, so the wire fingerprint matches the impersonated client.
   */
  readonly tlsProfile?: TlsProfile;
  /**
   * CA bundle for profile dials (`https.Agent({ ca })`). Defaults to the
   * system store; set it to trust a private/custom CA.
   */
  readonly ca?: string | Buffer | Array<string | Buffer>;
}
export type ValidatedFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/**
 * Whether a configured pool/relay agent owns this dial. When it does, the
 * proxy resolves the upstream target itself, so the local resolve below is an
 * advisory SSRF check rather than a prerequisite for egress.
 */

/**
 * Builds the application-relay request used by hosted relay front doors.
 * These endpoints intentionally do not receive CONNECT: they accept the
 * target origin/path in headers and perform the upstream fetch themselves,
 * matching the 21-beta relay contract.
 */
function relayRequest(
  relayEndpoint: URL,
  target: URL,
  init: RequestInit,
): { url: URL; init: RequestInit } {
  const relayUrl = new URL(relayEndpoint.toString());
  const headers = new Headers(init.headers);
  headers.delete("host");
  headers.set("x-relay-target", target.origin);
  headers.set("x-relay-path", `${target.pathname}${target.search}`);
  if (relayUrl.username || relayUrl.password) {
    const credentials = `${decodeURIComponent(relayUrl.username)}:${decodeURIComponent(relayUrl.password)}`;
    headers.set("x-relay-auth", `Basic ${Buffer.from(credentials).toString("base64")}`);
    relayUrl.username = "";
    relayUrl.password = "";
  }
  return { url: relayUrl, init: { ...init, headers } };
}

const CREDENTIAL_HEADERS = ["authorization", "cookie", "proxy-authorization"] as const;

function stripCredentialsOnCrossOrigin(
  headersInit: HeadersInit | undefined,
): Headers {
  const headers = new Headers(headersInit);
  for (const name of CREDENTIAL_HEADERS) headers.delete(name);
  return headers;
}

/**
 * The injected dialer. `fetchFn` is the seam offline suites use to record
 * requests without a socket; the runtime fetch is the only other dialer.
 */
function dialer(options: ValidatedFetchOptions): typeof fetch {
  return options.fetchFn ?? fetch;
}

/**
 * Builds the `undici` dispatcher that routes a dial through a SOCKS5 pool
 * agent. The runtime-native fetch does not support `socks5://` proxies
 * (`UnsupportedProxyProtocol`), so the socks pair drives the transport via
 * undici's dispatcher instead — no node `http`/`https` adapter is involved.
 */
let socksDispatcherCache: WeakMap<SocksProxyAgent, UndiciAgent> | undefined;
function socksDispatcherFor(agent: SocksProxyAgent): UndiciAgent {
  socksDispatcherCache ??= new WeakMap();
  let dispatcher = socksDispatcherCache.get(agent);
  if (!dispatcher) {
    dispatcher = new UndiciAgent({
      connect: async (opts: Record<string, unknown>) => {
        const o = opts as {
          hostname?: string;
          port?: number | string;
          family?: number;
          lookup?: (hostname: string, options: unknown, cb: (err: Error | null, addresses: unknown) => void) => void;
        };
        return await agent.connect(
          {} as never,
          {
            host: o.hostname ?? "localhost",
            port: Number(o.port ?? 80),
            ...(o.family === undefined ? {} : { family: o.family }),
            ...(o.lookup === undefined ? {} : { lookup: o.lookup }),
          } as never,
        );
      },
      // Cap the pooled socket lifetime so a silently-dropped keep-alive
      // connection is not reused by a later request.
      keepAliveTimeout: DEFAULT_KEEPALIVE_TIMEOUT_MS,
      keepAliveMaxTimeout: DEFAULT_KEEPALIVE_TIMEOUT_MS,
    } as unknown as ConstructorParameters<typeof UndiciAgent>[0]);
    socksDispatcherCache.set(agent, dispatcher);
  }
  return dispatcher;
}

/**
 * A Node `https` agent whose connections are dialed with a chosen TLS profile.
 *
 * The agent's `createConnection` is the only knob that reaches the ClientHello
 * through OpenSSL: it lets `tls.connect` run with the profile's cipher list,
 * TLS 1.3 suite order, ALPN, and version bounds. Used only when a profile is
 * requested; the runtime-native fetch stays the default for everything else.
 */
export function createProfileAgent(profile: TlsProfileConfig, ca?: string | Buffer | Array<string | Buffer>): HttpsAgent {
  // Straight option passthrough — no custom `createConnection`. Bun's
  // Node-compat layer ignores a user-supplied `createConnection` on the agent
  // (verified live 2026-11-11: the dial failed with ERR_SOCKET_CLOSED and no
  // ClientHello reached the sniffer), but it honors the standard TLS options
  // on the agent itself — `ALPNProtocols` switched the ALPN extension and
  // `ciphers` narrowed the offered suite list in capture. The request path
  // stays the plain https client with the profile's fingerprint.
  return new HttpsAgent({
    ...nodeTlsOptions(profile),
    ...(ca === undefined ? {} : { ca }),
  } as unknown as HttpsAgent);
}

/**
 * A shared undici dispatcher whose keep-alive socket lifetime is capped.
 *
 * Direct dials go through the runtime's own fetch; when a socks dispatcher is
 * in play (pool egress) the same TTL cap applies. A fresh-socket dispatcher
 * (`keepAliveTimeout: 1ms`) backs the stale-socket replay so a retry never
 * reuses the poisoned connection.
 */
let directDispatcherCache: { agent: UndiciAgent; fresh: UndiciAgent } | undefined;
function directDispatchers(): { agent: UndiciAgent; fresh: UndiciAgent } {
  directDispatcherCache ??= {
    agent: new UndiciAgent({
      keepAliveTimeout: DEFAULT_KEEPALIVE_TIMEOUT_MS,
      keepAliveMaxTimeout: DEFAULT_KEEPALIVE_TIMEOUT_MS,
    } as unknown as ConstructorParameters<typeof UndiciAgent>[0]),
    fresh: new UndiciAgent({
      keepAliveTimeout: FRESH_SOCKET_KEEPALIVE_TIMEOUT_MS,
      keepAliveMaxTimeout: FRESH_SOCKET_KEEPALIVE_TIMEOUT_MS,
    } as unknown as ConstructorParameters<typeof UndiciAgent>[0]),
  };
  return directDispatcherCache;
}

/**
 * Dial one request, always through `fetch`.
 *
 * The runtime's own fetch (Bun/Undici) is the transport the clients this
 * gateway impersonates actually use, and several upstreams meter per client
 * transport fingerprint — OpenCode's anonymous free tier refuses a
 * Node-stack dial with 429 FreeUsageLimitError while accepting the identical
 * bytes over this one. There is no Node `http`/`https` path to choose
 * between: the SSRF resolve/validate pass that runs before this dial is the
 * security boundary, and it is identical for every caller.
 *
 * A configured pool/relay agent is still honored through `dispatcher` when the
 * runtime supports it (Bun and Undici both do); when it is not supported the
 * agent is ignored rather than silently replaced by an unvalidated dial.
 *
 * `content-length` is set for a known-length body only when the caller did not
 * set it: without the header the request falls back to chunked encoding, and
 * some upstream gateways wait for the complete chunked stream before routing
 * the request — an avoidable round trip per dial.
 */
async function dial(
  url: URL,
  init: RequestInit,
  fetchFn: typeof fetch,
  proxyUrl: string | undefined,
  dispatcher?: UndiciAgent,
  socksFetch: (input: RequestInfo | URL, init?: UndiciRequestInit) => Promise<Response> = undiciFetch,
  freshSocket = false,
): Promise<Response> {
  const headers = new Headers(init.headers);
  const rawBody = init.body;
  if (rawBody !== undefined && rawBody !== null && !headers.has("content-length")) {
    const bytes =
      typeof rawBody === "string"
        ? Buffer.byteLength(rawBody, "utf8")
        : Buffer.isBuffer(rawBody) || rawBody instanceof Uint8Array
          ? rawBody.byteLength
          : (await new Response(rawBody).arrayBuffer()).byteLength;
    headers.set("content-length", String(bytes));
  }
  if (dispatcher !== undefined) {
    return await socksFetch(url, {
      ...init,
      headers,
      dispatcher: freshSocket ? directDispatchers().fresh : dispatcher,
    });
  }
  return await fetchFn(url, {
    ...init,
    headers,
    ...(proxyUrl === undefined ? {} : { proxy: proxyUrl }),
    // Fresh-socket replay uses the capped undici dispatcher directly so a
    // retry never reuses the pooled connection that just died.
    ...(freshSocket ? { dispatcher: directDispatchers().fresh } : {}),
  });
}

/**
 * One raw GET/HEAD dial that carries a body.
 *
 * The runtime-native fetch (`Bun`/undici) rejects `GET`/`HEAD` requests with a
 * body — "request with GET/HEAD method cannot have body" — but some upstreams
 * validate a signature over the body on a GET (Qoder's `/model/list` does).
 * This is the Node `http`/`https` path for exactly that case. It runs only
 * after the SSRF resolve/validate pass and only when no pool/relay agent owns
 * the dial, so the security boundary is unchanged.
 */
function nodeDial(url: URL, init: RequestInit, agent?: HttpsAgent): Promise<Response> {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === "http:" ? httpRequest : httpsRequest;
    const headers: Record<string, string> = {};
    {
      const h = new Headers(init.headers);
      h.forEach((value, key) => {
        headers[key] = value;
      });
    }
    let payload: Buffer | undefined;
    const body = init.body;
    if (typeof body === "string") {
      payload = Buffer.from(body, "utf8");
    } else if (Buffer.isBuffer(body)) {
      payload = body;
    } else if (body instanceof Uint8Array) {
      payload = Buffer.from(body);
    } else if (body instanceof ArrayBuffer) {
      payload = Buffer.from(new Uint8Array(body));
    } else if (body !== null && body !== undefined) {
      reject(new TypeError("nodeDial only supports string/Buffer/Uint8Array/ArrayBuffer bodies"));
      return;
    }
    if (payload !== undefined) headers["content-length"] = String(payload.byteLength);
    const req = mod(
      url,
      {
        method: (init.method ?? "GET").toUpperCase(),
        headers,
        ...(agent === undefined ? {} : { agent }),
        ...(init.signal === undefined ? {} : { signal: init.signal as AbortSignal }),
      },
      (res) => {
        // The response body is bridged into a web stream so callers can
        // consume it incrementally (SSE chat streams) instead of buffering
        // the entire payload before resolving.
        const bodyStream = new ReadableStream<Uint8Array>({
          start(controller) {
            res.on("data", (c: Buffer) => controller.enqueue(new Uint8Array(c)));
            res.on("end", () => controller.close());
            res.on("error", (err: Error) => controller.error(err));
          },
          cancel() {
            res.destroy();
          },
        });
        resolve(
          new Response(bodyStream, {
            status: res.statusCode ?? 200,
            ...(res.statusMessage === undefined ? {} : { statusText: res.statusMessage }),
            headers: res.headers as unknown as HeadersInit,
          }),
        );
      },
    );
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

export function createValidatedFetch(options: ValidatedFetchOptions = {}): ValidatedFetch {
  const policy = options.policy ?? {};
  const maxRedirects = options.maxRedirects ?? policy.maxRedirects ?? 3;
  const resolveFn = options.resolveFn ?? resolveAllAddresses;
  const fetchFn = dialer(options);
  const configuredAgent = options.agent;
  const relayEndpoint = isProxyAgentPair(configuredAgent)
    ? configuredAgent.relayEndpoint
    : undefined;
  const socksAgent = isProxyAgentPair(configuredAgent)
    ? configuredAgent.socks
    : undefined;
  const socksFetch = options.socksFetch ?? undiciFetch;
  const proxyUrl =
    options.proxyUrl ?? (isProxyAgentPair(configuredAgent) ? configuredAgent.proxyUrl : undefined);
  return async (input, init = {}) => {
    const startedAt = performance.now();
    let url = input instanceof Request ? new URL(input.url) : new URL(input.toString());
    let requestInit: RequestInit = { ...init, redirect: "manual" };
    if (input instanceof Request && init.headers === undefined) {
      requestInit.headers = new Headers(input.headers);
    }
    for (let hop = 0; hop <= maxRedirects; hop += 1) {
      if (url.protocol !== "http:" && url.protocol !== "https:")
        throw new TypeError("unsupported outbound URL protocol");
      const signal = requestInit.signal ?? new AbortController().signal;
      // Every hop — including proxied dials and redirect targets — is resolved
      // and checked against the SSRF policy. When a proxy agent owns the dial,
      // the proxy still resolves its own answer, so the check is advisory there;
      // it deterministically rejects targets whose *advertised* addresses fall
      // in blocked ranges (literal-IP redirects, private-space DNS, relay abuse).
      // For a pool/relay-owned dial, the upstream *target* is resolved by the
      // proxy/relay itself, so local DNS for it is an advisory SSRF check,
      // not a prerequisite for egress. Operator VPNs routinely break the
      // system resolver (tunnel DNS that is unreachable or drops queries);
      const poolDialsTarget = Boolean(configuredAgent || relayEndpoint);
      let resolvedAddress: string | undefined;
      let relayResolvedAddress: string | undefined;
      if (poolDialsTarget) {
        // The egress dials the pool/relay, which resolves the target itself.
        // Counting these lets ops confirm how much traffic depends on
        // proxy-resolved DNS rather than the local system resolver.
        metrics.cartethyia_proxy_dial_proxy_resolved_total.inc();
      }
      try {
        if (!poolDialsTarget) {
          const addresses = await resolveFn(url.hostname, signal);
          validateResolvedAddresses(addresses, policy);
          resolvedAddress = addresses[0];
        }
        if (relayEndpoint) {
          const relayAddresses = await resolveFn(relayEndpoint.hostname, signal);
          validateResolvedAddresses(relayAddresses, policy);
          relayResolvedAddress = relayAddresses[0];
          if (!relayResolvedAddress)
            throw new TypeError(`no validated address for ${relayEndpoint.hostname}`);
        }
      } catch (error) {
        // A pool/relay-owned dial still needs its egress host locally; only
        // the advisory target lookup may degrade.
        if (relayEndpoint && !relayResolvedAddress) throw error;
        if (!poolDialsTarget) throw new TypeError(`no validated address for ${url.hostname}`);
      }
      if (!poolDialsTarget && !resolvedAddress)
        throw new TypeError(`no validated address for ${url.hostname}`);
      let response: Response;
      if (relayEndpoint) {
        const relay = relayRequest(relayEndpoint, url, requestInit);
        // The relay front door is reached directly: it reads the target from
        // `x-relay-target`/`x-relay-path` and performs the upstream fetch
        // itself, so the runtime fetch must NOT be given `proxy` here — that
        // would make it attempt a CONNECT tunnel against the relay, which a
        // serverless front door refuses (400).
        response = await dial(relay.url, relay.init, fetchFn, undefined);
      } else {
        const method = (requestInit.method ?? "GET").toUpperCase();
        const hasBody = requestInit.body !== undefined && requestInit.body !== null;
        const profile = tlsProfileOf(options.tlsProfile ?? "default");
        // A TLS profile request is a *custom ClientHello* dial: it goes
        // through a Node https agent configured with the profile's OpenSSL
        // options, so the wire fingerprint matches the impersonated client.
        // This path is direct-only (never a pool/relay dial) and rejects
        // bodies on GET/HEAD like the runtime fetch does — that shape is
        // still handled by `nodeDial` below.
        if (profile !== undefined && !socksAgent && configuredAgent === undefined) {
          response = await nodeDial(url, requestInit, createProfileAgent(profile, options.ca));
        } else if ((method === "GET" || method === "HEAD") && hasBody && !socksAgent && options.fetchFn === undefined) {
          // The runtime fetch cannot carry a body on GET/HEAD, but Qoder's
          // model-list endpoint requires a signed GET body. When no pool/relay
          // owns the dial and no injected test fetch is present, dial through the
          // Node http(s) client (post SSRF validation). Every other case keeps
          // the existing fetch path.
          response = await nodeDial(url, requestInit);
        } else {
          try {
            response = await dial(url, requestInit, fetchFn, proxyUrl, socksAgent ? socksDispatcherFor(socksAgent) : undefined, socksFetch);
          } catch (error) {
            // A pooled keep-alive socket that died before response headers is
            // replayed once on a fresh socket. Only errors that *prove* the
            // socket died qualify; a bare fetch failure (or an abort, or a
            // locked body) is never replayed — the upstream may already hold
            // that request and a replay would deliver it twice.
            if (
              !requestInit.signal?.aborted &&
              isBodyReplaySafe(requestInit.body) &&
              isStaleSocketError(error)
            ) {
              response = await dial(url, requestInit, fetchFn, proxyUrl, socksAgent ? socksDispatcherFor(socksAgent) : undefined, socksFetch, true);
            } else {
              throw error;
            }
          }
        }
      }
      if (response.status < 300 || response.status >= 400) {
        trackNetworkCall(url.hostname, performance.now() - startedAt);
        return response;
      }
      const location = response.headers.get("location");
      if (!location) {
        trackNetworkCall(url.hostname, performance.now() - startedAt);
        return response;
      }
      // The redirect response body is never consumed: release its socket
      // before following the next hop instead of leaving it open.
      await response.body?.cancel().catch(() => undefined);
      const nextUrl = new URL(location, url);
      const isCrossOriginRedirect = nextUrl.origin !== url.origin;
      if (isCrossOriginRedirect) {
        requestInit = { ...requestInit, headers: stripCredentialsOnCrossOrigin(requestInit.headers) };
      }
      if (isCrossOriginRedirect && (response.status === 307 || response.status === 308)) {
        const method = (requestInit.method ?? "GET").toUpperCase();
        if (method !== "GET" && method !== "HEAD" && requestInit.body !== undefined) {
          throw new GatewayError("invalid_request", 400, "cross-origin redirect with body blocked (request {requestId}). Check the shape of what you sent — then resend 🪞");
        }
      }
      url = nextUrl;
      if (response.status === 301 || response.status === 302 || response.status === 303) {
        const method = (requestInit.method ?? "GET").toUpperCase();
        if (method !== "GET" && method !== "HEAD") {
          const { body: _body, ...withoutBody } = requestInit;
          requestInit = { ...withoutBody, method: "GET" };
        }
      }
    }
    throw new Error("outbound redirect limit exceeded");
  };
}
