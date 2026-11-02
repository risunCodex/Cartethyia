/**
 * Thinking/effort ladder resolution tests: rule-table mapping, canonical clamp,
 * and golden wire-payload equivalence (defaults stay byte-identical).
 */
import { describe, expect, test } from "bun:test";
import { resolveThinkingForModel } from "../../../src/protocol/translation/dialect/thinking-ladder";
import { clampThinkingLevelForModel } from "../../../src/protocol/translation/dialect/model-thinking";
import { canonicalToChatPayload } from "../../../src/protocol/request/chat";
import { canonicalToResponsesPayload } from "../../../src/protocol/request/responses";
import { canonicalToClaudeMessagesPayload } from "../../../src/protocol/request/messages";
import type { CanonicalRequest } from "../../../src/protocol/canonical-model";

function req(model = "gpt-5.6"): CanonicalRequest {
  return {
    model,
    messages: [{ role: "user", content: [{ kind: "text", text: "hi" }] }],
    stream: false,
    source_surface: "chat",
    generation_controls: {},
  } as CanonicalRequest;
}

describe("resolveThinkingForModel ladder mapping", () => {
  test("mercury chat ladder is {instant, low, medium, high}", () => {
    const thinking = resolveThinkingForModel("mercury-3", "inception", "chat");
    expect(thinking.efforts).toEqual(["instant", "low", "medium", "high"]);
    expect(thinking.mode).toBe("effort");
  });

  test("gemini is the base 4-tier ladder with google-level mode", () => {
    const thinking = resolveThinkingForModel("gemini-3-pro", "google", "chat");
    expect(thinking.efforts).toEqual(["minimal", "low", "medium", "high"]);
    expect(thinking.mode).toBe("google-level");
  });

  test("responses wire caps at xhigh unless the generation ladder says otherwise", () => {
    const base = resolveThinkingForModel("o3", "openai", "responses");
    expect(base.efforts).toEqual(["minimal", "low", "medium", "high", "xhigh"]);
    const gpt55 = resolveThinkingForModel("gpt-5.5", "openai", "responses");
    expect(gpt55.efforts).toEqual(["low", "medium", "high", "xhigh"]);
    const daybreak = resolveThinkingForModel("daybreak-1", "openai", "responses");
    expect(daybreak.efforts).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  test("claude generations pick the right ladder and mode", () => {
    const adaptive46 = resolveThinkingForModel("claude-opus-4.6", "anthropic", "messages");
    expect(adaptive46.efforts).toEqual(["low", "medium", "high"]);
    expect(adaptive46.mode).toBe("anthropic-adaptive");
    const newGen = resolveThinkingForModel("claude-fable-5", "anthropic", "messages");
    expect(newGen.efforts).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(newGen.mode).toBe("anthropic-adaptive");
    const budget = resolveThinkingForModel("claude-opus-4-5", "anthropic", "messages");
    expect(budget.efforts).toEqual(["minimal", "low", "medium", "high", "xhigh"]);
    expect(budget.mode).toBe("budget");
    const anyClaude = resolveThinkingForModel("claude-sonnet-4", "anthropic", "messages");
    expect(anyClaude.efforts).toContain("max");
  });

  test("mimo-v2.6 is narrowed to {low, medium, high}", () => {
    const thinking = resolveThinkingForModel("mimo-v2.6", "opencode", "chat");
    expect(thinking.efforts).toEqual(["low", "medium", "high"]);
  });

  test("declared efforts win over the rule table", () => {
    const thinking = resolveThinkingForModel("custom-model", "provider", "chat", {
      efforts: ["low", "high"],
    });
    expect(thinking.efforts).toEqual(["low", "high"]);
  });

  test("default is the extended ladder with effort mode", () => {
    const thinking = resolveThinkingForModel("some-unknown-model", "provider", "chat");
    expect(thinking.efforts).toEqual(["minimal", "low", "medium", "high", "xhigh", "max"]);
    expect(thinking.mode).toBe("effort");
  });

  test("never throws and always returns a config", () => {
    expect(() => resolveThinkingForModel("", "", "messages" as never)).not.toThrow();
    const always = resolveThinkingForModel("", "", "messages");
    expect(always.efforts.length).toBeGreaterThan(0);
  });
});

describe("clampThinkingLevelForModel", () => {
  test("steps down to the highest supported level at or below the request", () => {
    const mercury = resolveThinkingForModel("mercury-3", "inception", "chat");
    expect(clampThinkingLevelForModel(mercury, "max")).toBe("high");
    expect(clampThinkingLevelForModel(mercury, "xhigh")).toBe("high");
    expect(clampThinkingLevelForModel(mercury, "medium")).toBe("medium");
  });

  test("normalizes synonyms and off", () => {
    const extended = resolveThinkingForModel("deepseek-v4.1-flash", "deepseek", "chat");
    expect(clampThinkingLevelForModel(extended, "ultra")).toBe("max");
    expect(clampThinkingLevelForModel(extended, "off")).toBeUndefined();
    expect(clampThinkingLevelForModel(extended, "none")).toBeUndefined();
    expect(clampThinkingLevelForModel(extended, "banana")).toBeUndefined();
    expect(clampThinkingLevelForModel(extended, undefined)).toBeUndefined();
  });

  test("below-floor request uses the floor, not the max", () => {
    const gpt55 = resolveThinkingForModel("gpt-5.5", "openai", "responses");
    expect(clampThinkingLevelForModel(gpt55, "minimal")).toBe("low");
  });

  test("an in-ladder request passes through untouched", () => {
    const extended = resolveThinkingForModel("deepseek-v4.1-flash", "deepseek", "chat");
    expect(clampThinkingLevelForModel(extended, "max")).toBe("max");
    expect(clampThinkingLevelForModel(extended, "high")).toBe("high");
  });
});

describe("golden wire payloads stay byte-identical for defaults", () => {
  test("chat reasoning effort for mercury (max) clamps to high", () => {
    const request = req("mercury-3");
    request.reasoning = { effort: "max" };
    const payload = canonicalToChatPayload(request);
    expect(payload["reasoning_effort"]).toBe("high");
  });

  test("chat reasoning effort for deepseek (max) passes through", () => {
    const request = req("deepseek-v4.1-flash");
    request.reasoning = { effort: "max" };
    const payload = canonicalToChatPayload(request);
    expect(payload["reasoning_effort"]).toBe("max");
  });

  test("responses reasoning effort for gpt-5.5 (xhigh) passes through, (max) clamps", () => {
    const request = req("gpt-5.5");
    request.reasoning = { effort: "xhigh" };
    const payload = canonicalToResponsesPayload(request);
    expect((payload["reasoning"] as Record<string, unknown>)["effort"]).toBe("xhigh");

    const maxReq = req("gpt-5.5");
    maxReq.reasoning = { effort: "max" };
    const maxPayload = canonicalToResponsesPayload(maxReq);
    expect((maxPayload["reasoning"] as Record<string, unknown>)["effort"]).toBe("xhigh");
  });

  test("messages adaptive/op output_config.effort clamps via resolved config", () => {
    const request = req("claude-opus-4.6");
    request.reasoning = { thinking_type: "adaptive", effort: "xhigh" };
    const payload = canonicalToClaudeMessagesPayload(request);
    const outputConfig = (payload as Record<string, unknown>)["output_config"] as Record<string, unknown>;
    expect(outputConfig["effort"]).toBe("high");
  });

  test("messages budget-era derives budget_tokens from the level", () => {
    const request = req("claude-opus-4-5");
    request.reasoning = { effort: "high" };
    const payload = canonicalToClaudeMessagesPayload(request);
    const thinking = (payload as Record<string, unknown>)["thinking"] as Record<string, unknown>;
    expect(thinking["type"]).toBe("enabled");
    expect((thinking["budget_tokens"] as number) >= 1024).toBe(true);
  });
});
