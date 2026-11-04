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
  invalidateQuotaCacheForAccount,
} from "../../providers/quota/cache";
import { readQuotaSnapshot, readQuotaSnapshots } from "../../providers/quota/snapshot";
import {
  QUOTA_REFRESH_TIMEOUT_MS,
  refreshAccountQuota,
  signalFetch,
  timeoutSignal,
  type QuotaRefreshDeps,
  type QuotaRefreshFailureCode,
} from "../../providers/quota/refresh";
import { selectAccountTestEgress } from "./account-test-egress";
import type { ValidatedFetch } from "../../network/outbound-fetch";
import type { ProviderId } from "../../providers/provider-contracts";
import {
  DAILY_CHECKIN_PROVIDER_IDS,
  checkinAttemptedToday,
  checkinAttemptedTodayBatch,
  dailyCheckinEgressForPass,
  markCheckinAttempted,
} from "../../workers/daily-checkin";
import {
  fetchBuddyActivityReport,
  fetchDailyCheckin,
  type BuddyActivityReportResult,
  type DailyCheckinResult,
} from "../../providers/integrations/buddy/buddy-checkin";
import {
  fetchQoderDailyCheckin,
  isQoderCheckinProvider,
} from "../../providers/integrations/qoder/qoder-checkin";
import {
  claimQoderCredits,
  QODER_CREDIT_PROVIDER_IDS,
  type QoderCreditClaimResult,
} from "../../providers/integrations/qoder/claim-qoder-credits";
import {
  DrizzleQoderNativeIdentityStore,
  type QoderNativeIdentityStore,
} from "../../providers/integrations/qoder/qoder-native-identity-store";
import { claimZcodeGifts, type ZcodeGiftResult } from "../../providers/integrations/zcode-start-plan/gifts";
import { ZCODE_START_PLAN_PROVIDER_ID } from "../../providers/integrations/zcode-start-plan/provider";
import {
  supportsAccountReset,
  consumeAccountResetCredit,
  getCachedResetCredits,
  listAccountResetCredits,
} from "../../providers/operations/account-reset-service";
import {
  enqueueBackgroundQuotaRefresh,
  pendingQuotaRefreshes,
  toQuotaAccountHealth,
  toQuotaView,
} from "./quota-view";
import {
  ACCOUNT_STATUSES,
  type AccountQuotaRoutesDeps,
  type AccountStatus,
} from "./account-quota-shared";
import {
  DAILY_GROWTH_LEG_TIMEOUT_MS,
  enqueueDailyGrowthJob,
  getDailyGrowthJob,
  withLegBudget,
  type DailyGrowthJobAccount,
  type DailyGrowthJobDeps,
} from "./daily-growth-job";

/** Daily check-in only exists on the buddy billing facade; everything else 400s with intent. */
function supportsAccountCheckin(providerId: string): boolean {
  return (DAILY_CHECKIN_PROVIDER_IDS as readonly string[]).includes(providerId);
}

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

/** One account's check-in through the buddy billing facade (Qoder uses its own surface). */
async function runAccountCheckin(
  account: { id: string; providerId: string },
  credential: string,
  forceClaim: boolean,
  nativeIdentityStore?: QoderNativeIdentityStore,
): Promise<DailyCheckinResult> {
  if (isQoderCheckinProvider(account.providerId)) {
    return fetchQoderDailyCheckin({
      providerId: account.providerId,
      accountId: account.id,
      credential,
      fetcher: globalThis.fetch,
      ...(nativeIdentityStore ? { nativeIdentityStore } : {}),
    });
  }
  return fetchDailyCheckin({
    providerId: account.providerId,
    accountId: account.id,
    credential,
    fetcher: globalThis.fetch,
    ...(forceClaim ? { forceClaim } : {}),
  });
}

/**
 * One account's daily growth pass, report first then claim.
 *
 * The report goes first because it is the leg that lands on a free plan; the
 * claim is attempted after it regardless of how the report went. Each leg
 * reports its own outcome so the operator can see which one failed.
 *
 * `rotator` supplies the per-account egress the sweep uses; without one the
 * request leaves through direct egress, which is what the single-account routes
 * do.
 */
