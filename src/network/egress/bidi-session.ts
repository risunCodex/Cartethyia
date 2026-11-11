/**
 * HTTP/2 bidi session — one validated bidirectional stream over a dialed TLS
 * socket, plus the session wrapper that drives it.
 *
 * Inbound bytes are exposed as an async iterable whose consumer pace is the
 * backpressure: a paused consumer leaves the data unread and lets the HTTP/2
 * flow-control window close, which is what keeps a multi-megabyte Run from
 * buffering entirely in memory.
 */
import * as http2 from "node:http2";
import type { TLSSocket } from "node:tls";
import { GatewayError } from "../../protocol/gateway-error";
import type { Http2BidiEndReason, Http2BidiOpenOptions, ValidatedHttp2BidiStream } from "../bidi";

export const HTTP2_CONNECT_TIMEOUT_MS = 15_000;
/** Read-idle bound after which a bidi stream is declared dead. */
export const HTTP2_READ_IDLE_MS = 120_000;
/** Buffered inbound bytes before a bidi stream is refused as unbounded. */
export const HTTP2_MAX_BUFFERED_BYTES = 64 * 1024 * 1024;
/**
 * Session memory ceiling for one HTTP/2 session.
 *
 * Node and Bun count a session's unsent bytes against `maxSessionMemory`
 * (10 MB by default) and, once over it, fail every new stream with
 * `ENHANCE_YOUR_CALM`. A bidi Run request and its KV replies run to many
 * megabytes and the caller holds those bytes anyway, so the default only adds
 * a failure mode.
 */
export const HTTP2_SESSION_MAX_MEMORY_MB = 256;

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
export function openBidiStream(
  socket: TLSSocket,
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
