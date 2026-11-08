/**
 * Responses surface error-frame behavior for failed terminals.
 *
 * A terminal with `state: "failed"` is a real upstream failure — rate limit,
 * quota, upstream error. The encoder must emit `response.failed` carrying an
 * `error` object with the failure message (from `stop_details` when the
 * adapter set them) instead of a bare `response.incomplete`. An upstream
 * `error` event before an `aborted` terminal is likewise a failure, not an
 * incomplete response.
 */
import { describe, expect, test } from "bun:test";
import type { CanonicalEvent } from "../../../src/protocol/canonical-model";
import {
  ResponsesEventEncoder,
  encodeResponsesWireEvents,
} from "../../../src/transport/surface/responses/encode";

function terminal(overrides: Partial<CanonicalEvent & { stop_details?: Record<string, unknown> }> = {}): CanonicalEvent {
  return {
    type: "terminal",
    sequence_number: 2,
    state: "failed",
    stop_reason: "error",
    ...overrides,
  } as CanonicalEvent;
}

function responseEvent(overrides: Partial<CanonicalEvent> = {}): CanonicalEvent {
  return { type: "response_start", sequence_number: 1, model: "test-model", ...overrides } as CanonicalEvent;
}

describe("ResponsesEventEncoder failed terminal", () => {
  test("emits response.failed with the stop_details message", () => {
    const encoder = new ResponsesEventEncoder({});
    encoder.push(responseEvent());
    const wire = encoder.push(
      terminal({
        stop_details: {
          code: "quota_exceeded",
          status: 429,
          message: "you hit your usage limit",
        },
      }),
    );
    expect(wire).toHaveLength(1);
    const frame = wire[0] as Record<string, unknown>;
    expect(frame["type"]).toBe("response.failed");
    const response = frame["response"] as Record<string, unknown>;
    expect(response["status"]).toBe("failed");
    expect(response["error"]).toEqual({
      type: "server_error",
      code: "error",
      status: 429,
      message: "you hit your usage limit",
    });
  });

  test("falls back to a generic message when stop_details is absent", () => {
    const encoder = new ResponsesEventEncoder({});
    encoder.push(responseEvent());
    const wire = encoder.push(terminal());
    const frame = wire[0] as Record<string, unknown>;
    const response = frame["response"] as Record<string, unknown>;
    expect((response["error"] as Record<string, unknown>)["message"]).toBe(
      "The upstream response failed",
    );
  });

  test("an error event before an aborted terminal becomes failed, not incomplete", () => {
    const encoder = new ResponsesEventEncoder({});
    encoder.push(responseEvent());
    encoder.push({
      type: "error",
      sequence_number: 2,
      category: "upstream",
      message: "upstream exploded",
    } as CanonicalEvent);
    const wire = encoder.push({ type: "terminal", sequence_number: 3, state: "aborted" } as CanonicalEvent);
    expect(wire).toHaveLength(1);
    const frame = wire[0] as Record<string, unknown>;
    expect(frame["type"]).toBe("response.failed");
    const response = frame["response"] as Record<string, unknown>;
    expect(response["status"]).toBe("failed");
    expect((response["error"] as Record<string, unknown>)["message"]).toBe(
      "The upstream response failed",
    );
  });

  test("an aborted terminal without an error event stays incomplete", () => {
    const encoder = new ResponsesEventEncoder({});
    encoder.push(responseEvent());
    const wire = encoder.push({ type: "terminal", sequence_number: 2, state: "aborted", stop_reason: "length" } as CanonicalEvent);
    const frame = wire[0] as Record<string, unknown>;
    expect(frame["type"]).toBe("response.incomplete");
    const response = frame["response"] as Record<string, unknown>;
    expect(response["status"]).toBe("incomplete");
    expect(response["incomplete_details"]).toEqual({ reason: "max_output_tokens" });
    expect(response["error"]).toBeUndefined();
  });
});

describe("encodeResponsesWireEvents failed terminal", () => {
  test("failed terminal produces response.failed with error, no completed event", () => {
    const wire = encodeResponsesWireEvents([
      responseEvent(),
      terminal({
        stop_details: { code: "quota_exceeded", status: 429, message: "you hit your usage limit" },
      }),
    ]);
    expect(wire.some((e) => e.type === "response.failed")).toBe(true);
    expect(wire.some((e) => e.type === "response.completed")).toBe(false);
    expect(wire.some((e) => e.type === "response.incomplete")).toBe(false);
    const failed = wire.find((e) => e.type === "response.failed");
    const response = (failed as Record<string, unknown>)?.["response"] as Record<string, unknown>;
    expect(response["error"]).toEqual({
      type: "server_error",
      code: "error",
      status: 429,
      message: "you hit your usage limit",
    });
  });
});
