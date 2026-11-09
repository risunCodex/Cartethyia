# Console Domains B — deep audit for maintenance reduction

**Status: audit only — no implementation yet.**

- **Scope:** console domains B — `src/console/ip-bans/**`, `observability/**`, `providers/**`, `quota/**`, `remote-support/**`, `routing/**`, `settings/**`, `share/**`, `shared/**`, `system-prompt/**`, `updates/**`, plus `console-router.ts`, `console-router-guards.ts`, `dashboard-assets.ts`, `domain-registration.ts`, `response-compression.ts`.
- **Method:** CodeGraph symbol/call-path mapping first (`codegraph explore` / `codegraph callers`), then direct reads of every file in scope. No source, test, config, or git state was modified. The only file created is this report.
- **Goal:** concrete opportunities to reduce bloat, duplication, unnecessary work, and maintenance complexity while preserving behavior, memory/state integrity, and fallback semantics.

## Current flow evidence (how the area is organised)

- **Composition:** `createConsoleRouter` (`console-router.ts:119`) builds one Elysia app under `/console/api`, mounts the CSRF + mutation-limiter plugins, resolves session/API-key access in a `beforeHandle`, installs `gzipResponse` via `wrap` (path-scoped inside `response-compression.ts`), and delegates all domain routes to `registerConsoleDomains` (`domain-registration.ts:152`).
- **Domain pattern:** every domain is a thin `routes.ts` (Elysia surface) → `operations.ts`/`contracts.ts` (validation + orchestration) → Drizzle `store.ts` (persistence). Shared helpers live in `src/console/shared/` (`errors`, `query`, `cursor`, `read-through-cache`, `object`, `transaction`, `day`, `ip-privacy`, `elysia-schema`).
- **Caching:** the read-through cache (`shared/read-through-cache.ts`) is the single validator-capable cache for telemetry/usage/provider-list responses; `PublicModelCatalogStore` owns its own LRU + in-flight dedupe with TTL; quota uses the provider-layer cache (`providers/quota/cache`) plus persisted snapshots as the cold-start fallback; share stats use `cachedRead` with a 300 s TTL.
- **State/fallback posture observed:** quota cold reads fall back to persisted snapshots before hitting upstream; page open enqueues a bounded background refill; `cachedReadWithEtag` never lets a Redis failure fail a request; SSE samplers are shared per process and stop when the last subscriber leaves; update status file is the contract between gateway and detached installer.

## Findings

### F1 — Account-status PATCH validation is duplicated verbatim between tenant and global quota routes

- **Verdict:** CONFIRMED structural duplication. **Severity:** MED. **Effort:** S. **Behavior change:** no.
- **Evidence:**
  - `src/console/quota/account-quota-tenant.ts:748-764` (`PATCH /accounts/:id`): validates `body.status` against `ACCOUNT_STATUSES`, then maps `active` → `status` with `body.active !== undefined ? (body.active ? "active" : "disabled") : (body.status as AccountStatus | undefined)`, then rejects a missing status with 400 `"active or status is required"`.
  - `src/console/quota/account-quota-global.ts:120-136` (`PATCH /global/accounts/:id`): the identical block, byte-for-byte (same messages, same codes, same ordering, same `set.status = 400` before returning).
- **Current mechanism:** two route handlers re-implement the same input-interpretation contract. `ACCOUNT_STATUSES` is already shared via `account-quota-shared.ts:20`.
- **Why consolidate:** the two surfaces must stay in lockstep; a change to one (e.g. a new status alias or a changed error code) is silently not applied to the other. A shared `resolveNextAccountStatus(body)` in `account-quota-shared.ts` returning a discriminated union (`{ok:true; nextStatus}` | `{ok:false; status:400; body:{error,code}}`) removes the copy and pins the contract once.
- **State/fallback risk:** none. Pure user-input validation; no cache, snapshot, or persisted state touched. The early `set.status = 400` return is preserved by the helper's error branch.
- **Proof:** existing tests `test/console/account-batch-delete.test.ts` and the global-route cases in `test/console/provider-detail-bulk-actions.test.ts:267` (global PATCH path) exercise both surfaces; after extraction, run the full console suite plus a focused test asserting both routes return identical statuses/codes for the same inputs (`active:true`, `active:false`, invalid `status`, missing both).

### F2 — `listPools` and `getPoolDetail` duplicate the entire enrichment projection

