// CLI tool contracts and registry definitions.
import { ensureV1Suffix } from "./fs-ops";

// ── contracts.ts ──
/**
 * CLI Tools type contracts — shared across registry, injectors, service,
 * dashboard, and API routes.
 *
 * Each supported CLI coding agent ([CC], Codex, Kilo, OpenCode) has a `ToolDef`
 * with static metadata and a paired `ToolInjector` that reads and writes the
 * tool's config files on the host filesystem. The dashboard picks an API key +
 * models, POSTs to the backend, and the injector merges Cartethyia-specific
 * fields into the tool's config without clobbering user settings.
 */

/**
 * Cartethyia proxy surface a CLI tool targets. Registry/source material from a
 * sibling project used `openai-chat | openai-responses | anthropic-messages`;
 * Cartethyia's canonical surface vocabulary is the shorter form.
 */
type CliToolSurface = "chat" | "responses" | "messages";

/** How the tool's config is managed. */
type ConfigType = "env" | "custom";

/** A native model slot exposed by a CLI tool. */
interface ToolModelDef {
  readonly id: string;
  readonly name: string;
  readonly alias: string;
  /** Human-readable slot label shown in the dashboard. */
  readonly roleLabel?: string;
  /** Injector slot used for semantic roles such as Codex's subagent. */
  readonly roleKind?: "primary" | "subagent" | "secondary" | "review";
  readonly defaultValue?: string;
}

/** A persisted harness-specific route mapping for one native model slot. */
export interface CliModelMapping {
  readonly slotKey: string;
  readonly sourceModel: string;
  readonly targetModel: string;
  readonly enabled: boolean;
}

/** Mapping settings sent with a CLI configuration apply request. */
export interface CliMappingInput {
  readonly enabled: boolean;
  readonly mappings: readonly CliModelMapping[];
}

/** The user-facing routing mode for a CLI tool: `remote` routes are resolved by the gateway, `local` routes are baked into the tool's own config file. */
export type CliMappingMode = "remote" | "local";

/**
 * The default runtime SDK package for OpenCode: its native
 * `@opencode/ai/providers/openai-compatible` package (bundled with OpenCode
 * itself, not the AI SDK).
 */
export const DEFAULT_SDK: string = "@opencode/ai/providers/openai-compatible";

/** Persisted mapping settings for one CLI tool + API key pair. */
export interface CliMappingSettings {
  readonly toolId: string;
  readonly tenantId: string;
  readonly apiKeyId: string;
  readonly enabled: boolean;
  readonly mappings: readonly CliModelMapping[];
}

/** A note shown in the tool card UI. */
interface ToolNote {
  readonly type: "info" | "warning" | "error";
  readonly text: string;
}

/** Static metadata for a CLI tool — consumed by both backend and frontend. */
export interface ToolDef {
  readonly id: string;
  readonly name: string;
  readonly color: string;
  readonly description: string;
  readonly configType: ConfigType;
  readonly surface: CliToolSurface;
  readonly defaultModels: readonly ToolModelDef[];
  readonly settingsFile?: string;
  readonly docsUrl?: string;
  readonly notes?: readonly ToolNote[];
  /**
   * How this tool's slot→route mapping behaves, which also decides whether the
   * tool has a mapping surface at all.
   *
   * - `remote` — the CLI sends its own native model names and the gateway
   *   reroutes them, so a slot has an independent *target* route. Only this
   *   mode has a mapping table, and only keys carrying `routing:cli_mapping`
   *   may consume it.
   * - `local` — the tool's config file itself carries the routed model name,
   *   so a slot has one value (written to the file) rather than a separate
   *   target. There is nothing to persist; the model is baked into the file.
   *
   * Absent means the tool exposes no configurable model slots at all.
   */
  readonly mappingMode?: CliMappingMode;
}

/**
 * Secret-free projection of `ToolDef` sent to the dashboard.
 *
 * The browser must never receive `InjectorSpec` callbacks or host filesystem
 * paths it cannot use; it needs metadata, the model slots, and whether a
 * persisted mapping surface exists. `mappingSupported` is derived from
 * `ToolDef.mappingMode` rather than stored, so the two can never disagree.
 */
