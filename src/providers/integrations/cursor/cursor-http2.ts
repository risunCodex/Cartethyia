// Cursor Run transport: one validated HTTP/2 bidi stream, framed.
//
// This module owns the wire and nothing else. It opens the stream through the
// validated HTTP/2 binding, writes Connect frames, decodes response frames back
// into protobuf messages, and maps stream/HTTP/gRPC outcomes onto typed errors.
// It never calls `node:http2.connect` itself — the binding owns the socket, the
// DNS pinning, the SSRF policy, and the pool tunnel.
import { GatewayError } from "../../../protocol/gateway-error";
import type { ValidatedHttp2BidiStream, Http2BidiEndReason } from "../../../network/bidi";
import type { ValidatedOutboundHttp2Bidi } from "../../provider-contracts";
import { decodeFramePayload, encodeFrame, streamFrames, FLAG_END_STREAM } from "./protocol/framing";
import { decodeMessage } from "./protocol/messages";
import {
  CONTENT_TYPE_CONNECT_PROTO,
  CONNECT_PROTOCOL_VERSION,
  CURSOR_API_BASE_URL,
  FALLBACK_CLIENT_VERSION,
  RUN_PATH,
  isAllowedAgentHost,
  resolveCursorTimezone,
} from "./cursor-shared";
import { createCursorChecksumHeader, resolveCursorDeviceIds } from "./cursor-identity";
import { fnv1a32 } from "../shared/hash";

import { isRecord } from "../../../protocol/codecs";

/**
 * The refusal Cursor sends inside an otherwise-successful 200 Run stream.
 *
 * It is a Connect JSON error envelope, not protobuf, and it is where a real
 * account-level refusal lands — a rate-limited or exhausted account streams a
 * heartbeat and then this. Without it the Run looks like a deadlock: the
 * stream opened, no text ever arrived, and nothing named the reason.
 */
function connectErrorEnvelope(payload: Uint8Array): GatewayError | undefined {
  const text = new TextDecoder().decode(payload);
  if (!text.trimStart().startsWith("{\"error\"")) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || !isRecord(parsed["error"])) return undefined;
  const error = parsed["error"];
  const code = typeof error["code"] === "string" ? error["code"] : "";
  const detail = cursorErrorDetail(error);
  if (code === "resource_exhausted") {
    return new GatewayError(
      "quota_exceeded",
      429,
      `Cursor refused the Run: ${detail} (request {requestId}). You've maxed this window — pace yourself ⏳`,
      { providerId: "cursor", upstreamCode: code },
      "upstream",
    );
  }
  return new GatewayError(
    "platform_unavailable",
    502,
    `Cursor refused the Run: ${detail} (request {requestId}). The upstream came back empty-handed — retry 🌙`,
    { providerId: "cursor", upstreamCode: code },
    "upstream",
  );
}

/** The human-readable refusal, preferring Cursor's own `chatMessage`/`detail`. */
function cursorErrorDetail(error: Record<string, unknown>): string {
  const raw = typeof error["message"] === "string" ? error["message"] : "";
  for (const detail of Array.isArray(error["details"]) ? error["details"] : []) {
    if (!isRecord(detail)) continue;
    const debug = detail["debug"];
    if (!isRecord(debug)) continue;
    const info = debug["details"];
    if (isRecord(info)) {
      const chat = info["chatMessage"];
      if (typeof chat === "string" && chat.length > 0) return chat;
      const title = info["title"];
      if (typeof title === "string" && title.length > 0) return title;
    }
  }
  return raw.length > 0 ? raw : "Cursor refused the Run";
}

/** One decoded Cursor server message. */
export interface CursorServerMessage {
  readonly raw: Record<string, unknown>;
}

/** Read-idle bound for one Run stream. */
const DEFAULT_READ_IDLE_MS = 120_000;

