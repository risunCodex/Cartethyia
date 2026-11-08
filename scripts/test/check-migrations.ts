/**
 * Fails when the Drizzle schema and the committed SQL migrations disagree.
 *
 * `src/persistence/schema.ts` is the Drizzle source, but
 * `migrations/full-postgres/*.sql` is what actually runs at boot, and nothing
 * previously verified the two agreed. A column added to the schema without a
 * migration deploys cleanly and fails at first query; a column removed from
 * the schema while the SQL still creates it leaves a phantom table behind.
 *
 * How it works: two throwaway databases are built from the same schema's two
 * descriptions — one by applying every committed migration in order, one by
 * applying the DDL Drizzle generates from `schema.ts` — and their resulting
 * catalogs are compared. Anything present in one and not the other is drift.
 *
 * This compares *real applied DDL* rather than two snapshots of the schema, so
 * it catches migrations whose SQL does not do what its name claims.
 *
 * `drizzle-kit check` cannot do this here: it compares against snapshots under
 * `migrations/**​/meta/`, which this project never generates because the
 * migrations are hand-written — so it reports "Everything's fine" for a schema
 * change that has no migration at all.
 *
 * Index and constraint *names* are normalized away before comparing: the two
 * generators name them differently (`api_keys_one_default_per_tenant_uidx` vs
 * the schema-derived spelling) while producing identical definitions. Only
 * structural differences — a missing column, a changed type, a dropped
 * `DESC` — are reported.
 *
 * Requires a reachable PostgreSQL server with rights to create a database.
 * Set `CARTETHYIA_DRIFT_DATABASE_URL` to a disposable instance. The
 * development DATABASE_URL is never used as an administrative fallback.
 *
 * Never runs `drizzle-kit generate` against `migrations/`: that would rewrite
 * every committed baseline.
 */
import { Client } from "pg";
import { randomUUID } from "node:crypto";
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveMigrationsFolder, migrationFileIds } from "../../src/persistence/migrate";
import * as schemaModule from "../../src/persistence/schema";

const MIGRATIONS_DIR = resolveMigrationsFolder();

const driftDatabaseUrl = process.env["CARTETHYIA_DRIFT_DATABASE_URL"]?.trim();
if (!driftDatabaseUrl) {
  console.error(
    "[check-migrations] set CARTETHYIA_DRIFT_DATABASE_URL to a disposable PostgreSQL instance; " +
      "the development DATABASE_URL is never used for CREATE/DROP DATABASE",
  );
  throw new Error("CARTETHYIA_DRIFT_DATABASE_URL is required");
}
const ADMIN_URL: string = driftDatabaseUrl;

const SCRATCH_PREFIX = "cartethyia_drift_";


async function createDatabase(name: string): Promise<void> {
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }
}

