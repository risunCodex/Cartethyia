/** Embedded backend: bun:sqlite in the gateway's data dir. */
import { Database, type SQLQueryBindings } from "bun:sqlite";
import type { Statement } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { getTableColumns, getTableName } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { resolvePackagePath } from "../config/package-paths";
import { fullSchema, type DatabaseHandle } from "./db-handle";
import {
  BASELINE_MIGRATION_ID,
  assertMigrationHistorySupported,
  baselineSchemaMarker,
  acceptedBaselineSchemaMarkers,
  MIGRATION_LEDGER_TABLE,
  migrationFiles,
  migrationIdFor,
  splitStatements,
} from "./migrate";

/**
 * Ledger DDL for the SQLite backend.
 *
 * The shared ledger DDL is PostgreSQL (`timestamptz`, `now()`), and this
 * backend never sends PostgreSQL DDL. The shape is the same table the
 * readiness check reads, so a ledger written here is a ledger read there.
 */
const SQLITE_LEDGER_DDL = `CREATE TABLE IF NOT EXISTS ${MIGRATION_LEDGER_TABLE} (
  migration_id text PRIMARY KEY,
  applied_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
)`;

/**
 * Opens the embedded database at `file`.
 *
 * `:memory:` is the test backend and is used as given. A filesystem path has
 * its parent created first, because bun:sqlite does not create directories.
 * Foreign keys are off unless asked for, so the pragma is set on every
 * connection rather than trusted to a default. WAL keeps a reader from
 * blocking the single writer.
 */
/**
 * Databases whose `prepare`/`exec` have already been wrapped.
 *
 * Keyed weakly so a closed in-memory database is not retained by the registry.
 */
const SQLITE_PREPARED = new WeakSet<Database>();

/**
 * The statement cache of each wrapped database.
 *
 * Kept beside the weak set above rather than inside a closure so `close` can
 * drop the whole map: a live cache would otherwise keep the statements it
 * holds reachable past a `close(true)`, which is exactly what that call is
 * meant to release.
 */
const SQLITE_STATEMENT_CACHES = new WeakMap<Database, Map<string, Statement>>();

/**
 * Compiled statements kept per database, keyed by translated SQL text.
 *
 * Drizzle compiles a fresh statement for every query execution
 * (`SQLiteBunSession.prepareQuery`), and `Database.prepare` — unlike
 * `Database.query` — does not cache. A lite-mode gateway runs ~19 scheduled
 * tasks while idle, each executing the same handful of queries, so an uncached
 * path compiles a new statement (and five new closures) per tick and never
 * finalizes one: RSS climbs for hours with no traffic at all.
 *
 * Bounded because the SQL text is produced by a fixed set of Drizzle builders —
 * the key space is small and stable, not caller-supplied.
 *
 * Only SQL that `sqliteSql` left alone is cached. A rewrite inlines a value
 * into the text, and the two functions it rewrites (`now()`,
 * `gen_random_uuid()`) produce a different literal on every call — caching
 * those would pin a query to the value the first execution happened to inline.
 */
const SQLITE_STATEMENT_CACHE_MAX = 256;

