/**
 * Wire dialect resolver tests: mapping, precedence, and never-throw fallback.
 */
import { describe, expect, test } from "bun:test";
import { resolveDialect } from "../../../src/protocol/translation/dialect/resolver";
import type { CanonicalRequest } from "../../../src/protocol/canonical-model";
import { canonicalToChatPayload } from "../../../src/protocol/request/chat";
import { canonicalToClaudeMessagesPayload } from "../../../src/protocol/request/messages";

function req(): CanonicalRequest {
  return {
    model: "deepseek-v4-pro",
    messages: [{ role: "user", content: [{ kind: "text", text: "hi" }] }],
    stream: false,
    source_surface: "chat",
    generation_controls: {},
  } as CanonicalRequest;
}

describe("resolveDialect", () => {
  test("maps providers/models to dialects by heuristic", () => {
    expect(resolveDialect("deepseek-v4-pro", "deepseek", "messages").maxTokensField).toBe("max_tokens");
    expect(resolveDialect("deepseek-v4-pro", "deepseek", "messages").inband).toBe("deepseek");
    expect(resolveDialect("deepseek-v4-pro", "deepseek", "messages").supportsToolChoice).toBe(false);
    expect(resolveDialect("qwen3-thinking", "ollama", "chat").inband).toBe("qwen");
    expect(resolveDialect("qwen3-thinking", "ollama", "chat").supportsMultipleSystemMessages).toBe(false);
  });

  test("family defaults: anthropic for messages, openai otherwise", () => {
    expect(resolveDialect("any", "any", "messages").inband).toBeNull();
    expect(resolveDialect("any", "any", "chat").reasoningContentField).toBe("reasoning_content");
    expect(resolveDialect("any", "any", "responses").maxTokensField).toBe("max_tokens");
  });

  test("DB override wins over heuristic; unknown override falls back safely", () => {
    const deep = resolveDialect("qwen3-thinking", "ollama", "chat", "deepseek");
    expect(deep.inband).toBe("deepseek");
    const unknown = resolveDialect("qwen3-thinking", "ollama", "chat", "not-a-dialect");
    expect(unknown.inband).toBe("qwen"); // heuristic still applies; no throw
  });
});

describe("canonicalToChatPayload dialect policy", () => {
  test("default policy output is identical with and without an explicit policy", () => {
    const plain = canonicalToChatPayload(req());
    const defaulted = canonicalToChatPayload(req(), { dialectPolicy: resolveDialect("deepseek-v4-pro", "deepseek", "chat") });
    // DeepSeek heuristic resolves to the deepseek dialect, so compare against the
    // openai policy explicitly to prove the default path (no policy) matches today.
    const openai = canonicalToChatPayload(req(), {
      dialectPolicy: resolveDialect("x", "openai", "chat"),
    });
    expect(defaulted).toEqual(plain);
    expect(openai).toEqual(plain);
  });
});

describe("canonicalToClaudeMessagesPayload dialect policy", () => {
  test("messages default output is identical with and without a policy", () => {
    const plain = canonicalToClaudeMessagesPayload(req());
    const anthro = canonicalToClaudeMessagesPayload(req(), {
      dialectPolicy: resolveDialect("x", "anthropic", "messages"),
    });
    expect(anthro).toEqual(plain);
  });

  test("supportsToolChoice=false drops tool_choice", () => {
    const withTools = req();
    withTools.tools = [{ name: "t", description: "", jsonSchema: { type: "object", properties: {} } }];
    withTools.tool_choice = { type: "tool", name: "t" };
    const deepseek = canonicalToClaudeMessagesPayload(withTools, {
      dialectPolicy: resolveDialect("deepseek-v4-pro", "deepseek", "messages"),
    });
    expect((deepseek as Record<string, unknown>)["tool_choice"]).toBeUndefined();
    const openai = canonicalToClaudeMessagesPayload(withTools, {
      dialectPolicy: resolveDialect("x", "openai", "messages"),
    });
    expect((openai as Record<string, unknown>)["tool_choice"]).toBeDefined();
  });
});
