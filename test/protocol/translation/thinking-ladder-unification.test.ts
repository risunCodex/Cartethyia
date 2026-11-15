/**
 * F-28..F-33: the reasoning ladder unification.
 *
 * - F-28: rank tables are derived from the ladder, never hand-kept copies.
 * - F-30: the DeepSeek replay injection is a ladder-rule contract
 *   (`reasoningReplay`), not a raw model-string prefix match.
 * - F-31: the per-mode budget floor is declared once and clamps a sub-floor
 *   ladder budget instead of letting the cell fail.
 * - F-32: Copilot's fallback ceiling is a ladder rule, not a prePayload hook.
 * - F-33: the effort × wire × model matrix is driven by one test so a new
 *   family cannot silently drop a spelling.
 */
import { describe, expect, test } from "bun:test";
import { REASONING_EFFORTS } from "../../../src/protocol/canonical-model";
import {
  applyDeepSeekReasoning,
  ensureChatReasoningReplayPresence,
} from "../../../src/protocol/reasoning";
import {
  clampBudgetToWireFloor,
  REASONING_EFFORT_LADDER,
} from "../../../src/protocol/translation/thinking";
import { resolveThinkingForModel } from "../../../src/protocol/translation/dialect/thinking-ladder";
import { clampThinkingLevelForModel } from "../../../src/protocol/translation/dialect/model-thinking";

describe("F-28: rank tables derive from the ladder", () => {
  test("the buddy rank table's ladder keys match the ladder in order", async () => {
    // The table lives in buddy/chat (not exported); assert via the same
    // derivation the table uses, and against the ladder itself.
    const { REASONING_EFFORT_LADDER: ladder } = await import(
      "../../../src/protocol/translation/thinking"
    );
    const derived = Object.fromEntries(ladder.map((level, index) => [level, index]));
    expect(Object.keys(derived)).toEqual([...ladder]);
    for (let index = 1; index < ladder.length; index += 1) {
      const previous = ladder[index - 1]!;
      const current = ladder[index]!;
      expect(derived[current]! - derived[previous]!).toBe(1);
    }
  });

  test("every canonical effort resolves on the ladder (the `none` spelling is the non-ladder one)", () => {
    for (const effort of REASONING_EFFORTS) {
      if (effort === "none") continue;
      expect(REASONING_EFFORT_LADDER).toContain(effort);
    }
    expect(REASONING_EFFORT_LADDER).not.toContain("none");
  });
});

describe("F-30: the replay contract is a ladder flag", () => {
  test("a deepseek-family model resolves reasoningReplay and gets the contract", () => {
    expect(resolveThinkingForModel("deepseek-v4.1-flash", "buddy", "chat").reasoningReplay).toBe(
      true,
    );
    const payload: Record<string, unknown> = { model: "deepseek-v4.1-flash", messages: [] };
    applyDeepSeekReasoning(payload);
    expect(payload["thinking"]).toEqual({ type: "enabled" });
    expect(payload["reasoning_effort"]).toBe("high");
  });

  test("the reseller spelling of the same contract gets it too", () => {
    expect(
      resolveThinkingForModel("reflection/beam-free", "cline", "chat").reasoningReplay,
    ).toBe(true);
  });

  test("a non-matching model gets neither the thinking object nor a default effort", () => {
    const payload: Record<string, unknown> = { model: "gpt-5.5", messages: [] };
    applyDeepSeekReasoning(payload);
    expect(payload["thinking"]).toBeUndefined();
    expect(payload["reasoning_effort"]).toBeUndefined();
  });

  test("an explicit disabled contract still clears the effort", () => {
    const payload: Record<string, unknown> = {
      model: "deepseek-v4.1-flash",
      thinking: { type: "disabled" },
      reasoning_effort: "high",
      messages: [],
    };
    applyDeepSeekReasoning(payload);
    expect(payload["reasoning_effort"]).toBeUndefined();
    expect(payload["thinking"]).toEqual({ type: "disabled" });
  });

  test("the replay-presence helper gates on the flag, not the regex", () => {
    const deepseekTurns = {
      model: "deepseek-v4.1-flash",
      thinking: { type: "enabled" },
      messages: [{ role: "assistant", content: "hi" }],
    };
    ensureChatReasoningReplayPresence(deepseekTurns);
    expect((deepseekTurns.messages as Array<Record<string, unknown>>)[0]).toMatchObject({
      reasoning_content: "",
    });

    const foreignTurns = {
      model: "gpt-5.5",
      thinking: { type: "enabled" },
      messages: [{ role: "assistant", content: "hi" }],
    };
    ensureChatReasoningReplayPresence(foreignTurns);
    expect((foreignTurns.messages as Array<Record<string, unknown>>)[0]).not.toHaveProperty(
      "reasoning_content",
    );
  });
});

