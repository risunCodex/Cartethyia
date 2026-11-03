import type {} from "../contracts";
import { jsonDownload } from "../contracts";
import { homeDir, isLocalEndpoint, readJsonFile, stripV1Suffix, writeJsonFileWithBackup } from "../fs-ops";
import type { ApplyInput, InjectorSpec } from "../contracts";


// Claude Code injector spec.
const CLAUDE_ENV_KEYS = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_FABLE_MODEL",
  "ANTHROPIC_DEFAULT_MODEL",
  "ANTHROPIC_CUSTOM_MODEL_OPTION",
  "API_TIMEOUT_MS",
] as const;

/**
 * Baseline settings written into every generated config.
 *
 * Claude Code runs without permission prompts and with the LSP plugins the
 * team standardised on, so the operator never has to reproduce that setup by
 * hand. Only `env` (base URL + the selected key's secret) and `model` are
 * derived from the request; everything else is fixed.
 */
const CLAUDE_BASELINE: Record<string, unknown> = {
  permissions: { defaultMode: "bypassPermissions" },
  enabledPlugins: {
    "typescript-lsp@claude-plugins-official": true,
    "pyright-lsp@claude-plugins-official": true,
  },
  effortLevel: "medium",
  modelSettings: { "claude-opus-5.5": { effortLevel: "medium" } },
  skipDangerousModePermissionPrompt: true,
  includeCoAuthoredBy: false,
  theme: "dark",
  autoCompactWindow: 800000,
  autoCompactEnabled: true,
  autoContinueAtUsageLimit: true,
  hasCompletedOnboarding: true,
};

/** Resolves the top-level `model` from the selected slots, falling back to the
 * template default when the caller did not choose one. */
function claudeModel(input: ApplyInput): string {
  const slots = input.modelSlots ?? {};
  return input.activeModel ?? slots.opus ?? slots.sonnet ?? slots.haiku ?? "opus[1m]";
}


export const claudeSpec: InjectorSpec = {
  toolId: "claude",
  displayName: "Claude Code",
  binary: "claude",
  keepSettingsPathOnMissing: true,
  resolvePath: () => `${homeDir()}/.claude/settings.json`,
  resolveDir: () => `${homeDir()}/.claude`,

  async readStatus(path) {
    const settings = (await readJsonFile(path)) as { env?: Record<string, string> } | null;
    const env = settings?.env;
    const endpoint = env?.ANTHROPIC_BASE_URL ?? null;
    const models = env
      ? [
          env.ANTHROPIC_DEFAULT_OPUS_MODEL,
          env.ANTHROPIC_DEFAULT_SONNET_MODEL,
          env.ANTHROPIC_DEFAULT_HAIKU_MODEL,
          env.ANTHROPIC_DEFAULT_FABLE_MODEL,
          env.ANTHROPIC_DEFAULT_MODEL,
        ].filter((m): m is string => typeof m === "string")
      : null;
    return {
      configured: isLocalEndpoint(endpoint),
      currentEndpoint: endpoint,
      rawApiKey: env?.ANTHROPIC_AUTH_TOKEN ?? null,
      currentModels: models,
    };
  },

  async apply(input, path) {
    const existing = (await readJsonFile(path)) as Record<string, unknown> | null;
    const settings = (existing ?? {}) as Record<string, unknown>;
    const env = (settings.env as Record<string, string> | undefined) ?? {};
    for (const key of CLAUDE_ENV_KEYS) {
      if (key !== "ANTHROPIC_BASE_URL" && key !== "ANTHROPIC_AUTH_TOKEN") delete env[key];
    }
    env.ANTHROPIC_BASE_URL = stripV1Suffix(input.endpoint);
    env.ANTHROPIC_AUTH_TOKEN = input.apiKey;
    delete settings.model;
    delete settings.smallModel;
    settings.env = env;
    settings.model = claudeModel(input);
    for (const [key, value] of Object.entries(CLAUDE_BASELINE)) settings[key] = value;
    await writeJsonFileWithBackup(path, settings);
  },

  async reset(path) {
    const settings = (await readJsonFile(path)) as Record<string, unknown> | null;
    if (!settings) return false;
    const env = settings.env;
    if (env !== null && typeof env === "object" && !Array.isArray(env)) {
      for (const key of CLAUDE_ENV_KEYS) delete (env as Record<string, unknown>)[key];
    }
    delete settings.model;
    delete settings.smallModel;
    await writeJsonFileWithBackup(path, settings);
  },

  download(input) {
    const env: Record<string, string> = {
      ANTHROPIC_BASE_URL: stripV1Suffix(input.endpoint),
      ANTHROPIC_AUTH_TOKEN: input.apiKey,
    };
    const settings: Record<string, unknown> = {
      ...CLAUDE_BASELINE,
      model: claudeModel(input),
      env,
    };
    return jsonDownload(settings, { filename: "settings.json" });
  },

  messages: {
    applied: "Claude Code settings applied",
    reset: "Cartethyia settings removed from Claude Code",
  },
};

