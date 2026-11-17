// Candidate evaluation: quota-fact normalization and health/cooldown
// eligibility for routing candidates. Extracted from router.ts — the plan
// engine consumes these, and so do console diagnostics, manual tests, and
// probes through the router.ts re-exports.
import {
  totalRemainingCredit,
  totalRemainingPercent,
  type ProviderQuotaResult,
  type ProviderQuotaWindow,
} from "../../providers/quota/quota-contracts";
import type { EligibilityDecision, NormalizedQuotaFact, RoutedCandidate } from "./route-model";

/**
 * Filters quota windows to those relevant to the candidate model.
 * Providers like Antigravity report separate quotas for distinct model families
 * (Gemini vs Claude/GPT), Grok reports per-product buckets, and Cursor's two
 * named rails fund disjoint families ("Cursor Models" vs "Other Models").
 * Evaluating a Claude exhaustion against a Gemini request would incorrectly
 * mark the account exhausted for Gemini when Gemini capacity is still available.
 */
export function filterCandidateQuotaWindows(
  windows: readonly ProviderQuotaWindow[],
  candidate: { readonly provider_id?: string; readonly model_id?: string },
): readonly ProviderQuotaWindow[] {
  if (windows.length === 0) return windows;
  const providerId = candidate.provider_id?.toLowerCase() ?? "";
  const modelId = candidate.model_id?.toLowerCase() ?? "";
  windows = windows.filter((window) => window.modelIds === undefined || window.modelIds.includes(modelId));

  if (providerId === "antigravity") {
    const isGemini = /gemini|tab_flash/i.test(modelId);
    const isClaude = /claude|opus|sonnet/i.test(modelId);
    if (isGemini) {
      return windows.filter((w) => {
        const text = `${w.kind} ${w.label}`.toLowerCase();
        if (text.includes("gemini") || text.includes("google")) return true;
        return !text.includes("claude") && !text.includes("gpt");
      });
    }
    if (isClaude) {
      return windows.filter((w) => {
        const text = `${w.kind} ${w.label}`.toLowerCase();
        if (text.includes("claude") || text.includes("gpt")) return true;
        return !text.includes("gemini") && !text.includes("google");
      });
    }
  }

  if (providerId === "grok") {
    return windows.filter((w) => {
      if (w.kind.startsWith("product:")) {
        const product = w.kind.split(":")[1]?.toLowerCase();
        return product ? modelId.includes(product) : true;
      }
      return true;
    });
  }

  if (providerId === "cursor") {
    // `cursor:usd:individual-auto` is the "Cursor Models" rail (the weekly
    // pool on X Subscription, the auto-percent rail on classic plans) and
    // serves the Cursor-owned families (Grok, Composer, Auto). The matching
    // `cursor:usd:individual-api` rail ("Other Models", included-$ or prepaid
    // credit) serves everything else (Claude, GPT, Gemini, …). A spent
    // prepaid balance must not mark a Grok request exhausted, and an empty
    // weekly pool must not refuse a Claude request. The owned families are a
    // closed set, so unknown ids default to the third-party side.
    const isCursorOwned = /\bgrok|\bcomposer|\bauto\b/.test(modelId);
    return windows.filter((w) => {
      if (w.kind === "cursor:usd:individual-auto") return isCursorOwned;
      if (w.kind === "cursor:usd:individual-api") return !isCursorOwned;
      return true;
    });
  }

  return windows;
}

/**
 * Global freshness horizon for persisted quota/plan evidence. A plan or
 * snapshot older than this is downgraded to `unknown` by routing instead of
 * being trusted indefinitely. First cut uses one global value (not
 * provider-specific); see proposal locked decision #4.
 */
export const QUOTA_FRESHNESS_HORIZON_MS = 6 * 60 * 60 * 1000;

/** The account's total remaining absolute credit, or `null` when unknown. */
export function accountRemainingCredit(candidate: RoutedCandidate): number | null {
  const windows = candidate.quota_windows;
  if (windows === undefined || windows.length === 0) return null;
  return totalRemainingCredit(windows);
}

