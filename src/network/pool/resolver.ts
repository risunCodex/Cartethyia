/**
 * `PoolAgentResolver` — builds, caches, and reaps the per-pool egress agents
 * on demand — and `ValidatedNetworkBindingFactory`, which resolves upstream
 * names once through the SSRF policy and hands dispatch a validated fetch
 * (direct or pool-bound).
 */
import type { CartethyiaDatabase } from "../../persistence/db-handle";
import {
  isAddressAllowed,
  resolveAllAddresses,
  resolveAndValidateOnce,
  type ValidatedDestination,
} from "../ssrf";
import { createValidatedFetch, type ValidatedFetch } from "../outbound-fetch";
import { GatewayError } from "../../protocol/gateway-error";
import type { SsrfPolicy } from "../../config/network";
import { log } from "../../observability/logger";
import type { TransportKind, PoolAgent } from "./agent";
import { isIP } from "node:net";
import * as tls from "node:tls";
import * as http2 from "node:http2";
import type { Duplex } from "node:stream";
import WebSocket, { type ClientOptions, type RawData } from "ws";
import { isProxyAgentPair, createHttpProxyAgent, createSocks5Agent, PoolBindingError } from "./agent";
import { Agent as HttpsAgent } from "node:https";
import { parseAgentConfig, ProxyConfigError, type AgentConfig } from "../types";
import type { ProviderWebSocketSession, ValidatedOutboundWebSocket, ValidatedOutboundHttp2Bidi } from "../../providers/provider-contracts";
import type { Http2BidiEndReason, Http2BidiOpenOptions, ValidatedHttp2BidiStream } from "../http2-bidi";

/** Idle time after which an unused pool agent is destroyed. */
const POOL_AGENT_IDLE_MS = 10 * 60_000;
/** Maximum number of concurrent pool agents to prevent unbounded growth. */
const MAX_POOL_AGENTS = 1000;
/** Minimum gap between idle-time sweeps; the per-resolve scan is the hot cost. */
const POOL_AGENT_SWEEP_INTERVAL_MS = 30_000;
/** Time allowed for one HTTP/2 connection (TCP + TLS + preface) to establish. */
const HTTP2_CONNECT_TIMEOUT_MS = 15_000;
/** Read-idle bound after which a bidi stream is declared dead. */
const HTTP2_READ_IDLE_MS = 120_000;
/** Buffered inbound bytes before a bidi stream is refused as unbounded. */
const HTTP2_MAX_BUFFERED_BYTES = 64 * 1024 * 1024;
/**
 * Session memory ceiling for one HTTP/2 session.
 *
 * Node and Bun count a session's unsent bytes against `maxSessionMemory`
 * (10 MB by default) and, once over it, fail every new stream with
 * `ENHANCE_YOUR_CALM`. A bidi Run request and its KV replies run to many
 * megabytes and the caller holds those bytes anyway, so the default only adds
 * a failure mode.
 */
const HTTP2_SESSION_MAX_MEMORY_MB = 256;

export interface PoolAgentResolverDeps {
  readonly ssrfPolicy?: SsrfPolicy;
  readonly resolveFn?: (hostname: string, signal: AbortSignal) => Promise<readonly string[]>;
  /** Database used to load pool rows. */
  readonly db?: CartethyiaDatabase;
}

function destroyAgent(agent: unknown): void {
  if (isProxyAgentPair(agent)) {
    destroyAgent(agent.http);
    destroyAgent(agent.https);
    return;
  }
  const maybeDestroy = (agent as { destroy?: unknown }).destroy;
  if (typeof maybeDestroy === "function") {
    try {
      (maybeDestroy as () => void).call(agent);
      return;
    } catch (error) {
      // Destroy failure means sockets may outlive the agent — surface it
      // instead of silently leaking the pool's connections.
      log.warn("[pool-agent] destroy failed", error);
    }
  }
  const maybeClose = (agent as { close?: unknown }).close;
  if (typeof maybeClose === "function") {
    try {
      (maybeClose as () => void).call(agent);
    } catch (error) {
      log.warn("[pool-agent] close failed", error);
    }
  }
}

async function validateDialHost(
  hostname: string,
  policy: SsrfPolicy,
  resolveFn: (hostname: string, signal: AbortSignal) => Promise<readonly string[]>,
): Promise<void> {
  if (isIP(hostname) !== 0) {
    if (!isAddressAllowed(hostname, policy))
      throw new PoolBindingError(`pool endpoint resolves to disallowed address: ${hostname}`);
    return;
  }
  const addresses = await resolveFn(hostname, AbortSignal.timeout(5000));
  for (const address of addresses) {
    if (!isAddressAllowed(address, policy))
      throw new PoolBindingError(`pool endpoint resolves to disallowed address: ${address}`);
  }
}

function endpointHostname(kind: TransportKind, endpoint: string): string | undefined {
  try {
    if (kind === "http" || kind === "https") {
      const url = new URL(endpoint);
      return url.hostname || undefined;
    }
    if (kind === "socks5") {
      const authority = endpoint.includes("://") ? endpoint : `socks5://${endpoint}`;
      const url = new URL(authority);
      return url.hostname || undefined;
    }
  } catch {
    return undefined;
  }
  return undefined;
}


