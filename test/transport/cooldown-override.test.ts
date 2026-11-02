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
import { createDatabaseSnapshotBuilder } from "../../src/transport/routing/route-catalog";
import { InMemoryRouteSnapshotService } from "../../src/transport/routing/route-model";
import { RoutingEngine } from "../../src/transport/routing/router";
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

  test("with the override, the same account is no longer marked cooldown", async () => {
    await writePreferences({ forceDisableCooldown: true });
    await cool();
    const candidate = await candidateFor();
    expect(candidate).toBeDefined();
    // The whole point: it is routable again.
    expect(candidate?.["health_status"]).not.toBe("cooldown");
  });

  test("the override still carries the reset so plan() can explain it", async () => {
    await writePreferences({ forceDisableCooldown: true });
    await cool();
    // `cooldown_until` rides along even when the exclusion is skipped, so an
    // all-cooling answer can say when to retry instead of a bare 429.
    expect(await candidateFor().then((c) => c?.["cooldown_until"])).toBe(FUTURE.getTime());
  });

  test("continuation affinity refuses a hard-cooling account with 429", async () => {
    await writePreferences({});
    await cool("quota_exhausted");
    const service = new InMemoryRouteSnapshotService(createDatabaseSnapshotBuilder(getDb()));
    const snapshot = await service.getSnapshot();
    const candidate = (snapshot.candidates ?? []).find(
      (c) => c["provider_account_id"] === accountId,
    ) as Record<string, unknown> | undefined;
    expect(candidate).toBeDefined();
    const engine = new RoutingEngine();
    const run = () =>
      engine.plan(
        String(candidate?.["model_id"]),
        snapshot,
        world.tenantId,
        undefined,
        false,
        undefined,
        {
          providerId: String(candidate?.["provider_id"]),
          providerAccountId: accountId,
          rebaseable: false,
        },
      );
    let thrown: { code?: string; status?: number } | undefined;
    try {
      await run();
    } catch (error) {
      thrown = error as { code?: string; status?: number };
    }
    expect(thrown).toBeDefined();
    expect(thrown?.code).toBe("accounts_rate_limited");
    expect(thrown?.status).toBe(429);
  });

  test("continuation affinity keeps serving a healthy pinned account", async () => {
    await getDb()
      .update(providerAccounts)
      .set({ status: "active", cooldownUntil: null, lastErrorCategory: null })
      .where(eq(providerAccounts.id, accountId));
    const service = new InMemoryRouteSnapshotService(createDatabaseSnapshotBuilder(getDb()));
    const snapshot = await service.getSnapshot();
    const candidate = (snapshot.candidates ?? []).find(
      (c) => c["provider_account_id"] === accountId,
    ) as Record<string, unknown> | undefined;
    expect(candidate).toBeDefined();
    const engine = new RoutingEngine();
    const plan = await engine.plan(
      String(candidate?.["model_id"]),
      snapshot,
      world.tenantId,
      undefined,
      false,
      undefined,
      {
        providerId: String(candidate?.["provider_id"]),
        providerAccountId: accountId,
        rebaseable: false,
      },
    );
    expect(plan.candidates.map((c) => c.provider_account_id)).toContain(accountId);
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

  test("the override is read-only — the account row still says cooldown", async () => {
    // Turning the setting off must need no cleanup, which is only true if
    // nothing was written back.
    await writePreferences({ forceDisableCooldown: true });
    await cool();
    await candidateFor();
    const rows = await getDb()
      .select({ status: providerAccounts.status })
      .from(providerAccounts)
      .where(eq(providerAccounts.id, accountId));
    expect(rows[0]?.status).toBe("cooldown");
  });

  test("an expired row still reads as cooldown until the sweeper recovers it", async () => {
    // A row that still says `cooldown` must stay excluded even after its
    // deadline elapses: the sweeper is the only exit from `cooldown`, and
    // redialing an expired-but-not-yet-recovered account mid-window reproduces
    // the refusal that cooled it — the "still hit a cooled-down account"
    // report, logging a fresh `cooldown → cooldown` row each time.
    await writePreferences({});
    await getDb()
      .update(providerAccounts)
      .set({
        status: "cooldown",
        cooldownUntil: new Date(Date.now() - 5 * 60_000),
        lastErrorCategory: "quota_exhausted",
      })
      .where(eq(providerAccounts.id, accountId));
    const candidate = await candidateFor();
    expect(candidate).toBeDefined();
    expect(candidate?.["health_status"]).toBe("cooldown");
    expect(candidate?.["cooldown_kind"]).toBe("hard");
    // No reset to quote: the window already closed, and the sweep is about to
    // recover the row.
    expect(candidate?.["cooldown_until"]).toBeUndefined();
  });

  test("a hard-cooling pinned account with a complete replay still falls through", async () => {
    // The request is a complete conversation replay (every tool result is
    // answered in the history), but the pinned account is cooling. It must
    // NOT be refused with the hard "no longer routable" 400 — the recorded
    // exchange may rebase to a fresh Run on an eligible account. The router
    // receives `rebaseable: true` (the preparer derives it from the complete
    // conversation), so a second healthy account picks up the fallthrough.
    await writePreferences({});
    const siblingId = await world.addAccount({
      tenantId: world.tenantId,
      credential: "sk-cooldown-sibling",
      credentialKind: "api_key",
    });
    try {
      await cool("quota_exhausted");
      const service = new InMemoryRouteSnapshotService(createDatabaseSnapshotBuilder(getDb()));
      const snapshot = await service.getSnapshot();
      const candidates = (snapshot.candidates ?? []) as unknown as Array<Record<string, unknown>>;
      const pinned = candidates.find((c) => c["provider_account_id"] === accountId);
      expect(pinned).toBeDefined();
      const sibling = candidates.find((c) => c["provider_account_id"] === siblingId);
      expect(sibling).toBeDefined();
      const engine = new RoutingEngine();
      const plan = await engine.plan(
        String(pinned?.["model_id"]),
        snapshot,
        world.tenantId,
        undefined,
        false,
        undefined,
        {
          providerId: String(pinned?.["provider_id"]),
          providerAccountId: accountId,
          rebaseable: true,
        },
      );
      // The cooling account is not selected; the healthy sibling is.
      expect(plan.candidates.map((c) => c.provider_account_id)).not.toContain(accountId);
      expect(plan.candidates.map((c) => c.provider_account_id)).toContain(siblingId);
    } finally {
      await getDb()
        .update(providerAccounts)
        .set({ status: "active", cooldownUntil: null })
        .where(eq(providerAccounts.id, siblingId))
        .catch(() => undefined);
    }
  });

  test("a rebaseable continuation falls through to normal routing when the pin is absent", async () => {
    // The conversation is complete (every tool result answered) and the pinned
    // account is not a candidate for the requested model. The router must NOT
    // refuse; it must fall through and pick whichever account serves the model,
    // so a model switch across accounts starts a fresh Run with the recorded
    // history.
    await writePreferences({});
    await getDb()
      .update(providerAccounts)
      .set({ status: "active", cooldownUntil: null })
      .where(eq(providerAccounts.id, accountId));
    const service = new InMemoryRouteSnapshotService(createDatabaseSnapshotBuilder(getDb()));
    const snapshot = await service.getSnapshot();
    const candidate = (snapshot.candidates ?? []).find(
      (c) => c["provider_account_id"] === accountId,
    ) as Record<string, unknown> | undefined;
    expect(candidate).toBeDefined();
    const engine = new RoutingEngine();
    // Pin an account that is NOT in the candidate set (random UUID) with
    // `rebaseable: true` → must not throw, must return a normal plan.
    const plan = await engine.plan(
      String(candidate?.["model_id"]),
      snapshot,
      world.tenantId,
      undefined,
      false,
      undefined,
      {
        providerId: String(candidate?.["provider_id"]),
        providerAccountId: "00000000-0000-0000-0000-000000000000",
        rebaseable: true,
      },
    );
    expect(plan.candidates.length).toBeGreaterThan(0);
  });
});
