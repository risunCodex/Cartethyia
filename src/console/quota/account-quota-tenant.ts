import { globalOrOwnedBy } from "../../persistence/tenant-scope";
import { t } from "elysia";
import type { Elysia } from "elysia";
import { and, eq, inArray } from "drizzle-orm";
import { providerAccounts, providers } from "../../persistence/schema";
import { providerDisplayName } from "../../providers/provider-metadata";
import {
  invalidateCredentialCache,
  invalidateCredentialCaches,
} from "../../providers/operations/provider-credential-service";
import { requireTenantScope } from "../shared/errors";
import { BUDDY_PROVIDER_IDS } from "../../providers/provider-metadata";
import { GatewayError } from "../../protocol/gateway-error";
import {
  GLOBAL_QUOTA_LENS,
  getCachedQuotaEntries,
  getCachedQuotaEntry,
  invalidateQuotaCache,
  invalidateQuotaCaches,
} from "../../providers/quota/cache";
import { readQuotaSnapshot, readQuotaSnapshots } from "../../providers/quota/snapshot";
import {
  QUOTA_REFRESH_TOTAL_TIMEOUT_MS,
  quotaFetcherFor,
  refreshAccountQuota,
  timeoutSignal,
  type QuotaRefreshDeps,
  type QuotaRefreshFailureCode,
} from "../../providers/quota/refresh";
import { selectAccountTestEgress } from "./account-test-egress";
import { checkinAttemptedTodayBatch } from "../../workers/daily-checkin";
import {
  enqueueBackgroundQuotaRefresh,
  pendingQuotaRefreshes,
  toQuotaAccountHealth,
  toQuotaView,
} from "./quota-view";
import {
  loadAccountRow,
  resolveNextAccountStatus,
  supportsAccountCheckin,
  type AccountQuotaRoutesDeps,
} from "./account-quota-shared";
import { registerAccountGrowthTenantRoutes } from "./account-quota-actions";

/** Providers whose billing meter reports real per-day credit deductions. */
function isBuddyProvider(providerId: string): boolean {
  return BUDDY_PROVIDER_IDS.has(providerId);
}

/**
 * One account's stored usage, as the console renders it.
 *
 * `null` when nothing has been synced yet. Deliberately not an empty list: an
 * account with no snapshot has *no data*, while an account that spent nothing
 * has a snapshot saying zero — the page has to tell those apart.
 */
function toBuddyUsageView(
  rows: readonly { readonly day: string; readonly model: string; readonly credit: number }[] | undefined,
): {
  readonly totalCredits: number;
  readonly days: readonly { readonly day: string; readonly credit: number }[];
  readonly models: readonly { readonly model: string; readonly credit: number }[];
} | null {
  if (rows === undefined || rows.length === 0) return null;
  const byDay = new Map<string, number>();
  const byModel = new Map<string, number>();
  let totalCredits = 0;
  for (const row of rows) {
    byDay.set(row.day, (byDay.get(row.day) ?? 0) + row.credit);
    byModel.set(row.model, (byModel.get(row.model) ?? 0) + row.credit);
    totalCredits += row.credit;
  }
  return {
    totalCredits: Math.round(totalCredits * 100) / 100,
    days: [...byDay.entries()].map(([day, credit]) => ({ day, credit })),
    models: [...byModel.entries()]
      .map(([model, credit]) => ({ model, credit }))
      // Highest spend first: the operator is looking for what costs the most.
      .sort((left, right) => right.credit - left.credit),
  };
}

/**
 * How many accounts are refreshed at once.
 *
 * This is the bound, not a cap on how many may be requested. A tenant with
 * several hundred accounts used to be refused outright at 100 — "accountIds
 * exceeds the limit of 100" — so refreshing the whole fleet meant hand-batching
 * in the UI. Concurrency is what actually protects the upstream and the
 * gateway, and it does so regardless of how many ids arrive, so the request is
 * accepted at any size and drained through this many workers.
 */
const QUOTA_REFRESH_CONCURRENCY = 5;

/**
 * Registers the tenant-scoped account/quota routes onto `app`. Every route here
 * authorises through `requireTenantScope`, so the caller only ever touches its
 * own tenant's accounts.
 */
