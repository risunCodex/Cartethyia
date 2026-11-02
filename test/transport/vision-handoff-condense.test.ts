/**
 * Unit tests for `condenseHandoffRequest`: the pass that trims a giant-session
 * history (hundreds of tool-result turns) before the handoff'd request goes to
 * the text-only main model, so the multi-megabyte bodies that upstreams reset
 * or reject do not make handoff fail on large sessions.
 */
import { describe, expect, test } from "bun:test";
import type { CanonicalRequest, ContentPart } from "../../src/protocol/canonical-model";
import { condenseHandoffRequest } from "../../src/transport/request/preparer";

function text(textValue: string): ContentPart[] {
  return [{ kind: "text", text: textValue }];
}

function toolTurns(count: number): Array<{ role: "user" | "assistant" | "tool"; content: ContentPart[] }> {
  const turns: Array<{ role: "user" | "assistant" | "tool"; content: ContentPart[] }> = [];
  for (let i = 0; i < count; i += 1) {
    turns.push({ role: "assistant", content: [{ kind: "toolCall", call_id: `c${i}`, name: "read_file", arguments: { path: `/x/${i}` } }] });
    turns.push({ role: "tool", content: [{ kind: "toolResult", call_id: `c${i}`, content: `file contents ${"x".repeat(2000)} ${i}` }] });
  }
  return turns;
}

function makeRequest(historyTurns: Array<{ role: "user" | "assistant" | "tool"; content: ContentPart[] }>, active: ContentPart[]): CanonicalRequest {
  return {
    model: "inception/mercury-3",
    messages: [
      { role: "system", content: text("You are an AI agent.") },
      ...historyTurns,
      { role: "user", content: active },
    ],
    stream: false,
    source_surface: "chat",
    generation_controls: {},
  } as CanonicalRequest;
}

describe("condenseHandoffRequest", () => {
  test("small requests pass through untouched", () => {
    const req = makeRequest(
      [
        { role: "user", content: text("hi") },
        { role: "assistant", content: text("hello") },
      ],
      [
        { kind: "text", text: "what is in this image?" },
        { kind: "image", payload: "data:image/png;base64,AAAA" },
      ],
    );
    expect(condenseHandoffRequest(req)).toBe(req);
  });

  test("giant tool-transcript history is dropped; only system + active turn remain", () => {
    const req = makeRequest(toolTurns(120), [
      { kind: "text", text: "what is in this image?" },
      { kind: "image", payload: "data:image/png;base64,AAAA" },
    ]);
    const condensed = condenseHandoffRequest(req);
    // System prompt kept, then the active turn only.
    expect(condensed.messages[0]!.role).toBe("system");
    expect(condensed.messages).toHaveLength(2);
    const last = condensed.messages[1]!;
    expect(last.role).toBe("user");
    expect(last.content.some((part) => part.kind === "image")).toBe(true);
    // No tool call/result turns survive.
    for (const message of condensed.messages) {
      expect(message.content.some((part) => part.kind === "toolCall" || part.kind === "toolResult")).toBe(false);
    }
  });

  test("a moderate text-only session stays intact (under thresholds)", () => {
    const history: Array<{ role: "user" | "assistant" | "tool"; content: ContentPart[] }> = [];
    for (let i = 0; i < 40; i += 1) {
      history.push({ role: "user", content: text(`question ${i}`) });
      history.push({ role: "assistant", content: text(`answer ${i}`) });
    }
    const req = makeRequest(history, [
      { kind: "text", text: "what is in this image?" },
      { kind: "image", payload: "data:image/png;base64,AAAA" },
    ]);
    const condensed = condenseHandoffRequest(req);
    // Same active turn, medium history kept (no tool transcript to strip).
    expect(condensed.messages[condensed.messages.length - 1]!.role).toBe("user");
    expect(condensed.messages.length).toBeGreaterThan(40);
  });
});