export type ToolRegistryEntry = Pick<
  ToolDef,
  | "id"
  | "name"
  | "color"
  | "description"
  | "configType"
  | "surface"
  | "mappingMode"
  | "defaultModels"
  | "settingsFile"
  | "docsUrl"
  | "notes"
> & { readonly mappingSupported: boolean };

/** Runtime status of a CLI tool on the host. */
export interface ToolStatus {
  readonly toolId: string;
  readonly installed: boolean;
  /** True if the tool's config already points to a Cartethyia endpoint. */
  readonly configured: boolean;
  readonly settingsPath: string | null;
  readonly currentEndpoint: string | null;
  /** Sanitized key prefix — never the full secret. */
  readonly currentApiKeyPrefix: string | null;
  readonly currentModels: readonly string[] | null;
  readonly message?: string;
}

/** Input from the dashboard when applying Cartethyia config to a tool. */
export interface ApplyInput {
  /** Raw endpoint URL, e.g. "http://localhost:12800". Each injector normalizes as needed. */
  readonly endpoint: string;
  /** Full API key secret from Cartethyia's key store. */
  readonly apiKey: string;
  /** Ordered model identifiers used by positional tool slots. */
  readonly modelIds: readonly string[];
  /** Native model values keyed by the tool's semantic slot names. */
  readonly modelSlots?: Readonly<Record<string, string>>;
  /** Which model to set as active/primary (optional, defaults to modelIds[0]). */
  readonly activeModel?: string;
  /** Subagent model (for tools that support it, e.g. Codex, OpenCode). */
  readonly subagentModel?: string;
  /** API-key or share-template id that owns the remote mappings. */
  readonly mappingOwnerId?: string;
  /** Harness-specific mappings persisted separately from native CLI config. */
  readonly mapping?: CliMappingInput;
  /** Enables [CC]'s bypass-permissions (YOLO) mode when explicitly selected. */
  readonly bypassPermissions?: boolean;
  /**
   * The runtime SDK package to write into the tool's config (e.g. OpenCode's
   * `provider.*.npm`). Absent = the tool's default.
   */
  readonly sdk?: string;
  /**
   * WebSearch provider selection written into OpenCode's config. "carte"
   * routes search through the Cartethyia gateway; "native" (or absent) leaves
   * OpenCode's own provider selection in place.
   */
  readonly websearch?: string;
}

/** Result of an apply or reset operation. */
export interface ApplyResult {
  readonly success: boolean;
  readonly settingsPath?: string;
  readonly message: string;
  /** Non-fatal notes for the operator, e.g. preserved pre-existing providers. */
  readonly warnings?: readonly string[];
}

/**
 * What an apply actually did.
 *
 * A tool is written in one of two ways and the operator must be able to tell
 * which one happened, because they have different reach:
 * - `file` — this process wrote the tool's config on the host it runs on. Only
 *   useful when the CLI and the gateway share a machine.
 * - `remote` — nothing was written to disk; the tool resolves the mapping from
 *   persisted routing rows on each `/v1/*` call. Works when the gateway is
 *   remote, containerised, or the CLI lives on another machine.
 * - `both` — the tool's config was written and a remote route was recorded.
 * - `none` — nothing ran: the tool has no injectable config and the request
 *   asked for no remote route. Reported rather than folded into `file`, so
 *   the UI never claims a write that did not happen.
 */
export type ApplyOutcome = "file" | "remote" | "both" | "none";

/** Result of an apply operation, including which delivery paths ran. */
export interface ApplyConfigResult {
  readonly outcome: ApplyOutcome;
  /** True when the tool's config file on this host was written. */
  readonly wroteFile: boolean;
  /** True when persisted routing rows were saved for this tool. */
  readonly savedRemoteRoute: boolean;
  readonly settingsPath?: string;
  readonly message: string;
  /** Non-fatal notes for the operator (see `ApplyResult.warnings`). */
  readonly warnings?: readonly string[];
}

/** Result of a download-config operation. */
export interface DownloadResult {
  readonly content: string;
  readonly filename: string;
  readonly mimeType: string;
}

/**
 * Injector contract — one per tool.
 */
export interface ToolInjector {
  readonly toolId: string;
  getStatus(): Promise<ToolStatus>;
  apply(input: ApplyInput): Promise<ApplyResult>;
  reset(): Promise<ApplyResult>;
  download(input: ApplyInput): Promise<DownloadResult>;
}

