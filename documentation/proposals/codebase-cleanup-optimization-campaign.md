# Proposal — Codebase cleanup & optimization campaign

Status: proposed — audit complete, awaiting approval
Tanggal: 2026-11-08
Scope: routing, transport, provider operations, account health, quota refresh,
console API, dashboard, scripts, tests, config/docs generation, and cross-cutting
repo cleanup.
Method: parallel subagent audits by area, then one composed execution proposal.

---

## 1. Kondisi saat ini (dari kode)

This master proposal is grounded in the four area reports under
`documentation/proposals/parts/` plus two narrow second-pass audits. Every
finding in the summary table traces back to code evidence in those part files.

### Area reports

- `documentation/proposals/parts/01-routing-transport.md` — audited
- `documentation/proposals/parts/02-provider-health.md` — audited
- `documentation/proposals/parts/03-console-dashboard.md` — audited
- `documentation/proposals/parts/04-repo-wide-cleanup.md` — audited

---

## 2. Masalah yang diminta diatasi

Requested outcome:

- audit the whole codebase,
- identify old/duplicate/dead/cutoff code and stale compatibility paths,
- simplify and merge where one canonical owner should remain,
- improve runtime cost (fewer unnecessary allocations, sorts, DB round-trips,
  rebuilds, or duplicate transforms),
- make any required migrations/cutovers explicit rather than hiding them behind
  shims,
- produce a decision-ready campaign before implementation.

This proposal will prioritize changes that improve correctness, maintainability,
cutover completeness, and measurable runtime cost. Cosmetic churn is out.

---

## 3. Desain yang diusulkan

Composed from four area audits plus two narrow second-pass audits (routing and
provider-health).

Recommended execution method:

1. take the safe-first wins first,
2. then complete contract/boundary cutovers,
3. then do the risky or migration-worthy pieces with explicit approval,
4. keep edits file-disjoint per cluster,
5. run full validation only after all approved clusters land.

### Execution clusters

#### Cluster A — safe-first perf / simplification

- per-plan memoization of account-scoped quota/cache reads
- duplicate combo lookup collapse
- decouple snapshot rebuild from provider-catalog refresh
- hot-path `console_settings` scan collapse to `EXISTS`
- account-health auth pre-read collapse
- quota-refresh invalidation gap closure
- quota-refresh write collapse / transaction boundary cleanup
- quota-cache read-before-write simplification
- quota-refresh write-amplification guards
- global provider polling cleanup for route labels
- immutable routing-config read hoisting
- dead `sticky_account_id` removal
- likely-dead top-level `poolRouting` removal after consumer check
- rebuild-path duplicate copy/freeze simplification
- provider-alias normalization in cooldown rules
- path/env helper consolidation
- dotenv parser deduplication

#### Cluster B — contract / boundary cleanup

- browser-safe dashboard import boundary enforcement
- InferHub DTO ownership merge
- `SharedKeyPage` contract canonicalization
- compatibility-profile contract cutover
- route/nav/title manifest merge
- config/env/doc contract unification
- migration inventory/parity deduplication
- `/system/performance` deadness validation and cut-or-document decision
- move or purge `test/tools/*.oneoff.ts`
- test-scope semantics cleanup

#### Cluster C — risky cutovers / migration-worthy work

- unified-routing flag removal and canonicalization
- account-error classification table split/refactor
- legacy `policy_blocked` migration or explicit normalization
- keep-or-cut decision on `scripts/migrate-pg-to-sqlite.ts`
- any remaining dead compatibility field/category removal that touches stored rows

### Summary table

