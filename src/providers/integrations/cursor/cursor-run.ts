/**
 * Cursor Run turn orchestration: heartbeats, retry policy, and the two
 * fallbacks that keep a turn alive when the wire misbehaves.
 *
 * One turn = one attempt loop around a fresh Run:
 *
 * - **Heartbeat** — `client_heartbeat` every 5s keeps a counted tool batch
 *   open; it is *not* semantic progress (it never masks a stalled stream).
 * - **Replay-safe retry** — max 5 attempts, 500ms base exponential. A retry is
 *   only safe when the attempt produced no output the caller has seen; the
 *   caller (`onMessage`) reports progress and the loop refuses to replay a
 *   partial answer. `incomplete-stream` (stream ended before `turn_ended`)
 *   counts as retryable.
 * - **Model fallback** — `model_not_found`/`BAD_MODEL_NAME` before any output
 *   re-runs once on the discovered wire id (the exact id the account's roster
 *   listed), never on a folded alias.
 * - **Conversation rotation** — a poisoned conversation id (`resource_exhausted`
 *   in prose, or `PROVIDER_ERROR` after a zero-token cut) rotates to a fresh
 *   UUID and rebuilds from the supplied history; one rotation per turn so a
 *   truly broken account cannot spin.
 * - **h2→h1** — an ALPN/blocked-h2 open failure before any progress re-runs
 *   the whole attempt on the RunSSE + BidiAppend transport.
 */
import { randomUUID } from "node:crypto";
import type { ValidatedOutboundHttp2Bidi } from "../../../network/bidi";
import {
  classifyCursorThrown,
  type CursorFailure,
} from "./cursor-errors";
import {
  openHttp1RunTransport,
  openHttp2RunTransport,
  runHeaders,
  type CursorFetch,
  type CursorRunTransport,
  type CursorTransportEvent,
} from "./cursor-run-transport";
import { CURSOR_CLIENT_VERSION, CURSOR_RUN_PATH, CURSOR_API_BASE_URL } from "./cursor-wire";
import type { AgentServerMessage } from "./cursor-protocol/generated";

/** Client heartbeat cadence: keeps a counted tool batch open, marks no progress. */
export const CURSOR_HEARTBEAT_MS = 5_000;
/** Retry budget for one turn. */
export const CURSOR_MAX_TURN_RETRIES = 5;
/** Base delay for the exponential retry backoff. */
export const CURSOR_RETRY_BASE_MS = 500;
/** Ceiling on the exponential retry backoff. */
export const CURSOR_RETRY_MAX_MS = 30_000;

/** How the caller consumes the stream; `progress: true` forbids replay. */
export interface CursorTurnSink {
  /**
   * Receives one decoded server frame — including `turn_ended`, which carries
   * the turn's token usage and must reach the caller's accounting. Return
   * `progress: true` once the frame has been surfaced to the caller in any
   * form — after that the attempt is no longer replay-safe and a failure is
   * final for the turn.
   *
   * `transport` is the live Run pipe: the sink writes answer frames (exec
   * results, KV replies) into it while the turn runs. The transport belongs to
   * the attempt; a sink that outlives the turn (a parked Run) may keep writing
   * until the stream closes.
   */
  onMessage(
    message: AgentServerMessage,
    transport: CursorRunTransport,
  ): Promise<{ progress: boolean } | void> | { progress: boolean } | void;
  /** Receives each classified failure in order, for logging/telemetry. */
  onFailure?(failure: CursorFailure, attempt: number): void;
}

export interface CursorTurnOptions {
  readonly accessToken: string;
  readonly clientVersion?: string | undefined;
  /** Builds the run request body for one attempt (history, model pair, action). */
  readonly buildRequest: (state: CursorTurnState) => Record<string, unknown>;
  readonly sink: CursorTurnSink;
  /** Validated h2 dialer from the dispatch context. */
  readonly http2: ValidatedOutboundHttp2Bidi;
  /** Fetch for the HTTP/1 fallback and its BidiAppend calls. */
  readonly fetch: CursorFetch;
  readonly signal?: AbortSignal | undefined;
  /** The conversation id to run under; a poisoned one is rotated internally. */
  readonly conversationId?: string | undefined;
  /** Host allowlist for the h2 dial (the egress layer enforces it too). */
  readonly allowHostname?: ((hostname: string) => boolean) | undefined;
  /** Retry backoff base; tests shrink it. Defaults to {@link CURSOR_RETRY_BASE_MS}. */
  readonly retryBaseMs?: number | undefined;
  /** Heartbeat cadence override. Defaults to {@link CURSOR_HEARTBEAT_MS}. */
  readonly heartbeatMs?: number | undefined;
}

