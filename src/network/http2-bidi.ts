// Transport-neutral bidirectional HTTP/2 egress contract.
//
// Cursor's Run is a Connect-RPC bidi stream: one long-lived writable request
// whose response body is an unbounded stream of protobuf frames. Neither
// `fetch` nor the WebSocket session contract can express it — `fetch` needs the
// whole body up front, and a WebSocket is a different protocol — so the egress
// boundary gets its own contract.
//
// This module is transport-neutral on purpose: it declares *what* a validated
// bidi stream is, and `network/pool/resolver.ts` decides *how* one is dialed
// (direct TLS to a pinned, SSRF-validated address, or through the selected
// tenant pool's CONNECT/SOCKS tunnel). A provider adapter consumes the contract
// and never opens a socket of its own.

/** Response metadata of one opened bidi stream. */
interface Http2BidiResponse {
  /** HTTP/2 `:status`; `0` before the response headers arrive. */
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
}

/** Terminal reason a bidi stream ended. */
export type Http2BidiEndReason =
  /** The server closed the stream cleanly. */
  | { readonly kind: "remote-clean-close" }
  /** The server failed it: an HTTP status, a gRPC trailer, or a transport error. */
  | { readonly kind: "remote-error"; readonly error: Error }
  /** The client closed or aborted it. */
  | { readonly kind: "local-close" };

/**
 * One validated bidirectional HTTP/2 stream.
 *
 * Bytes in are an async iterable (so a provider pumps frames naturally and
 * backpressure comes from the consumer); bytes out are `write`, which resolves
 * once the chunk has drained — a bidi Run can carry megabytes, and an
 * unawaited write is how a stream overruns its session memory and dies with
 * `ENHANCE_YOUR_CALM`.
 */
export interface ValidatedHttp2BidiStream {
  readonly response: Http2BidiResponse;
  /** Response trailers, populated when the server sends them (gRPC status). */
  readonly trailers: Readonly<Record<string, string>>;
  /** Response body bytes, in arrival order. */
  readonly body: AsyncIterable<Uint8Array>;
  /** Writes one request chunk, resolving when it has drained. */
  write(chunk: Uint8Array): Promise<void>;
  /** Half-closes the request side; the response may still be streaming. */
  end(): void;
  /** Tears the stream down immediately. Idempotent. */
  abort(reason?: unknown): void;
  /** Registers a terminal listener; the returned function unregisters it. */
  onTerminal(listener: (reason: Http2BidiEndReason) => void): () => void;
}

/** Options for opening one validated bidi stream. */
export interface Http2BidiOpenOptions {
  readonly signal?: AbortSignal;
  /** Bytes read idle before the stream is declared dead. */
  readonly readIdleMs?: number;
  /** Upper bound on buffered inbound bytes before the stream is refused. */
  readonly maxBufferedBytes?: number;
  /**
   * Host allowlist applied on every new connection, in addition to the SSRF
   * policy. A long-lived stream carries the account credential for its whole
   * life, so "is this host one the caller may reach at all" is a per-provider
   * decision the binding enforces rather than trusts the adapter to apply.
   */
  readonly allowHostname?: (hostname: string) => boolean;
}

/**
 * The dialer contract a provider adapter is handed.
 *
 * Declared here rather than in the provider layer so the dependency runs one
 * way: `provider-contracts` imports this module, never the reverse, and this
 * transport-neutral contract stays free of any knowledge of providers.
 */
export type ValidatedOutboundHttp2Bidi = (
  url: URL,
  headers: Readonly<Record<string, string>>,
  options?: Http2BidiOpenOptions,
) => Promise<ValidatedHttp2BidiStream>;
