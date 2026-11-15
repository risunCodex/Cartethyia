/**
 * F-3: the `tools[]` ingress verdict is per-dialect identical, and the
 * adapters carry the unified rules — a malformed tool is refused (never
 * silently dropped, which left the client believing the model could call a
 * tool that never reached the upstream), a non-array is a 400 everywhere,
 * and an empty array means "no tools" everywhere.
 */
import { describe, expect, test } from "bun:test";
import { chatAdapter } from "../../../src/transport/surface/chat/adapter";
import { messagesAdapter } from "../../../src/transport/surface/messages/adapter";
import { responsesAdapter } from "../../../src/transport/surface/responses/adapter";
import { parseToolsArray } from "../../../src/transport/surface/dialects";

const chatBody = (tools: unknown): Record<string, unknown> => ({
  model: "m",
  messages: [{ role: "user", content: "hi" }],
  max_tokens: 16,
  ...(tools === undefined ? {} : { tools }),
});

const messagesBody = (tools: unknown): Record<string, unknown> => ({
  model: "m",
  max_tokens: 16,
  messages: [{ role: "user", content: "hi" }],
  ...(tools === undefined ? {} : { tools }),
});

describe("parseToolsArray: one verdict per dialect", () => {
  test("a non-array is a 400 on every dialect", () => {
    for (const dialect of ["chat", "responses", "messages"] as const) {
      expect(() => parseToolsArray({ name: "f" }, dialect), dialect).toThrow("must be an array");
    }
  });

  test("an empty array normalizes to undefined on every dialect", () => {
    for (const dialect of ["chat", "responses", "messages"] as const) {
      expect(parseToolsArray([], dialect), dialect).toBeUndefined();
    }
  });

  test("a malformed entry is a 400 naming the dialect, on every dialect", () => {
    for (const dialect of ["chat", "responses", "messages"] as const) {
      expect(() => parseToolsArray([{ parameters: {} }], dialect), dialect).toThrow(
        "tool failed to parse",
      );
    }
  });

  test("a well-formed array parses on every dialect", () => {
    const tools = [{ name: "f", description: "d", parameters: { type: "object", properties: {} } }];
    for (const dialect of ["chat", "responses", "messages"] as const) {
      expect(parseToolsArray(tools, dialect)?.map((tool) => tool.name)).toEqual(["f"]);
    }
  });
});

describe("adapters carry the unified tools[] verdict", () => {
  test("chat: a malformed tool is refused, not dropped", () => {
    expect(() => chatAdapter.parse(chatBody([{ parameters: {} }]))).toThrow("tool failed to parse");
  });

  test("chat: tools: [] parses to no tools", () => {
    expect(chatAdapter.parse(chatBody([])).tools).toBeUndefined();
  });

  test("chat: a non-array tools is a 400", () => {
    expect(() => chatAdapter.parse(chatBody("read_files"))).toThrow("must be an array");
  });

  test("messages: unchanged labels for the same verdicts", () => {
    expect(() => messagesAdapter.parse(messagesBody("read_files"))).toThrow(
      "Messages tools must be an array",
    );
    expect(() => messagesAdapter.parse(messagesBody([{ parameters: {} }]))).toThrow(
      "Messages tool failed to parse",
    );
    expect(messagesAdapter.parse(messagesBody([])).tools).toBeUndefined();
  });

  test("responses: a malformed tool is refused, not filtered", () => {
    // A tool with no name and no type cannot parse; the old Responses path
    // filtered it away, so the client believed a tool was declared that the
    // upstream never saw.
    expect(() =>
      responsesAdapter.parse({
        model: "m",
        input: "hi",
        tools: [{ name: "ok", parameters: {} }, { description: "no name, no type" }],
      }),
    ).toThrow("tool failed to parse");
  });
});