/** Cursor identity headers for the Run stream. */
async function runHeaders(
  credential: string,
  clientVersion: string,
  requestId: string,
): Promise<Record<string, string>> {
  const { machineId, macMachineId } = await resolveCursorDeviceIds();
  return {
    authorization: `Bearer ${credential}`,
    "content-type": CONTENT_TYPE_CONNECT_PROTO,
    "connect-protocol-version": CONNECT_PROTOCOL_VERSION,
    "connect-accept-encoding": "gzip,br",
    "x-cursor-client-type": "cli",
    "x-cursor-client-version": clientVersion,
    "x-cursor-checksum": createCursorChecksumHeader(machineId, macMachineId),
    // The CLI's streaming interceptor sets this on the bidi Run stream.
    // Without it Cursor may treat the stream as non-streaming.
    "x-cursor-streaming": "true",
    "x-ghost-mode": "true",
    "x-request-id": requestId,
    ...(resolveCursorTimezone() === "" ? {} : { "x-cursor-timezone": resolveCursorTimezone() }),
    "user-agent": "connect-es/1.6.1",
  };
}

/**
 * Opens one Cursor Run stream.
 *
 * The host is re-validated here as well as in the binding: the Run origin comes
 * from `GetServerConfig`, which is upstream data, so it is checked against the
 * Cursor allowlist before a credentialed connection is opened to it.
 */
export async function openCursorRun(input: {
  readonly origin: string;
  readonly credential: string;
  readonly outboundHttp2: ValidatedOutboundHttp2Bidi;
  readonly signal: AbortSignal;
  readonly clientVersion?: string;
  readonly readIdleMs?: number;
  readonly requestId?: string;
}): Promise<{ stream: ValidatedHttp2BidiStream; requestId: string; write: (message: Uint8Array) => Promise<void> }> {
  const url = new URL(`${input.origin}${RUN_PATH}`);
  if (url.protocol !== "https:" || !isAllowedAgentHost(url.hostname)) {
    throw new GatewayError(
      "invalid_request",
      400,
      "Cursor Run requires an allowlisted Cursor agent origin (request {requestId}). All roads blocked — time to find a new route 🗺️",
      { origin: input.origin },
    );
  }
  const requestId = input.requestId ?? crypto.randomUUID();
  const headers = await runHeaders(input.credential, input.clientVersion ?? FALLBACK_CLIENT_VERSION, requestId);
  const stream = await input.outboundHttp2(url, headers, {
    signal: input.signal,
    readIdleMs: input.readIdleMs ?? DEFAULT_READ_IDLE_MS,
    allowHostname: isAllowedAgentHost,
  });
  return {
    stream,
    requestId,
    write: async (message: Uint8Array): Promise<void> => {
      await stream.write(encodeFrame(0, message));
    },
  };
}

/** Map of gRPC status codes onto gateway errors. */
function grpcError(status: string, message: string | undefined): GatewayError {
  const code = Number(status);
  const detail = message === undefined || message.length === 0 ? "" : `: ${message}`;
  if (code === 16 || code === 7) {
    // UNAUTHENTICATED / PERMISSION_DENIED: the credential, not the request.
    return new GatewayError(
      "authentication_failed",
      401,
      `Cursor refused the credential${detail} (request {requestId}). Wrong key, right door — check the credential 🔑`,
      { grpcStatus: status },
      "upstream",
    );
  }
  if (code === 8 || code === 14) {
    return new GatewayError(
      "quota_exceeded",
      429,
      `Cursor refused the Run${detail} (request {requestId}). You've maxed this window — pace yourself ⏳`,
      { grpcStatus: status },
      "upstream",
    );
  }
  if (code === 4 || code === 10) {
    return new GatewayError(
      "deadline_exceeded",
      504,
      `Cursor Run ended before it finished${detail} (request {requestId}). Some things just take longer 🐢`,
      { grpcStatus: status },
      "upstream",
    );
  }
  return new GatewayError(
    "platform_unavailable",
    502,
    `Cursor Run failed (gRPC ${status})${detail} (request {requestId}). The upstream came back empty-handed — retry 🌙`,
    { grpcStatus: status },
    "upstream",
  );
}

/**
 * The terminal error for one ended Run stream.
 *
 * Status, trailers, and transport error are read in that order because that is
 * the order of authority: an HTTP status is what the edge answered, a gRPC
 * trailer is what the server decided, and a transport error is what the socket
 * did. A clean close with none of them is still a failure — a Run that ends
 * without `turn_ended` produced no answer.
 */
