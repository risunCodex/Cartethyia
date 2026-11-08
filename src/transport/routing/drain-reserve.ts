// Drain urgency and reserve scoring for candidate ordering.
//
// Ported from oh-my-pi's `windowRequiredDrain` and reserve semantics
// (`packages/ai/src/auth/usage-report.ts`, `policy.ts`): within the same rank
// group, an account whose remaining quota is about to expire unused should be
// burned first ("use it or lose it"), and an account parked in reserve (at or
// below the reserve percent) should yield to non-reserve siblings.
import {
  totalRemainingPercent,
  type ProviderQuotaWindow,
} from "../../providers/quota/quota-contracts";

/** Minimum time before reset that still counts as "some headroom" (1 minute). */
const MIN_REMAINING_MS = 60_000;

/** Usable fraction of a window: 0..1, with 0.5 neutral when unmeasured. */
function usedFraction(window: ProviderQuotaWindow): number {
  const used = window.usedPercent;
  if (typeof used === "number" && Number.isFinite(used)) {
    return Math.min(1, Math.max(0, used / 100));
  }
  const remaining = window.remainingPercent;
  if (typeof remaining === "number" && Number.isFinite(remaining)) {
    return Math.min(1, Math.max(0, 1 - remaining / 100));
  }
  if (typeof window.used === "number" && Number.isFinite(window.used)) {
    if (typeof window.limit === "number" && Number.isFinite(window.limit) && window.limit > 0) {
      return Math.min(1, Math.max(0, window.used / window.limit));
    }
  }
  if (typeof window.remaining === "number" && Number.isFinite(window.remaining)) {
    if (typeof window.limit === "number" && Number.isFinite(window.limit) && window.limit > 0) {
      return Math.min(1, Math.max(0, 1 - window.remaining / window.limit));
    }
  }
  return 0.5;
}

/** Reset instant (epoch ms) for a window, or undefined when it has no clock. */
function resetAtMs(window: ProviderQuotaWindow): number | undefined {
  if (window.resetsAt === null || window.resetsAt === undefined) return undefined;
  const at = Date.parse(window.resetsAt);
  return Number.isFinite(at) ? at : undefined;
}

/**
 * Drain score for the most-urgent relevant window: headroom fraction divided by
 * remaining hours until reset. Higher means quota that is about to expire
 * unused and should be burned first. Returns 0 when no window carries usable
 * evidence (the candidate is neutral, never penalized).
 */
export function drainScore(
  windows: readonly ProviderQuotaWindow[] | undefined,
  nowMs = Date.now(),
): number {
  if (windows === undefined || windows.length === 0) return 0;
  let best = 0;
  for (const window of windows) {
    const headroom = 1 - usedFraction(window);
    if (headroom <= 0) continue;
    const resetAt = resetAtMs(window);
    const durationMs = windowAccountingDurationMs(window);
    let remainingMs = resetAt === undefined ? (durationMs ?? MIN_REMAINING_MS) : resetAt - nowMs;
    if (durationMs !== undefined && durationMs > 0) {
      remainingMs = Math.min(remainingMs, durationMs);
    }
    const remainingHours = Math.max(remainingMs, MIN_REMAINING_MS) / (60 * 60 * 1000);
    best = Math.max(best, headroom / remainingHours);
  }
  return best;
}

function windowAccountingDurationMs(window: ProviderQuotaWindow): number | undefined {
  // Providers state window durations in the kind label (e.g. "5h", "7d") when
  // they do not carry an explicit duration field. Parse the common spellings;
  // an unparseable label contributes no clock.
  const text = `${window.kind} ${window.label}`.toLowerCase();
  const m = /(\d+(?:\.\d+)?)\s*(h|hour|hr|d|day|m|min|minute|s|sec|second)\b/.exec(text);
  if (!m) return undefined;
  const value = Number(m[1]);
  if (!Number.isFinite(value)) return undefined;
  const unit = m[2];
  if (unit === "h" || unit === "hour" || unit === "hr") return value * 60 * 60 * 1000;
  if (unit === "d" || unit === "day") return value * 24 * 60 * 60 * 1000;
  if (unit === "m" || unit === "min" || unit === "minute") return value * 60 * 1000;
  if (unit === "s" || unit === "sec" || unit === "second") return value * 1000;
  return undefined;
}

/**
 * The account's remaining fraction (0..1) across its pooled credit and
 * independent windows, or undefined when nothing is measured. Mirrors
 * `totalRemainingPercent` (the router's existing aggregate) but normalized to a
 * 0..1 fraction.
 */
export function remainingFraction(
  windows: readonly ProviderQuotaWindow[] | undefined,
): number | undefined {
  if (windows === undefined || windows.length === 0) return undefined;
  const percent = totalRemainingPercent(windows);
  if (percent === null) return undefined;
  return Math.min(1, Math.max(0, percent / 100));
}

/** True when the account's remaining fraction is at or below the reserve percent. */
export function isInReserve(
  windows: readonly ProviderQuotaWindow[] | undefined,
  reservePct: number,
): boolean {
  if (reservePct <= 0) return false;
  const fraction = remainingFraction(windows);
  if (fraction === undefined) return false;
  return fraction * 100 <= reservePct;
}

/**
 * True when a reserved account has healed above the reclaim threshold and may be
 * reclaimed to full priority.
 */
export function isReclaimReady(
  windows: readonly ProviderQuotaWindow[] | undefined,
  reservePct: number,
  reclaimAbovePct: number,
): boolean {
  if (reservePct <= 0 || reclaimAbovePct <= reservePct) return false;
  const fraction = remainingFraction(windows);
  if (fraction === undefined) return false;
  return fraction * 100 >= reclaimAbovePct;
}