/** Per-attempt identity handed to `buildRequest`. */
export interface CursorTurnState {
  readonly attempt: number;
  readonly conversationId: string;
  /** The wire id to send: the discovered id after a `model_not_found` retry. */
  readonly wireModelOverride: string | undefined;
  readonly carrier: "http2" | "http1";
}

export type CursorTurnResult =
  | { readonly status: "turn-ended"; readonly attempts: number }
  | { readonly status: "failed"; readonly failure: CursorFailure; readonly attempts: number };

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function backoffMs(attempt: number, baseMs: number): number {
  return Math.min(baseMs * 2 ** (attempt - 1), CURSOR_RETRY_MAX_MS);
}

/**
 * Whether a thrown/failed open is a blocked HTTP/2 path: ALPN negotiation
 * failure or the explicit "h2 is not supported" answer. Everything else is a
 * normal transport failure and retries on the same carrier.
 */
function isH2Blocked(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /alpn|h2 is not supported|http\/2 (?:is )?(?:not )?(?:available|supported)|ERR_HTTP2/i.test(message);
}

interface AttemptOutcome {
  readonly outcome: "turn-ended" | "failed";
  readonly failure?: CursorFailure;
  readonly sawProgress: boolean;
  readonly discoveredWireId: string | undefined;
}

/**
 * Runs one attempt: opens the transport, starts the heartbeat, and streams
 * frames to the sink until the turn ends or the stream fails.
 */
async function runAttempt(
  options: CursorTurnOptions,
  state: CursorTurnState,
  requestId: string,
): Promise<AttemptOutcome> {
  const openOptions = {
    accessToken: options.accessToken,
    clientVersion: options.clientVersion ?? CURSOR_CLIENT_VERSION,
    requestId,
    signal: options.signal,
  };

  let transport: CursorRunTransport;
  try {
    if (state.carrier === "http1") {
      transport = await openHttp1RunTransport(options.fetch, openOptions);
    } else {
      const url = new URL(CURSOR_API_BASE_URL + CURSOR_RUN_PATH);
      const stream = await options.http2(url, runHeaders(openOptions, {}), {
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.allowHostname === undefined ? {} : { allowHostname: options.allowHostname }),
      });
      transport = openHttp2RunTransport(stream);
    }
  } catch (error) {
    // An h2 open that failed because the path is blocked is the caller's cue
    // to fall back to h1 (before any progress, so the replay is safe).
    if (state.carrier === "http2" && isH2Blocked(error)) {
      return {
        outcome: "failed",
        failure: { policy: "fallback_h1", code: undefined, name: undefined, message: String(error), upstreamRetryable: false },
        sawProgress: false,
        discoveredWireId: state.wireModelOverride,
      };
    }
    return {
      outcome: "failed",
      failure: classifyCursorThrown(error),
      sawProgress: false,
      discoveredWireId: state.wireModelOverride,
    };
  }

  // The run request rides as the first client frame on both carriers.
  await transport.write({ runRequest: options.buildRequest(state) });

  let sawProgress = false;
  let sawTurnEnded = false;
  let failure: CursorFailure | undefined;

  const heartbeat = setInterval(() => {
    // A write failure here means the transport is gone; the event loop below
    // surfaces the real terminal cause, so the rejection is swallowed.
    void transport.write({ clientHeartbeat: {} }).catch(() => undefined);
  }, options.heartbeatMs ?? CURSOR_HEARTBEAT_MS);

  try {
    for await (const event of transport.events) {
      const typed = event as CursorTransportEvent;
      if (typed.kind === "message") {
        // Server heartbeats reach the sink (a relay uses them as quiet-timer
        // ticks to hand off a held tool batch) but are never semantic
        // progress and never carry turn_ended.
        const isHeartbeat = typed.message.interactionUpdate?.heartbeat !== undefined;
        // turn_ended reaches the sink first: it carries the turn's usage and
        // the caller's accounting must see it. It is also the last semantic
        // frame — stop reading promptly so a lingering heartbeats tail cannot
        // hold the turn open.
        const result = await options.sink.onMessage(typed.message, transport);
        if (!isHeartbeat && result?.progress === true) sawProgress = true;
        if (!isHeartbeat && typed.message.interactionUpdate?.turnEnded !== undefined) {
          sawTurnEnded = true;
          break;
        }
      } else if (typed.kind === "error") {
        failure = typed.failure;
        break;
      } else {
        break; // clean end without turn_ended: incomplete below
      }
    }
  } finally {
    clearInterval(heartbeat);
    transport.end();
  }

  if (failure === undefined && !sawTurnEnded) {
    // A cut with no output is an incomplete stream — retryable. A cut after
    // output the caller saw is final: replaying would duplicate the answer.
    failure = {
      policy: sawProgress ? "terminal" : "retryable",
      code: undefined,
      name: undefined,
      message: "Cursor stream ended before turnEnded",
      upstreamRetryable: false,
    };
  }

  if (failure === undefined) {
    return { outcome: "turn-ended", sawProgress, discoveredWireId: state.wireModelOverride };
  }

  // Capture the discovered wire id from a model_not_found retry hint when the
  // failure message names the roster id (the transport layer surfaces it as
  // `not_found`); the retry loop passes it through `wireModelOverride`.
  options.sink.onFailure?.(failure, state.attempt);
  return { outcome: "failed", failure, sawProgress, discoveredWireId: state.wireModelOverride };
}

