# Provider Operations, Quota, Authentication — Deep Audit (Part 07)

Status: **Audit only — no implementation yet.**

Scope: `src/providers/authentication/**`, `src/providers/operations/**`, `src/providers/quota/**`, `src/providers/search/**`. Read-only. No source, test, config, or git state was modified.

## 1. Summary

The four areas are in good structural shape: shared helpers exist for the right things (JWT decoding/verification, device flow, form token POSTs, reported-model extraction, client-version resolution, provider registry, account-verdict application). The audit found **four confirmed findings** and **one plausible low-severity finding**, all consolidation/cleanup opportunities that preserve behavior or remove a real stale-state hazard. No dead code was claimed from grep alone; every finding was traced to its callers and tests.

## 2. Current flow evidence (canonical paths)

### 2.1 Quota collection

`quota-refresh-sweep.ts` → `refreshAccountQuota` (`src/providers/quota/refresh.ts:367`) → in-flight dedup (`inFlightAccountQuotaRefreshes`, `refresh.ts:83`) → `runQuotaRefresh` (`refresh.ts:390`) → `fetchProviderQuota` (`src/providers/quota/quota-support.ts:75`) → `registry.resolveQuotaCollector` → per-provider collector (`fetchClaudeQuota`, `fetchClineQuota`, `fetchGithubQuota`, `fetchOllamaQuota`, …). The outcome is persisted three ways: `setCachedQuota` (two-tier in-memory + Redis, `src/providers/quota/cache.ts:189`), `quota_plan` on the account row (`refresh.ts:472-487`), and `persistQuotaSnapshot` (`src/providers/quota/snapshot.ts:39`). Routing/console read through `getCachedQuotaEntry` / `readQuotaSnapshot`.

### 2.2 OAuth refresh

`OAuthRefreshService.ensureFreshAccessToken` (`src/providers/authentication/oauth-refresh-service.ts:554`) is the single refresh entry point (dispatch retry, sweep, console UI, quota sweep all funnel here). Lease-fenced cross-process (`acquireLease`/`persistRefreshed`/`disableAccount`), with the D21 no-status-mutation invariant. `loadAccountWithFreshness` (`src/providers/operations/provider-credential-service.ts:156`) is the canonical account+OAuth-state loader. `refreshAccountStatus` (`src/providers/operations/account-refresh-status.ts:137`) is the manual UI affordance wrapping the same service.

### 2.3 Health

`recordAccountFailure`/`recordAccountSuccess` (`src/providers/operations/account-health-service.ts:110/440`) classify and persist verdicts; `applyAccountVerdict` (`account-health-service.ts:712`) is the single seam for account-state mutation. `mapPlanToTier` (`account-tier.ts:40`) maps `quota_plan` strings to the tier taxonomy consumed by `resolveCooldownRule` (`cooldown-rules.ts:53`).

### 2.4 Search

`createSearchAdapter` (`src/providers/search/search-provider.ts:84`) is the declarative adapter builder; `SEARCH_PROVIDER_SPECS` (`search-providers.ts:225`) defines Exa/Parallel. `providerSearchModel` (`search-catalog.ts:10`) builds the two catalog rows. Covered by `test/providers/search-providers.test.ts`.

## 3. Findings

### F1 — Claude's module-local quota cache can overwrite a debit-ahead balance and duplicates the shared two-tier quota cache

