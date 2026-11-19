// Pure route-catalog helpers: capability/profile projection, identity
// resolution, and the column projections/merges the snapshot read uses. The
// only state here is the bounded capability-profile memo; everything else is
// a pure function of its inputs. The snapshot assembly lives in
// `route-catalog-repository.ts`; this module is re-exported by
// `route-catalog.ts` for the public surface.

import {
  models,
  modelAliases,
  modelCombos,
  networkPools,
  poolRoutingSettings,
  providerAccounts,
  providerPoolAccounts,
  providerRoutingSettings,
  providers,
  tenantDisabledModels,
  cliToolMappings,
  cliToolSettings,
} from "../../persistence/schema";
import { resolveTenantOverride } from "../../persistence/tenant-scope";
import type { ServiceKind, WireFamily } from "../../protocol/canonical-model";
import { BoundedLruMap } from "../../shared/bounded-lru";
import { buildClaudeCliUserAgent } from "../../providers/operations/custom-cli-headers";
import { isBundledProviderId } from "../../providers/provider-contracts";
import { providerHasAdapterUserAgent, providerUsesBespokeWire } from "../../providers/provider-metadata";

const CLAUDE_MODEL_FAMILIES = new Set(["opus", "sonnet", "haiku", "fable", "mythos"]);

/** Codex's built-in review-model spellings worth matching. */
const CODEX_REVIEW_MODELS = new Set(["codex-auto-review"]);

export function cliMappingSourceKeys(toolId: string, sourceModel: string): readonly string[] {
  if (toolId === "codex") {
    const normalized = sourceModel.trim().toLowerCase();
    if (CODEX_REVIEW_MODELS.has(normalized)) {
      // Guardian's auto-review model is one fixed spelling; surface the full
      // spelling plus the bare family so a slot mapped to either one hits.
      return [...new Set([sourceModel, "codex-auto-review"])];
    }
    return [sourceModel];
  }
  if (toolId !== "claude") return [sourceModel];
  const normalized = sourceModel.trim().toLowerCase();
  const family =
    CLAUDE_MODEL_FAMILIES.has(normalized)
      ? normalized
      : /^claude-(opus|sonnet|haiku|fable|mythos)(?:-|$)/.exec(normalized)?.[1];
  if (normalized.includes("/") || family === undefined) return [sourceModel];
  return [...new Set([
    sourceModel,
    family,
    `claude-${family}-5`,
    `claude-${family}-5-1`,
    `claude-${family}-5-5`,
    `claude-${family}-4-6`,
    `claude-${family}-4-5`,
  ])];
}

/**
 * Projects one model row's metadata into the capability gates the router
 * filters candidates by. Exported so the projection contract is unit-testable
 * without a database.
 */
