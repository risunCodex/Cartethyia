/** Migration discovery + ledger helpers shared by every database backend. */
import { sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { basename, resolve } from "node:path";
import { resolvePackagePath } from "../config/package-paths";
import type { CartethyiaDatabase } from "./db-handle";

/**
 * SQL-only migration ledger. Migration files are the source of truth; this
 * table stores only which numbered files have already run.
 */
export const MIGRATION_LEDGER_TABLE = "cartethyia_schema_migrations";

export const LEDGER_DDL = `CREATE TABLE IF NOT EXISTS ${MIGRATION_LEDGER_TABLE} (
  migration_id text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
)`;

export function resolveMigrationsFolder(): string {
  const folder = resolvePackagePath("migrations", "full-postgres");
  if (!existsSync(folder)) {
    throw new Error(`Migrations folder not found: ${folder}`);
  }
  return folder;
}

export function migrationFileIds(folder: string): readonly string[] {
  return readdirSync(folder)
    .filter((file) => /^\d{4}_.+\.sql$/.test(file))
    .sort();
}

export function migrationFiles(folder: string): readonly string[] {
  return migrationFileIds(folder).map((file) => resolve(folder, file));
}

export function migrationIdFor(file: string): string {
  return basename(file);
}

/** The only migration file a fresh database builds from. */
export const BASELINE_MIGRATION_ID = "0000_baseline.sql";
const BASELINE_SCHEMA_MARKER_PREFIX = "baseline-schema:";

/**
 * Identifies the exact baseline schema recorded by a fresh database.
 *
 * The hash is taken over the *statements*, with comments stripped, because the
 * raw file text is not the thing that matters: a comment edit changes the hash
 * without changing the schema, and a changed hash makes every existing database
 * refuse to boot ("different baseline schema"). That is not hypothetical — a
 * documentation-only edit to the SQLite baseline header shipped in 2.4.6 and
 * locked out every database created by 2.4.5.
 *
 * Stripping comments makes the marker track the schema a database was built
 * from, which is what the check is actually asserting.
 */
export function baselineSchemaMarker(source: string): string {
  return `${BASELINE_SCHEMA_MARKER_PREFIX}${hashStatements(source)}`;
}

/**
 * Markers recorded by releases that hashed the raw baseline file text.
 *
 * Every 2.4.x release shipped the same SQLite baseline, so a database created by
 * any of them carries this one marker. The *schema* is identical to the current
 * baseline (verified: stripping comments from both yields the same hash), so
 * these are accepted as proof of the same schema instead of telling every
 * existing user to recreate their database.
 *
 * These are frozen history. Never add a marker for a schema that actually
 * differs — that would let an incompatible database boot against a newer
 * runtime, which is the failure this check exists to prevent.
 */
const LEGACY_BASELINE_SCHEMA_MARKERS: readonly string[] = [
  // full-postgres/0000_baseline.sql — unchanged across v2.4.0-v2.4.6, so this is
  // the raw-text hash every existing Full-mode database carries.
  "baseline-schema:bf7d2b4f1f99b4470c81850a77cc4ebc989997fbe8c8b68ec62833164c73a6ad",
  // lite-sqlite3/0000_baseline.sql, v2.4.0 – v2.4.5 (raw-text sha256).
  "baseline-schema:438c5e014c5f86f483a84e8a106b0e62143d4eb0b0daad728a300bcc683d8c02",
  // lite-sqlite3/0000_baseline.sql, v2.4.6 (same schema, different header).
  "baseline-schema:405083572bb108bfe42e726b6f3d0b47c8d76c8e1de1a3a5d5fbbbe88a7ac4dd",
];

/** Accepted markers for the current baseline schema, current form first. */
export function acceptedBaselineSchemaMarkers(source: string): readonly string[] {
  return [baselineSchemaMarker(source), ...LEGACY_BASELINE_SCHEMA_MARKERS];
}

/** Hash of the baseline's statements, with comments and formatting removed. */
function hashStatements(source: string): string {
  const statements = source
    // `--` to end of line, which is the only comment form these baselines use.
    .replace(/--[^\n]*/g, "")
    .split(/--> statement-breakpoint/)
    .map((part) => part.replace(/\s+/g, " ").trim())
    .filter((part) => part.length > 0)
    .join("\n");
  return createHash("sha256").update(statements).digest("hex");
}

/**
 * Rejects databases whose schema was created by retired migration files or
 * which have tables but no record of the current baseline.
 */
export function assertMigrationHistorySupported(
  applied: ReadonlySet<string>,
  expected: readonly string[],
  hasTenants: boolean,
  currentBaselineMarker?: string,
): void {
  const supported = new Set(expected);
  const retired = [...applied].filter((migrationId) => !supported.has(migrationId));
  if (retired.length > 0) {
    throw new Error(
      `Database contains retired migration history (${retired.join(", ")}). ` +
      "Create a fresh database and restore from a backup; in-place upgrades are no longer supported.",
    );
  }
  if (hasTenants && !applied.has(BASELINE_MIGRATION_ID)) {
    throw new Error(
      "Database contains an unversioned schema. Create a fresh database and restore from a backup; " +
      "in-place upgrades are no longer supported.",
    );
  }
  // Any marker in `expected` counts, not just the current one: a database built
  // by an older release carries a frozen historical marker for the same schema.
  const acceptedMarker =
    currentBaselineMarker !== undefined &&
    expected.some((id) => id.startsWith(BASELINE_SCHEMA_MARKER_PREFIX) && applied.has(id));
  if (hasTenants && currentBaselineMarker !== undefined && !acceptedMarker) {
    throw new Error(
      "Database was created from a different baseline schema. Create a fresh database and restore from a backup; " +
      "in-place upgrades are no longer supported.",
    );
  }
}

/**
 * Splits a migration file on the drizzle `statement-breakpoint` markers the
 * files already carry. Only the embedded backend needs per-statement
 * application (single-statement failure tolerance); the pg path sends the
 * whole file at once exactly as before.
 */
export function splitStatements(source: string): string[] {
  return source
    .split(/--> statement-breakpoint/g)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/**
 * Readiness view of the migration ledger: the numbered SQL files discovered on
 * disk compared against the ids recorded in {@link MIGRATION_LEDGER_TABLE}.
 */
export interface MigrationLedgerStatus {
  /** Migration file names discovered on disk, in apply order. */
  readonly expected: readonly string[];
  /** Expected migrations that have no ledger row. */
  readonly pending: readonly string[];
  /** True only when every expected migration is recorded in the ledger. */
  readonly applied: boolean;
}

/**
 * Compares the migration files discovered on disk against the applied-migration
 * ledger. A reachable ledger alone is not readiness: an interrupted upgrade
 * leaves the table present while later migrations are still unapplied.
 *
 * Runs on the drizzle handle, so it is identical on every backend.
 */
export async function readMigrationLedgerStatus(
  db: CartethyiaDatabase,
  folder: string = resolveMigrationsFolder(),
): Promise<MigrationLedgerStatus> {
  const expected = migrationFiles(folder).map((file) => migrationIdFor(file));
  const result = await db.execute<{ migration_id: string }>(
    sql.raw(`SELECT migration_id FROM ${MIGRATION_LEDGER_TABLE}`),
  );
  const applied = new Set(result.rows.map((row) => row.migration_id));
  const pending = expected.filter((migrationId) => !applied.has(migrationId));
  return { expected, pending, applied: pending.length === 0 };
}