- **Verdict:** CONFIRMED. **Severity:** MED. **Effort:** S. **Behavior change:** yes (removes a stale cache tier; no externally visible loss).
- **Path:** `src/providers/integrations/claude/claude-quota.ts:101-163` (`fetchClaudeQuota`, `quotaCache`, `quotaCooldown`).
- **Mechanism:** `fetchClaudeQuota` maintains its own `TtlCache<ProviderQuotaResult>` (5 min, 256 entries) keyed by `sha256Hex(credential)` and returns a cached `ProviderQuotaResult` without touching the shared cache. The shared two-tier cache (`cache.ts`) is also replenished by `runQuotaRefresh` after every collector call. Meanwhile `debitCachedQuota` (`cache.ts:255`) subtracts spend from the *shared* cached balance between sweeps, preserving `fetchedAt` so the sweep still refreshes. Because Claude's local cache is never invalidated by a debit and is keyed by credential (not the shared `(lens, accountId)` key), a sweep that runs within 5 minutes of a debit can return the pre-debit balance from the local cache, and `setCachedQuota` then writes it back over the debited shared balance — resurrecting a spent balance for routing/console until the next sweep.
- **Why it matters:** `debitCachedQuota` exists precisely so the usage floor does not keep selecting an exhausted account between sweeps; F1 can undo that. The local tier is also redundant with the shared in-memory tier for the common per-account credential case (the shared tier already dedupes concurrent fetches within a process).
- **Proposal:** Delete `quotaCache` from `claude-quota.ts` and let the shared two-tier cache own dedup. Keep `quotaCooldown` (the 429 backoff) as-is. `fetchClaudeQuota` then always performs the upstream read; the per-account in-flight + shared-cache layers already prevent duplicate traffic.
- **State/fallback analysis:** The shared cache's `retainedSuccess` path (keep last good balance on fetch error) is untouched. The 429 cooldown behavior is preserved. The only behavior change is that a second fetch for the same account within 5 minutes will hit the shared cache instead of the local one — the same freshness, one fewer stale layer. No fallback is loosened.
- **Verification:** A test that (1) seeds a claude quota via `refreshAccountQuota`, (2) calls `debitCachedQuota`, (3) runs `refreshAccountQuota` again, and (4) asserts the cached balance still reflects the debit. Existing `test/console/quota-retained-status.test.ts` and `test/providers/memory-backend.test.ts` cover the shared-cache semantics and must keep passing unchanged.

### F2 — `parseLimitWindows` and `parseQuotaWindows` are two overlapping generic quota parsers with duplicated field-extraction machinery

- **Verdict:** CONFIRMED (structural duplication). **Severity:** MED. **Effort:** M. **Behavior change:** no (if consolidation preserves the dedup and skip semantics).
- **Path:** `src/providers/quota/quota-limit-windows.ts:65-93` (`parseLimitWindows`) vs `src/providers/quota/quota-window-parser.ts:101-165` (`parseQuotaWindows`).
- **Mechanism:** Both walk a payload, read used-percent / reset / used / limit via ordered field-name or path lists, skip entries with neither percent nor reset, and emit `percentWindow(kind, label, percent, reset, used, limit, "independent")`. `parseLimitWindows` is array-shaped (a `limits[]` field); `parseQuotaWindows` is declarative-path shaped and additionally implements label-dedup. They are used side by side in one provider: `src/providers/integrations/claude/claude-quota.ts:80-97` calls `parseQuotaWindows` for fixed windows *and* `parseLimitWindows` inside `limitsWindows` (extraWindows); `cline-quota.ts:52-68` uses `parseLimitWindows`; `ollamacloud/quota.ts:33` uses `parseQuotaWindows`.
- **Why it matters:** Two parsers mean two places to keep the skip rule, the percent computation, and the window shape in sync. The Claude combination is the proof they must not drift: `parseQuotaWindows`' dedup-by-label exists specifically because fixed windows and `limits[]` windows describe the same scopes in different vocabularies.
- **Proposal:** Extract the shared per-window field-resolution core (first-non-null over ordered paths, percent-from-used/remaining/used-limit fallback chain, "emit if percent or reset" guard) into one internal helper, and have both walkers use it. Do **not** merge the two public entry points unless the array mode is added to `QuotaWindowMapping` (e.g. an `arrayPath` option) and the dedup behavior is explicitly moved into the shared path for both. The safer, smaller change is the shared core; a full merge is the larger, riskier option.
- **State/fallback analysis:** No persisted state is touched. The skip rule ("an entry with neither percent nor reset is dropped, never rendered as 0%") and the label-dedup order (declarative first, `limits[]` later) are the two invariants that must be preserved exactly; both are currently covered only indirectly through the Claude/Cline collectors (no direct unit test exists for either parser — see Open Questions).
- **Verification:** Add direct unit tests for `parseLimitWindows` and `parseQuotaWindows` covering: percent-only entry, reset-only entry (emitWithoutPercent), derived-used (Cline), label dedup across fixed+limits (Claude), and the 0-vs-null distinction. Existing `test/providers/cline-api-key-quota.test.ts`, `test/providers/cline-quota-headers.test.ts`, and the Claude quota paths must pass unchanged.

