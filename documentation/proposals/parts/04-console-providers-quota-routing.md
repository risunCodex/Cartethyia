# Report 04 — console/providers, quota, remote-support, routing, settings, share, shared, system-prompt, updates

Scope: `src/console/providers/`, `src/console/quota/`, `src/console/remote-support/`, `src/console/routing/`, `src/console/settings/`, `src/console/share/`, `src/console/shared/`, `src/console/system-prompt/`, `src/console/updates/`. Every `.ts` file read in full; every finding cross-checked against `src/`, `test/`, `scripts/`, `dashboard/src/` with grep. No edits made.

---

## DEAD-CODE

| # | Severity | File | Line | What | Suggested fix |
|---|----------|------|------|------|---------------|
| 1 | DEAD-CODE | `src/console/remote-support/contracts.ts` | 67–69 | `export function isRemoteSupportTool(...)` — zero consumers anywhere in the repo (routes use the Elysia `toolSchema`; no other importer). | Delete it, or privatize it. Test/verify by grepping `isRemoteSupportTool` repo-wide. |
| 2 | DEAD-CODE | `src/console/remote-support/contracts.ts` | 43–47 | `RemoteSupportStartRequest` interface — never imported or referenced. Only `RemoteSupportStartResponse` is consumed (dashboard). | Remove the interface. |
| 3 | DEAD-CODE | `src/console/routing/pools/import-parse.ts` | 206 | `export { isPoolKind, isPoolStatus };` — the only consumers are inside this module (lines 51, 55, 161). The export is never imported elsewhere. | Drop the export statement; keep the functions module-private. |
| 4 | DEAD-CODE | `src/console/providers/catalog/store.ts` 920–930 and `src/console/providers/catalog/contracts.ts` 809 | `listAllAccounts(tenantId)` — no caller anywhere in src/test/scripts/dashboard (only the interface declaration and its own implementation). `listAllAccountSummaries` covers the only real need. | Remove the method from the store + the `ProviderCatalogStore` interface (and any test double implementing it). |
| 5 | DEAD-CODE | `src/console/routing/model/routes.ts` | 19–24 | `ComboSchemaParity` / `ExpectComboParity` are exported type aliases used only inside the same file (compile-time parity check). | Remove `export` (keep the intra-file check). |
| 6 | DEAD-CODE | `src/console/routing/pools/routes.ts` | 18 | `import { parseProxyFile } from "./import-parse"` — used only inside a JSDoc `{@link parseProxyFile}` (line 49), never in code. | Remove the import (drop or de-link the JSDoc reference). |

## DUPLICATION

