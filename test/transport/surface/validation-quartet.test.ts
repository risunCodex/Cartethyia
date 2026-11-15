/**
 * F-7 / F-8 / F-12 / F-14: the validation quartet — schema-root verdicts, the
 * Responses flat-tool fallback, response_format bounds, and the shared
 * content-part policy.
 */
import { describe, expect, test } from "bun:test";
import { chatAdapter } from "../../../src/transport/surface/chat/adapter";
import { messagesAdapter } from "../../../src/transport/surface/messages/adapter";
import { responsesAdapter } from "../../../src/transport/surface/responses/adapter";
import { parseResponseFormat } from "../../../src/transport/surface/dialects";

const chatBody = (patch: Record<string, unknown>): Record<string, unknown> => ({
  model: "m",
  messages: [{ role: "user", content: "hi" }],
  max_tokens: 16,
  ...patch,
});

describe("F-7: non-record schema roots are refused, not coerced", () => {
  test("a JSON-Schema boolean root is a 400 naming the tool", () => {
    expect(() => chatAdapter.parse(chatBody({ tools: [{ name: "f", parameters: true }] }))).toThrow(
      'tool "f" schema must be a JSON object',
    );
  });

  test("an array or number root is a 400", () => {
    expect(() => chatAdapter.parse(chatBody({ tools: [{ name: "f", parameters: [1] }] }))).toThrow(
      "must be a JSON object",
    );
    expect(() => chatAdapter.parse(chatBody({ tools: [{ name: "f", parameters: 7 }] }))).toThrow(
      "must be a JSON object",
    );
  });

  test("a custom-grammar string root still parses (Chat custom.format)", () => {
    const parsed = chatAdapter.parse(
      chatBody({ tools: [{ type: "custom", custom: { name: "f", format: "^a+b$" } }] }),
    );
    expect(parsed.tools?.[0]?.tool_type).toBe("custom");
  });
});

describe("F-8: a Responses flat function tool with no schema key is malformed", () => {
  test("ships a 400 instead of the whole tool object as the schema", () => {
    expect(() =>
      responsesAdapter.parse({
        model: "m",
        input: "hi",
        tools: [{ type: "function", name: "f", description: "d" }],
      }),
    ).toThrow("requires parameters, input_schema, or a function envelope");
  });

  test("a hosted declaration without a schema key is still a real tool", () => {
    const parsed = responsesAdapter.parse({
      model: "m",
      input: "hi",
      tools: [{ type: "web_search" }],
    });
    expect(parsed.tools?.[0]?.name).toBe("web_search");
  });
});

describe("F-12: response_format bounds", () => {
  test("an unknown type is a 400 naming the value", () => {
    expect(() => parseResponseFormat({ type: "json_strict" })).toThrow("json_strict");
  });

  test("the plain-text format parses to no intent", () => {
    expect(parseResponseFormat({ type: "text" })).toBeUndefined();
  });

  test("json_schema requires a record schema", () => {
    expect(() => parseResponseFormat({ type: "json_schema", json_schema: {} })).toThrow(
      "requires a schema object",
    );
  });

  test("an empty or over-long name is a 400", () => {
    expect(() =>
      parseResponseFormat({ type: "json_schema", json_schema: { name: "", schema: { type: "object" } } }),
    ).toThrow("must not be empty");
    expect(() =>
      parseResponseFormat({
        type: "json_schema",
        json_schema: { name: "x".repeat(65), schema: { type: "object" } },
      }),
    ).toThrow("at most 64");
  });

  test("schema bounds apply (F-1 table reused)", () => {
    let schema: unknown = { type: "object", properties: {} };
    for (let depth = 0; depth < 30; depth += 1)
      schema = { type: "object", properties: { nested: schema } };
    expect(() =>
      parseResponseFormat({ type: "json_schema", json_schema: { name: "ok", schema } }),
    ).toThrow("nested deeper than 24");
  });

  test("a well-formed json_schema parses on both spellings", () => {
    const viaWrapper = parseResponseFormat({
      type: "json_schema",
      json_schema: { name: "out", strict: true, schema: { type: "object", properties: {} } },
    });
    expect(viaWrapper).toMatchObject({ type: "json_schema", name: "out", strict: true });
  });
});

describe("F-14: media parts carry a real reference", () => {
  test("chat: an image part with no url is a 400", () => {
    expect(() =>
      chatAdapter.parse({
        model: "m",
        messages: [{ role: "user", content: [{ type: "image_url" }] }],
      }),
    ).toThrow("image content part requires");
  });

  test("chat: an audio part with no data is a 400", () => {
    expect(() =>
      chatAdapter.parse({
        model: "m",
        messages: [{ role: "user", content: [{ type: "input_audio", input_audio: { format: "wav" } }] }],
      }),
    ).toThrow("audio content part requires");
  });

  test("chat: a file part with neither data, file_id, nor url is a 400", () => {
    expect(() =>
      chatAdapter.parse({
        model: "m",
        messages: [{ role: "user", content: [{ type: "file", file: { filename: "x.pdf" } }] }],
      }),
    ).toThrow("file content part requires");
  });

  test("messages: an image block without a source payload is a 400", () => {
    expect(() =>
      messagesAdapter.parse({
        model: "m",
        max_tokens: 16,
        messages: [{ role: "user", content: [{ type: "image" }] }],
      }),
    ).toThrow("image content part requires");
  });

  test("responses: unknown part types are quarantined as named extensions, not dropped", () => {
    // The documented policy: Chat rejects unknown types; Responses and
    // Messages quarantine them under their owning surface's prefix so no
    // data is lost mid-conversation.
    const parsed = responsesAdapter.parse({
      model: "m",
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "container_upload", upload: "x" }],
        },
      ],
    });
    const part = parsed.messages[0]?.content[0];
    expect(part).toMatchObject({ kind: "extension", name: "responses.content.container_upload" });
  });
});
