# Part 15 — Persistence, runtime observability, workers, shared primitives & types (deep audit)

## Scope

Read-only audit of `src/persistence/**`, `src/observability/**`, `src/workers/**`,
`src/shared/**`, `src/types/**` for concrete, worthwhile consolidation
opportunities (bloat, duplication, unnecessary work/latency, maintenance
complexity) that preserve behavior. Operator constraints: memory/state
integrity and valid fallback behavior win over cleanup; never propose removing
apparently duplicated logic unless the copies share the same contract, state
scope, ordering, error semantics, and safety boundary. Similar syntax is not
proof of duplicate behavior. Files were inspected as source plus tests; codegraph
was used first for symbol/call-path mapping, then direct `Read`/`Grep` for
detail. No source, test, config, or git state was modified (audit only).

Areas covered: `src/persistence/**` (db handle/boot/mode/pg/sqlite/dialect,
migrate/readiness/redis/connection-url, shared-cache, ttl-cache, stores
api-key/share/telemetry, usage-flush, health-event-flush, settings-revision,
sort-order, tenant-scope, tenant-preferences, system-prompt-store),
`src/observability/**` (logger/log-ring/log-sanitize, event-log, event-query,
raw-event-writer, telemetry-buffer, telemetry-reconciliation, telemetry-status,
metrics, performance-metrics, runtime-metrics, token-speed, payload-store,
payload-capture, redaction, client-name, request-notify),
`src/workers/**` (scheduler, sweep-runner, maintenance-lease,
account-identity-sweep, quota-refresh-sweep, oauth-refresh-sweep,
buddy-growth-tasks, daily-checkin, zcode-gift-claim), `src/shared/**`
(coerce, hash, sleep, time, invoke-guard), `src/types/**`.

## Current-flow evidence (traced)

- **Telemetry write path**: request terminal → `telemetry-buffer.ts`
  (`TelemetryBatchBuffer.enqueue`, `estimateTelemetryEventBytes` fixed envelope,
  adaptive flush, drain retry/backoff) → `DrizzleTelemetryStore.insertEvents`
  (`telemetry-store.ts:218`; raw `RawTelemetryEventWriter.append` first, then
  one transaction: `ON CONFLICT DO NOTHING` insert + `applyUsageDeltas` upsert).
- **Telemetry backfill/repair**: `reconcileTelemetry`
  (`telemetry-reconciliation.ts:251`; would lease + `(file, byte_offset)`
  checkpoint in the same transaction, `toRow` mirrors `telemetryEventRow`).
- **Telemetry read side**: `event-query.ts` is the canonical reader; every
  console aggregate runs in SQL. `event-log.ts` still carries a file-based
  reader (`queryTelemetryEvents`/`readTelemetryEvents`/`emptyTotals`/
  `accumulate`) used only by tests and by `event-log`'s own module; the only
  production imports of `event-log` are the `TELEMETRY_EVENT_DIR` constant,
  the `TelemetryEventRecord` type, and the retention-prune helper in
  `telemetry-store.ts`. `.skills/cartethyia-engineering/references/backend.md`
  documents that the file reader is the legacy read surface.
- **Memory metrics**: `metrics.ts` (`PrometheusRegistry`) exposes
  `cartethyia_memory_rss_bytes` etc.; `runtime-metrics.ts` `sample()` sets both
  the registry gauges and `trackMemoryUsage` (`performance-metrics.ts`), which
  is the only producer of `performanceMetricsSnapshot` consumed by
  `src/console/observability/performance.ts` (`/system/performance`). Adapter
  load is recorded twice: `provider-registry.ts` observes
  `proxy_provider_adapter_load_ms` histogram and `trackAdapterLoad`.
- **Workers**: `scheduler.ts` (`ScheduledTaskRegistry`, `runGrowingWaves`,
  `deferForForeground`) + `sweep-runner.ts` (`runSweep`, `deferWaveForForeground`)
  are the shared skeletons; sweeps (`account-identity`, `quota-refresh`,
  `oauth-refresh`) are `runSweep` plans. `buddy-growth-tasks.ts` (`runTask`)
  and `daily-checkin.ts` hand-roll their own walk loops, ledger stamps
  (`markClaimed` / `markCheckinAttempted`), and budget checks.
- **Deferred write buffers**: `usage-flush.ts` (`UsageFlushBuffer`) and
  `health-event-flush.ts` (`HealthEventFlushBuffer`) are two separate classes
  with the same enqueue/timer/flush/stop shape but genuinely different failure
  contracts (see F1).
