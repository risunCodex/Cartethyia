// Routing engine planning/admission core.
import { log } from "../../observability/logger";

import {
  accountsRateLimitedError,
  accountsUnavailableError,
  capacityExhaustedError,
  type AdmissionController,
  type RouteCandidate,
  type RoutedCandidate,
  type RoutePlan,
  type Reservation,
  type RouteSnapshot,
  type RoutingDecision,
  ROUTING_RANK,
} from "./route-model";
import { candidateSupportsRequest, type RequiredCapability } from "../../protocol/translation/capabilities";
import { planAllowsCandidate } from "./plan-gate";
import { accountReservePct, routingStickyWarmMs, routingStickyMaxSessions } from "../../config/routing";
import { InMemoryAdmissionController, admissionKey } from "./admission";
import { ReservationManager } from "./reservations";
import { createRoundRobinMap, RoundRobinState, StickySessionStore } from "./round-robin";
import { drainScore, isInReserve } from "./drain-reserve";
import { resolveMatchingCandidates } from "./alias-resolution";
import type { ProviderQuotaResult } from "../../providers/quota/quota-contracts";
import { getCachedQuotaEntries, quotaLens, type CachedQuotaEntry } from "../../providers/quota/cache";
import { readQuotaSnapshots } from "../../providers/quota/snapshot";
import type { ProviderQuotaResultSnapshot } from "../../persistence/schema";
import type { CartethyiaDatabase } from "../../persistence/db-handle";
import type { RedisClient } from "../../persistence/redis";
import { sharedClaudeSlowLanes } from "../../providers/integrations/claude/claude-slow-lane";
import {
  EligibilityEvaluator,
  creditPriority,
  earliestResetMs,
  exhaustedResetMs,
  filterCandidateQuotaWindows,
  hotWindow,
  normalizeQuotaFact,
} from "./candidate-evaluation";
import {
  applyProviderRoutingSorted as applyProviderRoutingSortedPlan,
  resolveProviderRouting as resolveProviderRoutingSetting,
} from "./provider-routing";

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

  /**
   * Stamps one candidate with its provider's usage floor + quota windows (the
   * per-candidate half of the old `applyUsageFloor`).
   */
  private applyUsageFloorToCandidate(
    candidate: RouteCandidate,
    snapshot: RouteSnapshot,
    tenantId: string | null,
    quotaCache: ReadonlyMap<string, CachedQuotaEntry>,
    snapshotMap: ReadonlyMap<string, ProviderQuotaResultSnapshot>,
  ): RouteCandidate {
    const accountId = candidate.provider_account_id;
    if (accountId === undefined) return candidate;
    const setting = resolveProviderRoutingSetting(
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
      // When no cache/snapshot evidence exists, the candidate's own stamped
      // windows ride through `...candidate` untouched — a miss must not erase
      // a stamped value.
      ...(quotaWindows === undefined ? {} : { quota_windows: quotaWindows }),
      ...(quota?.source === "zcode-start" && quota.error === null ? { quota_entitlements_known: true } : {}),
    };
    // Drain urgency and reserve are derived from the same windows the credit
    // ordering already reads. They are ordering preferences, never exclusions:
    // an account in reserve or with a zero drain score stays eligible and
    // routed. `RoutedCandidate` declares these fields mutable, so stamping them
    // directly avoids a second full candidate copy per plan.
    const derivedWindows = quotaWindows ?? candidate.quota_windows;
    if (derivedWindows !== undefined) {
      stamped.drain_score = drainScore(derivedWindows);
      stamped.in_reserve = isInReserve(derivedWindows, accountReservePct());
    }
    stamped.quota_fact = normalizeQuotaFact(stamped, cached, stored);
    return stamped;
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
    decisions: ReadonlyMap<RouteCandidate, RoutingDecision>,
    snapshot: RouteSnapshot,
    tid: string | null,
  ): RouteCandidate[] {
    return applyProviderRoutingSortedPlan(
      eligible,
      decisions,
      snapshot,
      tid,
      (key) => this.getProviderRoundRobin(key),
    );
  }
  private resolveMatchingCandidates(
    requestedModel: string,
    snapshot: RouteSnapshot,
    tid: string | null,
    allowCliMappings: boolean,
    keyId?: string,
  ): {
    resolved: ReturnType<typeof resolveMatchingCandidates>["resolved"];
    combo: ReturnType<typeof resolveMatchingCandidates>["combo"];
    matching: RouteCandidate[];
    unmatchedMembers: readonly string[];
  } {
    return resolveMatchingCandidates(
      requestedModel,
      snapshot,
      tid,
      allowCliMappings,
      keyId,
      (key) => this.getRoundRobin(key),
    );
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
  async plan(
    requestedModel: string,
    snapshot: RouteSnapshot,
    tenantId?: string | null,
    requiredCapabilities?: readonly RequiredCapability[],
    allowCliMappings = false,
    keyId?: string,
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
    const evaluations = matching.map((candidate) => {
      const stamped = this.applyUsageFloorToCandidate(
        candidate,
        snapshot,
        tid,
        quotaCacheByAccount,
        snapshotByAccount,
      );
      return this.evaluateCandidate(stamped, snapshot, tid, requiredCapabilities);
    });
    const decisions = new Map<RouteCandidate, RoutingDecision>();
    for (const evaluation of evaluations) {
      decisions.set(evaluation.candidate, evaluation.decision);
    }
    // Saturation is read once (inflight counters) and merged into the same
    // decision map rather than a second sort pass. The read must run on the
    // *stamped* candidates, because `decisions` is keyed by them: every
    // account-bearing candidate (the only kind carrying a `max_inflight`
    // ceiling) was copied by `applyUsageFloorToCandidate`, so matching against
    // the snapshot's original objects would never find a decision and the
    // merge would be dead. The copies preserve `provider_id`/`model_id`/
    // `provider_account_id`/`owner_tenant_id`, so `admissionKey` resolves to
    // the same bucket admission enforces.
    const saturated = await this.saturatedCandidates(
      evaluations.map((evaluation) => evaluation.candidate),
    );
    for (const candidate of saturated) {
      const existing = decisions.get(candidate);
      if (existing !== undefined) {
        decisions.set(candidate, {
          ...existing,
          eligible: existing.eligible,
          rank: ROUTING_RANK.SATURATED,
          saturated: true,
        });
      }
    }
    let eligible = evaluations
      .map((evaluation) => evaluation.candidate)
      .filter((candidate) => decisions.get(candidate)?.eligible === true);

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
    const stickyExplicit = stickyEntry?.explicit === true;
    // Every key the comparator reads is computed once per candidate. The sort
    // runs O(n log n) comparisons; recomputing reserve/hot/credit/drain inside
    // the comparator re-scanned each candidate's quota windows per comparison.
    const keyed = eligible.map((candidate) => ({
      candidate,
      rank: decisions.get(candidate)?.rank ?? ROUTING_RANK.FRESH_KNOWN,
      sticky: candidate.provider_account_id === stickyAccountId,
      freeTier: candidate.free_tier === true,
      reserve:
        (candidate as RoutedCandidate).in_reserve ??
        isInReserve(candidate.quota_windows, reservePct),
      priority: (candidate as RoutedCandidate).account_priority ?? 0,
      hot: hotWindow(candidate.quota_windows),
      credit: creditPriority(candidate),
      drain: (candidate as RoutedCandidate).drain_score ?? 0,
    }));
    keyed.sort((left, right) => {
      if (left.rank !== right.rank) return left.rank - right.rank;
      // A free-tier model routes to any account: skip every quota-derived
      // preference (credit, reserve, hot-window, drain) so the original order
      // is preserved. Sticky warm pins still apply — they are about prompt
      // cache warmth, not quota.
      // Sticky warm pin: within the warm window the account that last served
      // this session wins outright (explicit pins always win). When neither
      // applies the comparison falls through to the quota preferences.
      if (left.sticky !== right.sticky && (stickyExplicit || stickyWarm)) {
        return left.sticky ? -1 : 1;
      }
      if (left.freeTier && right.freeTier) return 0;
      if (left.reserve !== right.reserve) return left.reserve ? 1 : -1;
      if (left.priority !== right.priority) return right.priority - left.priority;
      if (left.hot !== right.hot) return left.hot ? 1 : -1;
      const credit = right.credit - left.credit;
      if (credit !== 0) return credit;
      if (left.drain !== right.drain) return right.drain - left.drain;
      return 0;
    });
    eligible = keyed.map((entry) => entry.candidate);

    // Provider routing rotates accounts within the same rank group only; it can
    // never float a cooling/saturated account ahead of a fresh one because the
    // rank is the primary key of the sort.
    eligible = this.applyProviderRoutingSorted(eligible, decisions, snapshot, tid);

    const chosen = eligible[0]!;
    // Record which account served this session so a follow-up request within the
    // warm window can prefer it (prompt-cache warmth). Explicit operator pins are
    // recorded as explicit so they win even past the warm window.
    if (sessionId !== undefined && chosen.provider_account_id !== undefined) {
      this.sticky.set(chosen.provider_id, sessionId, chosen.provider_account_id, false);
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
  async release(reservation: Reservation): Promise<void> {
    await this.admission.release(reservation);
    this.reservations.release(reservation.lease_id);
  }
}