export function createSqliteDatabase(file: string): Database {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  db.exec("PRAGMA foreign_keys = ON");
  if (file !== ":memory:") applyFilePragmas(db);
  // Guarded: this function has to run per database, but a caller may hand it
  // one that already went through here (a test builds a handle over a booted
  // handle). Wrapping `prepare` twice ran the translation twice, and the
  // second pass mangled SQL the first had already rewritten — `unrecognized
  // token: ":"` from a placeholder the first pass produced.
  if (SQLITE_PREPARED.has(db)) return db;
  SQLITE_PREPARED.add(db);
  const statementCache = new Map<string, Statement>();
  // Per database, never shared: a statement is only usable on the connection
  // that compiled it, and the whole map is dropped on close.
  SQLITE_STATEMENT_CACHES.set(db, statementCache);
  const prepare = db.prepare.bind(db);
  db.prepare = ((text: string) => {
    // `true` means the text was left untouched, so it is a key that will
    // compile to the same statement every time it is asked for again.
    const [translated, cacheable] = sqliteSql(text);
    if (cacheable) {
      const cached = statementCache.get(translated);
      // Returned as-is: a cached statement already carries the wrapped methods
      // below, and re-wrapping it would bind the wrapper's own wrapper.
      if (cached !== undefined) return cached;
    }
    const statement = prepare(translated);
    // bun:sqlite rejects a Date binding ("Binding expected string, TypedArray,
    // boolean, number, bigint or null"), and Drizzle's pg-core timestamp
    // columns bind `Date` objects. The schema is shared with PostgreSQL, so
    // the conversion lives here: every timestamp column is `text`, and an ISO
    // string is exactly what those columns store.
    const bind = (value: unknown): SQLQueryBindings =>
      value instanceof Date ? value.toISOString() : (value as SQLQueryBindings);
    const run = statement.run.bind(statement);
    const all = statement.all.bind(statement);
    const get = statement.get.bind(statement);
    // Drizzle's bun-sqlite session reads rows through `values`, not `all`.
    const values = statement.values.bind(statement);
    const bound = (args: unknown[]): SQLQueryBindings[] => args.map(bind);
    statement.run = ((...args: unknown[]) => run(...bound(args))) as typeof statement.run;
    statement.all = ((...args: unknown[]) => all(...bound(args))) as typeof statement.all;
    statement.get = ((...args: unknown[]) => get(...bound(args))) as typeof statement.get;
    statement.values = ((...args: unknown[]) => values(...bound(args))) as typeof statement.values;
    if (cacheable) {
      // Insertion-order eviction: `Map` iterates oldest-first, so the first key
      // is the least recently inserted one. Simple, and enough because the key
      // set is small and stable — a hit-count policy would only add state.
      if (statementCache.size >= SQLITE_STATEMENT_CACHE_MAX) {
        const oldest = statementCache.keys().next();
        if (oldest.done !== true) statementCache.delete(oldest.value);
      }
      statementCache.set(translated, statement);
    }
    return statement;
  }) as Database["prepare"];
  const exec = db.exec.bind(db);
  db.exec = ((text: string) => exec(sqliteSql(text)[0])) as Database["exec"];
  return db;
}

/**
 * Teaches the shared pg-core columns to read what bun:sqlite returns.
 *
 * The schema is written for node-postgres, whose driver hands booleans back
 * as booleans and timestamps as `Date`. bun:sqlite hands back the stored
 * value unchanged: an integer for a boolean, text for a timestamp. A
 * column's `mapFromDriverValue` is what turns a driver value into the type
 * the schema declares, and Drizzle calls it for every read — a select, a
 * join, a `returning()`. The pg-core boolean column returns its value
 * unchanged and the timestamp column only converts strings, so neither
 * produces what the schema promises from bun:sqlite's values. Replacing the
 * mapper on each column instance fixes every read at once. Writes are
 * untouched: booleans already bind as integers, and `Date` bindings are
 * converted to ISO strings in `createSqliteDatabase`.
 */
function installSqliteColumnMapping(schema: Record<string, unknown>): void {

  for (const value of Object.values(schema)) {
    const columns = tableColumns(value);
    if (columns === undefined) continue;
    const table = getTableName(Object.values(columns)[0]!.table as Parameters<typeof getTableName>[0]);
    for (const column of Object.values(columns)) {
      if (column.columnType === "PgBoolean") {
        column.mapFromDriverValue = (read) => read === null ? null : read === 1 || read === true;
      } else if (column.columnType === "PgTimestamp") {
        const convert = column.mapFromDriverValue.bind(column);
        column.mapFromDriverValue = (read) => {
          // A column declared `text` keeps whatever it was bound as, so a
          // timestamp can come back as the ISO string the writer produces, or
          // as a number — or the digits of one — when a row was restored from
          // a source that stored epoch milliseconds. `new Date` reads the
          // digits as a year and returns an invalid date, so those are
          // handled before the string conversion.
          if (typeof read === "number") return new Date(read);
          if (typeof read === "string" && /^\d+$/.test(read)) return new Date(Number(read));
          return convert(read);
        };
      }
      // Registered after the branches above replace it, so execute and the
      // builder call the same function. A column neither branch touches keeps
      // its own mapper, which is what already stringifies a numeric and parses
      // jsonb. execute is the one read that never called it.
      if (table !== undefined) {
        columnMapping.set(mappingKey(table, column.name), column.mapFromDriverValue.bind(column));
      }
    }
  }
}

interface MappedColumn {
  readonly name: string;
  readonly columnType: string;
  readonly table: object;
  mapFromDriverValue: (value: unknown) => unknown;
}

