/**
 * Loopback OAuth callback listener.
 *
 * A browser authorization server redirects to the redirect URI it was given,
 * and every browser client here advertises a loopback URI — `localhost:1455`
 * for Codex, `127.0.0.1:54549` for OpenRouter, and so on. That URI names the
 * machine the *operator's browser* is on, so a gateway that only advertises it
 * and never binds the port leaves the browser on a dead page: the code reaches
 * the address bar and nothing else, which is why every browser login fell back
 * to pasting the URL by hand.
 *
 * So the gateway binds that port when a login starts, for the life of the flow,
 * and completes the exchange from inside the listener. The advertised URI and
 * the bound socket are then the same endpoint, which is the only way a
 * redirect can deliver its code without a human copying it.
 *
 * One listener serves one port and is shared by every flow registered on it;
 * it stops once the last of those flows settles or its TTL lapses. A port that
 * cannot be bound fails the login immediately rather than advertising an
 * address nothing answers — the operator sees a port conflict, not a login that
 * silently never completes.
 *
 * `state` is the correlation key and is required: the flow store consumes it
 * atomically, so a replayed or forged callback cannot complete a flow that was
 * already spent.
 */
import { log } from "../../../observability/logger";
import { ConsoleDomainError } from "../../shared/errors";

/** A loopback endpoint a callback can actually be delivered to. */
export interface LoopbackCallbackEndpoint {
  readonly port: number;
  readonly path: string;
}

/** Hosts that name the operator's own machine. */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/**
 * The loopback endpoint `redirectUri` names, or `undefined` when it is not a
 * loopback HTTP URI.
 *
 * A custom scheme (`zcode://zai-auth/callback`) is delivered by the OS to the
 * installed app and a remote host is delivered over the network; neither is
 * something this process can bind, and both keep the manual path.
 */
export function loopbackCallbackEndpoint(redirectUri: string): LoopbackCallbackEndpoint | undefined {
  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:") return undefined;
  if (!LOOPBACK_HOSTS.has(url.hostname.toLowerCase())) return undefined;
  const port = url.port.length > 0 ? Number(url.port) : 80;
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) return undefined;
  return { port, path: url.pathname.length > 0 ? url.pathname : "/" };
}

/** Completes one callback once its code and state have been read. */
export interface OAuthCallbackCompleter {
  complete(
    providerId: string,
    code: string,
    state: string,
    /** Extra query params the callback carried (e.g. Kiro's `login_option`). */
    callbackParams?: Readonly<Record<string, string>>,
  ): Promise<{
    readonly ok: boolean;
    readonly message: string;
    readonly redirectUrl?: string;
    readonly continueState?: string;
  }>;
}

/** Minimal `Bun.serve` surface this module depends on. */
interface LoopbackServer {
  readonly port?: number | undefined;
  stop(closeActiveConnections?: boolean): void | Promise<void>;
}

type ServeFn = (options: {
  readonly hostname: string;
  readonly port: number;
  readonly fetch: (request: Request) => Response | Promise<Response>;
}) => LoopbackServer;

export interface CallbackListenerOptions {
  readonly completer: OAuthCallbackCompleter;
  /** Injected in tests; defaults to `Bun.serve`. */
  readonly serve?: ServeFn;
  /** How long a registered flow may wait for its callback. */
  readonly ttlMs?: number;
}

/** The default flow lifetime, matching the flow store's own 900 s TTL. */
const DEFAULT_TTL_MS = 900_000;

interface RegisteredFlow {
  readonly providerId: string;
  /** Paths this flow's callback may arrive on (e.g. Kiro serves both `/oauth/callback` and `/signin/callback`). */
  readonly paths: readonly string[];
  readonly timer: ReturnType<typeof setTimeout>;
  inFlight: boolean;
}

interface PortListener {
  readonly port: number;
  readonly servers: readonly LoopbackServer[];
  /** Live flows by `state`, so a callback can be matched and the port freed. */
  readonly flows: Map<string, RegisteredFlow>;
}

/**
 * Binds and releases the loopback listeners that deliver browser callbacks.
 *
 * A listener is created on the first flow for a port and torn down when that
 * port has no flows left, so an idle gateway holds no extra sockets and a port
 * is only occupied while a login that needs it is in flight.
 */
