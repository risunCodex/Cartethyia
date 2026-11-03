/**
 * End-to-end contract for the pool health-events route — the endpoint the
 * dashboard's `usePoolHealthEvents` hook calls. Pins the real mount path:
 * the pools router is prefixed `/network/pools`, so a hook that dials
 * `/routing/pools/...` gets a 404 and renders "Failed to load pool health
 * events". This is the regression that guards the correct prefix.
 */
import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createWorld } from "../helpers/fixtures";
import { createTestGateway } from "../helpers/gateway";
import { dbDescribe } from "../helpers/database";
import { networkPools } from "../../src/persistence/schema";

dbDescribe("pool health-events route", () => {
  test("GET /network/pools/:poolId/health-events answers 200 with an array", async () => {
    const world = await createWorld({ apiKeyOptions: { scopes: ["dashboard:read"] } });
    const gateway = await createTestGateway();
    try {
      await gateway.serveWorld(world);

      // A pool owned by the same tenant as the key.
      const poolId = randomUUID();
      await gateway.db.insert(networkPools).values({
        id: poolId,
        kind: "https",
        endpointConfig: { endpoint: "http://pool.example:8080" },
        tenantId: world.tenantId,
        createdAt: new Date(),
      });

      const correct = await gateway.request(
        `/console/api/network/pools/${poolId}/health-events`,
        { headers: { authorization: `Bearer ${world.token}` } },
      );
      expect(correct.status).toBe(200);
      const body = await correct.json();
      expect(Array.isArray(body)).toBe(true);

      // The legacy/wrong prefix must not exist — this is the regression.
      const wrong = await gateway.request(
        `/console/api/routing/pools/${poolId}/health-events`,
        { headers: { authorization: `Bearer ${world.token}` } },
      );
      expect(wrong.status).toBe(404);
    } finally {
      await gateway.close();
      await world.cleanup();
    }
  });
});
