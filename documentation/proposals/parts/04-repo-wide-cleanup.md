# Audit part — Repo-wide cleanup

Status: audited (first pass)
Scope: scripts, tests, docs/config generation, migrations/persistence touchpoints, cross-cutting deadness

---

## Findings

### 1. Config governance is split across multiple hand-maintained allowlists and docs

- **Verdict:** merge to one typed source of truth
- **Behavior change?:** no
- **Severity:** HIGH
- **Effort:** M/L
- **Evidence:**
  - `scripts/tools/generate-config.ts:148-153`
  - `documentation/reference/configuration.md:12-17`
  - `test/config/spec-env-example-bijection.test.ts:35-79`
  - `test/config/no-direct-env-reads.test.ts:53-109`
  - runtime non-spec env reads in `src/persistence/db-pg.ts:51-57`, `:102-163`, `src/persistence/redis.ts:17-54`, `src/observability/logger.ts:10`, `:25`
- **Current behavior:** one canonical config spec exists, but docs/tests/scripts
  each maintain their own side allowlists/exclusion lists.
- **Why it matters:** classic policy drift. Every new env knob pays a multi-file
  maintenance tax.
- **Recommended cut:** replace the repeated manual lists with one typed metadata
  registry that drives docs and tests together.
- **Likely follow-up:** tests + docs.

### 2. Migration inventory/order is duplicated in runtime, tests, and docs

- **Verdict:** deduplicate onto one canonical mechanism
- **Behavior change?:** no
- **Severity:** HIGH
- **Effort:** M
- **Evidence:**
  - Canonical runtime helper: `src/persistence/migrate.ts:20-37`
  - Duplicate discovery in `scripts/test/check-migrations.ts:43-63`
  - Hard-pinned list in `test/persistence/sqlite-baseline.test.ts:41-98`
  - Direct migration-dir reads in `test/persistence/sqlite-baseline.test.ts:42-43`, `:101`
  - Docs: `migrations/README.md:3-17`, `documentation/reference/sqlite-parity.md:5-10`
- **Current behavior:** migration discovery/order is implemented more than once,
  and tests hard-pin the full filename list.
- **Why it matters:** every schema change pays extra churn and stale-list risk.
- **Recommended cut:** reuse `migrationFiles()` / `migrationIdFor()` everywhere;
  replace the hard-coded expected list with parity assertions unless exact
  ledger history is intentionally pinned.
- **Likely follow-up:** tests, maybe docs.

### 3. `scripts/migrate-pg-to-sqlite.ts` conflicts with the documented cutover story

- **Verdict:** hard keep-or-cut decision
- **Behavior change?:** maybe
- **Severity:** HIGH
- **Effort:** M/L
- **Evidence:**
  - Docs say backend changes are backup-export → fresh DB → restore:
    `documentation/installation.md:123-125`, `:178-185`
  - Runtime migration guard says recreate + restore from backup:
    `src/persistence/migrate.ts:100-134`
  - Direct operational copier still exists: `scripts/migrate-pg-to-sqlite.ts:1-23`
  - Rebuilds target file: `scripts/migrate-pg-to-sqlite.ts:229-233`
  - Copies only shared columns: `scripts/migrate-pg-to-sqlite.ts:168-173`
  - Logs every PG query text/params: `scripts/migrate-pg-to-sqlite.ts:223-227`
  - Still advertised in changelog: `CHANGELOG.md:1309`
- **Current behavior:** docs moved to backup/restore cutover, but a direct
  PG→SQLite copier still ships as a separate operator path.
- **Why it matters:** that is an expensive compatibility surface with unclear
  support status.
- **Recommended cut:** decide whether it is still supported. If not, remove it
  and its mentions. If yes, promote it to a first-class supported contract with
  tests/docs/security cleanup.
- **Likely follow-up:** docs, tests, maybe migration/cutover comms.

### 4. Test scope wiring has drifted; backend scope still runs script/CLI and one integration case

