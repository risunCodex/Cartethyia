/**
 * One-off operational tool: migrate a full-mode PostgreSQL Cartethyia
 * database into the embedded SQLite (lite) backend.
 *
 *   bun run scripts/migrate-pg-to-sqlite.ts [target.sqlite]
 *
 * Source is `DATABASE_URL` (the running install's paymentgres). Target
 * defaults to the lite backend's file (`<data-dir>/cartethyia.sqlite`,
 * `CARTETHYIA_DATA_DIR` or the per-OS convention). `CARTETHYIA_DB_MODE`
 * is not consulted: this tool is deliberately backend-agnostic so it can
 * stage the SQLite file while the gateway still runs in full mode.
 *
 * What it copies: every public table except the migration ledger, whose
 * SQLite side is built by `applySqliteMigrations`. Sealed columns
 * (`credential_ciphertext`, OAuth state blobs) are copied verbatim as
 * blobs — they stay sealed under the install's own encryption key, so the
 * key must be unchanged across the cutover. The tool verifies row counts
 * per table, `foreign_key_check`, `integrity_check`, and that a stored
 * credential still decrypts.
 *
 * Nothing sensitive is printed: column names and counts only, never cell
 * values, URLs, or keys.
 */
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { Pool } from "pg";
import { Database, type SQLQueryBindings } from "bun:sqlite";
import { applySqliteMigrations, createSqliteDatabase } from "../src/persistence/db-sqlite";
import { resolveDataDir } from "../src/persistence/db-mode";
import { decryptCredentialToString } from "../src/security/crypto";

const PAGE_ROWS = 2000;
const MIN_SAFE_BIGINT = BigInt(Number.MIN_SAFE_INTEGER);
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

