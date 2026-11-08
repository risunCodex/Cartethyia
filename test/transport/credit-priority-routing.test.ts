/**
 * Credit-priority routing: within the same rank group, accounts with remaining
 * pooled credit are ordered ahead of unknown-quota accounts. Free-tier models
 * skip the preference — a free model routes to any account. The rank
 * (fresh → slow → cooling → saturated) stays the primary sort key; credit only
 * breaks ties inside one rank. Quota is not an eligibility exclusion: known-zero
 * accounts stay routed and are only ordered after unknown/positive.
 */
import { describe, expect, test } from "bun:test";
import { RoutingEngine } from "../../src/transport/routing/router";
import { sharedClaudeSlowLanes } from "../../src/providers/integrations/claude/claude-slow-lane";
import type { RouteCandidate, RouteSnapshot } from "../../src/transport/routing/route-model";
import type { ProviderQuotaWindow } from "../../src/providers/quota/quota-contracts";

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

function creditWindow(remaining: number): ProviderQuotaWindow {
  return {
    kind: "credits",
    label: "credits",
    accounting: "pooled",
    usedPercent: null,
    remainingPercent: null,
    resetsAt: null,
    remaining,
    limit: null,
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

test("accounts with remaining credit are ordered before unknown-quota accounts", async () => {
  const order = await plannedOrder(
    snapshot([
      candidate("a-unknown"),
      candidate("a-credit", { quota_windows: [creditWindow(42)] }),
    ]),
    "qoder-model",
  );
  expect(order).toEqual(["a-credit", "a-unknown"]);
});

test("a known-zero credit account without a limit is available and ranks as FRESH_KNOWN", async () => {
  const order = await plannedOrder(
    snapshot([
      candidate("a-zero", { quota_windows: [creditWindow(0)] }),
      candidate("a-unknown"),
    ]),
    "qoder-model",
  );
  // remaining=0 without a limit: not provably exhausted → quotaState "available" → FRESH_KNOWN.
  // A no-windows account is FRESH_UNKNOWN, so FRESH_KNOWN ranks first.
  expect(order).toEqual(["a-zero", "a-unknown"]);
});

test("a free-tier model routes even when its own quota window is exhausted", async () => {
  const order = await plannedOrder(
    snapshot([
      candidate("a-exhausted-free", { free_tier: true, quota_windows: [creditWindow(0)] }),
      candidate("a-unknown-free", { free_tier: true }),
    ]),
    "qoder-model",
  );
  // Exhausted windows no longer exclude; both accounts route, original order
  // preserved (free tier skips credit preference).
  expect(order).toEqual(["a-exhausted-free", "a-unknown-free"]);
});

test("a free-tier model ignores the operator floor threshold entirely", async () => {
  const order = await plannedOrder(
    snapshot([
      candidate("a-above-floor-free", { free_tier: true, quota_windows: [creditWindow(42)] }),
      candidate("a-exhausted-free", { free_tier: true, quota_windows: [creditWindow(0)] }),
    ]),
    "qoder-model",
  );
  // Neither account is excluded by quota; free tier skips credit preference, so
  // original order is preserved.
  expect(order).toEqual(["a-above-floor-free", "a-exhausted-free"]);
});

test("a free-tier model routes to any account; known-available ranks before unknown", async () => {
  const order = await plannedOrder(
    snapshot([
      candidate("a-unknown", { free_tier: true }),
      candidate("a-credit", { free_tier: true, quota_windows: [creditWindow(42)] }),
    ]),
    "qoder-model",
  );
  // Both are free-tier: credit priority is skipped within the same rank.
  // But a-credit (FRESH_KNOWN, available) outranks a-unknown (FRESH_UNKNOWN),
  // so it routes first regardless of original position.
  expect(order).toEqual(["a-credit", "a-unknown"]);
});

test("credit only breaks ties inside a rank; slow-lane still orders after fresh", async () => {
  const coolingId = "a-slow-credit";
  sharedClaudeSlowLanes.observe(coolingId, {
    offer: "treatment",
    status: "active",
    unifiedLimitClaim: false,
    overageInUse: false,
    unifiedResetAtSec: Math.floor(Date.now() / 1000) + 3600,
  });
  try {
    const order = await plannedOrder(
      snapshot([
        candidate(coolingId, { quota_windows: [creditWindow(99)] }),
        candidate("a-fresh-unknown"),
      ]),
      "qoder-model",
    );
    expect(order).toEqual(["a-fresh-unknown", coolingId]);
  } finally {
    // Observing with a fresh marker clears the lane state for the next test.
    sharedClaudeSlowLanes.observe(coolingId, {
      offer: "control",
      status: "active",
      unifiedLimitClaim: false,
      overageInUse: false,
      unifiedResetAtSec: Math.floor(Date.now() / 1000) + 3600,
    });
  }
});

describe("unregistered model passthrough", () => {
  test("a qualified provider/model not in the catalog routes via the provider's sibling candidate", async () => {
    // `qoder/not-in-catalog` is absent from the snapshot, but `qoder` has a
    // live candidate for another model. The engine clones that candidate and
    // retargets it at the requested model so the request still dispatches.
    const order = await plannedOrder(
      snapshot([candidate("a-1")]),
      "qoder/not-in-catalog",
    );
    expect(order).toEqual(["a-1"]);
  });

  test("the cloned candidate carries the requested model id", async () => {
    const engine = new RoutingEngine();
    const plan = await engine.plan(
      "qoder/not-in-catalog",
      snapshot([candidate("a-1")]),
    );
    expect(plan.resolved_model).toBe("qoder/not-in-catalog");
    expect(plan.candidates[0]?.model_id).toBe("not-in-catalog");
    expect(plan.candidates[0]?.provider_id).toBe("qoder");
  });

  test("a bare model not in the catalog still 404s", async () => {
    const engine = new RoutingEngine();
    await expect(
      engine.plan("not-in-catalog", snapshot([candidate("a-1")])),
    ).rejects.toMatchObject({ code: "model_not_found" });
  });

  test("a qualified provider with no candidates at all still 404s", async () => {
    const engine = new RoutingEngine();
    await expect(
      engine.plan("unknown-provider/anything", snapshot([candidate("a-1")])),
    ).rejects.toMatchObject({ code: "model_not_found" });
  });
});
