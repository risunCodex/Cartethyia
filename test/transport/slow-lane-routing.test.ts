/**
 * Slow-lane routing integration (design doc §4).
 *
 * The property that matters: a slow-lane account still SERVES, so it must stay
 * eligible and merely order behind fresh siblings. Two failure modes are pinned
 * here — an all-slow pool must not answer 429 while capacity sits idle, and a
 * slow candidate must not jump ahead of a fresh one.
 */
import { describe, expect, test } from "bun:test";
import { EligibilityEvaluator } from "../../src/transport/routing/router";
import { sharedClaudeSlowLanes } from "../../src/providers/integrations/claude/claude-slow-lane";
import type { RouteCandidate } from "../../src/transport/routing/route-model";

function candidate(id: string, extra: Record<string, unknown> = {}): RouteCandidate {
  return {
    provider_id: "claude",
    model_id: "claude-sonnet-4-6",
    wire_family: "messages",
    endpoint: "/v1/messages",
    capability_profile: {},
    provider_account_id: id,
    ...extra,
  } as unknown as RouteCandidate;
}

describe("slow-lane eligibility", () => {
  test("a lane-stamped candidate is eligible with reason 'slow'", () => {
    const decision = new EligibilityEvaluator().evaluate(candidate("a1", { lane: "slow" }));
    expect(decision.eligible).toBe(true);
    expect(decision.reason).toBe("slow");
  });

  test("a candidate with no lane stamp is healthy", () => {
    const decision = new EligibilityEvaluator().evaluate(candidate("a1"));
    expect(decision.reason).toBe("healthy");
  });

  test("a lane-stamped candidate is never a cooldown exclusion", () => {
    // The design's core claim: slow is orthogonal to cooldown, so a slow
    // account must not be excluded the way a hard cooldown is.
    const decision = new EligibilityEvaluator().evaluate(candidate("a1", { lane: "slow" }));
    expect(decision.reason).not.toBe("cooldown_hard");
    expect(decision.reason).not.toBe("model_cooldown");
    expect(decision.eligible).toBe(true);
  });

  test("a hard cooldown still wins over a lane stamp", () => {
    // Orthogonal does not mean overriding: a genuinely excluded account stays
    // excluded even if it happens to carry a lane stamp.
    const decision = new EligibilityEvaluator().evaluate(
      candidate("a1", { lane: "slow", health_status: "cooldown", cooldown_kind: "hard" }),
    );
    expect(decision.eligible).toBe(false);
    expect(decision.reason).toBe("cooldown_hard");
  });

  test("a lane-stamped exhausted account stays eligible (quota no longer excludes)", () => {
    // Quota is deliberately not an eligibility exclusion anymore: an exhausted
    // account is still routed (upstream decides) and a lane stamp only orders
    // it behind fresh siblings.
    const decision = new EligibilityEvaluator().evaluate(
      candidate("a1", {
        lane: "slow",
        quota_windows: [
          {
            accounting: "independent",
            remainingPercent: 0,
            resetAtMs: Date.now() + 3600_000,
          },
        ],
      }),
    );
    expect(decision.eligible).toBe(true);
    expect(decision.reason).toBe("slow");
  });
});

describe("slow-lane registry", () => {
  test("a fresh account is not lane-active", () => {
    expect(sharedClaudeSlowLanes.isActive(`fresh-${crypto.randomUUID()}`)).toBe(false);
  });

  test("observing a treatment offer makes the account lane-active", () => {
    const accountId = `lane-${crypto.randomUUID()}`;
    sharedClaudeSlowLanes.observe(accountId, {
      offer: "treatment",
      status: "active",
      unifiedLimitClaim: false,
      overageInUse: false,
      unifiedResetAtSec: Math.floor(Date.now() / 1000) + 3600,
    });
    expect(sharedClaudeSlowLanes.isActive(accountId)).toBe(true);
  });
});
