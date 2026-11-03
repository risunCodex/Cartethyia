import { platform } from "node:os";
import type {} from "../contracts";
import { jsonDownload } from "../contracts";
import { homeDir, isLocalEndpoint, join, readJsonFile, writeJsonFileWithBackup } from "../fs-ops";
import type { InjectorSpec } from "../contracts";

const IS_WIN = platform() === "win32";
const IS_MAC = platform() === "darwin";

// Kilo Code injector spec.
//
// Kilo Code is a fork of OpenCode, but it now reads its own config file —
// `~/.config/kilo/kilo.jsonc` (Windows: `%USERPROFILE%\.config\kilo\kilo.jsonc`)
// — with the same provider shape as OpenCode: `provider.<id>.npm/options/models`
// plus a top-level `model`. Unlike OpenCode, Kilo runs on the AI SDK, so the
// `npm` value must be an `@ai-sdk/*` package (default `@ai-sdk/openai-compatible`).
//
// The older VS Code extension also keeps a credential store at
// `~/.local/share/kilo/auth.json`; we still write the endpoint there for
// backward compatibility, but the canonical config is now `kilo.jsonc`.

const KILO_PROVIDER_ID = "cartethyia";

function resolveKiloConfigDirectory(): string {
  if (IS_WIN) return join(process.env.USERPROFILE ?? homeDir(), ".config", "kilo");
  if (IS_MAC) return join(homeDir(), ".config", "kilo");
  return join(homeDir(), ".config", "kilo");
}

function kiloConfigPath(): string {
  return join(resolveKiloConfigDirectory(), "kilo.jsonc");
}

function resolveKiloDataDirectory(): string {
  if (IS_WIN) return join(process.env.LOCALAPPDATA ?? homeDir(), "kilo");
  if (IS_MAC) return join(homeDir(), "Library", "Application Support", "kilo");
  return join(homeDir(), ".local", "share", "kilo");
}

function kiloVscodeSettingsPath(): string {
  if (IS_WIN) return join(process.env.APPDATA ?? homeDir(), "Code", "User", "settings.json");
  if (IS_MAC)
    return join(homeDir(), "Library", "Application Support", "Code", "User", "settings.json");
  return join(homeDir(), ".config", "Code", "User", "settings.json");
}

function kiloModelDef(model: string): unknown {
  return {
    name: model,
    limit: { context: 128000, output: 64000 },
  };
}

function buildKiloModels(models: readonly string[]): Record<string, unknown> {
  const map: Record<string, unknown> = {};
  for (const m of models) {
    if (!m) continue;
    map[m] = kiloModelDef(m);
  }
  return map;
}

