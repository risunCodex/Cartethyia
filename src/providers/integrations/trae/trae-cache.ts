// Trae session-cache estimation.
//
// Trae's agent surface does not report prompt-cache hits: the upstream metadata
// carries `prompt_cache_pool_record: null` and every cache counter
// (`cache_read_input_tokens`, `cached_tokens`) stays 0 even for byte-identical
// prefixes. The underlying models do cache those prefixes, so for the same
// conversation we ESTIMATE the hit locally. This only fills the gap when
// upstream reports nothing (0 or unavailable); a genuine upstream report (>0)
// is trusted and left untouched.
//
// The state lives in a factory-created instance, so Trae's sessions are fully
// isolated from Kiro's (and any other consumer of the shared factory).

import type { CanonicalMessage, UsageRecord } from "../../../protocol/canonical-model";
import { createSessionCache, estimateSessionCache, resetSessionCacheForTesting } from "../shared/session-cache";

const cache = createSessionCache();

export function estimateTraeSessionCache(
  record: UsageRecord,
  sessionId: string | undefined,
  messages: readonly CanonicalMessage[] | undefined,
): UsageRecord {
  return estimateSessionCache(cache, record, sessionId, messages);
}

/** Drops all tracked sessions. Test-only. */
export function resetTraeSessionCacheForTesting(): void {
  resetSessionCacheForTesting(cache);
}
