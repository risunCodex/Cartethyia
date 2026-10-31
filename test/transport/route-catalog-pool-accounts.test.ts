/**
 * Pool-as-account routing: for an ip-scoped, credential-less provider
 * (OpenCode Free), the route catalog emits one candidate per pool-account
 * instead of one candidate carrying every pool, and the pool-account's health
 * excludes a spent egress exactly like a cooling account.
 *
 * This is the "route looks by health" fix for the 429 report: when a tenant's
 * chain of fallback providers is all cooling/disabled, the OpenCode egresses
 * are visible, per-pool, to routing — and a cooling pool is excluded at plan
 * time instead of being dialed.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { getDb } from "../../src/persistence/boot";
import { models, networkPools, providerPoolAccounts, providers } from "../../src/persistence/schema";
import { createDatabaseSnapshotBuilder } from "../../src/transport/routing/route-catalog";
import { dbDescribe, requireDatabase } from "../helpers/database";
import { createWorld, type GatewayWorld } from "../helpers/fixtures";

requireDatabase();

dbDescribe("route catalog pool accounts", () => {
  let world: GatewayWorld;

  beforeAll(async () => {
    world = await createWorld();
  });

  afterAll(async () => {
    await world?.cleanup();
  });

  async function insertOpencodeWithPool(poolStatus: "active" | "cooldown" = "active") {
    const db = getDb();
    const providerId = "opencode";
    const tenantId = world.tenantId;
    const exists = await db.select({ id: providers.id }).from(providers).where(eq(providers.id, providerId)).limit(1);
    if (exists.length === 0) {
      await db.insert(providers).values({
        id: providerId,
        tenantId: null,
        wireFamilyDefault: "chat",
        baseUrl: "https://opencode.ai",
        enabled: true,
        requiresAccount: false,
      });
    }
    // The opencode model row, if not already present.
    const modelExists = await db.select({ id: models.id }).from(models).where(eq(models.modelId, "deepseek-v4.1-flash-free")).limit(1);
    if (modelExists.length === 0) {
      await db.insert(models).values({
        providerId,
        modelId: "deepseek-v4.1-flash-free",
        wireFamily: "chat",
        serviceKind: "llm",
        endpointPath: "/v1/chat/completions",
        contextLimit: 200_000,
        outputLimit: 4_096,
        enabled: true,
      });
    }

    const poolId = randomUUID();
    await db.insert(networkPools).values({
      id: poolId,
      kind: "https",
      endpointConfig: { endpoint: "http://pool.example:8080" },
      tenantId,
      status: poolStatus,
      createdAt: new Date(),
    });

    const poolAccountId = randomUUID();
    await db.insert(providerPoolAccounts).values({
      id: poolAccountId,
      tenantId,
      networkPoolId: poolId,
      providerId,
      label: `Pool ${poolId.slice(0, 8)}`,
      status: poolStatus,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...(poolStatus === "cooldown"
        ? { cooldownUntil: new Date(Date.now() + 60 * 60_000) }
        : {}),
    });

    return { poolId, poolAccountId };
  }

  test("emits one candidate per pool-account, not one multi-pool candidate", async () => {
    const { poolId } = await insertOpencodeWithPool("active");
    const snapshot = (await createDatabaseSnapshotBuilder(getDb())()) as unknown as {
      readonly candidates?: readonly Record<string, unknown>[];
    };
    const opencodeCandidates = (snapshot.candidates ?? []).filter(
      (candidate) => candidate["provider_id"] === "opencode",
    );
    expect(opencodeCandidates.length).toBeGreaterThan(0);
    // Each candidate is tied to exactly one pool.
    for (const candidate of opencodeCandidates) {
      expect(candidate["requires_account"]).toBe(false);
      const poolIds = candidate["network_pool_ids"] as readonly string[] | undefined;
      expect(poolIds).toBeDefined();
      expect(poolIds?.length).toBe(1);
      expect(poolIds?.[0]).toBe(poolId);
    }
  });

  test("a cooling pool-account marks the candidate cooldown, like a cooling account", async () => {
    await insertOpencodeWithPool("cooldown");
    const snapshot = (await createDatabaseSnapshotBuilder(getDb())()) as unknown as {
      readonly candidates?: readonly Record<string, unknown>[];
    };
    const coolingCandidate = (snapshot.candidates ?? []).find(
      (candidate) =>
        candidate["provider_id"] === "opencode" &&
        candidate["health_status"] === "cooldown",
    );
    expect(coolingCandidate).toBeDefined();
    expect(coolingCandidate?.["network_pool_ids"]).toBeDefined();
    expect((coolingCandidate?.["network_pool_ids"] as readonly string[]).length).toBe(1);
  });
});