export interface NetworkPoolRow {
  readonly id: string;
  readonly kind: TransportKind;
  readonly endpoint: string;
  readonly tenantId: string;
  readonly credential?: string;
  readonly config?: Record<string, unknown>;
}

export interface NetworkPoolLoader {
  load(poolId: string): Promise<NetworkPoolRow | undefined>;
}

/**
 * Per-pool egress agent cache.
 *
 * Lifecycle: `resolveAgent` single-flights agent construction per
 * `tenantId:poolId` by caching the build *promise* — concurrent requests over
 * the same pool share one build, and a failed build evicts itself so the next
 * caller retries. Each agent holds persistent sockets (`keepAlive: true`) and
 * carries the SSRF policy so every connect re-validates the proxy host.
 *
 * Reaping: entries idle beyond `POOL_AGENT_IDLE_MS` (10 min) are destroyed on
 * the next resolve — bounded memory for pools deleted or disabled outside the
 * mutation path, while hot entries are never destroyed mid-request. Also enforces
 * a hard cardinality ceiling (MAX_POOL_AGENTS) by evicting the least-recently-used
 * entries when the cache exceeds the cap.
 * `releasePool` tears down eagerly when a pool is mutated; `closeAll` drains
 * the cache at shutdown.
 *
 * Concurrency is deliberately *not* managed here: slot limits are owned by
 * `NetworkPoolSelector` (local counters + Redis `proxy:inflight:*`), so
 * agents stay pure connection factories.
 */
export class PoolAgentResolver {
  private readonly agents = new Map<string, Promise<PoolAgent>>();
  private readonly lastUsed = new Map<string, number>();
  private readonly ssrfPolicy: SsrfPolicy;
  private lastIdleSweepAt = 0;
  private readonly resolveFn: (
    hostname: string,
    signal: AbortSignal,
  ) => Promise<readonly string[]>;

  constructor(
    private readonly loader: NetworkPoolLoader,
    deps?: PoolAgentResolverDeps,
  ) {
    this.ssrfPolicy = deps?.ssrfPolicy ?? {};
    const injectedResolve = deps?.resolveFn;
    this.resolveFn =
      injectedResolve ?? ((hostname, signal) => resolveAllAddresses(hostname, signal));
  }

  async resolveAgent(poolId: string, tenantId: string): Promise<PoolAgent> {
    const cacheKey = `${tenantId}:${poolId}`;
    this.lastUsed.set(cacheKey, Date.now());
    this.evictIdleAgents();
    const existing = this.agents.get(cacheKey);
    if (existing) return existing;
    const built = this.buildAgent(poolId, tenantId).catch((err: unknown) => {
      this.agents.delete(cacheKey);
      this.lastUsed.delete(cacheKey);
      throw err;
    });
    this.agents.set(cacheKey, built);
    return built;
  }

  /**
   * Bounds the agent cache: entries idle beyond POOL_AGENT_IDLE_MS are
   * destroyed, so pools deleted or disabled outside the mutation path cannot
   * retain agents and sockets for the process lifetime. Hot entries are never
   * evicted — destroying an agent an active request is dialing through would
   * break that request.
   *
   * Also enforces a hard cardinality ceiling (MAX_POOL_AGENTS) by evicting
   * the least-recently-used entries when the cache exceeds the cap.
   *
   * The idle-time scan is throttled to once per 30 s: it walks the whole map
   * on every dispatch otherwise. The over-cap eviction still runs per call —
   * it only allocates when actually over the ceiling.
   */
  private evictIdleAgents(): void {
    const now = Date.now();
    if (now - this.lastIdleSweepAt >= POOL_AGENT_SWEEP_INTERVAL_MS) {
      this.lastIdleSweepAt = now;
      const cutoff = now - POOL_AGENT_IDLE_MS;
      for (const [key, usedAt] of this.lastUsed) {
        if (usedAt >= cutoff) continue;
        this.lastUsed.delete(key);
        const pending = this.agents.get(key);
        this.agents.delete(key);
        if (pending) {
          void pending
            .then((agent) => destroyAgent(agent))
            .catch(() => undefined);
        }
      }
    }
    // Evict oldest entries if over the cardinality ceiling
    if (this.agents.size > MAX_POOL_AGENTS) {
      const entries = Array.from(this.lastUsed.entries()).sort((a, b) => a[1] - b[1]);
      const toEvict = entries.slice(0, this.agents.size - MAX_POOL_AGENTS);
      for (const [key] of toEvict) {
        this.lastUsed.delete(key);
        const pending = this.agents.get(key);
        this.agents.delete(key);
        if (pending) {
          void pending
            .then((agent) => destroyAgent(agent))
            .catch(() => undefined);
        }
      }
    }
  }

  /** Drops agents idle past the retention window. Safe to call from maintenance. */
  sweepIdleAgents(): void {
    this.lastIdleSweepAt = 0;
    this.evictIdleAgents();
  }

