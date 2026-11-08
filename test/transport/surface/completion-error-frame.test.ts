/**
 * Completion surface error-frame behavior for failed terminals.
 *
 * A terminal with `state: "failed"` is a real upstream failure — rate limit,
 * quota, upstream error. The stream must emit an error object carrying the
 * failure message instead of a completion with a null `finish_reason`, so the
 * client sees the reason rather than a silent empty completion. `stop_details`
 * carries the failure details when the adapter set them.
 */
import { describe, expect, test } from "bun:test";
import type { CanonicalEvent } from "../../../src/protocol/canonical-model";
import { CompletionStreamEncoder } from "../../../src/transport/surface/completion";

function terminal(overrides: Partial<CanonicalEvent & { stop_details?: Record<string, unknown> }> = {}): CanonicalEvent {
  return {
    type: "terminal",
    sequence_number: 2,
    state: "failed",
    stop_reason: "error",
    ...overrides,
  } as CanonicalEvent;
}

describe("CompletionStreamEncoder failed terminal", () => {
  test("emits an error object with the stop_details message, not a completion choice", () => {
    const encoder = new CompletionStreamEncoder({ model: "test-model" });
    const chunks = encoder.push(
      terminal({
        stop_details: {
          code: "quota_exceeded",
          status: 429,
          message: "you hit your usage limit",
        },
      }),
    );
    expect(chunks).toHaveLength(1);
    const frame = chunks[0] as Record<string, unknown>;
    expect(frame["choices"]).toBeUndefined();
    const error = frame["error"] as Record<string, unknown>;
    expect(error["type"]).toBe("server_error");
    expect(error["code"]).toBe("error");
    expect(error["status"]).toBe(429);
    expect(error["message"]).toBe("you hit your usage limit");
    expect(frame["object"]).toBe("text_completion");
    expect(frame["model"]).toBe("test-model");
  });

  test("falls back to a generic message when stop_details is absent", () => {
    const encoder = new CompletionStreamEncoder({ model: "test-model" });
    const chunks = encoder.push(terminal());
    const frame = chunks[0] as Record<string, unknown>;
    const error = frame["error"] as Record<string, unknown>;
    expect(error["message"]).toBe("The upstream response failed");
  });

  test("a length terminal still emits a normal completion", () => {
    const encoder = new CompletionStreamEncoder({ model: "test-model" });
    const chunks = encoder.push({ type: "terminal", sequence_number: 2, state: "complete", stop_reason: "length" } as CanonicalEvent);
    expect(chunks[0]?.["error"]).toBeUndefined();
    const choice = (chunks[0] as Record<string, unknown>)?.["choices"] as Array<Record<string, unknown>>;
    expect(choice?.[0]?.["finish_reason"]).toBe("length");
  });
});
