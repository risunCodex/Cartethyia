// Qoder session-cache estimation.
//
// The Qoder upstream never reports prompt-cache hits: neither the gRPC surface
// (used `prompt_tokens_details` absent on every chunk — verified live
// 2026-11-05, `scripts/provider-probing/qoder/direct/direct-cache-hit.ts`) nor
// the IDE HTTP surface (`usage: null` / `raw_usage` absent — `direct-cache-hit-ide.ts`)
// carries a cached-token counter. The underlying models do cache byte-identical
// prefixes, so for the same conversation we ESTIMATE the hit locally from the
// request history — exactly how the Trae and Kiro adapters bridge the same gap.
// This only fills the gap when upstream reports nothing (0 or unavailable); a
// genuine upstream report (>0) is trusted and left untouched.
//
// The state lives in a factory-created instance, so Qoder's sessions are fully
// isolated from Trae's/Kiro's (and any other consumer of the shared factory).

import type { CanonicalMessage, UsageRecord } from "../../../protocol/canonical-model";
import { createSessionCache, estimateSessionCache, resetSessionCacheForTesting } from "../shared/session-cache";

const cache = createSessionCache();

export function estimateQoderSessionCache(
  record: UsageRecord,
  sessionId: string | undefined,
  messages: readonly CanonicalMessage[] | undefined,
): UsageRecord {
  return estimateSessionCache(cache, record, sessionId, messages);
}

/** Drops all tracked sessions. Test-only. */
export function resetQoderSessionCacheForTesting(): void {
  resetSessionCacheForTesting(cache);
}
