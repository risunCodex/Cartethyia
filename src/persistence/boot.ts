/**
 * Database boot: builds the active backend handle once per process, migrates it,
 * and owns the process-wide handle. Stores never import this — they take a
 * database handle from their caller.
 */
import { log } from "../observability/logger";
import { join } from "node:path";
import type { CartethyiaDatabase, DatabaseHandle } from "./db-handle";
import { resolveDataDir, resolveDbMode } from "./db-mode";
import { applySqlMigrations, createPgHandle, getPool, isPgHandle } from "./db-pg";
import { applySqliteMigrations, buildSqliteHandle, createSqliteDatabase } from "./db-sqlite";

/**
 * True when `error` is a unique-violation from either supported dialect:
 *
 * - Postgres: SQLSTATE 23505 (`code: "23505"`).
 * - SQLite: `UNIQUE constraint failed: <index>` (message text) or the
 *   driver's `SQLITE_CONSTRAINT_UNIQUE` code (19).
 *
 * Lives at the persistence boundary because it is a fact about the driver's
 * error shape, not about any one domain. It walks a bounded `cause` chain
 * because Drizzle wraps driver errors, so the code/message is not always on
 * the error the caller catches.
 */
export function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 3; depth += 1) {
    if (typeof current !== "object" || current === null) return false;
    const record = current as { code?: unknown; message?: unknown };
    const code = typeof record.code === "string" ? record.code : "";
    const message = typeof record.message === "string" ? record.message : "";
    if (code === "23505" || code === "SQLITE_CONSTRAINT_UNIQUE") return true;
    if (message.includes("UNIQUE constraint failed:")) return true;
    if (code === "19" && message.includes("constraint")) return true;
    if (!("cause" in current)) return false;
    current = current.cause;
  }
  return false;
}

declare global {
  // eslint-disable-next-line no-var -- globalThis augmentation requires `var`
  var __cartethyiaHandle: DatabaseHandle | undefined;
  // eslint-disable-next-line no-var
  var __cartethyiaMigrated: boolean | undefined;
}

/**
 * Builds the active backend handle once. Async because the PostgreSQL path
 * migrates asynchronously; the SQLite path opens synchronously inside.
 * Safe to call repeatedly — the first handle wins for the process lifetime.
 *
 * Lite boots (open, migrate, handle) in one step: the ledger makes repeat
 * boots cheap, and a handle without migrated tables behind it is never valid.
 */
export async function bootDatabase(): Promise<DatabaseHandle> {
  if (globalThis.__cartethyiaHandle) {
    // The cached handle survives a hot reload, but the column mapping does
    // not: it patched the previous module's columns. Reinstall it so a
    // reloaded module reads booleans as booleans.
    const raw = globalThis.__cartethyiaHandle.sqlite;
    if (resolveDbMode() === "lite" && raw) buildSqliteHandle(raw);
    return globalThis.__cartethyiaHandle;
  }
  if (resolveDbMode() === "lite") {
    const sqlite = createSqliteDatabase(join(resolveDataDir(), "cartethyia.sqlite"));
    try {
      await applySqliteMigrations(sqlite);
    } catch (error) {
      sqlite.close();
      throw error;
    }
    const handle = buildSqliteHandle(sqlite);
    globalThis.__cartethyiaHandle = handle;
    log.warn("[db] lite mode: embedded SQLite, single process only");
    return handle;
  }
  const handle = createPgHandle();
  globalThis.__cartethyiaHandle = handle;
  return handle;
}

/** Active backend handle; throws when the database has not booted yet. */
export function getDbHandle(): DatabaseHandle {
  if (globalThis.__cartethyiaHandle) {
    // The cached handle survives a hot reload, but the column mapping does
    // not: it patched the previous module's columns. Reinstall it so a
    // reloaded module reads booleans as booleans.
    const raw = globalThis.__cartethyiaHandle.sqlite;
    if (resolveDbMode() === "lite" && raw) buildSqliteHandle(raw);
    return globalThis.__cartethyiaHandle;
  }
  if (resolveDbMode() === "lite") {
    throw new Error("Lite database is not booted: await bootDatabase() before getDb()");
  }
  const handle = createPgHandle();
  globalThis.__cartethyiaHandle = handle;
  return handle;
}

