/**
 * Gateway-executed server-tool engine for the Buddy family: classification is
 * declaration-driven (never by name), execution fails as text, and the
 * follow-up transcript keeps the OpenAI shape upstream expects.
 */
import { expect, test } from "bun:test";
import type { ToolDefinition } from "../../src/protocol/canonical-model";
import {
  buildServerToolFollowUpMessages,
  buildServerToolInvocation,
  classifyServerToolDeclaration,
  executeServerToolInvocations,
  findServerToolDeclarations,
  isServerToolCall,
} from "../../src/providers/integrations/buddy/lifecycle";

const tool = (overrides: Partial<ToolDefinition>): ToolDefinition => ({
  name: "t",
  jsonSchema: {},
  ...overrides,
});

test("classification is declaration-driven, never name-driven", () => {
  // Anthropic dated server types survive on native_type.
  expect(classifyServerToolDeclaration(tool({ name: "web_search_20250305", native_type: "web_search_20250305" }))).toBe("web_search");
  expect(classifyServerToolDeclaration(tool({ name: "web_fetch_20250910", native_type: "web_fetch_20250910" }))).toBe("web_fetch");
  // Normalized canonical tool_type also counts.
  expect(classifyServerToolDeclaration(tool({ name: "web_search", tool_type: "web_search" }))).toBe("web_search");
  // A client's own function named WebSearch is NOT a server tool.
  expect(classifyServerToolDeclaration(tool({ name: "WebSearch", tool_type: "function" }))).toBeNull();
  expect(classifyServerToolDeclaration(tool({ name: "WebSearch" }))).toBeNull();
});

test("declared index maps call names to kinds", () => {
  const declared = findServerToolDeclarations([
    tool({ name: "web_search_20250305", native_type: "web_search_20250305" }),
    tool({ name: "web_fetch_20250910", native_type: "web_fetch_20250910" }),
    tool({ name: "WebSearch", tool_type: "function" }),
  ]);
  expect(declared.get("web_search_20250305")).toBe("web_search");
  expect(declared.get("web_fetch_20250910")).toBe("web_fetch");
  expect(declared.has("WebSearch")).toBe(false);
  expect(isServerToolCall("web_search_20250305", declared)).toBe(true);
  expect(isServerToolCall("WebSearch", declared)).toBe(false);
});

test("execution runs searches and fetches through injected backends", async () => {
  const invocations = [
    buildServerToolInvocation("call_1", "web_search_20250305", "web_search", '{"query":"jakarta weather"}'),
    buildServerToolInvocation("call_2", "web_fetch_20250910", "web_fetch", '{"url":"https://example.com/a"}'),
  ];
  const results = await executeServerToolInvocations(
    {
      search: async ({ query }) => `search:${query}`,
      fetch: async ({ url }) => `fetch:${url}`,
    },
    invocations,
  );
  expect(results).toHaveLength(2);
  expect(results[0]!.toolCallId).toBe("call_1");
  expect(results[0]!.content).toBe("search:jakarta weather");
  expect(results[1]!.toolCallId).toBe("call_2");
  expect(results[1]!.content).toBe("fetch:https://example.com/a");
});

test("failures become text, not exceptions", async () => {
  const invocations = [
    buildServerToolInvocation("call_1", "web_search_20250305", "web_search", '{"query":""}'),
    buildServerToolInvocation("call_2", "web_fetch_20250910", "web_fetch", '{"url":"not a url"}'),
    buildServerToolInvocation("call_3", "web_fetch_20250910", "web_fetch", '{"url":"https://example.com"}'),
  ];
  const results = await executeServerToolInvocations(
    {
      fetch: async () => {
        throw new Error("boom");
      },
    },
    invocations,
  );
  expect(results[0]!.content).toContain("empty query");
  expect(results[1]!.content).toContain("invalid or unsupported URL");
  expect(results[2]!.content).toContain("boom");
});

test("follow-up messages carry the assistant call pair and tool results", () => {
  const messages = buildServerToolFollowUpMessages(
    [{ id: "call_1", name: "web_search_20250305", arguments: '{"query":"x"}' }],
    [{ toolCallId: "call_1", content: "search:x" }],
  );
  expect(messages).toHaveLength(2);
  expect(messages[0]!["role"]).toBe("assistant");
  expect((messages[0]!["tool_calls"] as Array<Record<string, unknown>>)[0]!["id"]).toBe("call_1");
  expect(messages[1]!["role"]).toBe("tool");
  expect(messages[1]!["tool_call_id"]).toBe("call_1");
  expect(messages[1]!["content"]).toBe("search:x");
});
