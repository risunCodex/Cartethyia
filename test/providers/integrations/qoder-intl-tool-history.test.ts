import { expect, test } from "bun:test";
import {
  buildQoderRequest,
} from "../../../src/providers/integrations/qoder/qoder";
import type { CanonicalRequest, ContentPart } from "../../../src/protocol/canonical-model";

/**
 * Qoder's wire is OpenAI-compatible `tool_calls` deltas on every realm. A past
 * call is recorded as a structured turn (never as prose), so the model is not
 * taught a text echo to imitate.
 */

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

const CALL: ContentPart = {
  kind: "toolCall",
  call_id: "call_1",
  name: "Read",
  arguments: '{"file_path":"a.ts"}',
};

const RESULT: ContentPart = {
  kind: "toolResult",
  call_id: "call_1",
  content: "file body",
};

function build(parts: CanonicalRequest["messages"], realm: "intl" | "cn") {
  const req: CanonicalRequest = {
    model: "m",
    stream: false,
    source_surface: "chat",
    generation_controls: {},
    messages: parts,
  };
  return (buildQoderRequest("m", req, CONFIG, AUTH, realm)["messages"] ??
    []) as Array<Record<string, unknown>>;
}

test("INTL records a past call as a structured tool_calls turn", () => {
  const out = build([{ role: "assistant", content: [CALL] }, { role: "tool", content: [RESULT] }], "intl");
  const assistant = out.find((m) => m["role"] === "assistant");
  expect(assistant?.["tool_calls"]).toHaveLength(1);
  expect(((assistant?.["tool_calls"] as Array<Record<string, unknown>>)?.[0])).toEqual({
    id: "call_1",
    type: "function",
    function: { name: "Read", arguments: '{"file_path":"a.ts"}' },
  });
  expect(String(assistant?.["content"])).not.toContain("[assistant 请求调用工具]");
  const tool = out.find((m) => m["role"] === "tool");
  expect(tool).toBeDefined();
  expect(tool!["tool_call_id"]).toBe("call_1");
});

test("CN keeps the structured call", () => {
  const out = build([{ role: "assistant", content: [CALL] }, { role: "tool", content: [RESULT] }], "cn");
  const assistant = out.find((m) => m["role"] === "assistant");
  expect(assistant?.["tool_calls"]).toHaveLength(1);
  expect(String(assistant?.["content"])).not.toContain("[assistant 请求调用工具]");
});

test("a cancelled parallel call drops its orphan tool turn with the assistant calls", () => {
  // Codex/OpenAI run parallel tool calls; when one is cancelled or its result
  // is lost to compaction, the assistant turn's calls do not all have results.
  // The transcript must not emit an orphan `tool` turn (no preceding call),
  // which upstream rejects as "Messages with role 'tool' must be a response to
  // a preceding message with 'tool_calls'".
  const out = build(
    [
      { role: "user", content: [{ kind: "text", text: "baca dua file" }] },
      {
        role: "assistant",
        content: [
          { kind: "toolCall", call_id: "call_A", name: "Read", arguments: '{"file_path":"a"}' },
          { kind: "toolCall", call_id: "call_B", name: "Read", arguments: '{"file_path":"b"}' },
        ],
      },
      { role: "tool", content: [{ kind: "toolResult", call_id: "call_A", content: "isi A" }] },
      { role: "user", content: [{ kind: "text", text: "lanjut" }] },
    ],
    "intl",
  );
  // No assistant `tool_calls` turn: the set is incomplete, so all calls are
  // withheld together to keep the transcript consistent.
  for (const m of out) expect(m["tool_calls"]).toBeUndefined();
  // And critically: no orphan `tool` turn either.
  for (const m of out) {
    if (m["role"] === "tool") throw new Error("orphan tool turn leaked into transcript");
  }
  expect(out.some((m) => m["role"] === "user")).toBe(true);
});