/** One source column, as `information_schema.columns` reports it. */
interface PgColumn {
  readonly name: string;
  readonly dataType: string;
  readonly udtName: string;
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function asRows(rows: unknown): Record<string, unknown>[] {
  return rows as Record<string, unknown>[];
}

/** A pg `bigint`/`numeric` string that fits a JS number becomes one; otherwise it stays text. */
function numericStringToBind(value: string): SQLQueryBindings {
  if (!/^-?\d+$/.test(value)) {
    const n = Number(value);
    return Number.isFinite(n) ? n : value;
  }
  const big = BigInt(value);
  return big >= MIN_SAFE_BIGINT && big <= MAX_SAFE_BIGINT ? Number(big) : value;
}

/**
 * Maps one PostgreSQL driver value to the SQLite binding with the same
 * meaning, driven by the column's `data_type`. The SQLite schema is the
 * shared Drizzle schema, so the conversion is the same one the lite backend
 * applies at the driver edge: booleans become 1/0, timestamps ISO text,
 * jsonb text, bytea blobs, bigints safe numbers (or text when too large).
 */
export function mapPgValue(value: unknown, dataType: string): SQLQueryBindings {
  if (value === null || value === undefined) return null;
  if (dataType === "boolean") return value ? 1 : 0;
  if (dataType === "bytea") {
    if (Buffer.isBuffer(value)) return Buffer.from(value);
    if (value instanceof Uint8Array) return Buffer.from(value);
    throw new Error(`bytea column must arrive as Buffer, got ${typeof value}`);
  }
  if (dataType === "json" || dataType === "jsonb") {
    return typeof value === "string" ? value : JSON.stringify(value);
  }
  if (dataType.startsWith("timestamp") || dataType === "date") {
    if (value instanceof Date) return value.toISOString();
    if (typeof value === "string") return value;
    throw new Error(`timestamp/date column must arrive as Date or string, got ${typeof value}`);
  }
  if (
    (dataType === "bigint" ||
      dataType === "numeric" ||
      dataType === "decimal" ||
      dataType === "money") &&
    typeof value === "string"
  ) {
    return numericStringToBind(value);
  }
  if (typeof value === "bigint") return numericStringToBind(value.toString());
  return value as SQLQueryBindings;
}

async function pgTableNames(pool: Pool): Promise<string[]> {
  const result = await pool.query(
    `select table_name
       from information_schema.tables
      where table_schema = 'public' and table_type = 'BASE TABLE'
        and table_name <> 'cartethyia_schema_migrations'
      order by table_name`,
  );
  return asRows(result.rows).map((row) => String(row.table_name));
}

async function pgColumns(pool: Pool, table: string): Promise<PgColumn[]> {
  const result = await pool.query(
    `select column_name, data_type, udt_name
       from information_schema.columns
      where table_schema = 'public' and table_name = $1
      order by ordinal_position`,
    [table],
  );
  return asRows(result.rows).map((row) => ({
    name: String(row.column_name),
    dataType: String(row.data_type),
    udtName: String(row.udt_name),
  }));
}

function sqliteColumnNames(sqlite: Database, table: string): string[] {
  const rows = sqlite.query(`pragma table_info(${quoteIdent(table)})`).all() as {
    name: string;
  }[];
  return rows.map((row) => row.name);
}

async function copyTable(
  pool: Pool,
  sqlite: Database,
  table: string,
): Promise<{ copied: number; skipped: boolean }> {
  const srcCols = await pgColumns(pool, table);
  const dstNames = new Set(sqliteColumnNames(sqlite, table));
  const common = srcCols.filter((column) => dstNames.has(column.name));
  if (common.length === 0) {
    return { copied: 0, skipped: srcCols.length > 0 };
  }

  const select = `select ${srcCols.map((c) => quoteIdent(c.name)).join(", ")} from ${quoteIdent(table)}`;
  const insert = `insert into ${quoteIdent(table)} (${common
    .map((c) => quoteIdent(c.name))
    .join(", ")}) values (${common.map(() => "?").join(", ")})`;
  const statement = sqlite.prepare(insert);

  let offset = 0;
  let copied = 0;
  for (;;) {
    const result = await pool.query(`${select} limit ${PAGE_ROWS} offset ${offset}`);
    const rows = asRows(result.rows);
    if (rows.length === 0) break;
    sqlite.transaction(() => {
      for (const row of rows) {
        statement.run(...common.map((c) => mapPgValue(row[c.name], c.dataType)));
      }
    })();
    copied += rows.length;
    offset += PAGE_ROWS;
  }
  return { copied, skipped: false };
}

async function countPg(pool: Pool, table: string): Promise<number> {
  const result = await pool.query(`select count(*)::int as c from ${quoteIdent(table)}`);
  const row = asRows(result.rows)[0];
  return row === undefined ? 0 : Number(row.c);
}

function countLite(sqlite: Database, table: string): number {
  const row = sqlite.query(`select count(*) as c from ${quoteIdent(table)}`).get() as {
    c: number;
  } | null;
  return row?.c ?? 0;
}

async function main(): Promise<void> {
  const target = process.argv[2] ?? join(resolveDataDir(), "cartethyia.sqlite");
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required (the full-mode source)");
  }
  const pool = new Pool({ connectionString });
  try {
    // The target is always rebuilt from scratch: a half-finished migration must
    // never be re-run onto itself.
    await rm(target, { force: true });
    const sqlite = createSqliteDatabase(target);
    await applySqliteMigrations(sqlite);
    sqlite.exec("PRAGMA foreign_keys = OFF");

    const tables = await pgTableNames(pool);
    let totalCopied = 0;
    for (const table of tables) {
      const before = await countPg(pool, table);
      const { copied, skipped } = await copyTable(pool, sqlite, table);
      const after = countLite(sqlite, table);
      totalCopied += copied;
      if (skipped) {
        console.log(`SKIP ${table}: no destination columns (pg=${before})`);
      } else {
        console.log(`${before === after ? "OK" : "MISMATCH"} ${table}: pg=${before} lite=${after}`);
      }
    }

    sqlite.exec("PRAGMA foreign_keys = ON");
    const foreignKeyCheck = sqlite.query("PRAGMA foreign_key_check").all();
    const integrityCheck = sqlite.query("PRAGMA integrity_check").all();

    const credentialRow = sqlite
      .query(
        "select credential_ciphertext from provider_accounts where credential_ciphertext is not null limit 1",
      )
      .get() as { credential_ciphertext?: Uint8Array } | null;
    let probe = "no-credential-rows";
    if (credentialRow?.credential_ciphertext !== undefined) {
      const bytes = Buffer.from(credentialRow.credential_ciphertext);
      try {
        const plain = decryptCredentialToString(bytes);
        probe = plain !== null && plain.length > 0 ? "decrypt-ok" : "decrypt-empty";
      } catch {
        probe = "decrypt-failed";
      }
    }

    console.log(`copied_rows: ${totalCopied}`);
    console.log(`foreign_key_check: ${JSON.stringify(foreignKeyCheck)}`);
    console.log(`integrity_check: ${JSON.stringify(integrityCheck)}`);
    console.log(`credential_probe: ${probe}`);
    console.log(`target: ${target}`);
    sqlite.close();
  } finally {
    await pool.end();
  }
}

if (import.meta.main) {
  main().then(
    () => process.exit(0),
    (error) => {
      console.error(error);
      process.exit(1);
    },
  );
}