export function cursorRunTerminationError(input: {
  readonly stream: ValidatedHttp2BidiStream;
  readonly reason: Http2BidiEndReason;
}): GatewayError | undefined {
  if (input.reason.kind === "local-close") return undefined;
  if (input.reason.kind === "remote-error") {
    return input.reason.error instanceof GatewayError
      ? input.reason.error
      : new GatewayError(
          "transport_unavailable",
          502,
          `Cursor Run transport interrupted: ${input.reason.error.message} (request {requestId}). The connection ghosted us — come back in a moment 👻`,
          {},
          "network",
        );
  }
  const { status, headers } = input.stream.response;
  if (status !== 0 && status !== 200) {
    const message = headers["grpc-message"];
    return new GatewayError(
      status === 401 || status === 403 ? "authentication_failed" : "platform_unavailable",
      status === 401 || status === 403 ? 401 : 502,
      `Cursor Run failed by remote: ${status} (request {requestId}). The upstream came back empty-handed — retry 🌙`,
      { httpStatus: status, ...(message === undefined ? {} : { upstreamMessage: message }) },
      "upstream",
    );
  }
  const trailers = input.stream.trailers;
  const grpcStatus = trailers["grpc-status"] ?? headers["grpc-status"];
  if (grpcStatus !== undefined && grpcStatus !== "0") {
    return grpcError(grpcStatus, trailers["grpc-message"] ?? headers["grpc-message"]);
  }
  return new GatewayError(
    "platform_unavailable",
    502,
    "Cursor Run ended before turn_ended (request {requestId}). The upstream came back empty-handed — retry 🌙",
    {},
    "upstream",
  );
}

/**
 * Decodes a response byte stream into Cursor server messages.
 *
 * Buffering is bounded and the leftover is carried forward rather than
 * re-merged from scratch: a Run frame can be many megabytes, and copying the
 * whole pending buffer on every chunk is what turns a long Run into a stall.
 */
export async function* decodeServerMessages(
  body: AsyncIterable<Uint8Array>,
  maxBufferedBytes = 64 * 1024 * 1024,
): AsyncGenerator<Record<string, unknown>, void, void> {
  let pending: Uint8Array = new Uint8Array(0);
  for await (const chunk of body) {
    pending = pending.byteLength === 0 ? chunk : concat(pending, chunk);
    if (pending.byteLength > maxBufferedBytes) {
      throw new GatewayError(
        "platform_unavailable",
        502,
        "Cursor Run exceeded the frame buffer bound (request {requestId}). The upstream sent more than we can hold — retry 🌙",
        {},
        "upstream",
      );
    }
    const frames = [...streamFrames(pending)];
    if (frames.length === 0) continue;
    let consumed = 0;
    for (const frame of frames) consumed += 5 + frame.payload.byteLength;
    const leftover = pending.subarray(consumed);
    pending = leftover.byteLength === 0 ? new Uint8Array(0) : new Uint8Array(leftover);
    for (const frame of frames) {
      const payload = decodeFramePayload(frame);
      // A refusal is a Connect JSON error envelope, not protobuf: an exhausted
      // account answers with one inside a normal 200 stream. Surfacing it is
      // the difference between "the model said nothing" and "you hit your
      // usage limit".
      const envelope = connectErrorEnvelope(payload);
      if (envelope !== undefined) throw envelope;
      try {
        const decoded = decodeMessage("AgentServerMessage", payload);
        // Shape-only wire traces and checkpoint retention need the raw frame,
        // but the decoded message must stay a plain protobuf object for the
        // adapter (and for encodeMessage round-trips). Non-enumerable keeps it
        // out of Object.keys/JSON, so no existing consumer sees a new field.
        Object.defineProperty(decoded, "__bytes", { value: payload, enumerable: false });
        yield decoded;
      } catch {
        // One undecodable frame is not a protocol failure to abort on: Cursor
        // extends this schema with fields this vendored copy does not model, and
        // a Run that produced usable output must not die on one unknown field.
        continue;
      }
      // `END_STREAM` ends the *response*, not the payload: Cursor sets it on the
      // last frame of a Run, which is exactly the frame carrying `turn_ended`
      // and the model's final text. Returning before decoding it dropped every
      // answer and left the Run looking like a heartbeat-only deadlock.
      if ((frame.flags & FLAG_END_STREAM) !== 0) return;
    }
  }
}