### F3 — Account-row + OAuth-state loading is implemented four times with near-identical SQL

- **Verdict:** CONFIRMED. **Severity:** LOW. **Effort:** S. **Behavior change:** no.
- **Path:**
  - `src/providers/operations/provider-credential-service.ts:156` — `loadAccountWithFreshness` (canonical owner, used by refresh).
  - `src/providers/operations/account-refresh-status.ts:61` — `loadAccount` (same projection minus `dueAt`).
  - `src/providers/operations/account-refresh-status.ts:87` — `readStatusAfter` (status + `expiresAt`, same leftJoin shape).
  - `src/providers/authentication/oauth-refresh-service.ts:736` — `readAccountStatus` (status only).
- **Mechanism:** All four build `select(...).from(providerAccounts)` and conditionally leftJoin `providerOauthStates` on `providerAccountId` with the same `"leftJoin" in selectBuilder` memory/Postgres dialect guard. `readStatusAfter` vs `readAccountStatus` differ only in the extra `expiresAt` column.
- **Why it matters:** Four copies of the same join+projection pattern means four places to update if the schema or the dialect guard changes, and four subtly different row shapes to keep in mind when reading health/auth state.
- **Proposal:** Add one shared `loadAccountWithOauthState(db, accountId, { includeExpiry, includeDueAt })` in `provider-credential-service.ts` and have `refreshAccountStatus` and the two status readers call it. `refreshAccountStatus` keeps its own D25 status-after re-read semantics (it must re-read *after* the attempt — that is a call-order property, not a query-ownership property).
- **State/fallback analysis:** All four are read-only; the leftJoin guard is preserved. `loadAccountWithFreshness`' `dueAt` skew logic stays intact. No account state or fallback is affected.
- **Verification:** Existing `test/console/provider-account-refresh-token.test.ts` and `test/providers/refresh-disabled-status.test.ts` cover `refreshAccountStatus`; `test/providers/oauth-refresh-timeout.test.ts` covers the refresh path. All must pass unchanged after the refactor.

### F4 — Five client-version extractors are exact subsets of `defaultExtract` and can be removed

- **Verdict:** CONFIRMED (redundant code). **Severity:** LOW. **Effort:** S. **Behavior change:** no.
- **Path:** `src/providers/operations/client-versions.ts:19-26` (`qoderVersion`), `:70-73` (`clineClientVersion`), `:98-105` (`clineSdkVersion`), `:112-119` (`kiroCaskVersion`), `:107-110` (`kimiVersion`) vs `src/providers/operations/client-version-resolver.ts:102-120` (`defaultExtract`).
- **Mechanism:** `defaultExtract` already reads `parsed.version ?? parsed.info?.version ?? parsed["dist-tags"]?.latest`, validates via `isSemverish`, and falls back to a plain-text body — a strict superset of what these five do (each reads one or two of those fields from a JSON body). `probe` (`client-version-resolver.ts:157-164`) already applies `source.extract ?? defaultExtract`, so removing these five extractors is a drop-in change.
- **Why it matters:** Five near-identical functions across one file, each a smaller copy of the default; keeping them invites drift (e.g. one day adding `dist-tags` handling to one but not the others).
- **Proposal:** Delete the five extractors and omit `extract` on their sources (or point them at `defaultExtract` explicitly). Keep `traeVersion`, `cursorVersion`, `antigravityVersion`, `githubReleaseVersion`, `kiroVersion`, and `codeBuddyCnVersion` — each is genuinely bespoke (HTML changelog, commitSha join, YAML-ish, tag-strip, HTML regex, 4-part prefix).
- **State/fallback analysis:** `defaultExtract` is a superset: the only difference is it also accepts a plain-text body, which none of the five sources produce (all are JSON, and all already pass `content-type: application/json` in `probe`). No fallback changes.
- **Verification:** `test/providers/client-version-monitor.test.ts` exercises the resolver end-to-end; a focused test asserting each affected source (qoder, cline client, cline sdk, kiro cask, kimi) resolves its pinned fallback's newer version through `ensure()` would prove the switch.

