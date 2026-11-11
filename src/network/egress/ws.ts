/**
 * Validated WebSocket egress — WSS session + the dial that opens one.
 *
 * The dial resolves the target through the SSRF policy (done by the caller,
 * the binding factory) and then either connects through the selected pool
 * agent's tunnel or dials direct with pinned, SSRF-validated address.
 */
import * as tls from "node:tls";
import WebSocket, { type ClientOptions, type RawData } from "ws";
import { GatewayError } from "../../protocol/gateway-error";
import { isProxyAgentPair, type PoolAgent } from "../pool/agent";
import { Agent as HttpsAgent } from "node:https";
import type { ProviderWebSocketSession } from "../../providers/provider-contracts";
import type { ValidatedDestination } from "../ssrf";

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

export { connectValidatedWebSocket, WsSession };
