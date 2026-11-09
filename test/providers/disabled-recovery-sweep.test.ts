/**
 * A `disabled` account is never re-enabled by the sweep.
 *
 * Disabling is an operator decision (manual toggle) or a terminal machine
 * verdict (a revoked credential). Either way the recovery sweep must not undo
 * it: only an operator's explicit recovery re-enables a disabled account. The
 * sweep's only job is to return ordinary `cooldown` rows to rotation once
 * their window elapses.
 *
 * This runs against a real migrated SQLite file rather than a double, because
 * the property under test is a compound `WHERE` over status values and a
 * null check — precisely what a chainable double would let me assert instead of
 * prove.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database as SqliteDatabase } from "bun:sqlite";
import { applySqliteMigrations, buildSqliteHandle, createSqliteDatabase } from "../../src/persistence/db-sqlite";
import type { CartethyiaDatabase } from "../../src/persistence/db-handle";
import { providers, providerAccounts, providerOauthStates, healthEvents } from "../../src/persistence/schema";
import { and, eq } from "drizzle-orm";
import { sweepExpiredCooldowns } from "../../src/providers/operations/account-health-service";
import { resetCooldownCacheForTests } from "../../src/config/cooldowns";
import { loadDueOAuthAccounts, OAuthRefreshService, type OAuthTokenRefresher } from "../../src/providers/authentication/oauth-refresh-service";
import { encryptCredential } from "../../src/security/crypto";

/** Recovery window the boot-time reader resolves when the env var is unset. */
const DEFAULT_RECOVERY_MS = 86_400_000;

let dir: string | undefined;
let sqlite: SqliteDatabase | undefined;
let db: CartethyiaDatabase | undefined;
let providerId: string | undefined;
let previousMode: string | undefined;
let previousRecovery: string | undefined;

beforeEach(async () => {
  // The sweep's per-model pruning picks its SQL from `resolveDbMode()`, so a
  // file-backed fixture needs the mode to name the backend it is actually
  // writing to. This suite pins its own mode so it does not depend on local env.
  previousMode = process.env.CARTETHYIA_DB_MODE;
  previousRecovery = process.env.CARTETHYIA_ACCOUNT_DISABLED_RECOVERY_MS;
  process.env.CARTETHYIA_DB_MODE = "lite";
  dir = mkdtempSync(join(tmpdir(), "cartethyia-disabled-recovery-"));
  sqlite = createSqliteDatabase(join(dir, "cartethyia.sqlite"));
  await applySqliteMigrations(sqlite);
  db = buildSqliteHandle(sqlite).db;
  delete process.env.CARTETHYIA_ACCOUNT_DISABLED_RECOVERY_MS;
  resetCooldownCacheForTests();
  const [provider] = await db
    .insert(providers)
    .values({ id: "rec-provider" })
    .returning({ id: providers.id });
  providerId = provider?.id ?? "rec-provider";
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
  providerId = undefined;
  if (previousMode === undefined) delete process.env.CARTETHYIA_DB_MODE;
  else process.env.CARTETHYIA_DB_MODE = previousMode;
  if (previousRecovery === undefined) delete process.env.CARTETHYIA_ACCOUNT_DISABLED_RECOVERY_MS;
  else process.env.CARTETHYIA_ACCOUNT_DISABLED_RECOVERY_MS = previousRecovery;
  resetCooldownCacheForTests();
});

/** One account row in a given health state, carrying `cooldownUntil`. */
async function insertAccount(options: {
  label: string;
  status: "cooldown" | "disabled";
  cooldownUntil: Date | null;
  lastErrorCategory?: string | null;
  lastError?: string | null;
}): Promise<string> {
  if (!db || !providerId) throw new Error("fixture not initialised");
  const [row] = await db
    .insert(providerAccounts)
    .values({
      providerId,
      label: options.label,
      credentialKind: "api_key",
      status: options.status,
      cooldownUntil: options.cooldownUntil,
      lastErrorCategory:
        options.lastErrorCategory ?? (options.status === "disabled" ? "auth_invalidated" : null),
      lastError: options.lastError ?? null,
      consecutiveFailures: 4,
    })
    .returning({ id: providerAccounts.id });
  if (!row) throw new Error("account insert returned no row");
  return row.id;
}

async function statusOf(accountId: string): Promise<string | undefined> {
  if (!db) throw new Error("fixture not initialised");
  const [row] = await db
    .select({ status: providerAccounts.status })
    .from(providerAccounts)
    .where(eq(providerAccounts.id, accountId));
  return row?.status;
}

function handle(): CartethyiaDatabase {
  if (!db) throw new Error("fixture not initialised");
  return db;
}

/** A refresher whose refresh grant is definitively dead. */
function revokedRefresher(): OAuthTokenRefresher {
  return {
    refresh: () => Promise.reject(new Error("invalid_grant: refresh token revoked")),
  };
}