/**
 * Evaluates whether the candidate sits below its configured usage floor.
 * Mirrors the legacy ordering heuristic (credit vs lowest independent percent),
 * but returns a tri-state used for proactive exclusion under the unified
 * routing engine.
 */
export function usageFloorStateFor(candidate: RoutedCandidate): "above" | "below" | "unknown" {
  const floor = candidate.usage_floor;
  if (floor === null || floor === undefined || floor <= 0) return "unknown";
  if (candidate.free_tier === true) return "above";
  const windows = candidate.quota_windows;
  if (windows === undefined || windows.length === 0) return "unknown";
  if (candidate.usage_floor_unit === "credit") {
    const credit = accountRemainingCredit(candidate);
    if (credit === null) return "unknown";
    return credit >= floor ? "above" : "below";
  }
  const percent = totalRemainingPercent(windows);
  if (percent === null) return "unknown";
  return percent >= floor ? "above" : "below";
}

/** Earliest stated reset across exhausted windows, when any carries one. */
export function exhaustedResetMs(windows: readonly ProviderQuotaWindow[] | undefined): number | undefined {
  if (windows === undefined) return undefined;
  let earliest: number | undefined;
  for (const window of windows) {
    if (window.resetsAt === null || window.resetsAt === undefined) continue;
    const at = Date.parse(window.resetsAt);
    if (!Number.isFinite(at)) continue;
    if (earliest === undefined || at < earliest) earliest = at;
  }
  return earliest;
}

/** True when every relevant quota window for the candidate is known-spent. */
export function allWindowsExhausted(windows: readonly ProviderQuotaWindow[]): boolean {
  if (windows.length === 0) return false;
  for (const window of windows) {
    if (window.accounting === "pooled") {
      const remaining = window.remaining;
      if (remaining !== null && remaining !== undefined && remaining > 0) return false;
      const limit = window.limit;
      if (limit !== null && limit !== undefined) {
        const used = window.used;
        if (used !== null && used !== undefined && used < limit) return false;
        if (used === null && window.remainingPercent !== null && window.remainingPercent > 0) {
          return false;
        }
      } else if (window.remainingPercent !== null && window.remainingPercent > 0) {
        return false;
      } else if (remaining === null && window.used === null) {
        // No evidence of either remaining or used — not provably spent.
        return false;
      } else if (remaining !== null && limit === null) {
        // Remaining=0 but no limit: cannot prove the pool is exhausted without
        // knowing the total. This is the "credit window without a known ceiling"
        // shape — treat as unknown, not exhausted.
        return false;
      }
    } else {
      const remainingPercent = window.remainingPercent;
      if (remainingPercent !== null && remainingPercent > 0) return false;
      if (remainingPercent === null) {
        // Unknown independent window: cannot prove exhaustion.
        return false;
      }
    }
  }
  return true;
}

/**
 * Derives the normalized quota fact the routing decision engine evaluates.
 */
