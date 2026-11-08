# Audit part — Provider health & quota

Status: audited (first pass)
Scope: `src/providers/**` with focus on operations, health, classification, quota refresh

---

## Findings

### 1. `autoDisableRateLimitedEnabled()` scans `console_settings` on a hot failure path

- **Verdict:** cleanup + performance fix
- **Behavior change?:** no
- **Severity:** HIGH
- **Effort:** S/M
- **Evidence:**
  - `src/providers/operations/account-health-service.ts:45-63`
  - `src/providers/operations/account-health-service.ts:197-208`
- **Current behavior:** qualifying upstream quota/rate-limit failures can trigger
  a full `SELECT tenantId, preferences FROM console_settings`, then a JS
  `rows.some(...)` check inside `recordAccountFailure()`.
- **Why it matters:** this is on the attempt-outcome path, not an admin-only
  path. It loads more rows than needed and pays the cost repeatedly under
  failure waves.
- **Recommended cut:** push the tenant predicate into SQL and answer with
  `EXISTS` / `LIMIT 1`; preserve the `tenantId === null` "any tenant enabled"
  semantics without materializing the full table. Consider a short-lived
  per-tenant cache if the setting is stable.
- **Likely follow-up:** tests only.

### 2. Account error classification is overgrown and highly order-sensitive

- **Verdict:** refactor / cutover to smaller rule ownership
- **Behavior change?:** maybe (must preserve current verdict matrix)
- **Severity:** HIGH
- **Effort:** M/L
- **Evidence:**
  - Narrow branch: `src/providers/operations/account-error-classification.ts:968-982`
  - Broader overlapping branch: `src/providers/operations/account-error-classification.ts:985-1026`
- **Current behavior:** provider-specific wording such as the Buddy frequency
  window must stay before the broader `quotaSignal` branch or it is swallowed.
  The file itself documents the overlap.
- **Why it matters:** behavior is fragile and easy to regress because the same
  wording family is matched by multiple branches with different outcomes.
- **Recommended cut:** split provider-family rules into named ordered helpers or
  small per-family rule tables; keep one shared layer only for genuinely shared
  signals.
- **Likely follow-up:** golden classification fixtures; maybe docs for the rule
  matrix.

### 3. Compatibility-profile contract is only partially cut over

- **Verdict:** contract cleanup / complete the cutover
- **Behavior change?:** maybe
- **Severity:** HIGH
- **Effort:** M
- **Evidence:**
  - Runtime/interface shape: `src/providers/provider-metadata.ts:6-42`
  - Route schema subset only: `src/console/providers/catalog/routes.ts:31-54`
  - Validator handles `service_kinds`: `src/console/providers/catalog/contracts.ts:189-206`
  - Seed path persists compatibility JSON: `src/providers/operations/provider-catalog-service.ts:85-118`
- **Current behavior:** `CompatibilityProfile` includes fields such as
  `preferNativeFetch` and `service_kinds`, but the public route schema omits
  them while validation/runtime still know about at least part of that shape.
- **Why it matters:** this is a stale compatibility surface: persisted/runtime
  shape > API shape. It confuses operator-facing contract boundaries.
- **Recommended cut:** decide whether these fields are public operator-facing
  contract or internal-only. Then either expose them cleanly through schema +
  DTOs, or cut them from the public compatibility profile and relocate them.
- **Likely follow-up:** contract tests and docs; possible migration if already
  persisted keys need cleanup.

### 4. Account-health list/purge paths do an avoidable auth pre-read

- **Verdict:** simplify
- **Behavior change?:** no
- **Severity:** MED
- **Effort:** S/M
- **Evidence:**
  - Wrapper pre-read: `src/console/providers/catalog/store.ts:1597-1615`
  - Wrapper pre-read: `src/console/providers/catalog/store.ts:1617-1635`
  - Actual list/delete helpers: `src/providers/operations/account-health-service.ts:788-800`
  - Actual delete helper: `src/providers/operations/account-health-service.ts:834-842`
- **Current behavior:** list and purge are two-step DB flows — first resolve
  account ownership, then query/delete health rows by account id.
- **Why it matters:** correct but not minimal; duplicates auth plumbing and pays
  an extra round trip.
- **Recommended cut:** fold ownership into one joined query/delete, or
  centralize owned-account resolution in one helper that is reused exactly once.
- **Likely follow-up:** tests only.

### 5. Deprecated `policy_blocked` is a stale compatibility category

- **Verdict:** cleanup with explicit migration/read-time mapping
- **Behavior change?:** maybe for historical rows only
- **Severity:** MED
- **Effort:** M
- **Evidence:**
  - Deprecated union member: `src/providers/operations/account-error-classification.ts:189-194`
  - Active operational path only treats `policy_blocked_banned` specially:
    `src/console/providers/catalog/store.ts:1741-1781`
- **Current behavior:** legacy `policy_blocked` survives in types/rendering for
  historical rows, while active logic has already cut over to the split ban vs
  invalid-request categories.
- **Why it matters:** ambiguous stale state in the domain model.
- **Recommended cut:** migrate or map legacy rows explicitly, then remove the
  legacy category from active operational logic/types.
- **Likely follow-up:** migration, tests, maybe docs.