function concat(left: Uint8Array, right: Uint8Array): Uint8Array {
  const out = new Uint8Array(left.byteLength + right.byteLength);
  out.set(left, 0);
  out.set(right, left.byteLength);
  return out;
}

// ---------------------------------------------------------------------------
// Normalized Run transport, and the HTTP/1.1 fallback.
//
// HTTP/2 is the Run's native shape, but a network that cannot carry a
// bidirectional HTTP/2 stream (a tunneling proxy, an ALPN-restricted middlebox)
// must not turn Cursor into a provider that cannot serve at all: Cursor's own
// clients run the same conversation over HTTP/1.1, with the server's frames
// down one `AgentService/RunSSE` stream and each client message up as a
// numbered `BidiService/BidiAppend` call (donor wire, verified: the append
// body is raw protobuf — hex message, the request id, the sequence number —
// not a Connect frame).
// ---------------------------------------------------------------------------

/** Why one Run transport ended, with the failure the pump should surface. */
export interface CursorRunTerminal {
  readonly kind: "remote-error" | "remote-clean-close" | "local-close";
  readonly failure: GatewayError | undefined;
}

/**
 * One Run's wire, normalized across transports.
 *
 * `body` yields raw response bytes (Connect-framed server messages) and
 * `write` sends one framed client message; the frame pump in the adapter
 * consumes both without knowing which transport is underneath.
 */
export interface CursorRunTransport {
  readonly mode: "http2" | "http1";
  readonly body: AsyncIterable<Uint8Array>;
  write(message: Uint8Array): Promise<void>;
  abort(): void;
  /** Terminal listener; at most one terminal is delivered per transport. */
  onTerminal(listener: (terminal: CursorRunTerminal) => void): () => void;
}

/** Wraps the validated HTTP/2 stream in the normalized transport shape. */
export function wrapHttp2Run(
  stream: ValidatedHttp2BidiStream,
  write: (message: Uint8Array) => Promise<void>,
): CursorRunTransport {
  const listeners = new Set<(terminal: CursorRunTerminal) => void>();
  let settled = false;
  const settle = (terminal: CursorRunTerminal): void => {
    if (settled) return;
    settled = true;
    for (const listener of [...listeners]) {
      try {
        listener(terminal);
      } catch {
        // A listener failure must not skip the remaining listeners.
      }
    }
    listeners.clear();
  };
  stream.onTerminal((reason) => {
    if (reason.kind === "local-close") {
      settle({ kind: "local-close", failure: undefined });
      return;
    }
    if (reason.kind === "remote-clean-close") {
      // A clean close carries no failure of its own: the pump decides whether
      // a turn that ended without `turn_ended` is complete (text/step/tool
      // batch) or quiet. `cursorRunTerminationError` is for status/trailer
      // refusals, not for a stream the server simply closed.
      settle({ kind: "remote-clean-close", failure: undefined });
      return;
    }
    settle({
      kind: "remote-error",
      failure: cursorRunTerminationError({ stream, reason }) ?? undefined,
    });
  });
  return {
    mode: "http2",
    body: stream.body,
    write,
    abort: () => stream.abort(),
    onTerminal: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** HTTP/1.1 Run constants, as the donor's clients pin them. */
const H1 = {
  /** ms a BidiAppend may take before the Run fails (donor appendWait). */
  appendWaitMs: 60_000,
  /** BidiAppends allowed on the wire at once (donor atOnce). */
  atOnce: 16,
} as const;

/** ms after one h2-blocked open that fresh Runs go straight to HTTP/1.1. */
const H2_RETRY_AFTER_MS = 10 * 60_000;
/** ms an HTTP/2 open may take before the transport itself is declared blocked. */
const H2_HEAD_WAIT_MS = 15_000;

/** Per-credential HTTP/1.1 window after one h2-blocked open, digest-keyed. */
const h1UntilByCredential = new Map<string, number>();

function credentialDigest(credential: string): string {
  return String(fnv1a32(credential));
}

/** True when the failure to open an HTTP/2 Run says HTTP/2 itself is blocked. */
export function isH2BlockedOpen(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = String((error as Error & { code?: string }).code ?? "");
  if (/^ERR_HTTP2|^EPROTO/.test(code)) return true;
  const message = `${error.message} ${code}`.toLowerCase();
  return (
    /http\/?2|nghttp2|alpn|protocol error|settings frame|flow control/.test(message) &&
    !/refused|enotfound|econn|enetunreach|ehostunreach|epipe/.test(message)
  );
}

/**
 * Whether a failed Run *open* is worth retrying on a fresh transport.
 *
 * Connection and deadline failures are retried; auth, quota, and request-shape
 * refusals are not — retrying those just burns the account's remaining window.
 */
export function isRetryableOpenFailure(error: unknown): boolean {
  if (!(error instanceof GatewayError)) {
    // Raw transport throws (DNS, dial, TLS) come through as plain errors.
    return true;
  }
  if (error.code === "authentication_failed") return false;
  if (error.code === "quota_exceeded") return false;
  if (error.code === "invalid_request") return false;
  return true;
}

/** Backoff for open retries: 500 ms doubling, capped at 8 s (donor policy). */
export function openRetryDelayMs(attempt: number): number {
  return Math.min(500 * 2 ** attempt, 8_000);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new GatewayError("transport_closed", 499, "The request was cancelled (request {requestId}). Send it again whenever ready 🙃"));
      },
      { once: true },
    );
  });
}