describe("F-4: tool-call arguments normalize at every ingress", () => {
  test("chat: an unparseable arguments string is a 400, not forwarded", () => {
    const body = {
      model: "m",
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "not json{" } }],
        },
      ],
    };
    expect(() => chatAdapter.parse(body)).toThrow("must be valid JSON");
  });

  test("chat: object arguments are stringified once at ingress", () => {
    const body = {
      model: "m",
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: { a: 1 } } }],
        },
      ],
    };
    const parsed = chatAdapter.parse(body);
    const part = parsed.messages[1]?.content.find((p) => p.kind === "toolCall");
    expect(part).toMatchObject({ kind: "toolCall", arguments: '{"a":1}' });
  });

  test("chat: absent arguments stay a zero-arg call", () => {
    const body = {
      model: "m",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", tool_calls: [{ id: "c1", type: "function", function: { name: "f" } }] },
        { role: "tool", tool_call_id: "c1", content: "ok" },
      ],
    };
    const parsed = chatAdapter.parse(body);
    const part = parsed.messages[1]?.content.find((p) => p.kind === "toolCall");
    expect(part).toMatchObject({ kind: "toolCall", arguments: "{}" });
  });

  test("messages: a string input that cannot become an object is a 400", () => {
    const body = {
      model: "m",
      max_tokens: 16,
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "f", input: "not json{" }] },
      ],
    };
    expect(() => messagesAdapter.parse(body)).toThrow("must be valid JSON");
    // JSON that parses but is not an object is a type error, refused too.
    expect(() =>
      messagesAdapter.parse({
        model: "m",
        max_tokens: 16,
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "f", input: "42" }] },
        ],
      }),
    ).toThrow("must be a JSON object");
  });

  test("responses: arguments: 42 is a 400; an object stringifies", () => {
    const ok = {
      model: "m",
      input: [
        { type: "function_call", call_id: "c1", name: "f", arguments: { a: 1 } },
        { type: "function_call_output", call_id: "c1", output: "done" },
      ],
    };
    const request = responsesAdapter.parse(ok);
    const part = request.messages[0]?.content.find((p) => p.kind === "toolCall");
    expect(part).toMatchObject({ kind: "toolCall", arguments: '{"a":1}' });

    expect(() =>
      responsesAdapter.parse({
        model: "m",
        input: [{ type: "function_call", call_id: "c1", name: "f", arguments: 42 }],
      }),
    ).toThrow("must be a JSON object");
  });
});

describe("F-1: tool schema bounds at ingress", () => {
  test("a schema nested past 24 levels is a 400", () => {
    let schema: unknown = { type: "object", properties: {} };
    for (let depth = 0; depth < 30; depth += 1)
      schema = { type: "object", properties: { nested: schema } };
    const body = chatBody([{ name: "f", parameters: schema }]);
    expect(() => chatAdapter.parse(body)).toThrow("nested deeper than 24");
  });

  test("a schema serialized above 64 KiB is a 400", () => {
    const schema = {
      type: "object",
      properties: { blob: { type: "string", description: "x".repeat(70 * 1024) } },
    };
    expect(() => chatAdapter.parse(chatBody([{ name: "f", parameters: schema }]))).toThrow(
      "the limit is 65536",
    );
  });

  test("a schema array above 512 items is a 400", () => {
    const schema = {
      type: "array",
      items: Array.from({ length: 600 }, (_, index) => ({ type: "string", enum: [String(index)] })),
    };
    expect(() => chatAdapter.parse(chatBody([{ name: "f", parameters: schema }]))).toThrow(
      "the limit is 512",
    );
  });

  test("more than 256 tool declarations is a 400", () => {
    const tools = Array.from({ length: 257 }, (_, index) => ({
      name: `tool_${index}`,
      parameters: { type: "object", properties: {} },
    }));
    expect(() => chatAdapter.parse(chatBody(tools))).toThrow("the limit is 256");
  });

  test("a legitimate deep-enough schema still parses", () => {
    // Ten properties-nesting wrappers is ~21 JSON levels — inside the bound
    // the same way a real recursive schema is.
    let schema: unknown = { type: "string" };
    for (let depth = 0; depth < 10; depth += 1)
      schema = { type: "object", properties: { nested: schema } };
    const parsed = chatAdapter.parse(chatBody([{ name: "f", parameters: schema }]));
    expect(parsed.tools?.length).toBe(1);
  });
});

