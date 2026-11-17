/**
 * A qoder request must carry its tool calls.
 *
 * The translator emitted every assistant turn as text only: it handled
 * `toolResult` parts and then fell through to a text-only emit for everything
 * else, so the `toolCall` parts on an assistant turn were dropped. The payload
 * still carried the `tool` results, so the upstream received a transcript whose
 * results had no calls and rejected the whole request:
 *
 *   Messages with role 'tool' must be a response to a preceding message with
 *   'tool_calls'
 *
 * Recorded as request `eb9e4493`, 862 calls in and 0 out.
 */
import { expect, test } from "bun:test";
import { buildQoderRequest } from "../../../src/providers/integrations/qoder/qoder";
import type { CanonicalRequest, ContentPart } from "../../../src/protocol/canonical-model";

// `QoderModelConfig` is not exported, and this test needs no catalog entry:
// the request builder reads only the reasoning flag from it.
const AUTH = { userId: "test", token: "token" } as never;
const CONFIG = { is_reasoning: false } as never;

function build(messages: Array<{ role: "user" | "assistant" | "tool"; content: ContentPart[] }>): Array<Record<string, unknown>> {
  const request = {
    model: "deepseek-v4.1-flash",
    messages,
    generation_controls: { max_tokens: 1024 },
  } as unknown as CanonicalRequest;
  const built = buildQoderRequest("deepseek-v4.1-flash", request, CONFIG, AUTH, "cn");
  return (built["messages"] ?? []) as Array<Record<string, unknown>>;
}

const CALL: ContentPart = {
  kind: "toolCall",
  call_id: "call_1",
  name: "read_file",
  arguments: '{"path":"a.txt"}',
};
const RESULT: ContentPart = { kind: "toolResult", call_id: "call_1", content: "hello" };

test("an assistant turn that called a tool carries the call", () => {
  const out = build([
    { role: "user", content: [{ kind: "text", text: "read a.txt" }] },
    { role: "assistant", content: [{ kind: "text", text: "sure" }, CALL] },
    { role: "tool", content: [RESULT] },
  ]);
  const assistant = out.find((m) => m["role"] === "assistant");
  const calls = assistant?.["tool_calls"] as Array<Record<string, unknown>> | undefined;
  expect(calls).toBeArray();
  expect(calls?.[0]?.["id"]).toBe("call_1");
  expect((calls?.[0]?.["function"] as Record<string, unknown>)?.["name"]).toBe("read_file");
});

test("the message carries only the fields the upstream knows", () => {
  // `contents` is not a field the upstream reads. Sending it alongside
  // `content` gave it two descriptions of the same turn, and the tool call it
  // returned came back with no arguments filled in.
  const out = build([
    { role: "assistant", content: [CALL] },
    { role: "tool", content: [RESULT] },
  ]);
  const assistant = out.find((m) => m["role"] === "assistant");
  expect(assistant?.["contents"]).toBeUndefined();
  const calls = assistant?.["tool_calls"] as Array<Record<string, unknown>>;
  expect(calls).toHaveLength(1);
  expect((calls[0]?.["function"] as Record<string, unknown>)["name"]).toBe("read_file");
});

test("a tool result is not duplicated as a user turn", () => {
  // The result's own text was emitted a second time as `user`, doubling the
  // payload. One `tool` turn per result is the whole point of the block scan.
  const out = build([
    { role: "assistant", content: [CALL] },
    { role: "tool", content: [RESULT] },
  ]);
  const results = out.filter((m) => m["role"] === "tool");
  expect(results.length).toBe(1);
  const echoed = out.filter(
    (m) => m["role"] === "user" && String(m["content"] ?? "").includes("hello"),
  );
  expect(echoed.length).toBe(0);
});

test("arguments are passed through verbatim", () => {
  // The upstream parses them itself. Rewriting an unparseable blob to `{}`
  // would silently replace what the model actually asked for.
  const out = build([
    { role: "assistant", content: [{ ...CALL, arguments: "not json" } as ContentPart] },
    { role: "tool", content: [RESULT] },
  ]);
  const assistant = out.find((m) => m["role"] === "assistant");
  const calls = assistant?.["tool_calls"] as Array<Record<string, unknown>>;
  expect((calls[0]?.["function"] as Record<string, unknown>)["arguments"]).toBe("not json");
});

test("a plain assistant turn is unaffected", () => {
  const out = build([
    { role: "user", content: [{ kind: "text", text: "hi" }] },
    { role: "assistant", content: [{ kind: "text", text: "hello" }] },
  ]);
  const assistant = out.find((m) => m["role"] === "assistant");
  expect(assistant?.["content"]).toBe("hello");
  expect(assistant?.["tool_calls"]).toBeUndefined();
});

/**
 * The DeepSeek family ties multi-turn consistency to `reasoning_content`: an
 * assistant turn that thought must be replayed with it or the upstream refuses
 * the whole history. The reference bridge keeps the field for exactly these
 * models and drops it as noise elsewhere, and notes the symptom when it is
 * missed — occasional failures that sometimes pass on retry.
 */
test("a DeepSeek assistant turn replays its reasoning", () => {
  const out = build([
    { role: "user", content: [{ kind: "text", text: "go" }] },
    {
      role: "assistant",
      content: [
        { kind: "reasoning", payload: "step one", summary: "step one" },
        { kind: "text", text: "done" },
      ],
    },
  ]);
  const assistant = out.find((m) => m["role"] === "assistant");
  expect(assistant?.["reasoning_content"]).toBe("step one");
});

test("an empty reasoning string is replayed, not dropped", () => {
  // A client that knows the rule sends `""` on a thinking turn whose text is
  // not readable back. Dropping it re-triggers the complaint it avoids.
  const out = build([
    {
      role: "assistant",
      content: [{ kind: "reasoning", payload: "", summary: "" }, { kind: "text", text: "ok" }],
    },
  ]);
  const assistant = out.find((m) => m["role"] === "assistant");
  expect(assistant?.["reasoning_content"]).toBe("");
});

test("a non-DeepSeek model gets no reasoning field", () => {
  // The reference drops `reasoning_content` as noise for every other model.
  const request = {
    model: "qmodel",
    messages: [
      {
        role: "assistant",
        content: [{ kind: "reasoning", payload: "hmm", summary: "hmm" }],
      },
    ],
    generation_controls: { max_tokens: 1024 },
  } as unknown as CanonicalRequest;
  const out = (
    buildQoderRequest("qmodel", request, CONFIG, AUTH, "cn")["messages"] ?? []
  ) as Array<Record<string, unknown>>;
  expect(out[0]?.["reasoning_content"]).toBeUndefined();
});
