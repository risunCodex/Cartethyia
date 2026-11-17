import { afterEach, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "../../src/persistence/schema";
import { registerAccountQuotaTenantRoutes } from "../../src/console/quota/account-quota-tenant";
import { createDefaultProviderRegistry } from "../../src/providers/default-registry";
import { GLOBAL_QUOTA_LENS, getCachedQuotaEntry, setCachedQuota } from "../../src/providers/quota/cache";
import { persistQuotaSnapshot, readQuotaSnapshot, readQuotaSnapshots } from "../../src/providers/quota/snapshot";
import { createRunId, dbDescribe, requireDatabase, withRollback } from "../helpers/database";
import { createAccount, createTenant } from "../helpers/fixtures";

requireDatabase();
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const runId = createRunId("qoder-credits-claim");

const CAMPAIGNS_RESPONSE = {
  showCampaign: true,
  claimable: true,
  campaigns: [
    {
      campaignId: "campaign-credits",
      campaignKey: "act-20261102-503",
      actionType: "CLAIM_BENEFIT",
      claimStatus: "CLAIMABLE",
      benefit: { kind: "CREDITS", amount: 100 },
    },
  ],
};

const CLAIM_RESPONSE = {
  status: "CLAIMED",
  benefit: { kind: "CREDITS", amount: 100 },
};

dbDescribe("Qoder credit claim console boundary", () => {
  for (const scenario of ["claimed", "already_claimed", "nothing", "error", "credential-error"] as const) {
    test(`manual claim reports ${scenario} honestly`, async () => {
      await withRollback(async (client) => {
        const tenant = await createTenant(client, runId);
        await client.query("insert into providers (id, wire_family_default, base_url) values ('qoder', 'chat', 'https://api2.qoder.sh') on conflict (id) do nothing");
        const id = await createAccount(client, "qoder", { tenantId: tenant.tenantId });
        const db = drizzle(client, { schema });

        globalThis.fetch = Object.assign(async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
          const url = String(_input);
          if (url.includes("/sash/api/v1/me/campaigns") && init?.method === "GET") {
            if (scenario === "error") return new Response("not-json", { status: 500 });
            if (scenario === "nothing") {
              return Response.json({ showCampaign: true, claimable: true, campaigns: [] });
            }
            return Response.json(CAMPAIGNS_RESPONSE);
          }
          if (url.includes("/claim") && init?.method === "POST") {
            if (scenario === "already_claimed") return Response.json({ status: "CLAIMED", failureCode: "REPLAYED" });
            return Response.json(CLAIM_RESPONSE);
          }
          return new Response("no route", { status: 404 });
        }, { preconnect: originalFetch.preconnect });

        const quota = { source: "qoder", plan: null, windows: [], error: null };
        await setCachedQuota(tenant.tenantId, id, quota, undefined);
        await setCachedQuota(GLOBAL_QUOTA_LENS, id, quota, undefined);
        await persistQuotaSnapshot(db, id, quota);
        let invalidations = 0;
        const deps = {
          db, redis: undefined, providerRegistry: createDefaultProviderRegistry(),
          accessResolver: () => ({ id: "owner", tenantId: tenant.tenantId, admissionIdentity: "owner", scopes: ["dashboard:write"] as const }),
          resolveCredential: async () => {
            if (scenario === "credential-error") throw new Error("no credential");
            return "dummy-secret";
          },
          snapshotInvalidator: { invalidate: async () => ++invalidations },
        };
        const app = new Elysia();
        registerAccountQuotaTenantRoutes(app, deps, deps);
        const response = await app.handle(new Request(`http://localhost/accounts/${id}/claim-qoder-credits`, { method: "POST" }));
        const body = await response.json();
        const failure = ["error", "credential-error"].includes(scenario);
        expect(response.status).toBe(failure ? 502 : 200);
        if (scenario === "claimed") {
          expect(body.data.state).toBe("claimed");
          expect(body.data.amount).toBe(100);
          expect(await getCachedQuotaEntry(tenant.tenantId, id, undefined)).toBeNull();
          expect(await getCachedQuotaEntry(GLOBAL_QUOTA_LENS, id, undefined)).toBeNull();
          expect(await readQuotaSnapshot(db, id)).toBeNull();
          expect((await readQuotaSnapshots(db, [id])).has(id)).toBe(false);
          expect(invalidations).toBe(1);
        } else {
          expect(body.data.state).toBe(scenario === "credential-error" || scenario === "error" ? "error" : scenario);
          expect(await readQuotaSnapshot(db, id)).not.toBeNull();
          expect(invalidations).toBe(0);
        }
      });
    });
  }

  test("manual claims cannot access another tenant's qoder account", async () => {
    await withRollback(async (client) => {
      const tenant = await createTenant(client, runId);
      const other = await createTenant(client, runId);
      await client.query("insert into providers (id, wire_family_default, base_url) values ('qoder', 'chat', 'https://api2.qoder.sh') on conflict (id) do nothing");
      const foreignId = await createAccount(client, "qoder", { tenantId: other.tenantId });
      globalThis.fetch = Object.assign(async () => Response.json(CAMPAIGNS_RESPONSE), { preconnect: originalFetch.preconnect });
      const deps = {
        db: drizzle(client, { schema }), redis: undefined, providerRegistry: createDefaultProviderRegistry(),
        accessResolver: () => ({ id: "owner", tenantId: tenant.tenantId, admissionIdentity: "owner", scopes: ["dashboard:write"] as const }),
        resolveCredential: async () => "dummy-secret",
        snapshotInvalidator: { invalidate: async () => 0 },
      };
      const app = new Elysia();
      registerAccountQuotaTenantRoutes(app, deps, deps);
      const response = await app.handle(new Request(`http://localhost/accounts/${foreignId}/claim-qoder-credits`, { method: "POST" }));
      expect(response.status).toBe(404);
    });
  });

  test("PAT credentials are exchanged to a job token before the sash call", async () => {
    await withRollback(async (client) => {
      const tenant = await createTenant(client, runId);
      await client.query("insert into providers (id, wire_family_default, base_url) values ('qoder', 'chat', 'https://api2.qoder.sh') on conflict (id) do nothing");
      const id = await createAccount(client, "qoder", { tenantId: tenant.tenantId });
      const db = drizzle(client, { schema });

      const callLog: string[] = [];
      let exchangeBody = "";
      globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        callLog.push(`${method} ${url}`);
        if (url.includes("/api/v1/jobToken/exchange")) {
          exchangeBody = String(init?.body ?? "");
          // Exchange must be called with the PAT; return a JT.
          return Response.json({ token: "jt-exchange-test" });
        }
        if (url.includes("/sash/api/v1/me/campaigns") && method === "GET") {
          return Response.json(CAMPAIGNS_RESPONSE);
        }
        if (url.includes("/claim") && method === "POST") {
          return Response.json(CLAIM_RESPONSE);
        }
        return new Response("no route", { status: 404 });
      }, { preconnect: originalFetch.preconnect });

      const deps = {
        db, redis: undefined, providerRegistry: createDefaultProviderRegistry(),
        accessResolver: () => ({ id: "owner", tenantId: tenant.tenantId, admissionIdentity: "owner", scopes: ["dashboard:write"] as const }),
        resolveCredential: async () => "pt-test-secret",
        snapshotInvalidator: { invalidate: async () => 0 },
      };
      const app = new Elysia();
      registerAccountQuotaTenantRoutes(app, deps, deps);
      const response = await app.handle(new Request(`http://localhost/accounts/${id}/claim-qoder-credits`, { method: "POST" }));
      const body = await response.json();
      expect(response.status).toBe(200);
      expect(body.data.state).toBe("claimed");
      // exchange happened, and campaign call used the JT, not the raw PAT.
      expect(callLog.some((l) => l.includes("/api/v1/jobToken/exchange"))).toBe(true);
      const campaignCall = callLog.find((l) => l.includes("/sash/api/v1/me/campaigns"));
      expect(campaignCall).toBeDefined();
      // the exchange body carries personal_token (and machine binding when available)
      expect(exchangeBody).toContain("pt-test-secret");
    });
  });
});