| # | Severity | File | Line | What | Suggested fix |
|---|----------|------|------|------|---------------|
| 7 | DUPLICATION | `src/console/providers/oauth/callback-listener.ts` 414–425, `src/console/providers/oauth/routes.ts` 391–400, `src/console/dashboard-assets.ts` 80 | Three byte-identical HTML entity-escaping functions (`escapeHtml` / inline map in `failurePage`) with the same `Record` of five entities. | Extract one `escapeHtml` into `src/console/shared/` and reuse from all three. |
| 8 | DUPLICATION | `src/console/quota/quota-view.ts` 163–173 vs `src/console/providers/catalog/store-helpers.ts` 273–285 | `liveModelCooldowns` implemented twice (private copy in quota-view; exported copy in store-helpers). Both filter expired timestamps; only the return shape differs (`Record` vs `{modelCooldowns: Record} | undefined`). | Keep the `store-helpers` version as the single owner and have `quota-view` adapt the return shape (or move both to `shared/`). |
| 9 | DUPLICATION | `src/console/providers/catalog/store.ts` 713–728 (`mapUsage`), 1057–1072 (`toUsage`), `src/console/share/share-usage.ts` 96–111 (`tokenUsage`) | Three near-identical `Number(row?.x ?? 0)` converters from a `{requests, errors, inputTokens, outputTokens}` row to a `ProviderAccountTokenUsage`-like object, each recomputing `totalTokens`. | Extract one `toTokenUsage(row)` helper (probably in `src/console/shared/`) and reuse in all three call sites. |
| 10 | DUPLICATION | `src/console/providers/catalog/provider-operations.ts` | 455–475 vs 516–537 | The credentialKind/credentialMode validation block is copy-pasted between `createAccount` and `createAccountBatch`. | Extract `validateAccountCredentialRequest(request)` and call from both. |
| 11 | DUPLICATION | `src/console/quota/account-quota-tenant.ts` | 481–491, 561–568, 931–938, 1000–1008, 1092–1099, 1120–1127 | Same “select account row WHERE id = ? AND tenant_id = ? limit 1 → 404 if missing” pattern repeated six times (quota, refresh, checkin, activity-report, resets, reset, and DELETE). | Extract `loadOwnedAccount(db, tenantId, accountId)` returning `{account} | {status:404, body}`; call from all routes. |
| 12 | DUPLICATION | `src/console/quota/account-quota-tenant.ts` 721–737 vs `src/console/quota/account-quota-global.ts` 53–69 | The `active`/`status` body normalization + `ACCOUNT_STATUSES` validation is duplicated between tenant and global PATCH handlers. | Share one `resolveNextStatus(body)` helper (e.g. in `account-quota-shared.ts`). |
| 13 | DUPLICATION | `src/console/routing/model/store.ts` | 186–206 vs 339–361 | `renameAlias` and `renameCombo` both implement the same JSONB `members` array rewrite loop over the tenant's rows (plus the single-value target rewrite). | Extract `rewriteMemberReferences(tx, tenantId, oldName, newName)` used by both renames. |
| 14 | DUPLICATION | `src/console/routing/pools/operations.ts` | 591–633 vs 652–696 | `probeAdHocProviderBatch` and `probeAdHocPoolBatch` are structurally identical bounded worker-pool loops; they differ only in the probe call and the per-item result shape. | Extract a generic `runBoundedProbe<T>(requests, concurrency, probe, mapResult)` worker. |
| 15 | DUPLICATION | `src/console/routing/pools/operations.ts` | 208–232 vs 335–354 | `createPoolBatch` builds a `NetworkPoolRecord` literal that duplicates `createPool`'s record build (same defaults, same spread patterns, same validation calls). | Extract `buildPoolRecord(request, tenantId)` and use it in both paths. |
| 16 | DUPLICATION | `src/console/routing/pools/operations.ts` | 49–77 vs 78–106 | `listPools` and `getPoolDetail` repeat the identical enrichment block (providerCooldowns mapping, inflight, available, utilization). | Extract `enrichPoolResponse(res, poolId)` and call from both. |
| 17 | DUPLICATION | `src/console/updates/version-compare.ts` 48–73 vs `src/providers/operations/client-version-resolver.ts` 130 | Two independent semver comparators in the repo (`compareVersions` on parsed tuples vs on plain strings). | Consider one shared semver module (or document why the two must stay separate). |
| 18 | DUPLICATION | `src/console/providers/catalog/public-model-store.ts` 237 vs `src/console/routing/model/contracts.ts` 116 | The alias-graph depth bound is declared twice as the same value (16): `MAX_TARGET_DEPTH` and `MAX_ALIAS_DEPTH`. | Hoist a single `ALIAS_RESOLUTION_MAX_DEPTH` constant into a shared module and import from both. |

## BLOAT

