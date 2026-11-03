import { afterEach, expect, test } from "bun:test";
import { Elysia } from "elysia";
import Redis from "ioredis";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "../../src/persistence/schema";
import { registerAccountQuotaTenantRoutes } from "../../src/console/quota/account-quota-tenant";
import { createDefaultProviderRegistry } from "../../src/providers/default-registry";
import { GLOBAL_QUOTA_LENS, getCachedQuotaEntry, invalidateQuotaCacheForAccount, setCachedQuota } from "../../src/providers/quota/cache";
import { persistQuotaSnapshot, readQuotaSnapshot, readQuotaSnapshots } from "../../src/providers/quota/snapshot";
import { createRunId, dbDescribe, requireDatabase, testRedisUrl, withRollback } from "../helpers/database";
import { createAccount, createTenant } from "../helpers/fixtures";

requireDatabase();
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const runId = createRunId("zcode-gifts");

dbDescribe("ZCode gift console boundary", () => {
  for (const scenario of ["broken", "business", "malformed", "nothing", "claimed", "already_claimed", "captcha", "unknown", "partial", "credential-error"] as const) {
    test(`manual claim reports ${scenario} honestly`, async () => {
      await withRollback(async (client) => {
        const tenant = await createTenant(client, runId);
        await client.query("insert into providers (id, wire_family_default, base_url) values ('zcode-start', 'chat', 'https://zcode.z.ai') on conflict (id) do nothing");
        const id = await createAccount(client, "zcode-start", { tenantId: tenant.tenantId, status: "disabled" });
        const db = drizzle(client, { schema });
        let posts = 0;
        globalThis.fetch = Object.assign(async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
          if (init?.method === "POST") {
            const code = scenario === "captcha" ? 3007 : scenario === "already_claimed" ? 1003 : scenario === "unknown" ? 9999 : scenario === "partial" && posts > 0 ? 3007 : 0;
            posts += 1;
            return Response.json({ code });
          }
          if (scenario === "broken") return new Response("not-json");
          if (scenario === "business") return Response.json({ code: 0, success: false });
          if (scenario === "malformed") return Response.json({ code: 0, data: { plans: {}, deliveries: {} } });
          return Response.json({ code: 0, data: { deliveries: [], plans: scenario === "nothing" ? [] : Array.from({ length: scenario === "partial" ? 2 : 1 }, (_, i) => ({ plan_id: `gift-${i}`, name: `Gift ${i}` })) } });
        }, { preconnect: originalFetch.preconnect });
        const quota = { source: "zcode-start", plan: null, windows: [], error: null };
        await setCachedQuota(tenant.tenantId, id, quota, undefined);
        await setCachedQuota(GLOBAL_QUOTA_LENS, id, quota, undefined);
        await persistQuotaSnapshot(db, id, quota);
        let invalidations = 0;
        const deps = {
          db, redis: undefined, providerRegistry: createDefaultProviderRegistry(),
          accessResolver: () => ({ id: "owner", tenantId: tenant.tenantId, admissionIdentity: "owner", scopes: ["dashboard:write"] as const }),
          resolveCredential: async () => {
            if (scenario === "credential-error") throw new Error("Bearer dummy-secret");
            return "dummy-secret";
          },
          snapshotInvalidator: { invalidate: async () => ++invalidations },
        };
        const app = new Elysia();
        registerAccountQuotaTenantRoutes(app, deps, deps);
        const response = await app.handle(new Request(`http://localhost/accounts/${id}/claim-gifts`, { method: "POST" }));
        const body = await response.json();
        const failure = ["broken", "business", "malformed", "unknown", "credential-error"].includes(scenario);
        expect(response.status).toBe(failure ? 502 : 200);
        expect(body.ok).toBe(!failure);
        expect(body.data.state).toBe(failure ? "error" : scenario);
        expect(JSON.stringify(body)).not.toContain("dummy-secret");
        if (scenario === "claimed" || scenario === "partial") {
          expect(body.data.claimed).toEqual(["Gift 0"]);
          expect(await getCachedQuotaEntry(tenant.tenantId, id, undefined)).toBeNull();
          expect(await getCachedQuotaEntry(GLOBAL_QUOTA_LENS, id, undefined)).toBeNull();
          expect(await readQuotaSnapshot(db, id)).toBeNull();
          expect((await readQuotaSnapshots(db, [id])).has(id)).toBe(false);
          expect(invalidations).toBe(1);
        } else {
          expect(await readQuotaSnapshot(db, id)).not.toBeNull();
          expect(await getCachedQuotaEntry(tenant.tenantId, id, undefined)).not.toBeNull();
          expect(invalidations).toBe(0);
        }
        await invalidateQuotaCacheForAccount(id, undefined);
        if (scenario === "partial" || scenario === "captcha") expect(body.data.detail).toContain("ZCode app");
      });
    });
  }

  test("manual claims cannot access another tenant or shared accounts", async () => {
    await withRollback(async (client) => {
      const tenant = await createTenant(client, runId);
      const other = await createTenant(client, runId);
      await client.query("insert into providers (id, wire_family_default, base_url) values ('zcode-start', 'chat', 'https://zcode.z.ai') on conflict (id) do nothing");
      const ids = [
        await createAccount(client, "zcode-start", { tenantId: other.tenantId }),
        await createAccount(client, "zcode-start", { tenantId: null }),
      ];
      let credentialReads = 0;
      let upstreamCalls = 0;
      globalThis.fetch = Object.assign(async () => {
        upstreamCalls += 1;
        return Response.json({ code: 0 });
      }, { preconnect: originalFetch.preconnect });
      const deps = {
        db: drizzle(client, { schema }), redis: undefined, providerRegistry: createDefaultProviderRegistry(),
        accessResolver: () => ({ id: "owner", tenantId: tenant.tenantId, admissionIdentity: "owner", scopes: ["dashboard:write"] as const }),
        resolveCredential: async () => { credentialReads += 1; return "dummy-secret"; },
      };
      const app = new Elysia();
      registerAccountQuotaTenantRoutes(app, deps, deps);
      for (const id of ids) {
        const response = await app.handle(new Request(`http://localhost/accounts/${id}/claim-gifts`, { method: "POST" }));
        expect(response.status).toBe(404);
      }
      expect(credentialReads).toBe(0);
      expect(upstreamCalls).toBe(0);
    });
  });

  (testRedisUrl ? test : test.skip)("claimed grants invalidate every Redis lens and persisted snapshots", async () => {
    const redis = new Redis(testRedisUrl!, { maxRetriesPerRequest: 2 });
    try {
      await withRollback(async (client) => {
        const tenant = await createTenant(client, runId);
        await client.query("insert into providers (id, wire_family_default, base_url) values ('zcode-start', 'chat', 'https://zcode.z.ai') on conflict (id) do nothing");
        const id = await createAccount(client, "zcode-start", { tenantId: tenant.tenantId });
        const db = drizzle(client, { schema });
        const quota = { source: "zcode-start", plan: null, windows: [], error: null };
        await setCachedQuota(tenant.tenantId, id, quota, redis);
        await setCachedQuota(GLOBAL_QUOTA_LENS, id, quota, redis);
        await persistQuotaSnapshot(db, id, quota);
        const keys: string[] = [];
        let cursor = "0";
        do {
          const [next, batch] = await redis.scan(cursor, "MATCH", `quota:*:*:${id}`, "COUNT", 500);
          cursor = next;
          keys.push(...batch);
        } while (cursor !== "0");
        expect(keys.length).toBe(2);
        globalThis.fetch = Object.assign(async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
          Response.json(init?.method === "POST" ? { code: 0 } : { code: 0, data: { deliveries: [], plans: [{ plan_id: "gift", name: "Gift" }] } }),
        { preconnect: originalFetch.preconnect });
        const deps = {
          db, redis, providerRegistry: createDefaultProviderRegistry(),
          accessResolver: () => ({ id: "owner", tenantId: tenant.tenantId, admissionIdentity: "owner", scopes: ["dashboard:write"] as const }),
          resolveCredential: async () => "dummy-secret",
        };
        const app = new Elysia();
        registerAccountQuotaTenantRoutes(app, deps, deps);
        try {
          const response = await app.handle(new Request(`http://localhost/accounts/${id}/claim-gifts`, { method: "POST" }));
          expect(response.status).toBe(200);
          expect((await response.json()).data.state).toBe("claimed");
          expect(await redis.mget(...keys)).toEqual([null, null]);
          expect(await getCachedQuotaEntry(tenant.tenantId, id, redis)).toBeNull();
          expect(await getCachedQuotaEntry(GLOBAL_QUOTA_LENS, id, redis)).toBeNull();
          expect(await readQuotaSnapshot(db, id)).toBeNull();
          expect((await readQuotaSnapshots(db, [id])).has(id)).toBe(false);
        } finally {
          await invalidateQuotaCacheForAccount(id, redis);
        }
      });
    } finally {
      await redis.quit();
    }
  });
});
