/**
 * Unified network egress client.
 *
 * One entry point for every outbound transport the gateway can dial:
 *
 * - `fetch(poolId?, tenantId?)` — validated HTTP fetch (SSRF-guarded), with
 *   optional TLS ClientHello profile support (`options.tlsProfile`).
 * - `bidi(poolId?, tenantId?)` — validated bidirectional HTTP/2 stream
 *   (Connect-RPC-style request/response over one long-lived stream).
 * - `webSocket(poolId?, tenantId?)` — validated WSS session.
 * - `resolve(hostname, signal, port?)` — one-shot DNS resolution + SSRF
 *   validation, pinned so a rebind cannot retarget the socket.
 *
 * All four bind to the same selected network pool (when one is given) or to
 * validated direct egress. Provider adapters call this and never dial a
 * socket themselves.
 */
import { ValidatedNetworkBindingFactory } from "./egress/factory";
import type { ValidatedOutboundHttp2Bidi } from "./bidi";
import type { ValidatedOutboundWebSocket } from "../providers/provider-contracts";
import type { ValidatedDestination } from "./ssrf";
import type { SsrfPolicy } from "../config/network";
import type { TlsProfile } from "./egress/tls-profile";
import type { ValidatedFetch } from "./egress/fetch";
import type { PoolAgentResolver } from "./pool/resolver";

export interface NetworkClientOptions {
  /** SSRF policy applied to every dial. Defaults to the empty (block-all-loopback) policy. */
  readonly policy?: SsrfPolicy;
  /** Injected fetch for offline tests/recordings. */
  readonly fetchFn?: typeof fetch;
  /** Optional pool-agent resolver; without it every dial is direct. */
  readonly poolResolver?: PoolAgentResolver;
  /**
   * Default TLS ClientHello profile for direct https dials. `"default"` keeps
   * the runtime's own TLS; a named profile (see `tls-profile.ts`) dials with
   * that profile's OpenSSL options so the wire fingerprint matches the
   * impersonated client.
   */
  readonly tlsProfile?: TlsProfile;
}

export interface NetworkClient {
  /** Validated HTTP fetch bound to a pool slot (or direct when omitted). */
  readonly fetch: (poolId?: string, tenantId?: string) => ValidatedFetch;
  /** Validated bidirectional HTTP/2 stream. */
  readonly bidi: (poolId?: string, tenantId?: string) => ValidatedOutboundHttp2Bidi;
  /** Validated WSS session. */
  readonly webSocket: (poolId?: string, tenantId?: string) => ValidatedOutboundWebSocket;
  /** One-shot DNS resolution + SSRF validation for direct egress targets. */
  readonly resolve: (hostname: string, signal: AbortSignal, port?: number) => Promise<ValidatedDestination>;
}

export function createNetworkClient(options: NetworkClientOptions = {}): NetworkClient {
  const factory = new ValidatedNetworkBindingFactory(
    options.policy,
    options.fetchFn,
    options.poolResolver,
    options.tlsProfile,
  );
  return {
    fetch: (poolId, tenantId) => factory.fetch(poolId, tenantId),
    bidi: (poolId, tenantId) => factory.http2Bidi(poolId, tenantId),
    webSocket: (poolId, tenantId) => factory.webSocket(poolId, tenantId),
    resolve: (hostname, signal, port) => factory.resolve(hostname, signal, port),
  };
}