  async closeAll(): Promise<void> {
    for (const pending of this.agents.values()) {
      try {
        const agent = await pending;
        destroyAgent(agent);
      } catch {
        // Rejected builds already removed
      }
    }
    this.agents.clear();
    this.lastUsed.clear();

  }

  /** Observable cache size for the runtime metrics sampler. */
  agentCount(): number {
    return this.agents.size;
  }

  async releasePool(poolId: string, tenantId: string): Promise<void> {
    const cacheKey = `${tenantId}:${poolId}`;
    const pending = this.agents.get(cacheKey);
    this.agents.delete(cacheKey);
    this.lastUsed.delete(cacheKey);
    if (pending) {
      try {
        destroyAgent(await pending);
      } catch {
        // Build failed — nothing to destroy.
      }
    }
  }
  async resolveWebSocketAgent(poolId: string, tenantId: string): Promise<PoolAgent> {
    return this.resolveAgent(poolId, tenantId);
  }

  private async buildAgent(poolId: string, tenantId: string): Promise<PoolAgent> {
    const row = await this.loader.load(poolId);
    if (!row) throw new PoolBindingError(`network pool ${poolId} not found`);
    if (row.tenantId !== tenantId)
      throw new PoolBindingError(`network pool ${poolId} is not available to this tenant`);

    const agentConfig = this.resolveAgentConfig(row);
    switch (row.kind) {
      case "http":
      case "https":
      case "socks5": {
        const hostname = endpointHostname(row.kind, row.endpoint);
        if (hostname) await validateDialHost(hostname, this.ssrfPolicy, this.resolveFn);
        // The policy is handed to the agent too: both flavors re-resolve and
        // re-validate the proxy host on every connect, so the create-time
        // check cannot be bypassed by a DNS rebind of the proxy record.
        // The pool id rides along so the tunnel's bytes are attributed to the
        // pool that carried them.
        if (row.kind === "socks5")
          return createSocks5Agent(row.endpoint, row.credential, this.ssrfPolicy, agentConfig, poolId);
        return createHttpProxyAgent(row.endpoint, row.credential, this.ssrfPolicy, agentConfig, poolId);
      }
      default:
        // Compile-time exhaustiveness: new TransportKind variants must add a case.
        row.kind satisfies never;
        throw new PoolBindingError(`unsupported network pool kind: ${String(row.kind)}`);
    }
  }

  private resolveAgentConfig(row: NetworkPoolRow): AgentConfig {
    try {
      return parseAgentConfig(row.config ?? {});
    } catch (error) {
      if (error instanceof ProxyConfigError)
        throw new PoolBindingError(`invalid pool agent config: ${error.message}`);
      throw error;
    }
  }


}
/** Resolves upstream names and supplies the enforced outbound fetch capability. */
function connectValidatedWebSocket(
  url: URL,
  headers: Readonly<Record<string, string>>,
  signal: AbortSignal,
  destination: ValidatedDestination,
  agent?: PoolAgent,
): Promise<ProviderWebSocketSession> {
  const targetUrl = new URL(url.toString());
  targetUrl.protocol = "wss:";
  targetUrl.port = "";
  targetUrl.hash = "";
  const connectionOptions: ClientOptions = {
    handshakeTimeout: 15_000,
    perMessageDeflate: false,
    followRedirects: false,
    headers: { ...headers },
    ...(agent === undefined ? {} : { agent: agentForWebSocket(agent) }),
    ...(agent === undefined
      ? {
          createConnection: () => {
            const socket = tls.connect({
              host: destination.resolvedAddress,
              port: 443,
              servername: destination.hostname,
              rejectUnauthorized: true,
              ALPNProtocols: ["http/1.1"],
            });
            const onAbort = (): void => {
              socket.destroy(new Error("connection aborted"));
            };
            signal.addEventListener("abort", onAbort, { once: true });
            socket.once("secureConnect", () => signal.removeEventListener("abort", onAbort));
            return socket;
          },
        }
      : {}),
  };
  return new Promise<ProviderWebSocketSession>((resolve, reject) => {
    const socket = new WebSocket(targetUrl, connectionOptions);
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.terminate();
      reject(new GatewayError("transport_unavailable", 502, "WebSocket handshake timed out (request {requestId}). Some things just take longer 🐢"));
    }, 15_000);
    const abort = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.terminate();
      reject(new GatewayError("transport_closed", 499, "WebSocket connection was cancelled (request {requestId}). Send it again whenever ready 🙃"));
    };
    const onError = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      reject(new GatewayError("transport_unavailable", 502, "WebSocket connection failed (request {requestId}). The connection ghosted us — come back in a moment 👻"));
    };
    socket.once("open", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      resolve(new WsSession(socket, signal));
    });
    socket.once("error", onError);
    socket.once("unexpected-response", onError);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}


function agentForWebSocket(agent: PoolAgent): import("http").Agent | import("https").Agent {
  if (isProxyAgentPair(agent)) return agent.https;
  if (agent instanceof HttpsAgent) return agent;
  throw new GatewayError("proxy_pool_unhealthy", 503, "configured WebSocket proxy pool does not support WSS (request {requestId}). This bridge doesn't speak WSS — reconfigure the pool 🔧");
}

