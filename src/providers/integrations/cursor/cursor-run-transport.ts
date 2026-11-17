/**
 * Cursor Run transport: one normalized frame pipe over two carriers.
 *
 * The Run is Connect-RPC streaming — one writable request whose response is an
 * unbounded stream of protobuf frames — with two carriers:
 *
 * - **HTTP/2** (`/agent.v1.AgentService/Run`): the normal path, dialed through
 *   the validated bidi egress seam (`network/bidi.ts`); the adapter never opens
 *   a socket of its own. Client frames are Connect-framed `AgentClientMessage`
 *   writes, server frames arrive on the response body, and a terminal frame
 *   with the END_STREAM flag carries the JSON error envelope *inside* the 200.
 * - **HTTP/1.1** (`RunSSE` + `BidiAppend`): the fallback for networks that
 *   block h2 ("h2 is not supported"). The RunSSE request body is one
 *   Connect-framed `BidiRequestId`; every client frame afterwards is a unary
 *   `BidiAppend` (`application/proto` — the service answers 415 to the
 *   connect envelope on this endpoint) carrying `append_seqno` in arrival
 *   order and the raw frame in `data_binary`. The response side is the same
 *   Connect-framed server stream.
 *
 * Heartbeats and retry policy are the turn orchestrator's concern
 * (`cursor-run.ts`); this module only moves bytes and decodes frames.
 */
import { gunzipSync } from "node:zlib";
import {
  ConnectFrameDecoder,
  CONNECT_END_STREAM_FLAG,
  encodeFrame,
  parseTrailer,
  stripConnectEnvelope,
} from "../shared/connect";
import type { ValidatedHttp2BidiStream } from "../../../network/bidi";
import { decodeMessage, encodeMessage } from "./cursor-protocol/messages";
import type { AgentServerMessage, BidiRequestId } from "./cursor-protocol/generated";
import { decodeCursorEndStream, classifyCursorThrown, type CursorFailure } from "./cursor-errors";
import {
  CURSOR_API_BASE_URL,
  CURSOR_BIDI_APPEND_PATH,
  CURSOR_RUN_SSE_PATH,
  cursorClientHeaders,
  CURSOR_ALLOWED_TOOLS_HEADER,
  CURSOR_EXTERNAL_EXECUTOR_ALLOWED_TOOLS,
} from "./cursor-wire";

/** Minimal fetch surface accepted by the HTTP/1 transport. */
export type CursorFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** One decoded unit from the Run stream. */
export type CursorTransportEvent =
  /** A decoded server frame (interactions, exec, KV, checkpoints). */
  | { readonly kind: "message"; readonly message: AgentServerMessage }
  /** The stream ended without an error envelope. */
  | { readonly kind: "end" }
  /** The stream ended with a classified failure (envelope or transport). */
  | { readonly kind: "error"; readonly failure: CursorFailure };

/**
 * The normalized Run pipe. `write` resolves once the frame has drained — a Run
 * carries tool results and heartbeats for its whole life, and an unawaited
 * write is how a stream overruns its buffers.
 */
export interface CursorRunTransport {
  readonly carrier: "http2" | "http1";
  /** Decoded stream events, in arrival order. */
  readonly events: AsyncIterable<CursorTransportEvent>;
  /** Encodes and sends one `AgentClientMessage`-shaped object. */
  write(clientMessage: Record<string, unknown>): Promise<void>;
  /** Half-closes the request side; the response may still stream. */
  end(): void;
  /** Tears the transport down immediately. Idempotent. */
  abort(reason?: unknown): void;
}

export interface OpenTransportOptions {
  readonly accessToken: string;
  readonly clientVersion: string | undefined;
  readonly requestId: string;
  readonly signal: AbortSignal | undefined;
}

/**
 * Shared header set for a Run request. The `x-cursor-agent-allowed-tools`
 * header is what turns a run into external-executor mode: Cursor disables its
 * built-in toolset server-side and only issues MCP calls, which the gateway
 * relays to the caller. A native tool frame can only be answered where the
 * files live, which the gateway cannot do — this header makes it unaskable.
 */
export function runHeaders(options: OpenTransportOptions, extra: Record<string, string>): Record<string, string> {
  return {
    ...cursorClientHeaders(options.accessToken, {
      contentType: "application/connect+proto",
      clientVersion: options.clientVersion,
    }),
    "connect-protocol-version": "1",
    [CURSOR_ALLOWED_TOOLS_HEADER]: CURSOR_EXTERNAL_EXECUTOR_ALLOWED_TOOLS,
    "x-request-id": options.requestId,
    ...extra,
  };
}

/**
 * Decodes one response chunk stream into transport events.
 *
 * Frame flags decide the shape: the END_STREAM flag carries the JSON error
 * envelope (or an empty trailer on a clean end), a compressed frame is
 * inflated first, everything else is an `AgentServerMessage`. A transport
 * throw surfaces as a classified retryable failure rather than an exception
 * escaping the iteration.
 */