export function normalizeQuotaFact(
  candidate: RoutedCandidate,
  cacheEntry: { readonly fetchedAt: string | null; readonly quota: ProviderQuotaResult } | null | undefined,
  snapshotEntry: { readonly fetchedAt: string; readonly quota: ProviderQuotaResult } | null | undefined,
  now = Date.now(),
): NormalizedQuotaFact {
  const windows = candidate.quota_windows;
  const source =
    cacheEntry?.quota !== undefined
      ? cacheEntry.quota.error === null
        ? ("live_cache" as const)
        : ("unsupported" as const)
      : snapshotEntry?.quota !== undefined
        ? snapshotEntry.quota.error === null
          ? ("snapshot" as const)
          : ("unsupported" as const)
        : ("none" as const);

  // Freshness: only live-cache and snapshot evidence carries an observed-at.
  const observedSrc =
    cacheEntry?.quota !== undefined && cacheEntry.quota.error === null
      ? cacheEntry
      : snapshotEntry?.quota !== undefined && snapshotEntry.quota.error === null
        ? snapshotEntry
        : null;
  const rawObservedAt = observedSrc?.fetchedAt;
  const observedAt =
    rawObservedAt === null || rawObservedAt === undefined ? Number.NaN : Date.parse(rawObservedAt);
  const hasObservedAt = Number.isFinite(observedAt) && observedAt > 0;
  // Stale is only meaningful when we have an observation timestamp to judge.
  // Without one (candidate-stamped windows, no cache/snapshot metadata) there
  // is nothing to mark stale, so the windows remain usable evidence.
  const isStale = hasObservedAt && now - observedAt > QUOTA_FRESHNESS_HORIZON_MS;

  const usageFloorState = usageFloorStateFor(candidate);
  // Stale evidence is downgraded to unknown — the freshness horizon (locked
  // decision #4) means routing must not trust a weeks-old balance for either
  // exhaustion or floor decisions.
  if (isStale) {
    return {
      quotaState: "unknown",
      quotaSource: source,
      quotaObservedAt: hasObservedAt ? observedAt : null,
      isStale: true,
      usageFloorState: "unknown",
    };
  }
  if (windows === undefined || windows.length === 0) {
    return {
      quotaState: "unknown",
      quotaSource: source,
      quotaObservedAt: hasObservedAt ? observedAt : null,
      isStale: false,
      usageFloorState,
    };
  }
  if (usageFloorState === "below") {
    return {
      quotaState: "exhausted",
      quotaSource: source,
      quotaObservedAt: hasObservedAt ? observedAt : null,
      isStale,
      usageFloorState,
    };
  }
  if (allWindowsExhausted(windows)) {
    return {
      quotaState: "exhausted",
      quotaSource: source,
      quotaObservedAt: hasObservedAt ? observedAt : null,
      isStale,
      usageFloorState,
    };
  }
  return {
    quotaState: "available",
    quotaSource: source,
    quotaObservedAt: hasObservedAt ? observedAt : null,
    isStale,
    usageFloorState,
  };
}

/**
 * Routing priority for an account's remaining allowance when two candidates sit
 * in the same rank group: positive remaining credit first, then unknown, then
 * known-zero last. Free-tier models skip the preference entirely — a free model
 * routes to any account, as the provider's own directory stated it is free.
 */
export function creditPriority(candidate: RoutedCandidate): number {
  if (candidate.free_tier === true) return 0;
  const windows = candidate.quota_windows;
  if (windows === undefined || windows.length === 0) return 0;
  const credit = totalRemainingCredit(windows);
  if (credit === null) return 0;
  return credit > 0 ? 1 : -1;
}

/**
 * Hot-window guard: true when the account's most-urgent window is ≥85% used.
 * A nearly exhausted short window means an imminent mid-session block, so these
 * candidates rank behind cooler siblings no matter their drain score — overflow
 * lands on the next-most-urgent cool account instead.
 */
export function hotWindow(windows: readonly ProviderQuotaWindow[] | undefined): boolean {
  if (windows === undefined || windows.length === 0) return false;
  for (const window of windows) {
    const used = window.usedPercent;
    if (typeof used === "number" && Number.isFinite(used) && used >= 85) return true;
    const remaining = window.remainingPercent;
    if (typeof remaining === "number" && Number.isFinite(remaining) && remaining <= 15) return true;
  }
  return false;
}

/**
 * Carries a cooling deadline onto a decision only when there is one.
 *
 * A spread rather than a bare field because `exactOptionalPropertyTypes` treats
 * `cooldown_until: undefined` as a *present* property, which would assert a
 * deadline exists for a candidate that has none.
 */
export function spreadDeadline(cooldownUntil: number | undefined): { cooldown_until?: number } {
  return cooldownUntil === undefined ? {} : { cooldown_until: cooldownUntil };
}

/**
 * The earliest instant any cooling candidate recovers, in epoch ms.
 *
 * `undefined` when no decision carries a deadline — which is the honest answer
 * for a set whose exclusions have no reset (`disabled`), and keeps
 * `accountsRateLimitedError` from reporting a number nobody measured. The
 * minimum, not the maximum: the client can be served as soon as the *first*
 * account comes back, so quoting the slowest would hold it off longer than it
 * has to wait.
 */
