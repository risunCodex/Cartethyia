import { afterEach, expect, test, vi } from "bun:test";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "../../src/persistence/schema";
import { registerZcodeGiftClaimTask, zcodeGiftClaimSweep } from "../../src/workers/zcode-gift-claim";
import { ScheduledTaskRegistry } from "../../src/workers/scheduler";
import type { CartethyiaDatabase } from "../../src/persistence/db-handle";
import { createRunId, dbDescribe, requireDatabase, withRollback } from "../helpers/database";
import { createAccount, createTenant } from "../helpers/fixtures";

requireDatabase();
const originalOptIn = process.env.CARTETHYIA_ZCODE_AUTO_CLAIM;
afterEach(() => {
  if (originalOptIn === undefined) delete process.env.CARTETHYIA_ZCODE_AUTO_CLAIM;
  else process.env.CARTETHYIA_ZCODE_AUTO_CLAIM = originalOptIn;
  vi.useRealTimers();
});

for (const value of [undefined, "false", "1", "yes"]) {
  test(`automatic claims are absent without explicit true: ${value}`, () => {
    if (value === undefined) delete process.env.CARTETHYIA_ZCODE_AUTO_CLAIM;
    else process.env.CARTETHYIA_ZCODE_AUTO_CLAIM = value;
    const registry = new ScheduledTaskRegistry();
    registerZcodeGiftClaimTask(registry, { db: {} as CartethyiaDatabase, resolveCredential: async () => "dummy" });
    expect(registry.names()).toEqual([]);
  });
}

test("opt-in schedules its first claim after one day, never startup", async () => {
  process.env.CARTETHYIA_ZCODE_AUTO_CLAIM = "true";
  vi.useFakeTimers();
  let reads = 0;
  const db = { select: () => {
    reads += 1;
    return { from: () => ({ where: () => ({ orderBy: () => ({ limit: async () => [] }) }) }) };
  } } as unknown as CartethyiaDatabase;
  const registry = new ScheduledTaskRegistry();
  registerZcodeGiftClaimTask(registry, { db, resolveCredential: async () => "dummy" });
  registry.start();
  try {
    vi.advanceTimersByTime(24 * 60 * 60_000 - 1);
    expect(reads).toBe(0);
    vi.advanceTimersByTime(1);
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    expect(reads).toBeGreaterThan(0);
    const first = reads;
    vi.advanceTimersByTime(24 * 60 * 60_000);
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    expect(reads).toBeGreaterThan(first);
  } finally {
    await registry.stop();
  }
});

const runId = createRunId("zcode-gift-sweep");
dbDescribe("ZCode automatic gift eligibility", () => {
  test("bounded passes rotate all active accounts and never mutate disabled accounts", async () => {
    await withRollback(async (client) => {
      const tenant = await createTenant(client, runId);
      await client.query("insert into providers (id, wire_family_default, base_url) values ('zcode-start', 'chat', 'https://zcode.z.ai') on conflict (id) do nothing");
      const active: string[] = [];
      for (let i = 0; i < 3; i += 1) active.push(await createAccount(client, "zcode-start", { tenantId: tenant.tenantId }));
      const disabled = await createAccount(client, "zcode-start", { tenantId: tenant.tenantId, status: "disabled" });
      await createAccount(client, "zcode-start", { tenantId: tenant.tenantId, status: "cooldown" });
      const resolved: string[] = [];
      const db = drizzle(client, { schema });
      const deps = {
        db, maxPerPass: 2,
        resolveCredential: async (_provider: string, id: string) => { resolved.push(id); return "dummy-secret"; },
        fetcher: async () => Response.json({ code: 0, data: { deliveries: [], plans: [] } }),
      };
      const first = await zcodeGiftClaimSweep(deps);
      const second = await zcodeGiftClaimSweep(deps);
      expect(first.attempted).toBe(2);
      expect(second.attempted).toBe(1);
      expect(new Set(resolved)).toEqual(new Set(active));
      expect(resolved).not.toContain(disabled);
      await zcodeGiftClaimSweep(deps);
      expect(resolved).toHaveLength(5);
    });
  });

  test("new gifts clear the persisted quota snapshot before routing reuses it", async () => {
    await withRollback(async (client) => {
      const tenant = await createTenant(client, runId);
      await client.query("insert into providers (id, wire_family_default, base_url) values ('zcode-start', 'messages', 'https://zcode.z.ai') on conflict (id) do nothing");
      const accountId = await createAccount(client, "zcode-start", { tenantId: tenant.tenantId });
      await client.query("update provider_accounts set quota_snapshot = $1::jsonb where id = $2", [
        JSON.stringify({ quota: { source: "zcode-start", plan: null, windows: [], error: null }, fetchedAt: new Date().toISOString() }), accountId,
      ]);
      const summary = await zcodeGiftClaimSweep({
        db: drizzle(client, { schema }),
        resolveCredential: async () => "fixture",
        fetcher: async (_input, init) => Response.json(init?.method === "POST"
          ? { code: 0 } : { code: 0, data: { deliveries: [], plans: [{ plan_id: "fixture" }] } }),
      });
      expect(summary.plansClaimed).toBe(1);
      const result = await client.query("select quota_snapshot from provider_accounts where id = $1", [accountId]);
      expect(result.rows[0]?.quota_snapshot).toBeNull();
    });
  });
});
