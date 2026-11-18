// Route snapshot repository assembly: builds the `RouteSnapshot` through a
// staged build context over the row set loaded by `route-catalog-read.ts`.
// The pure projection and identity helpers live in `route-catalog-helpers.ts`;
// this module is re-exported by `route-catalog.ts` for the public surface.

import type { CartethyiaDatabase } from "../../persistence/db-handle";
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
import {
  capabilityProfileFor,
  cliMappingSourceKeys,
  mergeModelCatalog,
  type MergedModelRow,
  resolveRouteUserAgent,
} from "./route-catalog-helpers";
import {
  type AccountRouteRow,
  type CatalogRead,
  type PoolAccountRouteRow,
  readCatalogRows,
} from "./route-catalog-read";
import type { WireFamily } from "../../protocol/canonical-model";

const HARD_COOLDOWN_CATEGORIES: Readonly<Record<string, true>> = {
  quota_exhausted: true,
  auth_invalidated: true,
  // A rejected credential cools the account *out* of rotation for the window —
  // dialing it again can only reproduce the same 401, so it is excluded like
  // the `auth_invalidated` verdict rather than merely deprioritized.
  auth_rejected: true,
  // An account that must be verified before it can serve cannot be healed by
  // the next request — but it lands as a timed cooldown, so while it cools it
  // is excluded rather than dialed and failed again.
  validation_required: true,
};

function hardCooldownCategory(category: string | null): boolean {
  return category !== null && HARD_COOLDOWN_CATEGORIES[category] === true;
}



/** Snapshot load result from the 13-table catalog read. */
type RouteCatalogSnapshotResult = Omit<RouteSnapshot, "revision" | "created_at"> & { created_at?: number };

/**
 * Staged state for one snapshot build. The load reads all thirteen row sets
 * first, then compiles every lookup map/table once, then resolves candidates
 * against them through the resolver methods below. Everything here is local to
 * one build; nothing outlives it. Splitting this out of
 * `loadRouteCatalogSnapshot` keeps the assembly readable without re-deriving
 * the per-candidate lookups on every row.
 */
class RouteCatalogBuildContext {
  /** Model rows ready for candidate construction. */
  readonly mergedModelRows: readonly MergedModelRow[];
  /** The raw rows behind this build, read by alias/combo/CLI-table assembly. */
  private readonly rows: CatalogRead;
  /** Tenants that asked to ignore an account-wide cooldown. */
  readonly cooldownOverrideTenants: ReadonlySet<string>;
  /** Tenants whose invoke switch is off. */
  readonly invokeDisabledTenants: ReadonlySet<string>;
  /** Whether any tenant asked for the cooldown override (covers shared accounts). */
  readonly anyTenantOverrides: boolean;
  /** Tenant-scoped disabled model keys: `${tenantId}:${providerId}:${modelId}:${endpointPath}`. */
  readonly disabledModelKeys: ReadonlySet<string>;
  readonly providerTenantById: ReadonlyMap<string, string | null>;
  readonly requiresAccountById: ReadonlyMap<string, boolean>;
  /** Every active (non-disabled) pool a tenant owns, for automatic per-request selection. */
  readonly activePoolsByTenant: ReadonlyMap<
    string,
    readonly { id: string; maxInflight: number; weight: number }[]
  >;
  /** Tenants that have at least one pool row (active or not). */
  readonly configuredPoolTenants: ReadonlySet<string>;
  /** Pool-as-account rows grouped by tenant. */
  readonly poolAccountsByTenant: ReadonlyMap<string, PoolAccountRouteRow[]>;
  /** Per-tenant pool selection strategy; an absent row reads as `least_loaded`. */
  readonly poolRouting: Readonly<Record<string, PoolRoutingSetting>>;
  /** Per-tenant per-provider routing preferences; global settings under the `__global__` sentinel. */
  readonly providerRouting: Record<string, Record<string, ProviderRoutingMap[string][string]>>;
  /** Usable accounts per provider (not per provider-tenant). */
  readonly accountsByProvider: ReadonlyMap<string, readonly AccountRouteRow[]>;

