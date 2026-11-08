/**
 * Proactive quota-aware routing: drain urgency, reserve demotion, hot-window
 * guard, and session stickiness within the same rank group. These are ordering
 * preferences — never exclusions: every candidate here stays eligible and
 * routed, only the order changes.
 */
import { describe, expect, test } from "bun:test";
import { RoutingEngine } from "../../src/transport/routing/router";
import type { RouteCandidate, RouteSnapshot } from "../../src/transport/routing/route-model";
import type { ProviderQuotaWindow } from "../../src/providers/quota/quota-contracts";
import { drainScore, isInReserve, remainingFraction } from "../../src/transport/routing/drain-reserve";
import { StickySessionStore } from "../../src/transport/routing/round-robin";

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

function percentWindow(usedPercent: number, resetsAt: string | null = null, kind = "5h"): ProviderQuotaWindow {
  return {
    kind,
    label: kind,
    accounting: "independent",
    usedPercent,
    remainingPercent: 100 - usedPercent,
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

async function plannedOrder(
  snapshot: RouteSnapshot,
  requested: string,
  sessionId?: string,
): Promise<string[]> {
  const engine = new RoutingEngine();
  const plan = await engine.plan(requested, snapshot, null, undefined, false, undefined, undefined, sessionId);
  if (plan.candidates.length === 0) return [];
  return plan.candidates.map((candidate) => candidate.provider_account_id ?? candidate.provider_id);
}

describe("drainScore", () => {
  test("higher drain (quota about to expire) scores higher", () => {
    const soon = drainScore([percentWindow(50, new Date(Date.now() + 60 * 60 * 1000).toISOString())]);
    const later = drainScore([percentWindow(50, new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString())]);
    expect(soon).toBeGreaterThan(later);
    expect(soon).toBeGreaterThan(0);
  });

  test("a fully used window scores 0 (no headroom)", () => {
    expect(drainScore([percentWindow(100)])).toBe(0);
  });

  test("no windows score 0 (neutral)", () => {
    expect(drainScore(undefined)).toBe(0);
  });
});

describe("remainingFraction / isInReserve", () => {
  test("remaining fraction normalizes 0..1", () => {
    expect(remainingFraction([percentWindow(30)])).toBeCloseTo(0.7);
  });

  test("at/below reserve percent is in reserve", () => {
    const windows = [percentWindow(85)]; // 15% remaining
    expect(isInReserve(windows, 20)).toBe(true);
    expect(isInReserve(windows, 10)).toBe(false);
  });

  test("reserve disabled at 0 never reserves", () => {
    expect(isInReserve([percentWindow(99)], 0)).toBe(false);
  });
});

describe("routing sort: drain vs reserve vs hot vs sticky", () => {
  test("drain ordering: urgent-burn account first within a rank", async () => {
    const soonReset = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    const order = await plannedOrder(
      snapshot([
        candidate("a-fast-burn", { quota_windows: [percentWindow(40, soonReset)] }),
        candidate("a-slow-burn", { quota_windows: [percentWindow(40, null)] }),
      ]),
      "qoder-model",
    );
    expect(order).toEqual(["a-fast-burn", "a-slow-burn"]);
  });

  test("reserve account orders behind a non-reserve sibling", async () => {
    const order = await plannedOrder(
      snapshot([
        candidate("a-reserved", { quota_windows: [percentWindow(90)] }), // 10% remaining ≤ reserve 20
        candidate("a-healthy", { quota_windows: [percentWindow(50)] }), // 50% remaining
      ]),
      "qoder-model",
    );
    expect(order).toEqual(["a-healthy", "a-reserved"]);
  });

  test("hot-window guard defers a 90%-used account to a cooler sibling even with higher drain", async () => {
    const soonReset = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    const order = await plannedOrder(
      snapshot([
        candidate("a-hot", { quota_windows: [percentWindow(90, soonReset)] }),
        candidate("a-cool", { quota_windows: [percentWindow(40)] }), // no reset clock, cooler
      ]),
      "qoder-model",
    );
    expect(order).toEqual(["a-cool", "a-hot"]);
  });

  test("sticky warm window prefers the account that last served the session", async () => {
    const engine = new RoutingEngine();
    const snap = snapshot([
      candidate("a-first"),
      candidate("a-second"),
    ]);
    // First plan (no session id yet) records nothing sticky for a session;
    // simulate a prior session by pre-seeding the store through a plan with
    // the session id, then confirm the next plan prefers it.
    const first = await engine.plan("qoder-model", snap, null, undefined, false, undefined, undefined, "sess-1");
    const chosenFirst = first.candidates[0]!.provider_account_id!;
    const order = await engine.plan(
      "qoder-model",
      snap,
      null,
      undefined,
      false,
      undefined,
      undefined,
      "sess-1",
    );
    expect(order.candidates[0]!.provider_account_id).toBe(chosenFirst);
  });

  test("free-tier model ignores reserve/drain and keeps original order", async () => {
    const order = await plannedOrder(
      snapshot([
        candidate("a-free-reserved", { free_tier: true, quota_windows: [percentWindow(95)] }),
        candidate("a-free-healthy", { free_tier: true, quota_windows: [percentWindow(20)] }),
      ]),
      "qoder-model",
    );
    expect(order).toEqual(["a-free-reserved", "a-free-healthy"]);
  });
});

describe("StickySessionStore", () => {
  test("records and recalls a session's account", () => {
    const store = new StickySessionStore(8);
    store.set("qoder", "sess-1", "account-7");
    expect(store.get("qoder", "sess-1")?.accountId).toBe("account-7");
    expect(store.get("qoder", "sess-2")).toBeUndefined();
  });

  test("explicit pin is marked and survives warm-window checks", () => {
    const store = new StickySessionStore(8);
    store.set("qoder", "sess-1", "account-7", true);
    expect(store.get("qoder", "sess-1")?.explicit).toBe(true);
  });

  test("clear drops one session's stickiness", () => {
    const store = new StickySessionStore(8);
    store.set("qoder", "sess-1", "account-7");
    store.clear("qoder", "sess-1");
    expect(store.get("qoder", "sess-1")).toBeUndefined();
  });

  test("bounds by LRU capacity per provider", () => {
    const store = new StickySessionStore(2);
    store.set("qoder", "s-1", "a1");
    store.set("qoder", "s-2", "a2");
    store.set("qoder", "s-3", "a3");
    expect(store.get("qoder", "s-1")).toBeUndefined(); // evicted
    expect(store.get("qoder", "s-3")?.accountId).toBe("a3");
  });
});