export class OAuthCallbackListener {
  readonly #completer: OAuthCallbackCompleter;
  readonly #serve: ServeFn;
  readonly #ttlMs: number;
  readonly #ports = new Map<number, PortListener>();

  constructor(options: CallbackListenerOptions) {
    this.#completer = options.completer;
    this.#serve = options.serve ?? ((serveOptions) => Bun.serve(serveOptions) as LoopbackServer);
    this.#ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  }

  /**
   * Binds `redirectUri`'s port for `providerId` and remembers `state`.
   *
   * Returns `false` for a redirect this process cannot serve (a custom scheme
   * or a remote host); the caller keeps the manual path for those. Throws when
   * a loopback port is wanted but cannot be bound, because advertising an
   * address nothing answers is the failure this listener exists to remove.
   */
  register(redirectUri: string, providerId: string, state: string): boolean {
    const endpoint = loopbackCallbackEndpoint(redirectUri);
    if (endpoint === undefined) return false;
    const existing = this.#ports.get(endpoint.port);
    if (existing !== undefined) {
      this.#remember(existing, state, providerId, this.#callbackPaths(endpoint.path));
      return true;
    }
    const servers = this.#bind(endpoint);
    const listener: PortListener = { port: endpoint.port, servers, flows: new Map() };
    this.#ports.set(endpoint.port, listener);
    this.#remember(listener, state, providerId, this.#callbackPaths(endpoint.path));
    log.info(`[oauth] callback listener bound on 127.0.0.1:${endpoint.port}${endpoint.path}`);
    return true;
  }

  /**
   * The paths one login may deliver its callback on. Kiro's portal is observed
   * (unpacked IDE 1.4.62) to redirect to both `/oauth/callback` and
   * `/signin/callback`; binding only the advertised path left a redirect to the
   * other one hitting a 404 and the login hanging. Other providers neither
   * register nor expect `/signin/callback`, so adding it is harmless.
   */
  #callbackPaths(advertised: string): readonly string[] {
    return advertised === "/signin/callback"
      ? [advertised]
      : [advertised, "/signin/callback"];
  }

  /** Drops a flow and frees its port when nothing else is waiting on it. */
  release(redirectUri: string, state: string): void {
    const endpoint = loopbackCallbackEndpoint(redirectUri);
    if (endpoint === undefined) return;
    const listener = this.#ports.get(endpoint.port);
    if (listener === undefined) return;
    this.#forget(endpoint.port, listener, state);
  }

  /**
   * Re-registers an existing flow state under a new callback state.
   *
   * Kiro's two-phase portal login starts a second authorization leg with a
   * *fresh* state (the IDE mints a new UUID for the IdC authorize step), so
   * the loopback listener must retain the pending flow under that second
   * state too — otherwise the phase-2 callback answers "OAuth session not
   * found or expired" even though the flow is still alive.
   */
  track(redirectUri: string, state: string, newState: string): void {
    const endpoint = loopbackCallbackEndpoint(redirectUri);
    if (endpoint === undefined) return;
    const listener = this.#ports.get(endpoint.port);
    if (listener === undefined) return;
    const flow = listener.flows.get(state);
    if (flow === undefined) return;
    this.#remember(listener, newState, flow.providerId, flow.paths);
  }

  /**
   * Drops every flow for `providerId` on `redirectUri`'s port.
   *
   * The state-keyed `release` cannot serve a stateless callback: the flow is
   * filed under the generated state, but the callback arrives with `""`, so
   * the lookup deletes nothing and the port stays bound until TTL. Releasing
   * by provider covers that path without guessing across providers.
   */
  releaseProvider(redirectUri: string, providerId: string): void {
    const endpoint = loopbackCallbackEndpoint(redirectUri);
    if (endpoint === undefined) return;
    const listener = this.#ports.get(endpoint.port);
    if (listener === undefined) return;
    for (const [state, flow] of [...listener.flows]) {
      if (flow.providerId === providerId) this.#forget(endpoint.port, listener, state);
    }
  }

