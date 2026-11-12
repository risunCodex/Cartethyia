// Cursor Run hardening, adapted end-to-end from oh-my-pi's streamCursorWithWireMode.
//
// The wire opens in cursor-http2.ts; the lifecycle lives in the adapter. These
// are the policies that make a tool loop reliable: classify a transport
// failure once (a model-not-found is never retried, an HTTP/2 block is never
// retried as HTTP/2), keep checkpoint/exec accounting across a stream's
// exits, and drain async handlers on BOTH exits before anything is finalized.
import { GatewayError } from "../../../protocol/gateway-error";

/** One decoded frame's shape — no text, tokens, ids, or arguments. */
export interface CursorFrameShape {
  readonly at: number;
  readonly kind: string;
  readonly fields: readonly number[];
  readonly size: number;
}

/** The last checkpoint a Run reported, and the calls it owns. */
export interface CursorCheckpointState {
  /** Checkpoint number in this Run. */
  index: number;
  /** Checkpoint number within its step. */
  step: number;
  /** Consecutive checkpoints with no semantic frame between them. */
  streak: number;
  /** Shapes of the frames preceding the last checkpoint. */
  kinds: readonly string[];
  /** Opaque bytes to resume from, when the Run must be rebuilt. */
  bytes: Uint8Array | undefined;
  /** Calls the server requested but this client has not answered. */
  pendingCallIds: Set<string>;
  /** Calls the server already counted: never re-submit these. */
  completedCallIds: Set<string>;
  /** Calls Cursor served itself, already in its own tool count. */
  serverOwnedCount: number;
  /** `tool_requests_listed.call_count`, when the edge declared it. */
  expectedCallCount: number | undefined;
  /** Calls this client dispatched to its executor. */
  dispatchedCount: number;
}

export function createCheckpointState(): CursorCheckpointState {
  return {
    index: 0,
    step: 0,
    streak: 0,
    kinds: [],
    bytes: undefined,
    pendingCallIds: new Set<string>(),
    completedCallIds: new Set<string>(),
    serverOwnedCount: 0,
    expectedCallCount: undefined,
    dispatchedCount: 0,
  };
}

/** The first meaningful key of a decoded AgentServerMessage, for traces. */
export function frameKindOf(message: Record<string, unknown>): string {
  const keys = Object.keys(message).filter((key) => message[key] !== undefined && key !== "__bytes");
  return keys[0] ?? "unknown";
}

/** Shape-only trace entry: sizes and timings, never payload text or ids. */
export function frameShapeOf(message: Record<string, unknown>, at = Date.now()): CursorFrameShape {
  const bytes = message["__bytes"] instanceof Uint8Array ? (message["__bytes"] as Uint8Array) : undefined;
  return {
    at,
    kind: frameKindOf(message),
    fields: bytes === undefined ? [] : topLevelFieldNumbers(bytes),
    size: bytes?.byteLength ?? 0,
  };
}

/** Top-level protobuf field numbers of one decoded frame's raw bytes. */
export function topLevelFieldNumbers(bytes: Uint8Array): number[] {
  const numbers: number[] = [];
  let at = 0;
  while (at < bytes.byteLength && numbers.length < 64) {
    let tag = 0;
    let shift = 0;
    for (;;) {
      if (at >= bytes.byteLength) return numbers;
      const byte = bytes[at] ?? 0;
      at += 1;
      tag |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) break;
      shift += 7;
      if (shift > 35) return numbers;
    }
    const field = tag >>> 3;
    if (field > 0) numbers.push(field);
    const wire = tag & 7;
    if (wire === 0) {
      while (at < bytes.byteLength && ((bytes[at] ?? 0) & 0x80) !== 0) at += 1;
      at += 1;
    } else if (wire === 1) at += 8;
    else if (wire === 2) {
      let length = 0;
      shift = 0;
      for (;;) {
        if (at >= bytes.byteLength) return numbers;
        const byte = bytes[at] ?? 0;
        at += 1;
        length |= (byte & 0x7f) << shift;
        if ((byte & 0x80) === 0) break;
        shift += 7;
        if (shift > 35) return numbers;
      }
      at += length;
    } else if (wire === 5) at += 4;
    else return numbers;
  }
  return numbers;
}

/** Max in-memory shape-only trace entries before a failed Run is flushed. */
export const CURSOR_WIRE_TRACE_MAX = 256;
/** Opt-in: `CARTETHYIA_CURSOR_WIRE_TRACE=1`. Shape only; never payload text. */
export function wireTraceEnabled(): boolean {
  return process.env.CARTETHYIA_CURSOR_WIRE_TRACE === "1";
}

/** The "went quiet" error, naming the last checkpoint (donor 0.2.34). */
export function cursorQuietError(checkpoint: CursorCheckpointState | undefined): GatewayError {
  if (checkpoint === undefined || checkpoint.index === 0) {
    return new GatewayError(
      "platform_unavailable",
      502,
      "Cursor Run went quiet before any checkpoint (request {requestId}). The upstream came back empty-handed — retry 🌙",
      { providerId: "cursor", kind: "quiet" },
      "upstream",
    );
  }
  return new GatewayError(
    "platform_unavailable",
    502,
    `Cursor Run went quiet at checkpoint ${checkpoint.index} (step checkpoint #${checkpoint.step}, ` +
      `${checkpoint.streak} in a row; preceded by ${checkpoint.kinds.join(", ") || "no frames"}) (request {requestId}). ` +
      "The upstream came back empty-handed — retry 🌙",
    { providerId: "cursor", kind: "quiet", checkpointIndex: checkpoint.index },
    "upstream",
  );
}

