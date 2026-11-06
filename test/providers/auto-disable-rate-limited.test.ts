/**
 * Auto-disable of rate-limited accounts (area 01, D01–D06).
 *
 * When the `autoDisableRateLimited` preference is on, an upstream 429/quota
 * verdict that would normally cooldown the account instead disables it
 * (status `disabled`) with the marker reason `auto-disable (rate-limited): …`
 * and the configured recovery window. The recovery sweep is the only automatic
 * path back (D03); an operator disable stays terminal.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database as SqliteDatabase } from "bun:sqlite";
import { applySqliteMigrations, buildSqliteHandle, createSqliteDatabase } from "../../src/persistence/db-sqlite";
import type { CartethyiaDatabase } from "../../src/persistence/db-handle";
import { consoleSettings, healthEvents, providerAccounts, providers, tenants } from "../../src/persistence/schema";
import { and, eq } from "drizzle-orm";
import {
  autoDisableRateLimitedEnabled,
  recordAccountFailure,
  sweepExpiredCooldowns,
} from "../../src/providers/operations/account-health-service";
import { resetCooldownCacheForTests } from "../../src/config/cooldowns";

const RECOVERY_MS = 5 * 60 * 1000;

let dir: string | undefined;
let sqlite: SqliteDatabase | undefined;
let db: CartethyiaDatabase | undefined;
let previousMode: string | undefined;
let previousRecovery: string | undefined;

beforeEach(async () => {
  previousMode = process.env.CARTETHYIA_DB_MODE;
  previousRecovery = process.env.CARTETHYIA_ACCOUNT_DISABLED_RECOVERY_MS;
  process.env.CARTETHYIA_DB_MODE = "lite";
  process.env.CARTETHYIA_ACCOUNT_DISABLED_RECOVERY_MS = String(RECOVERY_MS);
  dir = mkdtempSync(join(tmpdir(), "cartethyia-auto-disable-"));
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
  if (previousRecovery === undefined) delete process.env.CARTETHYIA_ACCOUNT_DISABLED_RECOVERY_MS;
  else process.env.CARTETHYIA_ACCOUNT_DISABLED_RECOVERY_MS = previousRecovery;
  resetCooldownCacheForTests();
});

const TENANT = "t-auto-disable";
const PROVIDER = "p-auto-disable";

async function seedTenant(): Promise<void> {
  await db!.insert(tenants).values({ id: TENANT, name: "auto-disable", status: "active" });
  await db!.insert(providers).values({ id: PROVIDER });
}

async function setToggle(on: boolean): Promise<void> {
  await db!
    .insert(consoleSettings)
    .values({ tenantId: TENANT, preferences: on ? { autoDisableRateLimited: true } : {} })
    .onConflictDoUpdate({
      target: consoleSettings.tenantId,
      set: { preferences: on ? { autoDisableRateLimited: true } : {} },
    });
}

async function insertAccount(options: {
  providerId?: string;
  tenantId?: string | null;
  status?: "active" | "cooldown" | "disabled";
  lastErrorCategory?: string | null;
  lastError?: string | null;
  cooldownUntil?: Date | null;
  consecutiveFailures?: number;
} = {}): Promise<string> {
  const [row] = await db!
    .insert(providerAccounts)
    .values({
      providerId: options.providerId ?? PROVIDER,
      label: "account",
      credentialKind: "api_key",
      tenantId: options.tenantId === undefined ? TENANT : options.tenantId,
      status: options.status ?? "active",
      lastErrorCategory: options.lastErrorCategory ?? null,
      lastError: options.lastError ?? null,
      cooldownUntil: options.cooldownUntil ?? null,
      consecutiveFailures: options.consecutiveFailures ?? 0,
    })
    .returning({ id: providerAccounts.id });
  if (!row) throw new Error("account insert returned no row");
  return row.id;
}

async function rowOf(accountId: string): Promise<{
  status?: string;
  cooldownUntil?: Date | null;
  lastError?: string | null;
  lastErrorCategory?: string | null;
  modelCooldowns?: unknown;
}> {
  const [row] = await db!
    .select({
      status: providerAccounts.status,
      cooldownUntil: providerAccounts.cooldownUntil,
      lastError: providerAccounts.lastError,
      lastErrorCategory: providerAccounts.lastErrorCategory,
      modelCooldowns: providerAccounts.modelCooldowns,
    })
    .from(providerAccounts)
    .where(eq(providerAccounts.id, accountId));
  return row ?? {};
}

async function eventFor(accountId: string) {
  return db!
    .select({ fromStatus: healthEvents.fromStatus, toStatus: healthEvents.toStatus, reason: healthEvents.reason })
    .from(healthEvents)
    .where(and(eq(healthEvents.entityKind, "account"), eq(healthEvents.accountId, accountId)));
}

/** An upstream 429 that classifies as `rate_limit_transient`, mutating. */
function upstream429(message = "Rate limit exceeded"): unknown {
  return new Error(message);
}
const upstream429Evidence = {
  origin: "upstream" as const,
  scope: "account" as const,
  statusCode: 429,
  credentialEvidence: true,
};