export function buildCapabilityProfile(row: {
  modalities: unknown;
  reasoning: boolean;
  toolCall: boolean;
  providerId: string;
}): Record<string, boolean> {
  const mods =
    row.modalities != null && typeof row.modalities === "object"
      ? (row.modalities as { input?: unknown[]; output?: unknown[] })
      : {};
  const inputMods = Array.isArray(mods.input) ? mods.input : [];
  const outputMods = Array.isArray(mods.output) ? mods.output : [];
  // The canonical chat and responses codecs encode `image`, `document`/`file`,
  // and `audio` parts; the messages codec encodes the first two but has no
  // audio block (see `AUDIO_CAPABLE_WIRE_FAMILIES`). A bespoke adapter (Cursor)
  // frames its own protocol and has no generic rich-content path.
  //
  // The codec grant is a **fallback for rows with no modality metadata**, not
  // an override: `defineModel` always seeds `"text"`, so a non-empty array is
  // an explicit declaration and its contents are authoritative — a row that
  // declares `["text"]` is a text-only row and the router must strip the image
  // rather than forward it to an upstream that rejects it. An empty array is a
  // discovered or legacy row that carried no metadata, and pass-through keeps
  // a caller's attachment from being degraded on the strength of a guess.
  // Whether a given upstream model accepts the part is still the upstream's
  // call — a capability declared here only decides whether the router strips
  // the part before it ever sees it, and the audio grant is narrowed per wire
  // family at projection time.
  const codecEncodesRichContent = !providerUsesBespokeWire(row.providerId);
  const declaredInput = inputMods.length > 0;
  const richContentByCodec = codecEncodesRichContent && !declaredInput;
  // Reasoning and tools are never stripped here. A `false` flag — whether a
  // discovered row recorded it for lack of metadata, or a catalog row set it
  // explicitly — must not become a silent rewrite of a request the caller
  // asked for. The upstream decides whether it can serve them and returns its
  // own error if it cannot.
  return {
    // The route is not served by a canonical codec. Carried in the profile
    // because the capability predicates downstream see only this snapshot, not
    // the provider registry.
    bespokeWire: !codecEncodesRichContent,
    image: inputMods.includes("image") || richContentByCodec,
    document: inputMods.includes("document") || richContentByCodec,
    audio: inputMods.includes("audio") || richContentByCodec,
    mediaGeneration: outputMods.includes("image"),
    tools: true,
    parallelToolCalls: true,
    reasoning: true,
    reasoningEncryptedContent: true,
    // Search is its own route: a `websearch` row answers `POST /v1/search`.
    // A chat row never claims it; a hosted declaration rides through `tools`.
    webSearch: false,
    responseJsonObject: true,
    responseJsonSchema: true,
    promptCaching: true,
  };
}

/**
 * Upper bound on the capability-profile memo. Same value as the hand-rolled
 * bound it replaces: far above any real catalog, so eviction only ever targets
 * rows deleted from the catalog.
 */
const CAPABILITY_PROFILE_CACHE_MAX_ENTRIES = 4096;
const capabilityProfileCache = new BoundedLruMap<string, Record<string, boolean>>(
  CAPABILITY_PROFILE_CACHE_MAX_ENTRIES,
);

/**
 * The capability profile for one model row, memoized across rebuilds.
 *
 * The value is a pure function of the row's metadata, so two rebuilds that see
 * the same row get the same object instead of two identical ones. The cache is
 * a {@link BoundedLruMap} keyed by `providerId/modelId` **plus the row's
 * modalities**: the key must change when the operator edits a row's modalities
 * (text-only → vision), otherwise the rebuild would hand routing the stale
 * pre-edit profile until the entry aged out of the LRU. A row that has never
 * carried modality metadata keys with `null`, which only collides with another
 * metadata-less row for the same provider/model — the same profile by
 * construction.
 */
export function capabilityProfileFor(row: {
  modalities: unknown;
  reasoning: boolean;
  toolCall: boolean;
  providerId: string;
  modelId: string;
}): Record<string, boolean> {
  const key = `${row.providerId}/${row.modelId}/${JSON.stringify(row.modalities ?? null)}`;
  const cached = capabilityProfileCache.get(key);
  if (cached !== undefined) return cached;
  const profile = buildCapabilityProfile(row);
  capabilityProfileCache.set(key, profile);
  return profile;
}

/** Live memo size, for tests and the metrics gauge. */
export function capabilityProfileCacheSize(): number {
  return capabilityProfileCache.size;
}

