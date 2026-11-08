/**
 * Chat surface error-frame behavior for failed terminals.
 *
 * A terminal with `state: "failed"` is a real upstream failure — rate limit,
 * quota, upstream error. The stream must emit an error object carrying the
 * failure message instead of a `finish_reason: "error"` chunk, so the client
 * sees the reason rather than a bare word. `stop_details` carries the failure
 * details when the adapter set them (Cursor sets code/status/message).
 */
import { describe, expect, test } from "bun:test";
import type { CanonicalEvent } from "../../src/protocol/canonical-model";
import {
  ChatStreamEncoder,
  jsonCompletion,
} from "../../src/transport/surface/chat/encode";

function terminal(overrides: Partial<CanonicalEvent & { stop_details?: Record<string, unknown> }> = {}): CanonicalEvent {
  return {
    type: "terminal",
    sequence_number: 2,
    state: "failed",
    stop_reason: "error",
    ...overrides,
  } as CanonicalEvent;
}

describe("ChatStreamEncoder failed terminal", () => {
  test("emits an error frame with the stop_details message, not finish_reason", () => {
    const encoder = new ChatStreamEncoder({}, "test-model", "chatcmpl-test");
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
  });

  test("falls back to a generic message when stop_details is absent", () => {
    const encoder = new ChatStreamEncoder({}, "test-model", "chatcmpl-test");
    const chunks = encoder.push(terminal());
    const frame = chunks[0] as Record<string, unknown>;
    const error = frame["error"] as Record<string, unknown>;
    expect(error["message"]).toBe("The upstream response failed");
  });

  test("an aborted terminal still emits finish_reason, not an error frame", () => {
    const encoder = new ChatStreamEncoder({}, "test-model", "chatcmpl-test");
    const chunks = encoder.push({ type: "terminal", sequence_number: 2, state: "aborted" } as CanonicalEvent);
    expect(chunks[0]?.["error"]).toBeUndefined();
    expect((chunks[0] as Record<string, unknown>)?.["choices"]).toBeDefined();
  });
});

describe("jsonCompletion failed terminal", () => {
  test("carries the stop_details message in the error object", () => {
    const events: CanonicalEvent[] = [
      { type: "response_start", sequence_number: 1, model: "test-model" },
      terminal({
        stop_details: {
          code: "quota_exceeded",
          status: 429,
          message: "you hit your usage limit",
        },
      }),
    ];
    const out = jsonCompletion(events, {}, "test-model", "chatcmpl-test", 1000);
    expect(out["error"]).toEqual({
      type: "server_error",
      code: "error",
      status: 429,
      message: "you hit your usage limit",
    });
    expect(out["choices"]).toBeUndefined();
  });

  test("falls back to a generic message when stop_details is absent", () => {
    const events: CanonicalEvent[] = [
      { type: "response_start", sequence_number: 1, model: "test-model" },
      terminal(),
    ];
    const out = jsonCompletion(events, {}, "test-model", "chatcmpl-test", 1000);
    expect((out["error"] as Record<string, unknown>)["message"]).toBe(
      "The upstream response failed",
    );
  });
});
