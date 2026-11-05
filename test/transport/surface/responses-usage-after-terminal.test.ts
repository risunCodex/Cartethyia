/**
 * Regression: a `usage` canonical event arriving AFTER the terminal must not
 * fail a completed Responses stream.
 *
 * Several upstreams (Qoder gRPC among them) stream the usage chunk after the
 * finish-reason chunk. The Responses encoder previously threw
 * `ResponsesLifecycleError("Canonical event arrived after terminal Responses event")`
 * for it — which the stream finalizer recorded as `failed / invalid_lifecycle`
 * while the client had already received a complete `response.completed`, so a
 * healthy response was reported as a 500. `usage` after terminal is now
 * accepted (it updates the recorded usage) and any other post-terminal event is
 * still rejected.
 */
import { expect, test } from "bun:test";
import { ResponsesEventEncoder, encodeResponsesWireEvents } from "../../../src/transport/surface/responses/encode";
import type { CanonicalEvent } from "../../../src/protocol/canonical-model";

const USAGE = {
  input_tokens: 100,
  output_tokens: 20,
  total_tokens: 120,
  cached_input_tokens: 80,
  uncached_input_tokens: 20,
  cache_write_tokens: "unavailable" as const,
  reasoning_tokens: "unavailable" as const,
  estimated_cost: null,
};

const events = (): CanonicalEvent[] => [
  { type: "response_start", sequence_number: 1, model: "m" },
  { type: "content_delta", sequence_number: 2, content: { kind: "text", text: "hi" } },
  { type: "terminal", sequence_number: 3, state: "complete", stop_reason: "stop" },
  { type: "usage", sequence_number: 4, usage: USAGE },
];

test("usage after terminal is accepted and does not throw", () => {
  const encoder = new ResponsesEventEncoder({});
  for (const event of events()) encoder.push(event);
  // No throw above is the assertion; finish must also complete cleanly.
  expect(() => encoder.finish()).not.toThrow();
});

test("usage after terminal keeps a complete, error-free wire stream", () => {
  const wireEvents = encodeResponsesWireEvents(events(), {});
  expect(wireEvents.some((e) => e.type === "response.completed")).toBe(true);
  expect(wireEvents.some((e) => e.type === "response.error")).toBe(false);
  expect(wireEvents.some((e) => e.type === "response.failed")).toBe(false);
});

test("non-usage events after terminal still throw invalid_lifecycle", () => {
  const encoder = new ResponsesEventEncoder({});
  encoder.push({ type: "response_start", sequence_number: 1, model: "m" });
  encoder.push({ type: "terminal", sequence_number: 2, state: "complete", stop_reason: "stop" });
  expect(() =>
    encoder.push({ type: "content_delta", sequence_number: 3, content: { kind: "text", text: "x" } }),
  ).toThrow(/after terminal/);
});
