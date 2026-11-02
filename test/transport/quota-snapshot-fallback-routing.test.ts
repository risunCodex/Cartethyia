/**
 * Quota-snapshot fallback in routing: when the live quota cache is cold
 * (nothing in memory/Redis yet, e.g. right after a restart), the router must
 * fall back to the persisted `quota_snapshot` on the account row so accounts
 * with remaining credit are still preferred over exhausted ones. This is what
 * makes the "snapshot is the source of truth, cache is a support" invariant
 * hold for dispatch.
 */
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applySqliteMigrations,
  buildSqliteHandle,
  createSqliteDatabase,
} from "../../src/persistence/db-sqlite";
import { providerAccounts, providers } from "../../src/persistence/schema";
import { RoutingEngine } from "../../src/transport/routing/router";
import type { RouteCandidate, RouteSnapshot } from "../../src/transport/routing/route-model";
import { clearQuotaCacheForTests } from "../../src/providers/quota/cache";
import { persistQuotaSnapshot } from "../../src/providers/quota/snapshot";

function candidate(id: string): RouteCandidate {
  return {
    provider_id: "qoder",
    model_id: "qoder-model",
    wire_family: "chat",
    endpoint: "/v1/chat",
    capability_profile: {},
    provider_account_id: id,
    tenant_id: null,
  } as unknown as RouteCandidate;
}

function snapshot(candidates: readonly RouteCandidate[]): RouteSnapshot {
  return {
    revision: 1,
    candidates,
    aliases: {},
    combos: {},
    created_at: Date.now(),
  };
}

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "carte-quota-snapshot-"));
  const sqlite = createSqliteDatabase(join(dir, "q.sqlite"));
  await applySqliteMigrations(sqlite);
  const { db } = buildSqliteHandle(sqlite);
  await db.insert(providers).values({ id: "qoder" });
  const insert = async (id: string) => {
    await db.insert(providerAccounts).values({
      id,
      providerId: "qoder",
      label: id,
      credentialKind: "oauth",
    });
  };
  return {
    db,
    insert,
    cleanup: () => {
      try {
        sqlite.close();
      } catch {
        /* already closed */
      }
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          rmSync(dir, { recursive: true, force: true });
          break;
        } catch {
          /* retry */
        }
      }
    },
  };
}

test("cold cache falls back to persisted quota snapshot for ordering", async () => {
  clearQuotaCacheForTests();
  const fx = await fixture();
  try {
    await fx.insert("a-zero");
    await fx.insert("a-credit");
    await persistQuotaSnapshot(fx.db, "a-zero", {
      source: "qoder",
      plan: null,
      windows: [
        {
          kind: "qoder:plan",
          label: "Plan credits",
          accounting: "pooled",
          usedPercent: null,
          remainingPercent: null,
          resetsAt: null,
          used: 100,
          limit: 100,
        },
      ],
      error: null,
    });
    await persistQuotaSnapshot(fx.db, "a-credit", {
      source: "qoder",
      plan: null,
      windows: [
        {
          kind: "qoder:plan",
          label: "Plan credits",
          accounting: "pooled",
          usedPercent: null,
          remainingPercent: null,
          resetsAt: null,
          used: 0,
          limit: 100,
        },
      ],
      error: null,
    });

    // No Redis, empty in-memory cache => the only quota evidence is the
    // persisted snapshot. The account with remaining credit is chosen; the
    // exhausted account is excluded entirely (below floor), not just ordered
    // behind.
    const engine = new RoutingEngine(undefined, undefined, fx.db);
    const plan = await engine.plan("qoder-model", snapshot([candidate("a-credit"), candidate("a-zero")]));
    const order = plan.candidates.map((c) => c.provider_account_id);
    expect(order).toEqual(["a-credit"]);
  } finally {
    fx.cleanup();
    clearQuotaCacheForTests();
  }
});

test("a warm cache wins over the persisted snapshot", async () => {
  clearQuotaCacheForTests();
  const fx = await fixture();
  try {
    await fx.insert("a-zero");
    await fx.insert("a-credit");
    // Persist the opposite of the cache: snapshot says a-zero has credit,
    // cache says a-credit has credit. The cache must win.
    await persistQuotaSnapshot(fx.db, "a-zero", {
      source: "qoder",
      plan: null,
      windows: [
        {
          kind: "qoder:plan",
          label: "Plan credits",
          accounting: "pooled",
          usedPercent: null,
          remainingPercent: null,
          resetsAt: null,
          used: 0,
          limit: 100,
        },
      ],
      error: null,
    });
    await persistQuotaSnapshot(fx.db, "a-credit", {
      source: "qoder",
      plan: null,
      windows: [
        {
          kind: "qoder:plan",
          label: "Plan credits",
          accounting: "pooled",
          usedPercent: null,
          remainingPercent: null,
          resetsAt: null,
          used: 100,
          limit: 100,
        },
      ],
      error: null,
    });
    const engine = new RoutingEngine(undefined, undefined, fx.db);
    // Prime the in-memory cache directly through the cache module.
    const { setCachedQuota } = await import("../../src/providers/quota/cache");
    await setCachedQuota("global", "a-credit", {
      source: "qoder",
      plan: null,
      windows: [
        {
          kind: "qoder:plan",
          label: "Plan credits",
          accounting: "pooled",
          usedPercent: null,
          remainingPercent: null,
          resetsAt: null,
          used: 0,
          limit: 100,
        },
      ],
      error: null,
    }, undefined);
    await setCachedQuota("global", "a-zero", {
      source: "qoder",
      plan: null,
      windows: [
        {
          kind: "qoder:plan",
          label: "Plan credits",
          accounting: "pooled",
          usedPercent: null,
          remainingPercent: null,
          resetsAt: null,
          used: 100,
          limit: 100,
        },
      ],
      error: null,
    }, undefined);
    const plan = await engine.plan("qoder-model", snapshot([candidate("a-credit"), candidate("a-zero")]));
    const order = plan.candidates.map((c) => c.provider_account_id);
    expect(order[0]).toBe("a-credit");
  } finally {
    fx.cleanup();
    clearQuotaCacheForTests();
  }
});
