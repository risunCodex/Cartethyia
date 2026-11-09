// Routing model resolution and route planning.
import { log } from "../../observability/logger";
import { GatewayError } from "../../protocol/gateway-error";
import {
  accountsRateLimitedError,
  accountsUnavailableError,
  ambiguousModelError,
  capacityExhaustedError,
  modelNotFoundError,
  type AdmissionController,
  type ComboDefinition,
  type ProviderRoutingSetting,
  type Reservation,
  type RouteCandidate,
  type RoutedCandidate,
  type RoutePlan,
  type EligibilityDecision,
  type RouteContinuationAffinity,
  type RouteSnapshot,
  type RoutingDecision,
  ROUTING_RANK,
} from "./route-model";
import {
  candidateSupportsRequest,
  type RequiredCapability,
} from "../../protocol/translation/capabilities";
import { planAllowsCandidate } from "./plan-gate";
import { accountReservePct, routingStickyWarmMs, routingStickyMaxSessions } from "../../config/routing";
import type { NormalizedQuotaFact } from "./route-model";
import { InMemoryAdmissionController, admissionKey } from "./admission";
import { ReservationManager } from "./reservations";
import { createRoundRobinMap, RoundRobinState, StickySessionStore } from "./round-robin";
import { drainScore, isInReserve } from "./drain-reserve";
import {
  lookupRouteCandidates,
  parseModelReference,
  routeCandidateIndex,
} from "./candidate-index";
import {
  totalRemainingCredit,
  totalRemainingPercent,
  type ProviderQuotaResult,
  type ProviderQuotaWindow,
} from "../../providers/quota/quota-contracts";
import { getCachedQuotaEntries, quotaLens, type CachedQuotaEntry } from "../../providers/quota/cache";
import { readQuotaSnapshots } from "../../providers/quota/snapshot";
import type { ProviderQuotaResultSnapshot } from "../../persistence/schema";
import type { CartethyiaDatabase } from "../../persistence/db-handle";
import type { RedisClient } from "../../persistence/redis";
import { sharedClaudeSlowLanes } from "../../providers/integrations/claude/claude-slow-lane";

/**
 * Filters quota windows to those relevant to the candidate model.
 * Providers like Antigravity report separate quotas for distinct model families
 * (Gemini vs Claude/GPT), and Grok reports per-product buckets.
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
function accountRemainingCredit(candidate: RoutedCandidate): number | null {
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
function usageFloorStateFor(candidate: RoutedCandidate): "above" | "below" | "unknown" {
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
function exhaustedResetMs(windows: readonly ProviderQuotaWindow[] | undefined): number | undefined {
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
function allWindowsExhausted(windows: readonly ProviderQuotaWindow[]): boolean {
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
function normalizeQuotaFact(
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
function creditPriority(candidate: RoutedCandidate): number {
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
function hotWindow(windows: readonly ProviderQuotaWindow[] | undefined): boolean {
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
 * Normalizes a requested model name before alias lookup. Coding-agent CLIs
 * version their model ids with variant suffixes (`claude-opus-5[1m]`,
 * effort tags, …) that must never each become a mapping row. Normalization
 * is a pure lookup fallback — verbatim match always wins, and an
 * unrecognized name still resolves to itself (then fails downstream as
 * `model_not_found`, exactly like today).
 */
function normalizeAliasKey(requested: string, aliasMap: Record<string, string> | undefined): string {
  if (!aliasMap || aliasMap[requested] !== undefined) return requested;
  // 1. Strip a trailing `[...]` variant (`claude-opus-5[1m]` → `claude-opus-5`).
  let base = requested;
  const bracket = requested.indexOf("[");
  if (bracket > 0) {
    base = requested.slice(0, bracket);
    if (aliasMap[base] !== undefined) return base;
  }
  // 2. Family-slot fallback: `claude-<slot>-…` resolves through the slot
  // alias (`claude-opus-5` → `opus`, `claude-opus` → `opus`) so a full model
  // id honors the same mapping as the short slot name without per-variant
  // rows. Only fires when the full name has no mapping of its own.
  if (base.startsWith("claude-")) {
    const rest = base.slice("claude-".length);
    if (aliasMap[rest] !== undefined) return rest;
    const dash = rest.indexOf("-");
    if (dash > 0) {
      const slot = rest.slice(0, dash);
      if (aliasMap[slot] !== undefined) return slot;
    }
  }
  return base;
}

/**
 * Resolves one requested name to its alias target for pre-routing policy
 * checks. CLI mappings are opt-in per API key; ordinary tenant aliases always
 * remain available. `keyId` is required to read the key's own CLI routes —
 * without it CLI mappings are silently skipped even when `allowCliMappings`
 * is true.
 */
export function resolveAliasTarget(
  snapshot: RouteSnapshot,
  tenantId: string | null,
  requested: string,
  allowCliMappings = false,
  keyId?: string,
): string {
  try {
    return resolveAlias(requested, snapshot, tenantId, allowCliMappings, keyId).model;
  } catch {
    return requested;
  }
}

