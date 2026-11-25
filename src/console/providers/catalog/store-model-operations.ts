/**
 * Model reads and writes for the catalog store: the tenant model listing,
 * manual registration, enable/disable, metadata edits, deletion, the
 * provider-wide probe, and discovery/commit. Extracted from `store.ts`;
 * the provider rows live in `store-provider-records.ts` and the account
 * operations in `store-account-queries.ts`/`store-operations.ts`. Every function
 * takes the shared `StoreModelContext` the owning
 * `DrizzleProviderCatalogStore` builds.
 */
import { and, eq, isNull, sql, type SQL } from "drizzle-orm";
import { ConsoleDomainError } from "../../shared/errors";
import { globalOrOwnedBy, ownedByOnly } from "../../../persistence/tenant-scope";
import { models, providers, tenantDisabledModels } from "../../../persistence/schema";
import type { ServiceKind, WireFamily } from "../../../protocol/canonical-model";
import { nativeServicePathFor } from "../../../transport/contracts";
import { applyModelMetadataOverride, resolveManualModelMetadata } from "../../../providers/provider-model-definition";
import { endpointPathForProviderModel } from "./catalog-projections";
import { asStoredText, mapModelRow, withImageModality } from "./store-helpers";
import { isServiceKind } from "./contracts";
import type {
  DiscoverModelCandidate,
  ModelCatalogEntry,
  ModelMetadataOverride,
  ProbeAllModelsResult,
  ProbeModelRequest,
  SetModelEnabledRequest,
  UpdateModelMetadataRequest,
} from "./contracts";
import type { StoreModelContext } from "./store-contexts";
import { pickDefined } from "../../shared/object";

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
export async function listModelsForTenant(
  ctx: StoreModelContext,
  tenantId: string,
  providerId?: string,
): Promise<Map<string, readonly ModelCatalogEntry[]>> {
  const disabled = await ctx.db
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
  const dbRows = await ctx.db
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

export async function registerModels(
  ctx: StoreModelContext,
  tenantId: string,
  providerId: string,
  modelIds: readonly string[],
  wireFamily?: string,
  metadata?: ModelMetadataOverride,
  serviceKind?: ServiceKind,
): Promise<void> {
  const owner = await ctx.db
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
  const effectiveServiceKind: ServiceKind = serviceKind ?? "llm";
  const family = (wireFamily ?? "chat") as WireFamily;
  // Static endpoint from the provider's own bundled catalog via the probing
  // service (the same startup-built map this store is constructed with).
  // Without this, bundled providers on versioned bases (cline) get the
  // generic `/v1/…` default, which joins into an unreachable path and every
  // probe/dispatch 404s. Non-LLM services route to their native endpoint path
  // (e.g. `/v1/embeddings` for `"embedding"`).
  const nativeEndpoint =
    effectiveServiceKind === "llm" ? undefined : nativeServicePathFor(effectiveServiceKind);
  const staticEndpoint =
    nativeEndpoint === undefined
      ? await ctx.probing.resolveStaticEndpoint(providerId, family)
      : undefined;
  const endpointPath =
    nativeEndpoint ??
    endpointPathForProviderModel(
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
  await ctx.db
    .insert(models)
    .values(
      modelIds.map((modelId) => ({
        providerId,
        modelId,
        wireFamily: family,
        serviceKind: effectiveServiceKind,
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
        serviceKind: sql`excluded.service_kind`,
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
 * Batched provider-wide probe: the first registered model runs sequentially
 * (warms OAuth token / connection pools), the rest run concurrently bounded
 * to 5. Registered model ids come from the store's own catalog read.
 */
export async function probeAllModels(
  ctx: StoreModelContext,
  tenantId: string,
  providerId: string,
  mode?: ProbeModelRequest["mode"],
): Promise<ProbeAllModelsResult> {
  const entries = await listModelsForTenant(ctx, tenantId, providerId).then(
    (grouped) => grouped.get(providerId) ?? [],
  );
  const requests = entries.map((entry) => ({
    modelId: entry.modelId,
    route: entry.route,
    serviceKind: isServiceKind(entry.serviceKind) ? entry.serviceKind : ("llm" as const),
    ...pickDefined({ mode }),
  }));
  const seenRequestKeys = new Set<string>();
  const uniqueRequests = requests.filter((request) => {
    const key = `${request.modelId}\u0000${request.route}\u0000${request.serviceKind}`;
    if (seenRequestKeys.has(key)) return false;
    seenRequestKeys.add(key);
    return true;
  });
  return ctx.probing.probeAllModels(tenantId, providerId, uniqueRequests);
}

/** Toggles a persisted model's routing eligibility. */
export async function setModelEnabled(
  ctx: StoreModelContext,
  tenantId: string,
  providerId: string,
  request: SetModelEnabledRequest,
): Promise<boolean> {
  // Tenant-owned (BYOK) model: toggle the shared row directly.
  const owned = await ctx.db
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
    await ctx.db
      .update(models)
      .set({ enabled: request.enabled })
      .where(eq(models.id, ownedTarget.id));
    return true;
  }

  // Global/built-in model: tenants cannot mutate the shared row, so record
  // (or clear) a tenant-scoped disable in `tenantDisabledModels`.
  const global = await ctx.db
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
    await ctx.db
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
  await ctx.db
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
export async function updateModelMetadata(
  ctx: StoreModelContext,
  tenantId: string,
  providerId: string,
  request: UpdateModelMetadataRequest,
): Promise<boolean> {
  const findRow = (ownership: SQL) =>
    ctx.db
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
              ...pickDefined({ severity: warning.severity }),
              ...pickDefined({ updatedAt: warning.updatedAt }),
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
  await ctx.db.update(models).set(set).where(eq(models.id, row.id));
  return true;
}

export async function deleteModel(
  ctx: StoreModelContext,
  tenantId: string,
  providerId: string,
  request: SetModelEnabledRequest,
): Promise<boolean> {
  const owned = await ctx.db
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
    const rows = await ctx.db
      .delete(models)
      .where(eq(models.id, target.id))
      .returning({ id: models.id });
    return rows.length > 0;
  }
  const global = await ctx.db
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
  const rows = await ctx.db
    .delete(models)
    .where(eq(models.id, global[0].id))
    .returning({ id: models.id });
  await ctx.db
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

/** Read-only discovery; delegates to the same fetch path as sync (area 05). */
export async function listDiscoveryCandidates(
  ctx: StoreModelContext,
  tenantId: string,
  providerId: string,
): Promise<{
  readonly supported: boolean;
  readonly candidates: readonly DiscoverModelCandidate[];
  readonly accountLabel?: string;
}> {
  const discovery = await ctx.probing.discoverModels(tenantId, providerId);
  if (!discovery.supported) return { supported: false, candidates: [] };
  const registered = await listModelsForTenant(ctx, tenantId, providerId);
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
      ...pickDefined({ freeTier: definition.freeTier }),
      ...pickDefined({ proOnly: definition.proOnly }),
      alreadyRegistered: false,
    }));
  return {
    supported: true,
    candidates,
    ...pickDefined({ accountLabel: discovery.accountLabel }),
  };
}

/**
 * Re-runs discovery on the server, then persists only ids the fresh roster
 * actually advertised (D28/D29/D30/D31). This is the anti-forgery gate: a
 * caller cannot attach a hand-built metadata object to an arbitrary id.
 */
export async function commitDiscoveredModels(
  ctx: StoreModelContext,
  tenantId: string,
  providerId: string,
  modelIds: readonly string[],
): Promise<{
  readonly committed: readonly string[];
  readonly skipped: readonly string[];
  readonly synced: number;
}> {
  const discovery = await ctx.probing.discoverModels(tenantId, providerId);
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
      `Models are no longer in the provider's listing: ${unknown.join(", ")}. Fetch the model list again 🪞`,
    );
  }
  const registered = await listModelsForTenant(ctx, tenantId, providerId);
  const existing = new Set(
    (registered.get(providerId) ?? []).map((entry) => entry.modelId),
  );
  const selected = wanted.filter((id) => !existing.has(id));
  const skipped = wanted.filter((id) => existing.has(id));
  if (selected.length === 0) return { committed: [], skipped, synced: 0 };
  const { synced } = await ctx.probing.commitDiscoveredModels(
    tenantId,
    providerId,
    selected,
  );
  return { committed: selected, skipped, synced };
}
