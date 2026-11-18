/**
 * Tenant-scoped account action routes: daily growth (report + check-in),
 * manual check-in, gift/credit claims, activity report, and rate-limit
 * reset. Split from `account-quota-tenant.ts`, which keeps the quota
 * read/refresh routes and the account status/delete routes.
 */
import { t } from "elysia";
import type { Elysia } from "elysia";
import { and, eq, inArray } from "drizzle-orm";
import { providerAccounts } from "../../persistence/schema";
import { globalOrOwnedBy } from "../../persistence/tenant-scope";
import { requireTenantScope } from "../shared/errors";
import { invalidateQuotaCacheForAccount } from "../../providers/quota/cache";
import type { QuotaRefreshDeps } from "../../providers/quota/refresh";
import type { ValidatedFetch } from "../../network/egress/fetch";
import type { ProviderId } from "../../providers/provider-contracts";
import {
  checkinAttemptedToday,
  dailyCheckinEgressForPass,
  markCheckinAttempted,
} from "../../workers/daily-checkin";
import {
  fetchBuddyActivityReport,
  fetchDailyCheckin,
  type BuddyActivityReportResult,
  type DailyCheckinResult,
} from "../../providers/integrations/buddy/lifecycle";
import { claimZcodeGifts, type ZcodeGiftResult } from "../../providers/integrations/zcode-start-plan/gifts";
import { ZCODE_START_PLAN_PROVIDER_ID } from "../../providers/integrations/zcode-start-plan/provider";
import {
  claimQoderCredits,
  QODER_CREDIT_PROVIDER_IDS,
  type QoderCreditClaimResult,
} from "../../providers/integrations/qoder/claim-qoder-credits";
import {
  supportsAccountReset,
  consumeAccountResetCredit,
  getCachedResetCredits,
  listAccountResetCredits,
} from "../../providers/operations/account-reset-service";
import {
  loadAccountRow,
  supportsAccountCheckin,
  type AccountQuotaRoutesDeps,
} from "./account-quota-shared";
import {
  DAILY_GROWTH_LEG_TIMEOUT_MS,
  enqueueDailyGrowthJob,
  getDailyGrowthJob,
  withLegBudget,
  type DailyGrowthJobAccount,
  type DailyGrowthJobDeps,
} from "./daily-growth-job";

/** One account's check-in through the buddy billing facade. */
async function runAccountCheckin(
  account: { id: string; providerId: string },
  credential: string,
  forceClaim: boolean,
): Promise<DailyCheckinResult> {
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
  // fails closed instead of reporting under another account's identity.
  // dynamic-import: B-02 lazy graph — buddy uid decoder, only for buddy report legs.
  // The buddy-oauth-shared graph is lazy-loaded: the uid decoder is only
  // needed for buddy accounts' report leg (B-02).
  const { buddyAccountUid } = await import(
    "../../providers/integrations/buddy/account"
  );
  const userId = buddyAccountUid(credential);
  let report: { ok: boolean; message: string };
  if (userId === undefined || userId.length === 0) {
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
    const result = await fetchDailyCheckin({
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
 * Registers the tenant-scoped account action routes onto `app`: daily growth,
 * check-in, gift/credit claims, activity report, and rate-limit reset. Every
 * route authorises through `requireTenantScope`, so the caller only ever
 * touches its own tenant's accounts.
 */
export function registerAccountGrowthTenantRoutes(
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
    networkBindingFactory,
  } = deps;
  app
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
    const account = await loadAccountRow(db, params.id, access.tenantId);
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
      result = await runAccountCheckin(account, credential, true);
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
    const account = await loadAccountRow(db, params.id, access.tenantId);
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
  // Qoder daily-credits claim is an explicit operator action: the CREDITS
  // campaign only surfaces with the real UMID headers, so the claim mints/binds
  // a native identity first (same store the check-in worker uses).
  .post("/accounts/:id/claim-qoder-credits", async ({ request, params, set }) => {
    const access = requireTenantScope(accessResolver(request), "dashboard:write");
    const account = await loadAccountRow(db, params.id, access.tenantId);
    if (!account) {
      set.status = 404;
      return { error: `Account ${params.id} not found`, code: "not_found" };
    }
    if (!QODER_CREDIT_PROVIDER_IDS.includes(account.providerId)) {
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
        ok: false,
        status: 502,
        data: { id: account.id, state: "error", amount: 0, detail: "Qoder credit claim request failed" },
        message: "Qoder credit claim request failed",
        code: "qoder_credit_claim_failed",
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
    const account = await loadAccountRow(db, params.id, access.tenantId);
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
        "../../providers/integrations/buddy/account"
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
    const account = await loadAccountRow(db, params.id, access.tenantId);
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
    const account = await loadAccountRow(db, params.id, access.tenantId);
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
