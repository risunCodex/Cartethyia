/**
 * Pins donor-adapted Qoder behaviors:
 * - DeepSeek multi-turn backfills `reasoning_content` on every assistant turn
 *   once the conversation carries a reasoning trace.
 * - Qoder speaks structured `tool_calls` (no DSML/XML text-echo recovery).
 */
import { expect, test } from "bun:test";
import {
  buildQoderRequest,
} from "../../../src/providers/integrations/qoder/qoder";
import type { CanonicalRequest, ContentPart } from "../../../src/protocol/canonical-model";

const CONFIG = {
  id: "m",
  display_name: "M",
  max_input_tokens: 128_000,
  is_vl: false,
  is_reasoning: false,
};

const AUTH = {
  userId: "u",
  userName: "n",
  userType: "t",
  securityOauthToken: "s",
  refreshToken: "r",
  machineId: "m",
};

const RESULT: ContentPart = {
  kind: "toolResult",
  call_id: "call_1",
  content: "file body",
};

const REASONING: ContentPart = {
  kind: "reasoning",
  payload: null,
  summary: "thinking",
};

function build(parts: CanonicalRequest["messages"], model = "deepseek-v4.1-flash") {
  const req = {
    model,
    messages: parts,
    generation_controls: {},
    stream: false,
    source_surface: "chat" as const,
  } as CanonicalRequest;
  return buildQoderRequest(model, req, CONFIG, AUTH, "intl");
}

test("DeepSeek backfills reasoning_content on assistant turns without a trace field", () => {
  const body = build([
    { role: "user", content: [{ kind: "text", text: "hint" }] },
    { role: "assistant", content: [REASONING, { kind: "text", text: "ok" }] },
    { role: "user", content: [{ kind: "text", text: "more" }] },
    { role: "assistant", content: [{ kind: "text", text: "plain answer" }] },
  ]);
  const messages = body["messages"] as Array<Record<string, unknown>>;
  // The plain assistant turn (no reasoning part) still carries the empty field.
  const plain = messages.find((m) => m["role"] === "assistant" && m["content"] === "plain answer");
  expect(plain).toBeDefined();
  expect(plain!["reasoning_content"]).toBe("");
  // The thinking turn keeps its text.
  const thought = messages.find((m) => m["role"] === "assistant" && m["content"] === "ok");
  expect(thought!["reasoning_content"]).toBe("thinking");
});

test("non-DeepSeek models are not backfilled", () => {
  const body = build(
    [
      { role: "user", content: [{ kind: "text", text: "hint" }] },
      { role: "assistant", content: [REASONING, { kind: "text", text: "ok" }] },
      { role: "assistant", content: [{ kind: "text", text: "plain answer" }] },
    ],
    "qwen3.8-flash",
  );
  const messages = body["messages"] as Array<Record<string, unknown>>;
  const plain = messages.find((m) => m["role"] === "assistant" && m["content"] === "plain answer");
  expect(plain).toBeDefined();
  expect(plain!["reasoning_content"]).toBeUndefined();
});

test("a past call without an id is not written as text", () => {
  const body = build(
    [
      { role: "user", content: [{ kind: "text", text: "go" }] },
      {
        role: "assistant",
        content: [{ kind: "toolCall", call_id: "", name: "Read", arguments: "{}" }],
      },
      { role: "user", content: [RESULT] },
    ],
    "qwen3.8-flash",
  );
  const messages = body["messages"] as Array<Record<string, unknown>>;
  const assistant = messages.find((m) => m["role"] === "assistant");
  // No structured `tool_calls` field (the call carries no id), and crucially
  // no prose marker — the text-echo contamination must never be written.
  expect(assistant!["tool_calls"]).toBeUndefined();
  expect(String(assistant!["content"])).not.toContain("[assistant 请求调用工具]");
});

test("INTL sends structured tool_calls history, not the prose marker", () => {
  const body = build([
    { role: "user", content: [{ kind: "text", text: "go" }] },
    {
      role: "assistant",
      content: [{ kind: "toolCall", call_id: "call_1", name: "Read", arguments: '{"path":"a.ts"}' }],
    },
    { role: "user", content: [RESULT] },
  ]);
  const messages = body["messages"] as Array<Record<string, unknown>>;
  const assistant = messages.find((m) => m["role"] === "assistant");
  expect(assistant!["tool_calls"]).toHaveLength(1);
  expect(((assistant!["tool_calls"] as Array<Record<string, unknown>>)[0])).toEqual({
    id: "call_1",
    type: "function",
    function: { name: "Read", arguments: '{"path":"a.ts"}' },
  });
  expect(String(assistant!["content"])).not.toContain("[assistant 请求调用工具]");
  // The tool result is a structured `tool` turn, not text.
  const tool = messages.find((m) => m["role"] === "tool");
  expect(tool).toBeDefined();
  expect(tool!["tool_call_id"]).toBe("call_1");
});

test("image parts are carried as structured OpenAI parts, not dropped", () => {
  const body = build([
    {
      role: "user",
      content: [
        { kind: "image", payload: { source: { type: "base64", media_type: "image/png", data: "AAAA" } } },
        { kind: "text", text: "what color?" },
      ],
    },
  ]);
  const messages = body["messages"] as Array<Record<string, unknown>>;
  const user = messages.find((m) => m["role"] === "user");
  expect(Array.isArray(user!["content"])).toBe(true);
  const parts = user!["content"] as Array<Record<string, unknown>>;
  expect(parts[0]).toEqual({ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } });
  expect(parts[1]).toEqual({ type: "text", text: "what color?" });
});