/** Inserts an OAuth account row plus its oauth state; returns the account id. */
async function insertOauthAccount(options: {
  status: "cooldown" | "disabled";
  cooldownUntil: Date | null;
  refreshToken?: string | null;
}): Promise<string> {
  if (!db || !providerId) throw new Error("fixture not initialised");
  const [row] = await db
    .insert(providerAccounts)
    .values({
      providerId,
      label: options.status,
      credentialKind: "oauth",
      credentialCiphertext: encryptCredential("access-token"),
      status: options.status,
      cooldownUntil: options.cooldownUntil,
      lastErrorCategory: options.status === "disabled" ? "auth_invalidated" : null,
      consecutiveFailures: 4,
    })
    .returning({ id: providerAccounts.id });
  if (!row) throw new Error("account insert returned no row");
  await db.insert(providerOauthStates).values({
    providerAccountId: row.id,
    refreshCiphertext:
      options.refreshToken === null || options.refreshToken === undefined
        ? null
        : encryptCredential(options.refreshToken),
    expiresAt: new Date(Date.now() + 3_600_000),
  });
  return row.id;
}

test("an automatic disable is never re-enabled by the sweep", async () => {
  const accountId = await insertAccount({
    label: "auto-disabled",
    status: "disabled",
    cooldownUntil: new Date(Date.now() - 1_000),
  });

  const recovered = await sweepExpiredCooldowns(handle());

  expect(recovered).toBe(0);
  expect(await statusOf(accountId)).toBe("disabled");
});

test("an operator disable — no deadline — is never swept", async () => {
  // The whole safety argument rests on this row surviving. If the sweep ever
  // recovers it, the machine has overruled a human.
  const accountId = await insertAccount({
    label: "operator-disabled",
    status: "disabled",
    cooldownUntil: null,
  });

  expect(await sweepExpiredCooldowns(handle())).toBe(0);
  expect(await statusOf(accountId)).toBe("disabled");
});

test("an automatic disable whose deadline has not arrived stays parked", async () => {
  const accountId = await insertAccount({
    label: "auto-disabled-pending",
    status: "disabled",
    cooldownUntil: new Date(Date.now() + DEFAULT_RECOVERY_MS),
  });

  expect(await sweepExpiredCooldowns(handle())).toBe(0);
  expect(await statusOf(accountId)).toBe("disabled");
});

test("a plain cooldown is still recovered exactly as before", async () => {
  // The pre-existing behavior, pinned so the `or(...)` clause cannot come at
  // its expense.
  const accountId = await insertAccount({
    label: "cooling",
    status: "cooldown",
    cooldownUntil: new Date(Date.now() - 5_000),
  });
  const stillCooling = await insertAccount({
    label: "cooling-active",
    status: "cooldown",
    cooldownUntil: new Date(Date.now() + 600_000),
  });

  expect(await sweepExpiredCooldowns(handle())).toBe(1);
  expect(await statusOf(accountId)).toBe("active");
  expect(await statusOf(stillCooling)).toBe("cooldown");
});

test("a disabled account keeps its error state because it is never recovered", async () => {
  // The machine disable recorded the reason (`auth_invalidated`) and the
  // streak; since the sweep leaves disabled rows alone, both must survive
  // unchanged rather than being reset as if the account had recovered.
  const accountId = await insertAccount({
    label: "auto-disabled-category",
    status: "disabled",
    cooldownUntil: new Date(Date.now() - 1_000),
  });

  await sweepExpiredCooldowns(handle());

  const [row] = await db!
    .select({
      lastErrorCategory: providerAccounts.lastErrorCategory,
      consecutiveFailures: providerAccounts.consecutiveFailures,
    })
    .from(providerAccounts)
    .where(eq(providerAccounts.id, accountId));
  expect(row?.lastErrorCategory).toBe("auth_invalidated");
  expect(row?.consecutiveFailures).toBe(4);
});

test("no recovery event is written for an untouched disabled account", async () => {
  const accountId = await insertAccount({
    label: "auto-disabled-audit",
    status: "disabled",
    cooldownUntil: new Date(Date.now() - 1_000),
  });

  await sweepExpiredCooldowns(handle());

  const rows = await db!
    .select({
      fromStatus: healthEvents.fromStatus,
      toStatus: healthEvents.toStatus,
    })
    .from(healthEvents)
    .where(
      and(eq(healthEvents.entityKind, "account"), eq(healthEvents.accountId, accountId)),
    );
  expect(rows).toHaveLength(0);
});

test("a terminal auth-invalidated account is excluded from automatic OAuth refresh", async () => {
  const accountId = await insertOauthAccount({
    status: "disabled",
    cooldownUntil: null,
    refreshToken: "rt",
  });
  await db!
    .update(providerAccounts)
    .set({ lastErrorCategory: "auth_invalidated", lastError: "Trae HTTP 401 code 1001" })
    .where(eq(providerAccounts.id, accountId));

  const due = await loadDueOAuthAccounts(handle(), 0);
  expect(due.some((account) => account.id === accountId)).toBe(false);

  let refreshCalls = 0;
  const service = new OAuthRefreshService(handle());
  expect(await service.ensureFreshAccessToken(accountId, {
    refresh: async () => {
      refreshCalls += 1;
      return { access: "new", expiresAt: new Date(Date.now() + 60_000) };
    },
  }, { force: true, origin: "ui" })).toBeNull();
  expect(refreshCalls).toBe(0);
});

