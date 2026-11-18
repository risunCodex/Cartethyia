/**
 * Combo fallback ordering across health transitions: a `fallback` combo must
 * try its members in declared order while they are healthy, fail over to a
 * sibling when the primary cools, and return to the primary the moment it
 * recovers — the "provider sudah pulih tapi gak dipakai" report.
 *
 * The attempt loop moves a failed member behind its siblings for the *rest of
 * the request* (`runAttemptLoop`); the plan under test here is the next
 * request's plan, which must be built purely from current health: a recovered
 * primary is fresh and sorts back to the front of the member order.
 */
import { describe, expect, test } from "bun:test";
import { RoutingEngine } from "../../src/transport/routing/routing-engine";
import type { RouteCandidate, RouteSnapshot } from "../../src/transport/routing/route-model";

const TENANT = "tenant-1";
const COMBO = "combo-fallback";

function candidate(
  providerId: string,
  modelId: string,
  accountId: string,
  extra: Record<string, unknown> = {},
): RouteCandidate {
  return {
    provider_id: providerId,
    model_id: modelId,
    wire_family: "chat",
    endpoint: "/v1/chat/completions",
    capability_profile: {},
    provider_account_id: accountId,
    tenant_id: null,
    ...extra,
  } as unknown as RouteCandidate;
}

/** Primary member account. */
function primary(extra: Record<string, unknown> = {}): RouteCandidate {
  return candidate("provider-a", "model-a", "a1", extra);
}

/** Secondary member account. */
function secondary(extra: Record<string, unknown> = {}): RouteCandidate {
  return candidate("provider-b", "model-b", "b1", extra);
}

function snapshot(candidates: readonly RouteCandidate[]): RouteSnapshot {
  return {
    revision: 1,
    candidates,
    aliases: {},
    combos: {
      [TENANT]: {
        [COMBO]: { members: ["model-a", "model-b"], strategy: "fallback" },
      },
    },
    created_at: Date.now(),
  };
}

async function plannedOrder(snapshot: RouteSnapshot): Promise<string[]> {
  const engine = new RoutingEngine();
  const plan = await engine.plan(COMBO, snapshot, TENANT);
  return plan.candidates.map((candidate) => candidate.provider_account_id ?? candidate.provider_id);
}

describe("fallback combo ordering across health", () => {
  test("both members healthy: declared member order is preserved", async () => {
    const order = await plannedOrder(snapshot([primary(), secondary()]));
    expect(order).toEqual(["a1", "b1"]);
  });

  test("primary soft-cooling: sibling is tried first, primary stays behind", async () => {
    const order = await plannedOrder(
      snapshot([
        primary({ health_status: "cooldown", cooldown_kind: "soft", cooldown_until: Date.now() + 3_600_000 }),
        secondary(),
      ]),
    );
    expect(order).toEqual(["b1", "a1"]);
  });

  test("primary hard-cooling: excluded, sibling routes alone", async () => {
    const order = await plannedOrder(
      snapshot([
        primary({ health_status: "cooldown", cooldown_kind: "hard", cooldown_until: Date.now() + 3_600_000 }),
        secondary(),
      ]),
    );
    expect(order).toEqual(["b1"]);
  });

  test("after recovery the primary returns to the front", async () => {
    // Cooling primary → plan moves to the sibling.
    const cooling = await plannedOrder(
      snapshot([
        primary({ health_status: "cooldown", cooldown_kind: "soft", cooldown_until: Date.now() + 3_600_000 }),
        secondary(),
      ]),
    );
    expect(cooling).toEqual(["b1", "a1"]);

    // Primary recovers (health stamp gone / active): the next plan builds from
    // current health and puts it back at the head of the member order.
    const recovered = await plannedOrder(snapshot([primary(), secondary()]));
    expect(recovered).toEqual(["a1", "b1"]);
  });
});