/**
 * `table.column` to the mapper that turns bun:sqlite's stored value into the
 * type the schema declares. `db.execute` reads through `prepare().all()`, which
 * never calls a column mapper, so the alias applies these itself. A name that
 * two tables share maps to the same type everywhere in this schema, and a
 * column with no entry is returned as stored.
 */
const columnMapping = new Map<string, (value: unknown) => unknown>();

function mappingKey(table: string, column: string): string {
  return `${table}.${column}`;
}

/** One row from `prepare().all()`, with every known column mapped. */
function mapExecuteRow(row: Record<string, unknown>, table: string | undefined): Record<string, unknown> {
  if (table === undefined) return row;
  const mapped: Record<string, unknown> = {};
  for (const [column, value] of Object.entries(row)) {
    const convert = columnMapping.get(mappingKey(table, column));
    mapped[column] = value === null || convert === undefined ? value : convert(value);
  }
  return mapped;
}

/**
 * The table a raw statement reads, when it reads exactly one.
 *
 * `SELECT 1` and a join read columns from nowhere or from several tables, and
 * neither can be mapped by name. Both are returned as stored, which is what
 * they already were.
 */
interface RenderedStatement {
  readonly sql: string;
  readonly params: SQLQueryBindings[];
}

/**
 * A Drizzle `sql` value as bun:sqlite runs it: `?` placeholders and the values
 * that fill them, in order.
 *
 * A chunk is text, a nested statement, or a bound value. Text is concatenated,
 * a nested statement is rendered in place, and everything else is one `?`.
 * `Date` values are converted here too, because this path prepares through the
 * raw database rather than through the wrapper in `createSqliteDatabase`.
 */
function renderExecute(query: unknown): RenderedStatement | undefined {
  const chunks = (query as { queryChunks?: unknown[] }).queryChunks;
  if (chunks === undefined) return undefined;
  const params: SQLQueryBindings[] = [];
  const sql = chunks.map((chunk) => renderChunk(chunk, params)).join("");
  return { sql, params };
}

function renderChunk(chunk: unknown, params: SQLQueryBindings[]): string {
  if (Array.isArray(chunk)) {
    return `(${chunk.map((part) => renderChunk(part, params)).join(", ")})`;
  }
  if (typeof chunk === "object" && chunk !== null && "queryChunks" in chunk) {
    return (chunk as { queryChunks: unknown[] }).queryChunks
      .map((part) => renderChunk(part, params))
      .join("");
  }
  if (typeof chunk === "object" && chunk !== null && Array.isArray((chunk as { value?: unknown }).value)) {
    return ((chunk as { value: string[] }).value).join("");
  }
  // A table, column, or quoted name is SQL text, not a bound value. Rendering
  // one as a placeholder produces `DELETE FROM ?`, which SQLite rejects with
  // `near "?": syntax error` — the failure the payload sweep logs every pass.
  const kind = drizzleKind(chunk);
  if (kind === "Table") {
    return `"${getTableName(chunk as Parameters<typeof getTableName>[0])}"`;
  }
  if (kind === "Name") return `"${(chunk as { value: string }).value}"`;
  if (kind === "Column") return `"${(chunk as { name: string }).name}"`;
  const value = chunk instanceof Date ? chunk.toISOString() : chunk;
  params.push(value as SQLQueryBindings);
  return "?";
}


function drizzleKind(chunk: unknown): string | undefined {
  if (typeof chunk !== "object" || chunk === null) return undefined;
  // A pg column's own kind is `PgUUID` or `PgTimestamp`, not `Column`. Walk
  // the constructors: the base `Column` marks every one of them.
  let ctor = chunk.constructor as { [entityKind]?: unknown } | null;
  while (ctor !== null && ctor !== Function.prototype) {
    const kind = ctor[entityKind];
    if (kind === "Column" || kind === "Table" || kind === "Name") return kind;
    ctor = Object.getPrototypeOf(ctor) as { [entityKind]?: unknown } | null;
  }
  return undefined;
}

const entityKind = Symbol.for("drizzle:entityKind");
function singleTable(sql: string): string | undefined {
    const tables = [...sql.matchAll(/\b(?:from|join)\s+"?([a-z0-9_]+)"?/gi)].map((match) => match[1]);
  const distinct = new Set(tables);
  return distinct.size === 1 ? [...distinct][0] : undefined;
}

