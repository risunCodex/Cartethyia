# Report 06 — observability + persistence

Scope: `src/observability/**` (18 files) and `src/persistence/**` (24 files). Every `.ts` file read in full; every finding verified by grepping the whole repo (`src/`, `test/`, `scripts/`, `dashboard/src/`). No files were modified.

---

## 1. DEAD-CODE (exported symbols with no production caller)

### D1 — `event-query.ts`: superseded SQL readers left behind after `summarizeUsageWithPerformance` merged them
File: `D:\MyGitRepository\Projects\HoneyC\ProxyRouter-Project\Cartethyia\src\observability\event-query.ts`
- `summarizeTelemetry` (line 429) — only caller is `test/console/telemetry-sql-queries.test.ts` (line 27, 106). Production console uses `summarizeUsageWithPerformance` (`src/console/observability/store.ts:335,431,485,670`).
- `healthTelemetry` (line 718) — only caller is the same test (line 25, 198). Production references are comments only (`src/console/observability/store.ts:332`).
- `eventByRequestId` (line 406) — only caller is the same test (line 24, 357).
- `summarizeUsagePerformanceSql` (line 1043) — zero references anywhere (not even tests); only a comment at `store.ts:200`.
- `summarizeHealthPerformance` (line 994) — zero references anywhere.
- `familyUsageTotals` (line 849) — zero references anywhere (share page uses `familyKpiTotals` + `familyWindowRequests`).
Suggestion: delete the five functions with no production caller (keep tests in sync, or move the test assertions onto `summarizeUsageWithPerformance`). `summarizeUsageWithPerformance` (line 1082) is the live reader.

