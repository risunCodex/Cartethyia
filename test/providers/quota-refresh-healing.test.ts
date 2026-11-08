/**
 * `recordAccountCheck` healing: a successful quota refresh is the freshest
 * evidence about an account's health, so it lifts a cooldown whose verdict is
 * healable (quota exhausted, transient rate limit, capacity, unknown) back to
 * `active` immediately. An auth/policy cooldown is never healed by a quota
 * report — the credential is still refused — and an active account just gets
 * its success stamped.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { getDb } from "../../src/persistence/boot";
import { providerAccounts } from "../../src/persistence/schema";
import { eq } from "drizzle-orm";
import { createWorld, type GatewayWorld } from "../helpers/fixtures";
import { requireDatabase } from "../helpers/database";
import { recordAccountCheck } from "../../src/providers/quota/refresh";

requireDatabase();

describe("recordAccountCheck healing", () => {
  let world: GatewayWorld;

  beforeAll(async () => {
    world = await createWorld();
  });

  afterAll(async () => {
    await world?.cleanup();
  });

  async function setHealth(
    patch: {
      status?: "active" | "cooldown" | "disabled";
      lastErrorCategory?: string | null;
      lastError?: string | null;
      lastErrorAt?: Date | null;
      cooldownUntil?: Date | null;
      consecutiveFailures?: number;
      lastSuccessAt?: Date | null;
      lastRecoveredAt?: Date | null;
    },
  ): Promise<void> {
    await getDb().update(providerAccounts).set(patch).where(eq(providerAccounts.id, world.accountId));
  }

  async function readHealth() {
    const rows = await getDb()
      .select({
        status: providerAccounts.status,
        lastErrorCategory: providerAccounts.lastErrorCategory,
        cooldownUntil: providerAccounts.cooldownUntil,
        consecutiveFailures: providerAccounts.consecutiveFailures,
        lastSuccessAt: providerAccounts.lastSuccessAt,
        lastRecoveredAt: providerAccounts.lastRecoveredAt,
        lastError: providerAccounts.lastError,
      })
      .from(providerAccounts)
      .where(eq(providerAccounts.id, world.accountId))
      .limit(1);
    return rows[0]!;
  }

  test("a healable cooldown (quota exhausted) is lifted by a successful refresh", async () => {
    const cooldownUntil = new Date(Date.now() + 60 * 60 * 1000);
    await setHealth({
      status: "cooldown",
      lastErrorCategory: "quota_exhausted",
      cooldownUntil,
      consecutiveFailures: 5,
    });

    await recordAccountCheck(getDb(), world.accountId, { ok: true });

    const row = await readHealth();
    expect(row.status).toBe("active");
    expect(row.cooldownUntil).toBeNull();
    expect(row.lastErrorCategory).toBeNull();
    expect(row.lastError).toBeNull();
    expect(row.consecutiveFailures).toBe(0);
    expect(row.lastSuccessAt).not.toBeNull();
    expect(row.lastRecoveredAt).not.toBeNull();
  });

  test("a healable cooldown with a null category is also lifted", async () => {
    await setHealth({
      status: "cooldown",
      lastErrorCategory: null,
      cooldownUntil: new Date(Date.now() + 60 * 60 * 1000),
    });

    await recordAccountCheck(getDb(), world.accountId, { ok: true });

    const row = await readHealth();
    expect(row.status).toBe("active");
    expect(row.cooldownUntil).toBeNull();
  });

  test("a non-healable cooldown (auth invalidated) is never lifted by a quota report", async () => {
    const cooldownUntil = new Date(Date.now() + 60 * 60 * 1000);
    await setHealth({
      status: "cooldown",
      lastErrorCategory: "auth_invalidated",
      cooldownUntil,
      consecutiveFailures: 3,
      lastSuccessAt: null,
      lastRecoveredAt: null,
    });

    await recordAccountCheck(getDb(), world.accountId, { ok: true });

    const row = await readHealth();
    expect(row.status).toBe("cooldown");
    expect(row.lastErrorCategory).toBe("auth_invalidated");
    expect(row.cooldownUntil).toEqual(cooldownUntil);
    expect(row.consecutiveFailures).toBe(3);
    // The success stamp must not leak onto a parked account's row: the
    // `lastErrorCategory` is the reason the health machine parked it, and a
    // quota refresh that succeeded must not blur that verdict.
    expect(row.lastSuccessAt).toBeNull();
  });

  test("an active account just gets its success stamped", async () => {
    await setHealth({
      status: "active",
      lastErrorCategory: "rate_limit_transient",
      lastError: "old failure",
      consecutiveFailures: 2,
      lastErrorAt: new Date(),
      lastSuccessAt: null,
      lastRecoveredAt: null,
    });

    await recordAccountCheck(getDb(), world.accountId, { ok: true });

    const row = await readHealth();
    expect(row.status).toBe("active");
    expect(row.lastErrorCategory).toBeNull();
    expect(row.lastError).toBeNull();
    expect(row.consecutiveFailures).toBe(0);
    expect(row.lastSuccessAt).not.toBeNull();
    expect(row.lastRecoveredAt).toBeNull(); // never parked, so never "recovered"
  });
});
