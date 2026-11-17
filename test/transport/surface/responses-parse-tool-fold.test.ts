import { expect, test } from "bun:test";
import { parseResponsesRequest } from "../../../src/transport/surface/responses/parse";

/**
 * Responses input items each decode to one canonical message. Parallel tool
 * calls arrive as consecutive `function_call` items with no output between
 * them; decoding each into its own assistant turn broke the OpenAI wire
 * (an assistant `tool_calls` turn must be directly followed by the `tool`
 * turns answering it). The parser folds bare consecutive call turns into one
 * assistant turn.
 */

function parse(input: unknown) {
  return parseResponsesRequest({
    model: "acme/deepseek-v4.1-flash",
    input,
    stream: false,
    max_output_tokens: 1024,
  });
}

test("parallel function_call items fold into one assistant turn", () => {
  const req = parse([
    { type: "message", role: "user", content: [{ type: "input_text", text: "cek" }] },
    {
      type: "function_call",
      id: "call_00_x",
      call_id: "call_00_x",
      name: "shell",
      arguments: '{"command":"ls"}',
    },
    {
      type: "function_call",
      id: "call_01_x",
      call_id: "call_01_x",
      name: "shell",
      arguments: '{"command":"pwd"}',
    },
    { type: "function_call_output", call_id: "call_00_x", output: "a\n" },
    { type: "function_call_output", call_id: "call_01_x", output: "b\n" },
  ]);
  const assistant = req.messages.filter((m) => m.role === "assistant");
  expect(assistant).toHaveLength(1);
  const calls = assistant[0]!.content.filter((part) => part.kind === "toolCall");
  expect(calls).toHaveLength(2);
  expect(calls[0]).toMatchObject({ call_id: "call_00_x", name: "shell" });
  expect(calls[1]).toMatchObject({ call_id: "call_01_x", name: "shell" });
  const tools = req.messages.filter((m) => m.role === "tool");
  expect(tools).toHaveLength(2);
  expect(tools[0]!.content[0]).toMatchObject({ kind: "toolResult", call_id: "call_00_x" });
  expect(tools[1]!.content[0]).toMatchObject({ kind: "toolResult", call_id: "call_01_x" });
});

test("adjacent tool call turns stay separate when text intervenes", () => {
  const req = parse([
    {
      type: "function_call",
      id: "c1",
      call_id: "c1",
      name: "shell",
      arguments: '{"command":"a"}',
    },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "oke" }] },
    {
      type: "function_call",
      id: "c2",
      call_id: "c2",
      name: "shell",
      arguments: '{"command":"b"}',
    },
    { type: "function_call_output", call_id: "c1", output: "1" },
    { type: "function_call_output", call_id: "c2", output: "2" },
  ]);
  const assistant = req.messages.filter((m) => m.role === "assistant");
  // Three distinct assistant turns: tool-call turn, a text turn, then another
  // tool-call turn. The text between them prevents folding.
  expect(assistant).toHaveLength(3);
  expect(assistant[0]!.content.filter((p) => p.kind === "toolCall")).toHaveLength(1);
  expect(assistant[1]!.content.filter((p) => p.kind === "text")).toHaveLength(1);
  expect(assistant[2]!.content.filter((p) => p.kind === "toolCall")).toHaveLength(1);
});

test("reasoning still merges into the assistant tool-call turn", () => {
  const req = parse([
    {
      type: "reasoning",
      summary: [{ type: "summary_text", text: "lets do it" }],
    },
    {
      type: "function_call",
      id: "c1",
      call_id: "c1",
      name: "shell",
      arguments: '{"command":"pwd"}',
    },
    { type: "function_call_output", call_id: "c1", output: "/tmp" },
  ]);
  const assistant = req.messages.filter((m) => m.role === "assistant");
  expect(assistant).toHaveLength(1);
  const parts = assistant[0]!.content;
  expect(parts.some((p) => p.kind === "reasoning")).toBe(true);
  expect(parts.some((p) => p.kind === "toolCall")).toBe(true);
});

test("a reasoning-merged call turn folds with the bare call turn that follows", () => {
  // Codex interleaves: batch 1 (calls + outputs), then a reasoning item, then
  // batch 2 (calls + outputs). Decoding each function_call item separately
  // yields an assistant turn of [reasoning, toolCall] immediately followed by
  // [toolCall]. Those are one logical turn; splitting them produced two
  // consecutive assistant `tool_calls` turns that upstream rejects.
  const req = parse([
    { type: "message", role: "user", content: [{ type: "input_text", text: "cek" }] },
    { type: "function_call", id: "a1", call_id: "a1", name: "shell", arguments: '{"command":"a"}' },
    { type: "function_call", id: "a2", call_id: "a2", name: "shell", arguments: '{"command":"b"}' },
    { type: "function_call_output", call_id: "a1", output: "1" },
    { type: "function_call_output", call_id: "a2", output: "2" },
    { type: "reasoning", summary: [{ type: "summary_text", text: "next step" }] },
    { type: "function_call", id: "b1", call_id: "b1", name: "shell", arguments: '{"command":"c"}' },
    { type: "function_call", id: "b2", call_id: "b2", name: "shell", arguments: '{"command":"d"}' },
    { type: "function_call_output", call_id: "b1", output: "3" },
    { type: "function_call_output", call_id: "b2", output: "4" },
  ]);
  const assistant = req.messages.filter((m) => m.role === "assistant");
  // user, then two assistant turns (batch 1, batch 2 with reasoning folded).
  expect(assistant).toHaveLength(2);
  const batch1 = assistant[0]!.content.filter((p) => p.kind === "toolCall");
  expect(batch1).toHaveLength(2);
  expect(batch1.map((p) => p.call_id)).toEqual(["a1", "a2"]);
  const batch2 = assistant[1]!.content;
  expect(batch2.some((p) => p.kind === "reasoning")).toBe(true);
  expect(batch2.filter((p) => p.kind === "toolCall").map((p) => p.call_id)).toEqual([
    "b1",
    "b2",
  ]);
});

test("codex additional_tools auto-review item is skipped, not rejected", () => {
  // Codex's automatic approval review (Guardian) sends an `additional_tools`
  // input item to declare the tools its review isolate may run. Rejecting it
  // failed the whole auto-review request ("Automatic approval review failed"),
  // which made every permission escalation look like an infrastructure error.
  // The item is client-side metadata: it must parse without throwing and must
  // not leak into instructions or messages.
  const req = parse([
    {
      type: "additional_tools",
      id: "at_1",
      role: "developer",
      tools: [
        {
          type: "namespace",
          name: "functions",
          description: "",
          tools: [{ type: "function", name: "wait", strict: false, parameters: { type: "object", properties: { cell_id: { type: "string" } }, required: ["cell_id"] } }],
        },
      ],
    },
    { type: "message", role: "developer", content: [{ type: "input_text", text: "You are judging one planned action." }] },
    { type: "message", role: "user", content: [{ type: "input_text", text: "Approval request" }] },
  ]);
  // The developer review prompt is hoisted into instructions (normal behavior);
  // the additional_tools item contributes nothing anywhere.
  expect(req.instructions ?? []).toHaveLength(1);
  expect(String(req.instructions?.[0])).not.toContain("additional_tools");
  expect(req.messages).toHaveLength(1);
  expect(req.messages[0]!.role).toBe("user");
});
