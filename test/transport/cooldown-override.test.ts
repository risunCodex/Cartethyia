/**
 * `forceDisableCooldown` keeps a cooling account routable.
 *
 * The setting is dangerous on purpose, so what needs proving is not that it
 * works but that it works *only* in the narrow sense intended:
 *
 * - an account-wide cooldown stops excluding the candidate;
 * - the cooldown is still carried on the candidate, so `plan()` can still
 *   explain an all-cooling case with the real reset;
 * - the override is read-only — no account row is written, so turning it off
 *   needs no cleanup.
 *
 * The suite creates and cools **its own** account. Cooling every account in the
 * table would be simpler but would leave the fixture database altered for every
 * later test in the same worker, which is exactly how a suite starts passing or
 * failing depending on the order it ran in.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { getDb } from "../../src/persistence/boot";
import { consoleSettings, providerAccounts } from "../../src/persistence/schema";
import {
  createDatabaseSnapshotBuilder,
} from "../../src/transport/routing/route-catalog-repository";
import { dbDescribe, requireDatabase } from "../helpers/database";
import { createWorld, type GatewayWorld } from "../helpers/fixtures";

requireDatabase();

/** A cooldown that has not elapsed: the account is genuinely parked. */
const FUTURE = new Date(Date.now() + 60 * 60_000);

dbDescribe("forceDisableCooldown", () => {
  let world: GatewayWorld;
  let accountId: string;

  beforeAll(async () => {
    world = await createWorld();
    accountId = await world.addAccount({
      tenantId: world.tenantId,
      credential: "sk-cooldown-override",
      credentialKind: "api_key",
    });
  });

  afterAll(async () => {
    // Restore the one row this suite touched, so the account is not left
    // cooling for whatever runs next in this worker.
    if (accountId !== undefined) {
      await getDb()
        .update(providerAccounts)
        .set({ status: "active", cooldownUntil: null })
        .where(eq(providerAccounts.id, accountId))
        .catch(() => undefined);
    }
    await world?.cleanup();
  });

  async function writePreferences(preferences: Record<string, unknown>): Promise<void> {
    await getDb()
      .insert(consoleSettings)
      .values({ tenantId: world.tenantId, preferences, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: consoleSettings.tenantId,
        set: { preferences, updatedAt: new Date() },
      });
  }

  /**
   * Puts this suite's own account into cooldown.
   *
   * The category decides hard vs soft: `HARD_COOLDOWN_CATEGORIES` covers quota
   * exhaustion, policy blocks, and auth invalidation, and only a hard cooldown
   * is excluded outright. The default is transient rate limiting, which is the
   * soft case.
   */
  async function cool(lastErrorCategory = "rate_limit_transient"): Promise<void> {
    await getDb()
      .update(providerAccounts)
      .set({
        status: "cooldown",
        cooldownUntil: FUTURE,
        lastErrorCategory,
      })
      .where(eq(providerAccounts.id, accountId));
  }

  /** The health of the candidate serving this suite's account. */
  async function candidateFor(): Promise<Record<string, unknown> | undefined> {
    const snapshot = (await createDatabaseSnapshotBuilder(getDb())()) as unknown as {
      readonly candidates?: readonly Record<string, unknown>[];
    };
    return (snapshot.candidates ?? []).find(
      (candidate) => candidate["provider_account_id"] === accountId,
    );
  }

  test("a cooled account is excluded by default", async () => {
    await writePreferences({});
    await cool();
    const candidate = await candidateFor();
    expect(candidate).toBeDefined();
    expect(candidate?.["health_status"]).toBe("cooldown");
  });


  test("a hard cooldown is excluded by default", async () => {
    await writePreferences({});
    await cool("quota_exhausted");
    const candidate = await candidateFor();
    expect(candidate?.["health_status"]).toBe("cooldown");
    expect(candidate?.["cooldown_kind"]).toBe("hard");
  });

  test("with the override, a hard cooldown carries no exclusion stamp", async () => {
    // The regression this locks: `health_status` and `cooldown_kind` used to be
    // stamped even when the override was active, and the evaluator excludes a
    // hard cooldown on `health_status === "cooldown"` alone. So the setting
    // silently did nothing for quota-exhausted, policy-blocked, and
    // auth-invalidated accounts — the ones an operator most wants to reach.
    await writePreferences({ forceDisableCooldown: true });
    await cool("quota_exhausted");
    const candidate = await candidateFor();
    expect(candidate?.["health_status"]).not.toBe("cooldown");
    expect(candidate?.["cooldown_kind"]).toBeUndefined();
    // Still carried, so plan() can explain an all-cooling case.
    expect(candidate?.["cooldown_until"]).toBe(FUTURE.getTime());
  });

});