### D2 — `event-log.ts`: the entire file-reader surface is test-only leftovers
File: `D:\MyGitRepository\Projects\HoneyC\ProxyRouter-Project\Cartethyia\src\observability\event-log.ts`
The module doc (line 7–12) still claims the JSONL files are the "single source" for recent requests, but the canonical reader is now SQL (`event-query.ts`). Production imports of this module use only `TELEMETRY_EVENT_DIR` and the `TelemetryEventRecord` type:
- `readTelemetryEvents` (line 250) — only caller `test/helpers/fixtures.ts:476`.
- `queryTelemetryEvents(query)` (line 297) — only callers `test/observability/telemetry-buffer.test.ts:107`, `test/observability/raw-event-retention.test.ts:83,95`.
- `emptyTotals` (line 392), `accumulate` (line 399) — only caller `test/observability/cached-token-totals.test.ts:52`.
- Private support code becomes dead with them: `readEventFiles` (196), `readEventFileTail` (138), `matches` (283), `EventQuery` (258), `eventFileHour` (123).
Suggestion: keep the live exports (`TELEMETRY_EVENT_DIR`, `TelemetryEventRecord`); move the test-only reader (or the tests' expectations) to `event-query.ts` and delete the rest. At minimum, fix the module doc.

### D3 — `request-notify.ts`: `resetRequestNotifyForTests` unreferenced
File: `...\src\observability\request-notify.ts` line 41. Zero references in the entire repo (no test imports it). Remove; if a future test needs it, export it then.

### D4 — `performance-metrics.ts`: `resetPerformanceMetricsForTesting` unreferenced
File: `...\src\observability\performance-metrics.ts` line 76. Zero references repo-wide. Remove.

### D5 — `log-ring.ts`: `resetConsoleLogsForTests` unreferenced
File: `...\src\observability\log-ring.ts` line 156. Zero references repo-wide. Remove.

### D6 — `payload-store.ts`: `payloadWriterBacklog` test-only diagnostic seam
File: `...\src\observability\payload-store.ts` line 109. The only consumers are `test/observability/payload-backlog.test.ts` (lines 24, 75–150). No production surface reads backlog occupancy. Either privatize (grep for callers first) or keep and document as test-only.

### D7 — `metrics.ts`: `cartethyia_telemetry_raw_conflicts_total` registered, never incremented
File: `...\src\observability\metrics.ts` lines 305, 421–424. Declared and registered but no `.inc()` call anywhere (the reconciliation job computes conflicts locally and never publishes them). Dead metric — remove the family or wire it into `telemetry-reconciliation.ts` `insertChunk` (line 399).

---

## 2. DUPLICATION (same logic written more than once)

### U1 — UUID validation regex triplicated
- `...\src\persistence\usage-flush.ts` line 7 (`UUID_RE`)
- `...\src\persistence\stores\telemetry-store.ts` line 73 (`UUID_RE`)
- `...\src\providers\integrations\claude\claude.ts` line 131
Identical `^[0-9a-f]{8}-…$` regex, same intent (refuse non-uuid input). Extract one `isUuid(value)` helper (e.g. in `src/persistence/` or `src/shared/`) and reuse in all three.

### U2 — epoch-bucket SQL expression duplicated 3× in `event-query.ts`
File: `...\src\observability\event-query.ts`
The `isPostgres(db) ? (cast(extract(epoch …)/w)*w : (cast(strftime('%s' …)/w)*w` block appears verbatim at:
- `chartTelemetry` lines 637–639
- `providerUsageMatrix` lines 689–691
- `familyHourlyTelemetry` lines 954–956
Extract `bucketExpression(db, column, width)` (or `dayExpression` for 86400) into one helper; the "inlined for Postgres 42803" comment at line 636 belongs to the helper, once.

### U3 — aggregate column list duplicated between `summarizeTelemetry` and `summarizeUsageWithPerformance`
File: `...\src\observability\event-query.ts`. The SELECT at lines 437–448 (`requests/errors/cancelled/truncated/inputTokens/outputTokens/cachedInputTokens/reasoningTokens/estimatedCostUsd/sampled/latencyAvg/unpriced`) is a subset of the SELECT at lines 1089–1104. Since `summarizeUsageWithPerformance` supersedes `summarizeTelemetry` (see D1), express one in terms of the other (or delete the older one).

### U4 — coalescing flush-buffer skeleton duplicated
- `...\src\persistence\usage-flush.ts` (`UsageFlushBuffer`, line 101)
- `...\src\persistence\health-event-flush.ts` (`HealthEventFlushBuffer`, line 66)
Both implement the same shape (enqueue → timer → `flush()` → `stop()`, unref'd timer, failure streak/backoff, bounded pending). The module comment at `health-event-flush.ts:15` even says "Same shape as `persistence/usage-flush.ts`". Extract a shared bounded-coalescing-writer base (or a mixin) with the enqueue/timer/backoff plumbing; keep the per-consumer batch semantics.

### U5 — `maskClientIp` duplicated across the src/dashboard boundary
- `...\src\observability\redaction.ts` lines 19–45
- `...\dashboard\src\features\usage\usage-labels.ts` line 41
Same IPv4/IPv6 masking contract implemented twice (dashboard copy is the trim + tail-mask subset). Dashboard cannot import `src/`, so either move to a shared package/constants module both can import, or note the drift risk (the two already differ: dashboard copy lacks the IPv4-mapped-IPv6 tail handling at `redaction.ts:30-34`).

### U6 — gateway-error predicate duplicated in a script
File: `...\scripts\backfill-usage-totals.ts` line 23 defines a local `isGatewayError(status, httpStatus)` — a second copy of the rule in `src/observability/telemetry-status.ts` (line 115). Backfill script can import the canonical predicate (or the shared SQL constant) instead of re-deriving it, so a status-class change cannot silently desync a one-time backfill.

---

## 3. BLOAT

### B1 — `event-query.ts` is 1169 lines of near-identical SQL blocks
File: `...\src\observability\event-query.ts`. The `sum(case when ${IS_GATEWAY_ERROR_SQL} …)` + `coalesce(sum(...))` phrase is repeated across `breakdownTelemetry` (592–597), `chartTelemetry` (644–646), `healthTelemetry` (726–730), `familyHourlyTelemetry` (963–964), `summarizeUsageWithPerformance` (1091–1101). Introduce a shared `aggregateSelect()` fragment (or constants) to cut the repetition; most of the remaining size is justified by the backend dialect split.

### B2 — telemetry-reconciliation: the "did nothing" report object is spelled 4×
File: `...\src\observability\telemetry-reconciliation.ts`. The full `ReconcileReport` object with all-zero counters is repeated at lines 261–270, 277–285, and 292–301. Extract `emptyReport(owner, skippedReason)`.

### B3 — `HealthEventFlushBuffer.flush` silently discards the whole batch
File: `...\src\persistence\health-event-flush.ts` lines 157–160: `catch { }` drops every row in the batch with no log, no metric, no counter — an operator cannot tell audit rows are being lost. (usage-flush at least counts `droppedDelta` and retries per key.) At minimum, surface a drop counter (a `dropped` metric or reuse the existing `dropped` field which today only counts enqueue-time evictions).

### B4 — redundant `filesCompleted + 0` SQL update
See O1 — the expression is both a no-op and confusing dead code.

---

## 4. ANTI-PATTERN

### A1 — `as never` typing hole in health-event-flush
File: `...\src\persistence\health-event-flush.ts` line 152: `errorCategory: row.errorCategory as never`. `never` is a lie (the value is `string | null`); use the schema's actual column type or a union like the surrounding `fromStatus`/`toStatus` casts (which are also casts, but to real unions).

### A2 — error swallowing without observability in health-event-flush
File: `...\src\persistence\health-event-flush.ts` lines 157–160 (see B3). The `catch {}` swallows the write failure and the rows. The writer's own rationale ("must never fail a request") is sound, but the drop is invisible. Same class as A1's module.

### A3 — `shared-cache.ts` / `redis.ts` broad `catch {}` on every primitive
File: `...\src\persistence\shared-cache.ts` (`readShared` line 83, `writeShared` line 107, `deleteShared` line 125, `publishInvalidation` line 160) and `...\src\persistence\redis.ts` (`resolveRedisClient` line 72). All are documented ("a cache read must never fail a request"), but they also mask configuration errors (e.g. a malformed `REDIS_URL` silently degrades to memory backend with no log). A `log.debug`/`log.warn` on first failure would keep the fail-open behavior while making misconfiguration visible.

### A4 — module-level mutable singletons (accepted, but worth a note)
`payload-store.ts` (`backlog`/`backlogBytes`/`draining`, lines 104–106), `request-notify.ts` (`listeners`, line 19), `raw-event-writer.ts` (`states` map, line 110), `readiness.ts` (memo, lines 25–30), `telemetry-store`-adjacent `tenant-preferences.ts` (`preferencesCache`, line 77). Consistent with the repo's established singleton pattern and documented; flagging only so a future "no shared mutable module state" pass knows they exist deliberately.

---

## 5. OPTIMIZATION-OPP

### O1 — `telemetry-reconciliation.ts`: `filesCompleted` counter adds 0
File: `...\src\observability\telemetry-reconciliation.ts` line 396:
```ts
filesCompleted: sql`${telemetryReconciliationState.filesCompleted} + 0`,
```
The persisted checkpoint's `files_completed` column never changes (the intent is `+ 1` per completed file). The local `report.filesCompleted` is correct, so only the stored counter is wrong. Fix to `+ 1`, or drop the column if unused (the CLI prints `files completed` from the report, not the row — see `scripts/cli/telemetry.ts:59`).

### O2 — `api-key-store.listChildrenPage`: fourth query runs sequentially after `Promise.all`
File: `...\src\persistence\stores\api-key-store.ts` lines 446–476. The page/counts/template queries are parallelized (`Promise.all`), then `sumFamilyTelemetryConsumed` (line 469) runs as a separate awaited query (and itself runs a second SELECT with an `EXISTS` subquery, line 512–525). Include the family-telemetry SUM in the same `Promise.all` batch (or fold into the template query) to remove one round trip per page open.

### O3 — `runtime-metrics.sample()` writes each memory figure twice
File: `...\src\observability\runtime-metrics.ts` lines 192–205. `process.memoryUsage()` is read once, then each value is `metrics….set()` (193–196) and *again* `trackMemoryUsage(...)` (202–205), i.e. two map writes per sample per figure. Only `trackMemoryUsage` feeds the console performance endpoint; the two sinks could share one loop or one call, halving per-sample Map churn (minor, but the sample path joins a scheduled tick and any savings are free).

### O4 — `event-log.ts` `readEventFiles` allocates a fresh `TextDecoder` per file
File: `...\src\observability\event-log.ts` line 207 (`const decoder = new TextDecoder()` inside the per-file generator). Trivial but per-file allocation on a read path that is already chunked; hoist to the generator or reuse a module-level decoder.

### O5 — `telemetry-buffer.ts`: `estimateTelemetryEventBytes` walks a 10-element array per enqueue
File: `...\src\observability\telemetry-buffer.ts` lines 78–98. Called on every `enqueue` (line 301). Fine as a bound, but the fixed 512-byte envelope plus a small constant per populated field could be computed in O(1) with the same result; only relevant if enqueue volume is extreme (likely not worth changing).

---

## 6. STALE

### S1 — `event-log.ts` module doc contradicts the code
File: `...\src\observability\event-log.ts` lines 7–12 state the files are "the single source" for recent requests and "readers must go through this module", but production readers go through `event-query.ts` (SQL). Update the doc to describe the file layer as the at-least-once mirror/backfill source only (see also D2).

### S2 — `payload-capture.ts` class doc says "15 minutes by default"
File: `...\src\observability\payload-capture.ts` lines 413–416: "Payloads live for the tenant's chosen retention — 15 minutes by default". The actual default is 60 minutes (`DEFAULT_PAYLOAD_RETENTION_MS`, line 41, `payloadRetentionMs()` line 27). Stale doc — update to the constant, not the literal.

### S3 — dead metric `cartethyia_telemetry_raw_conflicts_total` (see D7)
Registered in `metrics.ts` (line 305/421) with no producer. Stale registration.

### S4 — `telemetry-reconciliation.ts`: collapsed `filesCompleted` column (see O1)
The `telemetry_reconciliation_state.files_completed` column exists (schema.ts line 1576) and is checked non-negative (line 1584) but is only ever written `+ 0`. Either fix the increment or treat the column as stale and remove it (plus its check) in a forward migration.

---

## OK — verified clean

- `token-speed.ts` — single well-tested helper; no duplication; no dead code (used by `error-lifecycle.ts` and `probing-service.ts`).
- `telemetry-status.ts` — one canonical rule, SQL + JS derived from same constants; the SQL is built per call (fine, not a hot loop).
- `client-name.ts`, `redaction.ts` — small, single-purpose, used on both write and read paths.
- `log-sanitize.ts` / `logger.ts` / `log-ring.ts` core — bounded-copy logic is tight and exercised by `log-bounds.test.ts`. The `reset…ForTests` exports are the only dead surface (D3/D5).
- `db-handle.ts`, `db-mode.ts`, `connection-url.ts`, `dialect.ts`, `migrate.ts`, `settings-revision.ts`, `tenant-scope.ts`, `sort-order.ts`, `ttl-cache.ts`, `readiness.ts`, `boot.ts` — no dead exports, no duplicated logic, careful error handling.
- `db-sqlite.ts` / `db-pg.ts` — the statement-cache, column mapping, and pool-shrinker are deliberate and documented; casts at the backend seam are justified and commented.
- `schema.ts` — every table/column surveyed is referenced by a live producer or migration; the `telemetry_events` index set matches the query shapes in `event-query.ts`.
- `telemetry-store.ts` — transactional insert + usage rollup is sound; the only duplication is the shared `UUID_RE` (U1).
- `shared-cache.ts` — read/write primitive design is documented and consistent.

---

## Summary counts

| Severity | Count |
| --- | --- |
| DEAD-CODE | 7 |
| DUPLICATION | 6 |
| BLOAT | 4 |
| ANTI-PATTERN | 4 |
| OPTIMIZATION-OPP | 5 |
| STALE | 4 |
| **Total** | **30** |

Notes on counts: D1 counts as one finding covering six dead exports; U2 counts the 3× duplicated bucket block as one. The most actionable items are **D1/D2** (delete superseded telemetry readers), **O1** (the `filesCompleted + 0` bug), and **D7/S3** (the never-incremented metric).

---

## Execution status

- **Area execution:** 3 file(s) changed in this scope during the cleanup pass; `bunx tsc --noEmit` clean and full backend suite green (4217 pass / 0 fail, protocol 591 pass / 0 fail).
- **Confirmed done (✅):** Dead SQL readers (D1) and event-log file readers (D2) removed; `summarizeUsageWithPerformance` is the live reader; tests migrated; O1 `filesCompleted + 0` → `+ 1` (fixed by orchestrator).
- **Not done / skipped (⛔):**
  - S2 payload-capture doc '15 minutes' vs 60 — not verified
  - U4 flush-buffer skeleton duplication — not verified
- **Note:** this status reflects the orchestrator's verification of representative findings, not an item-by-item re-audit of every finding in this report.
