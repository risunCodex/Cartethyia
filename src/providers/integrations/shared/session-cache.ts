// Shared session-cache estimation factory.
//
// The Kiro and Trae adapters both need to ESTIMATE prompt-cache hits locally
// because their upstream surfaces never report them. Their logic is
// byte-identical modulo the provider header comment, so it lives here once —
// but the state must stay per-provider: a factory call creates a private Map
// per integration, so cross-provider session-id collisions can never
// contaminate each other's estimates. Call each provider's wrapper
// (kiro-cache.ts / trae-cache.ts); do not import this module directly.

import { createHash } from "node:crypto";
import type { CanonicalMessage, UsageRecord } from "../../../protocol/canonical-model";

/** Bounded in-memory tracker: one entry per session, oldest evicted first. */
export const SESSION_CACHE_MAX_SESSIONS = 512;

interface SessionCacheEntry {
  /** hash(full messages) -> reported input tokens for that exact list. */
  readonly seen: Map<string, number>;
  /** Insertion order for bounded eviction. */
  readonly order: string[];
}

export interface SessionCache {
  estimate(
    record: UsageRecord,
    sessionId: string | undefined,
    messages: readonly CanonicalMessage[] | undefined,
  ): UsageRecord;
  resetForTesting(): void;
}

function hashOf(messages: readonly CanonicalMessage[]): string {
  return createHash("sha256").update(JSON.stringify(messages)).digest("hex");
}

/**
 * Creates an isolated session-cache estimator: its own private session Map,
 * bounded at SESSION_CACHE_MAX_SESSIONS with per-entry oldest-first eviction.
 */
export function createSessionCache(): SessionCache {
  const sessions = new Map<string, SessionCacheEntry>();

  function sessionFor(sessionId: string): SessionCacheEntry {
    let entry = sessions.get(sessionId);
    if (!entry) {
      entry = { seen: new Map(), order: [] };
      sessions.set(sessionId, entry);
    }
    return entry;
  }

  function remember(sessionId: string, fullHash: string, inputTokens: number): void {
    const entry = sessionFor(sessionId);
    if (!entry.seen.has(fullHash)) {
      entry.order.push(fullHash);
      if (entry.order.length > SESSION_CACHE_MAX_SESSIONS) {
        const oldest = entry.order.shift();
        if (oldest !== undefined) entry.seen.delete(oldest);
      }
    }
    entry.seen.set(fullHash, inputTokens);
    if (sessions.size > SESSION_CACHE_MAX_SESSIONS) {
      const oldestSession = sessions.keys().next().value;
      if (oldestSession !== undefined) sessions.delete(oldestSession);
    }
  }

  return {
    estimate(record, sessionId, messages) {
      if (!sessionId || !messages || messages.length === 0) return record;
      const upstreamReported =
        typeof record.cached_input_tokens === "number" && record.cached_input_tokens > 0;
      if (upstreamReported) return record;

      const fullHash = hashOf(messages);
      const entry = sessions.get(sessionId);

      if (entry) {
        // Longest prefix that matches a previously sent complete request.
        for (let len = messages.length; len >= 1; len -= 1) {
          const prefix = messages.slice(0, len);
          const tokens = entry.seen.get(hashOf(prefix));
          if (tokens === undefined) continue;
          if (len === messages.length) {
            // Byte-identical request: the whole input came from cache.
            return {
              ...record,
              cached_input_tokens: record.input_tokens,
              uncached_input_tokens: 0,
            };
          }
          const cached = Math.min(tokens, record.input_tokens);
          return {
            ...record,
            cached_input_tokens: cached,
            uncached_input_tokens: Math.max(0, record.input_tokens - cached),
          };
        }
      }

      remember(sessionId, fullHash, record.input_tokens);
      return record;
    },

    resetForTesting() {
      sessions.clear();
    },
  };
}

/**
 * Estimates how much of this request's input was served from cache.
 *
 * The longest prefix of `messages` that was ever sent as a complete request in
 * this session is considered cached, and its recorded token count is the
 * cached portion — if that prefix is the whole request, everything was cached.
 * This models how upstream prompt caching actually behaves (byte-identical
 * prefix reuse) without trusting a counter the upstream never reports.
 *
 * Returns the record unchanged when there is nothing to estimate (no session,
 * no history, or upstream already reported a real hit).
 */
export function estimateSessionCache(
  cache: SessionCache,
  record: UsageRecord,
  sessionId: string | undefined,
  messages: readonly CanonicalMessage[] | undefined,
): UsageRecord {
  return cache.estimate(record, sessionId, messages);
}

/** Drops all tracked sessions in this cache. Test-only. */
export function resetSessionCacheForTesting(cache: SessionCache): void {
  cache.resetForTesting();
}
