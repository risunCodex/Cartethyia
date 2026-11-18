/**
 * Inception's per-minute limit gets a 1-minute cooldown, not the generic
 * 15-minute default.
 *
 * The Free tier throttles per minute (1 000 requests / 1M input tokens / 100K
 * output tokens) and the window resets every minute. The generic rate-limit
 * arm would park the account for 15 minutes — long after the window refilled —
 * which is what made the limits feel harsh. The Inception arm shortens the
 * window to 1 minute so routing moves to the next account and the flagged one
 * returns almost at once.
 */
import { afterEach, expect, test } from "bun:test";
import { classifyAccountError } from "../../src/providers/operations/account-health-service";
import { resetCooldownCacheForTests } from "../../src/config/cooldowns";

const INCEPTION = "inception";
const UPSTREAM = { origin: "upstream" as const, scope: "provider" as const };

afterEach(() => {
  resetCooldownCacheForTests();
});

test("an Inception 429 cools the account for exactly 1 minute", () => {
  const classification = classifyAccountError(new Error("Rate limit exceeded. Please try again later."), {
    ...UPSTREAM,
    providerId: INCEPTION,
    statusCode: 429,
  });
  expect(classification.category).toBe("rate_limit_transient");
  expect(classification.status).toBe("cooldown");
  expect(classification.mutatesAccount).toBe(true);
  expect(classification.cooldownMs).toBe(60_000);
  expect(classification.retryAt?.getTime()).toBeGreaterThan(Date.now() + 55_000);
  expect(classification.retryAt?.getTime()).toBeLessThanOrEqual(Date.now() + 60_000);
});

test("an Inception input-token-limit message matches too", () => {
  const classification = classifyAccountError(
    new Error("Input token limit reached for this minute: 1,000,000 tokens"),
    {
      ...UPSTREAM,
      providerId: INCEPTION,
      statusCode: 429,
    },
  );
  expect(classification.category).toBe("rate_limit_transient");
  expect(classification.cooldownMs).toBe(60_000);
  expect(classification.mutatesAccount).toBe(true);
});

test("an Inception rate-limit code shape matches", () => {
  const classification = classifyAccountError(new Error("Rate limit exceeded"), {
    ...UPSTREAM,
    providerId: INCEPTION,
    providerCode: "rate_limit_reached",
  });
  expect(classification.category).toBe("rate_limit_transient");
  expect(classification.cooldownMs).toBe(60_000);
});

test("a non-Inception 429 keeps the generic 15-minute default", () => {
  const classification = classifyAccountError(new Error("Rate limit exceeded. Please try again later."), {
    ...UPSTREAM,
    providerId: "openai",
    statusCode: 429,
  });
  expect(classification.category).toBe("rate_limit_transient");
  expect(classification.mutatesAccount).toBe(true);
  expect(classification.cooldownMs).toBe(900_000);
});

test("an upstream-stated retry-after still wins over the 1-minute fallback", () => {
  const classification = classifyAccountError(new Error("Rate limit exceeded"), {
    ...UPSTREAM,
    providerId: INCEPTION,
    statusCode: 429,
    retryAfterMs: 5_000,
  });
  expect(classification.cooldownMs).toBe(5_000);
});
