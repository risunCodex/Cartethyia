// Persistence for tenant system-prompt injection settings.
//
// One row per tenant. Mutations bump the settings revision so the dispatch
// path's revision-keyed reader converges immediately (same mechanism as the
// runtime-preferences cache).
import { eq } from "drizzle-orm";
import type { CartethyiaDatabase } from "./db-handle";
import { tenantSystemPrompts } from "./schema";
import type {
  ScopePromptRef,
  SystemPromptPreset,
  TenantSystemPrompts,
} from "../console/system-prompt/contracts";
import {
  EMPTY_TENANT_SYSTEM_PROMPTS,
  SYSTEM_PROMPT_ALIAS_LIMIT,
  SYSTEM_PROMPT_COMBO_LIMIT,
  SYSTEM_PROMPT_MODEL_LIMIT,
  SYSTEM_PROMPT_PRESET_LIMIT,
  SYSTEM_PROMPT_PROVIDER_LIMIT,
  isPromptSetting,
  isScopePromptRef,
  isSystemPromptPreset,
  parseSystemPromptModelKey,
} from "../console/system-prompt/contracts";
import { bumpSettingsRevision } from "./settings-revision";

/** The stored row, normalized. Absent row reads as the empty configuration. */
export type StoredTenantSystemPrompts = TenantSystemPrompts;

/**
 * Normalizes one scope reference value. Accepts the new `{ kind, ... }` shape
 * and the legacy per-provider entry shape (`{ followGlobal, setting? }`) so a
 * hand-edited or pre-migration row stays valid. Invalid values become
 * `undefined` (the caller drops the key).
 */
function normalizeScopeRef(value: unknown, legacyProviderEntry?: boolean): ScopePromptRef | undefined {
  if (isScopePromptRef(value)) return value;
  if (legacyProviderEntry && typeof value === "object" && value !== null) {
    const candidate = value as { followGlobal?: unknown; setting?: unknown };
    if (candidate.followGlobal === true) return { kind: "global" };
    if (candidate.followGlobal === false && isPromptSetting(candidate.setting)) {
      return { kind: "custom", setting: candidate.setting };
    }
  }
  return undefined;
}

/**
 * Reads the tenant's stored configuration, defensively normalized: a
 * hand-edited or legacy row must not poison the dispatch path, so malformed
 * entries are dropped rather than trusted.
 */
export async function readTenantSystemPrompts(
  db: CartethyiaDatabase,
  tenantId: string,
): Promise<StoredTenantSystemPrompts> {
  const rows = await db
    .select({
      global: tenantSystemPrompts.global,
      presets: tenantSystemPrompts.presets,
      providers: tenantSystemPrompts.providers,
      models: tenantSystemPrompts.models,
      combos: tenantSystemPrompts.combos,
      aliases: tenantSystemPrompts.aliases,
    })
    .from(tenantSystemPrompts)
    .where(eq(tenantSystemPrompts.tenantId, tenantId))
    .limit(1);
  const row = rows[0];
  if (row === undefined) return EMPTY_TENANT_SYSTEM_PROMPTS;

  const presets: Record<string, SystemPromptPreset> = {};
  for (const [id, preset] of Object.entries(row.presets ?? {})) {
    if (isSystemPromptPreset(preset) && preset.id === id) presets[id] = preset;
  }

  const providers: Record<string, ScopePromptRef> = {};
  for (const [providerId, value] of Object.entries(row.providers ?? {})) {
    const ref = normalizeScopeRef(value, true);
    if (ref !== undefined) providers[providerId] = ref;
  }

  const models: Record<string, ScopePromptRef> = {};
  for (const [key, value] of Object.entries(row.models ?? {})) {
    if (parseSystemPromptModelKey(key) === null) continue;
    const ref = normalizeScopeRef(value);
    if (ref !== undefined) models[key] = ref;
  }

  const combos: Record<string, ScopePromptRef> = {};
  for (const [name, value] of Object.entries(row.combos ?? {})) {
    const ref = normalizeScopeRef(value);
    if (ref !== undefined) combos[name] = ref;
  }

  const aliases: Record<string, ScopePromptRef> = {};
  for (const [name, value] of Object.entries(row.aliases ?? {})) {
    const ref = normalizeScopeRef(value);
    if (ref !== undefined) aliases[name] = ref;
  }

  return {
    global: row.global !== null && isScopePromptRef(row.global) ? row.global : null,
    presets,
    providers,
    models,
    combos,
    aliases,
  };
}

/** Upserts the tenant's configuration and bumps the settings revision. */
export async function writeTenantSystemPrompts(
  db: CartethyiaDatabase,
  tenantId: string,
  next: TenantSystemPrompts,
): Promise<void> {
  // Keep the row bounded even though the API already enforces the caps: a
  // direct store caller must not be able to plant an unbounded map.
  const presets = Object.entries(next.presets).slice(0, SYSTEM_PROMPT_PRESET_LIMIT);
  const providers = Object.entries(next.providers).slice(0, SYSTEM_PROMPT_PROVIDER_LIMIT);
  const models = Object.entries(next.models).slice(0, SYSTEM_PROMPT_MODEL_LIMIT);
  const combos = Object.entries(next.combos).slice(0, SYSTEM_PROMPT_COMBO_LIMIT);
  const aliases = Object.entries(next.aliases).slice(0, SYSTEM_PROMPT_ALIAS_LIMIT);
  const values = {
    global: next.global,
    presets: Object.fromEntries(presets),
    providers: Object.fromEntries(providers),
    models: Object.fromEntries(models),
    combos: Object.fromEntries(combos),
    aliases: Object.fromEntries(aliases),
    updatedAt: new Date(),
  };
  await db
    .insert(tenantSystemPrompts)
    .values({ tenantId, ...values })
    .onConflictDoUpdate({ target: tenantSystemPrompts.tenantId, set: values });
  bumpSettingsRevision();
}

/** Clears the tenant's configuration entirely (console "reset" path). */
export async function clearTenantSystemPrompts(
  db: CartethyiaDatabase,
  tenantId: string,
): Promise<void> {
  await db.delete(tenantSystemPrompts).where(eq(tenantSystemPrompts.tenantId, tenantId));
  bumpSettingsRevision();
}
