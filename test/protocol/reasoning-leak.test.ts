/**
 * Reasoning leaking into the answer, or emitted twice.
 *
 * Four independent defects put reasoning text where a client reads it as the
 * answer, or showed the same thought twice on one surface:
 *
 * 1. Two readers of a reasoning part disagreed on field precedence, so the same
 *    part rendered different text per surface.
 * 2. Messages wrote the same string into `payload` *and* `summary`, and the
 *    Responses encoder then emitted it once per channel.
 * 3. Codex forwarded any unrecognized frame's `delta` as answer text, so a
 *    reasoning frame that fell through its chain leaked into the answer.
 * 4. Chat stripped `<think>` tags from `reasoning_content` with a *stateless*
 *    helper, so a tag split across two deltas leaked its literal bytes.
 *
 * Every fixture here is synthesized; no provider, database, or Redis is used.
 */
import { describe, expect, test } from "bun:test";
import type { CanonicalEvent, CanonicalRequest, ContentPart } from "../../src/protocol/canonical-model";
import { reasoningTextForReplay, reasoningTextOf } from "../../src/protocol/reasoning-text";
import { StreamEventPipeline } from "../../src/transport/dispatch/streaming/encoder";
import { CodexStreamFrameProcessor } from "../../src/protocol/response/codex";
import {
  decodeChatSseStream,
  parseChatResponseToEvents,
} from "../../src/protocol/response/chat";
import { parseClaudeContent } from "../../src/protocol/response/messages";
import { blockFromPart } from "../../src/transport/surface/messages/encode";

const THINKING = "I should check the cache before the database.";

/** Narrows a parsed part to the reasoning shape, failing loudly otherwise. */
function reasoningPart(part: ContentPart): Extract<ContentPart, { kind: "reasoning" }> {
  if (part.kind !== "reasoning") throw new Error(`expected a reasoning part, got ${part.kind}`);
  return part;
}

/** Narrows the content of a reasoning delta event. */
function reasoningPartOf(event: CanonicalEvent): Extract<ContentPart, { kind: "reasoning" }> {
  if (event.type !== "content_delta") throw new Error("expected a content delta");
  return reasoningPart(event.content);
}

describe("reasoningTextOf", () => {
  test("reads payload ahead of summary", () => {
    const part: ContentPart = { kind: "reasoning", payload: "stream", summary: "digest" };
    expect(reasoningTextOf(part)).toBe("stream");
  });

  test("falls back to summary when payload carries no text", () => {
    const part: ContentPart = { kind: "reasoning", payload: null, summary: "digest" };
    expect(reasoningTextOf(part)).toBe("digest");
  });

  test("returns nothing for an opaque part", () => {
    const part: ContentPart = { kind: "reasoning", payload: "secret", opaque: true };
    expect(reasoningTextOf(part)).toBeUndefined();
  });

  test("returns nothing when both fields are empty", () => {
    expect(reasoningTextOf({ payload: null, summary: "" })).toBeUndefined();
  });

  test("reads the payload once when both fields hold the same string", () => {
    // The double-write shape: one value, not two emissions.
    const part: ContentPart = { kind: "reasoning", payload: THINKING, summary: THINKING };
    expect(reasoningTextOf(part)).toBe(THINKING);
  });
});

describe("reasoningTextForReplay", () => {
  test("reads summary ahead of payload (replay precedence)", () => {
    const part: ContentPart = { kind: "reasoning", payload: "stream", summary: "digest" };
    expect(reasoningTextForReplay(part)).toBe("digest");
  });

  test("falls back to payload when summary is absent", () => {
    const stream: ContentPart = { kind: "reasoning", payload: "stream" };
    const digest: ContentPart = { kind: "reasoning", payload: null, summary: "digest" };
    expect(reasoningTextForReplay(stream)).toBe("stream");
    expect(reasoningTextForReplay(digest)).toBe("digest");
  });

  test("an empty-string summary wins over a non-empty payload", () => {
    const part: ContentPart = { kind: "reasoning", payload: "stream", summary: "" };
    expect(reasoningTextForReplay(part)).toBe("");
  });

  test("returns undefined when neither field is a string", () => {
    const blank: ContentPart = { kind: "reasoning", payload: null };
    const emptySummary: ContentPart = { kind: "reasoning", payload: null, summary: "" };
    expect(reasoningTextForReplay(blank)).toBeUndefined();
    expect(reasoningTextForReplay(emptySummary)).toBe("");
  });
});

describe("a canonical reasoning part reaches the client once", () => {
  const controller = {
    enqueue: () => {},
  } as unknown as ReadableStreamDefaultController<Uint8Array>;

  function pipeline(): StreamEventPipeline {
    return new StreamEventPipeline("responses", {}, false, { captureMode: "full" });
  }

  test("one part with payload and summary set emits one reasoning event", () => {
    const pipe = pipeline();
    pipe.enqueueEvent(
      {
        type: "content_delta",
        sequence_number: 1,
        content: { kind: "reasoning", payload: THINKING, summary: THINKING },
      } as CanonicalEvent,
      controller,
    );
    const events = pipe.telemetryEventTranscript;
    const list = Array.isArray(events) ? (events as CanonicalEvent[]) : [];
    const reasoning = list.filter(
      (event) => event.type === "content_delta" && event.content.kind === "reasoning",
    );
    // Before the fix this produced two: `reasoning_summary_text.delta` and
    // `reasoning_text.delta` for the same text.
    expect(reasoning).toHaveLength(1);
  });
});