### F5 (plausible) — Free-plan marker is split across two modules with identical semantics

- **Verdict:** PLAUSIBLE. **Severity:** LOW. **Effort:** S. **Behavior change:** no.
- **Path:** `src/transport/routing/plan-gate.ts:20` (`FREE_PLAN_MARKERS = ["free"]`) vs `src/providers/operations/account-tier.ts:45` (`lower.includes("free")`).
- **Mechanism:** `isFreePlanAccount` and `mapPlanToTier` both decide "free" by substring-matching the literal `"free"` against the plan string. `account-tier.ts`' header comment claims "the same marker set the routing plan-gate uses, so the two cannot disagree" — but the sets are actually defined twice (a constant in `plan-gate.ts`, an inline literal in `account-tier.ts`), so nothing enforces that claim.
- **Why it matters:** The comment asserts a shared contract the code does not share. If one side's marker set is ever widened (e.g. to include `"trial"`), the two can disagree exactly as the comment warns against.
- **Proposal:** Export `FREE_PLAN_MARKERS` from `plan-gate.ts` and consume it in `mapPlanToTier` (or hoist it to a shared module both import). Note this crosses the exclusive area boundary (`plan-gate.ts` lives in `src/transport/routing/`); the owned side of the change is the `account-tier.ts` consumer.
- **State/fallback analysis:** Both checks remain permissive-by-default (only an explicit free marker excludes; unknown plans stay in rotation). Consolidation changes no verdict.
- **Verification:** `test/providers/cooldown-rules.test.ts` (tier mapping) and the routing plan-gate tests must pass unchanged; add one assertion that the shared marker set is used by both.

## 4. Excluded and unverified suspects

- **Per-provider `refresh` implementations** (15 types): genuinely provider-specific (per-endpoint params, client secrets, region handling) and already built on the shared `postFormTokenRequest`. Not duplication.
- **`OAuthFlowStore` vs `InMemoryOAuthFlowStore`**: intentional memory/Redis backend pair behind one interface, not code bloat.
- **`getJson` (quota-contracts) vs `readJsonResponse` (oauth-flow-store)**: different error vocabularies and envelope handling; used by disjoint surfaces. Not consolidated.
- **BYOK/probe base-URL joining** (`quota-support.ts` `probeApiKeyConnectivity` vs `byok-wire-profile.ts` `modelListUrl`): different semantics (bundle probe vs BYOK endpoint-tail stripping); both are small and correct. Not worth merging.
- **`setCachedQuota`'s read-before-write**: a necessary read-modify-write for `retainedSuccess`, not duplication.
- **Quota/snapshot dual persistence**: `quota_plan` + `quota_snapshot` + cache are deliberately three different freshness scopes; documented in `refresh.ts` comments. Not bloat.
- **`OAuthClient.calculateExpiry` wrapper**: already delegates to `expiryFromSeconds`; fine.
- **Health-event writes**: `writeHealthEvent` (buffered) and `writeRefreshHealthEvent` (account-refresh-status) coexist; they serve different events (attempt vs verdict), but this was not fully verified as duplicative and is left open.
- **Dead code**: no claim of deadness from grep alone. All findings are confirmed live paths.

