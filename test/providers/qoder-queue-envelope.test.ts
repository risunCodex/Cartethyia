/**
 * The Qoder queued envelope carries its priority class on the body
 * (`queueType`, `subCode`). Issue #158 (qoder2api-hub) showed a sustained
 * `p4` + `RESOURCE_LIMIT` pin across every account, realm, and model while
 * quota read healthy — an egress/machine risk signal, not a capacity queue.
 * The envelope error must surface those fields so telemetry can tell
 * "wait it out" from "your egress is flagged".
 */
import { describe, expect, test } from "bun:test";
import { qoderEnvelopeToFrames } from "../../src/providers/integrations/qoder/qoder-sse";

function queuedEnvelope(queueType: string, subCode: string): string {
  return JSON.stringify({
    headers: { "content-type": "application/json" },
    statusCodeValue: 403,
    body: JSON.stringify({
      code: 10605,
      isQueued: true,
      queueType,
      queueCount: 1,
      retryAfterSeconds: 60,
      serviceAvailable: true,
      subCode,
    }),
  });
}

function queuedError(envelope: string): unknown {
  try {
    for (const _ of qoderEnvelopeToFrames(envelope)) {
      // drain — the queued envelope throws
    }
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("Qoder queued envelope surfaces its queue shape", () => {
  test("a p4/RESOURCE_LIMIT pin is visible on the error detail", () => {
    const error = queuedError(queuedEnvelope("p4", "RESOURCE_LIMIT")) as Error & { code?: string };
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe("upstream_queued");
    expect(error.message).toContain("queueType=p4");
    expect(error.message).toContain("subCode=RESOURCE_LIMIT");
  });

  test("a plain capacity queue without shape fields still classifies as queued", () => {
    const error = queuedError(
      JSON.stringify({
        statusCodeValue: 403,
        body: JSON.stringify({ code: 10605, isQueued: true, retryAfterSeconds: 30 }),
      }),
    ) as Error & { code?: string };
    expect(error.code).toBe("upstream_queued");
    expect(error.message).not.toContain("queueType=");
    expect(error.message).not.toContain("subCode=");
  });

  test("a p3 capacity queue distinguishes itself from the p4 pin", () => {
    const error = queuedError(queuedEnvelope("p3", "RESOURCE_LIMIT")) as Error;
    expect(error.message).toContain("queueType=p3");
  });
});
