/**
 * F-17: the thinking-sampling strip is an Anthropic-wire rule, not a
 * universal one.
 *
 * `applyParamQuirks` used to strip `temperature`/`top_p`/`top_k` whenever
 * thinking was enabled, on every wire family — but "extended thinking rejects
 * sampling controls" is the Messages contract. OpenAI-family chat wires
 * legally accept `temperature` alongside `reasoning_effort`, and the strip
 * deleted a parameter the caller explicitly asked for.
 */
import { describe, expect, test } from "bun:test";
import type { CanonicalRequest } from "../../../src/protocol/canonical-model";
import { applyParamQuirks } from "../../../src/protocol/translation/quirks";

function requestWithThinking(model: string): CanonicalRequest {
  return {
    model,
    messages: [{ role: "user", content: [{ kind: "text", text: "hi" }] }],
    generation_controls: { temperature: 0.7, top_p: 0.9, top_k: 40 },
    reasoning: { effort: "high", thinking_type: "enabled", budget_tokens: 2048 },
    stream: false,
    source_surface: "chat",
  };
}

describe("F-17: the thinking-sampling strip is wire-family gated", () => {
  test("golden: chat-wire dispatch with thinking + temperature keeps its sampling params", () => {
    const request = requestWithThinking("some-openai-model");
    const result = applyParamQuirks(request, "some-chat-provider", "chat");
    expect(result).toBe(request);
    expect(result.generation_controls.temperature).toBe(0.7);
    expect(result.generation_controls.top_p).toBe(0.9);
  });

  test("messages-wire dispatch with thinking strips all three sampling params", () => {
    const request = requestWithThinking("some-model");
    const result = applyParamQuirks(request, "some-provider", "messages");
    expect(result.generation_controls.temperature).toBeUndefined();
    expect(result.generation_controls.top_p).toBeUndefined();
    expect(result.generation_controls.top_k).toBeUndefined();
  });

  test("the gemini wire is untouched either way (no proven strip)", () => {
    const request = requestWithThinking("gemini-model");
    const result = applyParamQuirks(request, "some-provider", "gemini");
    expect(result).toBe(request);
    expect(result.generation_controls.temperature).toBe(0.7);
  });

  test("chat-wire dispatch without thinking is untouched", () => {
    const withThinking = requestWithThinking("some-model");
    const withoutThinking: CanonicalRequest = {
      model: withThinking.model,
      messages: withThinking.messages,
      generation_controls: withThinking.generation_controls,
      stream: withThinking.stream,
      source_surface: withThinking.source_surface,
    };
    const result = applyParamQuirks(withoutThinking, "some-provider", "chat");
    expect(result).toBe(withoutThinking);
  });

  test("declarative rows still apply per provider on their own merits", () => {
    // The github row strips temperature for every model regardless of
    // thinking — provider-scoped rows are not affected by the wire gate.
    const request = requestWithThinking("gpt-5");
    const result = applyParamQuirks(request, "github", "chat");
    expect(result.generation_controls.temperature).toBeUndefined();
  });
});
