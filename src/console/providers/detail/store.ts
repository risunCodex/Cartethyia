// Drizzle-backed persistence for provider routing (detail) settings.
import { and, eq, isNull, sql } from "drizzle-orm";
import type { CartethyiaDatabase } from "../../../persistence/db-handle";
import { providerRoutingSettings } from "../../../persistence/schema";
import { resolveTenantOverride } from "../../../persistence/tenant-scope";
import { DEFAULT_PROXY_SKIP_PROVIDER_IDS } from "../../../providers/provider-metadata";
import { isBundledProviderId } from "../../../providers/provider-contracts";
import type { ProviderRoutingResponse, UpdateProviderRoutingRequest } from "../catalog/contracts";
import { DEFAULT_PROVIDER_MAX_INFLIGHT } from "../../../persistence/schema";
import { buildClaudeCliUserAgent } from "../../../providers/operations/custom-cli-headers";
import type { ProviderDetailStore } from "./contracts";
/**
 * Whether a provider should start with proxying skipped.
 *
 * Bundled providers opt in through their own metadata (`defaultSkipProxy`).
 * A custom (BYOK) compatible provider cannot: its id is chosen at creation
 * time, so it is absent from `DEFAULT_PROXY_SKIP_PROVIDER_IDS` — a set built
 * from the bundled catalog alone — and every one of them started with
 * `skipProxy: false`. Those upstreams are the operator's own endpoint, reached
 * over plain HTTP/S by an OpenAI- or Anthropic-compatible client, which is the
 * case the flag exists for; making the operator discover it after the first
 * failures is the wrong default.
 *
 * Only the initial value. An explicit `skipProxy` in a patch always wins, so
 * an operator who turned it back on keeps it on.
 */
export function defaultSkipProxy(providerId: string): boolean {
  return DEFAULT_PROXY_SKIP_PROVIDER_IDS.has(providerId) || !isBundledProviderId(providerId);
}

function mapRow(row: typeof providerRoutingSettings.$inferSelect): ProviderRoutingResponse {
  return {
    providerId: row.providerId,
    tenantId: row.tenantId,
    strategy: row.strategy as ProviderRoutingResponse["strategy"],
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

function tenantWhere(providerId: string, tenantId: string | null) {
  return tenantId === null
    ? and(
        eq(providerRoutingSettings.providerId, providerId),
        isNull(providerRoutingSettings.tenantId),
      )
    : and(
        eq(providerRoutingSettings.providerId, providerId),
        eq(providerRoutingSettings.tenantId, tenantId),
      );
}

export class DrizzleProviderDetailStore implements ProviderDetailStore {
  constructor(private readonly db: CartethyiaDatabase) {}

  async getRouting(providerId: string, tenantId: string | null): Promise<ProviderRoutingResponse> {
    let specificRow: typeof providerRoutingSettings.$inferSelect | undefined;
    if (tenantId !== null) {
      const specific = await this.db
        .select()
        .from(providerRoutingSettings)
        .where(tenantWhere(providerId, tenantId))
        .limit(1);
      specificRow = specific[0];
    }
    const global = await this.db
      .select()
      .from(providerRoutingSettings)
      .where(tenantWhere(providerId, null))
      .limit(1);
    const globalRow = global[0];
    // Same tenant-wins-entirely-over-global precedence `resolveTenantOverride`
    // row picks which source to read `tenantId` from below.
    const resolvedRow = resolveTenantOverride(specificRow, globalRow, undefined);
    if (resolvedRow) {
      const mapped = mapRow(resolvedRow);
      return specificRow ? mapped : { ...mapped, tenantId };
    }
    return {
      providerId,
      tenantId,
      strategy: "fallback",
      rotateCount: 1,
      maxInflight: DEFAULT_PROVIDER_MAX_INFLIGHT,
      maxInflightPerProxy: null,
      usageFloor: null,
      usageFloorUnit: "percent",
      enabled: false,
      skipProxy: defaultSkipProxy(providerId),
      userAgent: buildClaudeCliUserAgent(),
      customUserAgent: null,
    };
  }
  async updateRouting(
    providerId: string,
    tenantId: string | null,
    patch: UpdateProviderRoutingRequest,
  ): Promise<ProviderRoutingResponse> {
    // Atomic upsert avoids the select→insert/update race that surfaces as
    // `23505 unique_violation` when two admins configure routing for the
    // same (tenant, provider) pair concurrently.
    const values = {
      providerId,
      tenantId: tenantId ?? null,
      strategy: patch.strategy ?? "fallback",
      rotateCount: patch.rotateCount ?? 1,
      maxInflight: patch.maxInflight ?? null,
      maxInflightPerProxy: patch.maxInflightPerProxy ?? null,
      usageFloor: patch.usageFloor ?? null,
      usageFloorUnit: patch.usageFloorUnit ?? "percent",
      enabled: patch.enabled ?? false,
      skipProxy: patch.skipProxy ?? defaultSkipProxy(providerId),
      userAgent: patch.userAgent ?? buildClaudeCliUserAgent(),
      customUserAgent: patch.customUserAgent ?? null,
    };
    const setClause: Record<string, unknown> = {};
    if (patch.strategy !== undefined) setClause.strategy = patch.strategy;
    if (patch.rotateCount !== undefined) setClause.rotateCount = patch.rotateCount;
    if (patch.maxInflight !== undefined) setClause.maxInflight = patch.maxInflight;
    if (patch.maxInflightPerProxy !== undefined)
      setClause.maxInflightPerProxy = patch.maxInflightPerProxy;
    if (patch.usageFloor !== undefined) setClause.usageFloor = patch.usageFloor;
    if (patch.usageFloorUnit !== undefined) setClause.usageFloorUnit = patch.usageFloorUnit;
    if (patch.enabled !== undefined) setClause.enabled = patch.enabled;
    if (patch.skipProxy !== undefined) setClause.skipProxy = patch.skipProxy;
    if (patch.userAgent !== undefined) setClause.userAgent = patch.userAgent;
    if (patch.customUserAgent !== undefined) setClause.customUserAgent = patch.customUserAgent;
    const upserted = await this.db
      .insert(providerRoutingSettings)
      .values(values)
      .onConflictDoUpdate({
        // The global row is guarded by a *partial* unique index
        // (`provider_routing_settings_global_provider_idx`, `WHERE tenant_id IS
        // NULL`), so the conflict target must name that predicate. Without
        // `targetWhere`, Postgres cannot match `(provider_id)` to the partial
        // index and rejects the statement with `42P10` — the global branch
        // failed on every write. The tenant branch's index is not partial, so it
        // needs no predicate.
        target:
          tenantId === null
            ? [providerRoutingSettings.providerId]
            : [providerRoutingSettings.tenantId, providerRoutingSettings.providerId],
        ...(tenantId === null
          ? { targetWhere: sql`tenant_id IS NULL` }
          : {}),
        set:
          Object.keys(setClause).length > 0
            ? setClause
            : // Deterministic no-op update so ON CONFLICT still returns the row.
              { providerId: providerRoutingSettings.providerId },
      })
      .returning();
    return mapRow(upserted[0]!);
  }
}

