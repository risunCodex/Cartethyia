/**
 * A free-tier refusal retires the egress, and nothing else does.
 *
 * OpenCode answers a flagged address with `403` + `FreeTierError`. The request
 * was never read, so the same proxy cannot succeed no matter what the payload
 * says — the fix is a different egress. Two mistakes are easy here and both are
 * pinned below: treating *any* 403 as an egress block (a content-policy refusal
 * would discard a healthy proxy), and treating a block as a long cooldown
 * (putting a retired address back into rotation).
 */
import { describe, expect, test } from "bun:test";
import { GatewayError } from "../../src/protocol/gateway-error";
import { classifyEgressFailure } from "../../src/network/verdict";
import { PROVIDER_BLOCK_MS } from "../../src/network/pool/selector";
import { providerRateLimitIsIpScoped } from "../../src/providers/provider-metadata";

/** The provider whose limits follow the egress address. */
const IP_SCOPED_PROVIDER = "opencode";

function freeTierRefusal(): GatewayError {
  return new GatewayError(
    "authentication_failed",
    403,
    "OpenCode's free tier can only be used from within OpenCode.",
    {
      providerId: IP_SCOPED_PROVIDER,
      providerStatus: 403,
      providerCode: "FreeTierError",
      raw: '{"type":"error","error":{"type":"FreeTierError","message":"…"}}',
    },
    "upstream",
  );
}

describe("classifyEgressFailure — free-tier IP block", () => {
  test("a FreeTierError 403 on an IP-scoped provider is an egress block", () => {
    expect(classifyEgressFailure(freeTierRefusal(), IP_SCOPED_PROVIDER).kind).toBe("blocked");
  });

  test("the provider id must be the IP-scoped one", () => {
    // A 403 from a provider whose limits belong to the credential says nothing
    // about the egress; retiring the pool would sideline healthy siblings.
    expect(classifyEgressFailure(freeTierRefusal(), "anthropic").kind).toBe("none");
  });

  test("an ordinary 403 is not an egress block", () => {
    const policy = new GatewayError(
      "policy_rejected",
      403,
      "content blocked by safety review",
      { providerId: IP_SCOPED_PROVIDER, providerCode: "11140" },
      "upstream",
    );
    expect(classifyEgressFailure(policy, IP_SCOPED_PROVIDER).kind).toBe("none");
  });

  test("a 429 is a cooldown, not an egress block", () => {
    const throttled = new GatewayError(
      "accounts_rate_limited",
      429,
      "Too many requests",
      { providerId: IP_SCOPED_PROVIDER, rateLimitScope: "provider" },
      "upstream",
    );
    expect(classifyEgressFailure(throttled, IP_SCOPED_PROVIDER).kind).toBe("cooldown");
  });

  test("a non-gateway error is not an egress block", () => {
    expect(classifyEgressFailure(new Error("FreeTierError"), IP_SCOPED_PROVIDER).kind).toBe("none");
  });
});

describe("block versus cooldown", () => {
  test("the block window outlives any cooldown an operator would wait out", () => {
    // A day is the longest cooldown this gateway applies; a retired address
    // must not come back inside that horizon on its own.
    expect(PROVIDER_BLOCK_MS).toBeGreaterThan(24 * 60 * 60 * 1000);
  });

  test("the free tier is the IP-scoped provider this rule is written for", () => {
    expect(providerRateLimitIsIpScoped(IP_SCOPED_PROVIDER)).toBe(true);
  });
});
