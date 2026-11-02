// Where a Grok rate-limit reading lives between dispatch and display.
//
// The bucket headers come back on **every** upstream response, so the cheap
// place to learn them is the traffic the gateway is already sending — not a
// probe of its own. A dispatch that reads and stores them costs nothing extra;
// a probe costs a request every time quota is shown.
//
// So this store is fed by dispatch (manual test or automatic routing alike) and
// read by the quota collector. The collector only probes when there is nothing
// stored, which is the first read after a start and never after that.
//
// Keyed by account id: two Grok accounts carry different buckets, and a reading
// filed against the wrong one is worse than no reading at all.

import type { ProviderQuotaWindow } from "../../quota/quota-contracts";
import { grokHeaderRequestsWindow, grokHeaderWindow, type GrokRateLimitReading } from "./grok-ratelimit";

/**
 * How long a stored reading stays useful.
 *
 * The header is eventually consistent, so a fresh value is not meaningfully
 * better than one from a few minutes ago — but a value from last week says
 * nothing about now. Five minutes is short enough to follow real traffic and
 * long enough that a burst of console refreshes costs no requests.
 */
const SNAPSHOT_TTL_MS = 5 * 60 * 1000;

interface Snapshot {
  readonly windows: readonly ProviderQuotaWindow[];
  readonly capturedAt: number;
}

const snapshots = new Map<string, Snapshot>();

/** Files a reading captured from a real dispatch against one account. */
export function rememberGrokRateLimit(
  accountId: string,
  reading: GrokRateLimitReading,
  now = Date.now(),
): void {
  const windows = [grokHeaderWindow(reading), grokHeaderRequestsWindow(reading)].filter(
    (value): value is ProviderQuotaWindow => value !== null,
  );
  if (windows.length === 0) return;
  snapshots.set(accountId, { windows, capturedAt: now });
  if (snapshots.size > 4096) {
    // Bounded: an unbounded map keyed by account is a leak dressed as a cache.
    for (const [key, value] of snapshots) {
      if (now - value.capturedAt > SNAPSHOT_TTL_MS) snapshots.delete(key);
    }
  }
}

/** The stored window for one account, or `null` when none is fresh enough. */
export function storedGrokRateLimit(accountId: string, now = Date.now()): readonly ProviderQuotaWindow[] | null {
  const snapshot = snapshots.get(accountId);
  if (!snapshot) return null;
  if (now - snapshot.capturedAt > SNAPSHOT_TTL_MS) {
    snapshots.delete(accountId);
    return null;
  }
  return snapshot.windows;
}

/** Test seam. */
export function clearGrokRateLimitSnapshots(): void {
  snapshots.clear();
}