function aliasMapFor(
  snapshot: RouteSnapshot,
  tenantId: string | null,
  allowCliMappings: boolean,
  keyId?: string,
): Record<string, string> | undefined {
  if (!tenantId) return undefined;
  const aliases = snapshot.aliases?.[tenantId];
  const cliAliases = allowCliMappings
    ? keyId
      ? snapshot.cli_aliases?.[`${tenantId}:${keyId}`] ?? snapshot.cli_aliases?.[tenantId]
      : snapshot.cli_aliases?.[tenantId]
    : undefined;
  if (!aliases && !cliAliases) return undefined;
  return { ...(aliases ?? {}), ...(cliAliases ?? {}) };
}

function resolveAlias(
  requested: string,
  snapshot: RouteSnapshot,
  tenantId: string | null,
  allowCliMappings = false,
  keyId?: string,
): { model: string; chain: readonly string[] } {
  const aliasMap = aliasMapFor(snapshot, tenantId, allowCliMappings, keyId);
  const chain: string[] = [];
  const seen = new Set<string>();
  let current = normalizeAliasKey(requested, aliasMap);
  while (aliasMap?.[current] !== undefined) {
    if (seen.has(current))
      throw new Error(`routing alias cycle: ${[...chain, current].join(" -> ")}`);
    if (chain.length >= 16)
      throw new Error(`routing alias depth exceeded: ${[...chain, current].join(" -> ")}`);
    const target = aliasMap[current];
    if (target === undefined) break;
    seen.add(current);
    chain.push(current);
    current = target;
  }
  return { model: current, chain };
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
/**
 * Carries a cooling deadline onto a decision only when there is one.
 *
 * A spread rather than a bare field because `exactOptionalPropertyTypes` treats
 * `cooldown_until: undefined` as a *present* property, which would assert a
 * deadline exists for a candidate that has none.
 */
function spreadDeadline(cooldownUntil: number | undefined): { cooldown_until?: number } {
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
function earliestResetMs(
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

export class RoutingEngine {
  private readonly _roundRobinByCombo = createRoundRobinMap();
  private readonly _roundRobinByProvider = createRoundRobinMap();
  private readonly eligibility = new EligibilityEvaluator();
  private readonly reservations = new ReservationManager();
  private readonly sticky = new StickySessionStore(routingStickyMaxSessions());

  constructor(
    private readonly admission: AdmissionController = new InMemoryAdmissionController(),
    private readonly redis?: RedisClient,
    private readonly db?: CartethyiaDatabase,
  ) {}

  private getRoundRobin(key: string): RoundRobinState {
    const existing = this._roundRobinByCombo.get(key);
    if (existing) return existing;
    const created = new RoundRobinState();
    this._roundRobinByCombo.set(key, created);
    return created;
  }

  private getProviderRoundRobin(key: string): RoundRobinState {
    const existing = this._roundRobinByProvider.get(key);
    if (existing) return existing;
    const created = new RoundRobinState();
    this._roundRobinByProvider.set(key, created);
    return created;
  }

  /** Observable bounded-collection sizes for the runtime metrics sampler. */
  roundRobinEntries(): { readonly combo: number; readonly provider: number } {
    return { combo: this._roundRobinByCombo.size, provider: this._roundRobinByProvider.size };
  }

  /**
   * Live admission counters for the buckets the given candidates draw from.
   *
   * Takes candidates rather than returning a fleet-wide snapshot: the scoped
   * read is what keeps `plan()` off Redis `KEYS` (the fleet-wide read had no
   * other implementation) and bounds the console's per-provider read to the
   * accounts it will actually report on. Both controllers hand back a fresh
   * map, so no defensive copy here — this feeds an admin read, not a mutation
   * site.
   */
  async accountInflightSnapshot(
    candidates: readonly RouteCandidate[],
  ): Promise<ReadonlyMap<string, number>> {
    return this.admission.readAccountInflight(candidates);
  }

  /**
   * Which candidates are already at their concurrency ceiling.
   *
   * The admission controller already holds these counters and will refuse the
   * account the moment it is asked; reading them here lets the plan *order*
   * use the same fact, so the first attempt goes to an account with room
   * instead of to one that is certain to answer 429.
   *
   * A counter read is a snapshot, so it can be a little stale — a slot freed
   * between here and `admit()` only costs a retry, which is the behavior
   * today anyway. A candidate with no configured ceiling is never saturated:
   * admission treats it as unlimited.
   */
  private async saturatedCandidates(
    candidates: readonly RouteCandidate[],
  ): Promise<ReadonlySet<RouteCandidate>> {
    const bounded = candidates.filter(
      (candidate) => typeof candidate.max_inflight === "number" && candidate.max_inflight > 0,
    );
    if (bounded.length === 0) return new Set();
    // Only the bounded candidates can be saturated, so only their buckets are
    // read. A failed ordering read must never fail routing — the admission
    // attempt itself is the real gate; this read only optimizes attempt order.
    const snapshot = await this.accountInflightSnapshot(bounded).catch(
      () => new Map<string, number>(),
    );
    if (snapshot.size === 0) return new Set();
    const saturated = new Set<RouteCandidate>();
    for (const candidate of bounded) {
      const limit = candidate.max_inflight;
      if (limit === undefined) continue;
      const inflight = snapshot.get(admissionKey(candidate));
      if (inflight !== undefined && inflight >= limit) {
        saturated.add(candidate);
      }
    }
    return saturated;
  }

  private resolveProviderRouting(
    snapshot: RouteSnapshot,
    providerId: string,
    tenantId: string | null,
  ): ProviderRoutingSetting | undefined {
    const routing = snapshot.providerRouting;
    if (!routing) return undefined;
    const tenantKey = tenantId ?? "__global__";
    const tenantBucket = (routing as Record<string, Record<string, ProviderRoutingSetting>>)[
      tenantKey
    ];
    if (tenantBucket?.[providerId]) return tenantBucket[providerId];
    const globalBucket = (routing as Record<string, Record<string, ProviderRoutingSetting>>)[
      "__global__"
    ];
    if (globalBucket?.[providerId]) return globalBucket[providerId];
    return undefined;
  }

  private reorderRun(
    run: RouteCandidate[],
    settings: ProviderRoutingSetting | undefined,
    tid: string | null,
  ): RouteCandidate[] {
    if (!settings || !settings.enabled || settings.strategy === "fallback") {
      return [...run];
    }
    const rrKey = `${tid ?? "__global__"}::${run[0]!.provider_id}`;
    const rr = this.getProviderRoundRobin(rrKey);
    const chosen = rr.next(run, settings.rotateCount);
    if (!chosen) return [...run];
    const idx = run.indexOf(chosen);
    if (idx <= 0) return [...run];
    return [...run.slice(idx), ...run.slice(0, idx)];
  }

  /**
   * Stamps one candidate with its provider's usage floor + quota windows (the
   * per-candidate half of the old `applyUsageFloor`).
   */
  private async applyUsageFloorToCandidate(
    candidate: RouteCandidate,
    snapshot: RouteSnapshot,
    tenantId: string | null,
    quotaCache: ReadonlyMap<string, CachedQuotaEntry>,
    snapshotMap: ReadonlyMap<string, ProviderQuotaResultSnapshot>,
  ): Promise<RouteCandidate> {
    const accountId = candidate.provider_account_id;
    if (accountId === undefined) return candidate;
    const setting = this.resolveProviderRouting(
      snapshot,
      candidate.provider_id,
      candidate.tenant_id ?? tenantId,
    );
    const cached = quotaCache.get(accountId);
    // The live cache is authoritative when warm; when it is cold (e.g. right
    // after a restart, before the sweep re-reads accounts), fall back to the
    // persisted quota snapshot — the durable source of truth — so routing
    // still prefers accounts that actually have remaining credit. The snapshot
    // is never fresher than the cache, but a stale balance beats an unknown
    // one for ordering, and the sweep refreshes it on schedule.
    let quota = cached?.quota;
    let stored: { readonly fetchedAt: string; readonly quota: ProviderQuotaResult } | null = null;
    if (quota === undefined) {
      const snap = snapshotMap.get(accountId);
      if (snap !== undefined) {
        stored = { fetchedAt: snap.fetchedAt, quota: snap.quota };
        quota = snap.quota;
      }
    }
    const rawWindows = quota?.windows;
    // The cache is authoritative when it has a reading; when it does not,
    // keep whatever the candidate already carried (the credit ordering reads
    // these windows, and a miss must not erase a stamped value).
    const quotaWindows =
      rawWindows === undefined
        ? undefined
        : candidate.provider_id === "zcode-start" ? rawWindows : filterCandidateQuotaWindows(rawWindows, candidate);
    const stamped: RoutedCandidate = {
      ...candidate,
      ...(setting?.usageFloor == null
        ? {}
        : { usage_floor: setting.usageFloor, usage_floor_unit: setting.usageFloorUnit }),
      // When no cache/snapshot evidence exists, keep the candidate's own
      // stamped windows (unit tests and in-memory fixture route this way).
      ...(quotaWindows === undefined
        ? candidate.quota_windows === undefined
          ? {}
          : { quota_windows: candidate.quota_windows }
        : { quota_windows: quotaWindows }),
      ...(quota?.source === "zcode-start" && quota.error === null ? { quota_entitlements_known: true } : {}),
      // Drain urgency and reserve are derived from the same windows the credit
      // ordering already reads. They are ordering preferences, never
      // exclusions: an account in reserve or with a zero drain score stays
      // eligible and routed.
      ...(quotaWindows === undefined && candidate.quota_windows === undefined
        ? {}
        : { drain_score: drainScore(quotaWindows ?? candidate.quota_windows) }),
      ...(quotaWindows === undefined && candidate.quota_windows === undefined
        ? {}
        : { in_reserve: isInReserve(quotaWindows ?? candidate.quota_windows, accountReservePct()) }),
    };
    const fact = normalizeQuotaFact(stamped, cached, stored);
    return { ...stamped, quota_fact: fact };
  }

  /**
   * One merged evaluation of a candidate: health/cooldown eligibility, slow
   * lane, usage floor, plan gate, and capability support. Returns the candidate
   * and the single `RoutingDecision` every downstream layer reads.
   */
  private evaluateCandidate(
    candidate: RouteCandidate,
    _snapshot: RouteSnapshot,
    _tenantId: string | null,
    requiredCapabilities: readonly RequiredCapability[] | undefined,
  ): { candidate: RouteCandidate; decision: RoutingDecision } {
    const eligibility = this.eligibility.evaluate(candidate);
    if (!eligibility.eligible) {
      const reason = eligibility.reason;
      const rank =
        reason === "model_cooldown" || reason === "cooldown_hard"
          ? ROUTING_RANK.COOLING
          : ROUTING_RANK.SATURATED;
      return {
        candidate,
        decision: {
          eligible: false,
          rank,
          reason,
          ...(eligibility.cooldown_until !== undefined
            ? { cooldown_until: eligibility.cooldown_until }
            : {}),
          floor_blocked: reason === "quota_exhausted",
        },
      };
    }
    // Slow lane.
    const accountId = (candidate as RouteCandidate & { readonly provider_account_id?: string })
      .provider_account_id;
    if (accountId !== undefined && sharedClaudeSlowLanes.isActive(accountId)) {
      return {
        candidate,
        decision: {
          eligible: true,
          rank: ROUTING_RANK.SLOW,
          reason: "slow",
        },
      };
    }
    // Unified decision engine: normalized quota/plan fact.
    const fact = candidate.quota_fact;
    if (fact !== undefined) {
      if (fact.quotaState === "exhausted" || fact.usageFloorState === "below") {
        const reset = exhaustedResetMs(candidate.quota_windows);
        return {
          candidate,
          decision: {
            eligible: false,
            rank: ROUTING_RANK.SATURATED,
            reason: "quota_exhausted",
            floor_blocked: fact.usageFloorState === "below",
            saturated: false,
            ...(reset === undefined ? {} : { cooldown_until: reset }),
          },
        };
      }
    }
    // Plan gate (free plan).
    if (!planAllowsCandidate(candidate)) {
      return {
        candidate,
        decision: {
          eligible: false,
          rank: ROUTING_RANK.SATURATED,
          reason: "plan_gate",
          plan_gate_blocked: true,
        },
      };
    }
    // Capability.
    if (requiredCapabilities !== undefined && requiredCapabilities.length > 0) {
      if (!candidateSupportsRequest(candidate, requiredCapabilities)) {
        return {
          candidate,
          decision: {
            eligible: false,
            rank: ROUTING_RANK.SATURATED,
            reason: "capability_unsupported",
            capability_blocked: true,
          },
        };
      }
    }
    // A soft cooldown is a deprioritization, not an exclusion: the evaluator
    // returned it eligible (so a single-account deployment still routes), but
    // it must still behind every fresh/slow sibling. Without this branch the
    // candidate falls through to the quota classification below, which labels
    // it FRESH_KNOWN/FRESH_UNKNOWN and lets it sort ahead of healthy accounts —
    // the "still hit a cooled-down account, never failed over" report. The raw
    // `reason` stays `"cooldown"` so `ELIGIBILITY_REASON_LABELS` and the
    // envelope `reasons` stream are untouched, and the reset deadline rides
    // along for the all-cooling 429 answer.
    if (eligibility.reason === "cooldown") {
      return {
        candidate,
        decision: {
          eligible: true,
          rank: ROUTING_RANK.COOLING,
          reason: "cooldown",
          ...(eligibility.cooldown_until !== undefined
            ? { cooldown_until: eligibility.cooldown_until }
            : {}),
        },
      };
    }
    // Unified engine: unknown quota is eligible but lower-rank than known-available.
    if (fact !== undefined) {
      if (fact.quotaState === "unknown") {
        return {
          candidate,
          decision: {
            eligible: true,
            rank: ROUTING_RANK.FRESH_UNKNOWN,
            reason: "quota_unknown",
          },
        };
      }
      return {
        candidate,
        decision: {
          eligible: true,
          rank: ROUTING_RANK.FRESH_KNOWN,
          reason: "healthy",
        },
      };
    }
    return {
      candidate,
      decision: {
        eligible: true,
        rank: ROUTING_RANK.FRESH_KNOWN,
        reason: "healthy",
      },
    };
  }

  /**
   * Rotates accounts within the same rank group only. The rank is the primary
   * sort key, so rotation can never float a cooling/saturated account ahead of
   * a fresh one — the old double-sort is gone by construction.
   */
  private applyProviderRoutingSorted(
    eligible: readonly RouteCandidate[],
    decisions: ReadonlyMap<string, RoutingDecision>,
    snapshot: RouteSnapshot,
    tid: string | null,
  ): RouteCandidate[] {
    if (eligible.length <= 1) return [...eligible];
    const result: RouteCandidate[] = [];
    let i = 0;
    while (i < eligible.length) {
      const cur = eligible[i]!;
      const rank = decisions.get(admissionKey(cur))?.rank ?? ROUTING_RANK.FRESH_KNOWN;
      let j = i + 1;
      while (j < eligible.length) {
        const next = eligible[j]!;
        const nextRank = decisions.get(admissionKey(next))?.rank ?? ROUTING_RANK.FRESH_KNOWN;
        if (
          next.provider_id !== cur.provider_id ||
          next.model_id !== cur.model_id ||
          nextRank !== rank
        ) {
          break;
        }
        j += 1;
      }
      const run = eligible.slice(i, j);
      if (run.length > 1) {
        const settings = this.resolveProviderRouting(snapshot, cur.provider_id, tid);
        result.push(...this.reorderRun([...run], settings, tid));
      } else {
        result.push(...run);
      }
      i = j;
    }
    return result;
  }

  /**
   * Applies continuation affinity as a hard pin (or a rebase pass-through).
   *
   * Returns a plan when the pinned account is present and eligible, `null`
   * when the continuation is rebaseable and the pin is empty (so the caller
   * continues with ordinary routing), and throws the strict 400 when the pin
   * is a hard constraint with no matching candidate.
   */
  private resolveContinuationPlan(
    affinity: RouteContinuationAffinity,
    matching: readonly RouteCandidate[],
    requestedModel: string,
    resolvedModel: string,
    snapshot: RouteSnapshot,
  ): RoutePlan | null {
    const pinned = matching.filter(
      (candidate) =>
        candidate.provider_id === affinity.providerId &&
        candidate.provider_account_id === affinity.providerAccountId,
    );
    if (pinned.length === 0) {
      if (affinity.rebaseable) return null;
      throw new GatewayError(
        "invalid_request",
        400,
        "This tool result belongs to a Cursor account that is no longer routable (request {requestId}). Reconnect the account, or resend the complete conversation. The session went cold — reconnect or resend 🔌",
        {
          providerId: affinity.providerId,
          accountId: affinity.providerAccountId,
        },
      );
    }
    // The pinned account owns the live session, so it is the only correct
    // target for this tool result — but health still applies. Forcing a
    // session whose account is hard-cooling (quota exhausted) reproduces the
    // refusal that cooled it, which is how "still hit a cooled-down account"
    // leaked through continuation affinity. Evaluate the pin before
    // returning: time-bounded cooling answers 429 with the real reset; an
    // account that is disabled/locked answers a clear 400.
    const pinnedDecisions = pinned.map((candidate) => this.eligibility.evaluate(candidate));
    const blocked = pinnedDecisions.find((decision) => !decision.eligible);
    if (blocked !== undefined) {
      // A rebaseable continuation (complete conversation replay) is not owed
      // to this account: the recorded exchange may travel as history to a
      // fresh Run on an eligible account. Cooling/blocked pinned account must
      // not turn that into a hard refusal — fall through to normal routing.
      if (affinity.rebaseable) return null;
      const reason = blocked.reason;
      if (
        reason === "cooldown_hard" ||
        reason === "model_cooldown" ||
        (reason === "quota_exhausted" && typeof blocked.cooldown_until === "number")
      ) {
        throw accountsRateLimitedError(requestedModel, resolvedModel, earliestResetMs(pinnedDecisions));
      }
      throw new GatewayError(
        "invalid_request",
        400,
        "This tool result belongs to an account that is no longer routable (request {requestId}). Reconnect the account, or resend the complete conversation. The session went cold — reconnect or resend 🔌",
        {
          providerId: affinity.providerId,
          accountId: affinity.providerAccountId,
        },
      );
    }
    const decisions = new Map<string, RoutingDecision>();
    for (const candidate of pinned) {
      const decision = pinnedDecisions.find((d) => d.candidate === candidate);
      decisions.set(admissionKey(candidate), {
        eligible: true,
        rank: ROUTING_RANK.FRESH_KNOWN,
        reason: "healthy",
        ...(decision?.cooldown_until !== undefined
          ? { cooldown_until: decision.cooldown_until }
          : {}),
      });
    }
    return {
      revision: snapshot.revision,
      candidates: pinned,
      requested_model: requestedModel,
      resolved_model: resolvedModel,
      provider_id: pinned[0]!.provider_id,
      decisions,
    };
  }

  async plan(
    requestedModel: string,
    snapshot: RouteSnapshot,
    tenantId?: string | null,
    requiredCapabilities?: readonly RequiredCapability[],
    allowCliMappings = false,
    keyId?: string,
    continuationAffinity?: RouteContinuationAffinity,
    sessionId?: string,
  ): Promise<RoutePlan> {
    const tid = tenantId ?? null;
    const { resolved, matching, unmatchedMembers } = this.resolveMatchingCandidates(
      requestedModel,
      snapshot,
      tid,
      allowCliMappings,
      keyId,
    );
    // Continuation affinity is applied first and absolutely.
    //
    // A request carrying a tool result for a provider session this process is
    // holding MUST reach the exact live account that owns that session. Routing
    // it anywhere else is not a degraded choice — it is a correctness failure:
    // the result would be written onto a different account's upstream turn
    // (corrupting both conversations and leaking the first account's context),
    // or into a fresh turn that never asked for the call. So the candidate set
    // is restricted before any health, cooling, or rotation logic runs, and an
    // empty result is a refusal rather than a fallback to normal routing.
    // Continuation affinity is applied first and absolutely.
    //
    // A request carrying a tool result for a provider session this process is
    // holding MUST reach the exact live account that owns that session. Routing
    // it anywhere else is not a degraded choice — it is a correctness failure:
    // the result would be written onto a different account's upstream turn
    // (corrupting both conversations and leaking the first account's context),
    // or into a fresh turn that never asked for the call. So the candidate set
    // is restricted before any health, cooling, or rotation logic runs, and an
    // empty result is a refusal rather than a fallback to normal routing.
    //
    // The one exception is a *rebaseable* continuation: when the conversation
    // is complete (every tool result is answered in the history) and the pinned
    // account is no longer routable for the requested model, the request may
    // fall through to normal routing so the adapter starts a fresh Run carrying
    // the recorded history. This is what makes model switches across accounts
    // work — see `resolveContinuationPlan` and `preparer.ts`.
    if (continuationAffinity !== undefined) {
      const continuationPlan = this.resolveContinuationPlan(
        continuationAffinity,
        matching,
        requestedModel,
        resolved.model,
        snapshot,
      );
      if (continuationPlan !== null) return continuationPlan;
    }
    // ── One evaluation pass ──────────────────────────────────────────────
    // Every filter that used to run as a separate pass (usage floor, slow lane,
    // health/cooldown eligibility, plan gate, capability) is merged into a
    // single per-candidate decision. `plan()` then sorts once by rank and
    // hands the full `decisions` map downstream, so no later layer re-derives
    // a competing ordering.
    //
    // Quota evidence is read in batch before the per-candidate pass: one
    // in-memory/Redis `MGET` per lens and one DB query for the accounts the
    // cache did not answer, instead of a serial round trip per candidate. The
    // per-candidate stamping below then consumes the shared maps, keeping the
    // live-cache-authoritative / snapshot-fallback semantics identical.
    const quotaCacheByAccount = new Map<string, CachedQuotaEntry>();
    const lensToAccounts = new Map<string, string[]>();
    for (const candidate of matching) {
      const accountId = candidate.provider_account_id;
      if (accountId === undefined) continue;
      const lens = quotaLens(candidate.tenant_id ?? tid);
      const accounts = lensToAccounts.get(lens);
      if (accounts === undefined) lensToAccounts.set(lens, [accountId]);
      else accounts.push(accountId);
    }
    for (const [lens, accountIds] of lensToAccounts) {
      const entries = await getCachedQuotaEntries(lens, accountIds, this.redis).catch(
        () => new Map<string, CachedQuotaEntry>(),
      );
      for (const [accountId, entry] of entries) quotaCacheByAccount.set(accountId, entry);
    }
    const snapshotByAccount = new Map<string, ProviderQuotaResultSnapshot>();
    if (this.db !== undefined) {
      const needingSnapshot = matching
        .map((candidate) => candidate.provider_account_id)
        .filter((accountId): accountId is string => accountId !== undefined && !quotaCacheByAccount.has(accountId));
      if (needingSnapshot.length > 0) {
        const snaps = await readQuotaSnapshots(this.db, needingSnapshot).catch(
          () => new Map<string, ProviderQuotaResultSnapshot>(),
        );
        for (const [accountId, snap] of snaps) snapshotByAccount.set(accountId, snap);
      }
    }
    const evaluations = await Promise.all(
      matching.map(async (candidate) => {
        const stamped = await this.applyUsageFloorToCandidate(
          candidate,
          snapshot,
          tid,
          quotaCacheByAccount,
          snapshotByAccount,
        );
        return this.evaluateCandidate(stamped, snapshot, tid, requiredCapabilities);
      }),
    );
    const decisions = new Map<string, RoutingDecision>();
    for (const evaluation of evaluations) {
      decisions.set(admissionKey(evaluation.candidate), evaluation.decision);
    }
    // Saturation is read once (inflight counters) and merged into the same
    // decision map rather than a second sort pass.
    const saturated = await this.saturatedCandidates(matching);
    for (const candidate of saturated) {
      const key = admissionKey(candidate);
      const existing = decisions.get(key);
      if (existing !== undefined) {
        decisions.set(key, {
          ...existing,
          eligible: existing.eligible,
          rank: ROUTING_RANK.SATURATED,
          saturated: true,
        });
      }
    }
    let eligible = evaluations
      .map((evaluation) => evaluation.candidate)
      .filter((candidate) => decisions.get(admissionKey(candidate))?.eligible === true);

    if (eligible.length === 0) {
      // Time-bounded exclusions answer 429, not 503. See the long comment that
      // used to live here: cooldown/floor exclusions with a stated reset are
      // "not until then", not "down". Only a floor with no stated reset stays
      // 503.
      const rateLimited = [...decisions.values()].some(
        (d) =>
          d.reason === "cooldown_hard" ||
          d.reason === "model_cooldown" ||
          (d.reason === "quota_exhausted" && typeof d.cooldown_until === "number"),
      );
      if (rateLimited) {
        throw accountsRateLimitedError(
          requestedModel,
          resolved.model,
          earliestResetMs([...decisions.values()]),
        );
      }
      if (unmatchedMembers.length > 0) {
        log.warn("[routing] combo members without routable candidates", {
          requested: requestedModel,
          routed: resolved.model,
          unmatched: [...new Set(unmatchedMembers)].sort(),
        });
      }
      throw accountsUnavailableError(requestedModel, [...decisions.values()].map((d) => d.reason));
    }

    // Every eligible candidate cooling and no healthy/slow sibling → 429.
    const healthyCount = [...decisions.values()].filter(
      (d) =>
        d.eligible &&
        (d.reason === "healthy" || d.reason === "slow" || d.reason === "quota_unknown"),
    ).length;
    if (healthyCount === 0) {
      throw accountsRateLimitedError(
        requestedModel,
        resolved.model,
        earliestResetMs([...decisions.values()]),
      );
    }

    // Single sort by rank (fresh → slow → cooling → saturated), stable. Within
    // the same rank, ordered by credit → reserve → hot-window guard → measured
    // usage → drain → round-robin. The drain score chases quota about to expire
    // unused; reserve yields to non-reserve siblings; a hot primary window (≥85%
    // used) defers to cooler accounts so overflow lands on a cool sibling.
    const reservePct = accountReservePct();
    const stickyWarmMs = routingStickyWarmMs();
    const stickyEntry = stickyWarmMs > 0 ? this.sticky.get(eligible[0]?.provider_id ?? "", sessionId) : undefined;
    const stickyAccountId = stickyEntry?.accountId;
    const stickyWarm = stickyEntry !== undefined && Date.now() - stickyEntry.lastUsedAtMs < stickyWarmMs;
    eligible = [...eligible].sort((left, right) => {
      const leftRank = decisions.get(admissionKey(left))?.rank ?? ROUTING_RANK.FRESH_KNOWN;
      const rightRank = decisions.get(admissionKey(right))?.rank ?? ROUTING_RANK.FRESH_KNOWN;
      if (leftRank !== rightRank) return leftRank - rightRank;
      // A free-tier model routes to any account: skip every quota-derived
      // preference (credit, reserve, hot-window, drain) so the original order
      // is preserved. Sticky warm pins still apply — they are about prompt
      // cache warmth, not quota.
      const bothFree = left.free_tier === true && right.free_tier === true;
      // Sticky warm pin: within the warm window the account that last served
      // this session wins outright (explicit pins always win).
      const leftSticky = left.provider_account_id === stickyAccountId;
      const rightSticky = right.provider_account_id === stickyAccountId;
      if (leftSticky !== rightSticky) {
        if (stickyEntry?.explicit === true) return leftSticky ? -1 : 1;
        if (stickyWarm) return leftSticky ? -1 : 1;
      }
      if (bothFree) return 0;
      const leftReserve = (left as RoutedCandidate).in_reserve ??
        isInReserve(left.quota_windows, reservePct);
      const rightReserve = (right as RoutedCandidate).in_reserve ??
        isInReserve(right.quota_windows, reservePct);
      if (leftReserve !== rightReserve) return leftReserve ? 1 : -1;
      const leftPriority = (left as RoutedCandidate).account_priority ?? 0;
      const rightPriority = (right as RoutedCandidate).account_priority ?? 0;
      if (leftPriority !== rightPriority) return rightPriority - leftPriority;
      const leftHot = hotWindow(left.quota_windows);
      const rightHot = hotWindow(right.quota_windows);
      if (leftHot !== rightHot) return leftHot ? 1 : -1;
      const credit = creditPriority(right) - creditPriority(left);
      if (credit !== 0) return credit;
      const leftDrain = (left as RoutedCandidate).drain_score ?? 0;
      const rightDrain = (right as RoutedCandidate).drain_score ?? 0;
      if (leftDrain !== rightDrain) return rightDrain - leftDrain;
      return 0;
    });

    // Provider routing rotates accounts within the same rank group only; it can
    // never float a cooling/saturated account ahead of a fresh one because the
    // rank is the primary key of the sort.
    eligible = this.applyProviderRoutingSorted(eligible, decisions, snapshot, tid);

    const chosen = eligible[0]!;
    // Record which account served this session so a follow-up request within the
    // warm window can prefer it (prompt-cache warmth). Explicit operator pins are
    // recorded as explicit so they win even past the warm window.
    if (sessionId !== undefined && chosen.provider_account_id !== undefined) {
      const explicitPin = continuationAffinity?.providerAccountId === chosen.provider_account_id;
      this.sticky.set(chosen.provider_id, sessionId, chosen.provider_account_id, explicitPin);
    }
    return {
      revision: snapshot.revision,
      candidates: eligible,
      requested_model: requestedModel,
      resolved_model: resolved.model,
      provider_id: chosen.provider_id,
      decisions,
    };
  }

  /**
   * Resolves the requested name to a bare target, expands a combo into its
   * member models, and returns the candidates serving them in plan order.
   *
   * Both alias resolution and the ambiguity check judge the *resolved* bare
   * target, never the originally requested name: an alias resolving to a bare
   * model that multiple providers serve must be rejected exactly like
   * requesting that bare model directly, so resolving through an alias is
   * never a silent way to bypass ambiguity protection.
   */
  private resolveMatchingCandidates(
    requestedModel: string,
    snapshot: RouteSnapshot,
    tid: string | null,
    allowCliMappings: boolean,
    keyId?: string,
  ): {
    resolved: ReturnType<typeof resolveAlias>;
    combo: ComboDefinition | undefined;
    matching: RouteCandidate[];
    /** Combo members that matched zero candidates — misconfigured or
     * connection-less members the operator should fix, surfaced on errors
     * instead of failing opaquely on whichever member happened to route. */
    unmatchedMembers: readonly string[];
  } {
    const safeResolve = (name: string) => {
      try {
        return resolveAlias(name, snapshot, tid, allowCliMappings, keyId);
      } catch {
        throw modelNotFoundError(requestedModel);
      }
    };
    const resolved = safeResolve(requestedModel);
    const comboMap = tid ? snapshot.combos[tid] : undefined;
    const combo = comboMap?.[resolved.model];
    // Combo members may themselves be aliases or combos (an alias may target
    // a combo, and a combo may nest another combo). Resolve recursively with
    // the same depth bound as the alias walk so a member that names a combo
    // expands to its models instead of matching no candidate and reading as
    // "model not found" for a route the operator actually defined.
    const expandMember = (name: string, seen: ReadonlySet<string>): readonly string[] => {
      if (seen.has(name) || seen.size >= 16) return [];
      const next = new Set(seen).add(name);
      const alias = safeResolve(name);
      const nested = comboMap?.[alias.model];
      if (!nested) return [alias.model];
      return nested.members.flatMap((member) => expandMember(member, next));
    };
    const rawModelIds = combo
      ? combo.members.flatMap((name) => expandMember(name, new Set([resolved.model])))
      : [resolved.model];
    const modelIds = [...new Set(rawModelIds)];
    // One index build per snapshot (cached on the immutable snapshot), one
    // lookup per unique resolved model. The previous shape rescanned every
    // candidate per model — O(C×K) string parses per plan — which was the
    // quadratic cost the catalog rebuild had already paid once and the request
    // path was paying again on every plan.
    const index = routeCandidateIndex(snapshot);
    const parsedModels = modelIds.map((id) => ({ id, parsed: parseModelReference(id) }));
    let matching = parsedModels.flatMap((entry) => lookupRouteCandidates(index, entry.parsed, tid));
    // Preserve the resolver's flatten-then-dedupe contract: one candidate can
    // serve two member groups only via a combo listing the same model twice,
    // and the plan must not dial it twice.
    matching = [...new Set(matching)];
    let unmatchedMembers: readonly string[] = [];
    if (combo) {
      const perId = parsedModels.map((entry) => ({
        id: entry.id,
        group: lookupRouteCandidates(index, entry.parsed, tid),
      }));
      unmatchedMembers = perId.filter((entry) => entry.group.length === 0).map((entry) => entry.id);
      const groups = perId.map((entry) => entry.group).filter((g) => g.length > 0);
      if (combo.strategy === "round_robin" && groups.length > 1) {
        const heads = groups.map((g) => g[0] as RouteCandidate);
        const rr = this.getRoundRobin(`${tid}::${resolved.model}`);
        const chosen = rr.next(heads, 1);
        const startIndex = chosen ? heads.indexOf(chosen) : 0;
        matching = [...groups.slice(startIndex), ...groups.slice(0, startIndex)].flat();
      } else {
        matching = groups.flat();
      }
    }
    if (matching.length === 0) {
      // A qualified `provider/model` reference whose model is not in the
      // catalog still routes: clone the provider's first live candidate (any
      // model) and retarget it at the requested model. This is the passthrough
      // contract — a provider that accepts arbitrary model ids (BYOK, custom
      // gateways, or a model the catalog has not fetched yet) must be able to
      // serve them. The clone inherits the provider's endpoint, wire family,
      // dialect, capabilities, tenant scoping and account/network-pool wiring;
      // only the model id changes. A provider with zero candidates cannot be
      // synthesized, so bare-model misses and empty providers still 404.
      if (parsedModels.length === 1 && parsedModels[0]!.parsed.providerId !== null) {
        const providerId = parsedModels[0]!.parsed.providerId;
        const sibling = [...index.qualified.entries()]
          .filter(([key]) => key.startsWith(`${providerId}/`))
          .flatMap(([, group]) => group)
          .find((candidate) => candidate.tenant_id == null || candidate.tenant_id === tid);
        if (sibling !== undefined) {
          matching = [{
            ...sibling,
            model_id: parsedModels[0]!.parsed.modelId,
          }];
        }
      }
      if (matching.length === 0) throw modelNotFoundError(requestedModel, modelIds);
    }
    const owners = [...new Set(matching.map((candidate) => candidate.provider_id))];
    if (owners.length > 1 && !resolved.model.includes("/") && !combo)
      throw ambiguousModelError(requestedModel, owners);
    return { resolved, combo, matching, unmatchedMembers };
  }

  async reserve(plan: RoutePlan): Promise<Reservation> {
    for (const candidate of plan.candidates) {
      const admitted = await this.admission.admit(candidate);
      if (admitted.admitted) return this.reservations.acquire(candidate, plan.revision);
    }
    // Last candidate's identity names the provider the plan was actually for;
    // every candidate shares it, so any one of them is representative.
    const last = plan.candidates[plan.candidates.length - 1];
    throw capacityExhaustedError({
      ...(last?.provider_id !== undefined ? { providerId: last.provider_id } : {}),
      ...(plan.resolved_model !== undefined ? { model: plan.resolved_model } : {}),
      candidateCount: plan.candidates.length,
      ...(last?.max_inflight !== undefined ? { maxInflight: last.max_inflight } : {}),
    });
  }
  async release(reservation: Reservation): Promise<void> {
    await this.admission.release(reservation);
    this.reservations.release(reservation.lease_id);
  }
}