| # | Severity | File | Line | What | Suggested fix |
|---|----------|------|------|------|---------------|
| 19 | BLOAT | `src/console/providers/oauth/routes.ts` | 466–482 vs 483–488 | The “bind the redirect's loopback port” comment block is written twice almost verbatim; the second copy sits directly above the `return` after `savePending` already ran `register`. | Delete the duplicated comment block (keep one accurate copy next to the `register` call). |
| 20 | BLOAT | `src/console/providers/catalog/store.ts` | 801–813 | Two orphaned JSDoc blocks (“Next free list position…” and “Labels already in use…”) float above `generateAccountLabel` attached to nothing (the real docs live on the helpers). | Fold into the actual method doc or delete. |
| 21 | BLOAT | `src/console/routing/pools/store.ts` | 171–178 | `map()` uses an IIFE `(() => { … })()` solely to compute `storedProviderProbe(row, endpoint ?? "")`; every sibling field is a plain conditional spread. | Replace the IIFE with a local `const probe = ...` and a normal spread, matching the rest of the object. |

## ANTI-PATTERN

| # | Severity | File | Line | What | Suggested fix |
|---|----------|------|------|------|---------------|
| 22 | ANTI-PATTERN | `src/console/updates/routes.ts` | 105–119 | `POST /updates/apply` spawns a detached shell (`npm install -g … && restart`), ignores the child entirely (no `error`/`exit` listener, no exit-code check), then unconditionally runs `setTimeout(() => process.exit(0), 1500)` — killing the gateway even if the install failed, and without surfacing any failure. This is a destructive control path with no verification. | Wait for the child to exit, check exit code, report success/failure to the caller, and do not `process.exit` from inside a route handler (or move this behind an explicit operator-confirmed script with proper handling). |
| 23 | ANTI-PATTERN | `src/console/routing/pools/operations.ts` 278–279/392/455, `src/console/share/share-router.ts` 290 | Many best-effort cleanups use `.catch(() => undefined)` / `void …catch(() => undefined)`, silently swallowing agent-release and cooldown-clear failures. Individually defensible, but the pattern is pervasive and hides real cleanup failures. | At minimum log those failures at debug/trace level so agent leaks are discoverable; consider a shared `ignoreError` helper that logs. |

## OPTIMIZATION-OPP

| # | Severity | File | Line | What | Suggested fix |
|---|----------|------|------|------|---------------|
| 24 | OPTIMIZATION-OPP | `src/console/providers/catalog/store.ts` | 814–834 + 1319–1356 | `generateAccountLabel` issues a full SELECT of all existing labels for the provider on every account creation lacking a label; `createAccountBatch` walks each request through `createAccount` → `generateAccountLabel`, so an unlabeled N-item paste performs N full label reads (O(N·M), plus per-item savepoint overhead). | Read the existing labels once per batch up front and generate the next label incrementally (e.g. pass a shared “existing labels” set into `createAccount`), keeping single-create behavior unchanged. |
| 25 | OPTIMIZATION-OPP | `src/console/remote-support/service.ts` | 317–327 | `launchDetached` re-runs `where`/`which` via `spawnSync` even though `toolAvailable` already cached the resolution in `installedCache` (lines 34, 69–85). | Have `launchDetached` consult `toolAvailable`'s cached result (or share one resolver) instead of a second spawn per start. |
| 26 | OPTIMIZATION-OPP | `src/console/routing/pools/operations.ts` | 49–77 | `listPools` awaits `getPoolCooldowns` and `getInflightAuthoritative` per pool (parallel across pools, but 2 round-trips per pool). On a tenant with many pools this is N×2 coordinator round-trips per page load. | If the selector exposes a bulk read (cooldowns/inflight for many ids), use it; otherwise batch the selector calls. |

## STALE

