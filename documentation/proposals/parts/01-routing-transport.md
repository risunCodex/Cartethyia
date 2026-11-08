# Audit part — Routing & transport

Status: audited (first pass)
Scope: `src/transport/**`, `src/config/routing.ts`, `src/config/spec.ts`

---

## Findings

### 1. Unified-routing feature flag looks like a stale rollout seam

- **Verdict:** cutover candidate
- **Behavior change?:** yes
- **Severity:** HIGH
- **Effort:** M
- **Evidence:**
  - Flag spec: `src/config/spec.ts:228-235`
  - Reader: `src/config/routing.ts:13-18`
  - Branch in routing: `src/transport/routing/router.ts:185-191`
  - Legacy permissive fallback path: `src/transport/routing/router.ts:788-816`
  - Tests still force the env var on: `test/transport/unified-routing-decision.test.ts:76-89`
- **Current behavior:** the request planner still carries dual behavior. When the
  flag is off, unified quota/plan normalization returns `null` and routing falls
  back to the older permissive path.
- **Why it matters:** this is a broad stale rollout seam in the core planner.
  It keeps two behaviors alive, complicates reasoning, and leaves tests/docs
  split across both modes.
- **Recommended cut:** decide that unified routing is now canonical, then flip or
  remove the flag and delete the fallback path. Treat it as a cutover with docs,
  `.env.example`, and tests updated together.
- **Likely follow-up:** cutover tests + docs/config update.

### 2. `plan()` repeats account-scoped quota/cache work per candidate

- **Verdict:** performance cleanup
- **Behavior change?:** no
- **Severity:** HIGH
- **Effort:** M
- **Evidence:**
  - Snapshot fanout per `(model, account)`: `src/transport/routing/route-catalog.ts:822-873`
  - Candidate loop calls `applyUsageFloorToCandidate()`: `src/transport/routing/router.ts:1009-1013`
  - Per-candidate cache/DB reads inside the helper: `src/transport/routing/router.ts:647-662`
- **Current behavior:** the same account can appear across many candidates, but
  quota cache lookup / quota snapshot fallback work is repeated per candidate.
- **Why it matters:** combo requests or any multi-candidate same-account shape
  pay duplicate Redis/DB work and duplicate quota normalization/filtering.
- **Recommended cut:** memoize the account-scoped quota fetch once per plan, then
  keep model-specific filtering (`filterCandidateQuotaWindows`) as the per-
  candidate step.
- **Likely follow-up:** tests for combos / cache-miss behavior.

### 3. `resolveMatchingCandidates()` duplicates candidate-index lookups for combos

- **Verdict:** simplify
- **Behavior change?:** no
- **Severity:** MED
- **Effort:** S
- **Evidence:**
  - First lookup pass: `src/transport/routing/router.ts:1207-1209`
  - Combo handling recomputes lookups: `src/transport/routing/router.ts:1215-1223`
- **Current behavior:** combo routing computes `matching` once, then re-runs the
  same lookup work per member group.
- **Why it matters:** duplicate lookup/allocation work on the request path.
- **Recommended cut:** compute member groups once and derive both `matching` and
  `unmatchedMembers` from the same structure.
- **Likely follow-up:** combo tests only.

### 4. Pool-routing data looks duplicated; top-level snapshot `poolRouting` may be obsolete

- **Verdict:** internal contract cleanup
- **Behavior change?:** no
- **Severity:** MED
- **Effort:** S/M
- **Evidence:**
  - Top-level snapshot field: `src/transport/routing/route-model.ts:350-352`
  - Snapshot builder preserves it: `src/transport/routing/route-model.ts:759-763`
  - Per-candidate `network_pool_routing` is already stamped by route-catalog:
    `src/transport/routing/route-catalog.ts:532-536`,
    `src/transport/routing/route-catalog.ts:646-652`,
    `src/transport/routing/route-catalog.ts:737-738`,
    `src/transport/routing/route-catalog.ts:778`,
    `src/transport/routing/route-catalog.ts:812`,
    `src/transport/routing/route-catalog.ts:869`,
    `src/transport/routing/route-catalog.ts:998`
  - Dispatch reads the candidate-stamped field: `src/transport/dispatch/leases.ts:106-137`
- **Current behavior:** pool-routing state appears both at top-level snapshot and
  per candidate, while dispatch reads the per-candidate field.
- **Why it matters:** likely leftover duplication after a cutover; two sources of
  truth for one concept.
- **Recommended cut:** verify all snapshot consumers, then prune one
  representation (likely the top-level field if unused).
- **Likely follow-up:** snapshot consumer audit + tests.

### 5. Hot-path config reads still parse env live in request planning

- **Verdict:** small performance/clarity cleanup
- **Behavior change?:** maybe if tests rely on live env mutation
- **Severity:** LOW/MED
- **Effort:** S
- **Evidence:**
  - Thin env readers: `src/config/routing.ts:13-41`
  - `unifiedRoutingDecisionEnabled()` from per-candidate path:
    `src/transport/routing/router.ts:185-191`
  - `accountReservePct()` from candidate stamping:
    `src/transport/routing/router.ts:689-694`
  - `plan()` rereads reserve/sticky values per request:
    `src/transport/routing/router.ts:1085-1089`
- **Current behavior:** immutable routing knobs are parsed from `process.env`
  repeatedly on the request path, and some checks can happen per candidate.
- **Why it matters:** each read is cheap, but this is the core path; repeated
  parsing makes the code noisier and keeps live-env semantics where they likely
  are not needed.
- **Recommended cut:** centralize immutable knobs once per process or once per
  plan; keep tests honest if they currently rely on mid-process env mutation.