/** Applies the open-retry backoff; exported as part of the transport policy. */
export { sleep as cursorSleep };

/** Connect's code for an HTTP status that carried no Connect error of its own. */
function connectCodeForStatus(status: number): string {
  return { 400: "invalid_argument", 401: "unauthenticated", 403: "permission_denied", 429: "resource_exhausted" }[
    status
  ] ?? "unavailable";
}

/** Maps an HTTP/1.1 Run failure onto the gateway's error taxonomy. */
function h1OpenFailure(status: number, message: string): GatewayError {
  if (status === 401 || status === 403) {
    return new GatewayError(
      "authentication_failed",
      401,
      `Cursor refused the credential over HTTP/1.1: ${message} (request {requestId}). Wrong key, right door — check the credential 🔑`,
      {},
      "upstream",
    );
  }
  if (status === 429) {
    return new GatewayError(
      "quota_exceeded",
      429,
      `Cursor refused the Run over HTTP/1.1: ${message} (request {requestId}). You've maxed this window — pace yourself ⏳`,
      {},
      "upstream",
    );
  }
  return new GatewayError(
    "platform_unavailable",
    502,
    `Cursor Run failed over HTTP/1.1: ${message} (request {requestId}). The upstream came back empty-handed — retry 🌙`,
    {},
    "upstream",
  );
}