/** Resolves route identity: bundled adapters without a native User-Agent builder, plus custom providers. */
export function resolveRouteUserAgent(
  providerId: string,
  tenantUserAgent: string | undefined,
  globalUserAgent: string | undefined,
): string | undefined {
  if (isBundledProviderId(providerId)) {
    // A bundled adapter that frames its own identity headers never consumes a
    // route User-Agent (Command Code, Qoder, buddy, ...), so it never gets one
    // — the control is hidden for it too.
    if (providerHasAdapterUserAgent(providerId)) return undefined;
    // Bundled API-key providers: an operator who set no identity of their own
    // gets the Claude Code CLI identity, resolved live so the stamped version
    // tracks discovery. This used to be a frozen `codex_cli_rs` literal, which
    // named a different vendor's client on requests that mostly reached neither.
    const selected = resolveTenantOverride(
      tenantUserAgent,
      globalUserAgent,
      buildClaudeCliUserAgent(),
    );
    return selected.trim() === "" ? undefined : selected;
  }
  // Custom (BYOK) providers: only an explicit operator choice rides on the
  // route; the adapter owns the default otherwise (see `registerByokProviders`).
  // An explicit empty choice ("None") is preserved so the adapter can honor it.
  const selected = resolveTenantOverride(tenantUserAgent, globalUserAgent, undefined);
  return selected === undefined ? undefined : selected.trim();
}

/** One persisted model row ready for candidate construction. */
export interface MergedModelRow {
  providerId: string;
  modelId: string;
  wireFamily: WireFamily;
  dialect?: string | null;
  serviceKind: ServiceKind;
  endpointPath: string;
  modalities: unknown;
  outputLimit: number | null;
  reasoning: boolean;
  toolCall: boolean;
  enabled: boolean;
  proOnly: boolean | null;
  /** Whether the provider publishes the row as free. Read for plan logging. */
  freeTier: boolean | null;
}
/**
 * Converts persisted model rows into candidate input. Seed materialization is
 * performed before this function runs, so no static-vs-DB merge is needed.
 */
export function mergeModelCatalog(
  dbRows: readonly ModelRouteRow[],
): MergedModelRow[] {
  return dbRows
    .filter((row) => row.enabled)
    .map((row) => ({
      providerId: row.providerId,
      modelId: row.modelId,
      wireFamily: row.wireFamily as WireFamily,
      ...(row.dialect === null ? {} : { dialect: row.dialect }),
      serviceKind: row.serviceKind as ServiceKind,
      endpointPath: row.endpointPath,
      modalities: row.modalities,
      outputLimit: row.outputLimit,
      reasoning: row.reasoning,
      toolCall: row.toolCall,
      enabled: row.enabled,
      freeTier: row.freeTier ?? null,
      proOnly: row.proOnly ?? null,
    }));
}

/**
 * Column projections for the snapshot read.
 *
 * The builder reads a handful of fields from each table, but the read used to
 * be a bare `select()` — every column of all ten tables, including
 * `provider_accounts.credential_ciphertext` and `network_pools.
 * endpoint_config`, which the snapshot never touches. That ciphertext is the
 * largest thing the gateway stores per account, and the snapshot is rebuilt on
 * every catalog change, so the bytes were transferred and then discarded on
 * every rebuild. The projection keeps the query count at ten and drops the
 * payload to what is actually read.
 *
 * Each object doubles as the row type (`ModelRouteRow` and friends are derived
 * from it), so a column added here is automatically typed, and a column the
 * builder starts reading but is missing here fails to compile rather than
 * silently reading `undefined`.
 */
export const PROVIDER_COLUMNS = {
  id: providers.id,
  tenantId: providers.tenantId,
  requiresAccount: providers.requiresAccount,
} as const;

export const MODEL_COLUMNS = {
  providerId: models.providerId,
  modelId: models.modelId,
  wireFamily: models.wireFamily,
  dialect: models.dialect,
  serviceKind: models.serviceKind,
  endpointPath: models.endpointPath,
  modalities: models.modalities,
  outputLimit: models.outputLimit,
  reasoning: models.reasoning,
  toolCall: models.toolCall,
  enabled: models.enabled,
  // Carried for the plan gate: an upstream may refuse a model on a free plan,
  // and only the row says which. See `planAllowsModel`.
  proOnly: models.proOnly,
  // Carried alongside it: the provider's own statement that the row is free,
  // which is the other half of the same plan question.
  freeTier: models.freeTier,
} as const;
export const ACCOUNT_COLUMNS = {
  id: providerAccounts.id,
  providerId: providerAccounts.providerId,
  tenantId: providerAccounts.tenantId,
  label: providerAccounts.label,
  status: providerAccounts.status,
  cooldownUntil: providerAccounts.cooldownUntil,
  modelCooldowns: providerAccounts.modelCooldowns,
  lastErrorCategory: providerAccounts.lastErrorCategory,
  // The account's last reported plan. Read here rather than from the quota
  // cache, which is empty on a cold start — exactly when routing must not be
  // guessing whether an account is free.
  quotaPlan: providerAccounts.quotaPlan,
} as const;

