/**
 * The durable provider-cooldown mirror (`network_pools.provider_cooldowns`).
 *
 * The selector's cooldown map is process-local, so a restart dropped every
 * flag while the upstream kept refusing the egress — the operator saw no
 * cooldown badge anywhere and still received 429s, because dispatch re-picked
 * a pool it no longer remembered. The mirror is what makes the flag outlive
 * the flagging process.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { buildSqliteHandle, applySqliteMigrations } from "../../src/persistence/db-sqlite";
import { healthEvents, networkPools, tenants } from "../../src/persistence/schema";
import { NetworkPoolSelector, PROVIDER_BLOCK_MS } from "../../src/network/pool/selector";
import {
  dropAllProviderCooldownMarkers,
  dropProviderCooldownMarker,
  pruneExpiredProviderCooldownMarkers,
  recordProbeVerdict,
  restorePoolProbeVerdicts,
  restoreProviderCooldownMarkers,
  upsertProviderCooldownMarker,
} from "../../src/network/pool/cooldown-store";
import { flagPoolCooldown } from "../../src/network/pool/health";
import { recordPoolDispatchOutcome } from "../../src/network/pool/health";
import { GatewayError } from "../../src/protocol/gateway-error";
import { resetCooldownCacheForTests } from "../../src/config/cooldowns";

resetCooldownCacheForTests();
afterAll(resetCooldownCacheForTests);

const dirs: string[] = [];

async function bootedSqlite(): Promise<{ db: ReturnType<typeof buildSqliteHandle>["db"]; close: () => void }> {
  const dir = mkdtempSync(join(tmpdir(), "cartethyia-poolcool-"));
  dirs.push(dir);
  const db = new Database(join(dir, "cartethyia.sqlite"));
  try {
    await applySqliteMigrations(db);
  } catch (error) {
    db.close();
    throw error;
  }
  const handle = buildSqliteHandle(db);
  await handle.db.insert(tenants).values({
    id: "00000000-0000-0000-0000-0000000000aa",
    name: "pools",
    status: "active",
    // `tenants` timestamps default to PG `now()`, which the SQLite driver has
    // no function for; supply them explicitly like every SQLite write does.
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return {
    db: handle.db,
    close: () => {
      try {
        db.close();
      } catch {
        // Windows holds the WAL past close; cleanup below ignores that.
      }
    },
  };
}

async function insertPool(db: ReturnType<typeof buildSqliteHandle>["db"], poolId: string): Promise<void> {
  await db.insert(networkPools).values({
    id: poolId,
    kind: "https",
    endpointConfig: { endpoint: "http://pool.example:8080" },
    // `network_pools.created_at` defaults to PG's `now()`, which the SQLite
    // driver has no function for; supply it, as production writes do.
    createdAt: new Date(),
    tenantId: "00000000-0000-0000-0000-0000000000aa",
  });
}

afterAll(() => {
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows can hold the WAL open for a beat; a leftover temp dir is not
      // a failed test.
    }
  }
});

describe("the provider cooldown mirror", () => {
  test("flags persist on the row and boot restores them into the selector", async () => {
    const { db, close } = await bootedSqlite();
    try {
      const poolId = randomUUID();
      await insertPool(db, poolId);

      await upsertProviderCooldownMarker(db, poolId, "OpenCode", {
        until: Date.now() + 60 * 60 * 1000,
        reason: "Provider opencode rate limit",
      });
      // A second provider's marker must survive the first's write.
      await upsertProviderCooldownMarker(db, poolId, "opencode", {
        until: Date.now() + 60 * 60 * 1000,
        reason: "Provider opencode rate limit",
      });

      const selector = new NetworkPoolSelector();
      const restored = await restoreProviderCooldownMarkers(selector, db);
      expect(restored).toBe(1);
      expect((await selector.isProviderCooldown(poolId, "opencode")).inCooldown).toBe(true);
      // And the restored state keeps the pool out of rotation.
      expect(await selector.tryAcquireAvailablePool([poolId], "opencode")).toBeUndefined();

      // The console listing (the badge source) reads the same selector state.
      const listing = await selector.getPoolCooldowns(poolId);
      expect(listing).toHaveLength(1);
      expect(listing[0]?.providerId).toBe("opencode");
    } finally {
      close();
    }
  });

  test("expired markers and unrelated pools are not resurrected", async () => {
    const { db, close } = await bootedSqlite();
    try {
      const poolId = randomUUID();
      await insertPool(db, poolId);
      await upsertProviderCooldownMarker(db, poolId, "opencode", {
        until: Date.now() - 1,
        reason: "spent before the restart",
      });

      const selector = new NetworkPoolSelector();
      expect(await restoreProviderCooldownMarkers(selector, db)).toBe(0);
      expect((await selector.isProviderCooldown(poolId, "opencode")).inCooldown).toBe(false);
    } finally {
      close();
    }
  });

  test("dropping an orphan marker is a no-op, and drops only resolve", async () => {
    const { db, close } = await bootedSqlite();
    try {
      const poolId = randomUUID();
      await insertPool(db, poolId);
      // No rows written anywhere: the pool id does not exist.
      await upsertProviderCooldownMarker(db, randomUUID(), "opencode", {
        until: Date.now() + 1000,
        reason: "x",
      });

      await upsertProviderCooldownMarker(db, poolId, "opencode", {
        until: Date.now() + 60 * 60 * 1000,
        reason: "cooldown",
      });
      // A 429 probe must not release a cooldown it merely re-measured.
      await dropProviderCooldownMarker(db, poolId, "opencode", true);
      const [kept] = await db
        .select({ providerCooldowns: networkPools.providerCooldowns })
        .from(networkPools);
      expect(kept?.providerCooldowns?.opencode?.reason).toBe("cooldown");

      await dropAllProviderCooldownMarkers(db, poolId);
      const [cleared] = await db
        .select({ providerCooldowns: networkPools.providerCooldowns })
        .from(networkPools);
      expect(cleared?.providerCooldowns ?? {}).toEqual({});
    } finally {
      close();
    }
  });
});

describe("dispatch flagging writes the mirror", () => {
  test("a provider-scoped 429 lands on the row for the next boot", async () => {
    const { db, close } = await bootedSqlite();
    try {
      const poolId = randomUUID();
      await insertPool(db, poolId);

      const error = new GatewayError(
        "quota_exceeded",
        429,
        "free tier usage limit",
        // No `retryAfterMs`: upstream named no window, so the configured
        // fallback applies.
        {},
        "upstream",
      );

      flagPoolCooldown(new NetworkPoolSelector(), db, poolId, "opencode", error);
      // Fire-and-forget by design; give the mirror write a moment.
      await new Promise((resolve) => setTimeout(resolve, 50));

      const selector = new NetworkPoolSelector();
      expect(await restoreProviderCooldownMarkers(selector, db)).toBe(1);
      const state = await selector.isProviderCooldown(poolId, "opencode");
      expect(state.inCooldown).toBe(true);
      // The measured window outlives the old 15-minute guess: an egress that
      // exhausted its allowance stays refused long past that.
      expect(state.resetsAt?.getTime()).toBeGreaterThan(Date.now() + 30 * 60 * 1000);
    } finally {
      close();
    }
  });

  test("a block marker restored at boot retires the egress", async () => {
    const { db, close } = await bootedSqlite();
    try {
      const poolId = randomUUID();
      await insertPool(db, poolId);
      await upsertProviderCooldownMarker(db, poolId, "opencode", {
        until: Date.now() + PROVIDER_BLOCK_MS,
        reason: "Upstream refused this egress address",
        blocked: true,
      });

      const selector = new NetworkPoolSelector();
      await restoreProviderCooldownMarkers(selector, db);
      const state = await selector.isProviderCooldown(poolId, "opencode");
      expect(state.blocked).toBe(true);
      expect(state.inCooldown).toBe(true);
    } finally {
      close();
    }
  });
});

describe("the probe verdict is enforced state, not a decoration", () => {
  test("a probe verdict lands in the mirror and the health history", async () => {
    const { db, close } = await bootedSqlite();
    try {
      const poolId = randomUUID();
      await insertPool(db, poolId);

      const until = Date.now() + PROVIDER_BLOCK_MS;
      await recordProbeVerdict(db, poolId, "opencode", {
        until,
        reason: "Upstream refused this egress address",
        blocked: true,
      });
      await recordProbeVerdict(db, poolId, "another-pool-fake", {
        until: Date.now() + 60 * 60 * 1000,
        reason: "Operator probe measured a provider 429",
      });

      const events = await db.select({ reason: healthEvents.reason, category: healthEvents.errorCategory }).from(healthEvents);
      expect(events[0]?.category).toBe("egress_blocked");
      expect(events[0]?.reason).toContain("opencode");
      // The block marker is intact for restart restore.
      const selector = new NetworkPoolSelector();
      await restoreProviderCooldownMarkers(selector, db);
      expect((await selector.isProviderCooldown(poolId, "opencode")).blocked).toBe(true);
    } finally {
      close();
    }
  });

  test("boot replays fresh stored verdicts, and skips stale ones", async () => {
    const { db, close } = await bootedSqlite();
    try {
      const fresh = randomUUID();
      const stale = randomUUID();
      await insertPool(db, fresh);
      await insertPool(db, stale);

      // Fresh: verdict endpoint matches the row's endpoint, provider is keyed
      // by address, row active — replay it as a block.
      await db
        .update(networkPools)
        .set({
          providerProbeProviderId: "opencode",
          providerProbeStatus: "blocked",
          providerProbeReason: "Upstream refused this egress address",
          providerProbeEndpoint: "http://pool.example:8080",
          providerProbeAt: new Date(),
        })
        .where(eq(networkPools.id, fresh));

      // Stale: the verdict describes the pool *id* (the pre-90dc16a0 shape),
      // which cannot describe this row's address — replaying it would enforce
      // a claim about an address the row never used.
      await db
        .update(networkPools)
        .set({
          providerProbeProviderId: "opencode",
          providerProbeStatus: "blocked",
          providerProbeAt: new Date(),
          providerProbeEndpoint: stale,
        })
        .where(eq(networkPools.id, stale));

      // Throttled: a fresh 429 verdict replays into a cooldown (the probe
      // measured the rate-limit window; `provider_probe_at` starts that
      // window, so a restart mid-window does not forget the spent egress).
      const throttled = randomUUID();
      await insertPool(db, throttled);
      await db
        .update(networkPools)
        .set({
          providerProbeProviderId: "opencode",
          providerProbeStatus: "throttled",
          providerProbeEndpoint: "http://pool.example:8080",
          providerProbeAt: new Date(),
        })
        .where(eq(networkPools.id, throttled));

      const selector = new NetworkPoolSelector();
      expect(await restorePoolProbeVerdicts(selector, db)).toBe(2);

      const enforced = await selector.isProviderCooldown(fresh, "opencode");
      expect(enforced.blocked).toBe(true);
      expect(enforced.inCooldown).toBe(true);
      expect((await selector.isProviderCooldown(stale, "opencode")).inCooldown).toBe(false);
      expect((await selector.isProviderCooldown(throttled, "opencode")).inCooldown).toBe(true);
      expect((await selector.isProviderCooldown(throttled, "opencode")).blocked).toBe(false);
      // And the replayed block keeps the pool out of rotation immediately.
      expect(await selector.tryAcquireAvailablePool([fresh], "opencode")).toBeUndefined();
      // The replayed cooldown also excludes the throttled pool.
      expect(await selector.tryAcquireAvailablePool([throttled], "opencode")).toBeUndefined();
    } finally {
      close();
    }
  });
});

describe("pruning expired provider cooldown markers", () => {
  test("expired markers are dropped while live cooldowns and blocks survive", async () => {
    const { db, close } = await bootedSqlite();
    try {
      const poolId = randomUUID();
      await insertPool(db, poolId);
      const future = Date.now() + 60 * 60 * 1000;
      await upsertProviderCooldownMarker(db, poolId, "opencode", {
        until: Date.now() - 1000,
        reason: "spent window",
      });
      await upsertProviderCooldownMarker(db, poolId, "anthropic", {
        until: future,
        reason: "live cooldown",
      });
      await upsertProviderCooldownMarker(db, poolId, "deepseek", {
        until: future,
        reason: "retired egress",
        blocked: true,
      });

      const dropped = await pruneExpiredProviderCooldownMarkers(db, poolId);
      expect(dropped).toBe(1);

      const [row] = await db
        .select({ providerCooldowns: networkPools.providerCooldowns })
        .from(networkPools);
      expect(row?.providerCooldowns).not.toHaveProperty("opencode");
      expect(row?.providerCooldowns?.anthropic?.until).toBe(future);
      expect(row?.providerCooldowns?.deepseek?.blocked).toBe(true);
    } finally {
      close();
    }
  });
});

describe("dispatch success clears the provider cooldown marker", () => {
  test("a completed request drops the pool's marker for that provider", async () => {
    const { db, close } = await bootedSqlite();
    try {
      const poolId = randomUUID();
      await insertPool(db, poolId);
      await upsertProviderCooldownMarker(db, poolId, "opencode", {
        until: Date.now() + 60 * 60 * 1000,
        reason: "Provider opencode rate limit",
      });

      await recordPoolDispatchOutcome(db, poolId, {
        succeeded: true,
        providerId: "opencode",
      });

      const [row] = await db
        .select({
          providerCooldowns: networkPools.providerCooldowns,
          status: networkPools.status,
          consecutiveFailures: networkPools.consecutiveFailures,
        })
        .from(networkPools);
      expect(row?.providerCooldowns ?? {}).toEqual({});
      // And the pool row shows the recovery.
      expect(row?.status).toBe("active");
      expect(row?.consecutiveFailures).toBe(0);
    } finally {
      close();
    }
  });

  test("a failed attempt leaves the marker intact", async () => {
    const { db, close } = await bootedSqlite();
    try {
      const poolId = randomUUID();
      await insertPool(db, poolId);
      await upsertProviderCooldownMarker(db, poolId, "opencode", {
        until: Date.now() + 60 * 60 * 1000,
        reason: "Provider opencode rate limit",
      });

      await recordPoolDispatchOutcome(db, poolId, {
        succeeded: false,
        providerId: "opencode",
        error: new GatewayError("proxy_unreachable", 502, "tunnel failed", {}, "network"),
        errorOrigin: "network",
      });

      const [row] = await db
        .select({ providerCooldowns: networkPools.providerCooldowns })
        .from(networkPools);
      expect(row?.providerCooldowns?.opencode?.reason).toBe("Provider opencode rate limit");
    } finally {
      close();
    }
  });
});