describe("F-2: tool names at ingress", () => {
  test("duplicate tool names are a 400 on every dialect", () => {
    const tools = [
      { name: "f", parameters: { type: "object", properties: {} } },
      { name: "f", parameters: { type: "object", properties: {} } },
    ];
    expect(() => chatAdapter.parse(chatBody(tools))).toThrow('declares "f" more than once');
    expect(() =>
      responsesAdapter.parse({ model: "m", input: "hi", tools }),
    ).toThrow('declares "f" more than once');
    expect(() => messagesAdapter.parse(messagesBody(tools))).toThrow(
      'declares "f" more than once',
    );
  });

  test("an empty-after-trim name is a 400, including through the function wrapper", () => {
    expect(() =>
      chatAdapter.parse(chatBody([{ function: { name: "  ", parameters: {} } }])),
    ).toThrow("must not be empty");
  });

  test("names outside the charset or length are a 400 naming the offender", () => {
    expect(() => chatAdapter.parse(chatBody([{ name: "my tool", parameters: {} }]))).toThrow(
      "my tool",
    );
    expect(() => chatAdapter.parse(chatBody([{ name: "a.b", parameters: {} }]))).toThrow("a.b");
    const long = "x".repeat(129);
    expect(() => chatAdapter.parse(chatBody([{ name: long, parameters: {} }]))).toThrow(
      "must match",
    );
  });

  test("charset-safe names of every realistic shape still parse", () => {
    const names = ["f", "_f", "f_1", "mcp__server__tool", "x".repeat(128)];
    for (const name of names) {
      const parsed = chatAdapter.parse(chatBody([{ name, parameters: {} }]));
      expect(parsed.tools?.[0]?.name, name).toBe(name);
    }
  });
});

describe("F-5: the pairing ledger runs on the Chat and Responses ingress", () => {
  test("chat: an orphan tool result is dropped at ingress", () => {
    const body = {
      model: "m",
      messages: [
        { role: "user", content: "hi" },
        { role: "tool", tool_call_id: "ghost", content: "stray" },
      ],
    };
    const parsed = chatAdapter.parse(body);
    expect(parsed.messages.some((message) => message.content.some((p) => p.kind === "toolResult"))).toBe(false);
  });

  test("chat: a duplicate result is dropped, first wins", () => {
    const body = {
      model: "m",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", tool_calls: [{ id: "c1", type: "function", function: { name: "f" } }] },
        { role: "tool", tool_call_id: "c1", content: "first" },
        { role: "tool", tool_call_id: "c1", content: "second" },
      ],
    };
    const parsed = chatAdapter.parse(body);
    const results = parsed.messages.flatMap((message) =>
      message.content.filter((p) => p.kind === "toolResult"),
    );
    expect(results.length).toBe(1);
  });

  test("chat: a tool turn without tool_call_id is a 400 on both spellings of the failure", () => {
    expect(() => chatAdapter.parse({ model: "m", messages: [{ role: "tool", content: "x" }] })).toThrow(
      "requires tool_call_id",
    );
  });

  test("responses: an orphan function_call_output is dropped at ingress", () => {
    const request = responsesAdapter.parse({
      model: "m",
      input: [
        { type: "message", role: "user", content: "hi" },
        { type: "function_call_output", call_id: "ghost", output: "stray" },
      ],
    });
    expect(request.messages.some((message) => message.content.some((p) => p.kind === "toolResult"))).toBe(false);
  });

  test("responses: a duplicate function_call_output is dropped, first wins", () => {
    const request = responsesAdapter.parse({
      model: "m",
      input: [
        { type: "function_call", call_id: "c1", name: "f", arguments: "{}" },
        { type: "function_call_output", call_id: "c1", output: "first" },
        { type: "function_call_output", call_id: "c1", output: "second" },
      ],
    });
    const results = request.messages.flatMap((message) =>
      message.content.filter((p) => p.kind === "toolResult"),
    );
    expect(results.length).toBe(1);
  });

  test("messages: strict mode is unchanged — an orphan result is a typed 400", () => {
    const body = {
      model: "m",
      max_tokens: 16,
      messages: [
        { role: "user", content: [{ type: "tool_result", tool_use_id: "ghost", content: "x" }] },
      ],
    };
    expect(() => messagesAdapter.parse(body)).toThrow("tool_result has no matching tool_use: ghost");
  });
});