/**
 * Runs one turn to completion, applying the retry/fallback policy.
 *
 * The turn never replays a partially delivered answer: once the sink reports
 * progress, a failure is final. The three escapes — h1 fallback, discovered-id
 * retry, conversation rotation — all fire only before progress or on a clean
 * replay of the same history.
 */
export async function runCursorTurn(options: CursorTurnOptions): Promise<CursorTurnResult> {
  let conversationId = options.conversationId ?? randomUUID();
  let wireModelOverride: string | undefined;
  let carrier: "http2" | "http1" = "http2";
  let rotatedConversation = false;

  for (let attempt = 1; attempt <= CURSOR_MAX_TURN_RETRIES + 1; attempt++) {
    const state: CursorTurnState = {
      attempt,
      conversationId,
      wireModelOverride,
      carrier,
    };
    const requestId = randomUUID();
    const result = await runAttempt(options, state, requestId);

    if (result.outcome === "turn-ended") {
      return { status: "turn-ended", attempts: attempt };
    }

    const failure = result.failure ?? {
      policy: "terminal" as const,
      code: undefined,
      name: undefined,
      message: "unknown failure",
      upstreamRetryable: false,
    };

    // h2 blocked → one whole-attempt retry on h1.
    if (failure.policy === "fallback_h1" && carrier === "http2" && !result.sawProgress) {
      carrier = "http1";
      attempt -= 1; // the fallback does not consume the retry budget
      continue;
    }

    // model_not_found → one retry on the discovered wire id.
    if (failure.policy === "model_not_found" && !result.sawProgress && wireModelOverride === undefined) {
      wireModelOverride = extractDiscoveredId(failure.message) ?? "default";
      attempt -= 1;
      continue;
    }

    // Poisoned conversation → rotate once and rebuild from history.
    if (failure.policy === "conversation_rejected" && !rotatedConversation && !result.sawProgress) {
      conversationId = randomUUID();
      rotatedConversation = true;
      attempt -= 1;
      continue;
    }

    if (failure.policy === "retryable" && !result.sawProgress && attempt <= CURSOR_MAX_TURN_RETRIES) {
      await sleep(backoffMs(attempt, options.retryBaseMs ?? CURSOR_RETRY_BASE_MS), options.signal);
      continue;
    }

    return { status: "failed", failure, attempts: attempt };
  }

  return {
    status: "failed",
    failure: {
      policy: "terminal",
      code: undefined,
      name: undefined,
      message: "Cursor turn exhausted its retry budget",
      upstreamRetryable: false,
    },
    attempts: CURSOR_MAX_TURN_RETRIES + 1,
  };
}

/**
 * Extracts the replacement model id from a `not_found` message when the
 * upstream names it ("AI Model Not Found" carries no id, so the caller's
 * discovered roster id is the fallback and this answers `undefined`).
 */
function extractDiscoveredId(message: string): string | undefined {
  const match = /model\s+["'`]([^"'`]+)["'`]/i.exec(message);
  return match?.[1];
}
