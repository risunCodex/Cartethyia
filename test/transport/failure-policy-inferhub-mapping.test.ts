/**
 * InferHub error mapping.
 *
 * InferHub publishes its own vocabulary in `error.code`, and several of its
 * codes would otherwise be misread:
 *
 * - `account_blocked` and `model_not_allowed_for_key` arrive as **403**. The
 *   status-only table calls every 403 `authentication_failed`; the two mean
 *   different things and neither is a spend limit, so `account_blocked` must
 *   cool the *account* (credential evidence) and `model_not_allowed_for_key`
 *   must be a per-key/per-model refusal rather than a provider-wide outage.
 * - `no_provider` is not "the upstream is broken": no publisher serves the
 *   model at all, so a retry should pick another route instead of cooling
 *   anything.
 * - `rate_limited` (429) must stay quota-shaped so `Retry-After` is honored.
 *
 * No new gateway error codes are introduced — every mapping below lands on an
 * existing member.
 */
import { describe, expect, test } from "bun:test";
import {
  classifyUpstreamError,
  upstreamErrorIdentifier,
  statusToGatewayErrorCode,
  parseRetryAfter,
} from "../../src/transport/failure-policy";

/** InferHub's error envelope: `{ error: { code, message } }`. */
function inferhubBody(code: string): unknown {
  return { error: { code, message: `inferhub: ${code}` } };
}

describe("InferHub error identifier extraction", () => {
  test("reads the code out of InferHub's nested envelope", () => {
    expect(upstreamErrorIdentifier(inferhubBody("account_blocked"))).toBe("account_blocked");
    expect(upstreamErrorIdentifier(inferhubBody("model_not_allowed_for_key"))).toBe(
      "model_not_allowed_for_key",
    );
  });
});

describe("InferHub error classification", () => {
  test("403 account_blocked is an account-level credential fault", () => {
    // Not a quota fault: the account was blocked, so cooling the provider would
    // punish every other account on it.
    const result = classifyUpstreamError(403, "account_blocked");
    expect(result.code).toBe("authentication_failed");
    expect(result.status).toBe(403);
    expect(result.credentialEvidence).toBe(true);
  });

  test("403 model_not_allowed_for_key is a per-key refusal", () => {
    const result = classifyUpstreamError(403, "model_not_allowed_for_key");
    expect(result.code).toBe("authentication_failed");
    expect(result.status).toBe(403);
  });

  test("403 insufficient_key_scope is an auth fault", () => {
    expect(classifyUpstreamError(403, "insufficient_key_scope").code).toBe(
      "authentication_failed",
    );
  });

  test("429 rate_limited stays quota-shaped so Retry-After is honored", () => {
    // The status-only path already reaches quota_exceeded; the identifier must
    // not divert it into a non-retryable class.
    expect(statusToGatewayErrorCode(429)).toBe("quota_exceeded");
    expect(classifyUpstreamError(429, "rate_limited").code).toBe("quota_exceeded");
  });

  test("a 429 Retry-After header becomes a real cooldown, in milliseconds", () => {
    // InferHub sends `Retry-After` in seconds, as the OpenAI/Anthropic error
    // shape specifies. The guard against a retry storm is that the value is
    // actually honored rather than dropped.
    expect(parseRetryAfter("5")).toBe(5_000);
    expect(parseRetryAfter(null)).toBeNull();
  });

  test("402 is a billing verdict on the account", () => {
    expect(statusToGatewayErrorCode(402)).toBe("quota_exceeded");
  });

  test("no_provider is a model/route property, not an outage", () => {
    const result = classifyUpstreamError(503, "no_provider");
    expect(result.code).toBe("model_not_found");
    // Not credential evidence: the account is fine, the model has no publisher.
    expect(result.credentialEvidence).toBeUndefined();
  });

  test("provider-busy codes classify as upstream overload", () => {
    for (const code of ["providers_busy", "providers_overloaded"]) {
      expect(classifyUpstreamError(503, code).code).toBe("upstream_overloaded");
    }
  });

  test("quota-shaped provider codes classify as quota", () => {
    for (const code of ["providers_out_of_quota", "providers_at_capacity"]) {
      expect(classifyUpstreamError(429, code).code).toBe("quota_exceeded");
    }
  });

  test("context_too_long is a context overflow", () => {
    expect(classifyUpstreamError(400, "context_too_long").code).toBe(
      "context_length_exceeded",
    );
  });

  test("content_rejected is a policy refusal", () => {
    expect(classifyUpstreamError(403, "content_rejected").code).toBe("policy_rejected");
  });

  test("upstream_timeout is a deadline, not a platform outage", () => {
    // Already handled for every provider; pinned so an InferHub refactor cannot
    // drop it into the generic 5xx bucket.
    expect(classifyUpstreamError(504, "upstream_timeout").code).toBe("deadline_exceeded");
  });

  test("5xx without a recognized code stays a platform outage", () => {
    expect(classifyUpstreamError(500, "internal_error").code).toBe("platform_unavailable");
    expect(statusToGatewayErrorCode(503)).toBe("platform_unavailable");
  });
});
