/**
 * Monotonic per-session turn index for the `x-grok-turn-idx` header.
 *
 * The official `grok` CLI stamps this header with the conversation's prompt
 * index: incremented once per user prompt and re-sent unchanged for every
 * tool-loop iteration of the same prompt. A client that sends only the newest
 * message (delta-style) would otherwise pin the count at `1` forever, which
 * makes the backend treat successive requests as the same turn.
 *
 * `resolveInboundSessionId` already resolves *which* conversation a request
 * belongs to; this module is the only place that remembers *how far* that
 * conversation has advanced, so the count never regresses for one session.
 */

import type { CanonicalRequest } from "../../../protocol/canonical-model";
import { TtlCache } from "../../../persistence/ttl-cache";

/** Idle window after which a session's remembered index is discarded. */
const SESSION_TTL_MS = 30 * 60_000;

/** Bound on remembered sessions; least-recently-used is evicted past this. */
const MAX_SESSIONS = 5_000;

interface TurnEntry {
  readonly turn: number;
}

// Bounded, LRU-ordered: a session re-inserts on every use so the newest
// session is the last evicted, exactly as the previous delete-then-set Map.
const turns = new TtlCache<TurnEntry>({
  ttlMs: SESSION_TTL_MS,
  maxEntries: MAX_SESSIONS,
  lru: true,
});
const requestTurns = new WeakMap<object, number>();

/** User turns in the request, floored at 1 (a turn is never index 0). */
function userTurnCount(request: CanonicalRequest | undefined): number {
  const messages = request?.messages;
  if (!Array.isArray(messages)) return 1;
  let count = 0;
  for (const message of messages) {
    if (message?.role === "user") count += 1;
  }
  return Math.max(1, count);
}

/**
 * Turn index for one dispatch: the payload's own user-turn count, advanced past
 * the last index seen for the same session so it never goes backwards.
 *
 * Without a session id there is nothing to remember, so the payload count is
 * returned as-is.
 */
export function resolveGrokTurnIndex(
  sessionId: string | undefined,
  request: CanonicalRequest | undefined,
  requestKey?: object,
): number {
  const fromInput = userTurnCount(request);
  if (requestKey !== undefined) {
    const previousRequestTurn = requestTurns.get(requestKey);
    if (previousRequestTurn !== undefined) return previousRequestTurn;
  }
  if (sessionId === undefined || sessionId.length === 0) return fromInput;

  const remembered = turns.get(sessionId)?.turn;

  // A full-history client already reports the true index; a delta-style client
  // reports 1 every time, so the stored index is advanced by one for it.
  const turn = remembered === undefined ? fromInput : Math.max(fromInput, remembered + 1);

  // Re-insert so the entry is newest for eviction order.
  turns.set(sessionId, { turn });
  if (requestKey !== undefined) requestTurns.set(requestKey, turn);
  return turn;
}
