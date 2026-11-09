import { describe, expect, test } from "bun:test";
import type { CanonicalEvent } from "../../src/protocol/canonical-model";
import { classifyUpstreamFailure } from "../../src/transport/failure-policy";
import { GatewayError } from "../../src/protocol/gateway-error";
import { classifyAccountError } from "../../src/providers/operations/account-health-service";
import {
  GROK_407_PROBE_PROMPT,
  grok407ProbeFailure,
} from "../../src/providers/discovery/probe-phases";

function textEvent(text: string): readonly CanonicalEvent[] {
  return [
    {
      type: "content_delta",
      sequence_number: 1,
      content: { kind: "text", text },
    },
  ];
}

describe("Grok 407 feature probe", () => {
  test("accepts a bare 407", () => {
    expect(
      grok407ProbeFailure({
        providerId: "grok",
        prompt: GROK_407_PROBE_PROMPT,
        events: textEvent("407"),
        dispatchError: undefined,
      }),
    ).toBeUndefined();
  });

  test("accepts 407 with Grok confidence metadata and a terminal error", () => {
    expect(
      grok407ProbeFailure({
        providerId: "grok",
        prompt: GROK_407_PROBE_PROMPT,
        events: textEvent("407 \\confidence{100}"),
        dispatchError: new Error("terminal metadata after content"),
      }),
    ).toBeUndefined();
  });

  test("parks a 202 response as Grok free-usage exhaustion", () => {
    const failure = grok407ProbeFailure({
      providerId: "grok",
      prompt: GROK_407_PROBE_PROMPT,
      events: textEvent("202"),
      dispatchError: undefined,
    });

    expect(failure).toBeInstanceOf(GatewayError);
    expect(failure?.code).toBe("quota_exceeded");
    expect(failure?.details.providerCode).toBe("subscription:free-usage-exhausted");
    expect(failure?.details.providerStatus).toBe(202);
    expect(failure?.details.upstreamStatus).toBe(202);
  });

  test("parks a refusal (not exactly 407) for the same quota window", () => {
    const failure = grok407ProbeFailure({
      providerId: "grok",
      prompt: GROK_407_PROBE_PROMPT,
      events: textEvent("I can't reply with only a specific number."),
      dispatchError: undefined,
    });

    if (failure === undefined) throw new Error("expected Grok feature failure");
    const policy = classifyUpstreamFailure(failure);
    const classification = classifyAccountError(failure, { ...policy, providerId: "grok" });
    expect(failure.code).toBe("quota_exceeded");
    expect(failure.details.providerCode).toBe("subscription:free-usage-exhausted");
    expect(classification.cooldownMs).toBe(24 * 60 * 60 * 1000);
    expect(classification.modelScoped).toBe(false);
  });

  test("a named free-usage exhaustion is scoped to the requested model", () => {
    const failure = new GatewayError(
      "quota_exceeded",
      429,
      JSON.stringify({
        code: "subscription:free-usage-exhausted",
        error: "You've used all the included free usage for model grok-4.7 for now. Usage resets over a rolling 24-hour window — tokens (actual/limit): 699617/600000.",
      }),
      { providerId: "grok", providerCode: "subscription:free-usage-exhausted" },
      "upstream",
    );
    const classification = classifyAccountError(failure, {
      origin: "upstream",
      scope: "account",
      providerId: "grok",
      providerCode: "subscription:free-usage-exhausted",
      statusCode: 429,
      credentialEvidence: true,
      modelId: "grok-4.7",
    });

    expect(classification.category).toBe("quota_exhausted");
    expect(classification.modelScoped).toBe(true);
    expect(classification.cooldownMs).toBe(24 * 60 * 60 * 1000);
  });

  test("parks any other failed feature probe for the same quota window", () => {
    const failure = grok407ProbeFailure({
      providerId: "grok",
      prompt: GROK_407_PROBE_PROMPT,
      events: [],
      dispatchError: new Error("upstream disconnected"),
    });

    if (failure === undefined) throw new Error("expected Grok feature failure");
    const policy = classifyUpstreamFailure(failure);
    const classification = classifyAccountError(failure, { ...policy, providerId: "grok" });
    expect(failure.code).toBe("quota_exceeded");
    expect(failure.details.providerCode).toBe("subscription:free-usage-exhausted");
    expect(classification.cooldownMs).toBe(24 * 60 * 60 * 1000);
  });

  test("uses a provider-stated reset duration instead of the fallback", () => {
    const prior = new GatewayError(
      "quota_exceeded",
      429,
      "quota will reset in 2 hours",
      {},
      "upstream",
    );
    const failure = grok407ProbeFailure({
      providerId: "grok",
      prompt: GROK_407_PROBE_PROMPT,
      events: [],
      dispatchError: prior,
    });

    if (failure === undefined) throw new Error("expected Grok feature failure");
    const policy = classifyUpstreamFailure(failure);
    const classification = classifyAccountError(failure, { ...policy, providerId: "grok" });
    expect(classification.cooldownMs).toBe(2 * 60 * 60 * 1000);
  });
});