- **Cache layer**: `TtlCache`/`TtlCacheFamily` (`ttl-cache.ts`) with
  `dedupeRequest` single-flight; `shared-cache.ts` (Redis L2 + invalidation
  channel). `readiness.ts` memo/single-flight is a hand-rolled TTL cache.

## Findings

### F1 — `UsageFlushBuffer` and `HealthEventFlushBuffer` are a shared deferred-write skeleton, but must stay separate (reviewed, no cleanup proposed)

- **Severity:** n/a · **Effort:** n/a · **Behavior change:** n/a.
- **Mechanism.** Both are timer-driven deferred write buffers with the same
  shape: `enqueue`/`flush`/`stop`, an `unref`'d timer, and a synchronous
  enqueue that never touches the DB. `health-event-flush.ts` even documents
  "Same shape as `persistence/usage-flush.ts`". But the contracts differ in
  exactly the ways that matter:
  - `usage-flush.ts`: coalesces per-key deltas into a `Map`, chunks at
    `FLUSH_STATEMENT_MAX_KEYS`, failure-streak backoff
    (`FLUSH_FAILURE_STREAK_LIMIT`/`FLUSH_BACKOFF_MS`), per-key rewrites on
    chunk failure, drop-accounting via `droppedDelta`, and `force` bypass.
  - `health-event-flush.ts`: array of rows, first-in-first-out drop at
    `MAX_PENDING_ROWS` with `dropped` count, a `drain(accountId)` barrier
    (`inflightDone`) that a purge needs to avoid resurrecting deleted rows,
    and no backoff at all.
- **Why consolidation is not proposed.** A shared base class would have to
  parameterize the pending structure (Map vs array), the failure policy
  (backoff vs none), and the drain barrier — three orthogonal dimensions with
  different state-integrity semantics. The health buffer's `inflightDone`
  barrier exists specifically so `clear` + eventual `DELETE` cannot race an
  in-flight insert; the usage buffer's failure-streak backoff exists to stop
  probing a down database. Merging them would either force the health buffer
  to inherit a backoff it deliberately does not have, or force the usage
  buffer to inherit a drain barrier it does not need. No cleanup proposed.
- **Verification.** `test/persistence/usage-flush.test.ts` and
  `test/persistence/health-event-flush.test.ts` pin the distinct drop/backoff/
  barrier behaviors. This finding is recorded as a reviewed-and-rejected
  consolidation, not a silent omission.

### F2 — Telemetry `toRow` (reconciliation) and `telemetryEventRow` (write path) are two column mappings that drift (CONFIRMED, MED)