/** varint encoding for the BidiAppend body builder. */
function appendVarint(out: number[], value: number): void {
  let v = value;
  while (v > 0x7f) {
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(v);
}

/**
 * Builds one raw `aiserver.v1.BidiAppendRequest` body:
 * field 1 `data` (hex string), field 2 `requestId` (message, field 1 string),
 * field 3 `appendSeqno` (int64). Verified against the donor's wire encoder.
 */
function bidiAppendBody(message: Uint8Array, requestId: string, seqno: number): Uint8Array {
  const hex = Buffer.from(message).toString("hex");
  const data = new TextEncoder().encode(hex);
  const id = new TextEncoder().encode(requestId);
  const out: number[] = [];
  out.push(0x0a);
  appendVarint(out, data.byteLength);
  for (const byte of data) out.push(byte);
  out.push(0x12, 2 + id.byteLength, 0x0a);
  appendVarint(out, id.byteLength);
  for (const byte of id) out.push(byte);
  out.push(0x18);
  appendVarint(out, seqno);
  return new Uint8Array(out);
}

/** True when a client message is a KV blob reply, which no append waits on. */
function isKvReply(message: Uint8Array): boolean {
  return message.byteLength > 0 && message[0] === 0x1a;
}

/**
 * Opens one Run over HTTP/1.1: the server's frames come down one RunSSE
 * stream, every client message goes up as a numbered BidiAppend call.
 *
 * Failures of an append or of the down stream end the Run with a synthesized
 * Connect error envelope (END_STREAM), so the shared decoder surfaces it as
 * the Run's own refusal — the pump cannot tell the transports apart.
 */
export async function openCursorRunH1(input: {
  readonly requestId: string;
  readonly credential: string;
  readonly fetcher: typeof fetch;
  readonly signal: AbortSignal;
  readonly clientVersion?: string;
  readonly readIdleMs?: number;
}): Promise<CursorRunTransport> {
  const ac = new AbortController();
  const forwardAbort = (): void => ac.abort();
  input.signal.addEventListener("abort", forwardAbort, { once: true });
  if (input.signal.aborted) ac.abort();

  const headers = await runHeaders(input.credential, input.clientVersion ?? FALLBACK_CLIENT_VERSION, input.requestId);
  const wireHeaders = {
    ...headers,
    "accept-encoding": "identity",
    "x-cursor-streaming": "true",
  };

  const listeners = new Set<(terminal: CursorRunTerminal) => void>();
  let ended = false;
  let settled = false;
  let seqno = 0;
  const inflight = new Set<Promise<void>>();

  const queue: Array<Uint8Array | null> = [];
  let waiter: (() => void) | undefined;
  const pushDown = (chunk: Uint8Array | null): void => {
    queue.push(chunk);
    const wake = waiter;
    waiter = undefined;
    wake?.();
  };
  const settle = (terminal: CursorRunTerminal): void => {
    if (settled) return;
    settled = true;
    for (const listener of [...listeners]) {
      try {
        listener(terminal);
      } catch {
        // A listener failure must not skip the remaining listeners.
      }
    }
    listeners.clear();
  };

  const failStream = (code: string, message: string, status: number): void => {
    if (ended) return;
    ended = true;
    // Synthesized Connect error envelope: the shared decoder reads it as the
    // Run's own refusal, exactly as it does over HTTP/2.
    const json = new TextEncoder().encode(JSON.stringify({ error: { code, message } }));
    pushDown(encodeFrame(FLAG_END_STREAM, json));
    pushDown(null);
    settle({ kind: "remote-error", failure: h1OpenFailure(status, message) });
  };

  const endCleanly = (): void => {
    if (ended || inflight.size > 0) return;
    ended = true;
    pushDown(null);
    settle({ kind: "remote-clean-close", failure: undefined });
  };

  const append = async (message: Uint8Array): Promise<void> => {
    const seq = seqno;
    seqno += 1;
    const body = bidiAppendBody(message, input.requestId, seq);
    const deadlineMs = H1.appendWaitMs + Math.ceil(body.byteLength / 65_536) * 1_000;
    const deadline = AbortSignal.timeout(deadlineMs);
    try {
      const response = await input.fetcher(`${CURSOR_API_BASE_URL}/aiserver.v1.BidiService/BidiAppend`, {
        method: "POST",
        headers: { ...wireHeaders, "content-type": "application/proto" },
        body: body as unknown as BodyInit,
        signal: AbortSignal.any([ac.signal, deadline]),
      });
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        failStream(connectCodeForStatus(response.status), text.trim() || `HTTP ${response.status}`, response.status);
        return;
      }
      await response.arrayBuffer().catch(() => undefined);
    } catch (error) {
      if (ac.signal.aborted || input.signal.aborted) return;
      if (deadline.aborted) {
        failStream("deadline_exceeded", `BidiAppend got no answer in ${Math.round(deadlineMs / 1_000)}s`, 504);
        return;
      }
      failStream("unavailable", `BidiAppend: ${error instanceof Error ? error.message : String(error)}`, 502);
    }
  };

  const track = (promise: Promise<void>): void => {
    inflight.add(promise);
    void promise.finally(() => {
      inflight.delete(promise);
      // A down stream that already ended cleanly while appends were on the
      // wire becomes terminal only once they have all been answered.
      if (inflight.size === 0 && sseDone && !ended) endCleanly();
    });
  };
  let sseDone = false;
  /** One append whose completion the write path waits on. */
  const appendTracked = (message: Uint8Array): Promise<void> => {
    const promise = append(message);
    track(promise);
    return promise;
  };

  const transport: CursorRunTransport = {
    mode: "http1",
    body: {
      [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
        return {
          next: async (): Promise<IteratorResult<Uint8Array>> => {
            for (;;) {
              const front = queue.shift();
              if (front === undefined) {
                if (ended) return { done: true, value: undefined };
                await new Promise<void>((resolve) => {
                  waiter = resolve;
                });
                continue;
              }
              if (front === null) return { done: true, value: undefined };
              return { done: false, value: front };
            }
          },
        };
      },
    },
    write: async (message: Uint8Array): Promise<void> => {
      if (ended || ac.signal.aborted) {
        throw new GatewayError(
          "transport_unavailable",
          502,
          "Cursor Run transport is closed (request {requestId}). The connection ghosted us — come back in a moment 👻",
          {},
          "network",
        );
      }
      // KV blob replies never wait: nothing else depends on them, and Cursor
      // asks for a fresh Run's whole history at once (donor kvReply rule).
      if (isKvReply(message)) {
        track(append(message));
        return;
      }
      // Every other message serializes: it goes up only after the appends
      // before it were answered, in sequence order (donor ordering rule).
      while (inflight.size > 0 && !ended && !ac.signal.aborted) {
        await Promise.race([...inflight]);
      }
      if (ended || ac.signal.aborted) {
        throw new GatewayError(
          "transport_unavailable",
          502,
          "Cursor Run transport is closed (request {requestId}). The connection ghosted us — come back in a moment 👻",
          {},
          "network",
        );
      }
      await appendTracked(message);
    },
    abort: () => {
      ac.abort();
      if (!ended) {
        ended = true;
        pushDown(null);
        settle({ kind: "local-close", failure: undefined });
      }
    },
    onTerminal: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };

  // Down stream: RunSSE, opened with one Connect frame carrying the request
  // id (field 1, string) — the linkage every append repeats. The opener is
  // a regular message frame (flags 0), not an END_STREAM frame: END_STREAM
  // ends the *response*, not the request body.
  void (async () => {
    try {
      const id = new TextEncoder().encode(input.requestId);
      const runOpen = new Uint8Array(2 + id.byteLength);
      runOpen[0] = 0x0a;
      runOpen[1] = id.byteLength;
      runOpen.set(id, 2);
      const response = await input.fetcher(`${CURSOR_API_BASE_URL}/agent.v1.AgentService/RunSSE`, {
        method: "POST",
        headers: wireHeaders,
        body: encodeFrame(0, runOpen) as unknown as BodyInit,
        signal: ac.signal,
      });
      if (!response.ok || response.body === null) {
        const text = response.body === null ? "no response body" : await response.text().catch(() => "");
        failStream(
          connectCodeForStatus(response.status),
          text.trim() || `HTTP ${response.status}`,
          response.status,
        );
        return;
      }
      const reader = response.body.getReader();
      const readIdleMs = input.readIdleMs ?? DEFAULT_READ_IDLE_MS;
      for (;;) {
        if (ended) {
          await reader.cancel().catch(() => undefined);
          return;
        }
        const chunk = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) => {
            const timer = setTimeout(() => reject(new Error(`RunSSE idle past ${readIdleMs}ms`)), readIdleMs);
            timer.unref?.();
          }),
        ]);
        if (chunk.done) {
          sseDone = true;
          endCleanly();
          return;
        }
        pushDown(chunk.value);
      }
    } catch (error) {
      if (ac.signal.aborted || input.signal.aborted) {
        if (!ended) {
          ended = true;
          pushDown(null);
          settle({ kind: "local-close", failure: undefined });
        }
        return;
      }
      failStream("unavailable", `RunSSE: ${error instanceof Error ? error.message : String(error)}`, 502);
    }
  })();

  return transport;
}