export function earliestResetMs(
  decisions: readonly { readonly cooldown_until?: number }[],
): number | undefined {
  let earliest: number | undefined;
  for (const decision of decisions) {
    const until = decision.cooldown_until;
    if (typeof until !== "number" || !Number.isFinite(until) || until <= Date.now()) continue;
    if (earliest === undefined || until < earliest) earliest = until;
  }
  return earliest;
}

/**
 * Shared eligibility evaluator used by live routing, console diagnostics,
 * manual tests, and probes. No path bypasses it.
 *
 * A cooling account is *deprioritized*, not excluded. Cooling means "recently
 * failed, try something else first", not "cannot serve this request": a quota
 * cooldown is usually scoped to one model or one provider, the deadline can be
 * the classifier's own fallback rather than the provider's statement, and a
 * per-request refusal (a bid the upstream declined) can park an otherwise
 * healthy account for an hour. Excluding it made the gateway answer
 * `accounts_unavailable` while a usable credential sat idle — reported as
 * "cooldown blocks the account completely". Ordering is what carries the
 * intent instead: `plan()` sorts cooling candidates after every healthy one,
 * so they are reached only when nothing better is left.
 *
 * That ordering only helps while a healthy sibling exists. Once *every* eligible
 * candidate is cooling there is nothing to fail over to, and dialing a cooling
 * account can only reproduce the refusal that cooled it — the operator's "still
 * hit a cooled-down account, never failed over" report. `plan()` therefore
 * answers `accountsRateLimitedError` (429) in that end state instead of
 * planning a cooling account; the evaluator itself still returns `cooldown`
 * candidates eligible, because the ordering above is what the plan needs to
 * build the healthy-first list.
 *
 * `model_cooldown` reaches that same 429 by a different route: the evaluator
 * excludes it outright, so when it is the only reason nothing is eligible
 * `plan()` reports it as a time-bounded refusal rather than 503
 * `accounts_unavailable`. See the branch in `plan()`.
 *
 * `model_cooldown` is the exception, and a hard exclusion. It is the snapshot's
 * marker for an *unexpired per-model* entry on the candidate whose model is
 * being planned — the upstream stated this exact (account, model) pair is
 * exhausted until a named reset. That is a verdict about this request, not a
 * general "try later": the deadline is the provider's own statement, retrying
 * inside it can only reproduce the refusal, and the account keeps serving every
 * other model it holds. Deprioritizing it instead made failover burn a full
 * round trip on a known-refused account after every healthy sibling failed, and
 * logged a fresh `active → cooldown` row on each attempt.
 *
 * `disabled` stays a hard exclusion: it is an operator decision, and only an
 * operator restores it.
 */
export class EligibilityEvaluator {
  evaluate(candidate: RoutedCandidate): EligibilityDecision {
    if (candidate.health_status === "disabled")
      return { eligible: false, reason: "disabled", candidate };
    if (candidate.health_status === "model_cooldown")
      return { eligible: false, reason: "model_cooldown", candidate, ...spreadDeadline(candidate.cooldown_until) };
    if (candidate.health_status === "cooldown" && candidate.cooldown_kind === "hard")
      return { eligible: false, reason: "cooldown_hard", candidate, ...spreadDeadline(candidate.cooldown_until) };
    // Quota/usage-floor is deliberately NOT an exclusion: an account whose
    // window is spent or below its configured floor is still routed, and the
    // upstream is the one that answers (its refusal is classified into a
    // cooldown then). Blocking here made free-tier and exhausted accounts
    // unreachable even when the operator wanted them tried — "don't follow
    // quota, route whether or not it has any."
    //
    // A slow lane is orthogonal to cooldown, never a member of it: the account
    // still serves on spare capacity when the request carries the slow usage
    // limit, so excluding it would park a serving credential. It stays eligible
    // and only orders behind fresh siblings (see the ordering below).
    if (candidate.lane === "slow")
      return { eligible: true, reason: "slow", candidate };
    if (candidate.health_status === "cooldown")
      return { eligible: true, reason: "cooldown", candidate, ...spreadDeadline(candidate.cooldown_until) };
    return { eligible: true, reason: "healthy", candidate };
  }
}
