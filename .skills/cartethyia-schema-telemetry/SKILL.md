---
name: cartethyia-schema-telemetry
description: "Schema and telemetry changes: update the canonical schema and generated baselines, restore mappings, or add a usage/telemetry field. Use for database baselines, telemetry_events/usage_totals, and combo-strategy renames."
---

# Schema and telemetry

Use for a schema change, a baseline update, or a new usage/telemetry field.

## Telemetry tests must not touch real data

`TELEMETRY_EVENT_DIR` resolves from the data dir when `event-log` is first
imported (`src/observability/event-log.ts`). Setting `CARTETHYIA_DATA_DIR`
after that import is too late; leaving it unset can write to—and let cleanup
delete—the machine's real telemetry.

Create a temporary data directory and set it **before any dynamic telemetry
import**:

```ts
const sandbox = await mkdtemp(join(tmpdir(), "carte-telemetry-test-"));
process.env.CARTETHYIA_DATA_DIR = sandbox;
const telemetry = await import("../../src/observability/event-log");
```

Use `test/observability/raw-event-retention.test.ts` as the reference. Keep every
telemetry test and cleanup inside its own sandbox.

## Schema changes

The repository ships one baseline per backend plus the numbered files after it.
A fresh database builds from `0000_baseline.sql` and then applies **every**
forward file in order, on both backends (`src/persistence/db-sqlite.ts`,
`src/persistence/db-pg.ts`), and gets tables that only a numbered file creates.
Do not restate the file count here — it grows with every migration and rots
silently. Read `migrations/full-postgres/` (and `lite-sqlite3/`) instead; the
one place the list is legitimately written out is the pinned baseline test.

**Treat `0000_baseline.sql` as append-only history.** It is pinned by a content
hash: `baselineSchemaMarker()` records `sha256` of the file into
`cartethyia_schema_migrations`, and `assertMigrationHistorySupported()` rejects
any database whose recorded marker no longer matches the file on disk. So
editing the baseline does not upgrade existing databases — it makes them refuse
to boot, with "Create a fresh database and restore from a backup". A fresh
install gets forward-file changes anyway, so folding a change into the baseline
buys nothing and costs every existing deployment.

1. Update `src/persistence/schema.ts`.
2. Add the next numbered file to **both** `migrations/full-postgres/` and
   `migrations/lite-sqlite3/`. The statement must be a no-op on a database the
   current baseline already created, because a fresh install runs the baseline
   and then every later file. `0008_add_models_route_unique_index.sql` is the
   shape: the bundled model seed upserts on an index a pre-baseline database
   does not have, and boot dies without it.
3. Do not regenerate either baseline for an ordinary schema change. The SQLite
   baseline is generated from the pinned PostgreSQL baseline, not from
   `schema.ts` or the accumulated forward migrations. Regenerate it only for a
   deliberate baseline/generator change that preserves released schema
   semantics and accepted hash compatibility; do not edit it by hand.
   `test/persistence/sqlite-baseline.test.ts` checks the current contract.
4. Update backup validation and restore mapping for old column names, enum
   values, defaults, or required data that must survive recreation.
5. Test the fresh schema, the numbered file against a database created before
   it, and legacy backup restoration. Never test against a live development
   or production database.

Two consequences worth knowing before you touch `migrations/`:

- A schema edit that no migration covers is invisible until runtime. Run
  `bun run check:migrations` — it builds two throwaway databases (one from the
  committed SQL, one from the DDL Drizzle derives from `schema.ts`) and diffs
  their real catalogs. `drizzle-kit check` cannot do this: it compares against
  `migrations/**/meta/` snapshots, which this project never generates because
  the migrations are hand-written, so it reports "Everything's fine" even after
  a whole new table is added to the schema with no migration.
- Never run `drizzle-kit generate` against `migrations/`: it rewrites every
  committed baseline.

Drizzle numeric columns may require string persistence. Use bigint number mode
for absolute epoch milliseconds. Manual migrations are not applied by the boot
ledger; report them separately.

## Persisted telemetry fields

Per-request events are appended to one raw JSONL file per UTC hour under the
data dir's `telemetry-events/` (`src/observability/event-log.ts`). Usage,
breakdown, chart, request detail, and per-key spend read these events (per-key
*lifetime* spend and share KPIs come from `telemetry_usage_totals`).
Estimated `/count_tokens` answers also produce rows — `token-count.ts`
finalizes them through `finalizeRequestTelemetry` with estimated, unpriced
usage. No compaction worker, summary index, or watermark replaces the
individual rows. Reconciliation bumps `files_completed` by one per processed
file in the same transaction as its inserts — keep that increment when
touching `telemetry-reconciliation.ts`.
Legacy `<YYYY-MM-DD>.events.jsonl` files remain readable until retention;
`.compacted.jsonl` and `.index.json` are never read as requests.

Retention deletes whole expired raw files and never replaces them with a
summary. The query path still applies the retention floor and can read the
newest unfiltered page backwards from a file's tail.

The database keeps aggregates in `telemetry_usage_totals` only; do not add a
reader back onto `telemetry_events`. Payload capture stays a separate
append-only file under `data/telemetry-payloads/`.

A new usage field must pass through canonical usage, normalization, the file
writer, event query/aggregation, console contract/store, dashboard validator,
and Usage UI. Reject invalid upstream values; do not silently clamp them.
`cachedInputTokens` is the live worked example of every hop: column on
`telemetryEvents` (`schema.ts`), summed in `AGGREGATE_SELECT`
(`event-query.ts`), chart/breakdown buckets read `bucket.cachedInputTokens`
(`console/observability/store.ts`), dashboard validator
(`dashboard/src/hooks/providers.ts`), matrix card. Follow that trail field by
field. For a new *time-bucketed* aggregate, reuse the `bucketExpression`
helper in `event-query.ts` (shared epoch-bucket SQL, inlined per dialect) —
do not re-derive the expression; its comment explains the Postgres 42803
pitfall.
An aggregate that must survive retention needs the canonical schema and a
forward migration in both backend directories. Update restore mapping when old
backups do not carry the field or use a retired representation.

Costs arrive as strings from `numeric` columns and from restored rows. Coerce
before summing: `0 + "0.000966"` concatenates instead of adding.

## Renames and strategy removal

Change the canonical enum/model, router, console contract/store, validation,
catalog snapshot, schema, forward migrations in both backend directories,
backup mapping, dashboard contract/hook/card, and docs. No alias fields.

Combo strategies are `fallback` and `round_robin`. There is no fusion strategy
and no minimum-balance floor: do not reintroduce
`model_combo_strategy.fusion`, `credit_limit`, or the account remaining-balance
stamps. The fresh baseline must exclude retired enum values; normalize legacy
backup rows to the current strategy during restore.

## Verify

The gate list is `cartethyia-engineering/references/verification.md`; run those,
plus `bun run test:backend`.

The boundary specific to this skill is the database: exercise the fresh
baseline and legacy backup mappings. Never reset production data — use the
disposable database configured with `CARTETHYIA_TEST_DATABASE_URL` in the local
`.env` or shell (`bun run test-db:up/check/down`).
