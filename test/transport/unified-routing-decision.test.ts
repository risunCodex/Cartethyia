/**
 * Unified routing decision engine (routing/quota/health unification), now the
 * canonical planner behavior.
 *
 * It guarantees:
 * - known-exhausted quota (spent pooled credits, or all relevant independent
 *   windows spent) becomes a proactive exclusion before dispatch;
 * - unknown/unsupported/stale quota stays eligible but ranks below a known
 *   available balance (FRESH_UNKNOWN < FRESH_KNOWN);
 * - usage-floor-below becomes a proactive exclusion;
 * - window matching stays model-aware: exhausting one model family must not
 *   block the sibling family.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { RoutingEngine } from "../../src/transport/routing/router";
import type { RouteCandidate, RouteSnapshot } from "../../src/transport/routing/route-model";
import type { ProviderQuotaWindow } from "../../src/providers/quota/quota-contracts";
import { clearQuotaCacheForTests, setCachedQuota } from "../../src/providers/quota/cache";

function candidate(id: string, extra: Record<string, unknown> = {}): RouteCandidate {
  return {
    provider_id: "qoder",
    model_id: "qoder-model",
    wire_family: "chat",
    endpoint: "/v1/chat",
    capability_profile: {},
    provider_account_id: id,
    tenant_id: null,
    ...extra,
  } as unknown as RouteCandidate;
}

function pooledWindow(remaining: number, limit: number | null = null): ProviderQuotaWindow {
  return {
    kind: "credits",
    label: "credits",
    accounting: "pooled",
    usedPercent: null,
    remainingPercent: null,
    resetsAt: null,
    remaining,
    limit,
  };
}

function independentWindow(remainingPercent: number, resetsAt: string | null = null): ProviderQuotaWindow {
  return {
    kind: "window",
    label: "window",
    accounting: "independent",
    usedPercent: 100 - remainingPercent,
    remainingPercent,
    resetsAt,
  };
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

async function plannedOrder(snapshot: RouteSnapshot, requested: string): Promise<string[]> {
  const engine = new RoutingEngine();
  const plan = await engine.plan(requested, snapshot);
  if (plan.candidates.length === 0) return [];
  return plan.candidates.map((candidate) => candidate.provider_account_id ?? candidate.provider_id);
}

beforeEach(() => {
  clearQuotaCacheForTests();
});

describe("unified routing decision engine", () => {
  test("a known-exhausted pooled account is proactively excluded before dispatch", async () => {
    const order = await plannedOrder(
      snapshot([
        candidate("a-zero", { quota_windows: [pooledWindow(0, 100)] }),
        candidate("a-credit", { quota_windows: [pooledWindow(50, 100)] }),
      ]),
      "qoder-model",
    );
    expect(order).toEqual(["a-credit"]);
  });

  test("an all-independent-windows-exhausted account is excluded; a healthy window account is preferred", async () => {
    const order = await plannedOrder(
      snapshot([
        candidate("a-exhausted", { quota_windows: [independentWindow(0), independentWindow(0)] }),
        candidate("a-healthy", { quota_windows: [independentWindow(80)] }),
      ]),
      "qoder-model",
    );
    expect(order).toEqual(["a-healthy"]);
  });

  test("unknown quota (no windows) stays eligible but ranks below known-available", async () => {
    const order = await plannedOrder(
      snapshot([
        candidate("a-unknown"),
        candidate("a-credit", { quota_windows: [pooledWindow(42)] }),
      ]),
      "qoder-model",
    );
    expect(order).toEqual(["a-credit", "a-unknown"]);
  });

  test("when every candidate is unknown, they remain eligible and dialable (no hard block)", async () => {
    const order = await plannedOrder(
      snapshot([candidate("a-unknown-1"), candidate("a-unknown-2")]),
      "qoder-model",
    );
    expect(order.length).toBe(2);
  });

  test("a below-usage-floor account is proactively excluded", async () => {
    const order = await plannedOrder(
      snapshot([
        candidate("a-below", {
          quota_windows: [pooledWindow(5, 100)],
          usage_floor: 10,
          usage_floor_unit: "credit",
        }),
        candidate("a-above", {
          quota_windows: [pooledWindow(50, 100)],
          usage_floor: 10,
          usage_floor_unit: "credit",
        }),
      ]),
      "qoder-model",
    );
    expect(order).toEqual(["a-above"]);
  });

  test("model-scoped window matching keeps a sibling model eligible", async () => {
    const claudeWindows: ProviderQuotaWindow[] = [
      {
        kind: "weekly:Claude & GPT",
        label: "Claude & GPT (Weekly)",
        accounting: "independent",
        usedPercent: 100,
        remainingPercent: 0,
        resetsAt: null,
      },
      {
        kind: "weekly:Gemini",
        label: "Gemini (Weekly)",
        accounting: "independent",
        usedPercent: 4,
        remainingPercent: 96,
        resetsAt: null,
      },
    ];
    const geminiCandidate: RouteCandidate = {
      provider_id: "antigravity",
      model_id: "gemini-3.8-flash",
      wire_family: "chat",
      endpoint: "/v1internal:generateContent",
      capability_profile: {},
      provider_account_id: "a-claude-exhausted",
      tenant_id: null,
      quota_windows: claudeWindows,
    } as unknown as RouteCandidate;
    const order = await plannedOrder(snapshot([geminiCandidate]), "gemini-3.8-flash");
    // The candidate serves Gemini; its Claude window exhaustion must not block it.
    expect(order).toEqual(["a-claude-exhausted"]);
  });

  test("stale quota evidence (older than the freshness horizon) downgrades to unknown", async () => {
    // A warm cache entry whose fetchedAt is >6h old must NOT be read as
    // exhausted — stale evidence is unknown, so the account stays eligible.
    const staleFetchedAt = new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString();
    const staleActive = candidate("a-stale", {
      quota_windows: [pooledWindow(0, 100)],
    });
    const staleAvailable = candidate("a-fresh", {
      quota_windows: [pooledWindow(30, 100)],
    });
    await setCachedQuota("global", "a-stale", {
      source: "qoder",
      plan: null,
      windows: [pooledWindow(0, 100)],
      error: null,
    }, undefined, new Date(staleFetchedAt));
    await setCachedQuota("global", "a-fresh", {
      source: "qoder",
      plan: null,
      windows: [pooledWindow(30, 100)],
      error: null,
    }, undefined, new Date());
    const engine = new RoutingEngine();
    // A real RoutingEngine consults the cache; pass the cache-backed candidates
    // through plan() so the fact derivation sees the entry timestamps.
    const plan = await engine.plan("qoder-model", snapshot([staleActive, staleAvailable]));
    const order = plan.candidates.map((c) => c.provider_account_id);
    // Fresh available outranks stale-unknown.
    expect(order[0]).toBe("a-fresh");
    expect(order).toContain("a-stale");
  });
});