## 5. State/fallback cross-cutting analysis

- **Quota F1** is the only finding with a state-integrity hazard; it is a staleness/overwrite interaction, not corruption. Fixing it keeps the shared cache as the single source of truth.
- Consolidating F2/F3/F4/F5 touches read paths and pure parsing; none writes persisted state, so no lease, snapshot, credential, or telemetry loss is possible.
- Every finding preserves the existing failure semantics: transient refresh failures still release the lease, definitive failures still disable via `applyAccountVerdict`, quota fetch failures still retain the last good snapshot/plan, and search still fails closed on non-search wires.

## 6. Validation

- Scope confirmed by walking `src/providers/{authentication,operations,quota,search}` (40 files) plus cross-area callers (`src/transport/routing/plan-gate.ts`, `src/console/quota/*`, `src/workers/quota-refresh-sweep.ts`, `src/providers/default-registry.ts`, `src/providers/provider-registry.ts`).
- CodeGraph used for symbol/call-path mapping (`OAuthRefreshService`, refresh-lead, quota cache/snapshot/refresh, catalog caches, search adapters, health service); Read used for full file bodies and line-precise citations.
- Tests inspected: `cline-quota-headers.test.ts`, `cline-api-key-quota.test.ts`, `quota-retained-status.test.ts`, `memory-backend.test.ts`, `quota-refresh-healing.test.ts`, `search-providers.test.ts`, `client-version-monitor.test.ts`, `refresh-disabled-status.test.ts`, `provider-account-refresh-token.test.ts`, `cooldown-rules.test.ts`, and the quota/health/classification suites listed in the repo.
- No tests were run (read-only audit; no implementation yet). Suggested proof per finding is listed with each finding.

## 7. Open questions

- No direct unit tests exist for `parseLimitWindows`/`parseQuotaWindows`; is the financial/rendering risk of the Claude dual-parser path high enough to warrant adding those tests as part of any consolidation, or is the existing collector-level coverage sufficient?
- The claude local quota cache predates the shared two-tier cache; confirm with the feature owner whether it was added before `cache.ts` gained the in-memory tier (in which case F1 is purely vestigial).
- Are `writeHealthEvent` and `writeRefreshHealthEvent` intentionally separate (different event shapes), or should the manual-refresh event flow through the buffered path too?

---

Execution status: **Implementasi kampaian (2026-11-09).** Verified against the
full backend suite (4735 pass / 1 skip / 0 fail) and `tsc --noEmit` (zero
errors in scope):

- **F1 (M-24) — ✅.** Module-local `quotaCache` deleted from
  `claude-quota.ts`; `fetchClaudeQuota` always reads upstream and the shared
  two-tier cache owns dedup. `quotaCooldown` (429 backoff) kept exactly. New
  test `test/providers/claude-quota-cache.test.ts` (debit-then-sweep retains
  debit).
- **F2 (M-25) — ✅.** `resolveWindowEmission` extracted into
  `quota-window-parser.ts`; `parseQuotaWindows` and `parseLimitWindows` share
  the field-resolution core, each keeping its own derive flag. New test
  `test/providers/quota-window-parsers.test.ts`.
- **F3 (M-26) — ✅.** `loadAccountWithOauthState` added to
  `provider-credential-service.ts` with the same leftJoin dialect guard and
  dueAt skew logic; all four loading sites now delegate to it.
- **F4 (M-27) — ✅.** Five extractors that were exact subsets of
  `defaultExtract` deleted (qoder/cline/cline-SDK/kiro-cask/kimi); sources now
  omit `extract`. `test/providers/client-version-monitor.test.ts` updated.
- **F5 — ⛔ (plausible-unverified).** Free-plan marker split across two
  modules — addressed by M-17 (routing cluster), which exported
  `FREE_PLAN_MARKERS` from `plan-gate.ts` and consumed it in `account-tier.ts`.
  Resolved there; see part 05.
