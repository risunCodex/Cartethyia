import { describe, expect, test } from "bun:test";
import type { CanonicalRequest } from "../../../src/protocol/canonical-model";
import { encodeWireRequest } from "../../../src/protocol/registry";
import { canonicalToChatPayload } from "../../../src/protocol/request/chat";
import { canonicalToResponsesPayload } from "../../../src/protocol/request/responses";
import type { ProviderDispatchContext } from "../../../src/providers/provider-contracts";
import { lookupKimiPromptCacheKey } from "../../../src/providers/integrations/kimi/kimi";
import {
  normalizeInboundSessionId,
  resolveInboundSessionId,
  resolvePromptCacheKey,
} from "../../../src/providers/operations/session-resolution";
import { forwardedRequestHeaders } from "../../../src/transport/dispatch/upstream";

function request(
  overrides: Partial<CanonicalRequest> = {},
): CanonicalRequest {
  return {
    model: "demo",
    messages: [],
    generation_controls: {},
    stream: false,
    source_surface: "chat",
    ...overrides,
  };
}

function context(requestHeaders: Record<string, string>): ProviderDispatchContext {
  return {
    credential: { provider_id: "openai", credential_kind: "none" },
    deadline: Date.now() + 60_000,
    abort_signal: new AbortController().signal,
    request_headers: requestHeaders,
  } as unknown as ProviderDispatchContext;
}

describe("prompt cache identity", () => {
  test("resolves equivalent canonical keys from every inbound wire", () => {
    const chat = request({
      generation_controls: { "extension:prompt_cache_key": "session-a" },
    });
    const responses = request({
      source_surface: "responses",
      generation_controls: { "extension:responses.prompt_cache_key": "session-a" },
    });
    const messages = request({
      source_surface: "messages",
      generation_controls: { "extension:metadata_user_id": "session-a" },
    });

    expect(resolvePromptCacheKey(chat)).toBe("session-a");
    expect(resolvePromptCacheKey(responses)).toBe("session-a");
    expect(resolvePromptCacheKey(messages)).toBe("session-a");
  });

  test("prefers explicit key, then inbound session, then conversation id", () => {
    const headers = context({ "x-session-id": "header-session" });
    const withConversation = request({ conversation: { conversation_id: "conversation" } });
    expect(resolvePromptCacheKey(withConversation, headers)).toBe("header-session");
    expect(
      resolvePromptCacheKey(
        {
          ...withConversation,
          generation_controls: { "extension:prompt_cache_key": "explicit-key" },
        },
        headers,
      ),
    ).toBe("explicit-key");
    expect(resolvePromptCacheKey(withConversation)).toBe("conversation");
  });

  test("derives stable affinity from a sufficiently long opening turn", () => {
    const firstTurn = "A stable opening user prompt with enough text to derive affinity.";
    const first = request({
      messages: [{ role: "user", content: [{ kind: "text", text: firstTurn }] }],
    });
    const repeated = request({
      messages: [
        { role: "user", content: [{ kind: "text", text: firstTurn }] },
        { role: "assistant", content: [{ kind: "text", text: "Prior answer." }] },
      ],
    });

    expect(resolvePromptCacheKey(first)).toMatch(/^aff_[0-9a-f]{24}$/);
    expect(resolvePromptCacheKey(repeated)).toBe(resolvePromptCacheKey(first));
  });

  test("preserves an inbound session key in shared Chat and Responses payloads", () => {
    const requestWithPrompt = request({
      messages: [{ role: "user", content: [{ kind: "text", text: "hello" }] }],
    });
    const promptCacheKey = resolvePromptCacheKey(
      requestWithPrompt,
      context({ "x-session-id": "session-from-header" }),
    );
    if (promptCacheKey === undefined) throw new Error("Expected session cache identity");

    expect(canonicalToChatPayload(requestWithPrompt, { promptCacheKey })["prompt_cache_key"])
      .toBe("session-from-header");
    expect(canonicalToResponsesPayload(requestWithPrompt, { promptCacheKey })["prompt_cache_key"])
      .toBe("session-from-header");
  });

  test("passes inbound session affinity through the codec registry", async () => {
    const requestWithPrompt = request({
      messages: [{ role: "user", content: [{ kind: "text", text: "hello" }] }],
    });
    const promptCacheKey = resolvePromptCacheKey(
      requestWithPrompt,
      context({ "x-session-id": "session-from-header" }),
    );
    if (promptCacheKey === undefined) throw new Error("Expected session cache identity");

    const chatPayload = await encodeWireRequest("chat", requestWithPrompt, { promptCacheKey });
    const responsesPayload = await encodeWireRequest("responses", requestWithPrompt, {
      promptCacheKey,
    });
    expect(chatPayload["prompt_cache_key"]).toBe("session-from-header");
    expect(responsesPayload["prompt_cache_key"]).toBe("session-from-header");
  });

  test("uses inbound session affinity for Kimi's native Messages identity", () => {
    const requestWithPrompt = request();
    expect(
      lookupKimiPromptCacheKey(
        requestWithPrompt,
        context({ "x-session-id": "session-from-header" }),
      ),
    ).toBe("session-from-header");
  });

  test("does not add OpenAI cache keys when cache controls are disabled", () => {
    const requestWithKey = request({
      generation_controls: { "extension:prompt_cache_key": "explicit-key" },
    });

    expect(canonicalToChatPayload(requestWithKey, { supportsPromptCaching: false }))
      .not.toHaveProperty("prompt_cache_key");
    expect(canonicalToResponsesPayload(requestWithKey, { supportsPromptCaching: false }))
      .not.toHaveProperty("prompt_cache_key");
  });
});

describe("inbound session ID precedence", () => {
  test("uses the first populated supported session header", () => {
    expect(
      resolveInboundSessionId(
        context({
          "x-conversation-id": "first",
          "x-session-id": "second",
          "session-id": "last",
        }),
      ),
    ).toBe("first");
  });

  test("normalizeInboundSessionId trims and rejects empty or oversized values", () => {
    expect(normalizeInboundSessionId("  session-a  ")).toBe("session-a");
    expect(normalizeInboundSessionId("")).toBeUndefined();
    expect(normalizeInboundSessionId("   ")).toBeUndefined();
    expect(normalizeInboundSessionId(undefined)).toBeUndefined();
    const oversized = "s".repeat(257);
    expect(normalizeInboundSessionId(oversized)).toBeUndefined();
    const atLimit = "s".repeat(256);
    expect(normalizeInboundSessionId(atLimit)).toBe(atLimit);
  });

  test("skips an oversized header and falls through to the next one", () => {
    expect(
      resolveInboundSessionId(
        context({
          "x-conversation-id": "s".repeat(257),
          "x-session-id": "second",
        }),
      ),
    ).toBe("second");
  });

  test("does not include client IP or credentials in forwarded cache headers", () => {
    const headers = forwardedRequestHeaders(
      new Request("https://upstream.example/v1/chat/completions", {
        method: "POST",
        headers: {
          "prompt-cache-key": "cache-session",
          "x-session-id": "session-id",
          authorization: "secret",
          cookie: "session=secret",
          "x-forwarded-for": "203.0.113.9",
        },
      }),
    );

    expect(headers["prompt-cache-key"]).toBe("cache-session");
    expect(headers["x-session-id"]).toBe("session-id");
    expect(headers["authorization"]).toBeUndefined();
    expect(headers["cookie"]).toBeUndefined();
    expect(headers["x-forwarded-for"]).toBeUndefined();
  });
});
