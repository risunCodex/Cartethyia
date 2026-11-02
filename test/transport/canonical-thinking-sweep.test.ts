/**
 * Canonical pipeline text forwarding.
 *
 * Thinking tags in a provider's answer text are a per-provider decoder concern
 * (MiMo Studio, CommandCode, the chat wire's own splitter), not a universal
 * one. When the pipeline split `<think>` spans for every surface, a literal
 * `<think>` in an answer — docs, a code sample, a model reciting the syntax —
 * was silently converted into reasoning: the answer vanished into the thinking
 * pane, and the poisoned history stopped follow-up turns.
 *
 * The pipeline now forwards text verbatim. The loop guard still watches the
 * full text stream, so a runaway is caught however it arrives.
 */
import { describe, expect, test } from "bun:test";
import type { CanonicalEvent } from "../../src/protocol/canonical-model";
import { StreamEventPipeline } from "../../src/transport/dispatch/streaming/encoder";

function pipeline(): StreamEventPipeline {
  return new StreamEventPipeline("responses", {}, false, { captureMode: "full" });
}

const controller = {
  enqueue: () => {},
} as unknown as ReadableStreamDefaultController<Uint8Array>;

function textDelta(text: string, sequenceNumber: number): CanonicalEvent {
  return {
    type: "content_delta",
    sequence_number: sequenceNumber,
    content: { kind: "text", text },
  };
}

function recorded(pipe: StreamEventPipeline): CanonicalEvent[] {
  const transcript = pipe.telemetryEventTranscript;
  return Array.isArray(transcript) ? (transcript as CanonicalEvent[]) : [];
}

function allTextOf(events: CanonicalEvent[]): string {
  return events
    .filter((event) => event.type === "content_delta" && event.content.kind === "text")
    .map((event) => (event.type === "content_delta" && event.content.kind === "text" ? event.content.text : ""))
    .join("");
}

function reasoningCount(events: CanonicalEvent[]): number {
  return events.filter(
    (event) => event.type === "content_delta" && event.content.kind === "reasoning",
  ).length;
}

describe("canonical text forwarding", () => {
  test("forwards an inline think span verbatim instead of converting it to reasoning", () => {
    const pipe = pipeline();
    pipe.enqueueEvent(textDelta("<think>secret plan</think>Hello", 1), controller);

    const events = recorded(pipe);
    expect(reasoningCount(events)).toBe(0);
    expect(allTextOf(events)).toBe("<think>secret plan</think>Hello");
  });

  test("keeps a stray closing tag in the answer", () => {
    const pipe = pipeline();
    pipe.enqueueEvent(textDelta("done</think>", 1), controller);

    expect(allTextOf(recorded(pipe))).toBe("done</think>");
  });

  test("a tag split across two chunks stays one text event", () => {
    const pipe = pipeline();
    pipe.enqueueEvent(textDelta("<thi", 1), controller);
    pipe.enqueueEvent(textDelta("nk>a</think>b", 2), controller);

    const events = recorded(pipe);
    expect(reasoningCount(events)).toBe(0);
    expect(allTextOf(events)).toBe("<think>a</think>b");
  });

  test("text still precedes the terminal", () => {
    const pipe = pipeline();
    pipe.enqueueEvent(textDelta("tail</thi", 1), controller);
    pipe.enqueueEvent(
      { type: "terminal", sequence_number: 2, state: "complete" } as CanonicalEvent,
      controller,
    );

    const events = recorded(pipe);
    expect(allTextOf(events)).toBe("tail</thi");
    expect(events.findIndex((event) => event.type === "terminal")).toBeGreaterThan(
      events.findIndex((event) => event.type === "content_delta"),
    );
  });

  test("a literal think tag inside a code fence survives in the answer", () => {
    const pipe = pipeline();
    const answer = "Use `<think>` inside a fence to enable reasoning.";
    pipe.enqueueEvent(textDelta(answer, 1), controller);

    const events = recorded(pipe);
    expect(allTextOf(events)).toBe(answer);
    expect(reasoningCount(events)).toBe(0);
  });
});