export const ALIAS_COLUMNS = {
  tenantId: modelAliases.tenantId,
  alias: modelAliases.alias,
  targetModel: modelAliases.targetModel,
} as const;

export const COMBO_COLUMNS = {
  tenantId: modelCombos.tenantId,
  name: modelCombos.name,
  members: modelCombos.members,
  strategy: modelCombos.strategy,
} as const;

export const ROUTING_COLUMNS = {
  providerId: providerRoutingSettings.providerId,
  tenantId: providerRoutingSettings.tenantId,
  strategy: providerRoutingSettings.strategy,
  rotateCount: providerRoutingSettings.rotateCount,
  maxInflight: providerRoutingSettings.maxInflight,
  maxInflightPerProxy: providerRoutingSettings.maxInflightPerProxy,
  usageFloor: providerRoutingSettings.usageFloor,
  usageFloorUnit: providerRoutingSettings.usageFloorUnit,
  enabled: providerRoutingSettings.enabled,
  skipProxy: providerRoutingSettings.skipProxy,
  userAgent: providerRoutingSettings.userAgent,
  customUserAgent: providerRoutingSettings.customUserAgent,
} as const;

export const POOL_COLUMNS = {
  id: networkPools.id,
  tenantId: networkPools.tenantId,
  status: networkPools.status,
  maxInflight: networkPools.maxInflight,
  weight: networkPools.weight,
} as const;

export const POOL_ACCOUNT_COLUMNS = {
  id: providerPoolAccounts.id,
  tenantId: providerPoolAccounts.tenantId,
  networkPoolId: providerPoolAccounts.networkPoolId,
  providerId: providerPoolAccounts.providerId,
  label: providerPoolAccounts.label,
  status: providerPoolAccounts.status,
  cooldownUntil: providerPoolAccounts.cooldownUntil,
  lastErrorCategory: providerPoolAccounts.lastErrorCategory,
} as const;

export const DISABLED_MODEL_COLUMNS = {
  tenantId: tenantDisabledModels.tenantId,
  providerId: tenantDisabledModels.providerId,
  modelId: tenantDisabledModels.modelId,
  endpointPath: tenantDisabledModels.endpointPath,
} as const;

export const CLI_MAPPING_COLUMNS = {
  tenantId: cliToolMappings.tenantId,
  apiKeyId: cliToolMappings.apiKeyId,
  toolId: cliToolMappings.toolId,
  sourceModel: cliToolMappings.sourceModel,
  targetModel: cliToolMappings.targetModel,
  enabled: cliToolMappings.enabled,
} as const;

/** The per-(tenant, tool, key) Remote Routing switch. A mapping row only
 * routes when its bucket's settings row has `mappings_enabled` set. */
export const CLI_MAPPING_SETTING_COLUMNS = {
  tenantId: cliToolSettings.tenantId,
  apiKeyId: cliToolSettings.apiKeyId,
  toolId: cliToolSettings.toolId,
  mappingsEnabled: cliToolSettings.mappingsEnabled,
} as const;

export const POOL_SETTING_COLUMNS = {
  tenantId: poolRoutingSettings.tenantId,
  strategy: poolRoutingSettings.strategy,
  rotateCount: poolRoutingSettings.rotateCount,
} as const;

/** A row of `models` as the snapshot read sees it. */
export type ModelRouteRow = { [K in keyof typeof MODEL_COLUMNS]: (typeof models.$inferSelect)[K] };
