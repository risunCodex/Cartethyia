import { describe, expect, test } from "bun:test";
import { resolveThinkingForModel } from "../../src/protocol/translation/dialect/thinking-ladder";
import { clampThinkingLevelForModel } from "../../src/protocol/translation/dialect/model-thinking";

/**
 * Mercury (Inception Labs) rejects every reasoning effort outside
 * `{instant, low, medium, high}` with a 400 that names the field:
 *
 *   Value error, reasoning_effort must be one of: 'instant', 'low',
 *   'medium', 'high'
 *
 * Recorded live from request `40b60777` (ZCode → `/v1/messages` → inception
 * chat wire), where a `(max)` model suffix survived the clamp because the
 * default extended ladder includes `max`.
 */
describe("Mercury reasoning effort clamping", () => {
  test("mercury chat resolves to the {instant, low, medium, high} ladder", () => {
    const supported = resolveThinkingForModel("mercury-3", "inception", "chat").efforts;
    expect(supported).toEqual(["instant", "low", "medium", "high"]);
    // Provider-prefixed ids resolve the same way.
    expect(
      resolveThinkingForModel("inception/mercury-3", "inception", "chat").efforts,
    ).toEqual(supported);
  });

  test("a (max) request clamps down to high, never reaching the upstream", () => {
    const thinking = resolveThinkingForModel("mercury-3", "inception", "chat");
    expect(clampThinkingLevelForModel(thinking, "max")).toBe("high");
    expect(clampThinkingLevelForModel(thinking, "xhigh")).toBe("high");
  });

  test("levels inside the mercury ladder pass through untouched", () => {
    const thinking = resolveThinkingForModel("mercury-3", "inception", "chat");
    expect(clampThinkingLevelForModel(thinking, "high")).toBe("high");
    expect(clampThinkingLevelForModel(thinking, "medium")).toBe("medium");
    expect(clampThinkingLevelForModel(thinking, "low")).toBe("low");
  });

  test("non-mercury models keep the extended ladder", () => {
    const supported = resolveThinkingForModel("deepseek-v4.1-flash", "deepseek", "chat").efforts;
    expect(supported).toContain("max");
    const thinking = resolveThinkingForModel("deepseek-v4.1-flash", "deepseek", "chat");
    expect(clampThinkingLevelForModel(thinking, "max")).toBe("max");
  });
});