/** Structured failure kinds, mapped once from an upstream error. */
export type CursorFailureKind =
  | "model_not_found"
  | "conversation_rejected"
  | "resource_exhausted"
  | "not_implemented"
  | "h2_blocked"
  | "quiet"
  | "transport"
  | "authentication"
  | "fatal";

export interface CursorFailureClassification {
  readonly kind: CursorFailureKind;
  readonly retryable: boolean;
  readonly fallbackH1: boolean;
  readonly rotateConversation: boolean;
}

/** Donor patterns (cursor.ts L381-L405). */
const MODEL_NOT_FOUND = /^(?:Connect error not_found:|gRPC error 5:)|AI Model Not Found/i;
const RESOURCE_EXHAUSTED = /resource.?exhausted/i;
const CONVERSATION_REJECTED = /conversation.*(rejected|conflict|stale|not found)|store conflict/i;
const NOT_IMPLEMENTED = /not implemented by this client$/i;

export function classifyCursorFailure(error: unknown, transport: "http2" | "http1"): CursorFailureClassification {
  if (error instanceof GatewayError) {
    if (error.code === "authentication_failed") {
      return { kind: "authentication", retryable: false, fallbackH1: false, rotateConversation: false };
    }
    if (error.code === "quota_exceeded" || RESOURCE_EXHAUSTED.test(error.message)) {
      return { kind: "resource_exhausted", retryable: false, fallbackH1: false, rotateConversation: false };
    }
    if (MODEL_NOT_FOUND.test(error.message)) {
      return { kind: "model_not_found", retryable: false, fallbackH1: false, rotateConversation: false };
    }
    if (error.code === "invalid_request") {
      return { kind: "fatal", retryable: false, fallbackH1: false, rotateConversation: false };
    }
    if (error.details["kind"] === "quiet") {
      return { kind: "quiet", retryable: true, fallbackH1: false, rotateConversation: false };
    }
  }
  const message = error instanceof Error ? error.message : String(error);
  if (MODEL_NOT_FOUND.test(message)) {
    return { kind: "model_not_found", retryable: false, fallbackH1: false, rotateConversation: false };
  }
  if (CONVERSATION_REJECTED.test(message)) {
    return { kind: "conversation_rejected", retryable: true, fallbackH1: false, rotateConversation: true };
  }
  if (RESOURCE_EXHAUSTED.test(message)) {
    return { kind: "resource_exhausted", retryable: false, fallbackH1: false, rotateConversation: false };
  }
  if (NOT_IMPLEMENTED.test(message)) {
    return { kind: "not_implemented", retryable: false, fallbackH1: false, rotateConversation: false };
  }
  if (/http\/?2|nghttp2|alpn|rst_stream|goaway|protocol error/i.test(message) && transport === "http2") {
    return { kind: "h2_blocked", retryable: true, fallbackH1: true, rotateConversation: false };
  }
  if (/quiet|no server message|heartbeat/i.test(message)) {
    return { kind: "quiet", retryable: true, fallbackH1: false, rotateConversation: false };
  }
  return { kind: "transport", retryable: true, fallbackH1: false, rotateConversation: false };
}

/**
 * One settlement for a Run's transport: `end` / `error` / `timeout`,
 * whichever arrives first. Late events are no-ops (donor settleH2).
 */
export function createRunCompletion() {
  let settle!: (reason: "end" | "error" | "timeout") => void;
  const promise = new Promise<"end" | "error" | "timeout">((resolve) => {
    settle = resolve;
  });
  let settled = false;
  return {
    promise,
    settle(reason: "end" | "error" | "timeout"): boolean {
      if (settled) return false;
      settled = true;
      settle(reason);
      return true;
    },
    get settled(): boolean {
      return settled;
    },
  };
}

/**
 * Drains dispatched exec handlers on BOTH exits (donor L1198-L1233).
 *
 * A dispatch can spawn another, so the set is re-checked rather than awaited
 * as one snapshot. The wait is bounded by the abort signal: an exec handler
 * has no cancellation contract, and a hung tool must not hold the terminal
 * event hostage after the caller gave up.
 */
export async function drainInFlightDispatches(
  dispatches: Set<Promise<void>>,
  signal?: AbortSignal,
): Promise<void> {
  if (dispatches.size === 0 || signal?.aborted === true) return;
  if (signal === undefined) {
    while (dispatches.size > 0) await Promise.all(dispatches);
    return;
  }
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<void>((resolve) => {
    onAbort = resolve;
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    while (dispatches.size > 0 && !signal.aborted) {
      await Promise.race([Promise.all(dispatches), aborted]);
    }
  } finally {
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
  }
}

/**
 * A step ends when the server's own tool count covers the calls this client
 * dispatched (donor/magpie 0.2.35): waiting out the heartbeats after that is
 * what made a finished tool round look hung. Server-owned calls are already
 * in the count and are never re-sent.
 */
export function reconcileToolCount(
  checkpoint: CursorCheckpointState,
  serverToolCount: number,
): { endStep: boolean; resend: string[] } {
  const resend = [...checkpoint.pendingCallIds].filter((id) => !checkpoint.completedCallIds.has(id));
  const expected = checkpoint.expectedCallCount ?? serverToolCount;
  const counted = serverToolCount + checkpoint.serverOwnedCount;
  return { endStep: counted >= Math.max(checkpoint.dispatchedCount, expected), resend };
}
