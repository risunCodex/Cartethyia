/**
 * Qoder's quota verdicts — `110` "Billing daily count exceeded" and the
 * exhausted-quota 499 close — must cool the *model*, never the account.
 *
 * One model's spend cap does not drain another: cooling the whole account as
 * `quota_exhausted` parks every other model on it, the exact symptom reported.
 * The classifier must produce a model-scoped verdict (`model_unreachable`,
 * mutating so the writer writes `modelCooldowns[modelId]`), and stay
 * non-mutating when no model is known so an unknown-pair refusal never parks
 * the account either. The window is a full day — the provider's own daily
 * billing window — never the generic 1h fallback, which let the pair
 * re-enter rotation inside the window it was closed for.
 */
import { expect, test } from "bun:test";
import { classifyAccountError } from "../../src/providers/operations/account-health-service";
import { classifyUpstreamError } from "../../src/transport/failure-policy";
import { GatewayError } from "../../src/protocol/gateway-error";

const BILLING_DAILY = '{"code":"110","message":"Billing daily count exceeded"}';
const UPSTREAM = { origin: "upstream" as const, scope: "account" as const };
const ONE_DAY = 24 * 60 * 60 * 1000;

test("Qoder code-110 billing-limit refusals cool the model, not the account", () => {
  const classification = classifyAccountError(new Error(BILLING_DAILY), {
    ...UPSTREAM,
    providerId: "qoder",
    providerCode: "110",
    statusCode: 403,
    modelId: "deepseek-v4.1-flash",
  });
  expect(classification.category).toBe("model_unreachable");
  expect(classification.status).toBe("cooldown");
  expect(classification.cooldownMs).toBe(ONE_DAY);
  // Mutating = the writer records `modelCooldowns[modelId]` and leaves the
  // account routable for its other models.
  expect(classification.mutatesAccount).toBe(true);
  expect(classification.category).not.toBe("auth_invalidated");
});

test("Qoder code-110 is never credential invalidation, with or without a model", () => {
  expect(
    classifyAccountError(new Error(BILLING_DAILY), {
      ...UPSTREAM,
      providerId: "qoder",
      providerCode: "110",
      statusCode: 401,
      credentialEvidence: true,
      modelId: "deepseek-v4.1-flash",
    }).category,
  ).not.toBe("auth_invalidated");
  expect(
    classifyAccountError(new Error(BILLING_DAILY), {
      ...UPSTREAM,
      providerId: "qoder",
      providerCode: "110",
      statusCode: 401,
      credentialEvidence: true,
    }).category,
  ).not.toBe("auth_invalidated");
});

test("Qoder code-110 without a model id never parks the account", () => {
  const classification = classifyAccountError(new Error(BILLING_DAILY), {
    ...UPSTREAM,
    providerId: "qoder",
    providerCode: "110",
    statusCode: 403,
  });
  expect(classification.category).toBe("model_unreachable");
  expect(classification.status).toBe("cooldown");
  expect(classification.mutatesAccount).toBe(false);
});

test("the billing phrase is recognised even when the numeric code is not parsed", () => {
  // The probe path may deliver only the message text.
  const classification = classifyAccountError(new Error("Billing daily count exceeded"), {
    ...UPSTREAM,
    providerId: "qoder",
    statusCode: 403,
    modelId: "auto",
  });
  expect(classification.category).toBe("model_unreachable");
  expect(classification.status).toBe("cooldown");
  expect(classification.mutatesAccount).toBe(true);
});

test("upstream classification maps code 110 to quota, not auth", () => {
  const classification = classifyUpstreamError(403, "110");
  expect(classification.code).toBe("quota_exceeded");
  expect(classification.credentialEvidence).toBeUndefined();
});

test("an unknown numeric provider code never invalidates the credential", () => {
  const classification = classifyAccountError(new Error("some opaque error"), {
    ...UPSTREAM,
    providerId: "qoder",
    providerCode: "999",
    statusCode: 403,
    credentialEvidence: true,
  });
  expect(classification.category).not.toBe("auth_invalidated");
  // Unknown → safe cooldown, never a parked/disabled account.
  expect(classification.status).toBe("cooldown");
});

test("textual auth rejection still invalidates the credential", () => {
  const classification = classifyAccountError(new Error("invalid api key"), {
    origin: "upstream",
    scope: "account",
    providerId: "qoder",
  });
  expect(classification.category).toBe("auth_invalidated");
});

test("Qoder gRPC quota_exceeded with providerCode cools the model for a day", () => {
  // The gRPC surface throws `quota_exceeded` with `providerCode:
  // "quota_exceeded"` in details. That must take the qoder model-scoped
  // quota arm (24h) instead of falling through to the generic 429
  // rate-limit arm (transient, short).
  const classification = classifyAccountError(
    new GatewayError("quota_exceeded", 429, "Qoder quota exhausted on the gRPC surface", {
      providerCode: "quota_exceeded",
    }, "upstream"),
    {
      ...UPSTREAM,
      providerId: "qoder",
      statusCode: 429,
      modelId: "deepseek-v4.1-flash",
    },
  );
  expect(classification.category).toBe("model_unreachable");
  expect(classification.status).toBe("cooldown");
  expect(classification.cooldownMs).toBe(ONE_DAY);
  expect(classification.mutatesAccount).toBe(true);
});

test("Qoder 429 without a quota provider code stays a transient rate limit", () => {
  const classification = classifyAccountError(
    new GatewayError("quota_exceeded", 429, "Qoder quota exhausted on the gRPC surface", {}, "upstream"),
    {
      ...UPSTREAM,
      providerId: "qoder",
      statusCode: 429,
      modelId: "deepseek-v4.1-flash",
    },
  );
  // No provider code → not a quota signal → generic rate-limit arm.
  expect(classification.category).toBe("rate_limit_transient");
  expect(classification.cooldownMs).toBeLessThan(ONE_DAY);
});
