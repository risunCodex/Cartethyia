/**
 * F-42: the non-image attachment ceiling (inline files, documents, audio) and
 * F-43: the env-gated tool-result truncation. Both exist because the clamp
 * policy used to be image-specific — a 40 MB base64 PDF or a 300 KiB
 * tool_result passed ingress and poisoned every retry and replay.
 */
import { describe, expect, test } from "bun:test";
import type { CanonicalRequest } from "../../../src/protocol/canonical-model";
import { chatAdapter } from "../../../src/transport/surface/chat/adapter";
import { messagesAdapter } from "../../../src/transport/surface/messages/adapter";
import {
  ATTACHMENT_CLAMP_MAX_BYTES,
  assertInlineAttachmentSize,
} from "../../../src/transport/surface/content-parts";
import {
  TOOL_RESULT_TRUNCATION_MARKER,
  truncateToolResults,
} from "../../../src/protocol/tool-result-truncate";

/** A base64 string whose decoded length is `bytes`. */
function base64OfDecodedBytes(bytes: number): string {
  // Each base64 char carries 6 bits; 4 chars decode to 3 bytes.
  return "A".repeat(Math.ceil((bytes / 3) * 4));
}

describe("F-42: the attachment clamp", () => {
  test("an oversized inline document is a deterministic 400 naming kind and size", () => {
    const oversized = base64OfDecodedBytes(ATTACHMENT_CLAMP_MAX_BYTES + 1024);
    expect(() => assertInlineAttachmentSize("inline file", oversized)).toThrow(
      /inline file attachment is \d+\.\d+ MB decoded/,
    );
  });

  test("a payload inside the ceiling passes", () => {
    expect(() =>
      assertInlineAttachmentSize("inline file", base64OfDecodedBytes(1024)),
    ).not.toThrow();
  });

  test("a file_id/url reference has no inline bytes and is never measured", () => {
    expect(() => assertInlineAttachmentSize("inline file", "file_abc123")).not.toThrow();
    expect(() => assertInlineAttachmentSize("inline file", undefined)).not.toThrow();
  });

  test("chat: an oversized inline file is refused at ingress", () => {
    const oversized = base64OfDecodedBytes(ATTACHMENT_CLAMP_MAX_BYTES + 4096);
    const body = {
      model: "m",
      messages: [
        {
          role: "user",
          content: [
            { type: "file", file: { file_data: oversized, filename: "big.pdf" } },
          ],
        },
      ],
    };
    expect(() => chatAdapter.parse(body)).toThrow("decoded");
  });

  test("chat: an oversized inline audio is refused at ingress", () => {
    const oversized = base64OfDecodedBytes(ATTACHMENT_CLAMP_MAX_BYTES + 4096);
    const body = {
      model: "m",
      messages: [
        {
          role: "user",
          content: [{ type: "input_audio", input_audio: { data: oversized, format: "wav" } }],
        },
      ],
    };
    expect(() => chatAdapter.parse(body)).toThrow("audio attachment");
  });

  test("messages: an oversized document source is refused at ingress", () => {
    const oversized = base64OfDecodedBytes(ATTACHMENT_CLAMP_MAX_BYTES + 4096);
    const body = {
      model: "m",
      max_tokens: 16,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "document",
              source: { type: "base64", media_type: "application/pdf", data: oversized },
            },
          ],
        },
      ],
    };
    expect(() => messagesAdapter.parse(body)).toThrow("decoded");
  });

  test("a realistic small attachment still parses on every surface", () => {
    const small = base64OfDecodedBytes(64 * 1024);
    const parsed = chatAdapter.parse({
      model: "m",
      messages: [
        { role: "user", content: [{ type: "file", file: { file_data: small, filename: "a.pdf" } }] },
      ],
    });
    expect(parsed.messages[0]?.content[0]?.kind).toBe("file");
  });
});

describe("F-43: the env-gated tool-result truncation", () => {
  function requestWithResult(text: string): CanonicalRequest {
    return {
      model: "m",
      messages: [
        { role: "user", content: [{ kind: "text", text: "run it" }] },
        {
          role: "assistant",
          content: [{ kind: "toolCall", call_id: "c1", name: "t", arguments: "{}" }],
        },
        { role: "tool", content: [{ kind: "toolResult", call_id: "c1", content: text }] },
      ],
      generation_controls: {},
      stream: false,
      source_surface: "chat",
    };
  }

  test("maxKb <= 0 is off and returns the same reference", () => {
    const request = requestWithResult("x".repeat(10_000));
    expect(truncateToolResults(request, 0)).toBe(request);
    expect(truncateToolResults(request, -5)).toBe(request);
  });

  test("an over-limit result is truncated with a visible marker", () => {
    const request = requestWithResult("x".repeat(3 * 1024));
    const truncated = truncateToolResults(request, 1);
    const result = truncated.messages[2]?.content[0];
    expect(result).toMatchObject({ kind: "toolResult" });
    if (result?.kind === "toolResult" && typeof result.content === "string") {
      expect(result.content.startsWith("x".repeat(1024))).toBe(true);
      expect(result.content.endsWith(TOOL_RESULT_TRUNCATION_MARKER)).toBe(true);
      expect(result.content.length).toBe(1024 + TOOL_RESULT_TRUNCATION_MARKER.length);
    } else {
      throw new Error("expected a string tool result");
    }
  });

  test("a result inside the limit is untouched and returns the same reference", () => {
    const request = requestWithResult("short");
    expect(truncateToolResults(request, 64)).toBe(request);
  });

  test("array-content results truncate their text parts only", () => {
    const request = requestWithResult("");
    const long = "y".repeat(4 * 1024);
    const withArray: CanonicalRequest = {
      ...request,
      messages: request.messages.map((message, index) =>
        index === 2
          ? {
              ...message,
              content: [
                { kind: "toolResult", call_id: "c1", content: [{ kind: "text", text: long }] },
              ],
            }
          : message,
      ),
    };
    const truncated = truncateToolResults(withArray, 1);
    const result = truncated.messages[2]?.content[0];
    if (result?.kind === "toolResult" && Array.isArray(result.content)) {
      const text = result.content[0];
      expect(text).toMatchObject({ kind: "text" });
      if (text.kind === "text") expect(text.text.endsWith(TOOL_RESULT_TRUNCATION_MARKER)).toBe(true);
    } else {
      throw new Error("expected an array tool result");
    }
  });
});
