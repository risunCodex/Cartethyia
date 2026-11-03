/**
 * The reset-credits read cache (`GET /accounts/:id/resets`).
 *
 * Every dialog open used to hit the upstream live. The read now goes through
 * a short per-account TTL cache (`getCachedResetCredits`), so two opens in the
 * TTL window produce one upstream call and the second open serves the cached
 * answer. This suite pins that contract end to end through the deployed route:
 * the upstream (the Claude usage/oauth discovery endpoints) is stubbed and
 * counted, and the second read must not add a call.
 */
import { expect, test } from "bun:test";
import { createAccount, createWorld } from "../helpers/fixtures";
import { createTestGateway } from "../helpers/gateway";
import { dbDescribe, getTestPool } from "../helpers/database";

const CEDAR_URL = "https://api.anthropic.com/api/oauth/usage?cedar_ember=1&skip_spend=1";
const JUNIPER_URL = "https://api.anthropic.com/api/oauth/usage?at_wall=1&skip_spend=1";

function cedarPayload() {
  return {
    cedar_ember: {
      eligible: true,
      grants: [
        {
          id: "grant-1",
          resets_left: 2,
          usable_now: true,
          label: "Claude limit reset",
          starts_at: "2026-11-01T00:00:00Z",
          ends_at: "2026-11-30T00:00:00Z",
        },
      ],
      next_grant_id: "grant-1",
    },
  };
}

async function setupWorldAndProvider() {
  const world = await createWorld({
    apiKeyOptions: { scopes: ["dashboard:read", "dashboard:write"] },
  });
  const pool = await getTestPool();
  const client = await pool.connect();
  await client.query("BEGIN");
  await client.query(
    `insert into providers (id, tenant_id, wire_family_default, base_url, enabled, requires_account)
     values ('claude', null, 'messages', 'https://api.anthropic.com', true, true)
     on conflict (id) do nothing`,
  );
  const accountId = await createAccount(client, "claude", {
    tenantId: world.tenantId,
    label: "claude-acc",
    credentialKind: "oauth",
    credential: "claude-oauth-token",
  });
  await client.query("COMMIT");
  const cleanup = async () => {
    await client.query(`delete from providers where id = 'claude' and tenant_id is null`);
    await client.query(`delete from provider_accounts where tenant_id = $1`, [
      world.tenantId,
    ]);
    client.release();
  };
  return { world, accountId, cleanup };
}

dbDescribe("reset-credits read cache", () => {
  test("two dialog opens produce one upstream call; second serves cache", async () => {
    const { world, accountId, cleanup } = await setupWorldAndProvider();
    const gateway = await createTestGateway();
    const realFetch = globalThis.fetch;
    let upstreamCalls = 0;
    const fetchMock = async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === CEDAR_URL) {
        upstreamCalls += 1;
        return new Response(JSON.stringify(cedarPayload()), { status: 200 });
      }
      if (url === JUNIPER_URL) {
        return new Response(JSON.stringify({}), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    };
    globalThis.fetch = fetchMock as typeof fetch;
    try {
      const read = async () => {
        const response = await gateway.request(`/console/api/accounts/${accountId}/resets`, {
          headers: { authorization: `Bearer ${world.token}` },
        });
        expect(response.status).toBe(200);
        return response.json();
      };

      const first = await read();
      expect(first.availableCount).toBe(2);
      expect(first.credits).toHaveLength(1);

      const second = await read();
      expect(second.availableCount).toBe(2);
      expect(second.credits).toEqual(first.credits);

      // The cache served the second read: one upstream discovery, not two.
      expect(upstreamCalls).toBe(1);
    } finally {
      globalThis.fetch = realFetch;
      await gateway.close();
      await cleanup();
      await world.cleanup();
    }
  });

  test("a missing account 404s without touching the upstream", async () => {
    const { world, cleanup } = await setupWorldAndProvider();
    const gateway = await createTestGateway();
    const realFetch = globalThis.fetch;
    let upstreamCalls = 0;
    const fetchMock = async (_input: RequestInfo | URL) => {
      upstreamCalls += 1;
      return new Response(JSON.stringify({}), { status: 200 });
    };
    globalThis.fetch = fetchMock as typeof fetch;
    try {
      const ghost = "00000000-0000-0000-0000-000000000000";
      const response = await gateway.request(`/console/api/accounts/${ghost}/resets`, {
        headers: { authorization: `Bearer ${world.token}` },
      });
      expect(response.status).toBe(404);
      expect(upstreamCalls).toBe(0);
    } finally {
      globalThis.fetch = realFetch;
      await gateway.close();
      await cleanup();
      await world.cleanup();
    }
  });
});