/** An upstream quota verdict that classifies as `quota_exhausted`, mutating. */
function upstreamQuota(): unknown {
  return new Error("You have exceeded your quota");
}
const upstreamQuotaEvidence = {
  origin: "upstream" as const,
  scope: "account" as const,
  statusCode: 402,
  credentialEvidence: true,
};

describe("autoDisableRateLimitedEnabled", () => {
  test("missing row means off", async () => {
    await seedTenant();
    expect(await autoDisableRateLimitedEnabled(db!, TENANT)).toBe(false);
    expect(await autoDisableRateLimitedEnabled(db!, "other-tenant")).toBe(false);
  });

  test("a read error means off (fail-safe)", async () => {
    const broken = {
      select() {
        throw new Error("boom");
      },
    } as unknown as CartethyiaDatabase;
    expect(await autoDisableRateLimitedEnabled(broken, "tenant")).toBe(false);
  });

  test("shared accounts follow any tenant's toggle (D06)", async () => {
    await seedTenant();
    await setToggle(false);
    expect(await autoDisableRateLimitedEnabled(db!, null)).toBe(false);
    await setToggle(true);
    expect(await autoDisableRateLimitedEnabled(db!, null)).toBe(true);
  });

  test("a tenant-scoped read only honors that tenant", async () => {
    await seedTenant();
    await setToggle(true);
    expect(await autoDisableRateLimitedEnabled(db!, TENANT)).toBe(true);
    expect(await autoDisableRateLimitedEnabled(db!, "other-tenant")).toBe(false);
  });
});

describe("auto-disable intercept", () => {
  test("toggle off keeps the legacy cooldown", async () => {
    await seedTenant();
    await setToggle(false);
    const accountId = await insertAccount();
    await recordAccountFailure(db!, accountId, upstream429(), upstream429Evidence);
    const row = await rowOf(accountId);
    expect(row.status).toBe("cooldown");
    expect(row.lastError).not.toContain("auto-disable");
    expect(row.modelCooldowns).toEqual({});
  });

  test("toggle on disables on an upstream rate limit with the marker", async () => {
    await seedTenant();
    await setToggle(true);
    const accountId = await insertAccount();
    await recordAccountFailure(db!, accountId, upstream429(), upstream429Evidence);
    const row = await rowOf(accountId);
    expect(row.status).toBe("disabled");
    expect(row.lastError).toContain("auto-disable (rate-limited): ");
    expect(row.lastErrorCategory).toBe("rate_limit_transient");
    expect(row.cooldownUntil).not.toBeNull();
    const until = (row.cooldownUntil as Date).getTime();
    expect(until - Date.now()).toBeGreaterThan(RECOVERY_MS - 60_000);
    expect(until - Date.now()).toBeLessThanOrEqual(RECOVERY_MS);
    const events = await eventFor(accountId);
    expect(events.at(-1)?.toStatus).toBe("disabled");
    expect(events.at(-1)?.reason).toContain("auto-disable (rate-limited): ");
  });

  test("toggle on disables on upstream quota exhaustion", async () => {
    await seedTenant();
    await setToggle(true);
    const accountId = await insertAccount();
    await recordAccountFailure(db!, accountId, upstreamQuota(), upstreamQuotaEvidence);
    const row = await rowOf(accountId);
    expect(row.status).toBe("disabled");
    expect(row.lastErrorCategory).toBe("quota_exhausted");
    expect(row.lastError).toContain("auto-disable (rate-limited): ");
  });

  test("the auto-disable recovery window is never truncated by the 1h escalation cap", async () => {
    // The recovery window is a policy duration, not a fallback: with a 36h
    // recovery and any failure streak, the deadline must land ~36h out —
    // never the 1h escalation ceiling (D18).
    const previous = process.env.CARTETHYIA_ACCOUNT_DISABLED_RECOVERY_MS;
    process.env.CARTETHYIA_ACCOUNT_DISABLED_RECOVERY_MS = String(36 * 60 * 60 * 1000);
    resetCooldownCacheForTests();
    try {
      await seedTenant();
      await setToggle(true);
      const accountId = await insertAccount({ consecutiveFailures: 5 });
      await recordAccountFailure(db!, accountId, upstream429(), upstream429Evidence);
      const row = await rowOf(accountId);
      expect(row.status).toBe("disabled");
      const until = (row.cooldownUntil as Date).getTime();
      const hours = (until - Date.now()) / (60 * 60 * 1000);
      expect(hours).toBeGreaterThan(35);
      expect(hours).toBeLessThanOrEqual(36);
    } finally {
      if (previous === undefined) delete process.env.CARTETHYIA_ACCOUNT_DISABLED_RECOVERY_MS;
      else process.env.CARTETHYIA_ACCOUNT_DISABLED_RECOVERY_MS = previous;
      resetCooldownCacheForTests();
    }
  });

  test("a 429 with a modelId still disables the account, not just the pair (D02)", async () => {
    await seedTenant();
    await setToggle(true);
    const accountId = await insertAccount();
    await recordAccountFailure(db!, accountId, upstream429(), {
      ...upstream429Evidence,
      modelId: "deepseek-v4.1-flash",
    });
    const row = await rowOf(accountId);
    expect(row.status).toBe("disabled");
    expect(row.modelCooldowns).toEqual({});
    expect(row.lastError).toContain("auto-disable (rate-limited): ");
  });

  test("non-target categories are untouched", async () => {
    await seedTenant();
    await setToggle(true);
    const accountId = await insertAccount();
    // A timeout is `timeout` — not in the target set — and still mutates at
    // account scope, so it must stay a cooldown.
    await recordAccountFailure(db!, accountId, new Error("request timed out"), {
      origin: "upstream",
      scope: "account",
      statusCode: 504,
      credentialEvidence: true,
    });
    const row = await rowOf(accountId);
    expect(row.status).toBe("cooldown");
    expect(row.lastError).not.toContain("auto-disable");
  });

  test("a provider-stated window under 5 minutes is not auto-disabled (D04)", async () => {
    await seedTenant();
    await setToggle(true);
    const accountId = await insertAccount();
    await recordAccountFailure(db!, accountId, upstream429(), {
      ...upstream429Evidence,
      retryAfterMs: 60_000, // Inception's 1-minute per-minute limit
    });
    const row = await rowOf(accountId);
    expect(row.status).toBe("cooldown");
    expect(row.lastError).not.toContain("auto-disable");
  });

  test("non-upstream origin never disables", async () => {
    await seedTenant();
    await setToggle(true);
    const accountId = await insertAccount();
    await recordAccountFailure(db!, accountId, upstream429(), {
      origin: "network",
      scope: "account",
      statusCode: 429,
    });
    const row = await rowOf(accountId);
    expect(row.status).toBe("active");
    expect(row.lastError).toBeNull();
  });

  test("shared account is disabled when any tenant has the toggle on (D06)", async () => {
    await seedTenant();
    await setToggle(true);
    const accountId = await insertAccount({ tenantId: null });
    await recordAccountFailure(db!, accountId, upstream429(), upstream429Evidence);
    const row = await rowOf(accountId);
    expect(row.status).toBe("disabled");
  });
});