- **Verdict:** CONFIRMED structural duplication. **Severity:** MED. **Effort:** S. **Behavior change:** no.
- **Evidence:** `src/console/routing/pools/operations.ts:49-77` (`listPools`) and `:78-106` (`getPoolDetail`) both run `sanitizePoolResponse(...)` → `getPoolCooldowns` → `getInflightAuthoritative` → the identical `{...res, inflight, available: Math.max(0, res.maxInflight - inflight), utilization: ..., providerCooldowns: ...}` projection.
- **Current mechanism:** two handlers recompute the same read-only derivation for the same pool shape; the only difference is the source (`list` row vs `get(tenantId, poolId)`).
- **Why consolidate:** extract `enrichPoolResponse(res, poolId)` (one private helper in `operations.ts`). Drift between the two copies would make the list and the detail page disagree on `available`/`utilization`/cooldown rendering for the same pool — exactly the class of divergence this audit targets.
- **State/fallback risk:** none. Both paths already treat `poolSelector` as optional (`?.`), keep `res.inflight` when the selector is absent, and use the same fallbacks; the helper preserves all three fallbacks.
- **Proof:** `test/console/pool-account-list.test.ts`, `pool-strategy-route.test.ts`, and `pool-probe-enforcement.test.ts` exercise list/detail behavior; add a small unit pinning `enrichPoolResponse` for (a) selector present, (b) selector absent, (c) cooldowns empty vs non-empty. Run the pool console tests.

### F3 — The "model cooldown has a live entry" SQL fragment is duplicated across catalog store and global-quota routes

- **Verdict:** CONFIRMED structural duplication (identical dialect-specific SQL subquery). **Severity:** MED. **Effort:** S–M. **Behavior change:** no.
- **Evidence:**
  - `src/console/providers/catalog/store.ts:1801-1803` (`liveCooldownPredicate`): `EXISTS (SELECT 1 FROM json_each(...) ... entry.value > ${nowIso})` for SQLite / `jsonb_each_text(...)` for Postgres.
  - `src/console/quota/account-quota-global.ts:41-42` (`globalLiveCooldownPredicate`): the identical two-branch fragment.
- **Current mechanism:** both build the same "model_cooldowns has an entry whose ISO deadline is still in the future" predicate. The catalog store wraps it in `or(eq(status,'cooldown'), cooldownUntil > now, live)` and scopes to a tenant; the global route wraps the same fragment inside a raw `and(isNull(tenantId), sql\`... OR ...\`)` string. The fragment is identical; only the surrounding scoping differs.
- **Why consolidate:** a change to live-cooldown semantics (deadline format, shape guard, dialect) must currently be applied in two files; the comment at `store.ts:1796-1797` explicitly says it mirrors `liveModelCooldowns`, so the two copies are coupled by contract. Extract only the subquery into `src/persistence/dialect.ts` (the canonical home of dialect-specific SQL, next to `pruneExpiredCooldowns`) as e.g. `liveModelCooldownExistsSql(database, nowIso)`, and keep each caller's own scoping (`isNull(tenantId)` vs tenant `where`) intact.
- **State/fallback risk:** none for memory/state. The extracted fragment is pure SQL text; both callers keep their own `nowIso` evaluation and their own ownership scope. Do NOT unify the full predicates — the tenant path must never touch `tenant_id IS NULL` rows and the global path must only touch them, so only the shared JSON subquery is extracted.
- **Proof:** `test/console/provider-detail-bulk-actions.test.ts` covers both the tenant `disable-cooldowns` (lines 142-208, including the model-cooldown row) and the global route (lines 267-305). After extraction, assert the generated SQL is unchanged by running these tests plus a SQLite/Postgres dialect check.

### F4 — IP-ban domain carries a private copy of the canonical ban-duration list and a dead export

- **Verdict:** CONFIRMED duplication + dead export. **Severity:** LOW. **Effort:** S. **Behavior change:** no.
- **Evidence:**
  - `src/console/ip-bans/routes.ts:29-37` defines `BAN_DURATION_CHOICES` with the same six entries as the canonical list in `src/console/api-keys/ban-constants.ts:31-41` (identical values, verified byte-for-byte except the `const`/`export` prefix). It is exported at `routes.ts:99`.
  - `src/console/ip-bans/routes.ts:39-44` exports `parseBanDuration`; grep across `src/`, `test/`, and `dashboard/` finds no importer. The POST handler (lines 66-75) re-implements the rounding/validation inline instead of using it.
  - The dashboard keeps a third, intentionally-mirrored copy (`dashboard/src/lib/ban-durations.ts`); it is documented as a mirror and is out of scope for this change.
