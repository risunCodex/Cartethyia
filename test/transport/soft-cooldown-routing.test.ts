/**
 * Soft-cooldown routing: a soft cooling account is deprioritized, not
 * excluded (M-14). The evaluator returns it eligible — so a single-account
 * deployment still reaches it — but the plan must sort it after every
 * fresh/slow sibling, and an all-soft set must answer 429 with the real
 * reset instead of serving a cooling account (the "still hit a cooled-down
 * account, never failed over" report).
 *
 * `cooldown_kind: "soft"` is the runtime stamp default (`route-catalog.ts`
 * derives it from every non-hard error category); a soft cooldown used to
 * fall through to the quota classification and sort as FRESH_KNOWN ahead of
 * healthy accounts.
 */
import { describe, expect, test } from "bun:test";
import { EligibilityEvaluator, RoutingEngine } from "../../src/transport/routing/router";
import type { RouteCandidate, RouteSnapshot } from "../../src/transport/routing/route-model";

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

function softCooling(id: string, resetInMs = 3_600_000): RouteCandidate {
  return candidate(id, {
    health_status: "cooldown",
    cooldown_kind: "soft",
    cooldown_until: Date.now() + resetInMs,
  });
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

describe("soft cooldown evaluation", () => {
  test("a soft cooldown is eligible and keeps its raw reason", () => {
    const decision = new EligibilityEvaluator().evaluate(softCooling("a1"));
    expect(decision.eligible).toBe(true);
    expect(decision.reason).toBe("cooldown");
    expect(decision.cooldown_until).toBeTypeOf("number");
  });
});

describe("soft cooldown plan ordering", () => {
  test("a soft-cooling candidate listed first loses to a healthy sibling", async () => {
    const order = await plannedOrder(
      snapshot([softCooling("a-soft"), candidate("a-healthy")]),
      "qoder-model",
    );
    expect(order).toEqual(["a-healthy", "a-soft"]);
  });

  test("a soft-cooling candidate loses to a healthy sibling even with credit", async () => {
    const order = await plannedOrder(
      snapshot([
        candidate("a-soft-credit", {
          health_status: "cooldown",
          cooldown_kind: "soft",
          cooldown_until: Date.now() + 3_600_000,
          quota_windows: [{ accounting: "pooled", remaining: 99 }],
        }),
        candidate("a-healthy-unknown"),
      ]),
      "qoder-model",
    );
    expect(order).toEqual(["a-healthy-unknown", "a-soft-credit"]);
  });

  test("an all-soft-cooling set answers 429 with the reset", async () => {
    const engine = new RoutingEngine();
    const resetWindowMs = 3_600_000;
    let thrown: { code?: string; status?: number; details?: Record<string, unknown> } | undefined;
    try {
      await engine.plan(
        "qoder-model",
        snapshot([softCooling("a-soft-1", resetWindowMs), softCooling("a-soft-2", 0)]),
      );
    } catch (error) {
      thrown = error as { code?: string; status?: number; details?: Record<string, unknown> };
    }
    expect(thrown).toBeDefined();
    expect(thrown?.code).toBe("accounts_rate_limited");
    expect(thrown?.status).toBe(429);
    // The earliest reset is quoted, not a bare 429: a positive retry-after
    // bounded by the window the first candidate was parked for.
    const retryAfterMs = thrown?.details?.retryAfterMs;
    expect(typeof retryAfterMs).toBe("number");
    expect(retryAfterMs as number).toBeGreaterThan(0);
    expect(retryAfterMs as number).toBeLessThanOrEqual(resetWindowMs);
  });

  test("a single healthy candidate still routes", async () => {
    const order = await plannedOrder(snapshot([candidate("a-healthy")]), "qoder-model");
    expect(order).toEqual(["a-healthy"]);
  });
});
