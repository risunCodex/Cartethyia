# Audit — Transport routing, selection, quota-aware admission, route snapshots (05)

Status: **audit only — no implementation yet** (see Execution status).
Scope: `src/transport/routing/**` (router, route-catalog, route-model, admission,
reservations, candidate-index, drain-reserve, round-robin, bounded-lru, plan-gate)
and its direct consumers/tests. No source, test, config, or git state was modified.

---

## 1. Scope and method

Read-only deep audit of the routing layer for bloat, duplication, unnecessary
work/latency, and maintenance complexity, with an explicit focus on memory/state
integrity and valid fallback behavior. Method: CodeGraph symbol/call-path mapping
first (`codegraph_explore`), then `Read`/`Grep` of the actual source and tests.
No code was changed; the only artifact produced is this report.

**Area coverage — verified, with evidence**

| Area | Where | Verified behavior |
| --- | --- | --- |
| Model resolution + combo/alias walk | `src/transport/routing/router.ts` `resolveMatchingCandidates` (1163–1264), `candidate-index.ts` | Index built once per immutable snapshot (`WeakMap` cache) and reused; lookup is one `Map.get` per resolved model. No obvious bloat. |
| Eligibility evaluator | `router.ts` `EligibilityEvaluator` (475–507) | Single shared evaluator used by `plan()` and continuation affinity. See Finding 1 for an unused method on it. |
| Quota-aware admission | `router.ts` `applyUsageFloorToCandidate` (638–701), `admission.ts`, `drain-reserve.ts` | Live-cache-wins, snapshot-fallback, then candidate-stamped windows. See Finding 4 (per-candidate round trips). |
| Route snapshot service | `route-model.ts` `InMemoryRouteSnapshotService` (615–760) | Revision-tagged in-flight build prevents lost mutations; debounced background rebuild; peer invalidation via pub/sub with origin echo-ignore. Sound state integrity. |
| Pool-account / credential-less candidate fan-out | `route-catalog.ts` `loadRouteCatalogSnapshot` (419–1000) | See Finding 3 (repeated candidate construction). |
| Plan ordering + rotation | `router.ts` `plan` (951–1151), `applyProviderRoutingSorted` (827–862), `round-robin.ts` | See Finding 2 (soft-cooldown rank) — empirically confirmed, not just read. |
| Reservation leases | `reservations.ts` `ReservationManager` | Expiry min-heap; stale-node compaction; live leases never capped; admission counters are the real gate. No integrity issue found. |

**Excluded / unverified suspects (explicitly not findings)**

- `EligibilityEvaluator.filter` (router.ts:501–506) — see Finding 1.
- `route-catalog.ts` `resolveNetworkPools`/`resolveMaxInflight`/etc. recompute per
  account during a snapshot build. This is real redundant work, but it runs on a
  debounced background rebuild (not the request path), the per-account results are
  cheap, and memoizing across the candidate loop would introduce a per-build cache
  whose invalidation boundary is tricky (a mutation mid-build). Left as an
  unverified/low-value suspect; the request-path finding (Finding 4) is the
  meaningful latency one.
- `ReservationManager.get` and `StickySessionStore.clear` are used only by tests
  (public seams, not dead code). Left alone.
