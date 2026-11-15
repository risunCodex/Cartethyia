/**
 * F-6 / F-11 / F-13 / F-16: the L1 ingress fields that used to get a
 * different verdict per surface — tool_choice cross-check, stop-sequence
 * bounds, reasoning strictness, and the shared service_tier rule.
 */
import { describe, expect, test } from "bun:test";
import { chatAdapter } from "../../../src/transport/surface/chat/adapter";
import { messagesAdapter } from "../../../src/transport/surface/messages/adapter";
import { responsesAdapter } from "../../../src/transport/surface/responses/adapter";

const chatBody = (patch: Record<string, unknown>): Record<string, unknown> => ({
  model: "m",
  messages: [{ role: "user", content: "hi" }],
  max_tokens: 16,
  ...patch,
});

const messagesBody = (patch: Record<string, unknown>): Record<string, unknown> => ({
  model: "m",
  max_tokens: 16,
  messages: [{ role: "user", content: "hi" }],
  ...patch,
});

describe("F-6: tool_choice is cross-checked against declared tools", () => {
  const tools = [{ name: "read_file", parameters: { type: "object", properties: {} } }];

  test("a named selection with no matching tool is a 400 naming the tool (chat)", () => {
    expect(() =>
      chatAdapter.parse(chatBody({ tools, tool_choice: { type: "function", function: { name: "nope" } } })),
    ).toThrow('names tool "nope"');
  });

  test("a named selection with a matching tool parses", () => {
    const parsed = chatAdapter.parse(
      chatBody({ tools, tool_choice: { type: "function", function: { name: "read_file" } } }),
    );
    expect(parsed.tool_choice).toEqual({ type: "tool", name: "read_file" });
  });

  test("an empty tool_choice name is a 400 (chat)", () => {
    expect(() =>
      chatAdapter.parse(chatBody({ tools, tool_choice: { type: "function", function: { name: "" } } })),
    ).toThrow("empty tool");
  });

  test("allowed_tools entries are checked and counted (responses)", () => {
    const body = (choice: unknown): Record<string, unknown> => ({
      model: "m",
      input: "hi",
      tools,
      tool_choice: choice,
    });
    expect(() =>
      responsesAdapter.parse(body({ type: "allowed_tools", mode: "auto", tools: [{ type: "function", function: { name: "ghost" } }] })),
    ).toThrow('names tool "ghost"');
    const tooMany = {
      type: "allowed_tools",
      mode: "auto",
      tools: Array.from({ length: 33 }, (_, index) => ({
        type: "function",
        function: { name: `t${index}` },
      })),
    };
    expect(() => responsesAdapter.parse(body(tooMany))).toThrow("at most 32");
  });

  test("named tool_choice on messages is checked too", () => {
    expect(() =>
      messagesAdapter.parse(messagesBody({ tools, tool_choice: { type: "tool", name: "ghost" } })),
    ).toThrow('names tool "ghost"');
    const parsed = messagesAdapter.parse(
      messagesBody({ tools, tool_choice: { type: "tool", name: "read_file" } }),
    );
    expect(parsed.tool_choice).toEqual({ type: "tool", name: "read_file" });
  });
});

describe("F-11: stop sequences share one verdict", () => {
  test("chat: more than 4 sequences is a 400", () => {
    expect(() => chatAdapter.parse(chatBody({ stop: ["a", "b", "c", "d", "e"] }))).toThrow(
      "at most 4",
    );
  });

  test("chat: an over-long entry is a 400", () => {
    expect(() => chatAdapter.parse(chatBody({ stop: ["x".repeat(65)] }))).toThrow(
      "1..64 characters",
    );
  });

  test("chat: a valid string stop still parses", () => {
    expect(chatAdapter.parse(chatBody({ stop: "END" })).generation_controls.stop).toBe("END");
  });

  test("messages: non-string entries are a 400, not forwarded", () => {
    expect(() => messagesAdapter.parse(messagesBody({ stop_sequences: ["ok", 42] }))).toThrow(
      "must be strings",
    );
  });

  test("messages: a valid list parses", () => {
    const parsed = messagesAdapter.parse(messagesBody({ stop_sequences: ["a", "b"] }));
    expect(parsed.generation_controls.stop).toEqual(["a", "b"]);
  });

  test("responses: stop is carried instead of silently dropped", () => {
    const parsed = responsesAdapter.parse({ model: "m", input: "hi", stop: ["END", "STOP"] });
    expect(parsed.generation_controls.stop).toEqual(["END", "STOP"]);
    expect(() =>
      responsesAdapter.parse({ model: "m", input: "hi", stop: ["a", "b", "c", "d", "e"] }),
    ).toThrow("at most 4");
  });
});

describe("F-13: reasoning strictness", () => {
  test("an unknown effort is a 400 naming the value (responses)", () => {
    expect(() =>
      responsesAdapter.parse({ model: "m", input: "hi", reasoning: { effort: "maximum" } }),
    ).toThrow('reasoning effort "maximum" is not one of');
  });

  test("an unknown effort is a 400 naming the value (chat)", () => {
    expect(() => chatAdapter.parse(chatBody({ reasoning_effort: "maximum" }))).toThrow(
      'reasoning effort "maximum"',
    );
  });

  test("a sub-floor budget_tokens is a 400 (responses)", () => {
    expect(() =>
      responsesAdapter.parse({ model: "m", input: "hi", reasoning: { budget_tokens: -5 } }),
    ).toThrow("at least 1024");
  });

  test("canonical efforts still parse on every spelling", () => {
    expect(
      responsesAdapter.parse({ model: "m", input: "hi", reasoning: { effort: "high" } }).reasoning,
    ).toEqual({ effort: "high" });
    expect(chatAdapter.parse(chatBody({ reasoning_effort: "xhigh" })).reasoning).toEqual({
      effort: "xhigh",
    });
  });
});

describe("F-16: one service_tier rule", () => {
  test("a known tier lands in the canonical slot on every surface", () => {
    expect(chatAdapter.parse(chatBody({ service_tier: "flex" })).generation_controls.service_tier).toBe("flex");
    expect(
      responsesAdapter.parse({ model: "m", input: "hi", service_tier: "priority" }).generation_controls
        .service_tier,
    ).toBe("priority");
  });

  test("an unknown tier is forwarded verbatim as an extension everywhere", () => {
    // Chat forwarded it, Responses dropped it silently, Messages restricted
    // it — one rule now: forward, and let the route's projection decide.
    expect(
      chatAdapter.parse(chatBody({ service_tier: "custom_tier" })).generation_controls[
        "extension:service_tier"
      ],
    ).toBe("custom_tier");
    expect(
      responsesAdapter.parse({ model: "m", input: "hi", service_tier: "custom_tier" })
        .generation_controls["extension:service_tier"],
    ).toBe("custom_tier");
    expect(
      messagesAdapter.parse(messagesBody({ service_tier: "standard_only" })).generation_controls[
        "extension:service_tier"
      ],
    ).toBe("standard_only");
  });
});