- **Current mechanism:** the route neither validates against nor uses its private list; the list is an exact copy of `ban-constants.ts`. `parseBanDuration` is shipped API surface with no consumer.
- **Why consolidate:** delete the private list and the dead export; import `BAN_DURATION_CHOICES` from `api-keys/ban-constants.ts` (browser-safe, already re-exported by `api-keys/contracts.ts:151-154`), and have the POST handler call `parseBanDuration` (or remove it with its test if the team prefers to keep the inline logic — the safe minimal change is to reuse it). Removes one of the copies that must be kept in sync.
- **State/fallback risk:** none. The values are identical, so no behavior change for the 400 path; `parseBanDuration` returns `undefined` for invalid input, which maps to the same error branch.
- **Proof:** no dedicated IP-ban route test exists in `test/console/` (checked). Add a small route test for the three ban/unban endpoints, and rely on `dashboard-assets.test.ts`/`response-compression.test.ts` for the untouched surfaces. Verify by `grep` that no remaining importer of the removed export exists.

### F5 — `summarizeUsagePerformance` and its private `percentile` have no production callers

- **Verdict:** CONFIRMED no production use (exported only for the test suite). **Severity:** LOW. **Effort:** S. **Behavior change:** no (removal only).
- **Evidence:**
  - `src/console/observability/store.ts:223-250` exports `summarizeUsagePerformance`; `:205-209` defines private `percentile`. Production imports of the store are only `DrizzleObservabilityStore` (`domain-registration.ts:34`); `codegraph callers` and grep find the sole consumer at `test/console/usage-performance.test.ts:2`.
  - The store's own comments (lines 200-204) describe it as legacy: "kept for the JS-side `summarizeUsagePerformance`… The usage endpoints read percentiles from SQL via `summarizeUsagePerformanceSql`, which is what the dashboard polls."
- **Current mechanism:** the function ships in the backend bundle and recomputes percentiles by sorting a latency array in JS; the production telemetry reads already compute percentiles in SQL. It is dead weight plus a stale comment pointing at a removed path.
- **Why consolidate:** delete the export, the private `percentile`, and the test file. This removes ~45 lines and a misleading comment. Because it is an exported, tested function, it may be intentionally retained as a utility — flag for the team; if retained, the comment should be corrected to say "test-only".
- **State/fallback risk:** none. No runtime path references it; the SQL readers (`summarizeUsageWithPerformance`) are independent.
- **Proof:** delete and run `bun test test/console` plus a typecheck; confirm no remaining import of `summarizeUsagePerformance` from `src/console/observability/store`.

### F6 — CSRF and mutation-limiter middleware duplicate the identical path/method/exclusion predicate

- **Verdict:** CONFIRMED structural duplication. **Severity:** MED. **Effort:** S. **Behavior change:** no.
- **Evidence:** `src/console/console-router-guards.ts`:
  - `createConsoleCsrfMiddleware` lines 21-41: exclusion list `["/auth/login", "/auth/setup", "/auth/setup/restore", "/auth/session"]` (line 22) and predicate `!path.startsWith("/console/api/") || !["POST","PUT","PATCH","DELETE"].includes(request.method) || excluded.some(suffix => path.endsWith(suffix))` (lines 26-31).
  - `createConsoleMutationLimiterMiddleware` lines 77-111: the identical exclusion list (line 78) and predicate (lines 82-87).
- **Current mechanism:** two beforeHandle plugins evaluate the same "is this a protected console mutation?" test. Both are stateless gatekeepers for the same request population.
- **Why consolidate:** a new console auth route (or a change to the excluded set) must be added in two places; missing one causes CSRF and rate-limit behavior to diverge for that route — a security-adjacent drift. Extract one private `isProtectedConsoleMutation(request)` helper (and one `AUTH_ROUTE_SUFFIXES` constant) used by both plugins.
- **State/fallback risk:** none. Both plugins keep their own state (`consoleMutationHits` map stays in the limiter; CSRF stays stateless). The shared predicate is pure.
- **Proof:** `test/console/session-cookie-security.test.ts` and the gateway/console auth suite exercise both plugins; after extraction run the console suite. Add a focused test asserting a new auth suffix is excluded from both guards.

## State / fallback analysis

- All six findings are read-only refactors or dead-code removals. None introduces a new cache, changes a TTL, alters persisted state, or touches credential material.
- **Quota paths (F1, F3):** the disable/delete bulk actions still target rows through the same SQL predicates and the same tenant-vs-global scoping; only the SQL-generation helper and the input-validation helper are shared. The fallback chain (cache → snapshot → upstream) is untouched.
- **Pool reads (F2):** both endpoints keep the optional-selector fallback (`res.inflight`) and the cooldown-absent path.
- **Cache/telemetry (F5):** no cache state involved; the SQL readers that serve the dashboard are unaffected.
- **Security guards (F6):** stateless; the mutation-hit map and its pruning logic are untouched.

## Excluded / unverified suspects