/** The columns of one Drizzle table, or undefined for everything else in the schema. */
function tableColumns(value: unknown): Record<string, MappedColumn> | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  try {
    const columns = getTableColumns(value as Parameters<typeof getTableColumns>[0]);
    return Object.keys(columns).length > 0 ? columns as Record<string, MappedColumn> : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The handle stores run on.
 *
 * `db` is the bun-sqlite Drizzle instance. It is not the node-postgres
 * `CartethyiaDatabase` the stores are typed against — the two query builders
 * are different types — so the conversion happens once, here. The stores
 * exercise only the builder surface both drivers share.
 */
/**
 * The three statements the auth path runs on a cache miss, prepared once.
 *
 * Drizzle rebuilds the query on every call, and that rebuild measured 60x the
 * cost of the lookup itself. These are static SQL against an index, so there
 * is nothing for a builder to decide per call. The column list is exactly the
 * `api_keys` row the store maps, in the order `findActiveByHash` reads it.
 */
const AUTH_KEY_COLUMNS = [
  "id", "tenant_id", "key_hash", "key_mode", "parent_key_id", "issued_client_ip",
  "issued_client_ip_key", "label", "scopes", "requests_per_minute", "daily_token_limit",
  "monthly_token_limit", "lifetime_token_budget", "lifetime_tokens_consumed",
  "max_concurrent_requests", "model_access_mode", "model_list", "client_router_denylist",
  "model_prefix", "created_at", "enabled", "revoked_at", "banned_at", "ban_reason", "banned_until",
  "key_prefix", "key_encrypted",
  "notes_title", "notes_subtitle", "notes_body", "is_default", "sort_index",
].join(", ");

export interface SqliteAuthStatements {
  /** One active key by its hash. The auth path's first read. */
  readonly byHash: { get: (hash: string) => Record<string, unknown> | null };
  /** One active key by its id. Run only for a key that has a parent. */
  readonly byId: { get: (id: string) => Record<string, unknown> | null };
  /** Lifetime consumption across one key's children, revoked included. */
  readonly childrenConsumed: { get: (parentId: string) => { total: number } | null };
}

export function prepareAuthStatements(sqlite: Database): SqliteAuthStatements {
  // A key is active while not revoked and not under an active ban: a ban is
  // active when `banned_at` is set and `banned_until` is null (permanent) or
  // still in the future. SQLite stores timestamps as ISO text, so the
  // comparison is lexical (ISO sorts chronologically).
  const active = `enabled = 1 AND revoked_at IS NULL AND (banned_at IS NULL OR (banned_until IS NOT NULL AND banned_until <= datetime('now')))`;
  // `query`, not `prepare`: bun's `prepare` compiles a statement per call and
  // never finalizes one, while `query` caches the compiled statement behind an
  // LRU of its own. All three are constant text run once per authenticated
  // request, so they are the hottest statements in the process.
  return {
    byHash: sqlite.query(
      `SELECT ${AUTH_KEY_COLUMNS} FROM api_keys WHERE key_hash = ? AND ${active} LIMIT 1`,
    ) as SqliteAuthStatements["byHash"],
    byId: sqlite.query(
      `SELECT ${AUTH_KEY_COLUMNS} FROM api_keys WHERE id = ? AND ${active} LIMIT 1`,
    ) as SqliteAuthStatements["byId"],
    childrenConsumed: sqlite.query(
      `SELECT coalesce(sum(lifetime_tokens_consumed), 0) AS total FROM api_keys WHERE parent_key_id = ?`,
    ) as SqliteAuthStatements["childrenConsumed"],
  };
}


// A reloaded module must repatch the columns even when the handle is the
// one booted before the reload. See `buildSqliteHandle`.
installSqliteColumnMapping(fullSchema);

export function buildSqliteHandle(sqlite: Database): DatabaseHandle {
  // Reinstalled on every call, not guarded. `bun --hot` keeps the booted
  // handle in `globalThis` and never rebuilds it, so a mapping installed
  // once at boot dies with the module it patched: booleans came back as
  // integers and login rejected a valid user as `unknown_user`. The
  // reloaded module calls this again and repatches the live columns.
  installSqliteColumnMapping(fullSchema);
  const built = drizzle(sqlite, { schema: fullSchema });
  // node-postgres exposes `execute` for raw SQL. bun-sqlite exposes `run` and
  // `all` instead, and the stores were written against `execute`. The alias
  // goes through `exec` rather than `run`: `run` prepares a statement per
  // call, and a raw statement here carries its values inlined, so there is
  // nothing to bind. Affected rows are read back from `changes()`.
  const execute = (query: unknown): { rowCount: number; rows: unknown[] } => {
    // Rendered the way the bun-sqlite session renders it: `?` placeholders and
    // a params list. Joining the chunks kept only their text, so an
    // interpolated value was dropped and the statement reached SQLite with a
    // hole in it.
    const rendered = renderExecute(query);
    if (rendered === undefined) throw new Error("sqlite execute: query has no SQL text");
    // `all` for a statement that returns rows, `exec` otherwise. Readiness
    // reads the migration ledger through `execute` and decides "applied" from
    // `result.rows`; an alias that only reported `changes()` made every select
    // look empty, so a migrated database stayed "not ready" forever.
    const returnsRows = /^\s*(select|with|pragma)\b/i.test(rendered.sql);
    if (returnsRows) {
      // `all()` returns stored values, not mapped ones, so a timestamp comes
      // back as text and a boolean as 0 or 1. The builder path maps through
      // the column; this is the only read that does not, and the backup
      // import compares these values against the builder's. Map them here.
      const rows = sqlite.prepare(rendered.sql).all(...rendered.params) as Record<string, unknown>[];
      const table = singleTable(rendered.sql);
      return { rowCount: rows.length, rows: rows.map((row) => mapExecuteRow(row, table)) };
    }
    sqlite.prepare(rendered.sql).run(...rendered.params);
    const changed = sqlite.prepare("SELECT changes() AS c").get() as { c: number } | null;
    return { rowCount: changed?.c ?? 0, rows: [] };
  };
  // A transaction callback receives a fresh builder, not this handle, so the
  // `execute` alias above would not reach it. First-boot setup takes its lock
  // through `transaction.execute`, and without the alias that call throws and
  // setup can never complete on the SQLite backend.
  const transaction = built.transaction.bind(built);
  const db = Object.assign(built, {
    execute,
    transaction: (fn: (tx: unknown) => unknown) =>
      transaction((tx: object) => fn(Object.assign(tx, { execute }))),
  });
  return {
    kind: "sqlite",
    db: db as unknown as DatabaseHandle["db"],
    sqlite,
    auth: prepareAuthStatements(sqlite),
    query: (text, params) => {
      // bun:sqlite types `all` as a tuple spread, which a `readonly unknown[]`
      // cannot satisfy. The values are the bound parameters the caller built;
      // the cast is confined to this one call.
      const bound = (params ?? []) as Parameters<ReturnType<Database["prepare"]>["all"]>;
      const rows = sqlite.prepare(text).all(...bound) as unknown[];
      return Promise.resolve({ rows });
    },
    exec: (script) => {
      sqlite.exec(script);
      return Promise.resolve();
    },
    close: () => {
      // The cache has to go first: `close(true)` releases the connection
      // immediately, and a map still holding the statements would keep them
      // reachable after the handle is gone.
      SQLITE_STATEMENT_CACHES.get(sqlite)?.clear();
      SQLITE_STATEMENT_CACHES.delete(sqlite);
      // `true`, not the default: without it bun uses `sqlite3_close_v2`, which
      // defers the release until every outstanding statement is finalized or
      // collected. Nothing here finalizes explicitly, so the default left the
      // connection — and its pages — held indefinitely, which is the idle
      // growth this backend was seeing. `sqlite3_close` finalizes them now.
      sqlite.close(true);
      return Promise.resolve();
    },
  };
}

/**
 * Applies the SQLite migration set in order.
 *
 * Same ledger, same skip-when-recorded rule, and the same one-file-per-
 * transaction atomicity as the PostgreSQL runner. Two deliberate absences,
 * both consequences of being the only process: no advisory lock, because a
 * second process cannot open the file for writing, and no
 * `to_regclass` probe, because SQLite has no schemas — `sqlite_master`
 * answers the same question.
 */
/**
 * Rewrites the two PostgreSQL functions the schema's defaults emit.
 *
 * `gen_random_uuid()` becomes a quoted uuid. `now()` becomes a quoted UTC
 * timestamp. Both are matched only as function calls, so a column or string
 * that merely contains the words is left alone.
 */
/**
 * Rewrites the two PostgreSQL functions the schema's defaults emit, and only
 * those. A statement that contains neither is returned as-is, so the common
 * case — every read, and every write that supplies its own values — pays one
 * `includes` and nothing else.
 *
 * The second element tells the caller whether the text is a stable cache key.
 * Both rewrites substitute a value that differs per call, so a rewritten
 * statement must be compiled fresh every time; see `SQLITE_STATEMENT_CACHE_MAX`.
 */
function sqliteSql(text: string): [sql: string, cacheable: boolean] {
  if (!text.includes("gen_random_uuid()") && !text.includes("now()")) return [text, true];
  return [text
    .replaceAll("gen_random_uuid()", () => `'${randomUUID()}'`)
    .replaceAll("now()", () => `'${new Date().toISOString()}'`), false];
}

/**
 * Pragmas for a file-backed database. Each one removes a stall or a fsync the
 * default pays per commit, and none of them weakens crash safety below what
 * the usage flush already accepts (at most the last second of deltas).
 *
 * `synchronous = NORMAL` is durable against a process crash under WAL; only a
 * power loss can drop the last commit. `busy_timeout` makes a writer wait
 * instead of failing instantly when a sweep holds the lock. The cache is 8 MB:
 * large enough for auth and the active catalog working set, without reserving
 * 64 MB that an idle gateway never touches. `temp_store` keeps sorts off disk.
 * The checkpoint interval keeps a request from stalling on one.
 */
function applyFilePragmas(db: Database): void {
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA cache_size = -8192");
  db.exec("PRAGMA temp_store = MEMORY");
  db.exec("PRAGMA wal_autocheckpoint = 1000");
}

/** The SQLite set lives beside the PostgreSQL one, never inside it. */
export function resolveSqliteMigrationsFolder(): string {
  return resolvePackagePath("migrations", "lite-sqlite3");
}

export async function applySqliteMigrations(
  sqlite: Database,
  folder = resolveSqliteMigrationsFolder(),
): Promise<void> {
  sqlite.exec(SQLITE_LEDGER_DDL);
  const appliedRows = sqlite
    .prepare(`SELECT migration_id FROM ${MIGRATION_LEDGER_TABLE}`)
    .all() as { migration_id: string }[];
  const applied = new Set(appliedRows.map((row) => row.migration_id));

  const tenants = sqlite
    .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'tenants'")
    .get() as { present: number } | null;
  const files = migrationFiles(folder);
  const baselineFile = files.find((file) => migrationIdFor(file) === BASELINE_MIGRATION_ID);
  const baselineSource =
    baselineFile === undefined ? undefined : readFileSync(baselineFile, "utf8");
  const baselineMarker =
    baselineSource === undefined ? undefined : baselineSchemaMarker(baselineSource);
  assertMigrationHistorySupported(
    applied,
    [
      ...files.map(migrationIdFor),
      ...(baselineMarker === undefined ? [] : [baselineMarker]),
      ...(baselineSource === undefined ? [] : acceptedBaselineSchemaMarkers(baselineSource)),
    ],
    tenants !== null,
    baselineMarker,
  );

  for (const file of files) {
    const migrationId = migrationIdFor(file);
    if (applied.has(migrationId)) continue;
    const source = readFileSync(file, "utf8");
    const record = sqlite.prepare(
      `INSERT INTO ${MIGRATION_LEDGER_TABLE} (migration_id) VALUES (?)`,
    );
    try {
      sqlite.transaction(() => {
        for (const statement of splitStatements(source)) {
          // The generated baseline opens with a comment block, and a
          // breakpoint at the end of a file leaves an empty part. `exec`
          // rejects both, so only text that still contains SQL is sent.
          const sql = statement.replace(/--[^\n]*/g, "").trim();
          if (sql.length === 0) continue;
          sqlite.exec(sql);
        }
        record.run(migrationId);
        if (migrationId === BASELINE_MIGRATION_ID && baselineMarker !== undefined) {
          record.run(baselineMarker);
        }
      })();
      applied.add(migrationId);
      if (migrationId === BASELINE_MIGRATION_ID && baselineMarker !== undefined) {
        applied.add(baselineMarker);
      }
    } catch (error) {
      throw new Error(`Migration ${migrationId} failed: ${String(error)}`, { cause: error });
    }
  }
}