async function dropDatabase(name: string): Promise<void> {
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${name}`);
  } finally {
    await admin.end();
  }
}

function clientFor(name: string): Client {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;
  return new Client({ connectionString: url.toString() });
}

/** Escapes a value for inline use — `pg` parameter binding misbehaves under Bun here. */
function lit(value: unknown): string {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * Reads a database's catalog as comparable lines: tables, columns with their
 * type/nullability/default, index definitions, constraint definitions, and
 * enum members.
 */
async function catalogOf(name: string): Promise<readonly string[]> {
  const client = clientFor(name);
  await client.connect();
  const query = async (sql: string): Promise<Record<string, unknown>[]> =>
    (await client.query(sql)).rows as Record<string, unknown>[];
  const lines: string[] = [];
  try {
    const tables = await query(
      `select table_name from information_schema.tables where table_schema='public' order by table_name`,
    );
    for (const { table_name: table } of tables) {
      lines.push(`TABLE ${table}`);
      const columns = await query(
        `select column_name, udt_name, is_nullable, coalesce(column_default,'') as dflt
         from information_schema.columns where table_schema='public' and table_name=${lit(table)}
         order by ordinal_position`,
      );
      for (const column of columns) {
        lines.push(
          `  COL ${column.column_name} type=${column.udt_name} null=${column.is_nullable} default=${String(column.dflt).replace(/\s+/g, " ")}`,
        );
      }
      const indexes = await query(
        `select indexdef from pg_indexes where schemaname='public' and tablename=${lit(table)} order by indexdef`,
      );
      for (const index of indexes) {
        lines.push(`  IDX ${normalizeName(String(index.indexdef))}`);
      }
      const constraints = await query(
        `select pg_get_constraintdef(oid) as def from pg_constraint
         where conrelid = (select oid from pg_class where relname=${lit(table)} and relnamespace='public'::regnamespace)
         order by 1`,
      );
      for (const constraint of constraints) {
        lines.push(`  CON ${normalizeName(String(constraint.def).replace(/\s+/g, " "))}`);
      }
    }
    const enums = await query(
      `select t.typname, string_agg(e.enumlabel, ',' order by e.enumsortorder) as vals
       from pg_type t join pg_enum e on e.enumtypid=t.oid join pg_namespace n on n.oid=t.typnamespace
       where n.nspname='public' group by t.typname order by t.typname`,
    );
    lines.push("ENUMS");
    for (const entry of enums) lines.push(`  ${entry.typname} = ${entry.vals}`);
  } finally {
    await client.end();
  }
  return lines;
}

/**
 * Strips the generated identifier from an index/constraint definition, leaving
 * the shape. The two generators name the same object differently
 * (`_pkey` vs `_tenant_id_tool_id_api_key_id_pk`), which is not drift.
 */
function normalizeName(definition: string): string {
  return definition
    .replace(/ON public\.\w+ USING/g, "ON <table> USING")
    .replace(/^CREATE (UNIQUE )?INDEX \S+ /, "INDEX ")
    .replace(/^UNIQUE INDEX \S+ /, "UNIQUE INDEX ")
    .replace(/CONSTRAINT "\w+" /, "CONSTRAINT ")
    .replace(/\b(\w+)_(pkey|key|uidx|idx|fk|fkey|pk|unique)\b/g, "$1_<kind>");
}

async function main(): Promise<number> {
  const files = migrationFileIds(MIGRATIONS_DIR);
  if (files.length === 0) {
    console.error(`[migration-drift] no migrations found in ${MIGRATIONS_DIR}`);
    return 1;
  }

  // The DDL Drizzle derives from schema.ts.
  const current = generateDrizzleJson(schemaModule as unknown as Record<string, unknown>);
  const empty = generateDrizzleJson({} as Record<string, unknown>);
  const statements = await generateMigration(empty as never, current as never);
  const generatedDdl = statements.filter((s) => s.trim().length > 0).join(";\n");

  const runId = randomUUID().replace(/-/g, "");
  const migrationDb = `${SCRATCH_PREFIX}${runId}_migration`;
  const schemaDb = `${SCRATCH_PREFIX}${runId}_schema`;
  const created: string[] = [];

  let expected: readonly string[] = [];
  let actual: readonly string[] = [];
  try {
    await createDatabase(migrationDb);
    created.push(migrationDb);
    await createDatabase(schemaDb);
    created.push(schemaDb);

    const apply = async (name: string, sql: readonly string[]): Promise<void> => {
      const client = clientFor(name);
      await client.connect();
      try {
        for (const statement of sql) {
          try {
            await client.query(statement);
          } catch (error) {
            console.error(`[check-migrations] statement failed in ${name}: ${String(statement).slice(0, 220)}`);
            throw error;
          }
        }
      } finally {
        await client.end();
      }
    };

    const migrationSql = files.map((file) => readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
    await apply(migrationDb, migrationSql);
    await apply(schemaDb, [generatedDdl]);

    expected = await catalogOf(schemaDb);
    actual = await catalogOf(migrationDb);
  } finally {
    for (const name of created.reverse()) await dropDatabase(name);
  }

  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  const missing = expected.filter((line) => !actualSet.has(line));
  const extra = actual.filter((line) => !expectedSet.has(line));

  if (missing.length === 0 && extra.length === 0) {
    console.log(
      `[migration-drift] OK — ${files.length} migration(s) match src/persistence/schema.ts`,
    );
    return 0;
  }

  const render = (label: string, lines: readonly string[]): string =>
    lines.length === 0 ? "" : `\n${label} (${lines.length}):\n` + lines.map((l) => `  ${l}`).join("\n");

  console.error(
    `[migration-drift] DRIFT — src/persistence/schema.ts and migrations/full-postgres/ disagree.` +
      render(`In schema.ts but not produced by the migrations`, missing) +
      render(`Produced by the migrations but not in schema.ts`, extra) +
      `\n\nAdd a migration for the schema change, or revert it. Do not run\n` +
      `drizzle-kit generate: it would rewrite the ${files.length} committed baselines.`,
  );
  return 1;
}

process.exit(await main());
