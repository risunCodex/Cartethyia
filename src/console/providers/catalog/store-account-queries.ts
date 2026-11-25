/**
 * Account reads for the catalog store: list queries, id/ownership probes,
 * per-provider counts, and usage aggregation. Extracted from
 * the reads live here; the credential writes live in `store-account-mutations.ts`
 * and the pool-as-account reads in `store-pool-accounts.ts`. Every function
 * takes the shared `StoreAccountContext` the owning
 * `DrizzleProviderCatalogStore` builds.
 */
import { and, asc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { globalOrOwnedBy, ownedByOnly } from "../../../persistence/tenant-scope";
import {
  providerAccounts,
  providers,
  models,
  tenantDisabledModels,
  telemetryEvents,
  telemetryUsageTotals,
} from "../../../persistence/schema";
import { IS_GATEWAY_ERROR_SQL } from "../../../observability/event-query";
import {
  mapAccountRow,
  usageTotalsFromRow,
} from "./store-helpers";
import { listPoolAccounts, listAllPoolAccounts } from "./store-pool-accounts";
import type { OwnedProviderAccountRef, ProviderAccountResponse } from "./contracts";
import type { ProviderAccountRow, StoreAccountContext } from "./store-contexts";
import { pickDefined } from "../../shared/object";

/**
 * Today's per-account usage for a concrete id set. Scoped to those ids so
 * the `(tenant, account, created_at)` index serves the range instead of a
 * full-tenant window scan; returns exactly one group per account with
 * traffic, so an account is never lost to a top-N cap.
 */
async function accountTodayUsage(
  ctx: StoreAccountContext,
  tenantId: string,
  accountIds: readonly string[],
): Promise<
  Array<{ key: string; requests: number; errors: number; inputTokens: number; outputTokens: number }>
> {
  if (accountIds.length === 0) return [];
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);
  const rows = await ctx.db
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

async function accountInflightFor(
  ctx: StoreAccountContext,
  tenantId: string,
  providerId: string | undefined,
): Promise<Map<string, number>> {
  const readings = new Map<string, number>();
  if (!ctx.readAccountInflight || !providerId) return readings;
  const rows = await ctx.readAccountInflight(providerId, tenantId);
  for (const row of rows) {
    if (typeof row.accountId !== "string" || !Number.isFinite(row.inflight)) continue;
    readings.set(row.accountId, Math.max(0, Math.floor(row.inflight)));
  }
  return readings;
}

/**
 * Account rows plus their usage aggregates. One today-window GROUP BY and one
 * lifetime `telemetry_usage_totals` read serve the whole page; per-account
 * reads would scale with the account count.
 */
export async function accountsWithUsage(
  ctx: StoreAccountContext,
  tenantId: string,
  rows: readonly ProviderAccountRow[],
): Promise<readonly ProviderAccountResponse[]> {
  if (rows.length === 0) return [];
  const accountIds = rows.map((row) => row.id);
  // Today's per-account usage is one GROUP BY, not a read of every event
  // since midnight. The read is scoped to the accounts on this page via the
  // `(tenant, account, created_at)` index — a full-tenant breakdown scanned
  // every of today's events and capped at 100 groups, so an account past
  // the cap silently read as "no usage today".
  const todayGroups = await accountTodayUsage(ctx, tenantId, accountIds);
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
    ctx.db
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
  const first = rows[0];
  const inflightByAccount = await accountInflightFor(ctx, tenantId, first?.providerId);
  return rows.map((row) => {
    const inflight = inflightByAccount.get(row.id);
    return mapAccountRow(row, {
      today: usageTotalsFromRow(todayByAccount.get(row.id)),
      allTime: usageTotalsFromRow(lifetimeByAccount.get(row.id)),
      ...pickDefined({ inflight }),
    });
  });
}

export async function listAccountAuthStates(
  ctx: StoreAccountContext,
  tenantId: string,
  providerId: string,
  accountIds: readonly string[],
): Promise<Readonly<Record<string, Readonly<Record<string, unknown>>>>> {
  if (accountIds.length === 0) return {};
  const rows = await ctx.db
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

export async function listAccounts(
  ctx: StoreAccountContext,
  tenantId: string,
  providerId: string,
): Promise<readonly ProviderAccountResponse[]> {
  const rows = await ctx.db
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
  const accounts = await accountsWithUsage(ctx, tenantId, rows);
  const poolAccounts = await listPoolAccounts(ctx, tenantId, providerId);
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
export async function listAccountIds(
  ctx: StoreAccountContext,
  tenantId: string,
  providerId: string,
): Promise<readonly string[]> {
  const rows = await ctx.db
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

/**
 * One id-only ownership probe for routes that delegate to a narrower store
 * call afterwards. `globalOrOwnedBy` admits shared rows exactly like the
 * health-event/buddy-growth/recover preludes this replaces — the catalog's
 * visibility rule is "tenant-owned or global", not owned-only.
 */
export async function ownsAccount(
  ctx: StoreAccountContext,
  tenantId: string,
  providerId: string,
  accountId: string,
): Promise<boolean> {
  const rows = await ctx.db
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
  return rows.length > 0;
}

/**
 * The owned-only counterpart: `tenant_id` must equal the caller's tenant, so
 * a shared/global account is never matched. Used where the operation must
 * not act on a global row (the token-refresh admission check).
 */
export async function getOwnedAccount(
  ctx: StoreAccountContext,
  tenantId: string,
  providerId: string,
  accountId: string,
): Promise<OwnedProviderAccountRef | undefined> {
  const rows = await ctx.db
    .select({
      id: providerAccounts.id,
      providerId: providerAccounts.providerId,
      tenantId: providerAccounts.tenantId,
      credentialKind: providerAccounts.credentialKind,
      staticToken: providerAccounts.staticToken,
    })
    .from(providerAccounts)
    .where(
      and(
        eq(providerAccounts.id, accountId),
        eq(providerAccounts.providerId, providerId),
        ownedByOnly(providerAccounts.tenantId, tenantId),
      ),
    )
    .limit(1);
  const row = rows[0];
  return row === undefined
    ? undefined
    : {
        id: row.id,
        providerId: row.providerId,
        tenantId: row.tenantId,
        credentialKind: row.credentialKind,
        staticToken: row.staticToken,
      };
}

/**
 * Loads a shared/global `provider_accounts` row (`tenant_id IS NULL`) for
 * platform-admin token refresh operations.
 */
export async function getGlobalAccount(
  ctx: StoreAccountContext,
  providerId: string,
  accountId: string,
): Promise<OwnedProviderAccountRef | undefined> {
  const rows = await ctx.db
    .select({
      id: providerAccounts.id,
      providerId: providerAccounts.providerId,
      tenantId: providerAccounts.tenantId,
      credentialKind: providerAccounts.credentialKind,
      staticToken: providerAccounts.staticToken,
    })
    .from(providerAccounts)
    .where(
      and(
        eq(providerAccounts.id, accountId),
        eq(providerAccounts.providerId, providerId),
        isNull(providerAccounts.tenantId),
      ),
    )
    .limit(1);
  const row = rows[0];
  return row === undefined
    ? undefined
    : {
        id: row.id,
        providerId: row.providerId,
        tenantId: row.tenantId,
        credentialKind: row.credentialKind,
        staticToken: row.staticToken,
      };
}

export async function listAllAccounts(
  ctx: StoreAccountContext,
  tenantId: string,
): Promise<readonly ProviderAccountResponse[]> {
  const rows = await ctx.db
    .select()
    .from(providerAccounts)
    .where(globalOrOwnedBy(providerAccounts.tenantId, tenantId))
    .orderBy(asc(providerAccounts.sortIndex), asc(providerAccounts.createdAt), asc(providerAccounts.id));
  const accounts = await accountsWithUsage(ctx, tenantId, rows);
  const poolAccounts = await listAllPoolAccounts(ctx, tenantId);
  if (poolAccounts.length === 0) return accounts;
  return [...accounts, ...poolAccounts];
}

export async function listAllAccountSummaries(
  ctx: StoreAccountContext,
  tenantId: string,
): Promise<readonly { providerId: string; status: string }[]> {
  const rows = await ctx.db
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
export async function providerAccountCounts(
  ctx: StoreAccountContext,
  tenantId: string,
): Promise<readonly { providerId: string; total: number; active: number }[]> {
  const rows = await ctx.db
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
export async function providerModelCounts(
  ctx: StoreAccountContext,
  tenantId: string,
): Promise<readonly { providerId: string; count: number }[]> {
  const rows = await ctx.db
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
