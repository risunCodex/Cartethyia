// Drizzle-backed provider, account, model, routing, and API-key repositories.
import { and, asc, eq, gte, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { isSqliteDatabase } from "../../../persistence/dialect";
import { ConsoleDomainError } from "../../shared/errors";
import { parseCustomProviderId, isBundledProviderId } from "../../../providers/provider-contracts";
import { providerRateLimitIsIpScoped } from "../../../providers/provider-metadata";
import type { ModelDefinition } from "../../../providers/provider-model-definition";
import type { ProviderRegistry } from "../../../providers/provider-registry";
import { BUNDLED_PROVIDER_MODULES } from "../../../providers/default-registry";
import { globalOrOwnedBy, ownedByOnly } from "../../../persistence/tenant-scope";
import { nextSortIndex, reorderSortIndex } from "../../../persistence/sort-order";
import type { CartethyiaDatabase } from "../../../persistence/db-handle";
import { buddyTaskLedger, models, networkPools, providerAccounts, providerOauthStates, providerPoolAccounts, providers, telemetryEvents, telemetryUsageTotals, tenantDisabledModels } from "../../../persistence/schema";
import { IS_GATEWAY_ERROR_SQL } from "../../../observability/event-query";
import type { WireFamily } from "../../../protocol/canonical-model";
import { listAccountHealthEvents, recoverAccount, deleteAccountHealthEvents, type AccountHealthEventRecord } from "../../../providers/operations/account-health-service";
import { invalidateCredentialCache, invalidateCredentialCaches } from "../../../providers/operations/provider-credential-service";
import { invalidateQuotaCaches } from "../../../providers/quota/cache";
import { encryptCredential, hashSecret } from "../../../security/crypto";
import type { TelemetryBatchBuffer } from "../../../observability/telemetry-buffer";
import type { RedisClient } from "../../../persistence/redis";
import { bumpCatalogRevision, type BundledProviderCatalog } from "../../../providers/operations/provider-catalog-service";
import type { AccountInflightReading, BuddyGrowthTaskLedgerEntry, ByokConnectionTestRequest, ByokConnectionTestResult, CreateProviderAccountBatchItemResult, CreateProviderAccountBatchResult, CreateProviderAccountRequest, CredentialMode, DiscoverModelCandidate, ModelCatalogEntry, ProbeAllAccountsResult, ProbeAllModelsResult, ProbeModelRequest, ProbeModelResult, ProviderAccountBulkActionResult, ProviderAccountResponse, ProviderAccountTokenUsage, ProviderCatalogStore, ProviderRecord, SetModelEnabledRequest, UpdateModelMetadataRequest, UpdateProviderAccountRequest, ModelMetadataOverride } from "./contracts";
import { isServiceKind, validateCompatibilityProfile } from "./contracts";
import { ProviderProbingService, type ProbeOutboundResolver } from "../../../providers/discovery/probing-service";
import {
  applyModelMetadataOverride,
  resolveManualModelMetadata,
} from "../../../providers/provider-model-definition";
import { isUniqueViolation } from "../../../persistence/boot";
import { DEFAULT_ENDPOINT_BY_WIRE_FAMILY, endpointPathForProviderModel, mapProviderRow } from "./catalog-projections";
import { pushStructuredConsoleLog } from "../../../observability/log-ring";

const emptyUsage: ProviderAccountTokenUsage = { requests: 0, errors: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 };

/**
 * The owning pool's provider cooldown markers, filtered to the ones still in
 * force and shaped like `NetworkPoolResponse.providerCooldowns`. Expired
 * markers are skipped — a spent window is not a reason to flag the row.
 */
function activePoolProviderCooldowns(
  markers: Record<string, { until: number; reason: string; blocked?: boolean }>,
): { providerId: string; until: string; reason: string; blocked: boolean }[] {
  const now = Date.now();
  const active: { providerId: string; until: string; reason: string; blocked: boolean }[] = [];
  for (const [providerId, marker] of Object.entries(markers)) {
    if (marker.until <= now) continue;
    active.push({
      providerId,
      until: new Date(marker.until).toISOString(),
      reason: marker.reason,
      blocked: marker.blocked === true,
    });
  }
  return active;
}

/** Real Drizzle-backed provider and model catalog repository. */

import {
  asStoredText,
  liveModelCooldowns,
  mapModelRow,
  nextGeneratedAccountLabel,
  parseJwtCredential,
  parsePastedOAuthCredential,
  withImageModality,
} from "./store-helpers";

export {
  accountLabelKindSegment,
  mapModelRow,
  nextGeneratedAccountLabel,
  withImageModality,
} from "./store-helpers";

export class DrizzleProviderCatalogStore implements ProviderCatalogStore {
  private readonly probing: ProviderProbingService;
  private readonly bundledModelCatalog: ReadonlyMap<string, readonly ModelDefinition[]>;
  private readonly providerRegistry: ProviderRegistry;
  private readonly redis: RedisClient | undefined;

  private readonly readAccountInflight:
    | ((
        providerId: string,
        tenantId: string,
      ) => Promise<readonly AccountInflightReading[]>)
    | undefined;

  constructor(
    private readonly db: CartethyiaDatabase,
    options: {
      readonly telemetryBuffer: TelemetryBatchBuffer;
      readonly bundledModelCatalog: BundledProviderCatalog;
      readonly providerRegistry: ProviderRegistry;
      readonly outboundFetchFor: ProbeOutboundResolver;
      readonly snapshotInvalidator: { invalidate(): unknown };
      readonly readAccountInflight?:
        | ((
            providerId: string,
            tenantId: string,
          ) => Promise<readonly AccountInflightReading[]>)
        | undefined;
      /** Shared Redis handle for quota-cache invalidation on bulk delete. */
      readonly redis?: RedisClient | undefined;
    },
  ) {
    this.bundledModelCatalog = options.bundledModelCatalog.modelsByProvider;
    this.providerRegistry = options.providerRegistry;
    this.readAccountInflight = options.readAccountInflight;
    this.redis = options.redis;
    this.probing = new ProviderProbingService({
      db,
      telemetryBuffer: options.telemetryBuffer,
      defaultEndpoints: DEFAULT_ENDPOINT_BY_WIRE_FAMILY,
      bundledModelCatalog: this.bundledModelCatalog,
      outboundFetchFor: options.outboundFetchFor,
      snapshotInvalidator: options.snapshotInvalidator,
      providerRegistry: options.providerRegistry,
    });
  }
  async list(tenantId: string): Promise<readonly ProviderRecord[]> {
    const bundledIds = BUNDLED_PROVIDER_MODULES.map((provider) => provider.id);
    const rows = await this.db
      .select()
      .from(providers)
      .where(
        and(
          globalOrOwnedBy(providers.tenantId, tenantId),
          or(inArray(providers.id, bundledIds), eq(providers.tenantId, tenantId)),
        ),
      )
      .orderBy(asc(providers.id));
    return rows.map((row) => mapProviderRow(row, this.providerRegistry));
  }
  async get(tenantId: string, providerId: string): Promise<ProviderRecord | undefined> {
    const rows = await this.db
      .select()
      .from(providers)
      .where(
        and(
          eq(providers.id, providerId),
          globalOrOwnedBy(providers.tenantId, tenantId),
        ),
      )
      .limit(1);
    const row = rows[0];
    return row ? mapProviderRow(row, this.providerRegistry) : undefined;
  }
  async create(record: ProviderRecord): Promise<void> {
    if (isBundledProviderId(record.providerId))
      throw new ConsoleDomainError(
        "provider_is_builtin",
        403,
        "Built-in provider cannot be created",
      );
    parseCustomProviderId(record.providerId);
    if (record.compatibilityProfile) validateCompatibilityProfile(record.compatibilityProfile);
    await this.db.insert(providers).values({
      id: record.providerId,
      tenantId: record.tenantId ?? null,
      enabled: record.enabled,
      ...(record.wireFamilyDefault ? { wireFamilyDefault: record.wireFamilyDefault } : {}),
      capabilityProfile: record.capabilityProfile ?? null,
      baseUrl: record.baseUrl ?? null,
      compatibilityProfile: record.compatibilityProfile ?? null,
    });
  }
  async update(
    tenantId: string,
    providerId: string,
    patch: Partial<ProviderRecord>,
  ): Promise<ProviderRecord | undefined> {
    if (isBundledProviderId(providerId))
      throw new ConsoleDomainError(
        "provider_is_builtin",
        403,
        "Built-in provider cannot be updated",
      );
    if (patch.compatibilityProfile) validateCompatibilityProfile(patch.compatibilityProfile);
    const set: Partial<typeof providers.$inferInsert> = {};
    if (patch.enabled !== undefined) set.enabled = patch.enabled;
    if (patch.capabilityProfile !== undefined) set.capabilityProfile = patch.capabilityProfile;
    if (patch.baseUrl !== undefined) set.baseUrl = patch.baseUrl;
    if (patch.compatibilityProfile !== undefined)
      set.compatibilityProfile = patch.compatibilityProfile;
    const rows =
      Object.keys(set).length > 0
        ? await this.db
            .update(providers)
            .set(set)
            .where(
              and(
                eq(providers.id, providerId),
                ownedByOnly(providers.tenantId, tenantId),
              ),
            )
            .returning()
        : await this.db
            .select()
            .from(providers)
            .where(
              and(
                eq(providers.id, providerId),
                ownedByOnly(providers.tenantId, tenantId),
              ),
            );
    const row = rows[0];
    return row ? mapProviderRow(row, this.providerRegistry) : undefined;
  }
  async delete(tenantId: string, providerId: string): Promise<boolean> {
    if (isBundledProviderId(providerId))
      throw new ConsoleDomainError(
        "provider_is_builtin",
        403,
        "Built-in provider cannot be deleted",
      );
    // Custom-provider rows own their models, accounts, disabled-model flags,
    // and routing preferences: deleting the parent cascades all of them
    // (models/provider_accounts/provider_oauth_states via provider FK,
    // health_events via account FK, tenant_disabled_models and
    // provider_routing_settings via provider FK) in one atomic DELETE.
    const deleted = await this.db
      .delete(providers)
      .where(and(eq(providers.id, providerId), ownedByOnly(providers.tenantId, tenantId)))
      .returning({ id: providers.id });
    if (deleted.length === 0) return false;
    this.providerRegistry.unregister(providerId);
    // The provider left the registry, so the compiled catalog is now missing it
    // — the snapshot's re-seed is gated on that revision, and a delete that did
    // not bump it would leave the provider's model rows behind.
    bumpCatalogRevision();
    return true;
  }
  async updateGlobal(
    providerId: string,
    patch: Partial<ProviderRecord>,
  ): Promise<ProviderRecord | undefined> {
    const isBuiltin = isBundledProviderId(providerId);
    if (isBuiltin && Object.keys(patch).some((field) => field !== "enabled")) {
      throw new ConsoleDomainError(
        "provider_is_builtin",
        403,
        "Built-in providers only support enable/disable",
      );
    }
    if (patch.compatibilityProfile) validateCompatibilityProfile(patch.compatibilityProfile);
    const set: Partial<typeof providers.$inferInsert> = {};
    if (patch.enabled !== undefined) set.enabled = patch.enabled;
    if (patch.capabilityProfile !== undefined) set.capabilityProfile = patch.capabilityProfile;
    if (patch.baseUrl !== undefined) set.baseUrl = patch.baseUrl;
    if (patch.compatibilityProfile !== undefined) {
      set.compatibilityProfile = patch.compatibilityProfile;
    }
    const rows =
      Object.keys(set).length > 0
        ? await this.db
            .update(providers)
            .set(set)
            .where(and(eq(providers.id, providerId), isNull(providers.tenantId)))
            .returning()
        : await this.db
            .select()
            .from(providers)
            .where(and(eq(providers.id, providerId), isNull(providers.tenantId)));
    const row = rows[0];
    return row ? mapProviderRow(row, this.providerRegistry) : undefined;
  }

  async deleteGlobal(providerId: string): Promise<boolean> {
    if (isBundledProviderId(providerId)) {
      throw new ConsoleDomainError(
        "provider_is_builtin",
        403,
        "Built-in provider cannot be deleted",
      );
    }
    const rows = await this.db
      .delete(providers)
      .where(and(eq(providers.id, providerId), isNull(providers.tenantId)))
      .returning({ id: providers.id });
    return rows.length > 0;
  }
  async listModels(tenantId: string, providerId: string): Promise<readonly ModelCatalogEntry[]> {
    const byProvider = await this.listModelsForTenant(tenantId, providerId);
    return byProvider.get(providerId) ?? [];
  }

  /**
   * Every enabled-and-disabled model row the tenant can see, grouped by
   * provider. One pair of statements for the whole tenant instead of a pair per
   * provider.
   *
   * The per-provider `listModels` shape costs two queries per call, so a caller
   * that needs every provider's models — the flat catalog the picker renders —
   * issued `2 * providers + 2` statements, growing with the bundled catalog.
   * Grouping here makes it constant: one disabled-model read and one models
   * join, regardless of provider count. `providerId` narrows it to a single
   * provider for callers that already know which one they want.
   */
  async listModelsForTenant(
    tenantId: string,
    providerId?: string,
  ): Promise<Map<string, readonly ModelCatalogEntry[]>> {
    const disabled = await this.db
      .select({
        providerId: tenantDisabledModels.providerId,
        modelId: tenantDisabledModels.modelId,
        endpointPath: tenantDisabledModels.endpointPath,
      })
      .from(tenantDisabledModels)
      .where(
        providerId === undefined
          ? eq(tenantDisabledModels.tenantId, tenantId)
          : and(
              eq(tenantDisabledModels.tenantId, tenantId),
              eq(tenantDisabledModels.providerId, providerId),
            ),
      );
    const disabledKeys = new Set(
      disabled.map((d) => `${d.providerId}::${d.modelId}::${d.endpointPath}`),
    );
    const dbRows = await this.db
      .select({ model: models })
      .from(models)
      .innerJoin(providers, eq(models.providerId, providers.id))
      .where(
        and(
          ...(providerId === undefined ? [] : [eq(models.providerId, providerId)]),
          globalOrOwnedBy(providers.tenantId, tenantId),
        ),
      );
    const grouped = new Map<string, ModelCatalogEntry[]>();
    for (const { model: row } of dbRows) {
      const isDisabled = disabledKeys.has(
        `${row.providerId}::${row.modelId}::${row.endpointPath}`,
      );
      const list = grouped.get(row.providerId) ?? [];
      list.push(mapModelRow(row, isDisabled));
      grouped.set(row.providerId, list);
    }
    return grouped;
  }
  async registerModels(
    tenantId: string,
    providerId: string,
    modelIds: readonly string[],
    wireFamily?: string,
    metadata?: ModelMetadataOverride,
  ): Promise<void> {
    const owner = await this.db
      .select({
        id: providers.id,
        baseUrl: providers.baseUrl,
        compatibilityProfile: providers.compatibilityProfile,
      })
      .from(providers)
      .where(and(eq(providers.id, providerId), globalOrOwnedBy(providers.tenantId, tenantId)))
      .limit(1);
    if (!owner[0]) {
      throw new ConsoleDomainError("provider_not_found", 404, `Provider ${providerId} not found`);
    }
    const family = (wireFamily ?? "chat") as WireFamily;
    // Static endpoint from the provider's own bundled catalog via the probing
    // service (the same startup-built map this store is constructed with).
    // Without this, bundled providers on versioned bases (cline) get the
    // generic `/v1/…` default, which joins into an unreachable path and every
    // probe/dispatch 404s.
    const staticEndpoint = await this.probing.resolveStaticEndpoint(providerId, family);
    const endpointPath = endpointPathForProviderModel(
      family,
      owner[0].compatibilityProfile,
      staticEndpoint === undefined ? undefined : { [family]: staticEndpoint },
    );
    if (modelIds.length === 0) return;
    // Single multi-row insert and upsert of the capability flags so a
    // re-registration repairs a row whose `tool_call` (and `reasoning`) was
    // seeded false — a manual add persists schema defaults, which capability
    // preflight reads as "route cannot use tools" and silently strips `tools`
    // from every request. `enabled` stays operator-owned; `source` is refreshed
    // to `manual`.
    await this.db
      .insert(models)
      .values(
        modelIds.map((modelId) => ({
          providerId,
          modelId,
          wireFamily: family,
          endpointPath,
          ...applyModelMetadataOverride(
            resolveManualModelMetadata(providerId, modelId),
            metadata,
          ),
          source: "manual",
          sourceUpdatedAt: new Date(),
          enabled: true,
        })),
      )
      .onConflictDoUpdate({
        target: [models.providerId, models.modelId, models.endpointPath],
        set: {
          wireFamily: sql`excluded.wire_family`,
          contextLimit: sql`excluded.context_limit`,
          outputLimit: sql`excluded.output_limit`,
          modalities: sql`excluded.modalities`,
          reasoning: sql`excluded.reasoning`,
          toolCall: sql`excluded.tool_call`,
          source: sql`'manual'`,
          sourceUpdatedAt: sql`excluded.source_updated_at`,
        },
      });
  }

  /**
   * One-shot connectivity probe and model discovery live in
   * `services/provider-probing.ts` — the store only forwards so the domain
   * `ProviderCatalogStore` interface is unchanged.
   */
  async probeModel(
    tenantId: string,
    providerId: string,
    request: ProbeModelRequest,
  ): Promise<ProbeModelResult> {
    return this.probing.probeModel(tenantId, providerId, request);
  }

  /** Ad-hoc BYOK connectivity test; delegates to the shared probing service. */
  async testByokConnection(
    tenantId: string,
    request: ByokConnectionTestRequest,
  ): Promise<ByokConnectionTestResult> {
    return this.probing.testByokConnection(tenantId, request);
  }

  /**
   * Batched provider-wide probe: the first registered model runs sequentially
   * (warms OAuth token / connection pools), the rest run concurrently bounded
   * to 5. Registered model ids come from this store's own catalog read.
   */
  async probeAllModels(
    tenantId: string,
    providerId: string,
    mode?: ProbeModelRequest["mode"],
  ): Promise<ProbeAllModelsResult> {
    const entries = await this.listModels(tenantId, providerId);
    const requests = entries.map((entry) => ({
      modelId: entry.modelId,
      route: entry.route,
      serviceKind: isServiceKind(entry.serviceKind) ? entry.serviceKind : ("llm" as const),
      ...(mode === undefined ? {} : { mode }),
    }));
    const uniqueRequests = requests.filter(
      (request, index, all) =>
        all.findIndex(
          (candidate) =>
            candidate.modelId === request.modelId &&
            candidate.route === request.route &&
            candidate.serviceKind === request.serviceKind,
        ) === index,
    );
    return this.probing.probeAllModels(tenantId, providerId, uniqueRequests);
  }
  async probeAllAccounts(
    tenantId: string,
    providerId: string,
    request: ProbeModelRequest,
): Promise<ProbeAllAccountsResult> {
    return this.probing.probeAllAccounts(tenantId, providerId, request);
  }
  /** Toggles a persisted model's routing eligibility. */
  async setModelEnabled(
    tenantId: string,
    providerId: string,
    request: SetModelEnabledRequest,
  ): Promise<boolean> {
    // Tenant-owned (BYOK) model: toggle the shared row directly.
    const owned = await this.db
      .select({ id: models.id })
      .from(models)
      .innerJoin(providers, eq(models.providerId, providers.id))
      .where(
        and(
          eq(models.providerId, providerId),
          eq(models.modelId, request.modelId),
          eq(models.endpointPath, request.route),
          ownedByOnly(providers.tenantId, tenantId),
        ),
      )
      .limit(1);
    const ownedTarget = owned[0];
    if (ownedTarget) {
      await this.db
        .update(models)
        .set({ enabled: request.enabled })
        .where(eq(models.id, ownedTarget.id));
      return true;
    }

    // Global/built-in model: tenants cannot mutate the shared row, so record
    // (or clear) a tenant-scoped disable in `tenantDisabledModels`.
    const global = await this.db
      .select({ id: models.id })
      .from(models)
      .innerJoin(providers, eq(models.providerId, providers.id))
      .where(
        and(
          eq(models.providerId, providerId),
          eq(models.modelId, request.modelId),
          eq(models.endpointPath, request.route),
          isNull(providers.tenantId),
        ),
      )
      .limit(1);
    if (global[0] === undefined) return false;
    if (request.enabled) {
      await this.db
        .delete(tenantDisabledModels)
        .where(
          and(
            eq(tenantDisabledModels.tenantId, tenantId),
            eq(tenantDisabledModels.providerId, providerId),
            eq(tenantDisabledModels.modelId, request.modelId),
            eq(tenantDisabledModels.endpointPath, request.route),
          ),
        );
      return true;
    }
    await this.db
      .insert(tenantDisabledModels)
      .values({
        tenantId,
        providerId,
        modelId: request.modelId,
        endpointPath: request.route,
      })
      .onConflictDoNothing({
        target: [
          tenantDisabledModels.tenantId,
          tenantDisabledModels.providerId,
          tenantDisabledModels.modelId,
          tenantDisabledModels.endpointPath,
        ],
      });
    return true;
  }

  /**
   * Updates one model's limits and capability flags.
   *
   * Two row kinds are writable. A tenant-owned (BYOK) row is updated directly.
   * A model belonging to a *global* provider row is also updated directly:
   * bundled providers are seeded once with `tenant_id IS NULL` and `providers.id`
   * is the primary key, so a bundled provider can only ever have that one row —
   * there is no tenant-scoped row to edit instead. Auto-fetched rows
   * (`discovered` / `auto_free`) live on exactly those providers, which is why
   * the previous `ownedByOnly` filter answered `not_found` for every model the
   * operator had just fetched and could not be edited at all.
   *
   * A global `builtin` row is rejected: it is re-seeded from the bundle on every
   * boot, so an edit there would be silently reverted, and `deleteModel` refuses
   * it for the same reason.
   *
   * Absent override fields leave the stored value untouched — an edit that only
   * sets the context ceiling must not reset the capability flags.
   */
  async updateModelMetadata(
    tenantId: string,
    providerId: string,
    request: UpdateModelMetadataRequest,
  ): Promise<boolean> {
    const findRow = (ownership: SQL) =>
      this.db
        .select({ id: models.id, modalities: models.modalities, source: models.source })
        // source is read for both the global builtin guard above and the new
        // non-builtin-only warning edit.
        .from(models)
        .innerJoin(providers, eq(models.providerId, providers.id))
        .where(
          and(
            eq(models.providerId, providerId),
            eq(models.modelId, request.modelId),
            eq(models.endpointPath, request.route),
            ownership,
          ),
        )
        .limit(1);
    const owned = await findRow(ownedByOnly(providers.tenantId, tenantId));
    let row = owned[0];
    if (row === undefined) {
      const global = await findRow(isNull(providers.tenantId));
      const candidate = global[0];
      if (candidate === undefined) return false;
      if (candidate.source === "builtin") {
        throw new ConsoleDomainError(
          "builtin_model_immutable",
          403,
          `Built-in model ${providerId}/${request.modelId} cannot be edited — the bundle re-seeds it on every boot`,
        );
      }
      row = candidate;
    }

    const override = request.metadata;
    const set: Record<string, unknown> = { sourceUpdatedAt: new Date() };
    if (override?.contextLimit !== undefined) set.contextLimit = override.contextLimit;
    if (override?.outputLimit !== undefined) set.outputLimit = override.outputLimit;
    // Passthrough grants every capability and cannot be partly revoked by a
    // per-flag field: the point of the flag is that the operator does not know
    // which capabilities the model has, so an explicit `false` alongside it is
    // either stale or a mistake.
    // Builtin rows are re-seeded from the static catalog on every boot, so a
    // warning edit there would be reverted. Non-builtin rows (including ones a
    // discovery commit created) are operator-owned and may set or clear them.
    if (override?.warnings !== undefined) {
      if (row.source === "builtin") {
        throw new ConsoleDomainError(
          "builtin_model_immutable",
          403,
          `Built-in model ${providerId}/${request.modelId} warnings cannot be edited — the bundle re-seeds them on every boot`,
        );
      }
      set.warningMetadata =
        override.warnings === null
          ? null
          : {
              warnings: override.warnings.map((warning) => ({
                kind: warning.kind,
                message: warning.message,
                ...(warning.severity === undefined ? {} : { severity: warning.severity }),
                ...(warning.updatedAt === undefined ? {} : { updatedAt: warning.updatedAt }),
              })),
            };
    }
    if (override?.passthrough === true) {
      set.reasoning = true;
      set.toolCall = true;
      set.modalities = withImageModality(asStoredText(row.modalities), true);
    } else {
      if (override?.reasoning !== undefined) set.reasoning = override.reasoning;
      if (override?.toolCall !== undefined) set.toolCall = override.toolCall;
      if (override?.image !== undefined)
        set.modalities = withImageModality(asStoredText(row.modalities), override.image);
    }
    await this.db.update(models).set(set).where(eq(models.id, row.id));
    return true;
  }

  async deleteModel(
    tenantId: string,
    providerId: string,
    request: SetModelEnabledRequest,
  ): Promise<boolean> {
    const owned = await this.db
      .select({ id: models.id })
      .from(models)
      .innerJoin(providers, eq(models.providerId, providers.id))
      .where(
        and(
          eq(models.providerId, providerId),
          eq(models.modelId, request.modelId),
          eq(models.endpointPath, request.route),
          ownedByOnly(providers.tenantId, tenantId),
        ),
      )
      .limit(1);
    const target = owned[0];
    if (target) {
      const rows = await this.db
        .delete(models)
        .where(eq(models.id, target.id))
        .returning({ id: models.id });
      return rows.length > 0;
    }
    const global = await this.db
      .select({ id: models.id, source: models.source })
      .from(models)
      .innerJoin(providers, eq(models.providerId, providers.id))
      .where(
        and(
          eq(models.providerId, providerId),
          eq(models.modelId, request.modelId),
          eq(models.endpointPath, request.route),
          isNull(providers.tenantId),
        ),
      )
      .limit(1);
    if (!global[0]) return false;
    // Built-in models are immutable catalog: tenants can only disable them
    // (via tenantDisabledModels), never delete the shared row.
    if (global[0].source === "builtin") {
      throw new ConsoleDomainError(
        "builtin_model_immutable",
        403,
        `Built-in model ${providerId}/${request.modelId} cannot be deleted — disable it instead`,
      );
    }
    const rows = await this.db
      .delete(models)
      .where(eq(models.id, global[0].id))
      .returning({ id: models.id });
    await this.db
      .delete(tenantDisabledModels)
      .where(
        and(
          eq(tenantDisabledModels.tenantId, tenantId),
          eq(tenantDisabledModels.providerId, providerId),
          eq(tenantDisabledModels.modelId, request.modelId),
          eq(tenantDisabledModels.endpointPath, request.route),
        ),
      );
    return rows.length > 0;
  }

  private async accountsWithUsage(
    tenantId: string,
    rows: readonly (typeof providerAccounts.$inferSelect)[],
  ): Promise<readonly ProviderAccountResponse[]> {
    if (rows.length === 0) return [];
    const accountIds = rows.map((row) => row.id);
    // Today's per-account usage is one GROUP BY, not a read of every event
    // since midnight. The read is scoped to the accounts on this page via the
    // `(tenant, account, created_at)` index — a full-tenant breakdown scanned
    // every of today's events and capped at 100 groups, so an account past
    // the cap silently read as "no usage today".
    const todayGroups = await this.accountTodayUsage(tenantId, accountIds);
    const todayByAccount = new Map(
      todayGroups.map((group) => [
        group.key,
        {
          requests: group.requests,
          errors: group.errors,
          inputTokens: group.inputTokens,
          outputTokens: group.outputTokens,
        },
      ]),
    );
    const [lifetimeRows] = await Promise.all([
      this.db
        .select()
        .from(telemetryUsageTotals)
        .where(
          and(
            eq(telemetryUsageTotals.tenantId, tenantId),
            eq(telemetryUsageTotals.identityType, "account"),
            inArray(telemetryUsageTotals.entityId, accountIds),
          ),
        ),
    ]);
    const lifetimeByAccount = new Map(lifetimeRows.map((row) => [row.entityId, row]));
    const mapUsage = (row: {
      readonly requests: number | string | null;
      readonly errors: number | string | null;
      readonly inputTokens: number | string | null;
      readonly outputTokens: number | string | null;
    } | undefined): ProviderAccountTokenUsage => {
      const inputTokens = Number(row?.inputTokens ?? 0);
      const outputTokens = Number(row?.outputTokens ?? 0);
      return {
        requests: Number(row?.requests ?? 0),
        errors: Number(row?.errors ?? 0),
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
      };
    };
    const first = rows[0];
    const inflightByAccount = await this.accountInflightFor(tenantId, first?.providerId);
    return rows.map((row) => {
      const inflight = inflightByAccount.get(row.id);
      return this.mapAccount(row, {
        today: mapUsage(todayByAccount.get(row.id)),
        allTime: mapUsage(lifetimeByAccount.get(row.id)),
        ...(inflight === undefined ? {} : { inflight }),
      });
    });
  }

  /**
   * Today's per-account usage for a concrete id set. Scoped to those ids so
   * the `(tenant, account, created_at)` index serves the range instead of a
   * full-tenant window scan; returns exactly one group per account with
   * traffic, so an account is never lost to a top-N cap.
   */
  private async accountTodayUsage(
    tenantId: string,
    accountIds: readonly string[],
  ): Promise<
    Array<{ key: string; requests: number; errors: number; inputTokens: number; outputTokens: number }>
  > {
    if (accountIds.length === 0) return [];
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);
    const rows = await this.db
      .select({
        accountId: telemetryEvents.accountId,
        requests: sql<number>`count(*)`,
        errors: sql<number>`sum(case when ${IS_GATEWAY_ERROR_SQL} then 1 else 0 end)`,
        inputTokens: sql<number>`coalesce(sum(${telemetryEvents.inputTokens}), 0)`,
        outputTokens: sql<number>`coalesce(sum(${telemetryEvents.outputTokens}), 0)`,
      })
      .from(telemetryEvents)
      .where(
        and(
          eq(telemetryEvents.tenantId, tenantId),
          gte(telemetryEvents.createdAt, todayStart),
          inArray(telemetryEvents.accountId, accountIds),
        ),
      )
      .groupBy(telemetryEvents.accountId);
    return rows.flatMap((row) => {
      if (row.accountId === null) return [];
      return [
        {
          key: row.accountId,
          requests: Number(row.requests),
          errors: Number(row.errors),
          inputTokens: Number(row.inputTokens),
          outputTokens: Number(row.outputTokens),
        },
      ];
    });
  }

  private async accountInflightFor(
    tenantId: string,
    providerId: string | undefined,
  ): Promise<Map<string, number>> {
    const readings = new Map<string, number>();
    if (!this.readAccountInflight || !providerId) return readings;
    const rows = await this.readAccountInflight(providerId, tenantId);
    for (const row of rows) {
      if (typeof row.accountId !== "string" || !Number.isFinite(row.inflight)) continue;
      readings.set(row.accountId, Math.max(0, Math.floor(row.inflight)));
    }
    return readings;
  }

  /**
   * Next free list position for a new account in this provider's list.
   *
   * Scoped to (provider, tenant) because the list is per provider: a tenant
   * with accounts under two providers must not have the second provider's
   * first account land at a high index.
   */
  /**
   * Labels already in use for one provider, for numbering a generated name.
   *
   * Scoped to this provider and tenant: `dcint-key-1` and `other-key-1` belong
   * to different providers and must not collide with each other.
   */
  private async generateAccountLabel(
    db: CartethyiaDatabase | Parameters<Parameters<CartethyiaDatabase["transaction"]>[0]>[0],
    providerId: string,
    tenantId: string,
    credentialMode: CredentialMode,
  ): Promise<string> {
    const rows = await db
      .select({ label: providerAccounts.label })
      .from(providerAccounts)
      .where(
        and(
          eq(providerAccounts.providerId, providerId),
          globalOrOwnedBy(providerAccounts.tenantId, tenantId),
        ),
      );
    return nextGeneratedAccountLabel(
      providerId,
      credentialMode,
      rows.map((row) => row.label).filter((label): label is string => typeof label === "string"),
    );
  }

  private async nextAccountSortIndex(
    db: CartethyiaDatabase | Parameters<Parameters<CartethyiaDatabase["transaction"]>[0]>[0],
    providerId: string,
    tenantId: string,
  ): Promise<number> {
    return nextSortIndex(
      db,
      { table: providerAccounts, idColumn: providerAccounts.id, sortIndexColumn: providerAccounts.sortIndex },
      and(
        eq(providerAccounts.providerId, providerId),
        globalOrOwnedBy(providerAccounts.tenantId, tenantId),
      ),
    );
  }

  /** Rewrites one provider's account order; `accountIds` is the full order. */
  async reorderAccounts(
    tenantId: string,
    providerId: string,
    accountIds: readonly string[],
  ): Promise<void> {
    await reorderSortIndex(
      this.db,
      { table: providerAccounts, idColumn: providerAccounts.id, sortIndexColumn: providerAccounts.sortIndex },
      and(
        eq(providerAccounts.providerId, providerId),
        globalOrOwnedBy(providerAccounts.tenantId, tenantId),
      ),
      accountIds,
    );
  }

  async listAccountAuthStates(
    tenantId: string,
    providerId: string,
    accountIds: readonly string[],
  ): Promise<Readonly<Record<string, Readonly<Record<string, unknown>>>>> {
    if (accountIds.length === 0) return {};
    const rows = await this.db
      .select({ id: providerAccounts.id, authState: providerAccounts.authState })
      .from(providerAccounts)
      .where(
        and(
          eq(providerAccounts.providerId, providerId),
          globalOrOwnedBy(providerAccounts.tenantId, tenantId),
          inArray(providerAccounts.id, accountIds),
        ),
      );
    const out: Record<string, Readonly<Record<string, unknown>>> = {};
    for (const row of rows) {
      if (row.authState !== null && typeof row.authState === "object" && !Array.isArray(row.authState)) {
        out[row.id] = row.authState as Record<string, unknown>;
      }
    }
    return out;
  }

  async listAccounts(
    tenantId: string,
    providerId: string,
  ): Promise<readonly ProviderAccountResponse[]> {
    const rows = await this.db
      .select()
      .from(providerAccounts)
      .where(
        and(
          eq(providerAccounts.providerId, providerId),
          globalOrOwnedBy(providerAccounts.tenantId, tenantId),
        ),
      )
      // Stable list position, not `created_at`: two accounts created in the
      // same millisecond could swap between loads. `id` breaks a tie so the
      // order is total even before a reorder assigns distinct indices.
      .orderBy(asc(providerAccounts.sortIndex), asc(providerAccounts.createdAt), asc(providerAccounts.id));
    const accounts = await this.accountsWithUsage(tenantId, rows);
    const poolAccounts = await this.listPoolAccounts(tenantId, providerId);
    if (poolAccounts.length === 0) return accounts;
    // Pool-as-account rows are appended after real accounts. They are
    // account *equivalents* for ip-scoped, credential-less providers, so the
    // operator sees the egresses that carry those providers' rate limits in
    // the same list that already explains health.
    return [...accounts, ...poolAccounts];
  }

  /**
   * One cheap id-only read of an account set, for callers that need the set
   * (e.g. the routing-inflight reader) without the usage aggregates
   * `listAccounts` computes (P-02). No ORDER BY: the set is order-insensitive.
   */
  async listAccountIds(
    tenantId: string,
    providerId: string,
  ): Promise<readonly string[]> {
    const rows = await this.db
      .select({ id: providerAccounts.id })
      .from(providerAccounts)
      .where(
        and(
          eq(providerAccounts.providerId, providerId),
          globalOrOwnedBy(providerAccounts.tenantId, tenantId),
        ),
      );
    return rows.map((row) => row.id);
  }

  async listAllAccounts(tenantId: string): Promise<readonly ProviderAccountResponse[]> {
    const rows = await this.db
      .select()
      .from(providerAccounts)
      .where(globalOrOwnedBy(providerAccounts.tenantId, tenantId))
      .orderBy(asc(providerAccounts.sortIndex), asc(providerAccounts.createdAt), asc(providerAccounts.id));
    const accounts = await this.accountsWithUsage(tenantId, rows);
    const poolAccounts = await this.listAllPoolAccounts(tenantId);
    if (poolAccounts.length === 0) return accounts;
    return [...accounts, ...poolAccounts];
  }

  async listAllAccountSummaries(
    tenantId: string,
  ): Promise<readonly { providerId: string; status: string }[]> {
    const rows = await this.db
      .select({ providerId: providerAccounts.providerId, status: providerAccounts.status })
      .from(providerAccounts)
      .where(globalOrOwnedBy(providerAccounts.tenantId, tenantId));
    return rows.map((row) => ({ providerId: row.providerId, status: row.status }));
  }

  /**
   * Per-provider account totals for one tenant, from a single grouped read (one
   * statement, served by the `(provider_id, tenant_id)` index). `active` counts
   * every status except `disabled` — an account parked by the health machine
   * (`cooldown`) is still a connection, matching how the account-overview badge
   * reads status. Used by the provider list overview (`accountCount` /
   * `activeAccountCount`); totals are never counted in a per-provider loop.
   */
  async providerAccountCounts(
    tenantId: string,
  ): Promise<readonly { providerId: string; total: number; active: number }[]> {
    const rows = await this.db
      .select({
        providerId: providerAccounts.providerId,
        total: sql<number>`count(*)`,
        active: sql<number>`sum(case when ${providerAccounts.status} <> 'disabled' then 1 else 0 end)`,
      })
      .from(providerAccounts)
      .where(globalOrOwnedBy(providerAccounts.tenantId, tenantId))
      .groupBy(providerAccounts.providerId);
    return rows.map((row) => ({
      providerId: row.providerId,
      total: Number(row.total),
      active: Number(row.active),
    }));
  }

  /**
   * Per-provider enabled model-row counts for one tenant, from a single grouped
   * read over `models ⋈ providers`. A model counts only when the row is enabled
   * and the tenant has not suppressed it via `tenant_disabled_models` — the
   * same visibility rule the per-provider model listing applies, so the
   * overview badge never disagrees with what the detail page would list.
   */
  async providerModelCounts(
    tenantId: string,
  ): Promise<readonly { providerId: string; count: number }[]> {
    const rows = await this.db
      .select({ providerId: models.providerId, count: sql<number>`count(*)` })
      .from(models)
      .innerJoin(providers, eq(models.providerId, providers.id))
      .leftJoin(
        tenantDisabledModels,
        and(
          eq(tenantDisabledModels.tenantId, tenantId),
          eq(tenantDisabledModels.providerId, models.providerId),
          eq(tenantDisabledModels.modelId, models.modelId),
          eq(tenantDisabledModels.endpointPath, models.endpointPath),
        ),
      )
      .where(
        and(
          eq(models.enabled, true),
          globalOrOwnedBy(providers.tenantId, tenantId),
          isNull(tenantDisabledModels.id),
        ),
      )
      .groupBy(models.providerId);
    return rows.map((row) => ({ providerId: row.providerId, count: Number(row.count) }));
  }

  /**
   * Pool-as-account rows for one provider. Only providers whose rate limit
   * follows the egress address materialize these; every other provider's pool
   * list stays empty, so real accounts are returned unchanged.
   *
   * The pool row is the source of health truth: `provider_pool_accounts`
   * rows are created at backfill and never mutated, so the surface reads the
   * owning pool's live status/last-* fields and lives on top of them.
   */
  private async listPoolAccounts(
    tenantId: string,
    providerId: string,
  ): Promise<readonly ProviderAccountResponse[]> {
    if (!providerRateLimitIsIpScoped(providerId)) return [];
    const rows = await this.db
      .select()
      .from(providerPoolAccounts)
      .where(
        and(
          eq(providerPoolAccounts.providerId, providerId),
          eq(providerPoolAccounts.tenantId, tenantId),
        ),
      )
      .orderBy(asc(providerPoolAccounts.createdAt), asc(providerPoolAccounts.id));
    if (rows.length === 0) return [];
    const pools = await this.poolsById(tenantId, rows.map((row) => row.networkPoolId));
    const usage = await this.poolUsage(tenantId, rows.map((row) => row.networkPoolId));
    return rows.map((row) => this.mapPoolAccount(row, pools.get(row.networkPoolId), usage.get(row.networkPoolId)));
  }

  /** Pool-as-account rows across every provider, for tenant-wide listings. */
  private async listAllPoolAccounts(
    tenantId: string,
  ): Promise<readonly ProviderAccountResponse[]> {
    const rows = await this.db
      .select()
      .from(providerPoolAccounts)
      .where(eq(providerPoolAccounts.tenantId, tenantId))
      .orderBy(asc(providerPoolAccounts.createdAt), asc(providerPoolAccounts.id));
    if (rows.length === 0) return [];
    const pools = await this.poolsById(tenantId, rows.map((row) => row.networkPoolId));
    const usage = await this.poolUsage(tenantId, rows.map((row) => row.networkPoolId));
    return rows.map((row) => this.mapPoolAccount(row, pools.get(row.networkPoolId), usage.get(row.networkPoolId)));
  }

  /** Selects the owning network pools for a set of pool-account rows. */
  private async poolsById(
    tenantId: string,
    poolIds: readonly string[],
  ): Promise<Map<string, typeof networkPools.$inferSelect>> {
    const map = new Map<string, typeof networkPools.$inferSelect>();
    if (poolIds.length === 0) return map;
    const rows = await this.db
      .select()
      .from(networkPools)
      .where(
        and(
          eq(networkPools.tenantId, tenantId),
          inArray(networkPools.id, poolIds),
        ),
      );
    for (const row of rows) map.set(row.id, row);
    return map;
  }

  /**
   * Today + lifetime token usage per pool, from telemetry. Pools carry no
   * rows in `telemetry_usage_totals` (that table only admits account/api_key
   * identity types), so lifetime here is aggregated from the retained event
   * window (the same bounded window the usage page reads) rather than from
   * durable rollups.
   */
  private async poolUsage(
    tenantId: string,
    poolIds: readonly string[],
  ): Promise<Map<string, { today: ProviderAccountTokenUsage; allTime: ProviderAccountTokenUsage }>> {
    const map = new Map<string, { today: ProviderAccountTokenUsage; allTime: ProviderAccountTokenUsage }>();
    if (poolIds.length === 0) return map;
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);
    const [todayRows, lifetimeRows] = await Promise.all([
      this.db
        .select({
          poolId: telemetryEvents.networkPoolId,
          requests: sql<number>`count(*)`,
          errors: sql<number>`sum(case when ${IS_GATEWAY_ERROR_SQL} then 1 else 0 end)`,
          inputTokens: sql<number>`coalesce(sum(${telemetryEvents.inputTokens}), 0)`,
          outputTokens: sql<number>`coalesce(sum(${telemetryEvents.outputTokens}), 0)`,
        })
        .from(telemetryEvents)
        .where(
          and(
            eq(telemetryEvents.tenantId, tenantId),
            gte(telemetryEvents.createdAt, todayStart),
            inArray(telemetryEvents.networkPoolId, poolIds),
          ),
        )
        .groupBy(telemetryEvents.networkPoolId),
      this.db
        .select({
          poolId: telemetryEvents.networkPoolId,
          requests: sql<number>`count(*)`,
          errors: sql<number>`sum(case when ${IS_GATEWAY_ERROR_SQL} then 1 else 0 end)`,
          inputTokens: sql<number>`coalesce(sum(${telemetryEvents.inputTokens}), 0)`,
          outputTokens: sql<number>`coalesce(sum(${telemetryEvents.outputTokens}), 0)`,
        })
        .from(telemetryEvents)
        .where(
          and(
            eq(telemetryEvents.tenantId, tenantId),
            inArray(telemetryEvents.networkPoolId, poolIds),
          ),
        )
        .groupBy(telemetryEvents.networkPoolId),
    ]);
    const toUsage = (row: {
      readonly requests: number | string | null;
      readonly errors: number | string | null;
      readonly inputTokens: number | string | null;
      readonly outputTokens: number | string | null;
    }): ProviderAccountTokenUsage => {
      const inputTokens = Number(row.inputTokens ?? 0);
      const outputTokens = Number(row.outputTokens ?? 0);
      return {
        requests: Number(row.requests ?? 0),
        errors: Number(row.errors ?? 0),
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
      };
    };
    for (const id of poolIds) {
      const today = todayRows.find((row) => row.poolId === id);
      const lifetime = lifetimeRows.find((row) => row.poolId === id);
      map.set(id, {
        today: today ? toUsage(today) : emptyUsage,
        allTime: lifetime ? toUsage(lifetime) : emptyUsage,
      });
    }
    return map;
  }

  private mapPoolAccount(
    row: typeof providerPoolAccounts.$inferSelect,
    pool: typeof networkPools.$inferSelect | undefined,
    usage: { today: ProviderAccountTokenUsage; allTime: ProviderAccountTokenUsage } | undefined,
  ): ProviderAccountResponse {
    return {
      id: row.id,
      providerId: row.providerId,
      tenantId: row.tenantId,
      label: row.label,
      credentialKind: "none",
      // Health truth lives on the owning pool; fall back to the row only when
      // the pool row is unreachable (deleted cascade would have removed the
      // account row, so this is defensive).
      status: pool?.status ?? row.status,
      usageToday: usage?.today ?? emptyUsage,
      usageAllTime: usage?.allTime ?? emptyUsage,
      consecutiveFailures: pool?.consecutiveFailures ?? row.consecutiveFailures,
      ...(pool?.lastSuccessAt
        ? { lastSuccessAt: pool.lastSuccessAt.toISOString() }
        : row.lastSuccessAt
          ? { lastSuccessAt: row.lastSuccessAt.toISOString() }
          : {}),
      ...(pool?.lastError ? { lastError: pool.lastError } : row.lastError ? { lastError: row.lastError } : {}),
      ...(pool?.lastErrorCategory
        ? { lastErrorCategory: pool.lastErrorCategory }
        : row.lastErrorCategory
          ? { lastErrorCategory: row.lastErrorCategory }
          : {}),
      ...(pool?.lastErrorAt
        ? { lastErrorAt: pool.lastErrorAt.toISOString() }
        : row.lastErrorAt
          ? { lastErrorAt: row.lastErrorAt.toISOString() }
          : {}),
      ...(pool?.cooldownUntil
        ? { cooldownUntil: pool.cooldownUntil.toISOString() }
        : row.cooldownUntil
          ? { cooldownUntil: row.cooldownUntil.toISOString() }
          : {}),
      ...(pool?.lastRecoveredAt
        ? { lastRecoveredAt: pool.lastRecoveredAt.toISOString() }
        : row.lastRecoveredAt
          ? { lastRecoveredAt: row.lastRecoveredAt.toISOString() }
          : {}),
      createdAt: row.createdAt.toISOString(),
      sortIndex: 0,
      kind: "pool",
      networkPoolId: row.networkPoolId,
      ...(pool?.providerCooldowns
        ? { providerCooldowns: activePoolProviderCooldowns(pool.providerCooldowns) }
        : {}),
    };
  }

  async createAccount(
    tenantId: string,
    providerId: string,
    request: CreateProviderAccountRequest,
    existingTx?: Parameters<Parameters<CartethyiaDatabase["transaction"]>[0]>[0],
    includeUsage = true,
    sortIndexOverride?: number,
  ): Promise<ProviderAccountResponse> {
    // Callers inside an existing transaction pass it in so the account lands in
    // that unit of work (the batch path); otherwise this opens its own.
    const run = async (
      tx: Parameters<Parameters<CartethyiaDatabase["transaction"]>[0]>[0],
    ): Promise<ProviderAccountResponse> => {
    let effectiveSecret = request.secret;
        let effectiveCredentialKind = request.credentialKind;
        const requestedCredentialMode: CredentialMode = request.credentialMode ?? "auto";
        let effectiveCredentialMode: CredentialMode = requestedCredentialMode;
        let tokenExpiresAt: Date | undefined;
        let jwtIssuer: string | undefined;
        let oauthRefreshCiphertext: Buffer | undefined;
        let oauthExpiresAt: Date | undefined;
        let oauthHasRefreshToken = false;
        let pastedAuthState: Readonly<Record<string, unknown>> = {};

        if (
          (request.credentialKind === "oauth" || request.credentialKind === "api_key") &&
          request.secret.trim().length > 0
        ) {
          const trimmed = request.secret.trim();
          const parts = parsePastedOAuthCredential(trimmed);
          pastedAuthState = parts.authState;
          const hasRefreshToken = parts.refreshToken !== parts.accessToken;
          const parsedJwt =
            requestedCredentialMode === "api_key"
              ? undefined
              : parseJwtCredential(parts.accessToken);
          if (requestedCredentialMode === "jwt" && parsedJwt === undefined) {
            throw new ConsoleDomainError(
              "invalid_request",
              400,
              "credentialMode jwt requires a valid three-part JWT",
            );
          }
          if (requestedCredentialMode === "api_key") {
            effectiveSecret = parts.accessToken;
            effectiveCredentialKind = "api_key";
            effectiveCredentialMode = "api_key";
          } else if (
            parsedJwt !== undefined &&
            (requestedCredentialMode === "jwt" || !hasRefreshToken)
          ) {
            effectiveSecret = parts.accessToken;
            effectiveCredentialKind = "api_key";
            effectiveCredentialMode = "jwt";
            tokenExpiresAt = parsedJwt.expiresAt;
            // Kept alongside the expiry: the console shows who issued a static
            // token, and the secret itself is never readable after this point.
            jwtIssuer = parsedJwt.issuer;
          } else if (request.credentialKind === "oauth" || hasRefreshToken) {
            effectiveSecret = parts.accessToken;
            effectiveCredentialKind = hasRefreshToken ? "oauth" : "api_key";
            effectiveCredentialMode = hasRefreshToken ? "auto" : "api_key";
            if (hasRefreshToken) {
              oauthRefreshCiphertext = encryptCredential(parts.refreshToken);
              oauthHasRefreshToken = true;
            }
            oauthExpiresAt = parts.expiresAt;
          } else {
            effectiveCredentialMode = "api_key";
          }
        }

        // Append to the end of this provider's list rather than relying on
        // creation time, so a new account never displaces existing positions.
        const credentialFingerprint =
          effectiveCredentialKind === "none" || effectiveSecret.length === 0
            ? undefined
            : hashSecret(effectiveSecret);
        const accountAuthState = {
          ...pastedAuthState,
          ...(request.authState ?? {}),
          credentialMode: effectiveCredentialMode,
          ...(tokenExpiresAt === undefined ? {} : { tokenExpiresAt: tokenExpiresAt.toISOString() }),
          ...(jwtIssuer === undefined ? {} : { jwtIssuer }),
        };
        const nextSortIndex =
          sortIndexOverride ?? (await this.nextAccountSortIndex(tx, providerId, tenantId));
        // Read existing labels only when one has to be generated: a named
        // account costs no extra query, and this is the path a large batch
        // paste walks once per row.
        const label =
          request.label ??
          (await this.generateAccountLabel(tx, providerId, tenantId, effectiveCredentialMode));
        const rows = await tx
          .insert(providerAccounts)
          .values({
            providerId,
            tenantId,
            sortIndex: nextSortIndex,
            label,
            credentialCiphertext: encryptCredential(effectiveSecret),
            ...(credentialFingerprint ? { credentialFingerprint } : {}),
            credentialKind: effectiveCredentialKind,
            status: "active",
            authState: accountAuthState,
            // An OAuth account pasted without a refresh token is a *static*
            // token: the pasted value is a bearer token used exactly as issued
            // and there is no refresh grant to run. Flag it as static so the
            // console reads it as an informational "static token" rather than
            // "re-login required" — the token is still valid and dispatchable —
            // and so the refresh sweep skips it instead of retrying a refresh
            // that can never succeed.
            ...(effectiveCredentialKind === "oauth" && !oauthHasRefreshToken || effectiveCredentialMode === "jwt"
              ? { staticToken: true }
              : {}),
          })
          .returning();
        const row = rows[0];
        if (!row) throw new Error("failed to create provider account");

        if (effectiveCredentialKind === "oauth") {
          await tx.insert(providerOauthStates).values({
            providerAccountId: row.id,
            ...(oauthRefreshCiphertext ? { refreshCiphertext: oauthRefreshCiphertext } : {}),
            expiresAt: oauthExpiresAt ?? null,
          });
        }
        if (request.credentialKind === "oauth" && !oauthHasRefreshToken) {
          pushStructuredConsoleLog(
            "info",
            "OAuth access token stored as a static API credential; it will not be refreshed",
            {
              event: "token_refresh",
              providerId,
              accountId: row.id,
              errorCode: "static_token",
            },
          );
        }

        if (!includeUsage) {
          const emptyUsage = { requests: 0, errors: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 };
          return this.mapAccount(row, { today: emptyUsage, allTime: emptyUsage });
        }
        const [account] = await this.accountsWithUsage(tenantId, [row]);
        if (!account) throw new Error("created provider account could not be mapped");
        return account;
    };

    try {
      if (existingTx !== undefined) {
        return await run(existingTx);
      }
      return await this.db.transaction(run);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConsoleDomainError(
          "provider_account_duplicate",
          409,
          "A provider account with this credential already exists",
        );
      }
      throw error;
    }
  }

  /**
   * Creates many accounts in one round-trip.
   *
   * The whole batch shares one transaction, so a paste of 40 credentials costs
   * one connection checkout rather than 40. Each item is created through the
   * same `createAccount` path the single route uses — there is no second
   * implementation of credential detection to drift.
   *
   * Items are created sequentially inside that transaction: the unique
   * credential fingerprint makes two identical pastes collide, and a nested
   * transaction per item keeps that collision from aborting the whole batch.
   * Outcomes are reported per index, so a partial paste still lands the
   * accounts that were fine — an operator fixing one bad line should not have
   * to re-import 39.
   */
  async createAccountBatch(
    tenantId: string,
    providerId: string,
    requests: readonly CreateProviderAccountRequest[],
  ): Promise<CreateProviderAccountBatchResult> {
    if (requests.length === 0) {
      return { created: 0, failed: 0, results: [] };
    }
    const results: CreateProviderAccountBatchItemResult[] = [];
    let created = 0;
    let failed = 0;

    await this.db.transaction(async (tx) => {
      let nextSortIndex = await this.nextAccountSortIndex(tx, providerId, tenantId);
      for (const [index, request] of requests.entries()) {
        try {
          // A nested transaction acts as a savepoint: a duplicate-fingerprint
          // violation rolls back only this item, not the accounts before it.
          const account = await tx.transaction(async (inner) =>
            this.createAccount(tenantId, providerId, request, inner, false, nextSortIndex),
          );
          created += 1;
          nextSortIndex += 1;
          results.push({ index, ok: true, ...(account ? { account } : {}) });
        } catch (error) {
          failed += 1;
          results.push({
            index,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
            code: error instanceof ConsoleDomainError ? error.code : "create_failed",
          });
        }
      }
    });

    return { created, failed, results };
  }

  async updateAccount(
    tenantId: string,
    providerId: string,
    accountId: string,
    patch: UpdateProviderAccountRequest,
  ): Promise<ProviderAccountResponse | undefined> {
    const set: Partial<typeof providerAccounts.$inferInsert> = {};
    if (patch.label !== undefined) set.label = patch.label;
    if (patch.secret !== undefined) {
      set.credentialCiphertext = encryptCredential(patch.secret);
      set.credentialFingerprint =
        patch.secret.length === 0 ? null : hashSecret(patch.secret);
    }
    if (patch.status !== undefined) set.status = patch.status;
    // Toggling the static-token flag: turning it on declares the credential is
    // used as issued and never refreshed, so any stale re-auth flag is cleared —
    // the operator has said the account is fine, and the pill must stop reading
    // "Re-login required". Turning it off returns the account to normal OAuth
    // refresh handling; the sweep picks it up again on its next pass.
    if (patch.staticToken !== undefined) {
      set.staticToken = patch.staticToken;
      if (patch.staticToken) {
        set.lastError = null;
        set.lastErrorCategory = null;
        set.lastErrorAt = null;
      }
    }
    // Status toggles are not recovery: preserve the health machine's evidence
    // until the operator uses Recover or replaces the rejected credential.
    const clearsFailureState = patch.secret !== undefined && patch.secret.length > 0;
    if (clearsFailureState) {
      set.consecutiveFailures = 0;
      set.cooldownUntil = null;
      set.modelCooldowns = {};
      set.lastError = null;
      set.lastErrorCategory = null;
      set.lastErrorAt = null;
    }
    const where = and(
      eq(providerAccounts.id, accountId),
      eq(providerAccounts.providerId, providerId),
      globalOrOwnedBy(providerAccounts.tenantId, tenantId),
    );
    try {
      const rows =
        Object.keys(set).length > 0
          ? await this.db.update(providerAccounts).set(set).where(where).returning()
          : await this.db.select().from(providerAccounts).where(where);
      const row = rows[0];
      if (!row) return undefined;
      // Secret/status mutation: drop any cached credential so the next
      // attempt decrypts the new ciphertext (or refuses a disabled account).
      if (patch.secret !== undefined || patch.status !== undefined) {
        invalidateCredentialCache(accountId);
      }
      const [account] = await this.accountsWithUsage(tenantId, [row]);
      return account;
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConsoleDomainError(
          "provider_account_duplicate",
          409,
          "A provider account with this credential already exists",
        );
      }
      throw error;
    }
  }

  private mapAccount(
    row: typeof providerAccounts.$inferSelect,
    usage: {
      readonly today: ProviderAccountTokenUsage;
      readonly allTime: ProviderAccountTokenUsage;
      readonly inflight?: number | undefined;
    },
  ): ProviderAccountResponse {
    const authState =
      row.authState !== null && typeof row.authState === "object" && !Array.isArray(row.authState)
        ? (row.authState as Record<string, unknown>)
        : undefined;
    const rawCredentialMode = authState?.["credentialMode"];
    const credentialMode: CredentialMode | undefined =
      rawCredentialMode === "auto" || rawCredentialMode === "jwt" || rawCredentialMode === "api_key"
        ? rawCredentialMode
        : undefined;
    const tokenExpiresAt =
      typeof authState?.["tokenExpiresAt"] === "string" ? authState["tokenExpiresAt"] : undefined;
    const jwtIssuer =
      typeof authState?.["jwtIssuer"] === "string" ? authState["jwtIssuer"] : undefined;
    const authMethod =
      typeof authState?.["authMethod"] === "string" ? authState["authMethod"] : undefined;
    return {
      id: row.id,
      providerId: row.providerId,
      tenantId: row.tenantId,
      label: row.label,
      credentialKind: row.credentialKind,
      ...(credentialMode === undefined ? {} : { credentialMode }),
      ...(tokenExpiresAt === undefined ? {} : { tokenExpiresAt }),
      ...(jwtIssuer === undefined ? {} : { jwtIssuer }),
      ...(authMethod === undefined ? {} : { authMethod }),
      status: row.status,
      ...(usage.inflight === undefined ? {} : { inflight: usage.inflight }),
      usageToday: usage.today,
      usageAllTime: usage.allTime,
      consecutiveFailures: row.consecutiveFailures,
      ...(row.lastSuccessAt ? { lastSuccessAt: row.lastSuccessAt.toISOString() } : {}),
      ...(row.lastError ? { lastError: row.lastError } : {}),
      ...(row.lastErrorCategory ? { lastErrorCategory: row.lastErrorCategory } : {}),
      ...(row.lastErrorAt ? { lastErrorAt: row.lastErrorAt.toISOString() } : {}),
      ...(row.cooldownUntil ? { cooldownUntil: row.cooldownUntil.toISOString() } : {}),
      ...(liveModelCooldowns(row.modelCooldowns) ?? {}),
      ...(row.lastRecoveredAt ? { lastRecoveredAt: row.lastRecoveredAt.toISOString() } : {}),
      createdAt: row.createdAt.toISOString(),
      sortIndex: row.sortIndex,
      ...(row.staticToken ? { staticToken: true } : {}),
    };
  }

  async listAccountHealthEvents(
    tenantId: string,
    providerId: string,
    accountId: string,
  ): Promise<readonly AccountHealthEventRecord[]> {
    const owned = await this.db
      .select({ id: providerAccounts.id })
      .from(providerAccounts)
      .where(
        and(
          eq(providerAccounts.id, accountId),
          eq(providerAccounts.providerId, providerId),
          globalOrOwnedBy(providerAccounts.tenantId, tenantId),
        ),
      )
      .limit(1);
    if (owned.length === 0) return [];
    return listAccountHealthEvents(this.db, accountId);
  }

  /** Deletes one account's stored health & error rows, for the modal's purge. */
  async purgeAccountHealthEvents(
    tenantId: string,
    providerId: string,
    accountId: string,
  ): Promise<number> {
    const owned = await this.db
      .select({ id: providerAccounts.id })
      .from(providerAccounts)
      .where(
        and(
          eq(providerAccounts.id, accountId),
          eq(providerAccounts.providerId, providerId),
          globalOrOwnedBy(providerAccounts.tenantId, tenantId),
        ),
      )
      .limit(1);
    if (owned.length === 0) return 0;
    return deleteAccountHealthEvents(this.db, accountId);
  }
  async listBuddyGrowthTasks(
    tenantId: string,
    providerId: string,
    accountId: string,
    dayKey: string,
  ): Promise<readonly BuddyGrowthTaskLedgerEntry[]> {
    const owned = await this.db
      .select({ id: providerAccounts.id })
      .from(providerAccounts)
      .where(
        and(
          eq(providerAccounts.id, accountId),
          eq(providerAccounts.providerId, providerId),
          globalOrOwnedBy(providerAccounts.tenantId, tenantId),
        ),
      )
      .limit(1);
    if (owned.length === 0) return [];
    const rows = await this.db
      .select({
        accountId: buddyTaskLedger.accountId,
        task: buddyTaskLedger.task,
        claimedAt: buddyTaskLedger.claimedAt,
      })
      .from(buddyTaskLedger)
      .where(
        and(
          eq(buddyTaskLedger.accountId, accountId),
          eq(buddyTaskLedger.dayKey, dayKey),
        ),
      );
    return rows.map((row) => ({
      accountId: row.accountId,
      task: row.task,
      claimedAt: row.claimedAt.toISOString(),
    }));
  }

  async recoverAccount(
    tenantId: string,
    providerId: string,
    accountId: string,
  ): Promise<boolean> {
    const owned = await this.db
      .select({ id: providerAccounts.id })
      .from(providerAccounts)
      .where(
        and(
          eq(providerAccounts.id, accountId),
          eq(providerAccounts.providerId, providerId),
          globalOrOwnedBy(providerAccounts.tenantId, tenantId),
        ),
      )
      .limit(1);
    if (owned.length === 0) return false;
    return recoverAccount(this.db, accountId, "manual_operator_recovery");
  }

  /**
   * One `UPDATE ... WHERE <cooldown predicate>` (D07/D08/D09). The predicate
   * is evaluated in SQL, so the whole provider is handled in one statement
   * without reading rows into the process. `cooldown_until` and
   * `model_cooldowns` are left untouched: they are the evidence the operator
   * sees on a disabled row until an explicit Recover clears them.
   *
   * Pool-as-account rows live in `provider_pool_accounts`, not this table, so
   * they are excluded by construction. Shared (`tenant_id IS NULL`) rows are
   * counted in `globalSkipped` but never written by a tenant; the global-admin
   * pair of routes owns those.
   */
  async disableCooldowns(
    tenantId: string,
    providerId: string,
  ): Promise<ProviderAccountBulkActionResult> {
    const nowIso = new Date().toISOString();
    const [globalRows, updatedRows] = await Promise.all([
      this.db
        .select({ id: providerAccounts.id })
        .from(providerAccounts)
        .where(
          and(
            eq(providerAccounts.providerId, providerId),
            isNull(providerAccounts.tenantId),
            this.liveCooldownPredicate(nowIso),
          ),
        ),
      this.db
        .update(providerAccounts)
        .set({ status: "disabled" })
        .where(
          and(
            eq(providerAccounts.providerId, providerId),
            eq(providerAccounts.tenantId, tenantId),
            this.liveCooldownPredicate(nowIso),
          ),
        )
        .returning({ id: providerAccounts.id }),
    ]);
    // Status is part of the cached credential's admission decision, so every
    // newly disabled id must be dropped here — not only on delete.
    invalidateCredentialCaches(updatedRows.map((row) => row.id));
    return { ok: true, updated: updatedRows.length, globalSkipped: globalRows.length };
  }

  /**
   * One `DELETE ... WHERE <strict banned predicate> RETURNING id` (D12).
   * Credential and quota caches are dropped for the deleted ids in one pass
   * each, exactly like the existing batch-delete route. A delete is strictly
   * `status='disabled' AND last_error_category='policy_blocked_banned'`;
   * `auth_invalidated` is remediated by replacing the credential, not here.
   */
  async deleteBanned(
    tenantId: string,
    providerId: string,
  ): Promise<ProviderAccountBulkActionResult> {
    const globalRows = await this.db
      .select({ id: providerAccounts.id })
      .from(providerAccounts)
      .where(
        and(
          eq(providerAccounts.providerId, providerId),
          isNull(providerAccounts.tenantId),
          this.bannedPredicate(),
        ),
      );
    const deletedRows = await this.db
      .delete(providerAccounts)
      .where(
        and(
          eq(providerAccounts.providerId, providerId),
          eq(providerAccounts.tenantId, tenantId),
          this.bannedPredicate(),
        ),
      )
      .returning({ id: providerAccounts.id });
    const deletedIds = deletedRows.map((row) => row.id);
    invalidateCredentialCaches(deletedIds);
    await invalidateQuotaCaches(tenantId, deletedIds, this.redis);
    return {
      ok: true,
      updated: 0,
      deleted: deletedIds,
      missing: [],
      globalSkipped: globalRows.length,
    };
  }

  /** Strict banned definition shared by the tenant and global DELETE paths. */
  private bannedPredicate(): SQL {
    return and(
      eq(providerAccounts.status, "disabled"),
      eq(providerAccounts.lastErrorCategory, "policy_blocked_banned"),
    ) as SQL;
  }

  /**
   * `status='cooldown' OR cooldown_until > now OR model_cooldowns` carries a
   * live entry. The JSON check is dialect-specific: PostgreSQL uses
   * `jsonb_each_text` (with a shape guard), SQLite `json_each` on its `text`
   * column. Only entries whose ISO deadline is still in the future count, mirroring
   * `liveModelCooldowns`. Timestamps are stored as ISO strings on both backends,
   * so the lexical comparison against `nowIso` is stable.
   */
  private liveCooldownPredicate(nowIso: string): SQL {
    const liveModelCooldown = isSqliteDatabase(this.db)
      ? sql`EXISTS (SELECT 1 FROM json_each(${providerAccounts.modelCooldowns}) AS entry WHERE json_valid(${providerAccounts.modelCooldowns}) AND json_type(${providerAccounts.modelCooldowns}) = 'object' AND entry.value > ${nowIso})`
      : sql`EXISTS (SELECT 1 FROM jsonb_each_text(${providerAccounts.modelCooldowns}) AS entry WHERE jsonb_typeof(${providerAccounts.modelCooldowns}) = 'object' AND entry.value > ${nowIso})`;
    return or(
      eq(providerAccounts.status, "cooldown"),
      sql`${providerAccounts.cooldownUntil} > ${nowIso}`,
      liveModelCooldown,
    ) as SQL;
  }

  async syncModels(tenantId: string, providerId: string): Promise<{ synced: number }> {
    return this.probing.syncModels(tenantId, providerId);
  }

  /** Read-only discovery; delegates to the same fetch path as sync (area 05). */
  async listDiscoveryCandidates(
    tenantId: string,
    providerId: string,
  ): Promise<{
    readonly supported: boolean;
    readonly candidates: readonly DiscoverModelCandidate[];
    readonly accountLabel?: string;
  }> {
    const discovery = await this.probing.discoverModels(tenantId, providerId);
    if (!discovery.supported) return { supported: false, candidates: [] };
    const registered = await this.listModelsForTenant(tenantId, providerId);
    const ids = new Set(
      (registered.get(providerId) ?? []).map((entry) => entry.modelId),
    );
    // The picker exists to add models, so rows already on the roster are
    // excluded rather than listed disabled — a fully-registered catalog would
    // otherwise render an all-"Registered" list that reads as empty.
    const candidates: DiscoverModelCandidate[] = discovery.models
      .filter((definition) => !ids.has(definition.modelId))
      .map((definition) => ({
        modelId: definition.modelId,
        wireFamily: definition.wireFamily,
        serviceKind: definition.serviceKind ?? "llm",
        endpointPath: definition.endpointPath,
        contextLimit: definition.contextLimit,
        outputLimit: definition.outputLimit,
        modalities: definition.modalities,
        reasoning: definition.reasoning,
        toolCall: definition.toolCall,
        ...(definition.freeTier === undefined ? {} : { freeTier: definition.freeTier }),
        ...(definition.proOnly === undefined ? {} : { proOnly: definition.proOnly }),
        alreadyRegistered: false,
      }));
    return {
      supported: true,
      candidates,
      ...(discovery.accountLabel === undefined ? {} : { accountLabel: discovery.accountLabel }),
    };
  }

  /**
   * Re-runs discovery on the server, then persists only ids the fresh roster
   * actually advertised (D28/D29/D30/D31). This is the anti-forgery gate: a
   * caller cannot attach a hand-built metadata object to an arbitrary id.
   */
  async commitDiscoveredModels(
    tenantId: string,
    providerId: string,
    modelIds: readonly string[],
  ): Promise<{
    readonly committed: readonly string[];
    readonly skipped: readonly string[];
    readonly synced: number;
  }> {
    const discovery = await this.probing.discoverModels(tenantId, providerId);
    if (!discovery.supported) {
      throw new ConsoleDomainError(
        "model_discovery_unsupported",
        400,
        `${providerId} publishes no model-listing endpoint; add the model manually`,
      );
    }
    const byId = new Map(discovery.models.map((definition) => [definition.modelId, definition]));
    const wanted = [...new Set(modelIds)];
    const unknown = wanted.filter((id) => !byId.has(id));
    if (unknown.length > 0) {
      throw new ConsoleDomainError(
        "invalid_request",
        400,
        `Models are no longer in the provider's listing: ${unknown.join(", ")} (request {requestId}). Fetch the model list again 🪞`,
      );
    }
    const registered = await this.listModelsForTenant(tenantId, providerId);
    const existing = new Set(
      (registered.get(providerId) ?? []).map((entry) => entry.modelId),
    );
    const selected = wanted.filter((id) => !existing.has(id));
    const skipped = wanted.filter((id) => existing.has(id));
    if (selected.length === 0) return { committed: [], skipped, synced: 0 };
    const { synced } = await this.probing.commitDiscoveredModels(
      tenantId,
      providerId,
      selected,
    );
    return { committed: selected, skipped, synced };
  }
}