| Finding | Verdict | Behavior change? | Severity | Effort | Owner |
|---|---|---:|---|---|---|
| Unified-routing rollout flag | Cutover candidate | Yes | HIGH | M | Routing / transport |
| Per-candidate repeated quota/cache fetch work | Performance cleanup | No | HIGH | M | Routing / transport |
| Duplicate combo candidate lookups | Simplify | No | MED | S | Routing / transport |
| Duplicate pool-routing representations | Internal contract cleanup | No | MED | S/M | Routing / transport |
| Snapshot rebuild coupled to provider-catalog refresh | Rebuild-path performance cleanup | No | HIGH | M | Routing / transport |
| Hot-path config env reads in planner | Small perf/clarity cleanup | Maybe | LOW/MED | S | Routing / transport |
| Dead `sticky_account_id` field | Dead-field cleanup | No | LOW | S | Routing / transport |
| Rebuild-path duplicate copy/freeze work | Rebuild-path simplification | No | MED | S/M | Routing / transport |
| Candidate-index filtered-array allocation | Optional micro-opt | No | LOW | S/M | Routing / transport |
| Hot-path `console_settings` scan in failure path | Cleanup + perf fix | No | HIGH | S/M | Provider health |
| Quota-refresh invalidation gap | Correctness cleanup | Maybe | HIGH | M | Provider health / routing |
| Quota-refresh serial writes / missing transaction | Write-path cleanup | No | HIGH | M | Provider health / quota |
| `setCachedQuota()` read-before-write cost | Cache-path perf cleanup | No | MED | M | Provider health / quota |
| `applyAccountVerdict()` no transaction boundary | Transactional cleanup | No | MED | M | Provider health |
| Quota-refresh write amplification | Write-amplification cleanup | No | LOW/MED | S/M | Provider health / quota |
| Overgrown order-sensitive classification table | Refactor / cutover | Maybe | HIGH | M/L | Provider health |
| Compatibility-profile contract drift | Contract cleanup | Maybe | HIGH | M | Provider catalog / console API |
| Account-health auth pre-read duplication | Simplify | No | MED | S/M | Provider health / console |
| Legacy `policy_blocked` compatibility state | Cleanup with migration/read mapping | Maybe | MED | M | Provider health |
| Provider alias duplication in cooldown rules | Simplify | No | LOW/MED | S | Provider health |
| Dashboard bypasses browser-safe contract boundary | Boundary cutover | No | HIGH | M | Console/dashboard |
| InferHub DTO family duplicated client/server | Merge to one shared DTO owner | No | HIGH | M | Console/dashboard |
| `SharedKeyPage` mirrored by hand | Contract cleanup | No | MED/HIGH | S/M | Console/dashboard |
| Route/nav/title metadata duplicated | Merge to one manifest | Maybe | MED | M | Dashboard |
| Global provider polling for route labels | Performance cleanup | No | MED | S/M | Dashboard |
| Possibly unused `/system/performance` console API | Validate deadness then cut/document | Maybe | LOW/MED | S | Console API |
| Config governance split across spec/tests/docs | Merge to one source of truth | No | HIGH | M/L | Repo-wide config/docs |
| Migration inventory/order duplicated | Deduplicate to canonical mechanism | No | HIGH | M | Persistence / tests |
| `scripts/migrate-pg-to-sqlite.ts` vs documented cutover | Keep-or-cut decision | Maybe | HIGH | M/L | Scripts / persistence |
| Test scope semantics drift | Simplify / clarify | Yes | MED/HIGH | S/M | Scripts / tests |
| `test/tools/*.oneoff.ts` under test tree | Move or delete | No | MED | S/M | Repo-wide scripts/tests |
| Inconsistent root/path resolution | Normalize shared root helpers | No | MED | S/M | Repo-wide scripts/tests |
| Duplicated dotenv parsing | Deduplicate | No | LOW/MED | S | Repo-wide scripts |

---

## 4. File yang tersentuh

The campaign spans four owner groups:

| Area | Start with |
|---|---|
| Routing / transport | `src/transport/`, `src/config/routing.ts`, `src/config/spec.ts` |
| Provider ops / health / quota | `src/providers/operations/`, `src/providers/quota/`, `src/providers/provider-metadata.ts` |
| Console / dashboard | `src/console/`, `dashboard/` |
| Repo-wide / scripts / docs / tests | `scripts/`, `test/`, `documentation/reference/`, `migrations/` |

See the part files for exact file-level evidence and candidate touch lists.

---

## 5. Migrasi & risk

Expected risk types in this campaign:

- **Contract cutovers** where duplicated mirrors or partial public/runtime shapes drift
  (`compatibility-profile`, dashboard contract mirrors, route manifests).
- **Behavior cutovers** where the code still carries rollout seams or stale dual
  behavior (`unified-routing`, test-scope semantics).
- **Historical compatibility cleanup** where stored rows or scripts may still
  depend on legacy states (`policy_blocked`, `migrate-pg-to-sqlite.ts`).
- **Write-path correctness cleanup** where snapshot invalidation or transaction
  boundaries may currently be too weak (`quota refresh`, `applyAccountVerdict`).
- **Config/doc/test consolidation** where multiple side registries drift from the
  canonical spec.

Verification baseline during execution:

- `bun run typecheck`
- `bun run test`

Counts should be captured immediately before execution and again after the last
approved cluster lands.

---

## 6. Pertanyaan terbuka

These are the operator decisions that materially change execution order or scope:

1. **Unified routing cutover now, or safe-first first?**
   - **Recommendation:** safe-first first. Take the non-semantic routing wins
     (memoization, duplicate lookup collapse, rebuild decoupling, dead-field
     pruning), then cut over the unified-routing flag once the planner is
     simpler and the stricter behavior is easier to observe.

2. **Keep or cut `scripts/migrate-pg-to-sqlite.ts`?**
   - **Recommendation:** cut it unless there is active operator use to preserve.
     The documented product story already says backup/export → fresh DB →
     restore; carrying a silent parallel migration path is expensive.

3. **Legacy `policy_blocked`: migrate rows or normalize at read time first?**
   - **Recommendation:** normalize at read time first if the row volume or state
     ambiguity is unknown, then migrate/remove once the rendering/ops behavior is
     proven. If the row volume is small and well understood, one explicit
     migration is cleaner.

4. **Test scope semantics: preserve current behavior under a clearer name, or
   restore strict scope boundaries?**
   - **Recommendation:** restore strict boundaries unless CI depends on the wider
     current behavior. Hidden scope widening is worse than an explicit composite
     script.

5. **Candidate-index filtered-array allocation worth touching now?**
   - **Recommendation:** no, unless profiling says combo/alias lookup is hot.
     Keep it out of the first execution tranche; it is a micro-opt compared with
     the larger wins already identified.

---

## 7. Execution status

Audit complete; implementation not started.

- ✅ Four area audits composed into one campaign proposal.
- ✅ Narrow second-pass audits completed for routing and provider-health write paths.
- ⛔ No implementation yet; awaiting approval and cluster selection.