export function registerAccountQuotaTenantRoutes(
  app: Elysia,
  deps: AccountQuotaRoutesDeps,
  refreshDeps: QuotaRefreshDeps,
): void {
  const {
    db,
    accessResolver,
    redis,
    snapshotInvalidator,
    auditRecorder,
    providerRegistry,
  } = deps;
  app
    .get("/quota/overview", async ({ request }) => {
      const access = requireTenantScope(accessResolver(request), "dashboard:read");
      const rows = await db
        .select({
          id: providerAccounts.id,
          providerId: providerAccounts.providerId,
          tenantId: providerAccounts.tenantId,
          label: providerAccounts.label,
          credentialKind: providerAccounts.credentialKind,
          status: providerAccounts.status,
          lastError: providerAccounts.lastError,
          lastErrorCategory: providerAccounts.lastErrorCategory,
          lastSuccessAt: providerAccounts.lastSuccessAt,
          cooldownUntil: providerAccounts.cooldownUntil,
          modelCooldowns: providerAccounts.modelCooldowns,
        })
        .from(providerAccounts)
        .innerJoin(providers, eq(providerAccounts.providerId, providers.id))
        .where(
          and(
            globalOrOwnedBy(providerAccounts.tenantId, access.tenantId),
            globalOrOwnedBy(providers.tenantId, access.tenantId),
          ),
        );

      // One batch read per lens instead of one round trip per account: the page
      // renders every account at once, so per-account reads would make opening
      // it scale with the account count.
      const ownedIds: string[] = [];
      const globalIds: string[] = [];
      for (const row of rows) {
        if (row.tenantId === null) globalIds.push(row.id);
        else ownedIds.push(row.id);
      }
      const [ownedCache, globalCache] = await Promise.all([
        getCachedQuotaEntries(access.tenantId, ownedIds, redis),
        getCachedQuotaEntries(GLOBAL_QUOTA_LENS, globalIds, redis),
      ]);
      // A page open right after a restart finds the in-process cache empty.
      // Fall back to the persisted snapshots (which survive a restart) so the
      // page still renders the last known balance; the sweep refreshes it.
      const snapshots = await readQuotaSnapshots(
        db,
        rows.filter((row) => !globalCache.has(row.id) && !ownedCache.has(row.id)).map((row) => row.id),
      );

      const pending = pendingQuotaRefreshes();
      const providerIds = [...new Set(rows.map((row) => row.providerId))];
      // The dropdown is a quota-page control, not a provider directory: only
      // providers whose registry entry can actually answer a quota fetch
      // appear, so key-only providers with no quota endpoint never show up.
      const quotaProviders = providerIds.filter((providerId) =>
        providerRegistry.hasQuotaCollector(providerId),
      );
      const providersSummary = quotaProviders
        .sort((left, right) => left.localeCompare(right))
        .map((providerId) => ({
          id: providerId,
          name: providerDisplayName(providerId),
          icon: providerId,
        }));
      let refreshing = 0;
      // Cold-cache backfill: the overview renders whatever is cached, and the
      // periodic sweep owns freshness — but with many accounts (e.g. a large
      // Qoder roster) the sweep's per-pass cap cannot keep every cache warm,
      // so a page open would show accounts with no badge for minutes. Enqueue
      // a bounded background refresh for accounts whose cache entry is missing
      // (not merely stale), so the badge fills in without waiting for the next
      // sweep pass and without fanning out to the whole roster at once.
      const coldCacheCap = 20;
      let coldCacheEnqueued = 0;
      // The sweep's day markers answer "attempted today" without an upstream
      // request; only check-in-capable accounts can carry one, so only they
      // are read.
      const checkinCandidates = rows.filter((row) => supportsAccountCheckin(row.providerId));
      // One batched read for the whole page. Per-account reads made opening
      // this route scale with the account count — a round trip each, on the
      // route the dashboard polls — for a marker that is one key per account.
      const checkinAttempted = await checkinAttemptedTodayBatch({
        db,
        redis,
        accountIds: checkinCandidates.map((row) => row.id),
      });
      // Real credit deductions, read from the stored snapshots rather than from
      // the upstream: the page renders every account at once, and re-hitting the
      // billing endpoint per account would make opening it scale with the
      // account count. One batch read for every buddy row.
      // dynamic-import: B-02 lazy graph — buddy usage snapshots, only when the page renders buddy accounts.
      // The buddy-usage-store graph is lazy-loaded: it is only needed when the
      // page actually renders buddy accounts (B-02).
      const { readBuddyUsageSnapshots } = await import(
        "../../providers/integrations/buddy/account"
      );
      const usageByAccount = await readBuddyUsageSnapshots(
        db,
        rows.filter((row) => isBuddyProvider(row.providerId)).map((row) => row.id),
      );
      const accounts = rows.map((row) => {
        const entry =
          row.tenantId === null ? globalCache.get(row.id) : ownedCache.get(row.id);
        const snapshot = entry ?? snapshots.get(row.id);
        const entryQuota = snapshot ? snapshot.quota : null;
        const entryFetchedAt = snapshot ? snapshot.fetchedAt : null;
        // No background refresh is enqueued here: enqueuing one for every
        // account whose cached value had aged out means a single page open hits
        // every provider's quota endpoint at once — and because the page also
        // polls, the operator sees that fan-out as "the page refreshes
        // everything when I open it". The periodic sweep owns freshness; this
        // route renders what is cached.
        //
        // `refreshing` still counts accounts with no cached value, so the client
        // can show them as pending while the sweep fills them.
        const canRefresh = providerRegistry.hasQuotaCollector(row.providerId);
        const isRefreshing = canRefresh && (pending.has(row.id) || entry === undefined);
        if (isRefreshing) refreshing += 1;
        // Backfill a missing cache entry on page open (bounded, see above).
        if (
          canRefresh &&
          entry === undefined &&
          !pending.has(row.id) &&
          coldCacheEnqueued < coldCacheCap
        ) {
          coldCacheEnqueued += 1;
          enqueueBackgroundQuotaRefresh(refreshDeps, {
            accountId: row.id,
            providerId: row.providerId,
            tenantId: row.tenantId,
            credentialKind: row.credentialKind,
          });
        }
        return {
          id: row.id,
          provider: row.providerId,
          name: row.label || row.id,
          credentialHint: row.credentialKind,
          active: row.status === "active",
          quota: entryQuota
            ? toQuotaView(entryQuota, row, {
                fetchedAt: entryFetchedAt,
                lastAttemptAt: entry?.lastAttemptAt ?? null,
                refreshError: entry?.refreshError ?? null,
                ...(isRefreshing ? { status: "refreshing" as const } : {}),
              })
            : null,
          pending: isRefreshing,
          health: toQuotaAccountHealth(row),
          providerName: providerDisplayName(row.providerId),
          providerIcon: row.providerId,
          // Present only on buddy accounts. `attemptedToday` is the sweep
          // ledger (no upstream cost); the card combines it with the manual
          // trigger result to render claimed / already / due / unknown.
          ...(supportsAccountCheckin(row.providerId)
            ? { checkin: { attemptedToday: checkinAttempted.get(row.id) ?? false } }
            : {}),
          // Real usage: what the billing meter says this account actually spent,
          // per day and per model. Absent when nothing has been synced yet,
          // which is a "no data" state rather than a zero.
          ...(isBuddyProvider(row.providerId)
            ? { usage: toBuddyUsageView(usageByAccount.get(row.id)) }
            : {}),
        };
      });

      // `refreshing > 0` tells the client to poll quickly; once the worker has
      // filled everything this drops to 0 and the client falls back to its slow
      // cadence without a manual reload.
      return { providers: providersSummary, accounts, refreshing };
    })
    .get("/accounts/:id/quota", async ({ request, params, set }) => {
      const access = requireTenantScope(accessResolver(request), "dashboard:read");
      const accountId = params.id;
      const account = await loadAccountRow(db, accountId, access.tenantId);
      if (!account) {
        set.status = 404;
        return { error: `Account ${accountId} not found`, code: "not_found" };
      }
      // No quota collector means no upstream surface to ask: answer the
      // untracked state directly instead of caching a manufactured error.
      if (!providerRegistry.hasQuotaCollector(account.providerId)) {
        return {
          accountId,
          quota: null,
          health: toQuotaAccountHealth(account),
        };
      }
      const cached = await getCachedQuotaEntry(access.tenantId, accountId, redis);
      if (cached) {
        return {
          accountId,
          quota: toQuotaView(cached.quota, account, {
            fetchedAt: cached.fetchedAt,
            lastAttemptAt: cached.lastAttemptAt,
            refreshError: cached.refreshError,
          }),
          health: toQuotaAccountHealth(account),
        };
      }
      // Cache is cold (e.g. right after a restart): render the last persisted
      // snapshot instead of hitting upstream on every page open. The sweep
      // refreshes it; a page open does not need to pay the upstream cost.
      const snapshot = await readQuotaSnapshot(db, accountId);
      if (snapshot) {
        return {
          accountId,
          quota: toQuotaView(snapshot.quota, account, {
            fetchedAt: snapshot.fetchedAt,
            lastAttemptAt: snapshot.fetchedAt,
          }),
          health: toQuotaAccountHealth(account),
        };
      }

      // Cold read: this is the one path that legitimately waits on upstream, and
      // it shares the in-flight fetch with any queued background fill so a cold
      // page open never issues two requests for the same account.
      const outcome = await refreshAccountQuota(
        refreshDeps,
        {
          accountId,
          providerId: account.providerId,
          tenantId: account.tenantId,
          credentialKind: account.credentialKind,
          authState: account.authState,
        },
        await quotaFetcherFor(refreshDeps, accountId, account.tenantId, timeoutSignal(request.signal, QUOTA_REFRESH_TOTAL_TIMEOUT_MS)),
      );
      const fresh = await getCachedQuotaEntry(access.tenantId, accountId, redis);
      return {
        accountId,
        quota: toQuotaView(fresh?.quota ?? outcome.quota, account, {
          fetchedAt: fresh?.fetchedAt ?? null,
          lastAttemptAt: fresh?.lastAttemptAt ?? new Date().toISOString(),
          lastSuccessAt: fresh?.fetchedAt ?? null,
          refreshError: fresh?.refreshError ?? null,
        }),
        health: toQuotaAccountHealth(account),
      };
    })
    .post("/accounts/:id/quota/refresh", async ({ request, params, set }) => {
      const access = requireTenantScope(accessResolver(request), "dashboard:write");
      const accountId = params.id;
      const account = await loadAccountRow(db, accountId, access.tenantId);
      if (!account) {
        set.status = 404;
        return { error: `Account ${accountId} not found`, code: "not_found" };
      }
      // Manual refresh on a collectorless provider is a no-op by design, not
      // a 502: there is nothing upstream to probe.
      if (!providerRegistry.hasQuotaCollector(account.providerId)) {
        return { ok: true, status: 200, data: { id: accountId, quota: null } };
      }

      const attemptedAt = new Date().toISOString();
      if (!deps.poolSelector || !deps.networkBindingFactory) {
        throw new GatewayError(
          "proxy_pool_unavailable",
          503,
          "Account test cannot select a proxy because proxy routing is not configured. No bridge to cross — configure a pool first 🏗️",
          { reason: "proxy_routing_unconfigured" },
          "network",
        );
      }
      const egress = await selectAccountTestEgress(
        {
          db,
          poolSelector: deps.poolSelector,
          networkBindingFactory: deps.networkBindingFactory,
        },
        {
          tenantId: access.tenantId,
          providerId: account.providerId,
          signal: timeoutSignal(request.signal, QUOTA_REFRESH_TOTAL_TIMEOUT_MS),
        },
      );
      let outcome;
      try {
        outcome = await refreshAccountQuota(
          refreshDeps,
          {
            accountId,
            providerId: account.providerId,
            tenantId: account.tenantId,
            credentialKind: account.credentialKind,
            // Kiro's usage surface is profile-scoped: without the account's auth
            // state the collector cannot resolve a `profileArn`, and the GET is
            // refused with `400 Invalid profileArn.`.
            authState: account.authState,
          },
          egress.fetch,
        );
      } finally {
        egress.release();
      }
      const httpStatus = outcome.quota.error === null ? 200 : 502;
      set.status = httpStatus;
      return {
        ok: outcome.quota.error === null,
        status: httpStatus,
        data: {
          id: accountId,
          quota: toQuotaView(outcome.quota, account, {
            fetchedAt: attemptedAt,
            lastAttemptAt: attemptedAt,
            lastSuccessAt: outcome.quota.error === null ? attemptedAt : null,
          }),
        },
        message: outcome.quota.error ?? undefined,
      };
    })
    .post(
      "/quota/refresh",
      {
        body: t.Optional(
          t.Object({
            accountIds: t.Optional(t.Array(t.String())),
            ids: t.Optional(t.Array(t.String())),
          }),
        ),
      },
      async ({ request, body, set }) => {
        const access = requireTenantScope(accessResolver(request), "dashboard:write");
        const ids = body?.accountIds ?? body?.ids ?? [];
        if (ids.length === 0) {
          set.status = 400;
          return { error: "accountIds must be a non-empty array", code: "invalid_request" };
        }
        const accounts = await db
          .select({
            accountId: providerAccounts.id,
            providerId: providerAccounts.providerId,
            tenantId: providerAccounts.tenantId,
            credentialKind: providerAccounts.credentialKind,
            authState: providerAccounts.authState,
          })
          .from(providerAccounts)
          .where(
            and(
              inArray(providerAccounts.id, ids),
              globalOrOwnedBy(providerAccounts.tenantId, access.tenantId),
            ),
          );
        // Collectorless accounts are done without a fetch: counted as
        // succeeded with no quota, never as failures.
        const refreshable = accounts.filter((account) => providerRegistry.hasQuotaCollector(account.providerId));

        // A fresh deadline per account, not one for the whole batch: a single
        // 15s signal minted at request entry expired while the workers drained
        // later accounts, so every account past the first few got an already-
        // aborted fetch and was parked `quota_fetch_failed` over a batch budget,
        // not a credential problem. The request signal still cancels the whole
        // batch when the operator navigates away.
        const egressFor = (target: { readonly accountId: string; readonly tenantId: string | null }): Promise<typeof fetch> =>
          quotaFetcherFor(
            refreshDeps,
            target.accountId,
            target.tenantId,
            timeoutSignal(request.signal, QUOTA_REFRESH_TOTAL_TIMEOUT_MS),
          );
        const failures: Array<{
          accountId: string;
          code: QuotaRefreshFailureCode;
          message: string;
        }> = [];
        let succeeded = accounts.length - refreshable.length;
        let cursor = 0;
        await Promise.all(
          Array.from(
            { length: Math.min(QUOTA_REFRESH_CONCURRENCY, refreshable.length) },
            async () => {
              while (cursor < refreshable.length) {
                const target = refreshable[cursor++]!;
                const outcome = await refreshAccountQuota(refreshDeps, target, await egressFor(target));
                if (outcome.failure !== null) {
                  failures.push({
                    accountId: target.accountId,
                    code: outcome.failure,
                    message: outcome.quota.error ?? "Failed to refresh quota",
                  });
                  continue;
                }
                succeeded += 1;
              }
            },
          ),
        );

        return {
          ok: failures.length === 0,
          queued: accounts.length,
          succeeded,
          failed: failures.length,
          failures,
          accountIds: accounts.map((a) => a.accountId),
        };
      },
    )
    .patch(
      "/accounts/:id",
      {
        body: t.Object({
          active: t.Optional(t.Boolean()),
          status: t.Optional(t.String()),
        }),
      },
      async ({ request, params, body, set }) => {
        const access = requireTenantScope(accessResolver(request), "dashboard:write");
        const resolved = resolveNextAccountStatus(body);
        if (!resolved.ok) {
          set.status = resolved.status;
          return resolved.body;
        }
        const nextStatus = resolved.nextStatus;
        const updated = await db
          .update(providerAccounts)
          .set({ status: nextStatus })
          .where(
            and(
              eq(providerAccounts.id, params.id),
              eq(providerAccounts.tenantId, access.tenantId),
            ),
          )
          .returning({ id: providerAccounts.id });
        if (updated.length === 0) {
          set.status = 404;
          return { error: `Account ${params.id} not found`, code: "not_found" };
        }
        // A status flip must not drop a good cached quota: the value is an
        // upstream fact that the flip does not change, and clearing it would
        // blank the card the user is looking at. Only the route snapshot
        // (dispatch eligibility) needs to change.
        await snapshotInvalidator?.invalidate();
        return { ok: true, status: 200 };
      },
    )
    .patch(
      "/accounts/batch",
      {
        body: t.Object({
          ids: t.Array(t.String()),
          active: t.Boolean(),
        }),
      },
      async ({ request, body }) => {
        const access = requireTenantScope(accessResolver(request), "dashboard:write");
        // No size cap: a tenant-wide enable/disable is a legitimate single
        // request, and the UPDATE is one statement over `inArray` either way.
        if (body.ids.length === 0) return { ok: true, updated: 0 };
        const status = body.active ? ("active" as const) : ("disabled" as const);
        const updated = await db
          .update(providerAccounts)
          .set({ status })
          .where(
            and(
              inArray(providerAccounts.id, body.ids),
              eq(providerAccounts.tenantId, access.tenantId),
            ),
          )
          .returning({ id: providerAccounts.id });
        await snapshotInvalidator?.invalidate();
        return {
          ok: true,
          status: 200,
          data: {
            updated: updated.length,
            ids: updated.map((row) => row.id),
          },
        };
      },
    )
    .delete("/accounts/:id", async ({ request, params, set }) => {
      const access = requireTenantScope(accessResolver(request), "dashboard:write");
      const accountId = params.id;
      const deleted = await db
        .delete(providerAccounts)
        .where(
          and(eq(providerAccounts.id, accountId), eq(providerAccounts.tenantId, access.tenantId)),
        )
        .returning({ id: providerAccounts.id });
      if (deleted.length === 0) {
        set.status = 404;
        return { error: `Account ${accountId} not found`, code: "not_found" };
      }
      invalidateCredentialCache(accountId);
      // The account is gone, so its cached quota must go with it — unlike a
      // status flip, nothing can make this value meaningful again.
      await invalidateQuotaCache(access.tenantId, accountId, redis);
      await snapshotInvalidator?.invalidate();
      await auditRecorder?.record({
        access,
        action: "provider_account.deleted",
        target: accountId,
      });
      return { success: true };
    })
    .post(
      "/accounts/batch-delete",
      {
        body: t.Object({
          accountIds: t.Array(t.String()),
        }),
      },
      async ({ request, body }) => {
        const access = requireTenantScope(accessResolver(request), "dashboard:write");
        const accountIds = [...new Set(body.accountIds)];
        if (accountIds.length === 0) {
          return { ok: true, deleted: [], missing: [] };
        }
        // One DELETE statement for the whole batch, scoped to the tenant: a
        // global/shared account (`tenant_id IS NULL`) is never matchable, so
        // it lands in `missing` rather than being deleted by a tenant.
        const deleted = await db
          .delete(providerAccounts)
          .where(
            and(
              inArray(providerAccounts.id, accountIds),
              eq(providerAccounts.tenantId, access.tenantId),
            ),
          )
          .returning({ id: providerAccounts.id });
        const deletedIds = deleted.map((row) => row.id);
        const deletedSet = new Set(deletedIds);
        const missing = accountIds.filter((id) => !deletedSet.has(id));
        // One credential-cache pass, one quota-cache pass, one snapshot
        // invalidation, one audit row — never one per deleted account.
        invalidateCredentialCaches(deletedIds);
        await invalidateQuotaCaches(access.tenantId, deletedIds, redis);
        await snapshotInvalidator?.invalidate();
        await auditRecorder?.record({
          access,
          action: "provider_account.batch_deleted",
          target: access.tenantId,
          detail: { deleted: deletedIds, missing },
        });
        return { ok: true, deleted: deletedIds, missing };
      },
    )
;

  registerAccountGrowthTenantRoutes(app, deps, refreshDeps);
}
