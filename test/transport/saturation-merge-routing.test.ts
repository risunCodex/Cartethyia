/**
 * Saturation merge in `plan()`: a bounded account already at its inflight
 * ceiling must receive rank SATURATED (with `saturated: true`) and sort after
 * a sibling that still has room, while staying eligible — admission at
 * `reserve()` remains the real gate.
 *
 * This pins the identity contract the merge depends on: the inflight read
 * runs on the *stamped* candidates, the same objects `plan()` keys its
 * decision map by. `applyUsageFloorToCandidate` copies every account-bearing
 * candidate, and only account candidates carry a ceiling, so matching the
 * read against the snapshot's original objects would never find a decision
 * and the merge would be dead — the first attempt would go back to the
 * account that is certain to answer 429.
 */
import { describe, expect, test } from "bun:test";
import { RoutingEngine } from "../../src/transport/routing/routing-engine";
import { InMemoryAdmissionController } from "../../src/transport/routing/admission";
import { ROUTING_RANK } from "../../src/transport/routing/route-model";
import type { RouteCandidate, RouteSnapshot } from "../../src/transport/routing/route-model";

function candidate(accountId: string, extra: Record<string, unknown> = {}): RouteCandidate {
  return {
    provider_id: "testprov",
    model_id: "test-model",
    wire_family: "chat",
    endpoint: "/v1/chat",
    capability_profile: {},
    provider_account_id: accountId,
    max_inflight: 1,
    tenant_id: null,
    ...extra,
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

describe("saturation merge in plan()", () => {
  test("an account at its ceiling ranks SATURATED and plans after a fresh sibling", async () => {
    const full = candidate("acct-full");
    const room = candidate("acct-room");
    const admission = new InMemoryAdmissionController();
    // Fill acct-full to its ceiling of 1; acct-room stays at zero inflight.
    expect((await admission.admit(full)).admitted).toBe(true);

    const engine = new RoutingEngine(admission);
    // The ceiling account is listed first so the merge, not snapshot order,
    // is what puts its fresh sibling ahead.
    const plan = await engine.plan("test-model", snapshot([full, room]));

    expect(plan.candidates).toHaveLength(2);
    // The first attempt goes to the account with room; the ceiling account
    // trails as the failover candidate.
    expect(plan.candidates[0]?.provider_account_id).toBe("acct-room");
    expect(plan.candidates[1]?.provider_account_id).toBe("acct-full");

    // Decisions stay keyed per candidate identity: read them off the routed
    // (stamped) candidates themselves.
    const roomDecision = plan.decisions.get(plan.candidates[0]!);
    const fullDecision = plan.decisions.get(plan.candidates[1]!);
    expect(roomDecision?.rank).toBe(ROUTING_RANK.FRESH_UNKNOWN);
    expect(roomDecision?.saturated).toBeUndefined();
    // The ceiling account keeps its eligibility (admission is the real gate)
    // but carries the saturated verdict.
    expect(fullDecision?.eligible).toBe(true);
    expect(fullDecision?.rank).toBe(ROUTING_RANK.SATURATED);
    expect(fullDecision?.saturated).toBe(true);
  });

  test("a ceiling account alone still routes instead of failing eligibility", async () => {
    const full = candidate("acct-solo");
    const admission = new InMemoryAdmissionController();
    expect((await admission.admit(full)).admitted).toBe(true);

    const engine = new RoutingEngine(admission);
    const plan = await engine.plan("test-model", snapshot([full]));

    expect(plan.candidates).toHaveLength(1);
    const decision = plan.decisions.get(plan.candidates[0]!);
    expect(decision?.eligible).toBe(true);
    expect(decision?.rank).toBe(ROUTING_RANK.SATURATED);
    expect(decision?.saturated).toBe(true);
  });

  test("admission still enforces the ceiling when the saturated plan is reserved", async () => {
    const full = candidate("acct-solo");
    const admission = new InMemoryAdmissionController();
    expect((await admission.admit(full)).admitted).toBe(true);

    const engine = new RoutingEngine(admission);
    const plan = await engine.plan("test-model", snapshot([full]));
    // Ordering is an optimization only: the reservation attempt is the real
    // gate and must still refuse a saturated account with the routing
    // capacity code.
    await expect(engine.reserve(plan)).rejects.toMatchObject({
      code: "provider_capacity_exhausted",
    });
  });

  test("an account below its ceiling is not marked saturated", async () => {
    const first = candidate("acct-a", { max_inflight: 2 });
    const second = candidate("acct-b", { max_inflight: 2 });
    const admission = new InMemoryAdmissionController();
    // One inflight slot against a ceiling of 2: room remains on both.
    expect((await admission.admit(first)).admitted).toBe(true);

    const engine = new RoutingEngine(admission);
    const plan = await engine.plan("test-model", snapshot([first, second]));

    expect(plan.candidates).toHaveLength(2);
    for (const routed of plan.candidates) {
      const decision = plan.decisions.get(routed);
      expect(decision?.saturated).toBeUndefined();
      expect(decision?.rank).not.toBe(ROUTING_RANK.SATURATED);
    }
  });
});
