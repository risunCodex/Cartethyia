/**
 * Provider-row CRUD for the catalog store: tenant and global provider
 * reads, creates, updates, and deletes. Extracted from `store.ts`; the
 * model operations live in `store-model-operations.ts` and the account
 * operations in `store-account-queries.ts`/`store-operations.ts`. Every function
 * takes the shared `StoreProviderContext` the owning
 * `DrizzleProviderCatalogStore` builds.
 */
import { and, asc, eq, inArray, isNull, or } from "drizzle-orm";
import { ConsoleDomainError } from "../../shared/errors";
import { parseCustomProviderId, isBundledProviderId } from "../../../providers/provider-contracts";
import { BUNDLED_PROVIDER_MODULES } from "../../../providers/default-registry";
import { globalOrOwnedBy, ownedByOnly } from "../../../persistence/tenant-scope";
import { providers } from "../../../persistence/schema";
import { validateCompatibilityProfile } from "./contracts";
import type { ProviderRecord } from "./contracts";
import { mapProviderRow } from "./catalog-projections";
import { bumpCatalogRevision } from "../../../providers/operations/provider-catalog-service";
import type { StoreProviderContext } from "./store-contexts";

export async function listProviders(
  ctx: StoreProviderContext,
  tenantId: string,
): Promise<readonly ProviderRecord[]> {
  const bundledIds = BUNDLED_PROVIDER_MODULES.map((provider) => provider.id);
  const rows = await ctx.db
    .select()
    .from(providers)
    .where(
      and(
        globalOrOwnedBy(providers.tenantId, tenantId),
        or(inArray(providers.id, bundledIds), eq(providers.tenantId, tenantId)),
      ),
    )
    .orderBy(asc(providers.id));
  return rows.map((row) => mapProviderRow(row, ctx.providerRegistry));
}

export async function getProvider(
  ctx: StoreProviderContext,
  tenantId: string,
  providerId: string,
): Promise<ProviderRecord | undefined> {
  const rows = await ctx.db
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
  return row ? mapProviderRow(row, ctx.providerRegistry) : undefined;
}

export async function createProvider(
  ctx: StoreProviderContext,
  record: ProviderRecord,
): Promise<void> {
  if (isBundledProviderId(record.providerId))
    throw new ConsoleDomainError(
      "provider_is_builtin",
      403,
      "Built-in provider cannot be created",
    );
  parseCustomProviderId(record.providerId);
  if (record.compatibilityProfile) validateCompatibilityProfile(record.compatibilityProfile);
  await ctx.db.insert(providers).values({
    id: record.providerId,
    tenantId: record.tenantId ?? null,
    enabled: record.enabled,
    // A custom provider may be credential-less ("Public Key"); without this the
    // column default (`true`) would override the record and the route catalog
    // would stamp the provider disabled for having no account.
    requiresAccount: record.requiresAccount ?? true,
    ...(record.wireFamilyDefault ? { wireFamilyDefault: record.wireFamilyDefault } : {}),
    capabilityProfile: record.capabilityProfile ?? null,
    baseUrl: record.baseUrl ?? null,
    compatibilityProfile: record.compatibilityProfile ?? null,
  });
}

export async function updateProvider(
  ctx: StoreProviderContext,
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
      ? await ctx.db
          .update(providers)
          .set(set)
          .where(
            and(
              eq(providers.id, providerId),
              ownedByOnly(providers.tenantId, tenantId),
            ),
          )
          .returning()
      : await ctx.db
          .select()
          .from(providers)
          .where(
            and(
              eq(providers.id, providerId),
              ownedByOnly(providers.tenantId, tenantId),
            ),
          );
  const row = rows[0];
  return row ? mapProviderRow(row, ctx.providerRegistry) : undefined;
}

export async function deleteProvider(
  ctx: StoreProviderContext,
  tenantId: string,
  providerId: string,
): Promise<boolean> {
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
  const deleted = await ctx.db
    .delete(providers)
    .where(and(eq(providers.id, providerId), ownedByOnly(providers.tenantId, tenantId)))
    .returning({ id: providers.id });
  if (deleted.length === 0) return false;
  ctx.providerRegistry.unregister(providerId);
  // The provider left the registry, so the compiled catalog is now missing it
  // — the snapshot's re-seed is gated on that revision, and a delete that did
  // not bump it would leave the provider's model rows behind.
  bumpCatalogRevision();
  return true;
}

export async function updateGlobalProvider(
  ctx: StoreProviderContext,
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
      ? await ctx.db
          .update(providers)
          .set(set)
          .where(and(eq(providers.id, providerId), isNull(providers.tenantId)))
          .returning()
      : await ctx.db
          .select()
          .from(providers)
          .where(and(eq(providers.id, providerId), isNull(providers.tenantId)));
  const row = rows[0];
  return row ? mapProviderRow(row, ctx.providerRegistry) : undefined;
}

export async function deleteGlobalProvider(
  ctx: StoreProviderContext,
  providerId: string,
): Promise<boolean> {
  if (isBundledProviderId(providerId)) {
    throw new ConsoleDomainError(
      "provider_is_builtin",
      403,
      "Built-in provider cannot be deleted",
    );
  }
  const rows = await ctx.db
    .delete(providers)
    .where(and(eq(providers.id, providerId), isNull(providers.tenantId)))
    .returning({ id: providers.id });
  return rows.length > 0;
}
