// Routing snapshot: builds the RouteSnapshot from the persisted model catalog.

import { asc, eq, ne } from "drizzle-orm";
import type { CartethyiaDatabase } from "../../persistence/db-handle";
import {
  consoleSettings,
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
import { DEFAULT_PROVIDER_MAX_INFLIGHT } from "../../persistence/schema";
import { resolveTenantOverride } from "../../persistence/tenant-scope";
import {
  type ComboDefinition,
  type PoolRoutingSetting,
  type ProviderRoutingMap,
  type RouteSnapshot,
  type SnapshotBuilder,
  type RoutedCandidate,
} from "./route-model";
import { DEFAULT_PROXY_SKIP_PROVIDER_IDS } from "../../providers/provider-metadata";
import { buildClaudeCliUserAgent } from "../../providers/operations/custom-cli-headers";
import { isBundledProviderId } from "../../providers/provider-contracts";
import type { ServiceKind, WireFamily } from "../../protocol/canonical-model";
import { BoundedLruMap } from "./bounded-lru";
import { providerHasAdapterUserAgent, providerUsesBespokeWire } from "../../providers/provider-metadata";

const CLAUDE_MODEL_FAMILIES = new Set(["opus", "sonnet", "haiku", "fable", "mythos"]);

/** Codex's built-in (non-routeable) model spellings worth matching. */
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
 * Builds the routing `RouteSnapshot` from the persisted catalog
 * (`providers`, `models`, `provider_accounts`). Consumed by
 * `InMemoryRouteSnapshotService` as its `SnapshotBuilder`.
 *
 * Built-in definitions are materialized before snapshots are read. The
 * `models` DB table is authoritative for routing; compiled definitions are
 * only startup seed data. Custom/BYOK and live-discovered models are stored
 * in the same table.
 *
 * Tenant-aware: a provider with `providers.tenant_id = NULL` is global
 * (every built-in, plus any pool-wide custom provider) and its candidates
 * carry `tenant_id: null`, matching every request regardless of tenant. A
 * provider with `providers.tenant_id` set (BYOK) only pairs with accounts
 * owned by that exact same tenant, and its candidates carry that tenant id
 * — `RoutingEngine.plan()` filters candidates by the requesting tenant.
 */

const HARD_COOLDOWN_CATEGORIES: Readonly<Record<string, true>> = {
  quota_exhausted: true,
  policy_blocked: true,
  auth_invalidated: true,
};

function hardCooldownCategory(category: string | null): boolean {
  return category !== null && HARD_COOLDOWN_CATEGORIES[category] === true;
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
function capabilityProfileFor(row: {
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
interface MergedModelRow {
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
function mergeModelCatalog(
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
const PROVIDER_COLUMNS = {
  id: providers.id,
  tenantId: providers.tenantId,
  requiresAccount: providers.requiresAccount,
} as const;

const MODEL_COLUMNS = {
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
const ACCOUNT_COLUMNS = {
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

const ALIAS_COLUMNS = {
  tenantId: modelAliases.tenantId,
  alias: modelAliases.alias,
  targetModel: modelAliases.targetModel,
} as const;

const COMBO_COLUMNS = {
  tenantId: modelCombos.tenantId,
  name: modelCombos.name,
  members: modelCombos.members,
  strategy: modelCombos.strategy,
} as const;

const ROUTING_COLUMNS = {
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
} as const;

const POOL_COLUMNS = {
  id: networkPools.id,
  tenantId: networkPools.tenantId,
  status: networkPools.status,
  maxInflight: networkPools.maxInflight,
  weight: networkPools.weight,
} as const;

const POOL_ACCOUNT_COLUMNS = {
  id: providerPoolAccounts.id,
  tenantId: providerPoolAccounts.tenantId,
  networkPoolId: providerPoolAccounts.networkPoolId,
  providerId: providerPoolAccounts.providerId,
  label: providerPoolAccounts.label,
  status: providerPoolAccounts.status,
  cooldownUntil: providerPoolAccounts.cooldownUntil,
  lastErrorCategory: providerPoolAccounts.lastErrorCategory,
} as const;

const DISABLED_MODEL_COLUMNS = {
  tenantId: tenantDisabledModels.tenantId,
  providerId: tenantDisabledModels.providerId,
  modelId: tenantDisabledModels.modelId,
  endpointPath: tenantDisabledModels.endpointPath,
} as const;

const CLI_MAPPING_COLUMNS = {
  tenantId: cliToolMappings.tenantId,
  apiKeyId: cliToolMappings.apiKeyId,
  toolId: cliToolMappings.toolId,
  sourceModel: cliToolMappings.sourceModel,
  targetModel: cliToolMappings.targetModel,
  enabled: cliToolMappings.enabled,
} as const;

/** The per-(tenant, tool, key) Remote Routing switch. A mapping row only
 * routes when its bucket's settings row has `mappings_enabled` set. */
const CLI_MAPPING_SETTING_COLUMNS = {
  tenantId: cliToolSettings.tenantId,
  apiKeyId: cliToolSettings.apiKeyId,
  toolId: cliToolSettings.toolId,
  mappingsEnabled: cliToolSettings.mappingsEnabled,
} as const;

const POOL_SETTING_COLUMNS = {
  tenantId: poolRoutingSettings.tenantId,
  strategy: poolRoutingSettings.strategy,
  rotateCount: poolRoutingSettings.rotateCount,
} as const;

/** A row of `models` as this module reads it. */
type ModelRouteRow = { [K in keyof typeof MODEL_COLUMNS]: (typeof models.$inferSelect)[K] };

/** Snapshot load result from the 10-table catalog read. */
type RouteCatalogSnapshotResult = Omit<RouteSnapshot, "revision" | "created_at"> & { created_at?: number };

/** Repository abstracting database queries for the route catalog snapshot. */
class RouteCatalogRepository {
  constructor(private readonly db: CartethyiaDatabase) {}

  async loadRouteCatalogSnapshot(tenantId?: string): Promise<RouteCatalogSnapshotResult> {
    const [providerRows, modelRows, accountRows, aliasRows, comboRows, routingRows, poolRows, poolAccountRows, disabledModelRows, cliMappingRows, cliMappingSettingRows, poolSettingRows, settingsRows] =
      await Promise.all([
        this.db.select(PROVIDER_COLUMNS).from(providers).where(eq(providers.enabled, true)),
        this.db.select(MODEL_COLUMNS).from(models),
        this.db
          .select(ACCOUNT_COLUMNS)
          .from(providerAccounts)
          .where(ne(providerAccounts.status, "disabled"))
          .orderBy(asc(providerAccounts.status), asc(providerAccounts.createdAt), asc(providerAccounts.id)),
        this.db.select(ALIAS_COLUMNS).from(modelAliases),
        this.db.select(COMBO_COLUMNS).from(modelCombos),
        this.db.select(ROUTING_COLUMNS).from(providerRoutingSettings),
        this.db.select(POOL_COLUMNS).from(networkPools),
        this.db.select(POOL_ACCOUNT_COLUMNS).from(providerPoolAccounts),
        this.db.select(DISABLED_MODEL_COLUMNS).from(tenantDisabledModels),
        this.db.select(CLI_MAPPING_COLUMNS).from(cliToolMappings),
        this.db.select(CLI_MAPPING_SETTING_COLUMNS).from(cliToolSettings),
        this.db.select(POOL_SETTING_COLUMNS).from(poolRoutingSettings),
        // The cooldown override is a console_settings preference, read inside
        // the same fan-out rather than per request: one more row set on a
        // query that already runs, instead of a Postgres round trip on every
        // admitted request.
        this.db
          .select({ tenantId: consoleSettings.tenantId, preferences: consoleSettings.preferences })
          .from(consoleSettings),
      ]);
    const mergedModelRows = mergeModelCatalog(modelRows);
    /**
     * Tenants that asked to ignore an account-wide cooldown.
     *
     * Read-only override: the cooldown is still on the row, still shown in
     * Health, and still recovered by the sweep. This only stops it from
     * excluding the candidate, so turning the setting off needs no cleanup.
     *
     * Per-(account, model) cooldowns are deliberately NOT overridden — see the
     * preference's own doc.
     */
    const cooldownOverrideTenants = new Set<string>();
    const invokeDisabledTenants = new Set<string>();
    for (const row of settingsRows ?? []) {
      if (row.preferences?.forceDisableCooldown === true && row.tenantId) {
        cooldownOverrideTenants.add(row.tenantId);
      }
      if (row.preferences?.invokeDisabled === true && row.tenantId) {
        invokeDisabledTenants.add(row.tenantId);
      }
    }
    /**
     * A shared account has no tenant of its own (`tenant_id IS NULL`), so a
     * tenant-keyed override would never match it — yet a shared account is
     * exactly the one every tenant dials, and parking it stops all of them.
     * When any tenant asks, the override covers shared accounts too.
     */
    const anyTenantOverrides = cooldownOverrideTenants.size > 0;

    // Compile tenant-scoped disables into a lookup keyed by the same
    // composite identity the `models` table uses. A disabled key suppresses
    // the candidate whose account belongs to that tenant.
    const disabledModelKeys = new Set<string>(
      disabledModelRows.map(
        (row) => `${row.tenantId}:${row.providerId}:${row.modelId}:${row.endpointPath}`,
      ),
    );

    const providerTenantById = new Map<string, string | null>(
      providerRows.map((p) => [p.id, p.tenantId]),
    );
    const requiresAccountById = new Map<string, boolean>(
      providerRows.map((p) => [p.id, p.requiresAccount]),
    );

    // Every active (non-disabled) pool a tenant owns, available for
    // automatic per-request selection — see `resolveNetworkPools` below.
    const activePoolsByTenant = new Map<
      string,
      Array<{ id: string; maxInflight: number; weight: number }>
    >();
    const configuredPoolTenants = new Set<string>();
    for (const pool of poolRows) {
      configuredPoolTenants.add(pool.tenantId);
      if (pool.status !== "active") continue;
      if (!pool.tenantId) continue;
      const list = activePoolsByTenant.get(pool.tenantId) ?? [];
      list.push({ id: pool.id, maxInflight: pool.maxInflight ?? 10, weight: pool.weight ?? 100 });
      activePoolsByTenant.set(pool.tenantId, list);
    }

    // Pool-as-account rows, grouped by tenant: one per (pool × ip-scoped
    // provider). For a credential-less ip-scoped provider these are the
    // account-equivalent routing entities — a spent egress is excluded from
    // the plan exactly like a cooling account, and the candidate carries the
    // pool-account's health (see the public-candidate fan-out below).
    const poolAccountsByTenant = new Map<
      string,
      Array<{
        id: string;
        networkPoolId: string;
        providerId: string;
        status: string;
        cooldownUntil: Date | null;
        lastErrorCategory: string | null;
      }>
    >();
    for (const poolAccount of poolAccountRows) {
      const list = poolAccountsByTenant.get(poolAccount.tenantId) ?? [];
      list.push(poolAccount);
      poolAccountsByTenant.set(poolAccount.tenantId, list);
    }

    // Per-tenant pool selection strategy; an absent row reads as the
    // `least_loaded` default at selection time.
    const poolRouting: Record<string, PoolRoutingSetting> = {};
    for (const row of poolSettingRows) {
      if (tenantId === undefined || row.tenantId === tenantId) {
        poolRouting[row.tenantId] = { strategy: row.strategy, rotateCount: row.rotateCount };
      }
    }

    // Build per-tenant per-provider routing preferences before the
    // candidates loop below, since skipProxy has to be known while
    // deciding each candidate's network pool set. Global settings
    // (tenant_id IS NULL) are stored under sentinel "__global__".
    const providerRouting: Record<string, Record<string, ProviderRoutingMap[string][string]>> = {};
    for (const row of routingRows) {
      const tenantKey = row.tenantId ?? "__global__";
      const bucket = (providerRouting[tenantKey] ??= {});
      bucket[row.providerId] = {
        strategy: row.strategy as ProviderRoutingMap[string][string]["strategy"],
        rotateCount: row.rotateCount ?? 1,
        maxInflight: row.maxInflight,
        maxInflightPerProxy: row.maxInflightPerProxy,
        usageFloor: row.usageFloor,
        usageFloorUnit: row.usageFloorUnit === "credit" ? "credit" : "percent",
        enabled: row.enabled,
        skipProxy: row.skipProxy,
        userAgent: row.userAgent,
      };
    }
    /** Tenant-specific setting wins over global; an unconfigured provider
     * falls back to `DEFAULT_PROXY_SKIP_PROVIDER_IDS`, mirroring the same
     * default `DrizzleProviderDetailStore.getRouting` reports to the API —
     * so the dashboard's displayed default and the real dispatch decision
     * never disagree. */
    function resolveSkipProxy(providerId: string, rowTenantId: string | null): boolean {
      const effectiveTenantId = rowTenantId;
      const tenantSetting = effectiveTenantId ? providerRouting[effectiveTenantId]?.[providerId] : undefined;
      const globalSetting = providerRouting.__global__?.[providerId];
      return resolveTenantOverride(
        tenantSetting?.skipProxy,
        globalSetting?.skipProxy,
        DEFAULT_PROXY_SKIP_PROVIDER_IDS.has(providerId),
      );
    }
    function resolveUserAgent(providerId: string, rowTenantId: string | null): string | undefined {
      const tenantSetting = rowTenantId ? providerRouting[rowTenantId]?.[providerId]?.userAgent : undefined;
      const globalSetting = providerRouting.__global__?.[providerId]?.userAgent;
      return resolveRouteUserAgent(providerId, tenantSetting, globalSetting);
    }

    /** Provider-wide concurrency ceiling shared by every account of the provider.
     * Tenant setting wins over global, mirroring skipProxy. A stored `null`
     * is the explicit unlimited choice; so is the default — a provider with no
     * routing row at all is unlimited too, because an operator who never
     * configured a ceiling asked for none. */
    function resolveMaxInflight(
      providerId: string,
      rowTenantId: string | null,
    ): number | undefined {
      const tenantSetting = rowTenantId
        ? providerRouting[rowTenantId]?.[providerId]?.maxInflight
        : undefined;
      const globalSetting = providerRouting.__global__?.[providerId]?.maxInflight;
      const resolved = tenantSetting ?? globalSetting;
      if (resolved === null) return undefined;
      return resolved ?? DEFAULT_PROVIDER_MAX_INFLIGHT ?? undefined;
    }

    /**
     * This provider's per-pool inflight ceiling, from Routing Strategy.
     * `undefined` means unlimited — the default, and the state of every
     * provider nobody has configured. A stored `null` is the same choice made
     * explicitly; the two are deliberately indistinguishable downstream so the
     * hot path never branches on which one it read.
     */
    function resolveMaxInflightPerProxy(
      providerId: string,
      rowTenantId: string | null,
    ): number | undefined {
      const tenantSetting = rowTenantId
        ? providerRouting[rowTenantId]?.[providerId]?.maxInflightPerProxy
        : undefined;
      const globalSetting = providerRouting.__global__?.[providerId]?.maxInflightPerProxy;
      return tenantSetting ?? globalSetting ?? undefined;
    }

    /** Every active pool the account's tenant owns — dispatch picks the
     * least-loaded/non-cooldown one per request (`tryAcquireAvailablePool`),
     * never an admin-pinned single pool. */
    function resolveNetworkPools(
      providerId: string,
      rowTenantId: string | null,
    ):
      | {
          ids: readonly string[];
          limits: Record<string, number>;
          weights: Record<string, number>;
          routing?: PoolRoutingSetting & { tenantId: string };
        }
      | undefined {
      if (!rowTenantId || resolveSkipProxy(providerId, rowTenantId)) return undefined;
      if (!configuredPoolTenants.has(rowTenantId)) return undefined;
      const pools = activePoolsByTenant.get(rowTenantId) ?? [];
      const limits: Record<string, number> = {};
      const weights: Record<string, number> = {};
      for (const pool of pools) {
        limits[pool.id] = pool.maxInflight;
        weights[pool.id] = pool.weight;
      }
      const routing = poolRouting[rowTenantId];
      return {
        ids: pools.map((pool) => pool.id),
        limits,
        weights,
        ...(routing ? { routing: { tenantId: rowTenantId, ...routing } } : {}),
      };
    }

    /** The candidate fragment for a provider ceiling, empty when unlimited —
     * so an unconfigured provider's candidate is byte-for-byte what it was. */
    function providerLimitFor(
      providerId: string,
      rowTenantId: string | null,
    ): { network_pool_provider_limit?: number } {
      const limit = resolveMaxInflightPerProxy(providerId, rowTenantId);
      return limit === undefined ? {} : { network_pool_provider_limit: limit };
    }

    // Group usable accounts per provider (not per provider-tenant). Built-in
    // providers are `tenant_id IS NULL` but their accounts are per-tenant, so
    // grouping by `providerTenantId` would make every global model look
    // disabled. Instead keep all accounts for a provider together and fan out
    // candidates per account tenant below — e.g. `opencodeze/muse-spark`
    // hits with `model: "opencodeze/muse-spark"` must resolve to the tenant's
    // own account even though the provider row is global.
    const accountsByProvider = new Map<string, typeof accountRows>();
    for (const account of accountRows) {
      if (account.status === "disabled") continue;
      const list = accountsByProvider.get(account.providerId) ?? [];
      list.push(account);
      accountsByProvider.set(account.providerId, list);
    }

    const candidates: RoutedCandidate[] = [];
    for (const model of mergedModelRows) {
      const providerTenantId = providerTenantById.get(model.providerId);
      if (providerTenantId === undefined) continue;
      const accounts = accountsByProvider.get(model.providerId) ?? [];
      // One profile per model row, memoized across snapshot rebuilds. The
      // profile is derived purely from the row's metadata, is never mutated
      // (grep finds no write to `capability_profile`), and is shared by every
      // candidate this row fans out to — so a rebuild no longer constructs a
      // fresh object per model on top of the fan-out it already had.
      const capabilityProfile = capabilityProfileFor(model);
      if (accounts.length === 0) {
        const providerRequiresAccount = requiresAccountById.get(model.providerId) ?? true;
        if (!providerRequiresAccount) {
          // Public models inherit active pools for each tenant that has active pools.
          // When the provider is ip-scoped (limits follow the egress address), the
          // tenant's pool-account rows are the account-equivalent routing entities:
          // one candidate per pool, carrying that pool-account's health, so a spent
          // egress is excluded from the plan exactly like a cooling account.
          const ownedTenantIds = [...poolAccountsByTenant.keys()].filter((tid) =>
            (poolAccountsByTenant.get(tid) ?? []).some((pa) => pa.providerId === model.providerId),
          );
          let emittedPoolAccount = false;
          for (const tenantOwnerId of ownedTenantIds) {
            const poolAccounts = poolAccountsByTenant.get(tenantOwnerId) ?? [];
            const tenantPoolAccounts = new Map<string, typeof poolAccounts>();
            for (const pa of poolAccounts) {
              if (pa.providerId !== model.providerId) continue;
              const list = tenantPoolAccounts.get(pa.networkPoolId) ?? [];
              list.push(pa);
              tenantPoolAccounts.set(pa.networkPoolId, list);
            }
            if (tenantPoolAccounts.size === 0) continue;
            for (const [poolId, pas] of tenantPoolAccounts) {
              const first = pas[0];
              if (!first) continue;
              const tenantPools = resolveNetworkPools(model.providerId, tenantOwnerId);
              if (!tenantPools) continue;
              emittedPoolAccount = true;
              const tenantCandidate: RoutedCandidate = {
                provider_id: model.providerId,
                model_id: model.modelId,
                wire_family: model.wireFamily as WireFamily,
                ...(model.dialect == null ? {} : { dialect: model.dialect }),
                service_kind: model.serviceKind,
                endpoint: model.endpointPath,
                ...(model.outputLimit == null ? {} : { output_limit: model.outputLimit }),
                capability_profile: capabilityProfile,
                tenant_id: tenantOwnerId,
                ...(model.freeTier === true ? { free_tier: true } : {}),
                // Public credential-less candidates have no account to own them.
                owner_tenant_id: null,
                requires_account: false as const,
                network_pool_ids: [poolId],
                network_pool_required: true,
                network_pool_limits: tenantPools.limits,
                network_pool_weights: tenantPools.weights,
                ...(tenantPools.routing ? { network_pool_routing: tenantPools.routing } : {}),
                ...providerLimitFor(model.providerId, tenantOwnerId),
                ...(first.status === "disabled"
                  ? { health_status: "disabled" as const }
                  : first.status === "cooldown"
                    ? {
                        health_status: "cooldown" as const,
                        cooldown_kind: hardCooldownCategory(first.lastErrorCategory) ? "hard" : "soft",
                        ...(first.cooldownUntil && first.cooldownUntil.getTime() > Date.now()
                          ? { cooldown_until: first.cooldownUntil.getTime() }
                          : {}),
                      }
                    : {}),
              };
              if (tenantId === undefined || tenantId === tenantOwnerId) {
                candidates.push(tenantCandidate);
              }
            }
          }
          if (emittedPoolAccount) continue;
          for (const tId of configuredPoolTenants) {
            const tenantPools = resolveNetworkPools(model.providerId, tId);
            if (tenantPools) {
              const tenantCandidate: RoutedCandidate = {
                provider_id: model.providerId,
                model_id: model.modelId,
                wire_family: model.wireFamily as WireFamily,
                ...(model.dialect == null ? {} : { dialect: model.dialect }),
                service_kind: model.serviceKind,
                endpoint: model.endpointPath,
                ...(model.outputLimit == null ? {} : { output_limit: model.outputLimit }),
                capability_profile: capabilityProfile,
                tenant_id: tId,
                ...(model.freeTier === true ? { free_tier: true } : {}),
                // Public credential-less candidates have no account to own them.
                owner_tenant_id: null,
                requires_account: false as const,
                network_pool_ids: tenantPools.ids,
                network_pool_required: true,
                network_pool_limits: tenantPools.limits,
                network_pool_weights: tenantPools.weights,
                ...(tenantPools.routing ? { network_pool_routing: tenantPools.routing } : {}),
                ...providerLimitFor(model.providerId, tId),
              };
              if (tenantId === undefined || tenantId === tId) {
                candidates.push(tenantCandidate);
              }
            }
          }
        }
        const networkPools = providerRequiresAccount
          ? undefined
          : resolveNetworkPools(model.providerId, providerTenantId);
        const candidate: RoutedCandidate = {
          provider_id: model.providerId,
          model_id: model.modelId,
          wire_family: model.wireFamily as WireFamily,
          ...(model.dialect == null ? {} : { dialect: model.dialect }),
          service_kind: model.serviceKind,
          endpoint: model.endpointPath,
          ...(model.outputLimit == null ? {} : { output_limit: model.outputLimit }),
          capability_profile: capabilityProfile,
          tenant_id: providerTenantId,
          ...(model.freeTier === true ? { free_tier: true } : {}),
          // Public credential-less candidates have no account to own them.
          owner_tenant_id: null,
          ...(providerRequiresAccount
            ? { health_status: "disabled" as const }
            : { requires_account: false as const }),
          ...(networkPools
            ? {
                network_pool_ids: networkPools.ids,
                network_pool_required: true,
                network_pool_limits: networkPools.limits,
                network_pool_weights: networkPools.weights,
                ...(networkPools.routing ? { network_pool_routing: networkPools.routing } : {}),
                ...providerLimitFor(model.providerId, providerTenantId),
              }
            : {}),
        };
        if (tenantId === undefined || candidate.tenant_id === null || candidate.tenant_id === tenantId) {
          candidates.push(candidate);
        }
        continue;
      }
      for (const account of accounts) {
        const rowTenantId = account.tenantId ?? providerTenantId;
        if (
          rowTenantId !== null &&
          disabledModelKeys.has(
            `${rowTenantId}:${model.providerId}:${model.modelId}:${model.endpointPath}`,
          )
        ) {
          continue;
        }
        const networkPools = resolveNetworkPools(model.providerId, rowTenantId);
        const routeUserAgent = resolveUserAgent(model.providerId, rowTenantId);
        const candidate: RoutedCandidate = {
          provider_id: model.providerId,
          model_id: model.modelId,
          wire_family: model.wireFamily as WireFamily,
          ...(model.dialect == null ? {} : { dialect: model.dialect }),
          service_kind: model.serviceKind,
          endpoint: model.endpointPath,
          ...(model.outputLimit == null ? {} : { output_limit: model.outputLimit }),
          capability_profile: capabilityProfile,
          ...(routeUserAgent === undefined ? {} : { user_agent: routeUserAgent }),
          ...(model.freeTier === true ? { free_tier: true } : {}),
          tenant_id: rowTenantId,
          provider_account_id: account.id,
          // The account's owning tenant (null = shared pool-wide) — the bucket
          // key for admission, distinct from the requesting tenant.
          owner_tenant_id: account.tenantId ?? null,
          // The plan gate is per (account, model): the model may be refused on
          // a free plan and the account may be on one. Both ride here because
          // `plan()` sees the candidate and nothing else.
          ...(model.proOnly === true ? { pro_only: true } : {}),
          ...(account.quotaPlan === null || account.quotaPlan === undefined
            ? {}
            : { account_plan: account.quotaPlan }),
          // Provider-wide concurrency ceiling from Routing Strategy; legacy
          // account overrides are never read here.
          ...(() => {
            const resolved = resolveMaxInflight(model.providerId, rowTenantId);
            return resolved === undefined ? {} : { max_inflight: resolved };
          })(),
          ...(networkPools
            ? {
                network_pool_required: true,
                network_pool_ids: networkPools.ids,
                network_pool_limits: networkPools.limits,
                network_pool_weights: networkPools.weights,
                ...(networkPools.routing ? { network_pool_routing: networkPools.routing } : {}),
                ...providerLimitFor(model.providerId, rowTenantId),
              }
            : {}),
        };
        if (account.status === "cooldown") {
          // A row that still says `cooldown` stays excluded until the sweeper
          // flips it back to `active`. An *expired* deadline used to read as
          // healthy here (the comment below's "pure read" reasoning), which let
          // routing redial the account in the window between the deadline
          // elapsing and the next 30s sweep — reproducing the refusal that
          // cooled it and logging a fresh `cooldown → cooldown` row each time
          // (the operator's "still hit a cooled-down account" report). The
          // sweep is the only exit from `cooldown`; until it runs the row is
          // not proof the account can serve.
          //
          // `forceDisableCooldown` skips the exclusion entirely. The cooldown
          // is still real and still recorded — it simply stops deciding
          // routing. That is what makes the setting reversible: nothing was
          // written, so turning it off needs no cleanup, and Health still
          // reports the truth about the account.
          const overrideActive =
            rowTenantId === null
              ? anyTenantOverrides
              : cooldownOverrideTenants.has(rowTenantId);
          const accountDeadline = account.cooldownUntil;
          const unexpired =
            accountDeadline !== null && accountDeadline.getTime() > Date.now();
          if (overrideActive) {
            // The account is still cooling — this only stops it from being
            // excluded. `plan()` reads `cooldown_until` to answer the
            // all-cooling case, so it stays populated either way.
            //
            // Neither `health_status` nor `cooldown_kind` is set: the
            // evaluator excludes a hard cooldown on `health_status ===
            // "cooldown"` alone, so stamping it here would keep excluding
            // the very accounts the override exists to reach — a spent quota
            // or a policy block, which are the ones an operator actually
            // wants to override.
            if (unexpired) candidate.cooldown_until = accountDeadline!.getTime();
          } else {
            candidate.health_status = "cooldown";
            candidate.cooldown_kind = hardCooldownCategory(account.lastErrorCategory)
              ? "hard"
              : "soft";
            // The deadline rides with the exclusion it explains. `plan()`
            // reads it to answer the all-cooling case with the real reset
            // instead of a bare 429, so a client backs off for the window
            // that is actually open rather than inventing one. An expired
            // deadline carries no reset — the sweep is about to recover the
            // row, and quoting a past instant would tell the client to retry
            // "immediately" for a wait that is already over.
            if (unexpired) candidate.cooldown_until = accountDeadline!.getTime();
          }
        }

        // Per-model cooldown: an account may be healthy globally but cooling down
        // for a specific model. A non-expired entry for the model THIS candidate
        // serves is a hard exclusion, not a deprioritization: the upstream said
        // this exact (account, model) pair is exhausted until a stated reset
        // ("Daily free limit reached … Try again in 11h"), so dialing it can only
        // reproduce the same refusal. Deprioritizing instead made failover spend
        // a full round trip on it after every healthy sibling had failed, and
        // recorded another `active → cooldown` row each time — the operator's
        // report of one account churning while ten siblings sat healthy.
        //
        // `model_cooldown` (distinct from `cooldown`) is what carries that
        // distinction to the evaluator: an account-wide `cooldown` stays
        // deprioritized so a single-account deployment still routes, while a
        // model-scoped one is dropped for this model only and the account keeps
        // serving every other model it holds.
        const modelCooldowns = account.modelCooldowns as Record<string, string> | null;
        const modelCooldownUntil = modelCooldowns?.[model.modelId];
        if (modelCooldownUntil && new Date(modelCooldownUntil).getTime() > Date.now()) {
          candidate.health_status = "model_cooldown";
          candidate.cooldown_until = new Date(modelCooldownUntil).getTime();
        }
        if (tenantId === undefined || candidate.tenant_id === null || candidate.tenant_id === tenantId) {
          candidates.push(candidate);
        }
      }
    }

    const aliases: Record<string, Record<string, string>> = {};
    const cliAliases: Record<string, Record<string, string>> = {};
    for (const row of aliasRows) {
      if (tenantId === undefined || row.tenantId === tenantId) {
        (aliases[row.tenantId] ??= {})[row.alias] = row.targetModel;
      }
    }
    // CLI-tool mappings are per-(tenant, key): each API key can route the same
    // CLI slot to a different target. The snapshot keys the alias bucket by
    // `${tenantId}:${apiKeyId}` so the preparer can look up the exact key's
    // routes without merging across keys.
    // Remote Routing is opt-in per (tenant, tool, key): a mapping row routes
    // only when its bucket's settings row explicitly enabled it. The CLI tool
    // page and the API-key edit form both write that one flag, so either place
    // can turn the routes on or off.
    const enabledMappingBuckets = new Set<string>();
    for (const row of cliMappingSettingRows) {
      if (row.mappingsEnabled) enabledMappingBuckets.add(`${row.tenantId}:${row.apiKeyId}`);
    }
    for (const row of cliMappingRows) {
      if (!row.enabled) continue;
      if (!enabledMappingBuckets.has(`${row.tenantId}:${row.apiKeyId}`)) continue;
      if (tenantId === undefined || row.tenantId === tenantId) {
        const bucketKey = `${row.tenantId}:${row.apiKeyId}`;
        const aliasBucket = (cliAliases[bucketKey] ??= {});
        for (const sourceKey of cliMappingSourceKeys(row.toolId, row.sourceModel)) {
          aliasBucket[sourceKey] = row.targetModel;
        }
      }
    }
    const combos: Record<string, Record<string, ComboDefinition>> = {};
    for (const row of comboRows) {
      if (tenantId === undefined || row.tenantId === tenantId) {
        (combos[row.tenantId] ??= {})[row.name] = { members: row.members, strategy: row.strategy };
      }
    }

    const routingMap: ProviderRoutingMap | undefined =
      Object.keys(providerRouting).length > 0 ? (providerRouting as ProviderRoutingMap) : undefined;

    return {
      candidates,
      aliases,
      cli_aliases: cliAliases,
      combos,
      ...(routingMap ? { providerRouting: routingMap } : {}),
      ...(Object.keys(poolRouting).length > 0 ? { poolRouting } : {}),
      ...(invokeDisabledTenants.size > 0 ? { invokeDisabledTenants } : {}),
    };
  }
}

/** Builds a `SnapshotBuilder` reading the live catalog from `db`. */
export function createDatabaseSnapshotBuilder(
  db: CartethyiaDatabase,
  refreshActiveCatalogs?: () => Promise<void>,
): SnapshotBuilder {
  const repository = new RouteCatalogRepository(db);
  return async () => {
    await refreshActiveCatalogs?.();
    return repository.loadRouteCatalogSnapshot(undefined);
  };
}

