/**
 * Tenant system-prompt injection: resolution (most-specific-wins, presets,
 * refs, alias/combo requested-name), the canonical transform (append/override),
 * the buddy wrapped-append path, and the console API validation.
 */
import { describe, expect, test } from "bun:test";
import type { CanonicalRequest } from "../../src/protocol/canonical-model";
import {
  SYSTEM_PROMPT_WRAPPER_PREFIX,
  SYSTEM_PROMPT_WRAPPER_SUFFIX,
  systemPromptModelKey,
} from "../../src/console/system-prompt/contracts";
import {
  applyInjectSystemPrompt,
  resolveTenantSystemPrompt,
} from "../../src/transport/request/system-prompt-injection";
import { applyBuddySystemPrompt } from "../../src/providers/integrations/buddy/buddy-chat-shared";
import type { TenantSystemPrompts } from "../../src/console/system-prompt/contracts";

function request(overrides: Partial<CanonicalRequest> = {}): CanonicalRequest {
  return {
    model: "model-x",
    messages: [{ role: "user", content: [{ kind: "text", text: "hi" }] }],
    ...overrides,
  } as CanonicalRequest;
}

function setting(text: string, mode: "append" | "override" = "append", enabled = true) {
  return { enabled, mode, text };
}

/** A global ref pointing at a custom prompt. */
function globalCustom(text: string, mode: "append" | "override" = "append", enabled = true) {
  return { kind: "custom" as const, setting: setting(text, mode, enabled) };
}

/** A global ref pointing at a preset. */
function globalPreset(presetId: string) {
  return { kind: "preset" as const, presetId };
}

function prompts(overrides: Partial<TenantSystemPrompts> = {}): TenantSystemPrompts {
  return {
    global: null,
    presets: {},
    providers: {},
    models: {},
    combos: {},
    aliases: {},
    ...overrides,
  };
}

describe("resolveTenantSystemPrompt", () => {
  const base = prompts({
    global: globalCustom("global-prompt"),
    providers: {
      "prov-a": { kind: "global" },
      "prov-b": { kind: "custom", setting: setting("prov-b-prompt") },
      "prov-off": { kind: "custom", setting: setting("off", "append", false) },
      "prov-preset": { kind: "preset", presetId: "pre-1" },
    },
    presets: {
      "pre-1": { id: "pre-1", name: "Rules", enabled: true, mode: "append", text: "preset-prompt" },
      "pre-off": { id: "pre-off", name: "Off", enabled: false, mode: "append", text: "disabled" },
    },
    models: {
      [systemPromptModelKey("prov-a", "model-1")]: { kind: "custom", setting: setting("model-prompt") },
    },
    aliases: {
      "alias-fast": { kind: "custom", setting: setting("alias-prompt") },
    },
    combos: {
      "combo-x": { kind: "preset", presetId: "pre-1" },
    },
  });

  test("model scope wins over provider/global", () => {
    expect(resolveTenantSystemPrompt(base, { providerId: "prov-a", modelId: "model-1" })?.text).toBe("model-prompt");
  });

  test("followGlobal provider falls back to global", () => {
    expect(resolveTenantSystemPrompt(base, { providerId: "prov-a", modelId: "model-2" })?.text).toBe("global-prompt");
  });

  test("custom provider setting beats global", () => {
    expect(resolveTenantSystemPrompt(base, { providerId: "prov-b", modelId: "m" })?.text).toBe("prov-b-prompt");
  });

  test("disabled custom provider falls back to global", () => {
    expect(resolveTenantSystemPrompt(base, { providerId: "prov-off", modelId: "m" })?.text).toBe("global-prompt");
  });

  test("preset reference resolves to the preset text", () => {
    expect(resolveTenantSystemPrompt(base, { providerId: "prov-preset", modelId: "m" })?.text).toBe("preset-prompt");
  });

  test("disabled preset reference yields nothing (falls back to global)", () => {
    const withDisabled = prompts({ ...base, providers: { p: { kind: "preset", presetId: "pre-off" } } });
    expect(resolveTenantSystemPrompt(withDisabled, { providerId: "p", modelId: "m" })?.text).toBe("global-prompt");
  });

  test("missing preset reference falls back to global", () => {
    const withMissing = prompts({ ...base, providers: { p: { kind: "preset", presetId: "nope" } } });
    expect(resolveTenantSystemPrompt(withMissing, { providerId: "p", modelId: "m" })?.text).toBe("global-prompt");
  });

  test("alias reference beats model/provider/global when requested name matches", () => {
    expect(
      resolveTenantSystemPrompt(base, { providerId: "prov-a", modelId: "model-1", requestedModel: "alias-fast" })?.text,
    ).toBe("alias-prompt");
  });

  test("combo reference resolves when requested name matches", () => {
    expect(
      resolveTenantSystemPrompt(base, { providerId: "x", modelId: "m", requestedModel: "combo-x" })?.text,
    ).toBe("preset-prompt");
  });

  test("requestedName equal to modelId does not alias-match", () => {
    // When requestedModel === modelId there is no alias/combo indirection.
    expect(
      resolveTenantSystemPrompt(base, { providerId: "prov-a", modelId: "model-1", requestedModel: "model-1" })?.text,
    ).toBe("model-prompt");
  });

  test("unconfigured provider falls back to global", () => {
    expect(resolveTenantSystemPrompt(base, { providerId: "other", modelId: "m" })?.text).toBe("global-prompt");
  });

  test("no global configured → undefined", () => {
    expect(
      resolveTenantSystemPrompt(prompts(), { providerId: "x", modelId: "y" }),
    ).toBeUndefined();
  });

  test("global can reference a preset", () => {
    const withGlobalPreset = prompts({
      global: globalPreset("pre-1"),
      presets: {
        "pre-1": { id: "pre-1", name: "Rules", enabled: true, mode: "append", text: "preset-prompt" },
      },
    });
    expect(
      resolveTenantSystemPrompt(withGlobalPreset, { providerId: "x", modelId: "y" })?.text,
    ).toBe("preset-prompt");
  });

  test("global disabled preset yields nothing", () => {
    const withGlobalPreset = prompts({
      global: globalPreset("pre-off"),
      presets: {
        "pre-off": { id: "pre-off", name: "Off", enabled: false, mode: "append", text: "disabled" },
      },
    });
    expect(
      resolveTenantSystemPrompt(withGlobalPreset, { providerId: "x", modelId: "y" }),
    ).toBeUndefined();
  });

  test("explicit off on a provider stops injection instead of falling back to global", () => {
    const withOff = prompts({
      global: globalCustom("global-prompt"),
      providers: { "prov-off": { kind: "off" } },
    });
    expect(
      resolveTenantSystemPrompt(withOff, { providerId: "prov-off", modelId: "m" }),
    ).toBeUndefined();
  });

  test("explicit off on a model stops injection instead of falling back to global", () => {
    const withOff = prompts({
      global: globalCustom("global-prompt"),
      models: { [systemPromptModelKey("p", "m")]: { kind: "off" } },
    });
    expect(
      resolveTenantSystemPrompt(withOff, { providerId: "p", modelId: "m" }),
    ).toBeUndefined();
  });

  test("provider following global resolves a custom global", () => {
    const withGlobal = prompts({
      global: globalCustom("global-prompt"),
      providers: { "prov-a": { kind: "global" } },
    });
    expect(
      resolveTenantSystemPrompt(withGlobal, { providerId: "prov-a", modelId: "m" })?.text,
    ).toBe("global-prompt");
  });
});