- **Verdict:** simplify scope semantics
- **Behavior change?:** yes (test selection semantics)
- **Severity:** MED/HIGH
- **Effort:** S/M
- **Evidence:**
  - Runner comments: `scripts/test/run.ts:24-33`
  - Backend scope pushes script/CLI tree + one integration case:
    `scripts/test/run.ts:43-50`
  - Separate scopes still exist: `scripts/test/run.ts:213-225`
  - Package scripts expose these scopes as if cleanly separated:
    `package.json:44`, `:54`, `:60-69`
- **Current behavior:** scope names imply clean separation, but backend includes
  extra trees by policy.
- **Why it matters:** local/CI runs are harder to reason about and potentially
  slower than they look.
- **Recommended cut:** decide whether backend means “all non-dashboard” or keep
  true separation and stop implicitly pulling script/CLI/integration cases in.
- **Likely follow-up:** tests + minor docs.

### 5. Provider scratch / one-off tools live under `test/tools/`

- **Verdict:** move or delete
- **Behavior change?:** no
- **Severity:** MED
- **Effort:** S/M
- **Evidence:**
  - `test/tools/qoder-native-claim.oneoff.ts`
  - `test/tools/qoder-native-dump.oneoff.ts`
  - `test/tools/qoder-regen-test.oneoff.ts`
  - `test/tools/qoder-db-claim.oneoff.ts`
  - `test/tools/qoder-db-decrypt.oneoff.ts`
  - `test/tools/qoder-db-reward.oneoff.ts`
  - `test/tools/qoder-login-probe.oneoff.ts`
  - Example mutation of input file: `test/tools/qoder-native-claim.oneoff.ts:75-79`, `:131`, `:153`, `:158`
  - Hard-coded/local assumptions: `test/tools/qoder-db-claim.oneoff.ts:11-17`, `test/tools/qoder-db-decrypt.oneoff.ts:5-11`
- **Current behavior:** operational scratch scripts live in the test tree, some
  mutating state or assuming local paths/secrets.
- **Why it matters:** muddies the test tree and creates maintenance/security
  review drag.
- **Recommended cut:** move keeper scripts under `scripts/tools/` or a provider
  probing area; delete anything no longer a stable maintenance tool.
- **Likely follow-up:** maybe docs/test discovery touch.

### 6. Path resolution is inconsistent; scripts/tests still lean on `process.cwd()`

- **Verdict:** normalize shared root resolution
- **Behavior change?:** no
- **Severity:** MED
- **Effort:** S/M
- **Evidence:**
  - Shared root helper exists: `scripts/cli/env.ts:6-18`
  - Runtime path resolution exists: `src/persistence/migrate.ts:20-25`
  - CWD-based tests/scripts: `test/config/config-reference.test.ts:20`, `test/config/spec-env-example-bijection.test.ts:81`, `test/persistence/sqlite-baseline.test.ts:28`, `:42-43`, `:101`, `scripts/dev/supervisor.ts:73`, `:88`, `:127`
- **Current behavior:** mixed `PACKAGE_ROOT`, `process.cwd()`, and ad hoc
  path resolution across scripts/tests.
- **Why it matters:** fragile in worktrees, packaging, and alternate launch
  contexts.
- **Recommended cut:** one shared project/package-root helper for scripts/tests.
- **Likely follow-up:** tests only.

### 7. Dotenv parsing is duplicated across scripts

- **Verdict:** deduplicate
- **Behavior change?:** no
- **Severity:** LOW/MED
- **Effort:** S
- **Evidence:**
  - Shared reader: `scripts/cli/env.ts:24-39`
  - Duplicate parser in `scripts/test/run.ts:57-69`
  - Duplicate parser in `scripts/test/check-db.ts:18-28`
- **Current behavior:** multiple tiny env-file parsers with near-identical logic.
- **Why it matters:** small but needless script-layer drift.
- **Recommended cut:** reuse `readEnvFile()` / shared path helpers from
  `scripts/cli/env.ts`.
- **Likely follow-up:** minimal.

---

## Recommended execution order

1. Config/env/doc contract unification
2. Migration inventory/parity deduplication
3. Decide keep-or-cut for `scripts/migrate-pg-to-sqlite.ts`
4. Test scope simplification
5. Purge or move `test/tools/*.oneoff.ts`
6. Path/env helper consolidation
7. Dotenv parser deduplication

---

## Execution status

- ⛔ Audit only; no implementation yet.