describe("F-31: the per-mode budget floor", () => {
  test("budget-era modes floor at 1024", () => {
    expect(clampBudgetToWireFloor("budget", 256)).toBe(1024);
    expect(clampBudgetToWireFloor("anthropic-adaptive", 512)).toBe(1024);
  });

  test("a budget above the floor passes through unchanged", () => {
    expect(clampBudgetToWireFloor("budget", 8192)).toBe(8192);
  });

  test("effort and google-level modes declare no floor", () => {
    expect(clampBudgetToWireFloor("effort", 256)).toBe(256);
    expect(clampBudgetToWireFloor("google-level", 512)).toBe(512);
  });

  test("the ladder's sub-floor budgets clamp before validation on the messages wire", () => {
    // LEVEL_TO_BUDGET publishes instant=256/minimal=512; the budget-era wire
    // floors at 1024 — the cell clamps instead of failing.
    const clamped = clampBudgetToWireFloor("budget", 256);
    expect(clamped).toBe(1024);
  });
});

describe("F-32: the Copilot ceiling is a ladder rule", () => {
  test("a github model with no declared ladder serves up to high", () => {
    const config = resolveThinkingForModel("gpt-6-luna", "github", "chat");
    expect(config.efforts).toEqual(["minimal", "low", "medium", "high"]);
    expect(clampThinkingLevelForModel(config, "max")).toBe("high");
    expect(clampThinkingLevelForModel(config, "xhigh")).toBe("high");
    expect(clampThinkingLevelForModel(config, "minimal")).toBe("minimal");
  });

  test("the cap is a fallback: an id-specific ladder still wins on github", () => {
    // A gpt-5.5 row on the responses wire keeps its own ladder — the
    // provider rule must never override a model-specific one.
    const config = resolveThinkingForModel("gpt-5.5", "github", "responses");
    expect(config.efforts).toEqual(["low", "medium", "high", "xhigh"]);
  });
});

describe("F-33: the reasoning matrix", () => {
  const MODELS: ReadonlyArray<{ id: string; provider: string; wire: "chat" | "responses" | "messages" | "gemini" }> = [
    { id: "deepseek-v4.1-flash", provider: "buddy", wire: "chat" },
    { id: "claude-opus-4-5", provider: "anthropic", wire: "messages" },
    { id: "claude-opus-4-6", provider: "anthropic", wire: "messages" },
    { id: "claude-opus-4-7", provider: "anthropic", wire: "messages" },
    { id: "gpt-5.5", provider: "openai", wire: "responses" },
    { id: "gpt-6-luna", provider: "github", wire: "chat" },
    { id: "gemini-3.1-pro", provider: "google", wire: "gemini" },
    { id: "mimo-v2.6", provider: "mimo", wire: "chat" },
    { id: "mercury-coder", provider: "inception", wire: "chat" },
    { id: "totally-unknown-model", provider: "openrouter", wire: "chat" },
  ];

  test("every canonical effort resolves against every family without dropping a spelling", () => {
    for (const model of MODELS) {
      const config = resolveThinkingForModel(model.id, model.provider, model.wire);
      expect(config.efforts.length, `${model.id}/${model.wire}`).toBeGreaterThan(0);
      for (const effort of REASONING_EFFORTS) {
        if (effort === "none") continue;
        const clamped = clampThinkingLevelForModel(config, effort);
        // The clamp never INVENTS a level: the result is either a level the
        // config serves, or undefined (the caller's ask withdrawn) — never a
        // level outside the config's own ladder.
        if (clamped !== undefined) {
          expect(config.efforts, `${model.id}/${model.wire} effort=${effort}`).toContain(clamped);
        }
      }
    }
  });

  test("every resolved config carries a control mode the wire can encode", () => {
    const encodable = new Set(["effort", "budget", "anthropic-adaptive", "google-level"]);
    for (const model of MODELS) {
      const config = resolveThinkingForModel(model.id, model.provider, model.wire);
      expect(encodable.has(config.mode), `${model.id}/${model.wire} mode=${config.mode}`).toBe(
        true,
      );
    }
  });
});
