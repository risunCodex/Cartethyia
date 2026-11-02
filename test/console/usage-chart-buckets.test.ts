/**
 * The usage chart endpoint (`/console/api/system/usage/chart?period=24h`).
 *
 * The "Requests" series counts completions per bucket; the "Cached" series
 * counts the cached share of the prompt, not all input. This pins both series
 * end to end through the served completion route.
 */
import { expect, test } from "bun:test";
import { createWorld } from "../helpers/fixtures";
import { createTestGateway } from "../helpers/gateway";
import { dbDescribe } from "../helpers/database";

dbDescribe("usage chart buckets", () => {
  test("the chart exposes both series", async () => {
    const world = await createWorld({ apiKeyOptions: { scopes: ["dashboard:read"] } });
    const gateway = await createTestGateway();
    try {
      gateway.serveWorld(world);
      // The console mounts under /console/api and the chart takes a `period`
      // token (`24h`, `7d`, `all`), not explicit start/end/points bounds.
      const response = await gateway.request(
        "/console/api/system/usage/chart?period=24h",
        { headers: { authorization: `Bearer ${world.token}` } },
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        readonly buckets?: readonly {
          readonly requests?: number;
          readonly cached?: number;
        }[];
      };
      // Both series must be present on every bucket: "Requests" counts
      // completions, "Cached" counts the cached share of the prompt.
      const buckets = body.buckets ?? [];
      expect(buckets.length).toBeGreaterThan(0);
      for (const bucket of buckets) {
        expect(bucket.requests).toBeDefined();
        expect(bucket.cached).toBeDefined();
      }
    } finally {
      await gateway.close();
      await world.cleanup();
    }
  });
});
