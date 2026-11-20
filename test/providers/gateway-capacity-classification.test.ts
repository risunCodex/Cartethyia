/**
 * A gateway concurrency rejection must never be read as an account rate limit.
 *
 * `provider_capacity_exhausted` is raised by this gateway's own routing when
 * every account serving a model is already at its max-inflight. Nothing is
 * wrong with the credential — the ceiling is. But the error is a 429 whose
 * text says "rate limit", so it matched the `rate-limit` arm and cooled the
 * account for the full 15-minute rate-limit window. Every account then read
 * `cooldown`, so all of them looked busy while requests piled up.
 *
 * These pin the rejection as capacity-with-no-account-penalty, and pin the
 * rate-limit arm still working for rejections an upstream actually sent.
 */
import { expect, test } from "bun:test";
import { classifyAccountError } from "../../src/providers/operations/account-health-service";
import { capacityExhaustedError } from "../../src/transport/routing/route-model";

const CAPACITY_MESSAGES = [
  capacityExhaustedError({ providerId: "p", model: "m", candidateCount: 1, maxInflight: 2 }),
  capacityExhaustedError({ providerId: "p", model: "m", candidateCount: 4, maxInflight: 2 }),
  new Error("Every proxy pool for this provider is at its concurrency limit. Retry shortly."),
  new Error("The gateway is at its concurrency limit. Retry shortly."),
];

test("a gateway capacity rejection does not mutate the account", () => {
  for (const error of CAPACITY_MESSAGES) {
    expect(classifyAccountError(error, {}).mutatesAccount).toBe(false);
  }
});

test("a gateway capacity rejection attaches no cooldown", () => {
  for (const error of CAPACITY_MESSAGES) {
    expect(classifyAccountError(error, {}).cooldownMs).toBe(0);
  }
});

test("it is not claimed by the rate-limit arm, whatever scope it arrives with", () => {
  for (const error of CAPACITY_MESSAGES) {
    for (const scope of ["provider", "account", "model"] as const) {
      const classification = classifyAccountError(error, {
        origin: "upstream",
        scope,
        statusCode: 429,
      });
      expect(classification.category).toBe("model_capacity");
      expect(classification.mutatesAccount).toBe(false);
    }
  }
});

test("a real upstream rate limit with a stated window still cools the account", () => {
  for (const message of ["Rate limit reached for requests", "Too many requests"]) {
    const classification = classifyAccountError(new Error(message), {
      origin: "upstream",
      scope: "provider",
      statusCode: 429,
      retryAfterMs: 120_000,
    });
    expect(classification.category).toBe("rate_limit_transient");
    expect(classification.mutatesAccount).toBe(true);
    expect(classification.cooldownMs).toBe(120_000);
  }
});

test("an unstated rate limit is a skip, not a cooldown", () => {
  // No window stated means nothing to wait out: the account is neither parked
  // nor flagged, and only the audit row records the refusal.
  for (const message of ["Rate limit reached for requests", "Too many requests"]) {
    const classification = classifyAccountError(new Error(message), {
      origin: "upstream",
      scope: "provider",
      statusCode: 429,
    });
    expect(classification.category).toBe("rate_limit_transient");
    expect(classification.mutatesAccount).toBe(false);
    expect(classification.cooldownMs).toBe(0);
  }
});

test("a provider model-frequency window still scopes to the model", () => {
  const classification = classifyAccountError(
    new Error("usage exceeds frequency limit, switch to the other models"),
    { origin: "upstream", scope: "provider" },
  );
  expect(classification.category).toBe("rate_limit_transient");
  expect(classification.mutatesAccount).toBe(true);
});
