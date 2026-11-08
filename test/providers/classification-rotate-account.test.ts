/**
 * Classified rotation: a usage-limit/quota/spend verdict rotates to a sibling
 * account, while a transient per-minute throttle, model-capacity overload, or
 * concurrency cap backs off on the same account. `rotateAccount` is the axis
 * that distinguishes them.
 */
import { describe, expect, test } from "bun:test";
import { classifyAccountError } from "../../src/providers/operations/account-health-service";

function classify(message: string, extra: Record<string, unknown> = {}) {
  return classifyAccountError(new Error(message), {
    origin: "upstream",
    scope: "account",
    ...extra,
  });
}

describe("classifyAccountError rotateAccount", () => {
  test("quota exhaustion rotates to a sibling", () => {
    for (const message of [
      "You exceeded your current quota, please check your plan and billing details",
      "Insufficient credits",
      "Credits exhausted",
      "Your project has exceeded its monthly spending cap",
      "usage_limit_reached",
      "insufficient_quota",
    ]) {
      const c = classify(message, { statusCode: 429 });
      expect(c.rotateAccount, message).toBe(true);
    }
  });

  test("a spending-cap wording on 402 rotates", () => {
    const c = classify("You have exceeded your monthly spend limit", { statusCode: 402 });
    expect(c.rotateAccount).toBe(true);
  });

  test("a per-minute rate limit backs off on the same account (no rotate)", () => {
    for (const message of [
      "Rate limit will reset in 30 seconds",
      "Too many requests, please retry later",
      "tpm exhausted (type=quota_exceeded_error)",
      "RateLimitExceeded.EndpointTPMExceeded",
    ]) {
      const c = classify(message, { statusCode: 429 });
      expect(c.rotateAccount, message).toBe(false);
      expect(c.category).toBe("rate_limit_transient");
    }
  });

  test("model-capacity overload backs off, never rotates", () => {
    const c = classify("Model overloaded, retry shortly", { statusCode: 503 });
    expect(c.rotateAccount).toBe(false);
    expect(c.category).toBe("model_capacity");
  });

  test("an account ban rotates (rotates away from the banned credential)", () => {
    const c = classifyAccountError(new Error("Your account has been restricted due to unusual activity"), {
      origin: "upstream",
      scope: "account",
      providerId: "cb",
      providerCode: "11140",
      statusCode: 403,
    });
    expect(c.rotateAccount).toBe(true);
    expect(c.category).toBe("policy_blocked_banned");
  });

  test("a request refusal never rotates (it is not a credential verdict)", () => {
    const c = classifyAccountError(new Error("request illegal"), {
      origin: "upstream",
      scope: "account",
      providerId: "cb",
      providerCode: "11140",
      statusCode: 403,
    });
    expect(c.rotateAccount).toBe(false);
  });
});
