// Tenant system-prompt injection contracts.
//
// Shared by the console API, the persistence store, and the dispatch-path
// transform — all Elysia-free so the dashboard bundle can import the types.

/**
 * One scope's prompt configuration. `enabled` is the master switch for the
 * scope; `mode` decides how the text meets existing system content.
 */
export interface PromptSetting {
  readonly enabled: boolean;
  readonly mode: PromptMode;
  readonly text: string;
}

export const PROMPT_MODES = ["append", "override"] as const;
export type PromptMode = (typeof PROMPT_MODES)[number];

/**
 * A named, reusable prompt. Scopes reference presets by id instead of each
 * carrying its own text, so one tone/ruleset can be applied to many scopes.
 */
export interface SystemPromptPreset {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly mode: PromptMode;
  readonly text: string;
}

/**
 * How one scope decides what to inject. Modes:
 *
 * - `off`    — explicitly inject nothing for this scope; scope-specific stop,
 *              does NOT fall through to the global prompt.
 * - `global`  — follow the tenant's global prompt (the default posture).
 * - `preset`  — use the referenced named preset (disabled preset = no inject).
 * - `custom`  — carry this scope's own prompt inline.
 *
 * A scope with no entry at all behaves as `global` (resolution falls through
 * to the global prompt), so omitting a key is the same as an explicit
 * `{ kind: "global" }` reference. The global scope itself never uses
 * `{ kind: "global" }` — it is `null` (off), a preset, or a custom setting.
 */
export type ScopePromptRef =
  | { readonly kind: "off" }
  | { readonly kind: "global" }
  | { readonly kind: "preset"; readonly presetId: string }
  | { readonly kind: "custom"; readonly setting: PromptSetting };

/** The full per-tenant configuration, one row in `tenant_system_prompts`. */
export interface TenantSystemPrompts {
  /** `null` = no global injection — distinct from an explicit disabled setting. */
  readonly global: ScopePromptRef | null;
  /** preset id → preset */
  readonly presets: Readonly<Record<string, SystemPromptPreset>>;
  /** providerId → ref */
  readonly providers: Readonly<Record<string, ScopePromptRef>>;
  /** `${providerId}::${modelId}` → ref */
  readonly models: Readonly<Record<string, ScopePromptRef>>;
  /** combo name → ref */
  readonly combos: Readonly<Record<string, ScopePromptRef>>;
  /** alias name → ref */
  readonly aliases: Readonly<Record<string, ScopePromptRef>>;
}

/** Empty configuration: nothing configured anywhere. */
export const EMPTY_TENANT_SYSTEM_PROMPTS: TenantSystemPrompts = {
  global: null,
  presets: {},
  providers: {},
  models: {},
  combos: {},
  aliases: {},
};

/** Maximum stored text per scope (5 MB). Enforced at the console API. */
export const SYSTEM_PROMPT_TEXT_CAP_BYTES = 5_000_000;

/** Maximum stored preset-name length. Enforced at the console API. */
export const SYSTEM_PROMPT_PRESET_NAME_CAP = 200;

/**
 * Marker wrapping tenant text injected into a provider wire whose upstream
 * validates the system prompt as a channel identity (the buddy family). The
 * fixed identity prompt stays the opener; the tenant text rides after it
 * inside the same turn, framed so the provider's own parser is not confused.
 */
export const SYSTEM_PROMPT_WRAPPER_PREFIX = "<cartethyia:system-prompt>";
export const SYSTEM_PROMPT_WRAPPER_SUFFIX = "</cartethyia:system-prompt>";

/** Maximum number of presets stored for one tenant. */
export const SYSTEM_PROMPT_PRESET_LIMIT = 64;

/** Maximum number of per-provider entries stored for one tenant. */
export const SYSTEM_PROMPT_PROVIDER_LIMIT = 256;

/** Maximum number of per-model entries stored for one tenant. */
export const SYSTEM_PROMPT_MODEL_LIMIT = 512;

/** Maximum number of per-combo entries stored for one tenant. */
export const SYSTEM_PROMPT_COMBO_LIMIT = 512;

/** Maximum number of per-alias entries stored for one tenant. */
export const SYSTEM_PROMPT_ALIAS_LIMIT = 512;

/**
 * Providers whose upstream validates the fixed system prompt as a channel
 * identity. Their system turn must keep the fixed prompt as the opener, so
 * tenant text is appended after it inside the same turn, wrapped in the
 * gateway's prefix/suffix markers (see `SYSTEM_PROMPT_WRAPPER_PREFIX`).
 * `override` mode is not honoured for these providers — it would strip the
 * identity and the upstream would refuse the request.
 */
const WRAPPED_INJECTION_PROVIDERS: ReadonlySet<string> = new Set([
  "cb", // CodeBuddy International
  "cbcn", // CodeBuddy CN
]);

/** Whether a provider's tenant text rides wrapped after the fixed identity prompt. */
export function isWrappedInjectionProvider(providerId: string): boolean {
  return WRAPPED_INJECTION_PROVIDERS.has(providerId);
}

/** Model-scope key for the `models` map. */
export function systemPromptModelKey(providerId: string, modelId: string): string {
  return `${providerId}::${modelId}`;
}

/** Parses a model-scope key; null when the key is malformed. */
export function parseSystemPromptModelKey(key: string): { providerId: string; modelId: string } | null {
  const index = key.indexOf("::");
  if (index <= 0 || index === key.length - 2) return null;
  return { providerId: key.slice(0, index), modelId: key.slice(index + 2) };
}

/** True when the value is a well-formed prompt setting (shape only, not size). */
export function isPromptSetting(value: unknown): value is PromptSetting {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<PromptSetting>;
  return (
    typeof candidate.enabled === "boolean" &&
    typeof candidate.mode === "string" &&
    (PROMPT_MODES as readonly string[]).includes(candidate.mode) &&
    typeof candidate.text === "string"
  );
}

/** True when the value is a well-formed preset (shape only, not size). */
export function isSystemPromptPreset(value: unknown): value is SystemPromptPreset {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<SystemPromptPreset>;
  return (
    typeof candidate.id === "string" &&
    candidate.id.length > 0 &&
    typeof candidate.name === "string" &&
    candidate.name.length > 0 &&
    typeof candidate.enabled === "boolean" &&
    typeof candidate.mode === "string" &&
    (PROMPT_MODES as readonly string[]).includes(candidate.mode) &&
    typeof candidate.text === "string"
  );
}

/** True when the value is a well-formed scope reference (shape only). */
export function isScopePromptRef(value: unknown): value is ScopePromptRef {
  if (typeof value !== "object" || value === null) return false;
  const kind = (value as { kind?: unknown }).kind;
  if (kind === "off" || kind === "global") return true;
  if (kind === "preset") {
    const presetId = (value as { presetId?: unknown }).presetId;
    return typeof presetId === "string" && presetId.length > 0;
  }
  if (kind === "custom") {
    return isPromptSetting((value as { setting?: unknown }).setting);
  }
  return false;
}