export function getDb(): CartethyiaDatabase {
  return getDbHandle().db;
}

export async function ensureMigrated(): Promise<void> {
  if (globalThis.__cartethyiaMigrated) return;
  const handle = await bootDatabase();
  // Lite migrates during boot; pg migrates here under its advisory lock.
  if (isPgHandle(handle)) {
    await applySqlMigrations(handle.pool);
  }
  globalThis.__cartethyiaMigrated = true;
}

/**
 * Reports how many gateway processes this server's connection budget supports.
 *
 * The gateway is designed to run several processes against one port
 * (`reusePort` in `main.ts`), and each process opens its own pool of
 * `DATABASE_POOL_MAX` connections. Nothing in a single process can see its
 * siblings, so the only honest thing to do is tell the operator the arithmetic
 * they cannot see from the config file: with `poolMax` per process and
 * `max_connections` on the server, how many processes fit.
 *
 * `processCount` is the configured count: the budget is
 * `processCount × poolMax`, not `poolMax`. Without it a four-process deploy
 * that looked fine per-process exhausts `max_connections` in aggregate — and
 * does so under load rather than at boot.
 *
 * A pool that alone meets or exceeds the server ceiling is unambiguously
 * broken even for one process, so that fails the boot. Anything else is a
 * warning with the usable process count, because a single-process deployment
 * is legitimate and the operator — not this process — knows how many they run.
 */
export async function assertPoolFitsServerCapacity(
  poolMax: number,
  processCount = 1,
): Promise<void> {
  let serverMax: number;
  try {
    const result = await getPool().query<{ max_connections: string }>("SHOW max_connections");
    serverMax = Number(result.rows[0]?.max_connections);
  } catch (error) {
    // Capacity is a diagnostic, not a correctness requirement: a server that
    // refuses `SHOW` (restricted role) must not stop the gateway from serving.
    log.warn("[postgres] could not read max_connections; skipping pool capacity check", error);
    return;
  }
  if (!Number.isFinite(serverMax) || serverMax < 1) return;

  const needed = poolMax * Math.max(1, processCount);
  if (needed >= serverMax) {
    // A plain Error, not a GatewayError: this fires during boot, before any
    // request exists to shape an envelope for, and persistence must not depend
    // on the protocol layer for a diagnostic the operator reads in the log.
    // The `code` property keeps the stable identifier a boot log can match on.
    throw Object.assign(
      new Error(
        `DATABASE_POOL_MAX (${poolMax}) × ${Math.max(1, processCount)} process(es) = ${needed} connections, ` +
          `which meets or exceeds the server's max_connections (${serverMax}); ` +
          "the last process would be refused a full pool and every connection after that would fail",
      ),
      { code: "max_connections_exceeded", poolMax, serverMax, processCount, needed },
    );
  }

  const processes = Math.floor(serverMax / poolMax);
  if (processes < processCount) {
    log.warn(
      `[postgres] DATABASE_POOL_MAX=${poolMax} leaves room for ${processes} gateway process(es) ` +
        `on a server with max_connections=${serverMax}, but ${processCount} are configured; ` +
        "the surplus process would exhaust the budget",
      { pool_max: poolMax, max_connections: serverMax, processes, processCount },
    );
    return;
  }
  log.info(
    `[postgres] pool budget: ${processes} gateway processes fit ` +
      `(DATABASE_POOL_MAX=${poolMax}, max_connections=${serverMax})`,
  );
}

export async function closeDb(): Promise<void> {
  const handle = globalThis.__cartethyiaHandle;
  globalThis.__cartethyiaHandle = undefined;
  globalThis.__cartethyiaMigrated = false;
  if (handle) await handle.close();
}
