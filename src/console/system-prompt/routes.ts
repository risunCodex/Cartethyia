// Console API for tenant system-prompt injection.
//
// GET    /system-prompt → the stored configuration
// PUT    /system-prompt → replace the configuration wholesale
// DELETE /system-prompt → clear it entirely
//
// The PUT replaces the row: the modal edits the whole three-scope shape at
// once, so a PATCH surface would add states the UI never produces. Text is
// capped at 5 MB per scope and the provider/model maps are bounded, matching
// the store's own defensive limits.
import { Elysia, t } from "elysia";
import type { ConsoleAccessResolver } from "../auth/access";
import { ConsoleDomainError, consoleErrorHandler, requireTenantScope } from "../shared/errors";
import type { AuditSink } from "../audit/contracts";
import type { CartethyiaDatabase } from "../../persistence/db-handle";
import {
  clearTenantSystemPrompts,
  readTenantSystemPrompts,
  writeTenantSystemPrompts,
} from "../../persistence/system-prompt-store";
import {
  EMPTY_TENANT_SYSTEM_PROMPTS,
  PROMPT_MODES,
  SYSTEM_PROMPT_ALIAS_LIMIT,
  SYSTEM_PROMPT_COMBO_LIMIT,
  SYSTEM_PROMPT_MODEL_LIMIT,
  SYSTEM_PROMPT_PRESET_LIMIT,
  SYSTEM_PROMPT_PRESET_NAME_CAP,
  SYSTEM_PROMPT_PROVIDER_LIMIT,
  SYSTEM_PROMPT_TEXT_CAP_BYTES,
  isPromptSetting,
  isScopePromptRef,
  isSystemPromptPreset,
  parseSystemPromptModelKey,
  type PromptSetting,
  type ScopePromptRef,
  type SystemPromptPreset,
  type TenantSystemPrompts,
} from "./contracts";

/** Route-group context injected by the composition root. */
export interface SystemPromptRoutesConfig {
  readonly db: CartethyiaDatabase;
  readonly accessResolver: ConsoleAccessResolver;
  readonly auditSink?: AuditSink;
}

/** Validates one scope setting, including the 5 MB text cap. */
function validateSetting(value: unknown, scopeLabel: string): PromptSetting {
  if (!isPromptSetting(value)) {
    throw new ConsoleDomainError("invalid_request", 400, `${scopeLabel} is not a valid prompt setting`);
  }
  const bytes = Buffer.byteLength(value.text, "utf8");
  if (bytes > SYSTEM_PROMPT_TEXT_CAP_BYTES) {
    throw new ConsoleDomainError("payload_too_large", 413, `${scopeLabel} exceeds the 5 MB limit`);
  }
  if (!(PROMPT_MODES as readonly string[]).includes(value.mode)) {
    throw new ConsoleDomainError("invalid_request", 400, `${scopeLabel} has an invalid mode`);
  }
  return value;
}

/** Validates one preset. */
function validatePreset(value: unknown, scopeLabel: string): SystemPromptPreset {
  if (!isSystemPromptPreset(value)) {
    throw new ConsoleDomainError("invalid_request", 400, `${scopeLabel} is not a valid preset`);
  }
  if (value.name.length > SYSTEM_PROMPT_PRESET_NAME_CAP) {
    throw new ConsoleDomainError(
      "invalid_request",
      400,
      `${scopeLabel} name exceeds the ${SYSTEM_PROMPT_PRESET_NAME_CAP} character limit`,
    );
  }
  validateSetting(value, scopeLabel);
  return value;
}

/** Validates one scope reference; preset ids must exist when provided. */
function validateScopeRef(
  value: unknown,
  scopeLabel: string,
  presetIds: ReadonlySet<string>,
): ScopePromptRef {
  if (!isScopePromptRef(value)) {
    throw new ConsoleDomainError("invalid_request", 400, `${scopeLabel} is not a valid scope reference`);
  }
  if (value.kind === "preset") {
    if (!presetIds.has(value.presetId)) {
      throw new ConsoleDomainError("invalid_request", 400, `${scopeLabel} references an unknown preset`);
    }
    return value;
  }
  if (value.kind === "custom") {
    validateSetting(value.setting, scopeLabel);
    return value;
  }
  return value;
}

