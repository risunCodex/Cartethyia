/**
 * `ValidatedNetworkBindingFactory` — one binding point for every validated
 * egress capability: fetch, profile-fetch, HTTP/2 bidi, WebSocket, and
 * one-shot DNS+SSRF resolution.
 *
 * Direct egress resolves and validates *every* DNS answer for the hostname,
 * pins the chosen public address, and keeps TLS SNI pointed at the validated
 * hostname — so a rebind between check and connect cannot retarget the socket,
 * and the certificate still validates against the name the caller asked for.
 * Pooled egress reuses the selected tenant pool's CONNECT/SOCKS tunnel and
 * accounts the tunnel's bytes to that pool, exactly as `fetch` does.
 */
import { GatewayError } from "../../protocol/gateway-error";
import type { SsrfPolicy } from "../../config/network";
import { createValidatedFetch, type ValidatedFetch } from "./fetch";
import { isAddressAllowed, resolveAndValidateOnce, type ValidatedDestination } from "../ssrf";
import { tlsProfileOf, type TlsProfile } from "./tls-profile";
import { assertBidiTarget, dialDirect, dialThroughPool } from "./dial";
import { openBidiStream } from "./bidi-session";
import { connectValidatedWebSocket } from "./ws";
import type { ValidatedOutboundWebSocket, ValidatedOutboundHttp2Bidi } from "../../providers/provider-contracts";
import { PoolBindingError, type PoolAgent } from "../pool/agent";
import type { PoolAgentResolver } from "../pool/resolver";

export class ValidatedNetworkBindingFactory {
  private readonly directFetch: ValidatedFetch;
  /**
   * One `ValidatedFetch` per resolved pool agent. Building the closure (dialer,
   * relay setup, redirect loop) on every request through a pool was pure
   * churn; keying by the agent object means a released agent is naturally
   * collected (new builds mint a new agent) so no explicit invalidation is
   * needed.
   */
  private readonly pooledFetchCache = new WeakMap<PoolAgent, ValidatedFetch>();
  /** Default TLS ClientHello profile for direct https dials. */
  private readonly tlsProfile: TlsProfile;

  constructor(
    private readonly policy: SsrfPolicy = {},
    fetchFn?: typeof fetch,
    private readonly poolResolver?: PoolAgentResolver,
    tlsProfile: TlsProfile = "default",
  ) {
    this.directFetch = createValidatedFetch({
      policy,
      ...(fetchFn ? { fetchFn } : {}),
      tlsProfile,
    });
    this.tlsProfile = tlsProfile;
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
        let validated = this.pooledFetchCache.get(agent);
        if (validated === undefined) {
          validated = createValidatedFetch({ policy, agent });
          this.pooledFetchCache.set(agent, validated);
        }
        return await validated(input, init);
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
          agent = await this.poolResolver.resolveAgent(networkPoolId, tenantId);
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
        throw new GatewayError("invalid_request", 400, "HTTP/2 target host is not allowlisted (request {requestId}). All roads blocked — time to find a new route 🗺️");
      }
      const signal = options?.signal ?? AbortSignal.timeout(15_000);
      const profile = tlsProfileOf(this.tlsProfile);
      // Validation runs on every new connection, not once per capability: a
      // long-lived Run is re-opened after a session dies, and a hostname that
      // resolved safely the first time is not safe the twentieth.
      const destination = await this.resolve(hostname, signal, 443);
      if (!isAddressAllowed(destination.resolvedAddress, this.policy)) {
        throw new GatewayError("invalid_request", 400, "unsafe upstream address rejected (request {requestId}). All roads blocked — time to find a new route 🗺️");
      }
      // Mirrors `fetch`: no pool selected (or none configured) means validated
      // *direct* egress, which is already resolved and SSRF-checked above.
      // Requiring a pool whenever a tenant id was supplied made bidi-only
      // providers (Cursor) unreachable on every install without a pool, even
      // though the equivalent `fetch` path dials direct there.
      if (networkPoolId !== undefined || tenantId !== undefined) {
        if (networkPoolId === undefined || tenantId === undefined || this.poolResolver === undefined) {
          const socket = await dialDirect(destination, signal, profile);
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
              "Configured proxy pool could not be established (request {requestId}). This bridge looks shaky — repair or reroute 🔧",
              { poolId: networkPoolId, reason: error.message.slice(0, 200) },
              "network",
            );
          }
          throw error;
        }
        const socket = await dialThroughPool(agent, hostname, signal, profile);
        return openBidiStream(socket, url, headers, options ?? {});
      }
      const socket = await dialDirect(destination, signal, profile);
      return openBidiStream(socket, url, headers, options ?? {});
    };
  }
}