### 6. Cooldown rules duplicate alias providers instead of normalizing once

- **Verdict:** simplification
- **Behavior change?:** no
- **Severity:** LOW/MED
- **Effort:** S
- **Evidence:**
  - `src/providers/operations/cooldown-rules.ts:31-49`
- **Current behavior:** `trae` and `traecn` carry duplicated rule branches even
  though the comment names them as the same upstream product.
- **Why it matters:** small now, but this pattern spreads family drift over
  time.
- **Recommended cut:** normalize aliases before rule lookup, or resolve through
  a canonical provider-family key.
- **Likely follow-up:** tests only.

### 7. Quota refresh mutates routing-visible account state without using the invalidator seam

- **Verdict:** correctness cleanup
- **Behavior change?:** maybe (snapshot freshness improves)
- **Severity:** HIGH
- **Effort:** M
- **Evidence:**
  - `src/providers/quota/refresh.ts:58-72`
  - `src/console/quota/account-quota-shared.ts:50-58`
  - `src/providers/quota/refresh.ts:155-207`
  - `src/providers/quota/refresh.ts:236-247`
  - `src/providers/operations/account-health-service.ts:712-765`
- **Current behavior:** `QuotaRefreshDeps` carries `snapshotInvalidator`, but
  the quota refresh path never uses it even when `recordAccountCheck()` heals or
  parks an account, and `applyAccountVerdict()` can also change routing-visible
  state.
- **Why it matters:** route snapshots can stay stale until some unrelated
  invalidation happens.
- **Recommended cut:** invalidate only on actual routing-visible changes:
  successful heal, threshold parking, and any `applyAccountVerdict()` path that
  changes `status` or `cooldownUntil`.
- **Likely follow-up:** tests only.

### 8. One quota refresh can do 3–4 serial writes to the same row, outside one transaction

- **Verdict:** write-path simplification / efficiency cleanup
- **Behavior change?:** no
- **Severity:** HIGH
- **Effort:** M
- **Evidence:**
  - `src/providers/quota/refresh.ts:455-523`
  - `src/providers/quota/snapshot.ts:39-49`
- **Current behavior:** one upstream fetch can separately update plan,
  snapshot, label, then health/check fields for the same account row.
- **Why it matters:** extra round-trips and partial-write windows.
- **Recommended cut:** collapse plan + snapshot + label adoption where possible,
  and wrap one refresh outcome's row-state writes in a transaction when that is
  the intended unit.
- **Likely follow-up:** tests only.

### 9. `setCachedQuota()` pays a read-before-write round-trip on every refresh

- **Verdict:** cache-path performance cleanup
- **Behavior change?:** no
- **Severity:** MED
- **Effort:** M
- **Evidence:**
  - `src/providers/quota/cache.ts:189-236`
- **Current behavior:** every cache write first reads the prior entry, then
  parse/stringify work happens again before the write.
- **Why it matters:** hot-path Redis/network + serialization overhead scales with
  account count.
- **Recommended cut:** preserve semantics but collapse mechanics — pass prior
  entry when already known, use a more atomic Redis path, or scope retained
  success semantics more narrowly.
- **Likely follow-up:** tests only.

### 10. `applyAccountVerdict()` is a select-then-update-then-event sequence with no transaction boundary

- **Verdict:** transactional cleanup
- **Behavior change?:** no
- **Severity:** MED
- **Effort:** M
- **Evidence:**
  - `src/providers/operations/account-health-service.ts:728-765`
  - Caller from quota refresh: `src/providers/quota/refresh.ts:236-247`
- **Current behavior:** the method reads current status/cooldown, decides policy,
  updates the row, then writes a health event — all without one transaction.
- **Why it matters:** racing writers can make `fromStatus` stale and can commit a
  row update without its matching event.
- **Recommended cut:** use one transaction or collapse the initial read through
  `UPDATE ... RETURNING` so the state transition and event append become one
  unit.
- **Likely follow-up:** tests only.

### 11. Quota refresh rewrites heavyweight state even when nothing materially changed

- **Verdict:** write-amplification cleanup
- **Behavior change?:** no
- **Severity:** LOW/MED
- **Effort:** S/M
- **Evidence:**
  - `src/providers/quota/refresh.ts:468-479`
  - `src/providers/quota/refresh.ts:490-497`
  - `src/providers/quota/snapshot.ts:45-49`
  - `src/providers/quota/refresh.ts:497-517`
- **Current behavior:** successful refreshes always rewrite plan freshness, full
  snapshot JSON, and may run label adoption updates even when values are
  unchanged.
- **Why it matters:** unnecessary row churn on periodic sweeps.
- **Recommended cut:** guard writes by cheap change detection where practical.
- **Likely follow-up:** tests only.

---

## Recommended execution order

1. Hot-path `console_settings` scan
2. Quota refresh snapshot invalidation gap
3. Quota refresh write-path collapse / transaction boundaries
4. Classification rule-table overlap / order sensitivity
5. Compatibility-profile contract drift
6. Account-health auth pre-read collapse
7. Legacy `policy_blocked` cutover
8. Provider-alias normalization in cooldown rules
9. Cache/write-amplification cleanup in quota refresh

---

## Execution status

- ⛔ Audit only; no implementation yet.