  constructor(rows: CatalogRead) {
    this.rows = rows;
    this.mergedModelRows = mergeModelCatalog(rows.modelRows);
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
    for (const row of rows.settingsRows ?? []) {
      if (row.preferences?.forceDisableCooldown === true && row.tenantId) {
        cooldownOverrideTenants.add(row.tenantId);
      }
      if (row.preferences?.invokeDisabled === true && row.tenantId) {
        invokeDisabledTenants.add(row.tenantId);
      }
    }
    this.cooldownOverrideTenants = cooldownOverrideTenants;
    this.invokeDisabledTenants = invokeDisabledTenants;
    /**
     * A shared account has no tenant of its own (`tenant_id IS NULL`), so a
     * tenant-keyed override would never match it — yet a shared account is
     * exactly the one every tenant dials, and parking it stops all of them.
     * When any tenant asks, the override covers shared accounts too.
     */
    this.anyTenantOverrides = cooldownOverrideTenants.size > 0;

    // Compile tenant-scoped disables into a lookup keyed by the same
    // composite identity the `models` table uses. A disabled key suppresses
    // the candidate whose account belongs to that tenant.
    this.disabledModelKeys = new Set<string>(
      rows.disabledModelRows.map(
        (row) => `${row.tenantId}:${row.providerId}:${row.modelId}:${row.endpointPath}`,
      ),
    );

    this.providerTenantById = new Map<string, string | null>(
      rows.providerRows.map((p) => [p.id, p.tenantId]),
    );
    this.requiresAccountById = new Map<string, boolean>(
      rows.providerRows.map((p) => [p.id, p.requiresAccount]),
    );

    // Every active (non-disabled) pool a tenant owns, available for
    // automatic per-request selection — see `resolveNetworkPools` below.
    const activePoolsByTenant = new Map<
      string,
      Array<{ id: string; maxInflight: number; weight: number }>
    >();
    const configuredPoolTenants = new Set<string>();
    for (const pool of rows.poolRows) {
      configuredPoolTenants.add(pool.tenantId);
      if (pool.status !== "active") continue;
      if (!pool.tenantId) continue;
      const list = activePoolsByTenant.get(pool.tenantId) ?? [];
      list.push({ id: pool.id, maxInflight: pool.maxInflight ?? 10, weight: pool.weight ?? 100 });
      activePoolsByTenant.set(pool.tenantId, list);
    }
    this.activePoolsByTenant = activePoolsByTenant;
    this.configuredPoolTenants = configuredPoolTenants;

    // Pool-as-account rows, grouped by tenant: one per (pool × ip-scoped
    // provider). For a credential-less ip-scoped provider these are the
    // account-equivalent routing entities — a spent egress is excluded from
    // the plan exactly like a cooling account, and the candidate carries the
    // pool-account's health (see the public-candidate fan-out below).
    const poolAccountsByTenant = new Map<string, PoolAccountRouteRow[]>();
    for (const poolAccount of rows.poolAccountRows) {
      const list = poolAccountsByTenant.get(poolAccount.tenantId) ?? [];
      list.push(poolAccount);
      poolAccountsByTenant.set(poolAccount.tenantId, list);
    }
    this.poolAccountsByTenant = poolAccountsByTenant;

    // Per-tenant pool selection strategy; an absent row reads as the
    // `least_loaded` default at selection time. The local map resolves
    // per-candidate during the build; it is NOT stored in RouteSnapshot.
    const poolRouting: Record<string, PoolRoutingSetting> = {};
    for (const row of rows.poolSettingRows) {
      poolRouting[row.tenantId] = { strategy: row.strategy, rotateCount: row.rotateCount };
    }
    this.poolRouting = poolRouting;

    // Build per-tenant per-provider routing preferences before the
    // candidates loop below, since skipProxy has to be known while
    // deciding each candidate's network pool set. Global settings
    // (tenant_id IS NULL) are stored under sentinel "__global__".
    const providerRouting: Record<string, Record<string, ProviderRoutingMap[string][string]>> = {};
    for (const row of rows.routingRows) {
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
        customUserAgent: row.customUserAgent,
      };
    }
    this.providerRouting = providerRouting;