export const kiloSpec: InjectorSpec = {
  toolId: "kilo",
  displayName: "Kilo Code",
  binary: "kilo",
  resolveDir: resolveKiloConfigDirectory,
  resolvePath: kiloConfigPath,

  async readStatus(path) {
    const config = (await readJsonFile(path)) as {
      provider?: Record<string, { npm?: string; options?: { baseURL?: string; apiKey?: string }; models?: Record<string, unknown> }>;
      model?: string;
    } | null;
    const provider = config?.provider?.[KILO_PROVIDER_ID];
    const endpoint = provider?.options?.baseURL ?? null;
    const models = provider?.models ? Object.keys(provider.models) : null;
    const active =
      typeof config?.model === "string" && config.model.startsWith(`${KILO_PROVIDER_ID}/`)
        ? config.model.split("/").slice(1).join("/")
        : null;
    if (endpoint) {
      return {
        configured: isLocalEndpoint(endpoint),
        currentEndpoint: endpoint,
        rawApiKey: provider?.options?.apiKey ?? null,
        currentModels: active && models ? [active, ...models.filter((m) => m !== active)] : models,
      };
    }

    // Fallback to the legacy auth.json store (older VS Code extension).
    const auth = (await readJsonFile(join(resolveKiloDataDirectory(), "auth.json"))) as Record<
      string,
      { baseUrl?: string; baseURL?: string; apiKey?: string; model?: string }
    > | null;
    const entry = auth?.["openai-compatible"];
    if (!entry) {
      return { configured: false, currentEndpoint: null, rawApiKey: null, currentModels: null };
    }
    const baseUrl = entry.baseUrl ?? entry.baseURL ?? null;
    return {
      configured: isLocalEndpoint(baseUrl),
      currentEndpoint: baseUrl,
      rawApiKey: entry.apiKey ?? null,
      currentModels: entry.model ? [entry.model] : null,
    };
  },

  async apply(input, path) {
    // Canonical config: ~/.config/kilo/kilo.jsonc
    const existing = (await readJsonFile(path)) as Record<string, unknown> | null;
    const config: Record<string, unknown> = (existing ?? {}) as Record<string, unknown>;
    if (!config.provider || typeof config.provider !== "object") config.provider = {};
    const providers = config.provider as Record<string, unknown>;
    const prior = (providers[KILO_PROVIDER_ID] as Record<string, unknown> | undefined) ?? {};
    const priorModels = (prior.models as Record<string, unknown> | undefined) ?? {};
    const otherProviders = Object.keys(providers).filter((id) => id !== KILO_PROVIDER_ID);
    providers[KILO_PROVIDER_ID] = {
      npm: input.sdk ?? (prior as { npm?: string }).npm ?? "@ai-sdk/openai-compatible",
      options: {
        ...((prior.options as Record<string, unknown> | undefined) ?? {}),
        baseURL: input.endpoint,
        apiKey: input.apiKey,
      },
      models: { ...priorModels, ...buildKiloModels(input.modelIds) },
    };
    const activeModel = input.activeModel ?? input.modelIds[0] ?? "";
    config.model = activeModel === "" ? "" : `${KILO_PROVIDER_ID}/${activeModel}`;

    // YOLO mode: auto-approve shell/read/write.
    if (input.bypassPermissions === true) {
      config.permissions = [
        { action: "shell", resource: "*", effect: "allow" },
        { action: "external_directory", resource: "*", effect: "allow" },
        { action: "question", resource: "*", effect: "deny" },
      ];
    } else if (input.bypassPermissions === false) {
      delete config.permissions;
    }

    await writeJsonFileWithBackup(path, config);

    // Legacy credential store for the older VS Code extension.
    const authPath = join(resolveKiloDataDirectory(), "auth.json");
    const auth = ((await readJsonFile(authPath)) as Record<string, unknown> | null) ?? {};
    auth["openai-compatible"] = { baseUrl: input.endpoint, apiKey: input.apiKey, model: activeModel };
    await writeJsonFileWithBackup(authPath, auth);

    const settings =
      ((await readJsonFile(kiloVscodeSettingsPath())) as Record<string, unknown> | null) ?? {};
    settings["kilo.code.authProviderOverride"] = "openai-compatible";
    await writeJsonFileWithBackup(kiloVscodeSettingsPath(), settings);

    return otherProviders.length > 0
      ? [
          `Config already has other provider(s): ${otherProviders.join(", ")}. They were kept as-is — only ${KILO_PROVIDER_ID} was written/updated.`,
        ]
      : undefined;
  },

  async reset(path) {
    const config = (await readJsonFile(path)) as Record<string, unknown> | null;
    if (config && config.provider && typeof config.provider === "object") {
      const providers = config.provider as Record<string, unknown>;
      delete providers[KILO_PROVIDER_ID];
      if (Object.keys(providers).length === 0) delete config.provider;
    }
    if (typeof config?.model === "string" && config.model.startsWith(`${KILO_PROVIDER_ID}/`)) {
      delete config.model;
    }
    if (config) await writeJsonFileWithBackup(path, config);

    const auth = (await readJsonFile(join(resolveKiloDataDirectory(), "auth.json"))) as Record<
      string,
      unknown
    > | null;
    if (auth) {
      delete auth["openai-compatible"];
      await writeJsonFileWithBackup(join(resolveKiloDataDirectory(), "auth.json"), auth);
    }

    const settings = (await readJsonFile(kiloVscodeSettingsPath())) as Record<
      string,
      unknown
    > | null;
    if (settings && "kilo.code.authProviderOverride" in settings) {
      delete settings["kilo.code.authProviderOverride"];
      await writeJsonFileWithBackup(kiloVscodeSettingsPath(), settings);
    }
  },

  download(input) {
    const activeModel = input.activeModel ?? input.modelIds[0] ?? "";
    const config: Record<string, unknown> = {
      provider: {
        [KILO_PROVIDER_ID]: {
          npm: input.sdk ?? "@ai-sdk/openai-compatible",
          options: {
            baseURL: input.endpoint,
            apiKey: input.apiKey,
          },
          models: buildKiloModels(input.modelIds),
        },
      },
      model: activeModel === "" ? "" : `${KILO_PROVIDER_ID}/${activeModel}`,
    };
    return jsonDownload(config, { filename: "kilo.jsonc" });
  },

  messages: {
    applied: "Kilo Code settings applied",
    reset: "Cartethyia settings removed from Kilo Code",
    resetMissing: "No config file to reset",
  },
};
