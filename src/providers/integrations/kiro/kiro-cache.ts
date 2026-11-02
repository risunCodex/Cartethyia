// Kiro session-cache estimation.
//
// The Kiro runtime surface never reports prompt-cache hits: the EventStream
// carries only `contextUsageEvent` (window percentage) and `meteringEvent`
// (billed credits), with no metrics event and no cache token counters. The
// underlying models do cache byte-identical prefixes, so for the same
// conversation we ESTIMATE the hit locally from the request history — exactly
// how the Trae adapter bridges the same gap. This only fills the gap when
// upstream reports nothing (0 or unavailable); a genuine upstream report (>0)
// is trusted and left untouched.
//
// The state lives in a factory-created instance, so Kiro's sessions are fully
// isolated from Trae's (and any other consumer of the shared factory).

import type { CanonicalMessage, UsageRecord } from "../../../protocol/canonical-model";
import { createSessionCache, estimateSessionCache, resetSessionCacheForTesting } from "../shared/session-cache";

const cache = createSessionCache();

export function estimateKiroSessionCache(
  record: UsageRecord,
  sessionId: string | undefined,
  messages: readonly CanonicalMessage[] | undefined,
): UsageRecord {
  return estimateSessionCache(cache, record, sessionId, messages);
}

/** Drops all tracked sessions. Test-only. */
export function resetKiroSessionCacheForTesting(): void {
  resetSessionCacheForTesting(cache);
}
