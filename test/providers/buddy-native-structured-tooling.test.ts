/**
 * Native structured tool-calling parity with the reference gateway: assistant
 * tool_calls-only turns omit the content key, and the caller's parallel
 * tool-call intent is forwarded on the wire — so upstream stays on the
 * structured tool channel instead of falling back to prose/DSML.
 */
import { expect, test } from "bun:test";
import type { CanonicalRequest } from "../../src/protocol/canonical-model";
import {
  applyBuddySystemPrompt,
  injectBuddyParallelToolCalls,
  normalizeBuddyToolNames,
  omitBuddyAssistantToolCallContent,
} from "../../src/providers/integrations/buddy/chat";

const CALLS = [{ id: "call_1", type: "function", function: { name: "Read", arguments: "{}" } }];

test("omitBuddyAssistantToolCallContent drops empty string content on tool_calls turns", () => {
  const messages: Array<Record<string, unknown>> = [
    { role: "assistant", content: "", tool_calls: CALLS },
  ];
  omitBuddyAssistantToolCallContent(messages);
  expect(messages[0]!["content"]).toBeUndefined();
  expect(messages[0]!["tool_calls"]).toEqual(CALLS);
});

test("omitBuddyAssistantToolCallContent drops empty array content and keeps real text", () => {
  const messages: Array<Record<string, unknown>> = [
    { role: "assistant", content: [], tool_calls: CALLS },
    { role: "assistant", content: "thinking out loud", tool_calls: CALLS },
  ];
  omitBuddyAssistantToolCallContent(messages);
  expect(messages[0]!["content"]).toBeUndefined();
  expect(messages[1]!["content"]).toBe("thinking out loud");
});

test("omitBuddyAssistantToolCallContent leaves non-tool turns untouched", () => {
  const messages: Array<Record<string, unknown>> = [
    { role: "assistant", content: "" },
    { role: "user", content: "" },
  ];
  omitBuddyAssistantToolCallContent(messages);
  expect(messages[0]!["content"]).toBe("");
  expect(messages[1]!["content"]).toBe("");
});

test("injectBuddyParallelToolCalls forwards the control when set", () => {
  const payload: Record<string, unknown> = {};
  const request = { generation_controls: { parallel_tool_calls: false } } as CanonicalRequest;
  injectBuddyParallelToolCalls(payload, request);
  expect(payload["parallel_tool_calls"]).toBe(false);
});

test("injectBuddyParallelToolCalls leaves the payload alone when the control is unset", () => {
  const payload: Record<string, unknown> = {};
  const request = { generation_controls: {} } as CanonicalRequest;
  injectBuddyParallelToolCalls(payload, request);
  expect(payload["parallel_tool_calls"]).toBeUndefined();
});

test("applyBuddySystemPrompt keeps tool_calls-only assistant turns free of a content key", () => {
  const messages: Array<Record<string, unknown>> = [
    { role: "user", content: "go" },
    { role: "assistant", content: "", tool_calls: CALLS },
    { role: "tool", tool_call_id: "call_1", content: "result" },
    { role: "user", content: "thanks" },
  ];
  applyBuddySystemPrompt(messages, "SYSTEM");
  const assistant = messages.find((m) => m["role"] === "assistant");
  expect(assistant).toBeDefined();
  expect(assistant!["content"]).toBeUndefined();
  expect(assistant!["tool_calls"]).toEqual(CALLS);
});

test("normalizeBuddyToolNames keeps the OpenAI tool envelope", () => {
  const payload: Record<string, unknown> = {
    tools: [
      { type: "function", function: { name: "find", parameters: { type: "object", properties: {}, required: [] } } },
    ],
  };
  normalizeBuddyToolNames(payload);
  const tool = (payload["tools"] as Array<Record<string, unknown>>)[0]!;
  expect(tool["type"]).toBe("function");
  expect((tool["function"] as Record<string, unknown> | undefined)?.["name"]).toBe("find");
});