test("D23: a definitive refresh failure on an operator-disabled account does not write cooldownUntil", async () => {
  // Operator disable = disabled with NO deadline. A later machine refresh
  // failure must not add one, or the row would look recoverable.
  const accountId = await insertOauthAccount({
    status: "disabled",
    cooldownUntil: null,
    refreshToken: "rt",
  });

  const service = new OAuthRefreshService(handle());
  await service.ensureFreshAccessToken(accountId, revokedRefresher(), {
    force: true,
  });

  const [row] = await db!
    .select({
      status: providerAccounts.status,
      cooldownUntil: providerAccounts.cooldownUntil,
      lastErrorCategory: providerAccounts.lastErrorCategory,
    })
    .from(providerAccounts)
    .where(eq(providerAccounts.id, accountId));
  expect(row?.status).toBe("disabled");
  expect(row?.cooldownUntil).toBeNull();
  // The definitive failure still records the reason.
  expect(row?.lastErrorCategory).toBe("auth_invalidated");
});

test("D23: a definitive refresh failure on a machine-disabled account keeps its deadline", async () => {
  // Machine disable carries a recovery deadline; a second failure must not
  // strip it.
  const accountId = await insertOauthAccount({
    status: "disabled",
    cooldownUntil: new Date(Date.now() + DEFAULT_RECOVERY_MS),
    refreshToken: "rt",
  });

  const service = new OAuthRefreshService(handle());
  await service.ensureFreshAccessToken(accountId, revokedRefresher(), {
    force: true,
  });

  const [row] = await db!
    .select({
      status: providerAccounts.status,
      cooldownUntil: providerAccounts.cooldownUntil,
    })
    .from(providerAccounts)
    .where(eq(providerAccounts.id, accountId));
  expect(row?.status).toBe("disabled");
  expect(row?.cooldownUntil).not.toBeNull();
});

test("an auto-disabled quota row whose marker and deadline are present is recovered", async () => {
  // D03/R-B: the auto-disable intercept writes a marker reason and a recovery
  // deadline; the sweep may undo the machine's own verdict once the deadline
  // elapses. This is the new recovery path for area 01.
  const accountId = await insertAccount({
    label: "auto-disabled-quota",
    status: "disabled",
    cooldownUntil: new Date(Date.now() - 1_000),
    lastErrorCategory: "quota_exhausted",
    lastError: "auto-disable (rate-limited): Provider quota exhausted",
  });

  expect(await sweepExpiredCooldowns(handle())).toBe(1);
  expect(await statusOf(accountId)).toBe("active");
});

test("an auto-disabled rate-limit row whose marker and deadline are present is recovered", async () => {
  const accountId = await insertAccount({
    label: "auto-disabled-ratelimit",
    status: "disabled",
    cooldownUntil: new Date(Date.now() - 1_000),
    lastErrorCategory: "rate_limit_transient",
    lastError: "auto-disable (rate-limited): Provider rate limit",
  });

  expect(await sweepExpiredCooldowns(handle())).toBe(1);
  expect(await statusOf(accountId)).toBe("active");
});

test("an auto-disabled row with the marker but a future deadline stays parked", async () => {
  const accountId = await insertAccount({
    label: "auto-disabled-pending-marker",
    status: "disabled",
    cooldownUntil: new Date(Date.now() + DEFAULT_RECOVERY_MS),
    lastErrorCategory: "quota_exhausted",
    lastError: "auto-disable (rate-limited): Provider quota exhausted",
  });

  expect(await sweepExpiredCooldowns(handle())).toBe(0);
  expect(await statusOf(accountId)).toBe("disabled");
});

test("an operator disabled row with a target category but no marker is terminal", async () => {
  // R-B: the marker is mandatory. A bulk/operator disable that shares the
  // category and an elapsed deadline must not be re-enabled by the sweep.
  const accountId = await insertAccount({
    label: "operator-disabled-quota",
    status: "disabled",
    cooldownUntil: new Date(Date.now() - 1_000),
    lastErrorCategory: "quota_exhausted",
    lastError: "operator bulk disable",
  });

  expect(await sweepExpiredCooldowns(handle())).toBe(0);
  expect(await statusOf(accountId)).toBe("disabled");
});

test("a disabled row with the marker but a non-target category is terminal", async () => {
  const accountId = await insertAccount({
    label: "marker-non-target",
    status: "disabled",
    cooldownUntil: new Date(Date.now() - 1_000),
    lastErrorCategory: "auth_invalidated",
    lastError: "auto-disable (rate-limited): Provider credential revoked",
  });

  expect(await sweepExpiredCooldowns(handle())).toBe(0);
  expect(await statusOf(accountId)).toBe("disabled");
});
