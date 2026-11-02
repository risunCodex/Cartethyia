import { describe, expect, test } from "bun:test";
import { canonicalToResponsesPayload } from "../../src/protocol/request/responses";
import type { CanonicalRequest } from "../../src/protocol/canonical-model";

// The Grok normalizer is not exported, so we re-run the same prePayload
// filtering the adapter applies: allowed-fields allowlist + previous_response_id
// drop. This test locks the behavior we verified live: the proxy is stateless
// and rejects `previous_response_id` with 404.
function normalizeGrokPayload(payload: Record<string, unknown>): void {
  const GROK_ALLOWED_FIELDS = new Set([
    "model", "input", "instructions", "tools", "tool_choice", "stream",
    "store", "reasoning", "include", "temperature", "top_p",
    "max_output_tokens", "parallel_tool_calls", "text", "metadata",
    "prompt_cache_key", "previous_response_id", "conversation", "background",
    "truncation", "max_tool_calls", "stream_options",
    "prompt_cache_retention", "top_logprobs", "moderation",
    "safety_identifier", "prompt", "context_management", "user",
  ]);
  delete payload.previous_response_id;
  for (const key of Object.keys(payload)) {
    if (!GROK_ALLOWED_FIELDS.has(key)) delete payload[key];
  }
}

function buildRequest(overrides: Partial<CanonicalRequest> = {}): CanonicalRequest {
  return {
    model: "grok-4.7",
    messages: [
      { role: "user", content: [{ kind: "text", text: "Remember the key is 777." }] },
      { role: "assistant", content: [{ kind: "text", text: "Got it." }] },
      { role: "user", content: [{ kind: "text", text: "What is the key?" }] },
    ],
    generation_controls: {},
    stream: true,
    source_surface: "chat",
    conversation: { conversation_id: "conv-123", previous_response_id: "resp_should_be_dropped" },
    ...overrides,
  };
}

describe("Grok payload normalization (stateless proxy)", () => {
  test("drops previous_response_id (proxy returns 404 for it)", () => {
    const req = buildRequest();
    const payload = canonicalToResponsesPayload(req);
    expect(payload.previous_response_id).toBe("resp_should_be_dropped");
    normalizeGrokPayload(payload);
    expect(payload.previous_response_id).toBeUndefined();
  });

  test("keeps conversation (accepted by proxy)", () => {
    const req = buildRequest();
    const payload = canonicalToResponsesPayload(req);
    normalizeGrokPayload(payload);
    expect(payload.conversation).toBe("conv-123");
  });

  test("preserves the full input history (stateless continuity)", () => {
    const req = buildRequest();
    const payload = canonicalToResponsesPayload(req);
    normalizeGrokPayload(payload);
    expect(Array.isArray(payload.input)).toBe(true);
    expect(payload.input).toHaveLength(3);
    const roles = (payload.input as Array<{ role: string }>).map((i) => i.role);
    expect(roles).toEqual(["user", "assistant", "user"]);
  });

  test("keeps required wire fields", () => {
    const req = buildRequest();
    const payload = canonicalToResponsesPayload(req);
    normalizeGrokPayload(payload);
    expect(payload.model).toBe("grok-4.7");
    expect(payload.stream).toBe(true);
  });
});