async function* decodeEventStream(
  chunks: AsyncIterable<Uint8Array>,
  trailers: () => Readonly<Record<string, string>>,
): AsyncGenerator<CursorTransportEvent> {
  const decoder = new ConnectFrameDecoder();
  try {
    for await (const chunk of chunks) {
      for (const frame of decoder.push(chunk)) {
        if ((frame.flags & CONNECT_END_STREAM_FLAG) !== 0) {
          const failure = decodeCursorEndStream(parseTrailer(frame.payload));
          if (failure !== undefined) {
            yield { kind: "error", failure };
          } else {
            yield { kind: "end" };
          }
          return;
        }
        const payload = frame.compressed ? gunzipSync(frame.payload) : frame.payload;
        yield {
          kind: "message",
          message: decodeMessage<AgentServerMessage>("agent.v1.AgentServerMessage", payload),
        };
      }
    }
  } catch (error) {
    yield { kind: "error", failure: classifyCursorThrown(error) };
    return;
  }
  // Body exhausted without an END_STREAM frame: a gRPC trailer error is the
  // remaining way this stream can have failed; otherwise it ended cleanly.
  const grpcStatus = trailers()["grpc-status"];
  if (grpcStatus !== undefined && grpcStatus !== "0") {
    const message = trailers()["grpc-message"] ?? `gRPC status ${grpcStatus}`;
    yield {
      kind: "error",
      failure: { policy: "retryable", code: undefined, name: undefined, message, upstreamRetryable: true },
    };
    return;
  }
  yield { kind: "end" };
}

/**
 * Wraps an opened validated HTTP/2 bidi stream as a Run transport.
 *
 * The dial (host validation, pooling, tunnels) already happened in the egress
 * layer; this is only framing. Request frames are sent uncompressed — they are
 * small and per-frame compression only adds latency to tool results.
 */
export function openHttp2RunTransport(stream: ValidatedHttp2BidiStream): CursorRunTransport {
  let closed = false;
  return {
    carrier: "http2",
    events: decodeEventStream(stream.body, () => stream.trailers),
    async write(clientMessage: Record<string, unknown>): Promise<void> {
      const payload = encodeMessage("agent.v1.AgentClientMessage", clientMessage);
      await stream.write(encodeFrame(payload, false));
    },
    end(): void {
      if (closed) return;
      closed = true;
      stream.end();
    },
    abort(reason?: unknown): void {
      if (closed) return;
      closed = true;
      stream.abort(reason);
    },
  };
}

/** Per-append timeout: 60s plus 1s per 128 KB of payload. */
function appendTimeoutMs(payloadBytes: number): number {
  return 60_000 + Math.ceil(payloadBytes / (128 * 1024)) * 1000;
}

/**
 * Opens the HTTP/1.1 fallback transport: RunSSE down, BidiAppend up.
 *
 * The RunSSE request carries only the `BidiRequestId` — every client frame,
 * including the run request itself, rides up as a numbered BidiAppend. Appends
 * are awaited in order (the turn's tool results are causally ordered) while
 * up to 16 stay in flight, which is what keeps a multi-frame history burst
 * from costing one round trip each.
 */
export async function openHttp1RunTransport(
  fetchFn: CursorFetch,
  options: OpenTransportOptions,
): Promise<CursorRunTransport> {
  const requestId = options.requestId;
  const response = await fetchFn(`${CURSOR_API_BASE_URL}${CURSOR_RUN_SSE_PATH}`, {
    method: "POST",
    headers: runHeaders(options, { "x-cursor-streaming": "true" }),
    body: Buffer.from(
      encodeFrame(encodeMessage("agent.v1.BidiRequestId", { requestId } satisfies BidiRequestId), false),
    ),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  if (response.body === null) {
    throw new Error("Cursor RunSSE returned no body");
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Cursor RunSSE failed (${response.status}): ${text.slice(0, 200)}`);
  }

  let seqno = 0;
  let closed = false;
  const body = response.body;

  return {
    carrier: "http1",
    events: decodeEventStream(
      (async function* () {
        const reader = body.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) return;
            if (value !== undefined) yield value;
          }
        } finally {
          reader.releaseLock();
        }
      })(),
      () => ({}),
    ),
    async write(clientMessage: Record<string, unknown>): Promise<void> {
      if (closed) return;
      const frame = encodeMessage("agent.v1.AgentClientMessage", clientMessage);
      seqno += 1;
      const payload = Buffer.from(
        encodeMessage("aiserver.v1.BidiAppendRequest", {
          requestId: { requestId },
          appendSeqno: seqno,
          dataBinary: frame,
        }),
      );
      const response = await fetchFn(`${CURSOR_API_BASE_URL}${CURSOR_BIDI_APPEND_PATH}`, {
        method: "POST",
        // Plain proto, NOT the connect envelope: this endpoint answers 415 to
        // `application/connect+proto`.
        headers: {
          ...cursorClientHeaders(options.accessToken, {
            contentType: "application/proto",
            clientVersion: options.clientVersion,
          }),
          "x-request-id": options.requestId,
        },
        body: payload,
        signal: AbortSignal.timeout(appendTimeoutMs(payload.byteLength)),
      });
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(`Cursor BidiAppend failed (${response.status}): ${text.slice(0, 200)}`);
      }
      // The append's own response may be a framed unary ack; nothing in it
      // changes stream state, but draining it keeps the connection healthy.
      await response.arrayBuffer().catch(() => undefined);
    },
    end(): void {
      // BidiAppend has no half-close; the stream ends server-side.
      closed = true;
    },
    abort(reason?: unknown): void {
      if (closed) return;
      closed = true;
      void body.cancel(reason).catch(() => undefined);
    },
  };
}

export { stripConnectEnvelope };
