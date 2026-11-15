/**
 * F-23: withdrawn-tool re-declaration.
 *
 * A client that widens then narrows its tool set leaves history calling a
 * tool the current request no longer declares. The transcript replays that
 * call on every later turn, and strict wires reject the whole request (or
 * the model hallucinates against an undeclared name).
 */
import { describe, expect, test } from "bun:test";
import type { CanonicalRequest } from "../../../src/protocol/canonical-model";
import { redeclareWithdrawnTools } from "../../../src/protocol/request/sent-tools";
import { canonicalToChatPayload } from "../../../src/protocol/request/chat";
import { canonicalToClaudeMessagesPayload } from "../../../src/protocol/request/messages";

function requestWith(
  tools: CanonicalRequest["tools"],
  historyNames: string[],
): CanonicalRequest {
  return {
    model: "m",
    messages: [
      { role: "user", content: [{ kind: "text", text: "hi" }] },
      {
        role: "assistant",
        content: historyNames.map((name) => ({
          kind: "toolCall" as const,
          call_id: `c_${name}`,
          name,
          arguments: "{}",
        })),
      },
      {
        role: "tool",
        content: historyNames.map((name) => ({
          kind: "toolResult" as const,
          call_id: `c_${name}`,
          content: "ok",
        })),
      },
    ],
    ...(tools === undefined ? {} : { tools }),
    generation_controls: {},
    stream: false,
    source_surface: "chat",
  };
}

describe("redeclareWithdrawnTools", () => {
  test("history-declared names absent from request.tools are re-declared", () => {
    const request = requestWith(
      [{ name: "kept", jsonSchema: { type: "object", properties: {} } }],
      ["kept", "tool_a"],
    );
    const redeclared = redeclareWithdrawnTools(request);
    expect(redeclared.tools?.map((tool) => tool.name)).toEqual(["kept", "tool_a"]);
    // The stub is permissive but wire-valid: a real object schema the
    // builders can serialize on every wire.
    expect(redeclared.tools?.[1]?.jsonSchema).toEqual({
      type: "object",
      properties: {},
      required: [],
    });
  });

  test("a fully withdrawn tool set is re-declared from history alone", () => {
    const request = requestWith(undefined, ["tool_a", "tool_b"]);
    const redeclared = redeclareWithdrawnTools(request);
    expect(redeclared.tools?.map((tool) => tool.name)).toEqual(["tool_a", "tool_b"]);
  });

  test("nothing withdrawn returns the same reference", () => {
    const declared = requestWith(
      [{ name: "tool_a", jsonSchema: { type: "object", properties: {} } }],
      ["tool_a"],
    );
    expect(redeclareWithdrawnTools(declared)).toBe(declared);
    const noHistory = requestWith([{ name: "x", jsonSchema: {} }], []);
    expect(redeclareWithdrawnTools(noHistory)).toBe(noHistory);
  });

  test("duplicate history calls re-declare once, in first-seen order", () => {
    const request = requestWith(undefined, ["tool_a", "tool_a"]);
    expect(redeclareWithdrawnTools(request).tools?.map((tool) => tool.name)).toEqual(["tool_a"]);
  });

  test("every wire builder inherits the re-declaration (chat)", () => {
    const redeclared = redeclareWithdrawnTools(requestWith(undefined, ["tool_a"]));
    const payload = canonicalToChatPayload(redeclared, {} as never) as Record<string, unknown>;
    const tools = payload["tools"] as Array<Record<string, unknown>>;
    expect(
      tools.some(
        (tool) =>
          tool["type"] === "function" &&
          (tool["function"] as Record<string, unknown>)["name"] === "tool_a",
      ),
    ).toBe(true);
  });

  test("every wire builder inherits the re-declaration (messages)", () => {
    const redeclared = redeclareWithdrawnTools(requestWith(undefined, ["tool_a"]));
    const payload = canonicalToClaudeMessagesPayload(redeclared, {
      isOAuth: false,
    } as never) as Record<string, unknown>;
    const tools = payload["tools"] as Array<Record<string, unknown>>;
    const stub = tools.find((tool) => tool["name"] === "tool_a");
    expect(stub).toBeDefined();
    expect((stub?.["input_schema"] as Record<string, unknown>)["type"]).toBe("object");
  });
});