describe("Codex untyped frames", () => {
  test("an unrecognized frame's delta is not answer text", () => {
    const decoder = new CodexStreamFrameProcessor(1);
    // A reasoning frame that falls through the decoder's chain: the catch-all
    // used to push it as `kind: "text"`.
    const events = decoder.process({ type: "reasoning.delta", delta: "leaked thought" });
    expect(events).toHaveLength(1);
    const first = events[0];
    if (first?.type !== "content_delta") throw new Error("expected a content delta");
    expect(first.content.kind).toBe("extension");
    expect(first.content.kind === "extension" ? first.content.name : "").toBe("codex:untyped_delta");
    expect(first.content.kind === "extension" ? first.content.payload : undefined).toBe(
      "leaked thought",
    );
  });

  test("the frame is preserved, not dropped", () => {
    // Dropping it would silently discard real content, so the payload survives
    // on the extension part where telemetry can see it.
    const decoder = new CodexStreamFrameProcessor(1);
    const events = decoder.process({ type: "custom.frame", delta: "payload text" });
    expect(JSON.stringify(events)).toContain("payload text");
  });
});

describe("Chat reasoning_content tag splitting", () => {
  function request(): CanonicalRequest {
    return {
      model: "hy4-preview-f",
      messages: [{ role: "user", content: [{ kind: "text", text: "hi" }] }],
      generation_controls: {},
      stream: true,
      source_surface: "chat",
    };
  }

  function sseStream(text: string): ReadableStream<Uint8Array> {
    const bytes = new TextEncoder().encode(text);
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
  }

  function frame(payload: unknown): string {
    return `data: ${typeof payload === "string" ? payload : JSON.stringify(payload)}\n\n`;
  }

  async function reasoningOf(frames: string): Promise<string> {
    const sse =
      frames +
      frame({ choices: [{ delta: {}, finish_reason: "stop" }] }) +
      "data: [DONE]\n\n";
    const chunks: string[] = [];
    for await (const event of decodeChatSseStream(sseStream(sse), request())) {
      if (event.type === "content_delta" && event.content.kind === "reasoning") {
        chunks.push(reasoningTextOf(event.content) ?? "");
      }
    }
    return chunks.join("");
  }

  test("a think tag split across two deltas leaves no tag bytes", () => {
    // The stateless strip emitted `"<thi"` verbatim on the first delta and only
    // removed `</think>` on the second.
    const first = frame({ choices: [{ delta: { reasoning_content: "<thi" } }] });
    const second = frame({ choices: [{ delta: { reasoning_content: "nk>real thought</think>" } }] });
    return reasoningOf(first + second).then((text) => {
      expect(text).toBe("real thought");
      expect(text).not.toContain("<thi");
      expect(text).not.toContain("<");
      expect(text).not.toContain(">");
    });
  });

  test("untagged reasoning_content streams through unchanged", () => {
    const payload = frame({ choices: [{ delta: { reasoning_content: "plain thought" } }] });
    return reasoningOf(payload).then((text) => {
      expect(text).toBe("plain thought");
    });
  });

  test("a settled non-stream reasoning_content is still stripped", () => {
    const events = parseChatResponseToEvents(
      {
        id: "r1",
        choices: [{ message: { role: "assistant", content: "answer", reasoning_content: "<think>x</think>y" } }],
      },
      request(),
    );
    const reasoning = events.filter(
      (event) => event.type === "content_delta" && event.content.kind === "reasoning",
    );
    expect(reasoning).toHaveLength(1);
    const first = reasoning[0];
    if (first?.type !== "content_delta") throw new Error("expected a reasoning delta");
    expect(reasoningTextOf(reasoningPartOf(first))).toBe("xy");
  });
});

describe("Messages thinking blocks", () => {
  test("a thinking block yields payload text and no duplicate summary", () => {
    const part = reasoningPart(
      parseClaudeContent({
        type: "thinking",
        thinking: THINKING,
        signature: "sig-1",
      }),
    );
    expect(part.payload).toBe(THINKING);
    // The double-write is gone: `summary` must not duplicate `payload`, or a
    // surface carrying both channels emits the text twice.
    expect(part.summary).toBeUndefined();
    expect(part.signature).toBe("sig-1");
    expect(reasoningTextOf(part)).toBe(THINKING);
  });

  test("the block still renders its thinking text", () => {
    const part = parseClaudeContent({ type: "thinking", thinking: THINKING });
    const block = blockFromPart(part);
    expect(block).toEqual({ type: "thinking", thinking: THINKING });
  });

  test("signature handling survives the change", () => {
    const part = parseClaudeContent({ type: "thinking", thinking: THINKING, signature: "abc" });
    const block = blockFromPart(part);
    expect(block).toEqual({ type: "thinking", thinking: THINKING, signature: "abc" });
  });

  test("redacted thinking stays opaque", () => {
    const value = { type: "redacted_thinking", data: "opaque" };
    const part = reasoningPart(parseClaudeContent(value));
    expect(part.opaque).toBe(true);
    expect(reasoningTextOf(part)).toBeUndefined();
    expect(blockFromPart(part)).toBe(value);
  });
});