async function runDailyGrowthForAccount(
  providerId: ProviderId,
  account: { readonly id: string; readonly tenantId: string | null },
  refreshDeps: QuotaRefreshDeps,
  rotator: ((accountId: string, tenantId?: string | null) => Promise<ValidatedFetch>) | undefined,
): Promise<{
  readonly report: { readonly ok: boolean; readonly message: string };
  readonly checkin: { readonly ok: boolean; readonly message: string };
}> {
  const fetcher = rotator
    ? ((await rotator(account.id, account.tenantId)) as unknown as typeof fetch)
    : globalThis.fetch;
  let credential: string;
  try {
    credential = await refreshDeps.resolveCredential(providerId, account.id);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to resolve the credential.";
    return {
      report: { ok: false, message },
      checkin: { ok: false, message },
    };
  }

  // Report leg: needs a uid, which only a JWT carries, so an opaque API key
  // fails closed instead of reporting under another account's identity. Qoder
  // has no activity-report leg — its daily grant is purely the check-in.
  const qoderAccount = isQoderCheckinProvider(String(providerId));
  // dynamic-import: B-02 lazy graph — buddy uid decoder, only for buddy report legs.
  // The buddy-oauth-shared graph is lazy-loaded: the uid decoder is only
  // needed for buddy accounts' report leg (B-02).
  const { buddyAccountUid } = await import(
    "../../providers/integrations/buddy/buddy-oauth-shared"
  );
  const userId = buddyAccountUid(credential);
  let report: { ok: boolean; message: string };
  if (qoderAccount) {
    report = { ok: true, message: "Qoder has no activity-report leg" };
  } else if (userId === undefined || userId.length === 0) {
    report = { ok: false, message: "Report needs an OAuth account (no uid in this credential)" };
  } else {
    try {
      const result = await fetchBuddyActivityReport({
        providerId,
        accountId: account.id,
        credential,
        userId,
        fetcher,
      });
      report = result.state === "error"
        ? { ok: false, message: result.error ?? "Activity report failed" }
        : { ok: true, message: "Report sent — login streak lit for today" };
    } catch (error) {
      report = {
        ok: false,
        message: error instanceof Error ? error.message : "Activity report failed",
      };
    }
  }

  let checkin: { ok: boolean; message: string };
  try {
    const result = qoderAccount
      ? await fetchQoderDailyCheckin({
          providerId: String(providerId),
          accountId: account.id,
          credential,
          fetcher,
          nativeIdentityStore: new DrizzleQoderNativeIdentityStore(refreshDeps.db),
        })
      : await fetchDailyCheckin({
          providerId,
          accountId: account.id,
          credential,
          forceClaim: true,
          fetcher,
        });
    checkin =
      result.state === "error"
        ? { ok: false, message: result.error ?? "Daily check-in failed" }
        : { ok: true, message: checkinStateMessage(result) };
    // A manual trigger bypasses the day marker on the way in — the operator
    // asked for "now", and a marker must not be able to refuse that — but it
    // still leaves the marker behind, so the sweep does not spend another
    // claim on the same account later today and the console can answer
    // "attempted today" for an attempt made outside the sweep.
    if (result.state !== "error") {
      await markCheckinAttempted({ db: refreshDeps.db, redis: refreshDeps.redis, accountId: account.id });
    }
  } catch (error) {
    checkin = {
      ok: false,
      message: error instanceof Error ? error.message : "Daily check-in failed",
    };
  }
  return { report, checkin };
}

/**
 * Reads today's check-in attempt from the ledger.
 *
 * Delegates to the module that owns the write: the marker lives in Redis when
 * Redis is present and in `daily_checkin_ledger` when it is not, and only that
 * module knows which one its own writes used.
 */
async function todayCheckinAttempted(
  db: AccountQuotaRoutesDeps["db"] | undefined,
  redis: AccountQuotaRoutesDeps["redis"],
  accountId: string,
): Promise<boolean> {
  return checkinAttemptedToday({ db, redis, accountId });
}