/**
 * Opens one Cursor Run with the donor's transport policy: HTTP/2 first, and —
 * when HTTP/2 itself is blocked here — HTTP/1.1 immediately, with fresh Runs
 * staying on HTTP/1.1 for a window. A plain connection failure leaves the next
 * Run on HTTP/2 again; it says nothing about HTTP/2 being unavailable.
 */
export async function openCursorRunWithFallback(input: {
  readonly origin: string;
  readonly credential: string;
  readonly outboundHttp2: ValidatedOutboundHttp2Bidi | undefined;
  readonly outboundFetch: typeof fetch | undefined;
  readonly signal: AbortSignal;
  readonly clientVersion?: string;
  readonly readIdleMs?: number;
  /** Stable request id across H2 → H1 fallback and stream retries. */
  readonly requestId?: string;
  /** Force HTTP/1.1 after a mid-stream HTTP/2 failure. */
  readonly forceH1?: boolean;
}): Promise<{ transport: CursorRunTransport; requestId: string }> {
  const digest = credentialDigest(input.credential);
  const h1Until = h1UntilByCredential.get(digest) ?? 0;
  if (input.forceH1 === true) h1UntilByCredential.set(digest, Date.now() + H2_RETRY_AFTER_MS);
  if (input.forceH1 === true || Date.now() < h1Until || input.outboundHttp2 === undefined) {
    return openH1OrThrow(input, input.requestId ?? crypto.randomUUID(), digest);
  }
  let openedPromise: ReturnType<typeof openCursorRun> | undefined;
  try {
    openedPromise = openCursorRun({
      origin: input.origin,
      credential: input.credential,
      outboundHttp2: input.outboundHttp2,
      signal: input.signal,
      ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
      ...(input.clientVersion === undefined ? {} : { clientVersion: input.clientVersion }),
      ...(input.readIdleMs === undefined ? {} : { readIdleMs: input.readIdleMs }),
    });
    let headTimedOut = false;
    let headTimer: ReturnType<typeof setTimeout> | undefined;
    let opened: Awaited<typeof openedPromise>;
    try {
      opened = await Promise.race([
        openedPromise,
        new Promise<never>((_, reject) => {
          headTimer = setTimeout(() => {
            headTimedOut = true;
            reject(Object.assign(new Error("HTTP/2 Run got no response head in 15s"), { name: "H2HeadTimeout" }));
          }, H2_HEAD_WAIT_MS);
          headTimer.unref?.();
        }),
      ]);
    } finally {
      clearTimeout(headTimer);
      // A head that arrived after the timeout is a live stream nobody owns:
      // abort it instead of leaking the socket.
      if (headTimedOut) void openedPromise.then((o) => o.stream.abort(), () => undefined);
    }
    return {
      transport: wrapHttp2Run(opened.stream, opened.write),
      requestId: opened.requestId,
    };
  } catch (error) {
    if (!isH2BlockedOpen(error)) throw error;
    h1UntilByCredential.set(digest, Date.now() + H2_RETRY_AFTER_MS);
    // The donor keeps one request id across the fallback: RunSSE's opener and
    // every BidiAppend repeat the id the HTTP/2 Run was opened with.
    return openH1OrThrow(
      input,
      input.requestId ?? openedPromise?.then((o) => o.requestId).catch(() => crypto.randomUUID()) ?? crypto.randomUUID(),
      digest,
    );
  }
}

/** Opens the HTTP/1.1 fallback, refusing when no validated egress can carry it. */
async function openH1OrThrow(
  input: {
    readonly credential: string;
    readonly outboundFetch: typeof fetch | undefined;
    readonly signal: AbortSignal;
    readonly clientVersion?: string;
    readonly readIdleMs?: number;
  },
  requestId: string | Promise<string>,
  digest: string,
): Promise<{ transport: CursorRunTransport; requestId: string }> {
  const id = await requestId;
  if (input.outboundFetch === undefined) {
    throw new GatewayError(
      "admission_unavailable",
      503,
      "Cursor fell back to HTTP/1.1 but no validated egress is configured for this route (request {requestId}). No bridge to cross — configure a pool first 🏗️",
      { providerId: "cursor" },
    );
  }
  const transport = await openCursorRunH1({
    requestId: id,
    credential: input.credential,
    fetcher: input.outboundFetch,
    signal: input.signal,
    ...(input.clientVersion === undefined ? {} : { clientVersion: input.clientVersion }),
    ...(input.readIdleMs === undefined ? {} : { readIdleMs: input.readIdleMs }),
  });
  void digest;
  return { transport, requestId: id };
}
