/**
 * Kiro EventStream decoder — event types observed live on the wire
 * (captured 2026-11-02 via mitmproxy against the CLI 2.37.0 and IDE
 * 1.4.62 generation surfaces).
 *
 * Shapes under test come from real captures:
 *   - `assistantResponseEvent` → `{"content":"…","modelId":"auto"}`
 *   - `metadataEvent` → `{"stopReason":"END_TURN"}`
 *   - `contextUsageEvent` → `{"contextUsagePercentage":1.9624000787734985}`
 *   - `meteringEvent` → `{"unit":"credit","unitPlural":"credits","usage":0.21915093067993363}`
 *   - `reasoningContentEvent` → `{"redactedContent":"…"}` (encrypted envelope)
 *   - `initial-response` → `{"conversationId":""}`
 */
import { describe, expect, test } from "bun:test";
import { KiroStreamDecoder } from "../../src/providers/integrations/kiro/kiro-stream";
import type { KiroRawEvent } from "../../src/providers/integrations/kiro/kiro-stream";

function event(eventType: string, payload: string): KiroRawEvent {
  return { headers: { ":message-type": "event", ":event-type": eventType }, payload };
}

describe("KiroStreamDecoder", () => {
  test("assistantResponseEvent becomes a text delta", () => {
    const decoder = new KiroStreamDecoder();
    const outcome = decoder.decode(event("assistantResponseEvent", JSON.stringify({ content: "pong", modelId: "auto" })));
    expect(outcome.deltas).toEqual([{ kind: "text", text: "pong" }]);
  });

  test("metadataEvent END_TURN maps to canonical stop", () => {
    const decoder = new KiroStreamDecoder();
    const outcome = decoder.decode(event("metadataEvent", JSON.stringify({ stopReason: "END_TURN" })));
    expect(outcome.deltas).toEqual([]);
    expect(outcome.stopReason).toBe("stop");
    expect(outcome.providerStopReason).toBe("END_TURN");
  });

  test("contextUsageEvent reports the window percentage", () => {
    const decoder = new KiroStreamDecoder();
    const outcome = decoder.decode(
      event("contextUsageEvent", JSON.stringify({ contextUsagePercentage: 1.9624000787734985 })),
    );
    expect(outcome.deltas).toEqual([
      { kind: "usage", usage: { contextUsagePercentage: 1.9624000787734985 } },
    ]);
  });

  test("meteringEvent reports billed credits", () => {
    const decoder = new KiroStreamDecoder();
    const outcome = decoder.decode(
      event("meteringEvent", JSON.stringify({ unit: "credit", unitPlural: "credits", usage: 0.21915093067993363 })),
    );
    expect(outcome.deltas).toEqual([{ kind: "usage", usage: { credits: 0.21915093067993363 } }]);
  });

  test("reasoningContentEvent with redactedContent never surfaces text", () => {
    const decoder = new KiroStreamDecoder();
    // Envelope as captured: `.KTR~~<base64url-JSON>` after base64.
    const envelope = ".KTR~~eyJlbmNyeXB0aW9uUmVnaW9uIjpudWxsLCJtaW50ZWRBdE1zIjoxNzkzNTgwMzY0OTA1LCJtb2RlbEhhc2giOiJ5RUxWOXhiY2Z3dlUiLCJzbG90cyI6W10sInYiOjF9";
    const outcome = decoder.decode(event("reasoningContentEvent", JSON.stringify({ redactedContent: envelope })));
    expect(outcome.deltas).toEqual([]);
    expect(outcome.failure).toBeUndefined();
  });

  test("reasoningContentEvent with plain text still yields reasoning", () => {
    const decoder = new KiroStreamDecoder();
    const outcome = decoder.decode(event("reasoningContentEvent", JSON.stringify({ text: "thinking…" })));
    expect(outcome.deltas).toEqual([{ kind: "reasoning", text: "thinking…" }]);
  });

  test("initial-response emits nothing", () => {
    const decoder = new KiroStreamDecoder();
    const outcome = decoder.decode(event("initial-response", JSON.stringify({ conversationId: "" })));
    expect(outcome.deltas).toEqual([]);
  });

  test("event error payload surfaces a failure", () => {
    const decoder = new KiroStreamDecoder();
    const outcome = decoder.decode(
      { headers: { ":message-type": "error" }, payload: JSON.stringify({ message: "boom" }) },
    );
    expect(outcome.failure?.message).toBe("boom");
  });

  test("unknown event types are ignored, not fatal", () => {
    const decoder = new KiroStreamDecoder();
    const outcome = decoder.decode(event("brandNewEvent", JSON.stringify({ whatever: 1 })));
    expect(outcome.deltas).toEqual([]);
    expect(outcome.failure).toBeUndefined();
  });

  test("<thinking> marker text is split into reasoning", () => {
    const decoder = new KiroStreamDecoder();
    // Reasoning inside an open `<thinking>` block is emitted eagerly; only a
    // split marker is held back.
    const first = decoder.decode(event("assistantResponseEvent", JSON.stringify({ content: "<thinking>hmm" })));
    expect(first.deltas).toEqual([{ kind: "reasoning", text: "hmm" }]);
    const second = decoder.decode(event("assistantResponseEvent", JSON.stringify({ content: "</thinking>answer" })));
    expect(second.deltas).toEqual([{ kind: "text", text: "answer" }]);
  });

  test("a marker split across events is buffered, not leaked", () => {
    const decoder = new KiroStreamDecoder();
    // `<think` ends one event; `ing>…` continues the next.
    const first = decoder.decode(event("assistantResponseEvent", JSON.stringify({ content: "prefix <think" })));
    expect(first.deltas).toEqual([{ kind: "text", text: "prefix " }]);
    const second = decoder.decode(event("assistantResponseEvent", JSON.stringify({ content: "ing>hmm</thinking>done" })));
    expect(second.deltas).toEqual([
      { kind: "reasoning", text: "hmm" },
      { kind: "text", text: "done" },
    ]);
  });
});
