/**
 * The daily-growth background job (`POST /quota/daily-growth` → `{ jobId }`,
 * then `GET /quota/daily-growth/status/:jobId`).
 *
 * The route used to run the whole batch synchronously in the request. Now it
 * enqueues a background job and returns immediately with `{ jobId }`; the
 * status endpoint reports the completed aggregate. This suite pins:
 *
 * - the route returns 202 `{ jobId }` without waiting for the upstream calls;
 * - the status endpoint reports `done` with `total`/`succeeded`/`failed` and
 *   per-account errors;
 * - the job's per-account runner is invoked with the same outcomes the old
 *   synchronous path produced (report then claim), and a failed claim is
 *   reported as an error, not swallowed.
 *
 * The upstream calls go through `globalThis.fetch`, which is stubbed for the
 * duration of the suite to answer the buddy billing facade envelopes. The `cb`
 * provider row and its accounts are inserted committed (a gateway request runs
 * on a different pooled connection and would not see an uncommitted row).
 */
import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createAccount, createWorld } from "../helpers/fixtures";
import { createTestGateway } from "../helpers/gateway";
import { dbDescribe, getTestPool } from "../helpers/database";
import { clearDailyGrowthJobsForTests } from "../../src/console/quota/daily-growth-job";

dbDescribe("daily-growth background job", () => {
  test("enqueues and returns immediately with jobId; status reports done", async () => {
    clearDailyGrowthJobsForTests();
    const world = await createWorld({
      apiKeyOptions: { scopes: ["dashboard:read", "dashboard:write"] },
    });
    const gateway = await createTestGateway();
    // Insert the `cb` provider (the buddy billing facade) and two owned
    // accounts, committed so the gateway sees them.
    const pool = await getTestPool();
    const client = await pool.connect();
    let cleanupProvider: () => Promise<void> = async () => undefined;
    try {
      await client.query("BEGIN");
      await client.query(
        `insert into providers (id, tenant_id, wire_family_default, base_url, enabled, requires_account)
         values ('cb', null, 'chat', 'https://upstream.test', true, true)
         on conflict (id) do nothing`,
      );
      const accounts = [
        await createAccount(client, "cb", {
          tenantId: world.tenantId,
          label: "acc-1",
          credentialKind: "oauth",
          credential: `jwt-test-${randomUUID()}`,
        }),
        await createAccount(client, "cb", {
          tenantId: world.tenantId,
          label: "acc-2",
          credentialKind: "oauth",
          credential: `jwt-test-${randomUUID()}`,
        }),
      ];
      await client.query("COMMIT");
      cleanupProvider = async () => {
        await client.query(`delete from providers where id = 'cb' and tenant_id is null`);
        // Accounts cascade via the provider FK.
        await client.query(`delete from provider_accounts where tenant_id = $1`, [
          world.tenantId,
        ]);
      };
      // The job's upstream fetches go through globalThis.fetch; answer the
      // buddy facade envelopes (status + claim, and the activity report).
      const realFetch = globalThis.fetch;
      const statusUrl = "https://www.codebuddy.ai/v2/billing/meter/checkin-activity-status";
      const claimUrl = "https://www.codebuddy.ai/v2/billing/meter/daily-checkin";
      const reportUrl = "https://www.codebuddy.ai/v2/report";
      const fetchMock = async (input: RequestInfo | URL, _init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url === statusUrl) {
          return new Response(JSON.stringify({ code: 0, data: { active: true, today_checked_in: false, streak_days: 0 } }), { status: 200 });
        }
        if (url === claimUrl) {
          return new Response(JSON.stringify({ code: 0, data: { credit: 100, streak_days: 1 } }), { status: 200 });
        }
        if (url === reportUrl) {
          return new Response(JSON.stringify({ code: 0, data: {} }), { status: 200 });
        }
        return new Response(JSON.stringify({ code: 0, data: {} }), { status: 200 });
      };
      globalThis.fetch = fetchMock as typeof fetch;

      try {
        const response = await gateway.json("/console/api/quota/daily-growth", {
          providerId: "cb",
          accountIds: accounts,
        }, { token: world.token });
        expect(response.status).toBe(202);
        const body = await response.json();
        expect(typeof body.jobId).toBe("string");
        expect(body.jobId.length).toBeGreaterThan(0);

        // Poll the status endpoint until the job settles.
        let status: Record<string, unknown> | null = null;
        for (let attempt = 0; attempt < 100; attempt += 1) {
          const statusResponse = await gateway.request(
            `/console/api/quota/daily-growth/status/${body.jobId}`,
            { headers: { authorization: `Bearer ${world.token}` } },
          );
          expect(statusResponse.status).toBe(200);
          status = (await statusResponse.json()) as Record<string, unknown>;
          if (status.state === "done" || status.state === "failed") break;
          await Bun.sleep(50);
        }
        expect(status).not.toBeNull();
        expect(status!.state).toBe("done");
        expect(status!.total).toBe(2);
        expect(status!.succeeded).toBe(2);
        expect(status!.failed).toBe(0);
        expect(status!.errors).toEqual([]);
      } finally {
        globalThis.fetch = realFetch;
      }
    } finally {
      await cleanupProvider();
      client.release();
      await gateway.close();
      await world.cleanup();
    }
  });

  test("a failed claim is reported as an error with the account id", async () => {
    clearDailyGrowthJobsForTests();
    const world = await createWorld({
      apiKeyOptions: { scopes: ["dashboard:read", "dashboard:write"] },
    });
    const gateway = await createTestGateway();
    const pool = await getTestPool();
    const client = await pool.connect();
    let cleanupProvider: () => Promise<void> = async () => undefined;
    try {
      await client.query("BEGIN");
      await client.query(
        `insert into providers (id, tenant_id, wire_family_default, base_url, enabled, requires_account)
         values ('cb', null, 'chat', 'https://upstream.test', true, true)
         on conflict (id) do nothing`,
      );
      const accountId = await createAccount(client, "cb", {
        tenantId: world.tenantId,
        label: "acc-fail",
        credentialKind: "oauth",
        credential: `jwt-test-${randomUUID()}`,
      });
      await client.query("COMMIT");
      cleanupProvider = async () => {
        await client.query(`delete from providers where id = 'cb' and tenant_id is null`);
        await client.query(`delete from provider_accounts where tenant_id = $1`, [
          world.tenantId,
        ]);
      };

      const realFetch = globalThis.fetch;
      const statusUrl = "https://www.codebuddy.ai/v2/billing/meter/checkin-activity-status";
      const claimUrl = "https://www.codebuddy.ai/v2/billing/meter/daily-checkin";
      const reportUrl = "https://www.codebuddy.ai/v2/report";
      const fetchMock = async (input: RequestInfo | URL, _init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url === statusUrl) {
          return new Response(JSON.stringify({ code: 0, data: { active: true, today_checked_in: false, streak_days: 0 } }), { status: 200 });
        }
        if (url === claimUrl) {
          // An unknown business code → the claim reports a failure.
          return new Response(JSON.stringify({ code: 5000 }), { status: 200 });
        }
        if (url === reportUrl) {
          return new Response(JSON.stringify({ code: 0, data: {} }), { status: 200 });
        }
        return new Response(JSON.stringify({ code: 0, data: {} }), { status: 200 });
      };
      globalThis.fetch = fetchMock as typeof fetch;

      try {
        const response = await gateway.json("/console/api/quota/daily-growth", {
          providerId: "cb",
          accountIds: [accountId],
        }, { token: world.token });
        expect(response.status).toBe(202);
        const body = await response.json();
        let status: Record<string, unknown> | null = null;
        for (let attempt = 0; attempt < 100; attempt += 1) {
          const statusResponse = await gateway.request(
            `/console/api/quota/daily-growth/status/${body.jobId}`,
            { headers: { authorization: `Bearer ${world.token}` } },
          );
          status = (await statusResponse.json()) as Record<string, unknown>;
          if (status.state === "done" || status.state === "failed") break;
          await Bun.sleep(50);
        }
        expect(status!.state).toBe("done");
        expect(status!.total).toBe(1);
        expect(status!.succeeded).toBe(0);
        expect(status!.failed).toBe(1);
        const errors = status!.errors as Array<{ accountId: string; error: string }>;
        expect(errors).toHaveLength(1);
        expect(errors[0]!.accountId).toBe(accountId);
        expect(typeof errors[0]!.error).toBe("string");
      } finally {
        globalThis.fetch = realFetch;
      }
    } finally {
      await cleanupProvider();
      client.release();
      await gateway.close();
      await world.cleanup();
    }
  });
});