/** Validates the full PUT body into the stored shape. */
function validateBody(value: unknown): TenantSystemPrompts {
  if (typeof value !== "object" || value === null) {
    throw new ConsoleDomainError("invalid_request", 400, "Body must be an object");
  }
  const body = value as {
    global?: unknown;
    presets?: unknown;
    providers?: unknown;
    models?: unknown;
    combos?: unknown;
    aliases?: unknown;
  };

  const global =
    body.global === null || body.global === undefined
      ? null
      : validateSetting(body.global, "global");

  if (body.presets !== undefined && typeof body.presets !== "object") {
    throw new ConsoleDomainError("invalid_request", 400, "presets must be an object");
  }
  const rawPresets = (body.presets ?? {}) as Record<string, unknown>;
  const presetIds = Object.keys(rawPresets);
  if (presetIds.length > SYSTEM_PROMPT_PRESET_LIMIT) {
    throw new ConsoleDomainError(
      "invalid_request",
      400,
      `presets exceeds the ${SYSTEM_PROMPT_PRESET_LIMIT} entry limit`,
    );
  }
  const presets: Record<string, SystemPromptPreset> = {};
  for (const id of presetIds) {
    presets[id] = validatePreset(rawPresets[id], `preset ${id}`);
  }
  const presetIdSet = new Set(presetIds);

  const readRefMap = (
    raw: unknown,
    label: string,
    limit: number,
  ): Record<string, ScopePromptRef> => {
    if (raw !== undefined && typeof raw !== "object") {
      throw new ConsoleDomainError("invalid_request", 400, `${label} must be an object`);
    }
    const entries = (raw ?? {}) as Record<string, unknown>;
    const keys = Object.keys(entries);
    if (keys.length > limit) {
      throw new ConsoleDomainError(
        "invalid_request",
        400,
        `${label} exceeds the ${limit} entry limit`,
      );
    }
    const out: Record<string, ScopePromptRef> = {};
    for (const key of keys) {
      out[key] = validateScopeRef(entries[key], `${label} ${key}`, presetIdSet);
    }
    return out;
  };

  const providers = readRefMap(body.providers, "providers", SYSTEM_PROMPT_PROVIDER_LIMIT);
  const models = readRefMap(body.models, "models", SYSTEM_PROMPT_MODEL_LIMIT);
  for (const key of Object.keys(models)) {
    if (parseSystemPromptModelKey(key) === null) {
      throw new ConsoleDomainError("invalid_request", 400, `model key ${key} is malformed`);
    }
  }
  const combos = readRefMap(body.combos, "combos", SYSTEM_PROMPT_COMBO_LIMIT);
  const aliases = readRefMap(body.aliases, "aliases", SYSTEM_PROMPT_ALIAS_LIMIT);

  return { global, presets, providers, models, combos, aliases };
}

/**
 * The return type is inferred rather than annotated as `Elysia`: `.error()`
 * widens the instance type with its handler's response envelope, so the
 * annotated base type no longer matches the chained result (same reason the
 * remote-support routes leave it inferred).
 */
export function createSystemPromptRoutes(config: SystemPromptRoutesConfig) {
  return new Elysia()
    .error(consoleErrorHandler("System prompt settings failed"))
    .get("/system-prompt", async ({ request }) => {
      const access = requireTenantScope(config.accessResolver(request), "dashboard:read");
      return await readTenantSystemPrompts(config.db, access.tenantId);
    })
    .put(
      "/system-prompt",
      { body: t.Any() },
      async ({ request, body }) => {
        const access = requireTenantScope(config.accessResolver(request), "dashboard:write");
        const next = validateBody(body);
        await writeTenantSystemPrompts(config.db, access.tenantId, next);
        await config.auditSink?.record({
          access,
          action: "system_prompt.update",
          target: "tenant_system_prompts",
          detail: {
            global: next.global !== null,
            presets: Object.keys(next.presets).length,
            providers: Object.keys(next.providers).length,
            models: Object.keys(next.models).length,
            combos: Object.keys(next.combos).length,
            aliases: Object.keys(next.aliases).length,
          },
        });
        return next;
      },
    )
    .delete("/system-prompt", async ({ request }) => {
      const access = requireTenantScope(config.accessResolver(request), "dashboard:write");
      await clearTenantSystemPrompts(config.db, access.tenantId);
      return EMPTY_TENANT_SYSTEM_PROMPTS;
    });
}