/**
 * Operator-facing sentence for one check-in outcome.
 *
 * Every non-claimed state says what happens next rather than only that the
 * attempt happened. `unavailable` in particular is the normal case on a free
 * plan — the check-in activity simply is not running — and reading as a bare
 * "unavailable" looked like a failure, when the account had still done its
 * daily report and will be credited on the next cycle. A claim that did land
 * states the amount.
 */
function checkinStateMessage(result: DailyCheckinResult): string {
  switch (result.state) {
    case "claimed":
      return result.credit !== null
        ? `credited ${result.credit} credits${result.streakDays !== null ? ` (${result.streakDays}-day streak)` : ""}`
        : "credited";
    case "already_claimed":
      return "already claimed today — credited again tomorrow";
    case "not_eligible":
      return "not eligible on this account";
    case "event_ended":
      return "event has ended";
    case "unavailable":
      return "not open right now — you'll be credited on the next cycle";
    case "error":
      return result.error ?? "could not be completed";
  }
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
    networkBindingFactory,
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
        "../../providers/integrations/buddy/buddy-usage-store"
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
      const rows = await db
        .select()
        .from(providerAccounts)
        .where(
          and(eq(providerAccounts.id, accountId), eq(providerAccounts.tenantId, access.tenantId)),
        )
        .limit(1);
      const account = rows[0];
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
        signalFetch(timeoutSignal(request.signal, QUOTA_REFRESH_TIMEOUT_MS)),
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
      const rows = await db
        .select()
        .from(providerAccounts)
        .where(
          and(eq(providerAccounts.id, accountId), eq(providerAccounts.tenantId, access.tenantId)),
        )
        .limit(1);
      const account = rows[0];
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
          "Account test cannot select a proxy because proxy routing is not configured (request {requestId}). No bridge to cross — configure a pool first 🏗️",
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
          signal: timeoutSignal(request.signal, QUOTA_REFRESH_TIMEOUT_MS),
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

        const timedFetch = signalFetch(timeoutSignal(request.signal, QUOTA_REFRESH_TIMEOUT_MS));
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
                const outcome = await refreshAccountQuota(refreshDeps, target, timedFetch);
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
        if (body.status !== undefined && !ACCOUNT_STATUSES.includes(body.status as AccountStatus)) {
          set.status = 400;
          return {
            error: `status must be one of: ${ACCOUNT_STATUSES.join(", ")}`,
            code: "invalid_status",
          };
        }
        const nextStatus: AccountStatus | undefined =
          body.active !== undefined
            ? body.active
              ? "active"
              : "disabled"
            : (body.status as AccountStatus | undefined);
        if (!nextStatus) {
          set.status = 400;
          return { error: "active or status is required", code: "invalid_request" };
        }
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
    /**
     * Enqueues a background daily-growth job over a provider's accounts: the
     * growth-activity report first, then the check-in claim — the order the
     * sweep uses — with egress rotated per account the same way the worker
     * does, so a batch leaves from more than one address.
     *
     * Running the whole batch in the request held it open for every account's
     * upstream calls; the route now returns `{ jobId }` immediately and the
     * work drains through a bounded background worker (see the job status
     * route below). A manual trigger is the operator asserting "try now", so
     * it bypasses the sweep's once-per-day ledger; the upstream stays
     * idempotent either way.
     */
    .post(
      "/quota/daily-growth",
      {
        body: t.Object({
          providerId: t.String(),
          accountIds: t.Optional(t.Array(t.String())),
        }),
      },
      async ({ request, body, set }) => {
        const access = requireTenantScope(accessResolver(request), "dashboard:write");
        const providerId = body.providerId.trim().toLowerCase();
        if (!supportsAccountCheckin(providerId)) {
          set.status = 400;
          return {
            error: `Daily check-in is not supported for provider ${providerId}`,
            code: "checkin_unsupported",
          };
        }
        const wanted = body.accountIds?.filter((id) => id.trim().length > 0) ?? [];
        const rows = await db
          .select({
            id: providerAccounts.id,
            tenantId: providerAccounts.tenantId,
            label: providerAccounts.label,
          })
          .from(providerAccounts)
          .where(
            and(
              eq(providerAccounts.providerId, providerId),
              globalOrOwnedBy(providerAccounts.tenantId, access.tenantId),
              ...(wanted.length > 0 ? [inArray(providerAccounts.id, wanted)] : []),
            ),
          );
        const accounts = wanted.length > 0
          ? rows.filter((row) => wanted.includes(row.id))
          : rows;
        if (accounts.length === 0) {
          set.status = 404;
          return {
            error: `No accounts for provider ${providerId} in this tenant`,
            code: "not_found",
          };
        }
        // No size cap, for the same reason as the quota refresh: the work is
        // already drained through a bounded worker pool behind the job, so
        // refusing the request protected nothing and just forced the operator
        // to batch by hand.
        //
        // One egress rotator for the whole job, exactly as the sweep builds it,
        // so consecutive accounts leave from consecutive pools. The job carries
        // the per-account run (report then claim) through the injected runner.
        const rotator =
          networkBindingFactory !== undefined
            ? dailyCheckinEgressForPass({ db, networkBindingFactory })
            : undefined;
        // One leg budget for the whole job: every upstream fetch the per-account
        // run issues carries it on top of the helpers' own per-request timeouts.
        const legSignal = AbortSignal.timeout(DAILY_GROWTH_LEG_TIMEOUT_MS);
        const rotatorWithBudget =
          rotator === undefined
            ? undefined
            : async (accountId: string, tenantId?: string | null) => {
                const base = await rotator(accountId, tenantId);
                return withLegBudget(base, legSignal) as unknown as ValidatedFetch;
              };

        const runAccount = async (account: DailyGrowthJobAccount) => {
          const outcome = await runDailyGrowthForAccount(
            providerId as ProviderId,
            account,
            refreshDeps,
            rotatorWithBudget,
          );
          if (!outcome.checkin.ok) {
            return { ok: false, error: outcome.checkin.message };
          }
          return { ok: true };
        };

        const jobDeps: DailyGrowthJobDeps = {
          db,
          redis,
          runAccount,
          ...(snapshotInvalidator ? { snapshotInvalidator } : {}),
        };
        const jobId = enqueueDailyGrowthJob({
          deps: jobDeps,
          tenantId: access.tenantId,
          providerId,
          accounts,
        });
        set.status = 202;
        return { jobId, status: 202 };
      },
    )
    .get("/quota/daily-growth/status/:jobId", async ({ request, params, set }) => {
      const access = requireTenantScope(accessResolver(request), "dashboard:read");
      const job = getDailyGrowthJob(params.jobId, access.tenantId);
      if (job === null) {
        set.status = 404;
        return { error: `Job ${params.jobId} not found`, code: "not_found" };
      }
      return job;
    })
    .post("/accounts/:id/checkin", async ({ request, params, set }) => {
      const access = requireTenantScope(accessResolver(request), "dashboard:write");
      const rows = await db
        .select()
        .from(providerAccounts)
        .where(
          and(eq(providerAccounts.id, params.id), eq(providerAccounts.tenantId, access.tenantId)),
        )
        .limit(1);
      const account = rows[0];
      if (!account) {
        set.status = 404;
        return { error: `Account ${params.id} not found`, code: "not_found" };
      }
      if (!supportsAccountCheckin(account.providerId)) {
        set.status = 400;
        return {
          error: `Daily check-in is not supported for provider ${account.providerId}`,
          code: "checkin_unsupported",
        };
      }
      // A manual trigger is the operator asserting "try now", so it bypasses
      // the sweep's once-per-day ledger and forces the status probe. The
      // upstream itself stays idempotent: a duplicate claim answers
      // `already_claimed`, never a double grant.
      let result: DailyCheckinResult;
      try {
        const credential = await refreshDeps.resolveCredential(
          account.providerId as ProviderId,
          account.id,
        );
        result = await runAccountCheckin(account, credential, true, new DrizzleQoderNativeIdentityStore(db));
      } catch (error) {
        result = {
          providerId: account.providerId,
          accountId: account.id,
          state: "error",
          credit: null,
          streakDays: null,
          error: error instanceof Error ? error.message : "Daily check-in failed.",
        };
      }
      if (result.state === "error") {
        set.status = 502;
        return {
          ok: false,
          status: 502,
          data: { id: account.id, state: result.state },
          message: result.error ?? "Daily check-in failed",
          code: "checkin_failed",
        };
      }
      // The trigger bypassed the ledger on the way in; leaving the marker
      // behind is what stops the sweep spending a second claim on this account
      // today and lets the console read "attempted today" for an attempt the
      // sweep did not make.
      await markCheckinAttempted({ db, redis, accountId: account.id });
      return {
        ok: true,
        status: 200,
        data: {
          id: account.id,
          state: result.state,
          credit: result.credit,
          streakDays: result.streakDays,
        },
        message: checkinStateMessage(result),
      };
    })
    // Gift grants are an explicit action, not a side effect of a quota read.
    .post("/accounts/:id/claim-gifts", async ({ request, params, set }) => {
      const access = requireTenantScope(accessResolver(request), "dashboard:write");
      const rows = await db
        .select()
        .from(providerAccounts)
        .where(
          and(eq(providerAccounts.id, params.id), eq(providerAccounts.tenantId, access.tenantId)),
        )
        .limit(1);
      const account = rows[0];
      if (!account) {
        set.status = 404;
        return { error: `Account ${params.id} not found`, code: "not_found" };
      }
      if (account.providerId !== ZCODE_START_PLAN_PROVIDER_ID) {
        set.status = 400;
        return {
          error: `Gift plans are only claimable for ${ZCODE_START_PLAN_PROVIDER_ID}`,
          code: "gifts_unsupported",
        };
      }
      let result: ZcodeGiftResult;
      try {
        const credential = await refreshDeps.resolveCredential(account.providerId as ProviderId, account.id);
        const fetcher = networkBindingFactory
          ? await dailyCheckinEgressForPass({ db, networkBindingFactory })(account.id, access.tenantId)
          : globalThis.fetch;
        result = await claimZcodeGifts({ accountId: account.id, credential, fetcher });
      } catch {
        set.status = 502;
        return {
          ok: false, status: 502,
          data: { id: account.id, state: "error", claimed: [], detail: "Gift claim request failed" },
          message: "Gift claim request failed", code: "gift_claim_failed",
        };
      }
      if (result.claimed.length > 0) {
        // Cold readers must not resurrect the balance from before the grant.
        await db.update(providerAccounts).set({ quotaSnapshot: null }).where(
          and(eq(providerAccounts.id, account.id), eq(providerAccounts.tenantId, access.tenantId)),
        );
        await invalidateQuotaCacheForAccount(account.id, redis);
        await snapshotInvalidator?.invalidate();
      }
      if (result.state === "error") {
        set.status = 502;
        return {
          ok: false,
          status: 502,
          data: { id: account.id, ...result },
          message: result.detail ?? "Gift claim failed",
          code: "gift_claim_failed",
        };
      }
      return {
        ok: true,
        status: 200,
        data: { id: account.id, ...result },
        message:
          result.state === "nothing"
            ? "No gift plan to claim"
            : result.state === "claimed"
              ? `Claimed ${result.claimed.join(", ")}`
              : result.state === "already_claimed"
                ? "Every gift plan was claimed before"
                : (result.detail ?? "Claim it in the ZCode app"),
      };
    })
    // Qoder daily-credits claim is likewise an explicit operator action: the
    // CREDITS campaign only surfaces with the real UMID headers, so the claim
    // mints/binds a native identity first (same store the check-in worker uses).
    .post("/accounts/:id/claim-qoder-credits", async ({ request, params, set }) => {
      const access = requireTenantScope(accessResolver(request), "dashboard:write");
      const rows = await db
        .select()
        .from(providerAccounts)
        .where(
          and(eq(providerAccounts.id, params.id), eq(providerAccounts.tenantId, access.tenantId)),
        )
        .limit(1);
      const account = rows[0];
      if (!account) {
        set.status = 404;
        return { error: `Account ${params.id} not found`, code: "not_found" };
      }
      if (!QODER_CREDIT_PROVIDER_IDS.includes(account.providerId as (typeof QODER_CREDIT_PROVIDER_IDS)[number])) {
        set.status = 400;
        return {
          error: "Daily credits are only claimable for qoder accounts",
          code: "qoder_credits_unsupported",
        };
      }
      let result: QoderCreditClaimResult;
      try {
        const credential = await refreshDeps.resolveCredential(account.providerId as ProviderId, account.id);
        const fetcher = networkBindingFactory
          ? await dailyCheckinEgressForPass({ db, networkBindingFactory })(account.id, access.tenantId)
          : globalThis.fetch;
        result = await claimQoderCredits({ db, providerId: account.providerId, accountId: account.id, credential, fetcher });
      } catch {
        set.status = 502;
        return {
          ok: false, status: 502,
          data: { id: account.id, state: "error", amount: 0, detail: "Qoder credit claim request failed" },
          message: "Qoder credit claim request failed", code: "qoder_credit_claim_failed",
        };
      }
      if (result.state === "claimed") {
        // Cold readers must not resurrect the balance from before the grant.
        await db.update(providerAccounts).set({ quotaSnapshot: null }).where(
          and(eq(providerAccounts.id, account.id), eq(providerAccounts.tenantId, access.tenantId)),
        );
        await invalidateQuotaCacheForAccount(account.id, redis);
        await snapshotInvalidator?.invalidate();
      }
      if (result.state === "error") {
        set.status = 502;
        return {
          ok: false,
          status: 502,
          data: { id: account.id, ...result },
          message: result.detail ?? "Qoder credit claim failed",
          code: "qoder_credit_claim_failed",
        };
      }
      return {
        ok: true,
        status: 200,
        data: { id: account.id, ...result },
        message:
          result.state === "nothing"
            ? "No CREDITS campaign to claim"
            : result.state === "claimed"
              ? `Claimed ${result.amount} credits`
              : "CREDITS campaign already claimed",
      };
    })
    .post("/accounts/:id/activity-report", async ({ request, params, set }) => {
      const access = requireTenantScope(accessResolver(request), "dashboard:write");
      const rows = await db
        .select()
        .from(providerAccounts)
        .where(
          and(eq(providerAccounts.id, params.id), eq(providerAccounts.tenantId, access.tenantId)),
        )
        .limit(1);
      const account = rows[0];
      if (!account) {
        set.status = 404;
        return { error: `Account ${params.id} not found`, code: "not_found" };
      }
      if (!supportsAccountCheckin(account.providerId)) {
        set.status = 400;
        return {
          error: `Activity report is not supported for provider ${account.providerId}`,
          code: "report_unsupported",
        };
      }
      // One report per account per day lights the login streak; more is
      // rate-limit bait, so the sweep's check-in day marker gates this too.
      // The marker only proves an attempt happened today — the growth event is
      // a different upstream call, but sharing the marker keeps the "one
      // growth action per day" budget honest across both buttons.
      //
      // Read through the same helper the console's own overview uses rather
      // than the Redis key directly: without Redis the marker lives in
      // `daily_checkin_ledger`, so a Redis-only read answered "not yet" for
      // every Lite deployment and let the report be re-sent all day.
      if (await todayCheckinAttempted(db, redis, account.id)) {
        return {
          ok: true,
          status: 200,
          data: { id: account.id, state: "reported", alreadyToday: true },
          message: "Report sent — login streak already lit for today",
        };
      }
      let result: BuddyActivityReportResult;
      try {
        const credential = await refreshDeps.resolveCredential(
          account.providerId as ProviderId,
          account.id,
        );
        // The growth event scores by uid, and only a JWT carries one. An
        // opaque API key must fail closed here — reporting it under another
        // account's uid would poison someone else's streak.
        // dynamic-import: B-02 lazy graph — buddy uid decoder on this buddy-only surface.
        // The buddy-oauth-shared graph is lazy-loaded: the uid decoder is only
        // needed on this buddy-only surface (B-02).
        const { buddyAccountUid } = await import(
          "../../providers/integrations/buddy/buddy-oauth-shared"
        );
        const userId = buddyAccountUid(credential);
        if (!userId) {
          set.status = 400;
          return {
            error: "Activity report needs an OAuth account (no uid in this credential)",
            code: "report_requires_oauth",
          };
        }
        result = await fetchBuddyActivityReport({
          providerId: account.providerId,
          accountId: account.id,
          credential,
          userId,
          fetcher: globalThis.fetch,
        });
      } catch (error) {
        result = {
          providerId: account.providerId,
          accountId: account.id,
          state: "error",
          error: error instanceof Error ? error.message : "Activity report failed.",
        };
      }
      if (result.state === "error") {
        set.status = 502;
        return {
          ok: false,
          status: 502,
          data: { id: account.id, state: result.state },
          message: result.error ?? "Activity report failed",
          code: "report_failed",
        };
      }
      // Same reasoning as the check-in button: the growth budget is one per
      // day across both buttons, so a report that landed stamps the marker the
      // other button reads.
      await markCheckinAttempted({ db, redis, accountId: account.id });
      return {
        ok: true,
        status: 200,
        data: { id: account.id, state: result.state, alreadyToday: false },
        message: "Report sent — login streak lit for today",
      };
    })
    .get("/accounts/:id/resets", async ({ request, params, set }) => {
      const access = requireTenantScope(accessResolver(request), "dashboard:read");
      const rows = await db
        .select()
        .from(providerAccounts)
        .where(
          and(eq(providerAccounts.id, params.id), eq(providerAccounts.tenantId, access.tenantId)),
        )
        .limit(1);
      const account = rows[0];
      if (!account) {
        set.status = 404;
        return { error: `Account ${params.id} not found`, code: "not_found" };
      }
      if (!supportsAccountReset(account.providerId)) {
        return { availableCount: 0, credits: [] };
      }
      try {
        const credential = await refreshDeps.resolveCredential(
          account.providerId as ProviderId,
          account.id,
        );
        // Cached per account for a short TTL: every dialog open was hitting the
        // upstream live. The cache is cleared on a successful redemption, so a
        // consumed credit is not shown again for the rest of the TTL.
        const list = await getCachedResetCredits(account.providerId, account.id, () =>
          listAccountResetCredits(account.providerId, credential),
        );
        return list ?? { availableCount: 0, credits: [] };
      } catch (err) {
        return { availableCount: 0, credits: [] };
      }
    })
    .post("/accounts/:id/reset", async ({ request, params, set, body }) => {
      const access = requireTenantScope(accessResolver(request), "dashboard:write");
      const rows = await db
        .select()
        .from(providerAccounts)
        .where(
          and(eq(providerAccounts.id, params.id), eq(providerAccounts.tenantId, access.tenantId)),
        )
        .limit(1);
      const account = rows[0];
      if (!account) {
        set.status = 404;
        return { error: `Account ${params.id} not found`, code: "not_found" };
      }
      if (!supportsAccountReset(account.providerId)) {
        set.status = 400;
        return {
          error: `Reset is not supported for provider ${account.providerId}`,
          code: "reset_unsupported",
        };
      }
      const reqBody = (body && typeof body === "object" ? body : {}) as { creditId?: string };
      try {
        const credential = await refreshDeps.resolveCredential(
          account.providerId as ProviderId,
          account.id,
        );
        const outcome = await consumeAccountResetCredit({
          db,
          accountId: account.id,
          providerId: account.providerId,
          credentialRaw: credential,
          creditId: reqBody.creditId,
          snapshotInvalidator,
        });
        if (!outcome.ok) {
          // A business no-op ("nothing_to_reset", "already_redeemed") is not a
          // client error: the request was well-formed and the provider answered.
          // Only a provider-side failure (4xx/5xx) carries a failure status.
          set.status = outcome.status >= 400 ? outcome.status : 200;
          return {
            ok: false,
            code: outcome.code,
            message: outcome.message ?? `Reset failed: ${outcome.code}`,
          };
        }
        if (auditRecorder) {
          await auditRecorder.record({
            access,
            action: "provider_account.recovered",
            target: account.id,
            detail: { reason: "rate_limit_reset_consumed", provider: account.providerId },
          });
        }
        return {
          ok: true,
          code: outcome.code,
          message: outcome.message ?? "Rate limit reset applied successfully",
          creditId: outcome.creditId,
        };
      } catch (err) {
        set.status = 502;
        return {
          ok: false,
          code: "reset_failed",
          message: err instanceof Error ? err.message : "Reset operation failed",
        };
      }
    });
}