- **Period-token parsing** appears twice (`observability/contracts.ts:17` `isSupportedUsagePeriod` vs `observability/store.ts:87` `periodStartDate`). These have different contracts (boolean validation vs window start) and are deliberately separate; not consolidated.
- **Runtime settings dual validation** (Elysia `runtimeUpdateBody` bounds vs store normalizers in `settings/contracts.ts:248-293` / `settings/store.ts:89-152`): intentional belt-and-suspenders across different boundaries; not proposed.
- **Read-through cache local-fallback TTL:** the lite-mode fallback in `shared/read-through-cache.ts:75-83` applies the fixed 10 s `READ_THROUGH_DEFAULT_TTL_SECONDS`, ignoring the caller-supplied `ttlSeconds` (e.g. usage analytics' 30 s). This is a performance divergence in Lite mode only, not a correctness issue; left as an open question, not a finding.
- **Sampler pattern similarity** between `share-router.ts` (`createShareStatsSampler`) and `updates/routes.ts` (`createUpdateSampler`): structurally similar but different payloads/cadences/teardown; consolidating them would couple unrelated domains, so not proposed.
- **`clientNameFromUserAgent` re-export** from `observability/store.ts:19`: no importer of the re-export was found, but the canonical module (`observability/client-name.ts`) is heavily used, so the re-export is a one-line alias; left as cleanup trivia rather than a finding.
- **OAuth flow (`callback-listener.ts`, `providers/oauth/routes.ts`):** reviewed end to end; the state machine (peek → exchange → consume, listener lifecycle, device-flow retry on persist failure) is coherent with no duplication worth touching.
- **`dashboard-assets.ts` / `response-compression.ts`:** reviewed; the gzip path allowlist and the static-handler hashed-asset logic are single-purpose and well-documented, no duplication found.
- **`system-prompt` and `remote-support`:** validation-heavy but single-copy; no duplication found.

## Validation

- Typecheck (`bun run typecheck` or the repo's gate) after each extraction.
- Suite runs: `test/console/` exercises the affected surfaces — `account-batch-delete`, `provider-detail-bulk-actions`, `pool-*`, `quota-retained-status`, `session-cookie-security`, `response-compression`, `runtime-settings-*`, `share-stats-cache`, `dashboard-assets`, `update-apply`, `system-prompt-route`, `remote-support-*`.
- For F3, specifically re-run the SQLite fixture tests and (if available) a Postgres variant; the extracted fragment is byte-identical so both dialects must keep passing.

## Open questions

1. Is `summarizeUsagePerformance` intentionally retained as a test-only utility (F5)? If so, we can keep it and only fix the misleading comment; the dead-export finding stands either way.
2. Should the dashboard's `ban-durations.ts` mirror also point at `ban-constants.ts` (it is already imported by `dashboard/src/data/contracts.ts:179` for reasons, so the browser-safe path exists)? That change crosses the dashboard boundary and is proposed only as a follow-up, not part of the backend consolidation.
3. The lite-mode fixed-TTL behavior in `read-through-cache.ts` — should the local fallback honor the caller's `ttlSeconds` to match the Redis path? It is a behavior change (more/less recomputation in Lite mode), so it is deliberately not proposed here.

## Execution status

**Implementasi kampaian (2026-11-09).** Verified against the full backend suite
(4735 pass / 1 skip / 0 fail) and `tsc --noEmit` (zero errors in scope):

- **F1 (M-50) — ✅.** `resolveNextAccountStatus(body)` extracted in
  `account-quota-shared.ts` (discriminated union); tenant + global PATCH
  handlers use it with identical codes/messages/early-400.
- **F2 (M-51) — ✅.** `enrichPoolResponse(res, poolId)` extracted in
  `pools/operations.ts`; listPools + getPoolDetail use it; optional-selector
  fallback and cooldown-absent path preserved.
- **F3 (M-52) — ✅.** `liveModelCooldownExistsSql(database, nowIso)` added to
  `src/persistence/dialect.ts`; catalog + global-quota predicates use it, each
  keeping its own scoping (`isNull(tenantId)` vs tenant where).
- **F4 (M-53) — ✅.** Private `BAN_DURATION_CHOICES` copy and dead
  `parseBanDuration` export removed; canonical list imported from
  `api-keys/ban-constants.ts`; POST handler reuses `parseBanDuration`;
  re-export retained.
- **F5 (M-54) — ✅.** `summarizeUsagePerformance` + private `percentile` +
  `UsagePerformanceSummary` deleted; `test/console/usage-performance.test.ts`
  deleted; no production importers remain.
- **F6 (M-55) — ✅.** `AUTH_ROUTE_SUFFIXES` + `isProtectedConsoleMutation`
  extracted in `console-router-guards.ts`; shared by CSRF and mutation-limiter,
  each keeping its own state; exclusion behavior identical.
