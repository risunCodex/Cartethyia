/**
 * Raw validated TLS dials — direct and through a pool tunnel.
 *
 * Direct egress dials the pinned address with SNI set to the *validated
 * hostname*: pinning is what stops a DNS rebind between check and connect, and
 * preserving SNI is what makes the certificate validate against the name the
 * caller asked for rather than against an address.
 *
 * A pool tunnel dial runs the target TLS handshake inside the pool's
 * CONNECT/SOCKS tunnel with SNI set to the validated target hostname.
 *
 * Both accept an optional TLS ClientHello profile (`tls-profile.ts`) so the
 * dial mirrors a target client's transport fingerprint when one is requested.
 */
import { isIP } from "node:net";
import * as tls from "node:tls";
import type { Duplex } from "node:stream";
import { Agent as HttpsAgent } from "node:https";
import { GatewayError } from "../../protocol/gateway-error";
import { isProxyAgentPair, PoolBindingError, type PoolAgent } from "../pool/agent";
import { nodeTlsOptions, type TlsProfileConfig } from "./tls-profile";
import type { ValidatedDestination } from "../ssrf";

/** Time allowed for one HTTP/2 connection (TCP + TLS + preface) to establish. */
export const HTTP2_CONNECT_TIMEOUT_MS = 15_000;

/**
 * Rejects a bidi target that cannot be dialed safely.
 *
 * Every one of these is a property of the URL, not of the DNS answer, so it is
 * checked before any resolution: a credential in the authority would be sent to
 * whatever host resolves, a non-443 port is not the TLS endpoint the policy
 * validated, and an IP literal bypasses the hostname the caller allowlists.
 */
export function assertBidiTarget(url: URL): void {
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
 */
export function dialDirect(
  destination: ValidatedDestination,
  signal: AbortSignal,
  tlsProfile?: TlsProfileConfig,
): Promise<tls.TLSSocket> {
  return new Promise<tls.TLSSocket>((resolve, reject) => {
    const socket = tls.connect({
      host: destination.resolvedAddress,
      port: destination.port,
      servername: destination.hostname,
      rejectUnauthorized: true,
      ALPNProtocols: ["h2"],
      ...(tlsProfile === undefined ? {} : { ...nodeTlsOptions(tlsProfile, false) }),
    } as tls.ConnectionOptions);
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
export function dialThroughPool(
  agent: PoolAgent,
  hostname: string,
  signal: AbortSignal,
  tlsProfile?: TlsProfileConfig,
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
          ...(tlsProfile === undefined ? {} : { ...nodeTlsOptions(tlsProfile, false) }),
        } as tls.ConnectionOptions);
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
            new GatewayError("transport_unavailable", 502, "HTTP/2 connection timed out (request {requestId}). Some things just take longer 🐢", {}, "network"),
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
              `HTTP/2 TLS handshake failed: ${tlsError.message} (request {requestId}). The connection ghosted us — come back in a moment 👻`,
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
