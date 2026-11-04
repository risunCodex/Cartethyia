import { describe, expect, test } from "bun:test";
import { computeProbeVerdict, qoderCmodelProbePrompt } from "../../src/providers/discovery/probe-phases";
import { GatewayError } from "../../src/protocol/gateway-error";

function gateway422(status: number, message: string): GatewayError {
  return new GatewayError("invalid_request", status, message, {}, "upstream");
}

describe("computeProbeVerdict throttling labels", () => {
  test("an upstream 429 that names a free-tier usage limit is labeled a rate limit", () => {
    const verdict = computeProbeVerdict({
      events: [],
      dispatchError: gateway422(
        429,
        "Free usage limit reached. Free models work in OpenCode (https://opencode.ai); subscribe to OpenCode Go to keep going: https://opencode.ai/go",
      ),
      wireFamily: "chat",
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.errorMessage).toContain("Upstream rate limit (HTTP 429)");
    expect(verdict.errorMessage).toContain("Free usage limit reached");
  });

  test("an ordinary upstream 502 keeps the generic failure labeling", () => {
    const verdict = computeProbeVerdict({
      events: [],
      dispatchError: gateway422(502, "all upstream attempts failed"),
      wireFamily: "chat",
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.errorMessage).not.toContain("Upstream rate limit");
    expect(verdict.errorMessage).toContain("upstream 502");
  });
});

describe("qoderCmodelProbePrompt", () => {
  test("cmodel with no explicit prompt gets the identity-asserting replacement", () => {
    expect(qoderCmodelProbePrompt("qoder", "cmodel", undefined)).toBe(
      "halo gpt",
    );
    expect(qoderCmodelProbePrompt("qoder", "cantus", undefined)).toBe(
      "halo gpt",
    );
  });

  test("an explicit prompt is never overridden", () => {
    expect(qoderCmodelProbePrompt("qoder", "cmodel", "Halo")).toBeUndefined();
    expect(qoderCmodelProbePrompt("qoder", "cantus", "Halo")).toBeUndefined();
  });

  test("other Qoder roster rows keep the identity prompt", () => {
    expect(qoderCmodelProbePrompt("qoder", "dmodel", undefined)).toBeUndefined();
    expect(qoderCmodelProbePrompt("qoder", "qmodel", undefined)).toBeUndefined();
    expect(qoderCmodelProbePrompt("qoder", "smodel", undefined)).toBeUndefined();
    expect(qoderCmodelProbePrompt("qoder", "lite", undefined)).toBeUndefined();
  });

  test("providers other than Qoder are untouched", () => {
    expect(qoderCmodelProbePrompt("anthropic", "cmodel", undefined)).toBeUndefined();
  });
});
