/**
 * Credit-priority routing: within the same rank group, accounts with remaining
 * pooled credit are ordered ahead of unknown-quota accounts. Free-tier models
 * skip the preference — a free model routes to any account. The rank
 * (fresh → slow → cooling → saturated) stays the primary sort key; credit only
 * breaks ties inside one rank. Known-zero credit accounts are already excluded
 * by the usage-floor gate, so they never reach the ordering.
 */
import { expect, test } from "bun:test";
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

test("a known-zero credit account is excluded, never ordered ahead of unknown", async () => {
  const order = await plannedOrder(
    snapshot([
      candidate("a-zero", { quota_windows: [creditWindow(0)] }),
      candidate("a-unknown"),
    ]),
    "qoder-model",
  );
  // The zero-credit account cannot serve; only the unknown one is routable.
  expect(order).toEqual(["a-unknown"]);
});

test("a free-tier model is still excluded when its own quota window is exhausted", async () => {
  const order = await plannedOrder(
    snapshot([
      candidate("a-exhausted-free", { free_tier: true, quota_windows: [creditWindow(0)] }),
      candidate("a-unknown-free", { free_tier: true }),
    ]),
    "qoder-model",
  );
  // Exhausted quota windows are the provider's own limit, not the credit floor:
  // they still exclude the account even for a free-tier model.
  expect(order).toEqual(["a-unknown-free"]);
});

test("a free-tier model ignores only the operator floor threshold, not exhausted windows", async () => {
  const order = await plannedOrder(
    snapshot([
      // 42 credits remaining is above zero but below the default 40% floor
      // interpretation — the point is it is not exhausted, yet the floor
      // threshold would normally skip it. Free tier ignores that threshold.
      candidate("a-above-floor-free", { free_tier: true, quota_windows: [creditWindow(42)] }),
      candidate("a-exhausted-free", { free_tier: true, quota_windows: [creditWindow(0)] }),
    ]),
    "qoder-model",
  );
  // The non-exhausted account routes; the exhausted one stays excluded. Credit
  // preference is skipped for free tier, so original order is preserved.
  expect(order).toEqual(["a-above-floor-free"]);
});

test("a free-tier model routes to any account (no credit preference)", async () => {
  const order = await plannedOrder(
    snapshot([
      candidate("a-unknown", { free_tier: true }),
      candidate("a-credit", { free_tier: true, quota_windows: [creditWindow(42)] }),
    ]),
    "qoder-model",
  );
  // Credit would put a-credit first; a free model keeps the original order.
  expect(order).toEqual(["a-unknown", "a-credit"]);
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