- **Severity:** MED · **Effort:** S · **Behavior change:** no.
- **Mechanism.** The write path turns `TelemetryEventInput` into an insert row
  in `telemetry-buffer.ts:108-167` (`telemetryEventRow`). The backfill turns a
  `TelemetryEventRecord` into an insert row in `telemetry-reconciliation.ts:147-183`
  (`toRow`). Both are explicitly documented as mirrors ("Mirrors
  `telemetryEventRow` on the write path", `telemetry-reconciliation.ts:146`),
  but they are maintained by hand and have already drifted:
  - `toRow` maps `creditUsed`, `resolveMs`, `tokensPerSec`,
    `firstContentDeltaAtMs`, `lastEventAtMs`, `payloadCaptureState`, and
    `degenerateStop` — the fields the write path persists (schema columns at
    `schema.ts:1494-1525`) — **not at all**. `toRow`'s return type is
    `typeof telemetryEvents.$inferInsert`, so the fields are silently `null`,
    even when the raw JSONL line carries them.
  - `telemetryEventRow` derives `clientName` from `userAgent`; `toRow` also
    does (`telemetry-reconciliation.ts:166`), which is correct but currently
    duplicated rather than shared.
- **Why it is worthwhile.** The backfill exists to recover rows lost to a
  crash; a backfilled row that drops `tokensPerSec`/`creditUsed`/`degenerateStop`
  is a row that reads as if those events never happened, permanently (the raw
  file is pruned after retention). The two mappings must share one column
  spelling. The fix is a single shared `telemetryInsertRow` that maps a
  normalized `TelemetryEventRecord`-shaped row to the insert shape, used by
  both paths; the write path keeps its `TelemetryEventInput` normalization
  upstream of it.
- **State/fallback analysis.** `toRow` is used only by `insertChunk`
  (transaction + `ON CONFLICT DO NOTHING` + `RETURNING`); `ON CONFLICT` is
  the idempotency boundary and is untouched. Risk: the shared mapper must keep
  the `estimatedCostUsd` string-vs-null and `creditUsed` handling identical to
  today (numeric columns are string-typed in Drizzle), otherwise a backfilled
  row could flip the analytics `partial` flag. The `clientName` derivation must
  stay the single `clientNameFromUserAgent` call.
- **Fallback risk.** Low. `reconcileTelemetry` is only invoked by
  `scripts/cli/telemetry.ts` (operator), not by the request path.
- **Verification.** `test/observability/telemetry-reconciliation.test.ts`
  currently asserts `eventsInserted`/`conflicts` counts only — it does not
  assert the inserted row's columns. Add a test asserting a raw line carrying
  `tokensPerSec`, `creditUsed`, and `degenerateStop` backfills those columns;
  run the existing reconciliation suite plus `test/observability/telemetry-buffer.test.ts`.

### F3 — File-based `event-log.ts` read surface is effectively legacy; `TelemetryEventRecord` + `TELEMETRY_EVENT_DIR` are the only production-reachable exports (CONFIRMED, LOW)

- **Severity:** LOW · **Effort:** M · **Behavior change:** no.
- **Mechanism.** `event-log.ts` (420 lines) exports a file-based reader:
  `readTelemetryEvents` (line 257), `queryTelemetryEvents` (line 304),
  `emptyTotals`/`accumulate` (lines 399/406), plus the private
  `readEventFiles`/`readEventFileTail`/`normalize`. Grep across `src/`,
  `scripts/`, and `dashboard/` shows the only callers of these functions are
  tests (`test/observability/raw-event-retention.test.ts`,
  `test/observability/telemetry-buffer.test.ts`,
  `test/observability/cached-token-totals.test.ts`). Production imports from
  `event-log` are: `TELEMETRY_EVENT_DIR` (telemetry-reconciliation,
  telemetry-store, backup store, domain-registration), `TelemetryEventRecord`
  type (7 modules), and the retention prune in `telemetry-store.ts` (which
  uses `readdir` itself, not the reader). The canonical reader is
  `event-query.ts`; `.skills/cartethyia-engineering/references/backend.md`
  documents the file reader as the legacy surface.
- **Why it is worthwhile.** ~290 lines of file-scanning machinery (chunked
  readers, tail reader, `normalize`, `eventFileHour`, `matches`,
  `emptyTotals`/`accumulate`) exist only for production-dead paths. The
  module's durable value — `TELEMETRY_EVENT_DIR`, `TelemetryEventRecord`, and
  the retention helpers that `telemetry-store.ts` could import — stays. The
  cleanup is to strip the dead reader functions and their tests, not to rewrite
  the write path.
- **State/integrity risk.** `TelemetryEventRecord` is the shared type;
  `RAW_...` file layout, `hourStamp` naming, and the two-hour skip rule in
  `telemetry-reconciliation.ts`/`telemetry-store.ts` are independent and
  untouched. The file reader is read-only; removing it cannot corrupt state.
- **Fallback risk.** None: no production fallback calls these functions. The
  tests that use them (`raw-event-retention`, `telemetry-buffer`,
  `cached-token-totals`) must be rewritten against `event-query.ts` or the
  reconciliation path, or dropped if they only test the dead reader.
- **Verification.** After removal, `grep -rn "readTelemetryEvents\|queryTelemetryEvents\|emptyTotals\|accumulate"` over `src/` must return nothing; run the full `test/observability/` suite.

### F4 — Memory gauges are published to two registries from one sample; the `performance-metrics` memory series duplicates `metrics` gauges (PLAUSIBLE, LOW)

- **Severity:** LOW · **Effort:** S · **Behavior change:** no.
- **Mechanism.** `runtime-metrics.ts` `sample()` (lines 191-222) sets
  `metrics.cartethyia_memory_rss_bytes` / `..._heap_used_bytes` /
  `..._heap_total_bytes` / `..._memory_limit_bytes` and then, four lines later,
  calls `trackMemoryUsage("rss", ...)` / `("heap_used", ...)` /
  `("heap_total", ...)` / `("external", ...)` into `performance-metrics.ts`.
  Those `BoundedSeries` entries are the only source of `memory_bytes` in the
  `performanceMetricsSnapshot` served by `/system/performance`. So each sample
  computes `process.memoryUsage()` once but writes the same four numbers into
  two separate in-memory structures, kept in sync by hand.
- **Why it is worthwhile.** The `performance-metrics` memory series is a
  second, hand-maintained copy of the Prometheus memory gauges with a
  different key shape (`"rss"` vs the gauge names). Weakening the duplication
  removes a place where the two views can disagree. Behavior preservation: the
  `/system/performance` response shape must stay byte-identical, including the
  `external` key, which has no gauge equivalent.
- **Proposal (optional).** Keep `performanceMetricsSnapshot` as the single
  memory source and have the Prometheus gauges read from it, or keep the
  gauges as the source and have `performanceMetricsSnapshot` derive `memory_bytes`
  from the last sample. Both must be driven from the one `process.memoryUsage()`
  call. `trackAdapterLoad`/`trackModelCatalogLoad`/`trackNetworkCall` are
  separate series with no Prometheus twin and are unaffected; only the memory
  four are duplicated.
- **State/integrity risk.** `performanceMetricsSnapshot` is read by the
  console performance route; `memory_bytes` keys are fixed (`rss`, `heap_used`,
  `heap_total`, `external`). Changing the source must keep these keys and the
  256-entry cap (`MAX_PERFORMANCE_ENTRIES`) intact. No persisted state.
- **Fallback risk.** None: `performanceMetricsSnapshot` is pure.
- **Verification.** `test/observability/runtime-metrics-inflight-binding.test.ts`
  plus a new unit test asserting the snapshot and the gauges agree after a
  `sample()`; the console `/system/performance` route is covered by existing
  console tests.

### F5 — `TtlCache.load` vs the hand-rolled read-through in `tenant-preferences.ts` (reviewed, no cleanup proposed)

- **Severity:** n/a · **Effort:** n/a · **Behavior change:** n/a.
- **Mechanism.** `CachedPreferencesReader` (`tenant-preferences.ts:44-73`)
  and `readTenantSystemPromptsCached` (`transport/request/tenant-preferences.ts:36-46`)
  both implement get → miss → load → set + revision-keyed invalidation, which
  `TtlCache.load` (with `dedupeRequest` single-flight) already provides.
  However, they use `TtlCache`'s `get`/`set` directly and skip `load`. The
  difference matters: `load` adds single-flight deduplication via
  `dedupeRequest`, while the two hand-rolled readers can fetch the same key
  concurrently (e.g. two requests for the same tenant and revision). Also,
  `CachedPreferencesReader` caches `null` (no preferences row) — `load`'s
  `shouldCache` defaults would cache `null` as `value ?? null`.
- **Why consolidation is not proposed.** The two readers sit in different
  layers (`persistence/tenant-preferences.ts` vs `transport/request/tenant-preferences.ts`)
  and use different cache instances. Routing them through `TtlCache.load`
  would change the miss path from one query to a `dedupeRequest`-wrapped query
  — a behavior change on the hot path with no test coverage
  (`test/**` has no tenant-preferences unit test). Without a test pinning the
  load-through and revision semantics, this is a plausible improvement, not a
  confirmed duplicate.
- **Verification.** If pursued, add `test/persistence/tenant-preferences.test.ts`
  asserting: concurrent misses for the same key run one loader; a `null` value
  is cached; a revision bump invalidates. Current behavior is preserved either way.

## Excluded / unverified suspects

- **`src/persistence/readiness.ts` memo/single-flight** (TTL+in-flight) is
  hand-rolled and could reuse `TtlCache`; left out because its `sameMemoKey`
  equality and the `readinessInflightKey` re-check are distinct from
  `TtlCache`'s key-string interface, and readiness is not a hot path.
- **`src/persistence/settings-revision.ts` vs `shared-cache.ts`** — the
  revision counter is intentionally tiny and correctness-critical (monotonic,
  peer-ordered); consolidating it into the cache layer risks winding the
  counter backwards. Excluded.
- **`src/observability/logger.ts` vs `log-ring.ts`** — the logger already
  routes through the ring with bounds; no duplication found.
- **`src/workers/daily-checkin.ts` / `buddy-growth-tasks.ts`** hand-rolled
  walk loops vs `runSweep` — excluded: they have different ledger semantics
  (`markCheckinAttempted` Redis+SQL dual write, slot reservation,
  `withDirectFallback`, eager day-key checks) and different pacing; a `runSweep`
  plan would change failure isolation and skip counting.
- **`src/observability/payload-store.ts` / `payload-capture.ts`** — the gzip
  worker, semaphore, and backlog are already centralized and well-documented;
  no duplication found.
- **`src/persistence/db-sqlite.ts` vs `db-pg.ts`** — deliberately separate
  drivers; no shared consolidation proposed.
- **`src/types/undici.d.ts`** — type-only declaration; no actionable finding.

## State / fallback analysis (summary)

- F2 (toRow drift) is the only finding with a state-integrity angle: today a
  backfilled row silently loses the newer telemetry columns. The fix adds data
  that is already in the raw file; it cannot corrupt existing rows, and the
  `ON CONFLICT DO NOTHING` idempotency boundary is preserved.
- F3 (dead file reader) removes read-only code; it cannot corrupt persisted
  state, but the tests that exercise the reader must be migrated or removed
  with it.
- F4 (memory metric duplication) touches only in-memory observability; the
  `/system/performance` shape must be preserved.
- F1/F5 are reviewed-and-kept: the duplicate-looking code has different
  contracts/state scopes, and consolidation would risk the very invariants
  (drain barrier, backoff, single-flight miss path) the operator asked to
  protect.
- All findings preserve the request path, the write path, and the fallback
  branches documented in the traced flows. No guard or fallback is weakened.

## Validation

- Sources and tests inspected: `src/persistence/**`, `src/observability/**`,
  `src/workers/**`, `src/shared/**`, `src/types/**`, `test/persistence/**`,
  `test/observability/**`, `test/workers/**` (as listed in Scope and traced in
  Current-flow evidence).
- Codegraph used first for symbol/call-path mapping; `Read`/`Grep` used for
  the column-level and caller-level evidence above.
- No source, test, config, or git state was modified. This is an audit-only
  deliverable. The bounded changes proposed in F2-F4 have not been implemented
  or run against the suite; verification steps are specified per finding.

## Open questions

1. Should the legacy file-based telemetry reader tests (`raw-event-retention`,
   `telemetry-buffer`, `cached-token-totals`) be migrated to `event-query.ts`
   (SQL) before the dead file reader is removed, or is the reader intentionally
   kept as a debugging surface?
2. Is `/system/performance`'s `memory_bytes.external` needed, or can the
   memory snapshot be derived entirely from the Prometheus gauges?
3. Is there a policy preference for backfilled rows carrying `tokensPerSec`/
   `creditUsed`/`degenerateStop` once F2 lands — i.e. should reconciliation
   fill them (proposed) or leave them null to match the pre-migration rows?

## Execution status

**Implementasi kampaian (2026-11-09).** Verified against the full backend suite
(4735 pass / 1 skip / 0 fail) and `tsc --noEmit` (zero errors in scope):

- **F1 — reviewed, no change (as proposed).** `UsageFlushBuffer`/
  `HealthEventFlushBuffer` stay separate; the shared deferred-write skeleton is
  intentional.
- **F2 (M-60) — ✅.** Shared `telemetryInsertRow` mapper created
  (`src/observability/telemetry-row.ts`); both write path
  (`telemetry-buffer.ts`) and reconciliation (`telemetry-reconciliation.ts`)
  use it. Backfill now fills `creditUsed`, `resolveMs`, `tokensPerSec`,
  `firstContentDeltaAtMs`, `lastEventAtMs`, `payloadCaptureState`,
  `degenerateStop`. Preserved: `estimatedCostUsd` null-vs-string, single
  `clientNameFromUserAgent` derivation, `ON CONFLICT DO NOTHING`. Test added
  in `telemetry-reconciliation.test.ts`.
- **F3 (M-61) — ✅.** Dead file-based reader stripped from `event-log.ts`
  (`readTelemetryEvents`, `queryTelemetryEvents`, emptyTotals/accumulate,
  private read helpers); `TELEMETRY_EVENT_DIR` + `TelemetryEventRecord` kept.
  The three affected tests rewritten to read through `event-query.ts`; stale
  reader docs updated in `.skills/cartethyia-engineering/references/backend.md`.
- **F4 (M-62) — ✅.** Memory gauges consolidated: the `performance-metrics`
  memoryUsage `BoundedSeries` is canonical; `runtime-metrics.ts` records the
  single `process.memoryUsage()` call's four figures via `trackMemoryUsage` and
  derives the Prometheus gauges from the same series via `memoryUsageBytes()`.
  `/system/performance` shape byte-identical. Test added asserting
  snapshot/gauge agreement.
- **F5 — reviewed, no change (as proposed).** `TtlCache.load` vs the
  hand-rolled read-through in `tenant-preferences.ts` — intentionally distinct
  semantics.