    // Group usable accounts per provider (not per provider-tenant). Built-in
    // providers are `tenant_id IS NULL` but their accounts are per-tenant, so
    // grouping by `providerTenantId` would make every global model look
    // disabled. Instead keep all accounts for a provider together and fan out
    // candidates per account tenant below — e.g. `opencodeze/muse-spark`
    // hits with `model: "opencodeze/muse-spark"` must resolve to the tenant's
    // own account even though the provider row is global.
    const accountsByProvider = new Map<string, AccountRouteRow[]>();
    for (const account of rows.accountRows) {
      if (account.status === "disabled") continue;
      const list = accountsByProvider.get(account.providerId) ?? [];
      list.push(account);
      accountsByProvider.set(account.providerId, list);
    }
    this.accountsByProvider = accountsByProvider;
  }

  /** Tenant-specific setting wins over global; an unconfigured provider
   * falls back to `DEFAULT_PROXY_SKIP_PROVIDER_IDS`, mirroring the same
   * default `DrizzleProviderDetailStore.getRouting` reports to the API —
   * so the dashboard's displayed default and the real dispatch decision
   * never disagree. */
  private resolveSkipProxy(providerId: string, rowTenantId: string | null): boolean {
    const effectiveTenantId = rowTenantId;
    const tenantSetting = effectiveTenantId ? this.providerRouting[effectiveTenantId]?.[providerId] : undefined;
    const globalSetting = this.providerRouting.__global__?.[providerId];
    return resolveTenantOverride(
      tenantSetting?.skipProxy,
      globalSetting?.skipProxy,
      DEFAULT_PROXY_SKIP_PROVIDER_IDS.has(providerId),
    );
  }

  private resolveUserAgent(providerId: string, rowTenantId: string | null): string | undefined {
    const tenantSetting = rowTenantId ? this.providerRouting[rowTenantId]?.[providerId]?.userAgent : undefined;
    const globalSetting = this.providerRouting.__global__?.[providerId]?.userAgent;
    const tenantCustom = rowTenantId ? this.providerRouting[rowTenantId]?.[providerId]?.customUserAgent : undefined;
    const globalCustom = this.providerRouting.__global__?.[providerId]?.customUserAgent;
    // An operator-set custom User-Agent overrides the native identity when it
    // is non-empty; absent custom falls back to the native route identity.
    const custom = resolveTenantOverride(tenantCustom, globalCustom, undefined);
    if (custom !== undefined && custom !== null && custom.trim() !== "") return custom.trim();
    return resolveRouteUserAgent(providerId, tenantSetting, globalSetting);
  }

  /** Provider-wide concurrency ceiling shared by every account of the provider.
   * Tenant setting wins over global, mirroring skipProxy. A stored `null`
   * is the explicit unlimited choice; so is the default — a provider with no
   * routing row at all is unlimited too, because an operator who never
   * configured a ceiling asked for none. */
  private resolveMaxInflight(
    providerId: string,
    rowTenantId: string | null,
  ): number | undefined {
    const tenantSetting = rowTenantId
      ? this.providerRouting[rowTenantId]?.[providerId]?.maxInflight
      : undefined;
    const globalSetting = this.providerRouting.__global__?.[providerId]?.maxInflight;
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
  private resolveMaxInflightPerProxy(
    providerId: string,
    rowTenantId: string | null,
  ): number | undefined {
    const tenantSetting = rowTenantId
      ? this.providerRouting[rowTenantId]?.[providerId]?.maxInflightPerProxy
      : undefined;
    const globalSetting = this.providerRouting.__global__?.[providerId]?.maxInflightPerProxy;
    return tenantSetting ?? globalSetting ?? undefined;
  }

  /** Every active pool the account's tenant owns — dispatch picks the
   * least-loaded/non-cooldown one per request (`tryAcquireAvailablePool`),
   * never an admin-pinned single pool. */
  private resolveNetworkPools(
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
    if (!rowTenantId || this.resolveSkipProxy(providerId, rowTenantId)) return undefined;
    if (!this.configuredPoolTenants.has(rowTenantId)) return undefined;
    const pools = this.activePoolsByTenant.get(rowTenantId) ?? [];
    const limits: Record<string, number> = {};
    const weights: Record<string, number> = {};
    for (const pool of pools) {
      limits[pool.id] = pool.maxInflight;
      weights[pool.id] = pool.weight;
    }
    const routing = this.poolRouting[rowTenantId];
    return {
      ids: pools.map((pool) => pool.id),
      limits,
      weights,
      ...(routing ? { routing: { tenantId: rowTenantId, ...routing } } : {}),
    };
  }

  /** The candidate fragment for a provider ceiling, empty when unlimited —
   * so an unconfigured provider's candidate is byte-for-byte what it was. */
  private providerLimitFor(
    providerId: string,
    rowTenantId: string | null,
  ): { network_pool_provider_limit?: number } {
    const limit = this.resolveMaxInflightPerProxy(providerId, rowTenantId);
    return limit === undefined ? {} : { network_pool_provider_limit: limit };
  }

  /**
   * The field set shared by every `RoutedCandidate` literal in the fan-out
   * below. The four sites used to re-declare the same ~15-field shape, so a
   * field added to one had to be added to all four. `opts` carries only the
   * deltas that genuinely differ per site; health stamping is deliberately
   * NOT merged here — it happens at each site (inside the pool-account
   * literal, never for configured-pool tenants, conditional for public,
   * after construction for account rows), and collapsing those branches
   * would change routing.
   */
  private buildCandidateBase(
    model: MergedModelRow,
    capabilityProfile: Record<string, boolean>,
    opts: {
      readonly tenantId: string | null;
      /** `false` emits `requires_account: false` (credential-less route). */
      readonly requiresAccount?: boolean;
      readonly ownerTenantId?: string | null;
      readonly userAgent?: string;
      readonly accountId?: string;
      readonly proOnly?: boolean;
      readonly accountPlan?: string | null;
      readonly maxInflight?: number;
      readonly pools?: {
        readonly ids: readonly string[];
        readonly limits: Record<string, number>;
        readonly weights: Record<string, number>;
        /** `undefined` (from `resolveNetworkPools`) means no routing strategy. */
        readonly routing?: (PoolRoutingSetting & { tenantId: string }) | undefined;
      };
    },
  ): RoutedCandidate {
    return {
      provider_id: model.providerId,
      model_id: model.modelId,
      wire_family: model.wireFamily as WireFamily,
      ...(model.dialect == null ? {} : { dialect: model.dialect }),
      service_kind: model.serviceKind,
      endpoint: model.endpointPath,
      ...(model.outputLimit == null ? {} : { output_limit: model.outputLimit }),
      capability_profile: capabilityProfile,
      ...(opts.userAgent === undefined ? {} : { user_agent: opts.userAgent }),
      tenant_id: opts.tenantId,
      ...(model.freeTier === true ? { free_tier: true } : {}),
      // Public credential-less candidates have no account to own them.
      owner_tenant_id: opts.ownerTenantId ?? null,
      ...(opts.accountId === undefined ? {} : { provider_account_id: opts.accountId }),
      ...(opts.proOnly === true ? { pro_only: true } : {}),
      ...(opts.accountPlan === null || opts.accountPlan === undefined
        ? {}
        : { account_plan: opts.accountPlan }),
      ...(opts.maxInflight === undefined ? {} : { max_inflight: opts.maxInflight }),
      ...(opts.requiresAccount === false ? { requires_account: false as const } : {}),
      ...(opts.pools
        ? {
            network_pool_ids: opts.pools.ids,
            network_pool_required: true,
            network_pool_limits: opts.pools.limits,
            network_pool_weights: opts.pools.weights,
            ...(opts.pools.routing ? { network_pool_routing: opts.pools.routing } : {}),
            ...this.providerLimitFor(model.providerId, opts.tenantId),
          }
        : {}),
    };
  }

  /**
   * All candidates one model row fans out to: the credential-less public routes
   * (pool-account rows, configured-pool tenants, and the generic public route)
   * when the provider has no account rows, otherwise one candidate per account.
   */
  private buildModelCandidates(model: MergedModelRow): RoutedCandidate[] {
    const providerTenantId = this.providerTenantById.get(model.providerId);
    if (providerTenantId === undefined) return [];
    const accounts = this.accountsByProvider.get(model.providerId) ?? [];
    // One profile per model row, memoized across snapshot rebuilds. The
    // profile is derived purely from the row's metadata, is never mutated
    // (grep finds no write to `capability_profile`), and is shared by every
    // candidate this row fans out to — so a rebuild no longer constructs a
    // fresh object per model on top of the fan-out it already had.
    const capabilityProfile = capabilityProfileFor(model);
    if (accounts.length === 0) {
      return this.buildPublicCandidates(model, capabilityProfile, providerTenantId);
    }
    const candidates: RoutedCandidate[] = [];
    for (const account of accounts) {
      const candidate = this.buildAccountCandidate(model, capabilityProfile, account, providerTenantId);
      if (candidate !== null) candidates.push(candidate);
    }
    return candidates;
  }

  /** The credential-less fan-out for a provider with no account rows. */
  private buildPublicCandidates(
    model: MergedModelRow,
    capabilityProfile: Record<string, boolean>,
    providerTenantId: string | null,
  ): RoutedCandidate[] {
    const candidates: RoutedCandidate[] = [];
    const providerRequiresAccount = this.requiresAccountById.get(model.providerId) ?? true;
    if (!providerRequiresAccount) {
      // Public models inherit active pools for each tenant that has active pools.
      // When the provider is ip-scoped (limits follow the egress address), the
      // tenant's pool-account rows are the account-equivalent routing entities:
      // one candidate per pool, carrying that pool-account's health, so a spent
      // egress is excluded from the plan exactly like a cooling account.
      const ownedTenantIds = [...this.poolAccountsByTenant.keys()].filter((tid) =>
        (this.poolAccountsByTenant.get(tid) ?? []).some((pa) => pa.providerId === model.providerId),
      );
      let emittedPoolAccount = false;
      for (const tenantOwnerId of ownedTenantIds) {
        const poolAccounts = this.poolAccountsByTenant.get(tenantOwnerId) ?? [];
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
          const tenantPools = this.resolveNetworkPools(model.providerId, tenantOwnerId);
          if (!tenantPools) continue;
          emittedPoolAccount = true;
          const tenantCandidate = this.buildCandidateBase(model, capabilityProfile, {
            tenantId: tenantOwnerId,
            requiresAccount: false,
            pools: {
              ids: [poolId],
              limits: tenantPools.limits,
              weights: tenantPools.weights,
              routing: tenantPools.routing,
            },
          });
          // Pool-account health from the row: a spent egress is excluded
          // exactly like a cooling account, and the deadline rides along so
          // `plan()` can quote the real reset on an all-cooling answer.
          if (first.status === "disabled") {
            tenantCandidate.health_status = "disabled";
          } else if (first.status === "cooldown") {
            tenantCandidate.health_status = "cooldown";
            tenantCandidate.cooldown_kind = hardCooldownCategory(first.lastErrorCategory)
              ? "hard"
              : "soft";
            if (first.cooldownUntil && first.cooldownUntil.getTime() > Date.now()) {
              tenantCandidate.cooldown_until = first.cooldownUntil.getTime();
            }
          }
          candidates.push(tenantCandidate);
        }
      }
      if (emittedPoolAccount) return candidates;
      for (const tId of this.configuredPoolTenants) {
        const tenantPools = this.resolveNetworkPools(model.providerId, tId);
        if (tenantPools) {
          const tenantCandidate = this.buildCandidateBase(model, capabilityProfile, {
            tenantId: tId,
            requiresAccount: false,
            pools: {
              ids: tenantPools.ids,
              limits: tenantPools.limits,
              weights: tenantPools.weights,
              routing: tenantPools.routing,
            },
          });
          candidates.push(tenantCandidate);
        }
      }
    }
    const networkPools = providerRequiresAccount
      ? undefined
      : this.resolveNetworkPools(model.providerId, providerTenantId);
    const candidate = this.buildCandidateBase(model, capabilityProfile, {
      tenantId: providerTenantId,
      // A provider that requires an account but has none is unusable: the
      // public candidate is stamped disabled below. A genuinely
      // credential-less provider carries `requires_account: false` instead.
      ...(providerRequiresAccount ? {} : { requiresAccount: false }),
      ...(networkPools ? { pools: networkPools } : {}),
    });
    if (providerRequiresAccount) {
      candidate.health_status = "disabled";
    }
    candidates.push(candidate);
    return candidates;
  }

  /** The candidate for one account row, or `null` when a tenant-scoped
   * disable suppresses this (account, model) pair. */
  private buildAccountCandidate(
    model: MergedModelRow,
    capabilityProfile: Record<string, boolean>,
    account: AccountRouteRow,
    providerTenantId: string | null,
  ): RoutedCandidate | null {
    const rowTenantId = account.tenantId ?? providerTenantId;
    if (
      rowTenantId !== null &&
      this.disabledModelKeys.has(
        `${rowTenantId}:${model.providerId}:${model.modelId}:${model.endpointPath}`,
      )
    ) {
      return null;
    }
    const networkPools = this.resolveNetworkPools(model.providerId, rowTenantId);
    const routeUserAgent = this.resolveUserAgent(model.providerId, rowTenantId);
    const candidate = this.buildCandidateBase(model, capabilityProfile, {
      tenantId: rowTenantId,
      accountId: account.id,
      // The account's owning tenant (null = shared pool-wide) — the bucket
      // key for admission, distinct from the requesting tenant.
      ownerTenantId: account.tenantId ?? null,
      // The plan gate is per (account, model): the model may be refused on
      // a free plan and the account may be on one. Both ride here because
      // `plan()` sees the candidate and nothing else.
      ...(model.proOnly === true ? { proOnly: true } : {}),
      ...(account.quotaPlan === null || account.quotaPlan === undefined
        ? {}
        : { accountPlan: account.quotaPlan }),
      // Provider-wide concurrency ceiling from Routing Strategy; legacy
      // account overrides are never read here.
      ...(() => {
        const resolved = this.resolveMaxInflight(model.providerId, rowTenantId);
        return resolved === undefined ? {} : { maxInflight: resolved };
      })(),
      ...(routeUserAgent === undefined ? {} : { userAgent: routeUserAgent }),
      ...(networkPools ? { pools: networkPools } : {}),
    });
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
          ? this.anyTenantOverrides
          : this.cooldownOverrideTenants.has(rowTenantId);
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
    return candidate;
  }

  /** Fans out every model row into its candidates. */
  private fanOutCandidates(): RoutedCandidate[] {
    const candidates: RoutedCandidate[] = [];
    for (const model of this.mergedModelRows) {
      candidates.push(...this.buildModelCandidates(model));
    }
    return candidates;
  }

  /** Compiles aliases, CLI-tool alias buckets, and combos from their rows. */
  private assembleLookups(): {
    aliases: Record<string, Record<string, string>>;
    cliAliases: Record<string, Record<string, string>>;
    combos: Record<string, Record<string, ComboDefinition>>;
  } {
    const aliases: Record<string, Record<string, string>> = {};
    const cliAliases: Record<string, Record<string, string>> = {};
    for (const row of this.rows.aliasRows) {
      (aliases[row.tenantId] ??= {})[row.alias] = row.targetModel;
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
    for (const row of this.rows.cliMappingSettingRows) {
      if (row.mappingsEnabled) enabledMappingBuckets.add(`${row.tenantId}:${row.apiKeyId}`);
    }
    for (const row of this.rows.cliMappingRows) {
      if (!row.enabled) continue;
      if (!enabledMappingBuckets.has(`${row.tenantId}:${row.apiKeyId}`)) continue;
      const bucketKey = `${row.tenantId}:${row.apiKeyId}`;
      const aliasBucket = (cliAliases[bucketKey] ??= {});
      for (const sourceKey of cliMappingSourceKeys(row.toolId, row.sourceModel)) {
        aliasBucket[sourceKey] = row.targetModel;
      }
    }
    const combos: Record<string, Record<string, ComboDefinition>> = {};
    for (const row of this.rows.comboRows) {
      (combos[row.tenantId] ??= {})[row.name] = { members: row.members, strategy: row.strategy };
    }
    return { aliases, cliAliases, combos };
  }

  /** Builds the full snapshot result from the compiled rows. */
  snapshot(): RouteCatalogSnapshotResult {
    const candidates = this.fanOutCandidates();
    const { aliases, cliAliases, combos } = this.assembleLookups();
    const routingMap: ProviderRoutingMap | undefined =
      Object.keys(this.providerRouting).length > 0 ? (this.providerRouting as ProviderRoutingMap) : undefined;
    return {
      candidates,
      aliases,
      cli_aliases: cliAliases,
      combos,
      ...(routingMap ? { providerRouting: routingMap } : {}),
      ...(this.invokeDisabledTenants.size > 0 ? { invokeDisabledTenants: this.invokeDisabledTenants } : {}),
    };
  }
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
class RouteCatalogRepository {
  constructor(private readonly db: CartethyiaDatabase) {}

  async loadRouteCatalogSnapshot(): Promise<RouteCatalogSnapshotResult> {
    const rows = await readCatalogRows(this.db);
    return new RouteCatalogBuildContext(rows).snapshot();
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
    return repository.loadRouteCatalogSnapshot();
  };
}