describe("auto-disable recovery sweep (D03/R-B)", () => {
  test("sweep recovers an auto-disabled quota row whose deadline passed", async () => {
    await seedTenant();
    const accountId = await insertAccount({
      status: "disabled",
      lastErrorCategory: "quota_exhausted",
      lastError: "auto-disable (rate-limited): Provider quota exhausted",
      cooldownUntil: new Date(Date.now() - 1_000),
    });
    const recovered = await sweepExpiredCooldowns(db!);
    expect(recovered).toBe(1);
    expect((await rowOf(accountId)).status).toBe("active");
  });

  test("sweep recovers an auto-disabled rate-limit row whose deadline passed", async () => {
    await seedTenant();
    const accountId = await insertAccount({
      status: "disabled",
      lastErrorCategory: "rate_limit_transient",
      lastError: "auto-disable (rate-limited): Provider rate limit",
      cooldownUntil: new Date(Date.now() - 1_000),
    });
    expect(await sweepExpiredCooldowns(db!)).toBe(1);
    expect((await rowOf(accountId)).status).toBe("active");
  });

  test("sweep leaves a disabled row with the marker but a future deadline parked", async () => {
    await seedTenant();
    const accountId = await insertAccount({
      status: "disabled",
      lastErrorCategory: "quota_exhausted",
      lastError: "auto-disable (rate-limited): Provider quota exhausted",
      cooldownUntil: new Date(Date.now() + RECOVERY_MS),
    });
    expect(await sweepExpiredCooldowns(db!)).toBe(0);
    expect((await rowOf(accountId)).status).toBe("disabled");
  });

  test("sweep leaves an operator disable with a target category but no marker terminal", async () => {
    await seedTenant();
    const accountId = await insertAccount({
      status: "disabled",
      lastErrorCategory: "quota_exhausted",
      lastError: "operator bulk disable",
      cooldownUntil: new Date(Date.now() - 1_000),
    });
    expect(await sweepExpiredCooldowns(db!)).toBe(0);
    expect((await rowOf(accountId)).status).toBe("disabled");
  });

  test("sweep leaves a disabled row with the marker but a non-target category terminal", async () => {
    await seedTenant();
    const accountId = await insertAccount({
      status: "disabled",
      lastErrorCategory: "auth_invalidated",
      lastError: "auto-disable (rate-limited): Provider credential revoked",
      cooldownUntil: new Date(Date.now() - 1_000),
    });
    expect(await sweepExpiredCooldowns(db!)).toBe(0);
    expect((await rowOf(accountId)).status).toBe("disabled");
  });
});
