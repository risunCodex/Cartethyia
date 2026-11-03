import type {} from "../contracts";
import { ensureV1Suffix, homeDir, join, readJsonFile, writeJsonFileWithBackup } from "../fs-ops";
import type { InjectorSpec } from "../contracts";
import { DEFAULT_SDK } from "../contracts";


// OpenCode injector spec.
interface OpencodeModel {
  name: string;
  modalities: { input: string[]; output: string[] };
}

interface OpencodeProvider {
  npm: string;
  options: { baseURL?: string; apiKey?: string };
  models: Record<string, OpencodeModel>;
}

interface OpencodeConfig {
  provider?: Record<string, OpencodeProvider>;
  model?: string;
  agent?: {
    explorer?: {
      description?: string;
      mode?: string;
      model?: string;
    };
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

function buildOpencodeModels(models: readonly string[]): Record<string, OpencodeModel> {
  const map: Record<string, OpencodeModel> = {};
  for (const m of models) {
    if (!m) continue;
    map[m] = { name: m, modalities: { input: ["text", "image"], output: ["text"] } };
  }
  return map;
}

export const opencodeSpec: InjectorSpec = {
  toolId: "opencode",
  displayName: "OpenCode",
  binary: "opencode",
  resolvePath: () => join(homeDir(), ".config", "opencode", "opencode.json"),
  resolveDir: () => join(homeDir(), ".config", "opencode"),

  async readStatus(path) {
    const config = (await readJsonFile(path)) as OpencodeConfig | null;
    if (!config) {
      return { configured: false, currentEndpoint: null, rawApiKey: null, currentModels: null };
    }
    const provider = config.provider?.cartethyia;
    const endpoint = provider?.options?.baseURL ?? null;
    const models = provider?.models ? Object.keys(provider.models) : null;
    const active =
      typeof config.model === "string" && config.model.startsWith("cartethyia/")
        ? config.model.split("/").slice(1).join("/")
        : null;
    return {
      configured: !!provider,
      currentEndpoint: endpoint,
      rawApiKey: provider?.options?.apiKey ?? null,
      currentModels: active && models ? [active, ...models.filter((m) => m !== active)] : models,
    };
  },

  async apply(input, path) {
    const existing = (await readJsonFile(path)) as OpencodeConfig | null;
    const config: OpencodeConfig = (existing ?? {}) as OpencodeConfig;

    if (!config.provider) config.provider = {};
    const prior = config.provider.cartethyia;
    const otherProviders = Object.keys(config.provider).filter((id) => id !== "cartethyia");
    config.provider.cartethyia = {
      npm: input.sdk ?? prior?.npm ?? DEFAULT_SDK,
      options: {
        ...(prior?.options ?? {}),
        baseURL: ensureV1Suffix(input.endpoint),
        apiKey: input.apiKey,
      },
      models: { ...(prior?.models ?? {}), ...buildOpencodeModels(input.modelIds) },
    };

    const activeModel = input.activeModel ?? input.modelIds[0] ?? "";
    config.model = activeModel === "" ? "" : `cartethyia/${activeModel}`;

    if (input.websearch !== undefined) {
      config.websearch = { provider: input.websearch };
    }

    // YOLO mode: auto-approve shell/read/write. When on, write OpenCode's
    // permission rules; when off, leave whatever the user had (or nothing).
    if (input.bypassPermissions === true) {
      config.permissions = [
        { action: "shell", resource: "*", effect: "allow" },
        { action: "external_directory", resource: "*", effect: "allow" },
        { action: "question", resource: "*", effect: "deny" },
      ];
    } else if (input.bypassPermissions === false) {
      delete config.permissions;
    }

    if (!config.agent) config.agent = {};
    const subagentModel = input.subagentModel ?? input.modelIds[0] ?? activeModel;
    config.agent.explorer = {
      description: "Fast explorer subagent",
      mode: "subagent",
      model: `cartethyia/${subagentModel}`,
    };

    await writeJsonFileWithBackup(path, config);
    return otherProviders.length > 0
      ? [
          `Config already has other provider(s): ${otherProviders.join(", ")}. They were kept as-is — only cartethyia was written/updated.`,
        ]
      : undefined;
  },

  async reset(path) {
    const config = (await readJsonFile(path)) as OpencodeConfig | null;
    if (!config) return false;

    if (config.provider) {
      delete config.provider.cartethyia;
      if (Object.keys(config.provider).length === 0) delete config.provider;
    }

    if (typeof config.model === "string" && config.model.startsWith("cartethyia/")) {
      delete config.model;
    }

    if (config.agent?.explorer?.model?.startsWith("cartethyia/")) {
      delete config.agent.explorer;
      if (Object.keys(config.agent).length === 0) delete config.agent;
    }

    await writeJsonFileWithBackup(path, config);
  },

  download(input) {
    const activeModel = input.activeModel ?? input.modelIds[0] ?? "";
    const subagentModel = input.subagentModel ?? input.modelIds[0] ?? activeModel;
    const config: OpencodeConfig = {
      provider: {
        cartethyia: {
          npm: input.sdk ?? DEFAULT_SDK,
          options: {
            baseURL: ensureV1Suffix(input.endpoint),
            apiKey: input.apiKey,
          },
          models: buildOpencodeModels(input.modelIds),
        },
      },
      model: activeModel === "" ? "" : `cartethyia/${activeModel}`,
      agent: {
        explorer: {
          description: "Fast explorer subagent",
          mode: "subagent",
          model: `cartethyia/${subagentModel}`,
        },
      },
    };
    return {
      content: JSON.stringify(config, null, 2),
      filename: "opencode.json",
      mimeType: "application/json",
    };
  },

  messages: {
    applied: "OpenCode settings applied",
    reset: "Cartethyia settings removed from OpenCode",
  },
};