/**
 * Rejects a bidi target that cannot be dialed safely.
 *
 * Every one of these is a property of the URL, not of the DNS answer, so it is
 * checked before any resolution: a credential in the authority would be sent to
 * whatever host resolves, a non-443 port is not the TLS endpoint the policy
 * validated, and an IP literal bypasses the hostname the caller allowlists.
 */
function assertBidiTarget(url: URL): void {
  if (url.protocol !== "https:") {
    throw new GatewayError("invalid_request", 400, "validated HTTP/2 egress requires https (request {requestId}). Check the shape of what you sent — then resend 🪞");
  }
  if (url.username || url.password || url.hash) {
    throw new GatewayError("invalid_request", 400, "invalid validated HTTP/2 target (request {requestId}). Check the shape of what you sent — then resend 🪞");
  }
  if (url.port !== "" && url.port !== "443") {
    throw new GatewayError("invalid_request", 400, "validated HTTP/2 egress runs on port 443 (request {requestId}). Check the shape of what you sent — then resend 🪞");
  }
  const hostname = url.hostname;
  if (hostname.length === 0) {
    throw new GatewayError("invalid_request", 400, "HTTP/2 target hostname is required (request {requestId}). Check the shape of what you sent — then resend 🪞");
  }
  if (isIP(hostname) !== 0) {
    throw new GatewayError("invalid_request", 400, "HTTP/2 target must be a hostname, not an IP literal (request {requestId}). Check the shape of what you sent — then resend 🪞");
  }
}

/**
 * Opens one TLS socket to a validated destination.
 *
 * Direct egress dials the pinned address with SNI set to the *validated
 * hostname*: pinning is what stops a DNS rebind between check and connect, and
 * preserving SNI is what makes the certificate validate against the name the
 * caller asked for rather than against an address.
 */