  /** Stops every listener; used on shutdown and between tests. */
  stop(): void {
    for (const [port, listener] of this.#ports) {
      for (const flow of listener.flows.values()) clearTimeout(flow.timer);
      listener.flows.clear();
      for (const server of listener.servers) void server.stop(true);
      this.#ports.delete(port);
    }
  }

  #remember(listener: PortListener, state: string, providerId: string, paths: readonly string[]): void {
    const previous = listener.flows.get(state);
    if (previous !== undefined) clearTimeout(previous.timer);
    const timer = setTimeout(() => {
      this.#forget(listener.port, listener, state);
    }, this.#ttlMs);
    // A pending login must not hold the process open on its own.
    (timer as unknown as { unref?: () => void }).unref?.();
    listener.flows.set(state, { providerId, paths, timer, inFlight: false });
  }

  #forget(port: number, listener: PortListener, state: string): void {
    const flow = listener.flows.get(state);
    if (flow !== undefined) clearTimeout(flow.timer);
    listener.flows.delete(state);
    if (listener.flows.size > 0) return;
    this.#ports.delete(port);
    for (const server of listener.servers) void server.stop(true);
    log.info(`[oauth] callback listener released on 127.0.0.1:${port}`);
  }

  /** The `state` a registered flow was remembered under. */
  #stateOf(listener: PortListener, flow: RegisteredFlow): string | undefined {
    for (const [state, candidate] of listener.flows) {
      if (candidate === flow) return state;
    }
    return undefined;
  }

  /**
   * Binds the loopback address families `endpoint.port` should answer on.
   *
   * `localhost` resolves to `127.0.0.1` and `::1`, and a browser may pick
   * either, so both are bound: binding only IPv4 hands the code to whatever
   * else holds the IPv6 loopback on that port and the login times out with no
   * error at all. A host without an IPv6 loopback serves on IPv4 alone.
   */
  #bind(endpoint: LoopbackCallbackEndpoint): readonly LoopbackServer[] {
    const handler = (request: Request): Promise<Response> => this.#handle(request, endpoint);
    const servers: LoopbackServer[] = [];
    try {
      servers.push(this.#serve({ hostname: "127.0.0.1", port: endpoint.port, fetch: handler }));
    } catch (cause) {
      // A domain error, not a bare Error: the console route maps an untyped
      // failure to a generic `internal_error`, which hid an actionable "free
      // the port" message behind "Failed to start OAuth".
      throw new ConsoleDomainError(
        "oauth_callback_port_unavailable",
        409,
        `OAuth callback port ${endpoint.port} is in use, so the login redirect to ${endpoint.path} cannot be delivered. ` +
          `Free port ${endpoint.port} and retry.`,
        { port: endpoint.port, path: endpoint.path },
      );
    }
    try {
      servers.push(this.#serve({ hostname: "::1", port: endpoint.port, fetch: handler }));
    } catch {
      // No IPv6 loopback on this host: the IPv4 listener is the only reachable
      // endpoint, so it serves alone.
    }
    return servers;
  }

  async #handle(
    request: Request,
    endpoint: LoopbackCallbackEndpoint,
  ): Promise<Response> {
    const url = new URL(request.url);
    const listener = this.#ports.get(endpoint.port);
    if (listener === undefined) {
      return new Response("OAuth session not found or expired.", { status: 400 });
    }
    const error = url.searchParams.get("error");
    const state = url.searchParams.get("state") ?? "";
    /**
     * Not every authorization server hands back a `code`. Trae's page redirects
     * with the refresh token already in the query (`?isRedirect=true&
     * refreshToken=…`), and the client's parser reads the whole query. So an
     * absent `code` falls back to the query itself — the client decides whether
     * it can redeem it, and one that cannot still fails with its own message
     * rather than a bare 400 here.
     */
    const codeParam = url.searchParams.get("code") ?? "";
    const code = codeParam.length > 0 ? codeParam : url.search.slice(1);
    if (error !== null) {
      // A denial carries the state only when the server echoes one; clear it
      // when present so a retry starts a fresh flow.
      if (state.length > 0) this.#forget(endpoint.port, listener, state);
      return new Response(
        `<!doctype html><html><body><p>OAuth login failed: ${escapeHtml(error)}</p></body></html>`,
        { status: 400, headers: { "content-type": "text/html; charset=utf-8" } },
      );
    }
    if (code.length === 0 && !url.searchParams.has("login_option")) {
      return new Response("Missing authorization code.", { status: 400 });
    }
    // `state` is the correlation key and the replay guard. An authorization
    // server that does not echo one (OpenRouter omits it entirely) leaves the
    // callback with no key. A stateless fallback is only safe with exactly
    // one flow waiting: two concurrent logins on one port would deliver the
    // code to the wrong flow, so ambiguity fails closed instead of guessing.
    let matched;
    if (state.length > 0) {
      matched = listener.flows.get(state);
    } else if (listener.flows.size === 1) {
      matched = listener.flows.values().next().value;
    } else {
      return new Response("OAuth session ambiguous without state; retry the login.", { status: 400 });
    }
    if (matched === undefined) {
      return new Response("OAuth session not found or expired.", { status: 400 });
    }
    // Some providers (Kiro's portal) can land the callback on any of several
    // registered paths — `/oauth/callback` or `/signin/callback`. Accept the
    // path the flow registered for, not only the advertised default.
    if (!matched.paths.includes(url.pathname)) {
      return new Response("Not found", { status: 404 });
    }
    if (matched.inFlight) {
      return new Response("OAuth callback is already being processed.", { status: 409 });
    }
    // Claim while the exchange is in flight. A multi-step flow (Kiro OIDC) may
    // return a redirect and reuse this listener/state for its next callback.
    matched.inFlight = true;
    const matchedState = state.length > 0 ? state : this.#stateOf(listener, matched);
    let result: {
      ok: boolean;
      message: string;
      redirectUrl?: string;
      continueState?: string;
    };
    // Some authorization servers (Kiro's portal) append provider-specific query
    // params — `login_option` names the social/enterprise family that approved.
    // The exchange needs them to rebuild the exact redirect URI the portal saw,
    // and the OIDC families carry `issuer_url`/`idc_region`/`client_id`/`scopes`
    // that the continuation flow needs. Forward every param other than the ones
    // this handler already consumed.
    const callbackParams: Record<string, string> = {};
    for (const [key, value] of url.searchParams) {
      if (key === "code" || key === "state" || key === "error" || key === "error_description") continue;
      callbackParams[key] = value;
    }
    try {
      result = await this.#completer.complete(
        matched.providerId,
        code,
        state,
        Object.keys(callbackParams).length > 0 ? callbackParams : undefined,
      );
    } catch (failure) {
      if (matchedState !== undefined) this.#forget(endpoint.port, listener, matchedState);
      const message = failure instanceof Error ? failure.message : "OAuth login failed";
      log.error(`[oauth] callback completion failed for ${matched.providerId}: ${message}`);
      return new Response(
        "<!doctype html><html><body><p>OAuth login failed. Return to the console and try again.</p></body></html>",
        { status: 500, headers: { "content-type": "text/html; charset=utf-8" } },
      );
    }
    if (result.redirectUrl !== undefined) {
      // Phase 1 of a two-phase login (Kiro OIDC): the flow is still pending, so
      // continue by sending the browser to the phase-2 authorize URL. The phase-2
      // authorize URL carries a fresh state (`continueState`), which the completer
      // already registered under — keep the current matcher alive for it.
      matched.inFlight = false;
      return new Response(null, {
        status: 302,
        headers: { location: result.redirectUrl },
      });
    }
    if (matchedState !== undefined) this.#forget(endpoint.port, listener, matchedState);
    if (!result.ok) {
      return new Response(
        `<!doctype html><html><body><p>OAuth login failed: ${escapeHtml(result.message)}</p></body></html>`,
        { status: 400, headers: { "content-type": "text/html; charset=utf-8" } },
      );
    }
    // The console dialog polls the account list and closes itself, so the tab
    // only has to say it is finished. No inline script: a close() call would
    // need a CSP hash for no benefit the poll does not already provide.
    return new Response(
      "<!doctype html><html><body><p>OAuth login completed. You can close this tab.</p></body></html>",
      { headers: { "content-type": "text/html; charset=utf-8" } },
    );
  }
}

/** Escapes the few characters that can break out of the message paragraph. */
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[character] ?? character;
  });
}