- A duplicated verbatim comment block at router.ts:969–995 (continuation-affinity
  rationale appears twice, one copy stale: "Combo expansion … one level" text does
  not match the code's recursive `expandMember`). Documentation-only; listed in
  Finding 5 context, not its own finding.
- `config/routing.ts` knobs (reserve pct, sticky warm ms, max sessions) are read
  live per plan and not duplicated.

---

## 2. Findings

### Finding 1 — Unused `EligibilityEvaluator.filter` method

| | |
| --- | --- |
| Verdict | **CONFIRMED** dead code |
| Severity / Effort | LOW / S |
| Behavior change | none (pure removal) |
| Location | `src/transport/routing/router.ts:501–506` |

**Evidence.** `EligibilityEvaluator` exports a `filter(candidates)` method that
maps evaluate → filters eligible → maps back to candidate. Grep across
`src/**` and `test/**` finds the definition only; the only call sites of the
evaluator are `this.eligibility.evaluate(...)` (router.ts:714, `903) and tests
that call `.evaluate(...)` (`test/transport/quota-candidate-filter.test.ts:85`,
`test/transport/slow-lane-routing.test.ts:28–72`, `test/providers/commandcode-quota.test.ts:232`,
`test/providers/zcode-start-plan.test.ts:44`). CodeGraph's call graph confirms no
incoming edge to `filter`. No test exercises it, and `plan()` builds its own
eligible set from the decision map (router.ts:1037–1039), so the method is
unreachable production code.

**Mechanism.** The method is a thin convenience wrapper (6 lines) whose contract
(candidate-level eligibility) is already owned by `evaluate` + the `decisions`
map. It duplicates the map/filter/map shape that `plan()` does explicitly with
`admissionKey` decisions.

**Proposal.** Delete `filter` (lines 501–506). Owner: `router.ts`. If an
eligibility-filter API is ever wanted, expose `evaluate` (already public) and let
callers filter on `decision.eligible`. No imports or tests change.

**State / fallback analysis.** No state touched; no fallback path references it.
No behavior change.

**Verification.** `bun run scripts/test/run.ts --scope backend` + `tsc --noEmit`
after deletion; grep for `EligibilityEvaluator().filter` / `eligibility.filter` to
confirm no lingering references.

---

### Finding 2 — Soft-cooldown candidates are not deprioritized (ordering contract broken)

| | |
| --- | --- |
| Verdict | **CONFIRMED** behavioral defect |
| Severity / Effort | MED / M |
| Behavior change | yes (fixes ordering; see details) |
| Location | `src/transport/routing/router.ts:475–499` (evaluate), `1037–1128` (plan/sort); docs: router.ts:400–421 |

**Evidence.** The evaluator's contract comment (router.ts:400–421) states a cooling
(deprioritized) account "orders behind every healthy one" and the hard exclusion is
only for `cooldown_kind === "hard"`. But `evaluate` (router.ts:481–482) only
excludes when `health_status === "cooldown" && cooldown_kind === "hard"` — a
**soft** cooldown (all transient rate-limit categories; the default) falls through
to the `return { eligible: true, reason: "cooldown" ... }` branch (line 496–497),
which produces an **eligible** candidate with no rank classification. The rank
default in `evaluateCandidate` (router.ts:714–733) only lands on `COOLING` (3)
when `reason === "model_cooldown" || "cooldown_hard"`; a soft `"cooldown"` reason
skips that and reaches the quota-fact branch, which classifies it as
`FRESH_KNOWN` (0) or `FRESH_UNKNOWN` (1). I confirmed empirically with a scratch
script (temp, outside repo):

- `evaluate(soft)` → `{ eligible: true, reason: "cooldown" }` (not rank-tagged),
- `plan([soft, healthy])` with soft listed first → order `[soft, healthy]` —
  the cooling candidate is served ahead of the healthy sibling,
- `plan([softWithCredit, healthyUnknown])` → soft is `rank 0 / reason healthy`
  and wins, despite being in an active cooldown,
- all-soft set → serves the cooling account (the 429 blanket only fires when
  `healthyCount === 0` *after* filtering eligible, and soft candidates are
  eligible).

This is exactly the operator-reported failure the code comment says was fixed
("cooldown blocks the account completely" / "still hit a cooled-down account,
never failed over") — the fix only works for `cooldown_kind: "hard"`, while the
runtime stamp (`route-catalog.ts:909–921`) produces `"soft"` for every
non-`quota_exhausted`/non-`auth_invalidated` category (the majority of upstream
429s). The deprioritization is effectively neutralized in the plan sort.

**Mechanism.** Rank is the primary sort key (router.ts:1093–1096), and rotation
(`applyProviderRoutingSorted`) cannot float a cooling candidate ahead of a fresh
one *when the rank is actually COOLING*. Because soft cooldowns never receive rank
3, the "healthy-first" invariant the comment describes is not enforced for them.

**Proposal.** In `evaluate`/`evaluateCandidate`, classify a soft cooldown as rank
`COOLING` (eligible, but sorted after fresh/unknown) while keeping it eligible so a
single-account deployment still routes — the documented intent. Bounded change in
`evaluateCandidate` (router.ts:717–720): extend the rank branch to
`reason === "cooldown"` → `ROUTING_RANK.COOLING`, with the `cooldown_until`
deadline preserved. The 429 end-state logic (healthyCount == 0) must be re-checked:
with soft cooling at COOLING, an all-soft set becomes `healthyCount === 0` → 429
with the real reset (arguably the correct behavior for "every account is cooling"),
but this needs a deliberate decision, not an incidental one. Keep the evaluator's
raw `reason` values unchanged so `ELIGIBILITY_REASON_LABELS` and the envelope
`reasons` stream stay intact.

**State / fallback risk.** No persisted state touched. The only fallback change is
ordering + the all-soft 429 boundary. For single-account providers, an all-soft
set must still serve (do not let the healthyCount gate 429 a sole account that has
no sibling to fail over to — verify the `eligible.length === 0` vs `healthyCount ===
0` branches separately).

**Verification.** Add/extend planner tests: soft-cooldown candidate listed first
still loses to a healthy sibling; soft-with-credit loses to healthy-unknown; a
single soft-cooling account still routes (or, if 429 is chosen, asserts the reset
deadline is carried). Note: the `drain-reserve-routing.test.ts` and
`credit-priority-routing.test.ts` suites assert ordering *within* a rank and do
not currently cover soft-cooldown versus healthy siblings — the fix must not rely
on a test that silently passes either way.

---

### Finding 3 — Candidate construction duplicated across four near-identical literals in `route-catalog.ts`

| | |
| --- | --- |
| Verdict | **CONFIRMED** structural duplication |
| Severity / Effort | MED / M |
| Behavior change | none if refactor is mechanical; risk noted |
| Location | `src/transport/routing/route-catalog.ts:719–750` (pool-account), `760–783` (configured-pool tenant), `790–816` (base public), `834–873` (account) |

**Evidence.** Four `RoutedCandidate` object literals repeat the same field
spread — `provider_id`, `model_id`, `wire_family`, `dialect?`, `service_kind`,
`endpoint`, `output_limit?`, `capability_profile`, `tenant_id`, `free_tier?`,
`owner_tenant_id`, `requires_account`, and the `network_pool_*` block (ids/required/
limits/weights/routing + `providerLimitFor`) — with only three differences:
(1) pool-account candidate carries `network_pool_ids: [poolId]` and health stamping
from the pool-account row; (2) configured-pool tenant carries all pool ids and no
health stamp; (3) account candidate adds `provider_account_id`/`owner_tenant_id`/
`pro_only`/`account_plan`/`max_inflight` and health stamping done after literal
construction.

**Mechanism.** Each literal re-declares the same ~15-field shape; a field added to
one (e.g. a future per-candidate flag) must be added to all four, and the pool
block logic is duplicated word-for-word. This is the classic drift risk the repo
explicitly warns against (AGENTS.md "one canonical owner").

**Proposal.** Extract a single `buildCandidateBase(model, capabilityProfile, opts)`
helper returning the shared field set, with `opts` for the deltas (poolIds,
healthStamp, accountId, plan, maxInflight, userAgent). Keep each site's
behavior-visible differences explicit as options; do not merge the health-stamping
branches' semantics. Owner: `route-catalog.ts`.

**State / fallback risk.** The four literals are not behavior-identical: pool-account
candidate health (disabled/cooldown from pool-account status) vs configured-pool
tenant (no health) vs public (health `"disabled"` only when providerRequiresAccount)
vs account (health stamped after). A naive merge that treats them as identical
would change routing. The refactor must preserve each branch exactly, and the
pool-account test suite (`test/transport/route-catalog-pool-accounts.test.ts`,
`test/transport/pool-egress-failover.test.ts`) must pass unchanged.

**Verification.** Run `test/transport/route-catalog-pool-accounts.test.ts`,
`test/transport/pool-egress-failover.test.ts`, `test/transport/route-capability-modality.test.ts`,
and the full backend scope after the mechanical extract; diff the emitted candidate
salient fields (model/wire/pool/health/account) before/after on a fixture.

---

### Finding 4 — Per-candidate quota reads on the request path are serial round trips; batch reads exist but are unused here

| | |
| --- | --- |
| Verdict | **CONFIRMED** unnecessary latency (request path) |
| Severity / Effort | MED / M |
| Behavior change | none (read-only optimization) |
| Location | `src/transport/routing/router.ts:638–701` (`applyUsageFloorToCandidate`), called from `plan` at 1012–1017; batch APIs at `src/providers/quota/cache.ts:148` (`getCachedQuotaEntries`), `src/providers/quota/snapshot.ts:74` (`readQuotaSnapshots`) |

**Evidence.** `plan()` evaluates `matching` candidates with
`Promise.all(matching.map(applyUsageFloorToCandidate))`. Each call does, per
candidate: `getCachedQuotaEntry(quotaLens(...), accountId, redis)` (a Redis GET
when the in-memory tier misses — quota cache line 119–140) and, on cache miss with
a DB handle, `readQuotaSnapshot(db, accountId)` (a Postgres SELECT — snapshot.ts
line 57–71). For a model served by N accounts, the plan path issues up to N Redis
round trips (plus N Postgres reads on a cold cache) per request, and the same
account can be read multiple times when combo members fan out to several candidates
on one account. The codebase already ships the batch equivalents —
`getCachedQuotaEntries` (one MGET per lens, chunked 256) and `readQuotaSnapshots`
(one `inArray` query for all ids) — which the quota overview uses but the router
does not.

**Mechanism.** The per-candidate reads are independent (their results feed
`normalizeQuotaFact` per candidate) and the live-cache-wins / snapshot-fallback /
stamped-windows precedence is per candidate, so the reads can be coalesced by lens
and by account without changing any decision. The current `Promise.all` makes the
serial *dependency* small but not the *count* of round trips.

**Proposal.** In `plan()`, before the evaluation pass, group `matching` by
`quotaLens(candidate.tenant_id ?? tid)`, call `getCachedQuotaEntries` per lens and
`readQuotaSnapshots` for the missing accounts, and pass the two result maps into a
synchronous candidate-stamping step that preserves exact current precedence
(cache entry with quota wins; then snapshot; then candidate-stamped windows).
Behavior-neutral reads; no state written.

**State / fallback risk.** Read-only. Must preserve: `fetchedAt` freshness input to
`normalizeQuotaFact`, the `zcode-start` entitlement flag, `drain_score`/
`in_reserve` stamping, and the "cache error ≠ snapshot fallback" semantics (the
snapshot is only consulted when the cache has no quota, exactly as today).
Redis error tolerance must match the per-key path (both return null/empty on error,
never throw).

**Verification.** `test/transport/quota-snapshot-fallback-routing.test.ts` (cold
cache → snapshot; warm cache wins), `test/transport/unified-routing-decision.test.ts`
(stale/quota classification), `test/transport/credit-priority-routing.test.ts`, and
`test/transport/quota-candidate-filter.test.ts`. Add a unit asserting the plan path
issues one MGET per lens rather than N GETs (mirror the fake-Redis command-count
pattern in `test/transport/routing-admission.test.ts`).

---

### Finding 5 — Free-plan detection duplicated across `plan-gate.ts` and `account-tier.ts` (single-owner violation)

| | |
| --- | --- |
| Verdict | **CONFIRMED** duplicated policy logic |
| Severity / Effort | LOW / S |
| Behavior change | none (identical semantics) |
| Location | `src/transport/routing/plan-gate.ts:20–27` (`FREE_PLAN_MARKERS`, `isFreePlanAccount`); `src/providers/operations/account-tier.ts:40–45` (`mapPlanToTier` free branch) |

**Evidence.** `isFreePlanAccount` (plan-gate.ts:22–27) does
`plan.trim().toLowerCase()` then `.some(marker => normalized.includes(marker))`
with `FREE_PLAN_MARKERS = ["free"]`. `mapPlanToTier` (account-tier.ts:40–45) does
`(plan ?? "").trim().toLowerCase()` then `if (lower.includes("free")) return "free"`.
Same normalization, same substring test, same contract ("free is only claimed when
the string proves it"). The comment in account-tier.ts:9–10 and 43–44 explicitly
says "the same marker set the routing plan-gate uses, so the two cannot disagree
about an account" — yet they are two independent implementations with no shared
source, so they *can* drift (e.g. one adds a marker, or normalization diverges).
Tests lock each side separately (`test/transport/plan-gate.test.ts`,
`test/providers/account-tier.test.ts`), which would not catch a divergence.

**Mechanism.** Two owners for one predicate. The plan gate consumes
`candidate.account_plan`; the health/cooldown service consumes
`provider_accounts.quota_plan` via `mapPlanToTier` (account-health-service.ts:243–246).
Both decide "is this a free plan" and both feed routing-adjacent behavior.

**Proposal.** Have `mapPlanToTier` call `isFreePlanAccount(plan)` for its free
branch (import from `plan-gate`), or extract a shared `isFreePlanString`
into a neutral module (e.g. `src/providers/quota` or a shared `plan` util) used by
both. Keep the marker list in exactly one place.

**State / fallback risk.** Pure function; no state. The only risk is a semantics
mismatch if the shared helper is given different normalization — the current two
implementations are byte-identical in behavior, so delegating is safe. Verify the
empty-string/null path: `isFreePlanAccount` returns false for null/undefined/empty;
`mapPlanToTier` returns null for empty/null — consistent.

**Verification.** Both existing suites (`plan-gate.test.ts`, `account-tier.test.ts`)
pass unchanged after delegation; add one cross-test if desired.

---

## 3. State / fallback analysis (cross-cutting)

The user asked specifically whether consolidation risks losing or corrupting
caches, persisted state, session/continuation state, quota snapshots, routing
snapshots, credentials, or telemetry. Reviewed for each finding:

- **Route snapshot (`InMemoryRouteSnapshotService`)** — revision-tagged in-flight
  build + debounced rebuild + peer invalidation with origin echo-ignore is sound;
  none of the findings touch it. Finding 3 changes only how candidate objects are
  constructed inside one build, not snapshot identity or mutability
  (`deepFreeze` preserved).
- **Quota cache / snapshot** — Finding 4 is read-only and preserves live-cache-wins
  precedence, `fetchedAt` freshness, and the snapshot fallback only on cache-miss.
  It does not touch `setCachedQuota`/debit/invalidate paths.
- **Continuation affinity / session stickiness** — unchanged. Finding 2's rank
  change affects only healthy-vs-cooling order, never the hard pin
  (`resolveContinuationPlan`) or `sticky` writes.
- **Admission counters (in-memory + Redis TTL)** — unchanged. Findings 1–5 do not
  alter `admissionKey`, the Lua scripts, or release idempotency.
- **Fallback semantics** — the only fallback-path change is Finding 2's all-soft
  429 boundary, which must be decided deliberately and covered by a new test
  (single-account vs multi-account). Findings 1/3/4/5 have no fallback change.

No finding proposes loosening a guard, widening a type, or suppressing an error.

---

## 4. Validation

- **Read**: `router.ts`, `route-model.ts`, `candidate-index.ts`, `reservations.ts`,
  `drain-reserve.ts`, `round-robin.ts`, `plan-gate.ts`, `route-catalog.ts`,
  `admission.ts`, `src/config/routing.ts`, `src/persistence/tenant-scope.ts`,
  `src/persistence/shared-cache.ts`, `src/providers/quota/cache.ts`,
  `src/providers/quota/snapshot.ts`, `src/providers/quota/quota-contracts.ts`,
  `src/providers/operations/account-tier.ts`, `src/providers/operations/account-health-service.ts`,
  `src/transport/request/preparer.ts` (plan call sites), `src/transport/dispatch/leases.ts`,
  `src/boot/dependencies.ts`.
- **Tests read**: `test/transport/drain-reserve-routing.test.ts`,
  `test/transport/credit-priority-routing.test.ts`, `test/transport/unified-routing-decision.test.ts`,
  `test/transport/quota-snapshot-fallback-routing.test.ts`, `test/transport/route-catalog-pool-accounts.test.ts`,
  `test/transport/pool-egress-failover.test.ts`, `test/transport/routing-admission.test.ts`,
  `test/transport/reservations.test.ts`, `test/transport/plan-gate.test.ts`,
  `test/providers/account-tier.test.ts`, `test/transport/routing-defaults.test.ts`,
  `test/transport/routing-import-boundary.test.ts`.
- **Runtime proof (scratch, not repo)**: soft-cooldown rank behavior exercised
  against the real `RoutingEngine`; results cited in Finding 2.
- **Not executed**: backend test suite (audit-only; no code changed). The
  verification column in each finding names the exact suite to run if the change is
  adopted.

---

## 5. Open questions

1. **Soft-cooldown all-soft 429** (Finding 2): should an all-soft-cooling set
   answer 429 with the earliest reset (consistent with the all-hard behavior), or
   keep serving the cooling account so a sole-account provider never sees a 429
   it could have served? The current code serves; the documented intent ("cooling
   is deprioritized, not excluded") leans toward 429 when a healthy/slow sibling
   exists and serve-when-alone. Needs an owner decision.
2. **Finding 3** — is a shared builder worth the churn given the snapshot build is
   background/debounced? The maintenance payoff (single field-set owner) is real
   but the behavior-change risk is nonzero; recommend only if the mechanical
   extract lands with the pool-account tests untouched.
3. **Finding 4** — should the batch read also be applied to the *sweep*/refresh
   path, or only the request path? The sweep already uses per-lens `targetLens`;
   out of scope here.

---

## 6. Execution status

**Execute — implementation complete (2026-11-09).** See the Per-finding
execution status below. Verified against the full backend suite (4735 pass /
1 skip / 0 fail) and `tsc --noEmit` (zero errors in scope).

- **Finding 1 (M-13) — ✅.** Unused `EligibilityEvaluator.filter` deleted;
  no callers anywhere in `src/**` or `test/**`.
- **Finding 2 (M-14) — ✅.** Soft-cooldown candidates now rank `COOLING`
  in `evaluateCandidate` (after the plan-gate/capability checks, before quota
  classification); reason stays `"cooldown"`, `ELIGIBILITY_REASON_LABELS`
  untouched. All-soft set hits the existing `healthyCount === 0` → 429 with
  `earliestResetMs`. New tests: soft-loses-to-healthy, soft-with-credit-loses,
  all-soft-429-with-reset, single-healthy-still-routes.
- **Finding 3 (M-15) — ✅.** `buildCandidateBase` extracted in
  `loadRouteCatalogSnapshot`; all four literals rewritten to call it. Health
  stamping preserved per-branch.
- **Finding 4 — retained (not executed).** Per-candidate serial quota reads on
  the request path (batched reads exist but unused): a latency optimization, not
  a duplication cleanup; deferred (needs benchmark, per operator).
- **Finding 5 (M-17) — ✅.** `FREE_PLAN_MARKERS` exported from `plan-gate.ts`
  and consumed by `mapPlanToTier` in `account-tier.ts`; empty/null behavior
  preserved.