/** Batch status response for all-statuses endpoint. */
export type AllStatusesResult = Readonly<Record<string, ToolStatus>>;

/** Status details extracted from a tool's configuration file(s). */
interface StatusDetails {
  readonly configured: boolean;
  readonly currentEndpoint?: string | null | undefined;
  readonly currentApiKeyPrefix?: string | null | undefined;
  readonly rawApiKey?: string | null | undefined;
  readonly currentModels?: readonly string[] | null | undefined;
  readonly message?: string | undefined;
}

/**
 * The three values almost every `apply` and `download` starts from.
 *
 * Nearly all of them resolved the active model and the `/v1`-normalized
 * endpoint by hand, which is why one typo in that pair could differ per tool.
 * `resolveApplyTarget` is the one place they are decided; a tool whose slot
 * naming differs passes a `model` resolver.
 */
export interface ApplyTarget {
  /** The model to write as active/primary. Empty when the request named none. */
  readonly model: string;
  /** The endpoint with its `/v1` suffix ensured. */
  readonly baseUrl: string;
}

/** Resolves the model and endpoint one apply or download is built from. */
export function resolveApplyTarget(input: ApplyInput): ApplyTarget {
  return {
    model: input.activeModel ?? input.modelIds[0] ?? "",
    baseUrl: ensureV1Suffix(input.endpoint),
  };
}

/**
 * Builds a `DownloadResult` for the common case: one text payload with a
 * filename and a media type.
 *
 * Eight injectors returned `{ content, filename, mimeType }` from a string they
 * had already built, differing only in those two constants.
 */
export function textDownload(
  content: string,
  options: { readonly filename: string; readonly mimeType?: string | undefined },
): DownloadResult {
  return {
    content,
    filename: options.filename,
    mimeType: options.mimeType ?? "text/plain",
  };
}

/** Like `textDownload`, for the JSON-shaped payloads. */
export function jsonDownload(
  value: unknown,
  options: { readonly filename: string },
): DownloadResult {
  return {
    content: JSON.stringify(value, null, 2),
    filename: options.filename,
    mimeType: "application/json",
  };
}

/**
 * Declarative specification for a file-based CLI tool injector.
 */
export interface InjectorSpec {
  readonly toolId: ToolId;
  readonly displayName?: string | undefined;

  /** Primary binary name to probe on PATH or fallback path */
  readonly binary?: string | undefined;

  /** Custom check for whether the tool is installed */
  readonly checkInstalled?: ((path: string) => Promise<boolean> | boolean) | undefined;

  /** If true, return settingsPath even when tool is not installed and file is missing */
  readonly keepSettingsPathOnMissing?: boolean | undefined;

  /** If true, always execute reset() even if the primary settings file does not exist */
  readonly resetEvenIfMissing?: boolean | undefined;

  /** Resolve the primary settings file path */
  readonly resolvePath: () => string;

  /** Resolve directory that must exist before applying settings (defaults to dirname(resolvePath())) */
  readonly resolveDir?: (() => string) | undefined;

  /** Extract status details from existing settings file(s) */
  readonly readStatus: (path: string) => Promise<StatusDetails> | StatusDetails;

  /**
   * Apply Cartethyia configuration to the settings file(s). Return an array of
   * non-fatal warning strings to surface them to the operator (e.g. preserved
   * pre-existing providers).
   */
  readonly apply: (input: ApplyInput, path: string) => Promise<readonly string[] | void> | readonly string[] | void;

  /**
   * Reset Cartethyia configuration from settings file(s).
   * Returning `false` indicates no settings file was present to reset.
   */
  readonly reset: (path: string) => Promise<void | boolean> | void | boolean;

  /** Generate in-memory download payload without writing to disk */
  readonly download: (input: ApplyInput) => Promise<DownloadResult> | DownloadResult;

  /** Optional custom message overrides */
  readonly messages?:
    | {
        readonly applied?: string | undefined;
        readonly reset?: string | undefined;
        readonly resetMissing?: string | undefined;
      }
    | undefined;
}

// ── registry.ts ──
/**
 * CLI Tools registry — static metadata for every supported tool.
 *
 * Consumed by the backend service (for injector dispatch) and sent to the
 * frontend via GET /console/api/cli-tools/registry. MITM-based tools are
 * excluded — Cartethyia does not run a MITM proxy.
 */