function dialDirect(
  destination: ValidatedDestination,
  signal: AbortSignal,
): Promise<tls.TLSSocket> {
  return new Promise<tls.TLSSocket>((resolve, reject) => {
    const socket = tls.connect({
      host: destination.resolvedAddress,
      port: destination.port,
      servername: destination.hostname,
      rejectUnauthorized: true,
      ALPNProtocols: ["h2"],
    });
    const cleanup = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    };
    const onAbort = (): void => {
      cleanup();
      socket.destroy(new Error("HTTP/2 connection aborted"));
      reject(new GatewayError("transport_closed", 499, "HTTP/2 connection was cancelled (request {requestId}). Send it again whenever ready 🙃"));
    };
    const timer = setTimeout(() => {
      cleanup();
      socket.destroy();
      reject(
        new GatewayError("transport_unavailable", 502, "HTTP/2 connection timed out (request {requestId}). Some things just take longer 🐢", {}, "network"),
      );
    }, HTTP2_CONNECT_TIMEOUT_MS);
    socket.once("secureConnect", () => {
      cleanup();
      resolve(socket);
    });
    socket.once("error", (error) => {
      cleanup();
      reject(
        new GatewayError(
          "transport_unavailable",
          502,
          `HTTP/2 connection failed: ${error.message} (request {requestId}). The connection ghosted us — come back in a moment 👻`,
          {},
          "network",
        ),
      );
    });
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

/**
 * Opens one TLS socket through a pool agent's CONNECT/SOCKS tunnel.
 *
 * The agent owns the dial and re-validates the proxy host per connect, so the
 * tunnel is the pool's egress; the target TLS handshake then runs inside it
 * with SNI set to the validated target hostname.
 */
function dialThroughPool(
  agent: PoolAgent,
  hostname: string,
  signal: AbortSignal,
): Promise<tls.TLSSocket> {
  const pair = isProxyAgentPair(agent)
    ? agent
    : agent instanceof HttpsAgent
      ? { https: agent }
      : undefined;
  if (pair === undefined) {
    throw new GatewayError(
      "proxy_pool_unhealthy",
      503,
      "configured proxy pool does not support HTTPS tunneling (request {requestId}). This bridge doesn't speak HTTPS tunnels — reconfigure the pool 🔧",
    );
  }
  return new Promise<tls.TLSSocket>((resolve, reject) => {
    pair.https.createConnection(
      { host: hostname, port: 443, servername: hostname },
      (error: Error | null, socket: Duplex) => {
        if (error !== null || socket === null) {
          reject(
            error instanceof PoolBindingError
              ? new GatewayError(
                  "proxy_pool_unhealthy",
                  503,
                  "Configured proxy pool could not be established (request {requestId}). This bridge looks shaky — repair or reroute 🔧",
                  { reason: error.message.slice(0, 200) },
                  "network",
                )
              : new GatewayError(
                  "transport_unavailable",
                  502,
                  `HTTP/2 tunnel failed: ${error?.message ?? "no socket"} (request {requestId}). The connection ghosted us — come back in a moment 👻`,
                  {},
                  "network",
                ),
          );
          return;
        }
        const secured = tls.connect({
          socket: socket as tls.TLSSocket,
          servername: hostname,
          rejectUnauthorized: true,
          ALPNProtocols: ["h2"],
        });
        const cleanup = (): void => {
          clearTimeout(timer);
          signal.removeEventListener("abort", onAbort);
        };
        const onAbort = (): void => {
          cleanup();
          secured.destroy();
          reject(new GatewayError("transport_closed", 499, "HTTP/2 connection was cancelled (request {requestId}). Send it again whenever ready 🙃"));
        };
        const timer = setTimeout(() => {
          cleanup();
          secured.destroy();
          reject(
            new GatewayError("transport_unavailable", 502, "HTTP/2 connection timed out", {}, "network"),
          );
        }, HTTP2_CONNECT_TIMEOUT_MS);
        secured.once("secureConnect", () => {
          cleanup();
          resolve(secured);
        });
        secured.once("error", (tlsError) => {
          cleanup();
          reject(
            new GatewayError(
              "transport_unavailable",
              502,
              `HTTP/2 TLS handshake failed: ${tlsError.message}`,
              {},
              "network",
            ),
          );
        });
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
      },
    );
  });
}

/**
 * Wraps one connected HTTP/2 stream as a validated bidi stream.
 *
 * Inbound bytes are exposed as an async iterable whose consumer pace is the
 * backpressure: a paused consumer leaves the data unread and lets the HTTP/2
 * flow-control window close, which is what keeps a multi-megabyte Run from
 * buffering entirely in memory.
 */
class Http2BidiSession implements ValidatedHttp2BidiStream {
  private status = 0;
  private responseHeaders: Record<string, string> = {};
  private responseTrailers: Record<string, string> = {};
  private readonly chunks: Uint8Array[] = [];
  private readonly waiters: Array<{
    resolve(value: IteratorResult<Uint8Array>): void;
    reject(reason: unknown): void;
  }> = [];
  private inboundEnded = false;
  private inboundFailure: Error | undefined;
  private ended = false;
  private terminalReason: Http2BidiEndReason | undefined;
  private readonly terminalListeners = new Set<(reason: Http2BidiEndReason) => void>();
  private readIdleTimer: ReturnType<typeof setTimeout> | undefined;
  private bufferedBytes = 0;

  constructor(
    private readonly stream: http2.ClientHttp2Stream,
    private readonly session: http2.ClientHttp2Session,
    private readonly readIdleMs: number,
    private readonly maxBufferedBytes: number,
  ) {
    stream.on("response", (headers) => {
      const status = headers[":status"];
      this.status = typeof status === "string" ? Number(status) : (status ?? 0);
      this.responseHeaders = flattenHeaders(headers);
    });
    stream.on("trailers", (headers) => {
      this.responseTrailers = flattenHeaders(headers);
    });
    stream.on("data", (chunk: Buffer) => {
      this.armReadIdle();
      const bytes = new Uint8Array(chunk);
      this.bufferedBytes += bytes.byteLength;
      const waiter = this.waiters.shift();
      if (waiter !== undefined) {
        this.bufferedBytes -= bytes.byteLength;
        waiter.resolve({ done: false, value: bytes });
        return;
      }
      this.chunks.push(bytes);
      // A stream that keeps arriving while nobody reads is unbounded growth,
      // not backpressure: pause the socket rather than accumulating until the
      // process is out of memory.
      if (this.bufferedBytes > this.maxBufferedBytes) {
        this.fail(
          new GatewayError(
            "platform_unavailable",
            502,
            "HTTP/2 response exceeded the buffer bound (request {requestId}). The upstream sent more than we can hold — retry 🌙",
            {},
            "network",
          ),
        );
      }
    });
    stream.on("end", () => this.finishInbound());
    stream.on("error", (error) => this.fail(error));
    stream.on("aborted", () =>
      this.fail(new GatewayError("transport_unavailable", 502, "HTTP/2 stream aborted by remote (request {requestId}). The connection ghosted us — come back in a moment 👻", {}, "network")),
    );
    stream.on("close", () => {
      this.finishInbound();
      this.settleTerminal({ kind: "remote-clean-close" });
    });
  }

  get response(): { status: number; headers: Readonly<Record<string, string>> } {
    return { status: this.status, headers: this.responseHeaders };
  }

  get trailers(): Readonly<Record<string, string>> {
    return this.responseTrailers;
  }

  get body(): AsyncIterable<Uint8Array> {
    const self = this;
    return {
      [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
        return {
          next(): Promise<IteratorResult<Uint8Array>> {
            return self.nextChunk();
          },
          return(): Promise<IteratorResult<Uint8Array>> {
            self.abort();
            return Promise.resolve({ done: true, value: undefined });
          },
        };
      },
    };
  }

  private nextChunk(): Promise<IteratorResult<Uint8Array>> {
    const queued = this.chunks.shift();
    if (queued !== undefined) {
      this.bufferedBytes -= queued.byteLength;
      return Promise.resolve({ done: false, value: queued });
    }
    if (this.inboundFailure !== undefined) return Promise.reject(this.inboundFailure);
    if (this.inboundEnded) return Promise.resolve({ done: true, value: undefined });
    return new Promise<IteratorResult<Uint8Array>>((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  private armReadIdle(): void {
    clearTimeout(this.readIdleTimer);
    this.readIdleTimer = setTimeout(() => {
      this.fail(
        new GatewayError(
          "transport_unavailable",
          504,
          `HTTP/2 stream read-idle timeout after ${this.readIdleMs}ms — connection presumed dead (request {requestId}). The connection ghosted us — come back in a moment 👻`,
          {},
          "network",
        ),
      );
    }, this.readIdleMs);
    this.readIdleTimer.unref?.();
  }

  private finishInbound(): void {
    clearTimeout(this.readIdleTimer);
    this.readIdleTimer = undefined;
    if (this.inboundFailure !== undefined || this.inboundEnded) return;
    this.inboundEnded = true;
    const waiter = this.waiters.shift();
    waiter?.resolve({ done: true, value: undefined });
  }

  private fail(error: Error): void {
    if (this.inboundFailure !== undefined) return;
    this.inboundFailure = error;
    this.chunks.length = 0;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
    this.settleTerminal({ kind: "remote-error", error });
    try {
      this.stream.destroy(error);
    } catch {
      // The stream may already be closing.
    }
  }

  private settleTerminal(reason: Http2BidiEndReason): void {
    if (this.terminalReason !== undefined) return;
    this.terminalReason = reason;
    for (const listener of this.terminalListeners) {
      try {
        listener(reason);
      } catch {
        // An observer cannot destabilize teardown.
      }
    }
    this.terminalListeners.clear();
  }

  onTerminal(listener: (reason: Http2BidiEndReason) => void): () => void {
    this.terminalListeners.add(listener);
    return () => this.terminalListeners.delete(listener);
  }

  write(chunk: Uint8Array): Promise<void> {
    if (this.inboundFailure !== undefined) return Promise.reject(this.inboundFailure);
    if (this.ended) return Promise.reject(new Error("HTTP/2 request side already ended"));
    return new Promise<void>((resolve, reject) => {
      const flushed = this.stream.write(chunk, (error) => {
        if (error !== null && error !== undefined) reject(error);
      });
      if (flushed) {
        resolve();
        return;
      }
      // Backpressured: wait for drain. There is no deadline here — a stream
      // error or close settles it, and the read-idle watchdog bounds a stream
      // that stops answering.
      this.stream.once("drain", () => resolve());
    });
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    try {
      this.stream.end();
    } catch {
      // Already closed by the peer or by abort.
    }
  }

  abort(reason?: unknown): void {
    if (this.ended && this.terminalReason !== undefined) return;
    this.ended = true;
    this.settleTerminal({ kind: "local-close" });
    try {
      this.stream.destroy(reason instanceof Error ? reason : undefined);
    } catch {
      // Already destroyed.
    }
    try {
      this.session.close();
    } catch {
      // Already closing.
    }
  }
}

/** Flattens HTTP/2 header objects into a plain string map. */
function flattenHeaders(headers: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) out[name] = value.map((entry) => String(entry)).join(", ");
    else out[name] = String(value);
  }
  return out;
}

/** Opens one validated bidi stream over an already-connected socket. */
function openBidiStream(
  socket: tls.TLSSocket,
  url: URL,
  headers: Readonly<Record<string, string>>,
  options: Http2BidiOpenOptions,
): Promise<ValidatedHttp2BidiStream> {
  // `createConnection`, not the `socket` option: the socket is already a
  // validated, ALPN-negotiated TLS connection, and handing it through
  // `createConnection` is what makes the session adopt it as-is (Node's
  // `socket` option applies its own TLS expectations on top).
  const session = http2.connect(`https://${url.hostname}`, {
    createConnection: () => socket,
    maxSessionMemory: HTTP2_SESSION_MAX_MEMORY_MB,
  });
  return new Promise<ValidatedHttp2BidiStream>((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timer);
      session.removeListener("error", onError);
      session.removeListener("connect", onConnect);
    };
    const onError = (error: Error): void => {
      cleanup();
      try {
        session.destroy();
      } catch {
        // Already destroying.
      }
      reject(
        new GatewayError(
          "transport_unavailable",
          502,
          `HTTP/2 session failed: ${error.message} (request {requestId}). The connection ghosted us — come back in a moment 👻`,
          {},
          "network",
        ),
      );
    };
    const onConnect = (): void => {
      cleanup();
      const stream = session.request(
        {
          ":method": "POST",
          ":path": `${url.pathname}${url.search}`,
          ":authority": url.hostname,
          ":scheme": "https",
          ...headers,
        } as unknown as http2.OutgoingHttpHeaders,
        { endStream: false },
      );
      resolve(
        new Http2BidiSession(
          stream,
          session,
          options.readIdleMs ?? HTTP2_READ_IDLE_MS,
          options.maxBufferedBytes ?? HTTP2_MAX_BUFFERED_BYTES,
        ),
      );
    };
    const timer = setTimeout(() => {
      cleanup();
      try {
        session.destroy();
      } catch {
        // Already destroying.
      }
      reject(
        new GatewayError("transport_unavailable", 502, "HTTP/2 session timed out (request {requestId}). Some things just take longer 🐢", {}, "network"),
      );
    }, HTTP2_CONNECT_TIMEOUT_MS);
    session.once("error", onError);
    session.once("connect", onConnect);
  });
}

class WsSession implements ProviderWebSocketSession {
  readonly #socket: WebSocket;
  readonly #signal: AbortSignal;
  readonly #messages: string[] = [];
  readonly #waiters: Array<{
    resolve(value: string): void;
    reject(reason: Error): void;
    cleanup(): void;
  }> = [];
  #closed: Error | undefined;

  constructor(socket: WebSocket, signal: AbortSignal) {
    this.#socket = socket;
    this.#signal = signal;
    socket.on("message", (data: RawData, isBinary: boolean) => {
      if (isBinary) {
        this.#fail(new GatewayError("transport_unavailable", 502, "unexpected binary WebSocket frame (request {requestId}). The connection ghosted us — come back in a moment 👻"));
        return;
      }
      const message = data.toString();
      const waiter = this.#waiters.shift();
      if (waiter) {
        waiter.cleanup();
        waiter.resolve(message);
      } else {
        this.#messages.push(message);
      }
    });
    socket.on("close", () => this.#fail(new GatewayError("transport_closed", 502, "WebSocket connection closed (request {requestId}). The connection ghosted us — come back in a moment 👻")));
    socket.on("error", () => this.#fail(new GatewayError("transport_unavailable", 502, "WebSocket connection failed (request {requestId}). The connection ghosted us — come back in a moment 👻")));
  }

  send(message: string): void {
    if (this.#closed) throw this.#closed;
    if (this.#socket.readyState !== WebSocket.OPEN) {
      throw new GatewayError("transport_closed", 499, "WebSocket connection is not open (request {requestId}). Send it again whenever ready 🙃");
    }
    this.#socket.send(message, { binary: false });
  }

  receive(signal: AbortSignal): Promise<string> {
    const queued = this.#messages.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (this.#closed) return Promise.reject(this.#closed);
    const combined = AbortSignal.any([this.#signal, signal]);
    return new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new GatewayError("transport_unavailable", 504, "WebSocket receive timed out (request {requestId}). Some things just take longer 🐢"));
      }, 45_000);
      const onAbort = (): void => {
        cleanup();
        reject(new GatewayError("transport_closed", 499, "WebSocket receive was cancelled (request {requestId}). Send it again whenever ready 🙃"));
      };
      const cleanup = (): void => {
        clearTimeout(timeout);
        combined.removeEventListener("abort", onAbort);
      };
      combined.addEventListener("abort", onAbort, { once: true });
      this.#waiters.push({ resolve, reject, cleanup });
      if (combined.aborted) onAbort();
    });
  }

  close(code?: number, reason?: string): void {
    if (this.#socket.readyState === WebSocket.CLOSED) return;
    this.#socket.close(code, reason);
  }

  #fail(error: Error): void {
    if (this.#closed) return;
    this.#closed = error;
    for (const waiter of this.#waiters.splice(0)) {
      waiter.cleanup();
      waiter.reject(error);
    }
  }
}
export class ValidatedNetworkBindingFactory {
  private readonly directFetch: ValidatedFetch;

  constructor(
    private readonly policy: SsrfPolicy = {},
    fetchFn?: typeof fetch,
    private readonly poolResolver?: PoolAgentResolver,
  ) {
    this.directFetch = createValidatedFetch({ policy, ...(fetchFn ? { fetchFn } : {}) });
  }

  /**
   * One-shot DNS resolution + SSRF validation for direct egress targets:
   * every resolved address (all families, not just the first answer) must
   * pass the SSRF policy, and the validated destination pins the address so
   * the subsequent socket cannot be re-pointed at a private/link-local host
   * by a DNS rebind between check and connect.
   */
  resolve(hostname: string, signal: AbortSignal, port = 443): Promise<ValidatedDestination> {
    return resolveAndValidateOnce(hostname, this.policy, signal, port);
  }

  /**
   * Without `networkPoolId` (or when no pool resolver is configured), dispatch
   * through validated direct egress. With one, route through that pool's
   * validated agent. A pool configuration failure is returned to the caller;
   * configured egress is never silently replaced with direct traffic.
   */
  fetch(networkPoolId?: string, tenantId?: string): ValidatedFetch {
    if (!networkPoolId || !this.poolResolver || !tenantId) return this.directFetch;
    const { poolResolver, policy } = this;
    return async (input, init) => {
      try {
        const agent = await poolResolver.resolveAgent(networkPoolId, tenantId);
        return await createValidatedFetch({ policy, agent })(input, init);
      } catch (error) {
        if (error instanceof PoolBindingError) {
          throw new GatewayError(
            "proxy_pool_unhealthy",
            503,
            "Configured proxy pool could not be established (request {requestId}). This bridge looks shaky — repair or reroute 🔧",
            { poolId: networkPoolId, reason: error.message.slice(0, 200) },
            "network",
          );
        }
        throw error;
      }
    };
  }
  webSocket(networkPoolId?: string, tenantId?: string): ValidatedOutboundWebSocket {
    return async (url, headers, signal) => {
      if (url.protocol !== "wss:") {
        throw new GatewayError("invalid_request", 400, "validated WebSocket egress requires wss (request {requestId}). Check the shape of what you sent — then resend 🪞");
      }
      if (url.username || url.password || url.hash || (url.port !== "" && url.port !== "443")) {
        throw new GatewayError("invalid_request", 400, "invalid validated WebSocket target (request {requestId}). Check the shape of what you sent — then resend 🪞");
      }
      const hostname = url.hostname;
      if (!hostname) throw new GatewayError("invalid_request", 400, "WebSocket target hostname is required (request {requestId}). Check the shape of what you sent — then resend 🪞");
      const destination = await this.resolve(hostname, signal, 443);
      if (!isAddressAllowed(destination.resolvedAddress, this.policy)) {
        throw new GatewayError("invalid_request", 400, "unsafe upstream address rejected (request {requestId}). Check the shape of what you sent — then resend 🪞");
      }
      let agent: PoolAgent | undefined;
      if (networkPoolId || tenantId) {
        if (!networkPoolId || !tenantId || !this.poolResolver) {
          throw new GatewayError("proxy_pool_unhealthy", 503, "configured WebSocket proxy pool could not be established (request {requestId}). This bridge looks shaky — repair or reroute 🔧");
        }
        try {
          agent = await this.poolResolver.resolveWebSocketAgent(networkPoolId, tenantId);
        } catch (error) {
          if (error instanceof PoolBindingError) {
            throw new GatewayError("proxy_pool_unhealthy", 503, "configured WebSocket proxy pool could not be established (request {requestId}). This bridge looks shaky — repair or reroute 🔧");
          }
          throw error;
        }
      }
      return connectValidatedWebSocket(url, headers, signal, destination, agent);
    };
  }

  /**
   * Validated bidirectional HTTP/2 egress for one writable streaming request.
   *
   * Direct egress resolves and validates *every* DNS answer for the hostname,
   * pins the chosen public address, and keeps TLS SNI pointed at the validated
   * hostname — so a rebind between check and connect cannot retarget the socket,
   * and the certificate still validates against the name the caller asked for.
   * Pooled egress reuses the selected tenant pool's CONNECT/SOCKS tunnel and
   * accounts the tunnel's bytes to that pool, exactly as `fetch` does.
   *
   * Credentials in the authority, fragments, non-443 ports, IP literals, and
   * hostnames outside `allowHostname` are refused before anything is dialed: a
   * bidi stream carries the account credential for its whole lifetime, so the
   * target is checked once here rather than trusted to each caller.
   */
  http2Bidi(networkPoolId?: string, tenantId?: string): ValidatedOutboundHttp2Bidi {
    return async (url, headers, options) => {
      assertBidiTarget(url);
      const { hostname } = url;
      if (options?.allowHostname !== undefined && !options.allowHostname(hostname)) {
        throw new GatewayError("invalid_request", 400, "HTTP/2 target host is not allowlisted");
      }
      const signal = options?.signal ?? AbortSignal.timeout(HTTP2_CONNECT_TIMEOUT_MS);
      // Validation runs on every new connection, not once per capability: a
      // long-lived Run is re-opened after a session dies, and a hostname that
      // resolved safely the first time is not safe the twentieth.
      const destination = await this.resolve(hostname, signal, 443);
      if (!isAddressAllowed(destination.resolvedAddress, this.policy)) {
        throw new GatewayError("invalid_request", 400, "unsafe upstream address rejected");
      }
      // Mirrors `fetch`: no pool selected (or none configured) means validated
      // *direct* egress, which is already resolved and SSRF-checked above.
      // Requiring a pool whenever a tenant id was supplied made bidi-only
      // providers (Cursor) unreachable on every install without a pool, even
      // though the equivalent `fetch` path dials direct there.
      if (networkPoolId !== undefined || tenantId !== undefined) {
        if (networkPoolId === undefined || tenantId === undefined || this.poolResolver === undefined) {
          const socket = await dialDirect(destination, signal);
          return openBidiStream(socket, url, headers, options ?? {});
        }
        let agent: PoolAgent;
        try {
          agent = await this.poolResolver.resolveAgent(networkPoolId, tenantId);
        } catch (error) {
          if (error instanceof PoolBindingError) {
            throw new GatewayError(
              "proxy_pool_unhealthy",
              503,
              "Configured proxy pool could not be established.",
              { poolId: networkPoolId, reason: error.message.slice(0, 200) },
              "network",
            );
          }
          throw error;
        }
        const socket = await dialThroughPool(agent, hostname, signal);
        return openBidiStream(socket, url, headers, options ?? {});
      }
      const socket = await dialDirect(destination, signal);
      return openBidiStream(socket, url, headers, options ?? {});
    };
  }
}

