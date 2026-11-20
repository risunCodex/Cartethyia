/**
 * A rate limit without a usable time is a skip, not a cooldown.
 *
 * Two upstream shapes reached the health machine with no window to wait out:
 * a 429 that names no reset at all, and OpenRouter's shared-pool
 * `retry_after_seconds: 1` — a "retry shortly" nudge. Both used to park the
 * account on an invented 15-minute fallback (or floor the trivial window up to
 * it) and stamp a "Rate limited" pill that outlived any window with no
 * deadline behind it — the flag the operator had to clear by hand. Now neither
 * mutates the account: the request fails over, the account stays `active`, and
 * the audit row — rendered with the account's own status, not the verdict's
 * shape — is the only record. A window the account *can* wait out is honored
 * verbatim, so a flagged cooldown always carries the provider's own time.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database as SqliteDatabase } from "bun:sqlite";
import { applySqliteMigrations, buildSqliteHandle, createSqliteDatabase } from "../../src/persistence/db-sqlite";
import type { CartethyiaDatabase } from "../../src/persistence/db-handle";
import { healthEvents, providerAccounts, providers } from "../../src/persistence/schema";
import { and, eq } from "drizzle-orm";
import { recordAccountFailure } from "../../src/providers/operations/account-health-service";
import { resetCooldownCacheForTests } from "../../src/config/cooldowns";

let dir: string | undefined;
let sqlite: SqliteDatabase | undefined;
let db: CartethyiaDatabase | undefined;
let previousMode: string | undefined;

beforeEach(async () => {
  previousMode = process.env.CARTETHYIA_DB_MODE;
  process.env.CARTETHYIA_DB_MODE = "lite";
  dir = mkdtempSync(join(tmpdir(), "cartethyia-rl-skip-"));
  sqlite = createSqliteDatabase(join(dir, "cartethyia.sqlite"));
  await applySqliteMigrations(sqlite);
  db = buildSqliteHandle(sqlite).db;
  resetCooldownCacheForTests();
});

afterEach(() => {
  sqlite?.close();
  if (dir !== undefined) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows holds the file briefly after close; the temp dir is disposable.
    }
  }
  sqlite = undefined;
  db = undefined;
  dir = undefined;
  if (previousMode === undefined) delete process.env.CARTETHYIA_DB_MODE;
  else process.env.CARTETHYIA_DB_MODE = previousMode;
  resetCooldownCacheForTests();
});

let providerSequence = 0;

/** One fresh provider+account per call, so the in-process dedupe stamps of one
 * test can never compress another test's audit rows. */
async function insertAccount(): Promise<string> {
  providerSequence += 1;
  const providerId = `p-rl-skip-${providerSequence}`;
  await db!.insert(providers).values({ id: providerId });
  const [row] = await db!
    .insert(providerAccounts)
    .values({ providerId, label: "account", credentialKind: "api_key", status: "active" })
    .returning({ id: providerAccounts.id });
  if (!row) throw new Error("account insert returned no row");
  return row.id;
}

async function rowOf(accountId: string): Promise<{
  status?: string;
  cooldownUntil?: Date | null;
  lastError?: string | null;
  lastErrorCategory?: string | null;
  consecutiveFailures?: number;
}> {
  const [row] = await db!
    .select({
      status: providerAccounts.status,
      cooldownUntil: providerAccounts.cooldownUntil,
      lastError: providerAccounts.lastError,
      lastErrorCategory: providerAccounts.lastErrorCategory,
      consecutiveFailures: providerAccounts.consecutiveFailures,
    })
    .from(providerAccounts)
    .where(eq(providerAccounts.id, accountId));
  return row ?? {};
}

async function eventsFor(accountId: string) {
  return db!
    .select({
      fromStatus: healthEvents.fromStatus,
      toStatus: healthEvents.toStatus,
      reason: healthEvents.reason,
      errorCategory: healthEvents.errorCategory,
    })
    .from(healthEvents)
    .where(and(eq(healthEvents.entityKind, "account"), eq(healthEvents.accountId, accountId)));
}

/** The non-mutating audit write is fire-and-forget; give it a beat to land. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 25));
}

const account429 = {
  origin: "upstream" as const,
  scope: "account" as const,
  statusCode: 429,
  credentialEvidence: true,
};

test("an unstated 429 skips: the row is untouched and the audit row names the account's real status", async () => {
  const accountId = await insertAccount();
  const classification = await recordAccountFailure(db!, accountId, new Error("Too many requests"), account429);
  expect(classification?.mutatesAccount).toBe(false);
  await settle();

  const row = await rowOf(accountId);
  expect(row.status).toBe("active");
  expect(row.cooldownUntil).toBeNull();
  expect(row.lastErrorCategory).toBeNull();
  expect(row.lastError).toBeNull();
  expect(row.consecutiveFailures).toBe(0);

  const events = await eventsFor(accountId);
  expect(events).toHaveLength(1);
  // The verdict's shape is "cooldown", but nothing was cooled — the row must
  // say the account's own status, not claim a transition that never happened.
  expect(events[0]).toMatchObject({
    fromStatus: "active",
    toStatus: "active",
    errorCategory: "rate_limit_transient",
  });
});

test("an immediate repeat of the same skip is compressed into the first audit row", async () => {
  const accountId = await insertAccount();
  await recordAccountFailure(db!, accountId, new Error("Too many requests"), account429);
  await recordAccountFailure(db!, accountId, new Error("Too many requests"), account429);
  await settle();

  const events = await eventsFor(accountId);
  expect(events).toHaveLength(1);
  const row = await rowOf(accountId);
  expect(row.status).toBe("active");
  expect(row.lastErrorCategory).toBeNull();
});

test("OpenRouter's shared-pool one-second retry_after is a skip too", async () => {
  const accountId = await insertAccount();
  const classification = await recordAccountFailure(db!, accountId, new Error("rate limit exceeded"), {
    ...account429,
    retryAfterMs: 1_000,
  });
  expect(classification?.mutatesAccount).toBe(false);
  await settle();

  const row = await rowOf(accountId);
  expect(row.status).toBe("active");
  expect(row.cooldownUntil).toBeNull();
  expect(row.lastErrorCategory).toBeNull();
  const events = await eventsFor(accountId);
  expect(events).toHaveLength(1);
  expect(events[0]?.fromStatus).toBe("active");
});

test("a stated window cools the account verbatim with the provider's own time", async () => {
  const accountId = await insertAccount();
  const before = Date.now();
  const classification = await recordAccountFailure(db!, accountId, new Error("rate limit exceeded"), {
    ...account429,
    retryAfterMs: 120_000,
  });
  expect(classification?.mutatesAccount).toBe(true);
  expect(classification?.cooldownMs).toBe(120_000);

  const row = await rowOf(accountId);
  expect(row.status).toBe("cooldown");
  expect(row.lastErrorCategory).toBe("rate_limit_transient");
  const until = (row.cooldownUntil as Date).getTime();
  expect(until - before).toBeGreaterThanOrEqual(119_000);
  expect(until - before).toBeLessThanOrEqual(121_000);

  const events = await eventsFor(accountId);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ fromStatus: "active", toStatus: "cooldown" });
});