- **Likely follow-up:** maybe test touch only.

### 6. `sticky_account_id` on candidates is dead after the sticky-store cutover

- **Verdict:** dead-field cleanup
- **Behavior change?:** no
- **Severity:** LOW
- **Effort:** S
- **Evidence:**
  - Declaration only: `src/transport/routing/route-model.ts:173`
  - Active sticky logic uses `StickySessionStore` in `src/transport/routing/router.ts:1087-1105` and `:1136-1138`
- **Current behavior:** no repo consumer/read of `sticky_account_id` was found;
  live sticky behavior is entirely router-local via the in-memory sticky store.
- **Why it matters:** stale post-cutover field.
- **Recommended cut:** remove the field and its typing/test noise.
- **Likely follow-up:** tests only.

### 7. Snapshot rebuild appears coupled too broadly to provider-catalog refresh

- **Verdict:** rebuild-path performance cleanup
- **Behavior change?:** no
- **Severity:** HIGH
- **Effort:** M
- **Evidence:**
  - Every snapshot build refreshes active provider catalogs first:
    `src/boot/dependencies.ts:261-267`
  - Builder then loads the route catalog snapshot:
    `src/transport/routing/route-catalog.ts:1004-1013`
  - But invalidation is triggered by many non-catalog events too, e.g.:
    `src/network/pool-health-machine.ts:175`
    `src/providers/operations/account-health-service.ts:775`
    `src/providers/operations/account-health-service.ts:785`
- **Current behavior:** a pool-health or account-health invalidation appears to
  pay the same active-provider-catalog refresh prelude as real provider/model
  catalog mutations.
- **Why it matters:** rebuild work looks over-coupled to invalidate reason.
- **Recommended cut:** split “snapshot rebuild” from “active provider catalog
  refresh” behind a narrower invalidation reason or separate builder entrypoint.
- **Likely follow-up:** tests only unless refresh has hidden side effects.

### 8. Top-level `RouteSnapshot.poolRouting` looks fully dead inside the repo

- **Verdict:** internal contract cleanup
- **Behavior change?:** no
- **Severity:** MED
- **Effort:** S
- **Evidence:**
  - Field declaration: `src/transport/routing/route-model.ts:352`
  - Snapshot copy: `src/transport/routing/route-model.ts:760-762`
  - Catalog builds/returns it: `src/transport/routing/route-catalog.ts:532-536`, `:646-652`, `:998`
  - No repo read found outside those build/copy sites
- **Current behavior:** top-level `poolRouting` is carried through snapshot build,
  but dispatch reads candidate-level `network_pool_routing` instead.
- **Why it matters:** dead duplicated representation.
- **Recommended cut:** remove after a quick external-consumer check.
- **Likely follow-up:** snapshot tests only.

### 9. Snapshot rebuild duplicates object-copy / freeze work after catalog materialization

- **Verdict:** rebuild-path simplification
- **Behavior change?:** no
- **Severity:** MED
- **Effort:** S/M
- **Evidence:**
  - Catalog constructs `providerRouting` / `poolRouting` maps:
    `src/transport/routing/route-catalog.ts:543-559`, `:532-536`
  - Snapshot build re-walks/clones them and shallow-copies candidates/aliases/combos:
    `src/transport/routing/route-model.ts:735-764`
- **Current behavior:** every snapshot regeneration pays duplicate traversal,
  copying, and freezing work after catalog already materialized the structures.
- **Why it matters:** lower priority than request-path work, but still avoidable
  rebuild-path allocation/traversal cost.
- **Recommended cut:** simplify after `poolRouting` removal and/or push more
  normalization earlier into catalog build.
- **Likely follow-up:** snapshot tests only.

### 10. Candidate index still allocates filtered arrays per lookup

- **Verdict:** optional micro-optimization
- **Behavior change?:** no
- **Severity:** LOW
- **Effort:** S/M
- **Evidence:**
  - Index stores global qualified/bare buckets: `src/transport/routing/candidate-index.ts:27-63`
  - Each lookup allocates via `group.filter(...)`: `src/transport/routing/candidate-index.ts:75-87`
- **Current behavior:** even the indexed path still allocates a fresh array per
  model lookup.
- **Why it matters:** smaller than the duplicate combo lookup issue, but means
  the “indexed” path is not allocation-free yet.
- **Recommended cut:** only touch if combo/alias traffic proves hot enough to
  matter; otherwise keep for simplicity.
- **Likely follow-up:** optional only.

---

## Safe-first vs cutover-later notes

### Safe-first

- Memoize account-scoped quota/cache reads once per plan
- Collapse duplicate combo lookups
- Decouple snapshot rebuild from provider-catalog refresh
- Remove dead `sticky_account_id`
- Remove dead top-level `poolRouting` after external-consumer check
- Hoist immutable hot-path config reads

### Cutover-later

- Unified-routing flag removal itself is localized, but the *semantic* cutover is
  accepting stricter canonical behavior for:
  - proactive exclusion of exhausted / below-floor candidates
  - plan-gate exclusion
  - explicit `quota_unknown` demotion
- Safe rollout shape:
  1. default the flag on everywhere,
  2. keep a temporary escape hatch,
  3. remove test env toggling last,
  4. then delete the legacy fallback path.

---

## Recommended execution order

1. Memoize account-scoped quota/cache work per plan
2. Collapse duplicate combo lookups
3. Decouple snapshot rebuild from provider-catalog refresh
4. Prune dead `poolRouting` representation
5. Hoist immutable hot-path config reads
6. Remove dead `sticky_account_id`
7. Decide and execute the unified-routing cutover

---

## Execution status

- ⛔ Audit only; no implementation yet.