export const TOOL_REGISTRY = {
  // ── File-injected tools (config written to filesystem) ────────────────
  claude: {
    id: "claude",
    name: "Claude Code",
    color: "#D97757",
    description: "Anthropic Claude Code CLI (native Messages API)",
    configType: "env" as const,
    surface: "messages" as const,
    settingsFile: "~/.claude/settings.json",
    mappingMode: "remote" as const,
    defaultModels: [
      {
        id: "opus",
        name: "Claude Opus",
        alias: "opus",
        roleLabel: "Opus family",
        roleKind: "secondary",
      },
      {
        id: "sonnet",
        name: "Claude Sonnet",
        alias: "sonnet",
        roleLabel: "Sonnet family",
        roleKind: "primary",
      },
      {
        id: "haiku",
        name: "Claude Haiku",
        alias: "haiku",
        roleLabel: "Haiku family",
        roleKind: "secondary",
      },
      {
        id: "fable",
        name: "Claude Fable",
        alias: "fable",
        roleLabel: "Fable family",
        roleKind: "secondary",
      },
      {
        id: "mythos",
        name: "Claude Mythos",
        alias: "mythos",
        roleLabel: "Mythos family",
        roleKind: "secondary",
      },
    ],
  },

  codex: {
    id: "codex",
    name: "OpenAI Codex CLI",
    color: "#10A37F",
    description: "OpenAI Codex CLI with Responses API, subagents, and review roles",
    configType: "custom" as const,
    surface: "responses" as const,
    mappingMode: "remote" as const,
    settingsFile: "~/.codex/config.toml",
    docsUrl: "https://developers.openai.com/codex/config-reference",
    defaultModels: [
      {
        id: "gpt-5.6-sol",
        name: "GPT-5.6 Sol",
        alias: "session",
        roleLabel: "Primary session",
        roleKind: "primary",
        defaultValue: "gpt-5.6-sol",
      },
      {
        id: "gpt-5.5",
        name: "GPT-5.5",
        alias: "subagent",
        roleLabel: "Spawned subagents",
        roleKind: "subagent",
        defaultValue: "gpt-5.5",
      },
      {
        // Codex's Guardian auto-review agent always sends the hardcoded
        // `codex-auto-review` model. It must be routable for approval reviews
        // to work at all, so it is a first-class mapping slot here. The `id`
        // is qualified (routable via the codex provider) while `defaultValue`
        // carries the exact spelling Codex sends — the source the gateway maps.
        id: "codex/codex-auto-review",
        name: "Codex Auto Review",
        alias: "review",
        roleLabel: "Review (Guardian)",
        roleKind: "review",
        defaultValue: "codex-auto-review",
      },
    ],
  },

  opencode: {
    id: "opencode",
    name: "OpenCode",
    color: "#E87040",
    description: "OpenCode AI Terminal Assistant",
    configType: "custom" as const,
    surface: "chat" as const,
    settingsFile: "~/.config/opencode/opencode.json",
    defaultModels: [
      {
        id: "claude/claude-sonnet-5",
        name: "Claude Sonnet 5",
        alias: "sonnet",
        roleLabel: "Primary Agent",
        roleKind: "primary",
      },
      {
        id: "gpt-5.6-sol",
        name: "GPT-5.6 Sol",
        alias: "gpt-5.6-sol",
        roleLabel: "Fallback Agent",
        roleKind: "secondary",
      },
    ],
  },

  kilo: {
    id: "kilo",
    name: "Kilo Code",
    color: "#FF6B6B",
    description: "Kilo Code AI Assistant (VS Code)",
    configType: "custom" as const,
    surface: "chat" as const,
    settingsFile: "~/.local/share/kilo/auth.json",
    defaultModels: [{ id: "claude/claude-sonnet-5", name: "Claude Sonnet 5", alias: "sonnet" }],
  },
} satisfies Record<string, ToolDef>;

export type ToolId = keyof typeof TOOL_REGISTRY;

/** Ordered list of tool IDs for iteration. */
export const TOOL_IDS: readonly ToolId[] = Object.keys(TOOL_REGISTRY) as ToolId[];
