import type {} from "../contracts";
import { ensureV1Suffix, homeDir, join, readJsonFile, writeJsonFileWithBackup } from "../fs-ops";
import type { InjectorSpec } from "../contracts";
import { DEFAULT_SDK } from "../contracts";
import { writeWebsearchPlugin, removeWebsearchPlugin } from "../cartethyia-websearch-plugin";


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
  websearch?: { provider?: string };
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
    // The provider key written by this injector is the websearch provider name
    // when one is configured, otherwise the default `cartethyia`.
    const providerId = config.websearch?.provider ?? "cartethyia";
    const provider = config.provider?.[providerId];
    const endpoint = provider?.options?.baseURL ?? null;
    const models = provider?.models ? Object.keys(provider.models) : null;
    const active =
      typeof config.model === "string" && config.model.startsWith(`${providerId}/`)
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

    // The provider key written into opencode.jsonc follows the websearch
    // provider name when one is chosen, which keeps the websearch plugin and
    // the provider block pointing at the same entry.
    const providerId = input.websearch ?? "cartethyia";

    if (!config.provider) config.provider = {};
    const prior = config.provider[providerId];
    const otherProviders = Object.keys(config.provider).filter((id) => id !== providerId);
    config.provider[providerId] = {
      npm: input.sdk ?? prior?.npm ?? DEFAULT_SDK,
      options: {
        ...(prior?.options ?? {}),
        baseURL: ensureV1Suffix(input.endpoint),
        apiKey: input.apiKey,
      },
      models: { ...(prior?.models ?? {}), ...buildOpencodeModels(input.modelIds) },
    };

    const activeModel = input.activeModel ?? input.modelIds[0] ?? "";
    config.model = activeModel === "" ? "" : `${providerId}/${activeModel}`;

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
      model: `${providerId}/${subagentModel}`,
    };

    await writeJsonFileWithBackup(path, config);

    // Write (or refresh) the websearch provider plugin when web search is
    // routed through the gateway. The plugin id follows the provider name.
    if (input.websearch !== undefined) {
      await writeWebsearchPlugin(opencodeSpec.resolveDir?.() ?? join(homeDir(), ".config", "opencode"), providerId);
    }

    return otherProviders.length > 0
      ? [
          `Config already has other provider(s): ${otherProviders.join(", ")}. They were kept as-is — only ${providerId} was written/updated.`,
        ]
      : undefined;
  },

  async reset(path) {
    const config = (await readJsonFile(path)) as OpencodeConfig | null;
    if (!config) return false;

    const providerId = config.websearch?.provider ?? "cartethyia";

    if (config.provider) {
      delete config.provider[providerId];
      if (Object.keys(config.provider).length === 0) delete config.provider;
    }

    if (typeof config.model === "string" && config.model.startsWith(`${providerId}/`)) {
      delete config.model;
    }

    if (config.agent?.explorer?.model?.startsWith(`${providerId}/`)) {
      delete config.agent.explorer;
      if (Object.keys(config.agent).length === 0) delete config.agent;
    }

    if (config.websearch) {
      delete config.websearch;
    }

    await writeJsonFileWithBackup(path, config);

    // Remove the generated websearch plugin when present.
    await removeWebsearchPlugin(opencodeSpec.resolveDir?.() ?? join(homeDir(), ".config", "opencode"), providerId);
  },

  download(input) {
    const activeModel = input.activeModel ?? input.modelIds[0] ?? "";
    const subagentModel = input.subagentModel ?? input.modelIds[0] ?? activeModel;
    const providerId = input.websearch ?? "cartethyia";
    const config: OpencodeConfig = {
      provider: {
        [providerId]: {
          npm: input.sdk ?? DEFAULT_SDK,
          options: {
            baseURL: ensureV1Suffix(input.endpoint),
            apiKey: input.apiKey,
          },
          models: buildOpencodeModels(input.modelIds),
        },
      },
      model: activeModel === "" ? "" : `${providerId}/${activeModel}`,
      ...(input.websearch !== undefined ? { websearch: { provider: input.websearch } } : {}),
      agent: {
        explorer: {
          description: "Fast explorer subagent",
          mode: "subagent",
          model: `${providerId}/${subagentModel}`,
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