| # | Severity | File | Line | What | Suggested fix |
|---|----------|------|------|------|---------------|
| 27 | STALE | `src/console/routing/pools/probe-verdict.ts` | 91 | `RETRYABLE_TRANSPORT_CODES` contains `"ECONNECT_TIMEOUT"` (typo; not a real errno — the real code is `ECONNREFUSED`/`ETIMEDOUT`). Harmless because it never matches, but it is a dead entry that implies a code that does not exist. | Remove the bogus entry. |
| 28 | STALE | `src/console/providers/catalog/contracts.ts` | 887–944 | `ProviderRoutingResponse` and `UpdateProviderRoutingRequest` are declared in the *catalog* contracts but consumed only by the `providers/detail` domain (which imports them from `../catalog/contracts`). They are misplaced ownership, not shared contract. | Move the two types into `src/console/providers/detail/contracts.ts` and update the two importers (`detail/store.ts`, `detail/routes.ts`). |
| 29 | STALE | `src/console/providers/catalog/store.ts` | 31 | `const emptyUsage: ProviderAccountTokenUsage = …` is duplicated as a local literal inside `createAccount` (`!includeUsage` branch, line 1279) and as `emptyUsage` fallbacks in `mapPoolAccount`/`poolUsage`. Two shapes, same meaning. | Keep one exported `EMPTY_TOKEN_USAGE` constant and reuse it everywhere. |

---

## Summary counts

| Severity | Count |
|----------|-------|
| DEAD-CODE | 6 |
| DUPLICATION | 12 |
| BLOAT | 3 |
| ANTI-PATTERN | 2 |
| OPTIMIZATION-OPP | 3 |
| STALE | 3 |
| **Total findings** | **29** |

---

## OK — verified clean

- `src/console/providers/catalog/public-model-store.ts` — cache/eviction/LRU logic is sound and well-bounded; `resolveTargetIds`/`advertisedMetadata` are exported for good reason (tests + api-keys/dashboard consumers); no `any`, no suppression directives.
- `src/console/providers/catalog/catalog-projections.ts`, `contracts.ts`, `store-helpers.ts` — single-owner projections; the compile-time coverage guards (`_wireFamilyCoverage`, `_serviceKindCoverage`) are legitimate.
- `src/console/providers/detail/*` — small, well-factored; bound constants live in one place.
- `src/console/quota/account-quota-shared.ts`, `native-identity.ts`, `account-test-egress.ts` — clean; deps are minimal and the egress selection matches dispatch.
- `src/console/remote-support/service.ts` (aside from finding 25) — process lifecycle handling is thorough (detached, unref, pid liveness, TTL, `taskkill` tree kill).
- `src/console/routing/pools/probe-result.ts`, `relay-regions.ts`, `speed-test-sizes.ts`, `relay-deploy.ts` — cohesive, dependency-light, testable.
- `src/console/routing/model/contracts.ts` — `aliasCycleExists`/`targetResolves`/`partitionResolvableMembers` are shared correctly by create/update/clone.
- `src/console/settings/*` — the normalize/validate/store split is consistent; `runtimeUpdateBody` mirrors the store bounds.
- `src/console/share/share-stats.ts` / `share-usage.ts` — cache keys are correct (privacy-aware, family-sized); SQL is batched rather than N+1.
- `src/console/shared/*` — `cursor.ts`, `read-through-cache.ts`, `errors.ts`, `query.ts`, `day.ts`, `ip-privacy.ts`, `elysia-schema.ts` are all single-owner, well-documented, and free of `any`/suppressions.
- `src/console/system-prompt/*` — validation is centralized; `t.Any()` body is deliberately hand-validated with bounded limits.
- `src/console/updates/version-compare.ts` / `repository-updates.ts` — pure, dependency-free, test-covered (finding 22 is the only concern, in `routes.ts`).

Evidence note: no `.codegraph/` directory exists at repo root, so all relationship checks were done via `grep` over the full repo (`src/`, `test/`, `scripts/`, `dashboard/src/`).

---

## Execution status

- **Area execution:** 17 file(s) changed in this scope during the cleanup pass; `bunx tsc --noEmit` clean and full backend suite green (4217 pass / 0 fail, protocol 591 pass / 0 fail).
- **Confirmed done (✅):** Console-wide shared helpers landed (escapeHtml, tokenUsage, loadOwnedAccount patterns).
- **Not done / skipped (⛔):**
  - #22 POST /updates/apply destructive `process.exit` — deliberately skipped (needs operator-confirmed design) ⛔
- **Note:** this status reflects the orchestrator's verification of representative findings, not an item-by-item re-audit of every finding in this report.
