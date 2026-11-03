/**
 * Local gateway rejections must never classify as provider account cooldowns.
 *
 * Before the `origin === "upstream"` guard on the generic rate-limit / quota /
 * capacity arms, an API-key concurrency rejection (`capacity_exhausted`, 429,
 * "This API key is already serving its maximum number of concurrent requests")
 * matched the rate-limit arm and came back as `rate_limit_transient` — the
 * account-health record then blamed the provider account for a ceiling the
 * *key's* `max_concurrent` imposed, and wrote a phantom `logged -> cooldown`
 * transition. These pin the correct split: upstream verdicts still classify,
 * local ones fall through to the unclassified fallback and never mutate.
 */
import { describe, expect, test } from "bun:test";
import { GatewayError } from "../../src/protocol/gateway-error";
import { classifyAccountError } from "../../src/providers/operations/account-health-service";

const KEY_CONCURRENCY_MESSAGE =
  "This API key is already serving its maximum number of concurrent requests (request {requestId}). Retry shortly, or raise the key's concurrency limit. It'll free up in a moment 🌊";

describe("local gateway rejections do not cool provider accounts", () => {
  test("an API-key concurrency 429 never classifies as a provider rate limit", () => {
    const error = new GatewayError("capacity_exhausted", 429, KEY_CONCURRENCY_MESSAGE, {
      reason: "concurrency-limit",
    });
    const classification = classifyAccountError(error, {
      origin: "cartethyia",
      scope: "provider",
      statusCode: 429,
    });
    expect(classification.category).not.toBe("rate_limit_transient");
    expect(classification.category).toBe("unknown");
    expect(classification.mutatesAccount).toBe(false);
    expect(classification.status).toBe("cooldown");
  });

  test("the same message from the upstream still classifies as a rate limit", () => {
    const error = new GatewayError("quota_exceeded", 429, "rate limit exceeded", {}, "upstream");
    const classification = classifyAccountError(error, {
      origin: "upstream",
      scope: "provider",
      statusCode: 429,
    });
    expect(classification.category).toBe("rate_limit_transient");
    expect(classification.status).toBe("cooldown");
  });

  test("a local tenant-capacity 429 stays unclassified", () => {
    const error = new GatewayError(
      "tenant_capacity_exhausted",
      429,
      "This tenant is already serving its maximum number of concurrent requests",
    );
    const classification = classifyAccountError(error, {
      origin: "cartethyia",
      scope: "provider",
      statusCode: 429,
    });
    expect(classification.category).toBe("unknown");
    expect(classification.mutatesAccount).toBe(false);
  });

  test("a local provider-capacity 429 never cools the account", () => {
    const error = new GatewayError("provider_capacity_exhausted", 429, "Every account is at its concurrency limit");
    const classification = classifyAccountError(error, {
      origin: "cartethyia",
      scope: "provider",
      statusCode: 429,
    });
    // The gateway-capacity arm owns this exact message: it names the ceiling,
    // never the account, so it must not mutate.
    expect(classification.mutatesAccount).toBe(false);
    expect(classification.category).not.toBe("rate_limit_transient");
    expect(classification.category).toBe("model_capacity");
  });
});