describe("applyInjectSystemPrompt", () => {
  const basePrompts = prompts({ global: globalCustom("tenant"), providers: {}, models: {} });

  test("appends tenant text after existing system content", () => {
    const base = request({ system: [{ kind: "text", text: "caller" }] });
    const next = applyInjectSystemPrompt(
      base,
      basePrompts,
      { providerId: "p", modelId: "m", serviceKind: "llm" },
    );
    expect(next.system).toHaveLength(2);
    expect(next.system?.[1]).toEqual({ kind: "text", text: "tenant" });
  });

  test("creates system content when absent", () => {
    const next = applyInjectSystemPrompt(
      request(),
      basePrompts,
      { providerId: "p", modelId: "m", serviceKind: "llm" },
    );
    expect(next.system).toEqual([{ kind: "text", text: "tenant" }]);
  });

  test("override replaces caller system content", () => {
    const base = request({ system: [{ kind: "text", text: "caller" }] });
    const next = applyInjectSystemPrompt(
      base,
      prompts({ global: globalCustom("tenant", "override") }),
      { providerId: "p", modelId: "m", serviceKind: "llm" },
    );
    expect(next.system).toEqual([{ kind: "text", text: "tenant" }]);
  });

  test("override keeps replaced content when no caller system exists", () => {
    const next = applyInjectSystemPrompt(
      request(),
      prompts({ global: globalCustom("tenant", "override") }),
      { providerId: "p", modelId: "m", serviceKind: "llm" },
    );
    expect(next.system).toEqual([{ kind: "text", text: "tenant" }]);
  });

  test("idempotent: the same text is not appended twice", () => {
    const base = applyInjectSystemPrompt(
      request(),
      basePrompts,
      { providerId: "p", modelId: "m", serviceKind: "llm" },
    );
    const again = applyInjectSystemPrompt(
      base,
      basePrompts,
      { providerId: "p", modelId: "m", serviceKind: "llm" },
    );
    expect(again.system).toHaveLength(1);
  });

  test("skips non-llm service kinds", () => {
    const base = request();
    const next = applyInjectSystemPrompt(
      base,
      basePrompts,
      { providerId: "p", modelId: "m", serviceKind: "systemone" },
    );
    expect(next).toBe(base);
  });

  test("disabled setting is a no-op", () => {
    const base = request();
    const next = applyInjectSystemPrompt(
      base,
      prompts({ global: globalCustom("x", "append", false) }),
      { providerId: "p", modelId: "m", serviceKind: "llm" },
    );
    expect(next).toBe(base);
  });
});

describe("buddy wrapped append", () => {
  test("identity prompt stays the opener; tenant text rides wrapped", () => {
    const messages: Array<Record<string, unknown>> = [
      { role: "system", content: "caller system" },
      { role: "user", content: "hi" },
    ];
    applyBuddySystemPrompt(messages, "You are CodeBuddy Code.", "tenant directive");
    expect(messages[0]?.["role"]).toBe("system");
    const content = String(messages[0]?.["content"]);
    expect(content.startsWith("You are CodeBuddy Code.")).toBe(true);
    expect(content).toContain(SYSTEM_PROMPT_WRAPPER_PREFIX);
    expect(content).toContain("tenant directive");
    expect(content).toContain(SYSTEM_PROMPT_WRAPPER_SUFFIX);
    // Caller system text was replaced (identity preserved, caller dropped).
    expect(content).not.toContain("caller system");
    // The user turn survived.
    expect(messages.some((m) => m["role"] === "user")).toBe(true);
  });

  test("no tenant text → prompt unchanged", () => {
    const messages: Array<Record<string, unknown>> = [{ role: "user", content: "hi" }];
    applyBuddySystemPrompt(messages, "You are CodeBuddy Code.");
    expect(messages[0]?.["content"]).toBe("You are CodeBuddy Code.");
  });
});
