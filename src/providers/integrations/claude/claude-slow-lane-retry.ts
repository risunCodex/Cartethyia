/**
 * Slow-lane capacity-wait retry (design doc §5).
 *
 * When a request was sent with the slow usage limit and the upstream answers
 * "no spare capacity right now", the donor retries the SAME account after the
 * server-stated interval rather than failing over. That is not a failure: the
 * account is still in the lane, and failing over would abandon capacity that is
 * merely busy.
 *
 * Donor contract (the reference client, `packages/ai/src/providers/anthropic.ts`):
 * - Gate `:3726-3731` — the loop runs only when slow mode is active AND no first
 *   token has arrived AND the stream produced no replay-unsafe content AND the
 *   abort was not the caller's. Once tokens have flowed, a retry would duplicate
 *   output the caller may already have acted on.
 * - Capacity wait `:3739` — `overloaded: httpStatus === 529 || failureText.includes("overloaded_error")`.
 * - Statuses `:1028` `slot_busy` waits; `weekly_limit` / `budget_exhausted` /
 *   `off` / `ineligible` end the lane with no retry.
 * - Bounded by the server's max-wait (`:3737` passes `waitedMs` and `attempts`).
 */
import { GatewayError } from "../../../protocol/gateway-error";
import {
  classifyClaudeSlowStatus,
  type ClaudeSlowLanes,
  type ClaudeSlowSignal,
} from "./claude-slow-lane";

export interface SlowLaneFailureObservation {
  readonly httpStatus?: number;
  readonly message?: string;
  readonly headers?: ClaudeSlowSignal;
  /** True when this request was sent with `anthropic-usage-limit: slow`. */
  readonly sentSlow: boolean;
  /** Milliseconds already spent waiting on this request. */
  readonly waitedMs: number;
  readonly attempts: number;
}

export interface SlowLaneRetryDecision {
  /** True when this is a capacity wait: retry the same account. */
  readonly capacityWait: boolean;
  readonly delayMs: number;
}

/** A 529 or an `overloaded_error` body is the upstream asking us to wait. */
export function isOverloadedFailure(observation: SlowLaneFailureObservation): boolean {
  if (observation.httpStatus === 529) return true;
  const message = observation.message ?? "";
  return message.includes("overloaded_error");
}

/**
 * Decides whether a failed slow-lane request should wait and resend on the same
 * account. Returns `null` when it should not — the caller then treats the
 * failure normally (fail over, or surface it).
 */
export function planSlowLaneRetry(
  observation: SlowLaneFailureObservation,
  lanes: ClaudeSlowLanes,
  accountId: string,
  nowMs = Date.now(),
): SlowLaneRetryDecision | null {
  // Never a slow-lane wait unless we actually sent the slow header: without it
  // the account is not in the lane, so a wait is just latency with no capacity
  // behind it.
  if (!observation.sentSlow) return null;
  if (!lanes.isActive(accountId, nowMs)) return null;

  const status = observation.headers?.status;
  // A terminal lane status ends the lane: staying would spin against a limit
  // that will not lift inside this request.
  if (status !== undefined && classifyClaudeSlowStatus(status) === "terminal") return null;

  const overloaded = isOverloadedFailure(observation);
  const slotBusy = status === "slot_busy";
  if (!overloaded && !slotBusy) return null;

  const maxWaitMs = observation.headers?.maxWaitMs ?? 20 * 60 * 1000;
  if (observation.waitedMs >= maxWaitMs) return null;

  // The server's stated interval when we have one, else a conservative default.
  //
  // The donor's own default here is 20s, sized for an interactive CLI session
  // that can afford to wait. A gateway sits inside a request deadline and
  // typically cannot, so the fallback is much shorter: a long unconditional
  // wait would turn every unlabelled capacity signal into seconds of latency
  // for a caller that has already given up. Raise it only alongside real
  // deadline measurements.
  const DEFAULT_WAIT_MS = 2_000;
  const stated = observation.headers?.retryAfterMs ?? DEFAULT_WAIT_MS;
  const remaining = maxWaitMs - observation.waitedMs;
  const delayMs = Math.max(0, Math.min(stated, remaining));
  if (delayMs <= 0) return null;

  return { capacityWait: true, delayMs };
}

/** Typed error for a caller-aborted wait, so it is never read as a failure. */
export function slowLaneAborted(): GatewayError {
  return new GatewayError("transport_closed", 499, "The request was cancelled during the slow-lane capacity wait (request {requestId}). Send it again whenever ready 🙃");
}
