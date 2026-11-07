// Periodic quota sweep: keeps every account's cached quota warm so opening the
// Quota page is a cache read instead of a cold upstream fan-out.
//
// This is the piece that makes the page feel instant. Without it the only
// refreshes are the ones a user triggers, which means the first open after a
// cache expiry always blocks on the provider.
//
// It also carries the daily check-in ride-along: each account this sweep
// refreshes gets its once-per-day credit grant claimed in the same pass
// (`attemptDailyGrowthPass`), because both need the same freshly resolved
// credential and a second timer would duplicate that work.
import { log } from "../observability/logger";
import {
  QUOTA_REFRESH_TIMEOUT_MS,
  listQuotaRefreshTargets,
  refreshAccountQuota,
  signalFetch,
  targetLens,
  type QuotaRefreshDeps,
  type QuotaRefreshOutcome,
  type QuotaRefreshTarget,
} from "../providers/quota/refresh";
import {
  cachedQuotaAgeMs,
  getCachedQuotaEntries,
  type CachedQuotaEntry,
} from "../providers/quota/cache";
import { runSweep } from "./sweep-runner";
import type { ValidatedFetch } from "../network/outbound-fetch";
import type { ProviderId } from "../providers/provider-contracts";
import {
  attemptDailyGrowthPass,
  checkinDayKey,
  dequeueCheckin,
  pendingCheckinRequests,
  supportsDailyCheckin,
  releaseDaySlotsBatch,
  type DailyCheckinResult,
  type PendingCheckinRequest,
} from "./daily-checkin";

export interface QuotaRefreshSweepDeps extends QuotaRefreshDeps {
  /** Lists credential-bearing accounts; the default excludes credential-less rows. */
  readonly listTargets?: () => Promise<readonly QuotaRefreshTarget[]>;
  /** Maximum accounts in one completed wave. Defaults to 5. */
  readonly maxConcurrency?: number;
  /** Per-account credential cache for this sweep pass, keyed by account id. */
  readonly credentialCache?: Map<string, string>;
  /** Skip accounts whose cached value is younger than this. Defaults to 4 min. */
  readonly minAgeMs?: number;
  /** Cap on accounts attempted per pass, so one pass cannot run unbounded. Defaults to 40. */
  readonly maxPerPass?: number;
  /** Cap on the whole pass; remaining accounts are picked up next tick. Defaults to 90s. */
  readonly passBudgetMs?: number;
  /** Bounded per-pass cap on daily check-ins; `0` disables the ride-along. */
  readonly maxCheckinsPerPass?: number;
  /** Injectable fetch for the check-in ride-along (tests). */
  readonly checkinFetcher?: typeof fetch;
  /**
   * Accounts a caller outside the sweep asked to check in — a newly imported
   * buddy account, whose import deliberately made no upstream call. Defaults to
   * the module queue `enqueueCheckin` writes; injected in tests.
   */
  readonly listPendingCheckins?: () => readonly PendingCheckinRequest[];
  /**
   * Builds the fetch the check-in ride-along uses for one account.
   *
   * The sweep passes this down so the check-in can rotate egress per account
   * (a different proxy per account when pools are available) instead of
   * sharing one direct `globalThis.fetch` for every account. Absent means
   * direct egress, which is what `attemptDailyGrowthPass` already does.
   */
  readonly checkinFetcherFor?: (
    accountId: string,
    tenantId?: string | null,
  ) => ValidatedFetch | Promise<ValidatedFetch>;
  readonly now?: () => number;
  readonly onTick?: (result: {
    readonly targets: number;
    readonly attempted: number;
    readonly skipped: number;
    readonly failed: number;
    /** Daily check-ins attempted in this pass. */
    readonly checkins: number;
  }) => void;
}
const DEFAULT_MAX_CHECKINS_PER_PASS = 10;

/**
 * Whether this account may take a daily check-in slot in the current pass.
 *
 * The provider filter is applied *before* the slot count is consulted, and
 * that ordering is the whole point of the function: the sweep's batch is
 * oldest-first across every provider, so a cap checked first is spent on
 * non-buddy accounts the ride-along would skip anyway. A buddy account sitting
 * behind them (a `cbcn` row past the tenth older non-buddy row) then never gets
 * its automatic check-in — only a manual press, which bypasses the cap, ever
 * reaches it.
 */
function checkinSlotAvailable(
  providerId: string,
  checkinsSoFar: number,
  maxCheckins: number,
): boolean {
  if (!supportsDailyCheckin(providerId)) return false;
  return maxCheckins > 0 && checkinsSoFar < maxCheckins;
}

/**
 * Last line emitted per account. The sweep runs every minute over dozens of
 * accounts, and most outcomes ("quota ok, daily already claimed") repeat
 * verbatim every pass — printing them all buries the one line that matters.
 * An account is re-announced only when its outcome actually changes.
 *
 * Module scope, not per-call: suppression must survive across passes, and one
 * `quotaRefreshSweep` call is one pass. Bounded because it is keyed by account
 * id and is never pruned, so an account deleted years ago still holds an entry;
 * the oldest keys are the ones least likely to be announced again.
 */
const LAST_SWEEP_LINE_MAX = 512;
const lastSweepLine = new Map<string, string>();

/** Drops the oldest entries once the suppression map reaches its cap. */
function trimLastSweepLine(): void {
  if (lastSweepLine.size <= LAST_SWEEP_LINE_MAX) return;
  const excess = lastSweepLine.size - LAST_SWEEP_LINE_MAX;
  let dropped = 0;
  for (const key of lastSweepLine.keys()) {
    if (dropped >= excess) break;
    lastSweepLine.delete(key);
    dropped += 1;
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One candidate the sweep considers: the target plus its cache age. */
type SweepEntry = { target: QuotaRefreshTarget; ageMs: number };

/**
 * Selects the batch for one pass: eligible (due or queued) accounts first,
 * buddy accounts pulled ahead of age ordering so the check-in ride-along is
 * not starved by older non-buddy rows, capped at `maxPerPass`.
 */
function selectBatch(
  entries: readonly SweepEntry[],
  minAgeMs: number,
  maxPerPass: number,
  listPendingCheckins: () => readonly PendingCheckinRequest[],
): { batch: SweepEntry[]; skipped: number } {
  // An account added since the last pass is admitted regardless of cache
  // age: it has no quota reading at all yet, so the normal freshness gate
  // would make a brand-new buddy account wait a full sweep cycle before it
  // could claim its credit — the import enqueued it precisely so it would
  // not have to. Only the check-in needs this; the quota leg is happy to
  // fill a cold cache the moment it is asked to.
  const queued = new Set(
    listPendingCheckins()
      .filter((request) => supportsDailyCheckin(request.providerId))
      .map((request) => request.accountId),
  );
  const due = entries.filter(
    (entry) => entry.ageMs >= minAgeMs || queued.has(entry.target.accountId),
  );
  due.sort((left, right) => {
    const leftQueued = queued.has(left.target.accountId) ? 0 : 1;
    const rightQueued = queued.has(right.target.accountId) ? 0 : 1;
    if (leftQueued !== rightQueued) return leftQueued - rightQueued;
    const leftBuddy = supportsDailyCheckin(left.target.providerId) ? 0 : 1;
    const rightBuddy = supportsDailyCheckin(right.target.providerId) ? 0 : 1;
    if (leftBuddy !== rightBuddy) return leftBuddy - rightBuddy;
    return right.ageMs - left.ageMs;
  });
  const batch = due.slice(0, maxPerPass);
  return { batch, skipped: entries.length - due.length + (due.length - batch.length) };
}

/**
 * Runs the daily check-in ride-along for one batch item: claims its slot
 * before the first await (the wave runs concurrently, so the count read after
 * resolution would let the whole wave through), then attempts the growth pass
 * and records the outcome. Bounded by the per-pass cap.
 */
async function runCheckinRideAlong(
  deps: QuotaRefreshSweepDeps,
  entry: SweepEntry,
  resolveCredentialCached: (providerId: ProviderId, accountId: string) => Promise<string>,
  state: { checkins: number; claimed: number; maxCheckins: number },
  checkinOutcomes: Map<string, DailyCheckinResult>,
): Promise<void> {
  // The provider filter comes *before* the slot is consumed. The batch is
  // oldest-first across every provider, so checking the cap first spends the
  // whole per-pass budget on non-buddy accounts that the next line would
  // skip anyway — a buddy account past the cap (a cbcn row behind ten older
  // non-buddy rows) is never checked in automatically, only when an operator
  // presses the button, which bypasses this cap entirely.
  if (!checkinSlotAvailable(entry.target.providerId, state.checkins, state.maxCheckins)) return;
  // Claim the slot before the first await. The wave runs its items
  // concurrently, and reading `checkins` only after the growth pass
  // resolves lets every item in the wave pass the cap check against the
  // same stale count — the cap then bounds nothing.
  state.checkins += 1;
  try {
    // A `ValidatedFetch` shares the fetch call signature; the only
    // difference is Bun's `preconnect` static, so a single assertion is
    // enough (the double cast added nothing).
    const pooled: typeof fetch | undefined = deps.checkinFetcherFor
      ? ((await deps.checkinFetcherFor(
          entry.target.accountId,
          entry.target.tenantId,
        )) as typeof fetch)
      : undefined;
    const fetcher = pooled ?? deps.checkinFetcher;
    const pass = await attemptDailyGrowthPass({
      db: deps.db,
      redis: deps.redis,
      providerId: entry.target.providerId as ProviderId,
      accountId: entry.target.accountId,
      resolveCredential: resolveCredentialCached,
      ...(fetcher ? { fetcher } : {}),
    });
    // The request has been served: the pass either ran and wrote its own
    // day marker, or declined because today's slot was already settled.
    // Holding the entry would only make the next pass re-admit an account
    // it just handled.
    dequeueCheckin(entry.target.accountId);
    if (pass !== null) {
      if (pass.checkin.state === "claimed") state.claimed += 1;
      checkinOutcomes.set(entry.target.accountId, pass.checkin);
    }
  } catch (error) {
    checkinOutcomes.set(entry.target.accountId, {
      providerId: entry.target.providerId,
      accountId: entry.target.accountId,
      state: "error",
      credit: null,
      streakDays: null,
      error: getErrorMessage(error),
    });
  }
}

/** `provider/identity` — the account's own label, else its id. */
function accountName(target: QuotaRefreshTarget): string {
  const label = (target.label ?? "").trim();
  return `${target.providerId}/${label.length > 0 ? label : target.accountId}`;
}

/** Human-readable quota result. */
function quotaPhrase(outcome: QuotaRefreshOutcome): string {
  const error = outcome.quota.error;
  if (error === null) {
    const window = outcome.quota.windows.find((w) => w.usedPercent !== null);
    return window === undefined
      ? "quota ok"
      : `quota ok (${window.label} ${Math.round(window.usedPercent as number)}% used)`;
  }
  return `quota failed: ${error}`;
}

/**
 * Daily check-in outcome for the log line, or `null` when this account has
 * nothing to report.
 *
 * Only providers that expose the check-in route appear here at all: the sweep
 * skips the rest, and `daily unsupported` on every non-CodeBuddy account is
 * pure noise. The routine "nothing to claim today" states collapse to one
 * short phrase so the line stays scannable; only a real grant or a failure
 * carries detail.
 */
function checkinPhrase(result: DailyCheckinResult | undefined): string | null {
  if (result === undefined) return null;
  let phrase: string;
  switch (result.state) {
    case "claimed": {
      const credit = result.credit !== null ? ` +${result.credit}` : "";
      const streak = result.streakDays !== null ? ` (streak ${result.streakDays})` : "";
      phrase = `daily claimed${credit}${streak}`;
      break;
    }
    case "already_claimed":
      phrase = "daily ok";
      break;
    case "not_eligible":
      phrase = "daily not eligible";
      break;
    case "event_ended":
      phrase = "daily ended";
      break;
    case "unavailable":
      phrase = "daily unavailable";
      break;
    case "error":
      phrase = `daily failed: ${result.error ?? "unknown error"}`;
      break;
  }
  return phrase;
}

/**
 * Emits one line per attempted account, then a single pass summary when
 * anything needs attention. Level is `info` so the line survives the
 * production `LOG_LEVEL` (a `debug` sweep line is invisible in the console).
 */
function logSweepAccounts(
  attempted: readonly QuotaRefreshTarget[],
  quotaOutcomes: ReadonlyMap<string, QuotaRefreshOutcome>,
  checkinOutcomes: ReadonlyMap<string, DailyCheckinResult>,
  failed: number,
  claimed: number,
): void {
  for (const target of attempted) {
    const outcome = quotaOutcomes.get(target.accountId);
    if (outcome === undefined) continue;
    const result = checkinOutcomes.get(target.accountId);
    const parts = [quotaPhrase(outcome)];
    const checkin = checkinPhrase(result);
    if (checkin !== null) parts.push(checkin);
    const line = `${accountName(target)} ${parts.join(", ")}`;

    if (lastSweepLine.get(target.accountId) === line) continue;
    lastSweepLine.set(target.accountId, line);
    trimLastSweepLine();

    // A failed quota fetch or a failed check-in is operator-actionable.
    if (outcome.failure !== null || result?.state === "error") {
      log.warn(`[Quota-refresh] ${line}`);
    } else {
      log.info(`[Quota-refresh] ${line}`);
    }
  }

  // Only the interesting passes get a summary: an all-green pass that changed
  // nothing is already fully described by the lines above.
  if (failed > 0 || claimed > 0) {
    log.info(
      `[Quota-refresh] pass done: ${attempted.length} attempted, ${failed} quota failed, ${claimed} daily claimed`,
    );
  }
}

/**
 * How stale a cached quota reading must be before it is refreshed again.
 *
 * Half the cache TTL. The sweep runs every 60 s, so a 4 min threshold refreshes
 * every account roughly three times per 15 min TTL window — two of those three
 * passes hit the provider and learn nothing the cache did not already know.
 * 8 min is still comfortably inside the TTL, so a reading never goes stale
 * while it waits.
 */
const DEFAULT_MIN_AGE_MS = 8 * 60_000;
const DEFAULT_MAX_PER_PASS = 40;
const DEFAULT_PASS_BUDGET_MS = 90_000;

/**
 * One non-overlapping quota sweep. Never rejects out of the timer path: the
 * task registry treats a rejection as a backstop, not a channel, so every
 * failure here is isolated and counted.
 *
 * Ordering is by cache age (oldest first). Eligible accounts run in completed
 * waves of 2, then 3, then 4, then 5 (or the configured maximum); the next
 * wave does not start until the previous wave has fully settled.
 */
export async function quotaRefreshSweep(deps: QuotaRefreshSweepDeps): Promise<void> {
  const now = deps.now ?? Date.now;
  const minAgeMs = deps.minAgeMs ?? DEFAULT_MIN_AGE_MS;
  const maxPerPass = Math.max(1, deps.maxPerPass ?? DEFAULT_MAX_PER_PASS);
  // Reuse a credential between quota refresh and check-in within this pass,
  // but resolve it again next pass so OAuth refreshes and credential edits
  // are observed and secrets are not retained in a process-wide cache.
  const credentialCache = deps.credentialCache ?? new Map<string, string>();
  const listPendingCheckins = deps.listPendingCheckins ?? pendingCheckinRequests;
  const resolveCredentialCached = async (
    providerId: ProviderId,
    accountId: string,
  ): Promise<string> => {
    const cached = credentialCache.get(accountId);
    if (cached !== undefined) return cached;
    const secret = await deps.resolveCredential(providerId, accountId);
    credentialCache.set(accountId, secret);
    return secret;
  };

  let failed = 0;
  const maxCheckins = deps.maxCheckinsPerPass ?? DEFAULT_MAX_CHECKINS_PER_PASS;
  // The ride-along mutates this shared object (not local copies), so its
  // counters stay visible to the summary and the tick report after the wave.
  const checkinState = { checkins: 0, claimed: 0, maxCheckins };

  /**
   * One log line per account, emitted after the wave completes so the quota
   * result and the check-in ride-along land together instead of as two
   */
  const quotaOutcomes = new Map<string, QuotaRefreshOutcome>();
  const checkinOutcomes = new Map<string, DailyCheckinResult>();
  const attemptedTargets: QuotaRefreshTarget[] = [];
  const result = await runSweep<{ target: QuotaRefreshTarget; ageMs: number }>({
    name: "quota-refresh",
    list: async () => {
      const targets = deps.listTargets
        ? await deps.listTargets()
        : await listQuotaRefreshTargets(deps.db);
      // Read cache ages in one batched pass per lens: the sweep runs over
      // dozens of accounts each minute, so a `get` per account makes the age
      // scan's latency scale with the account count. `getCachedQuotaEntries`
      // is the cache's own batched reader, so the key format stays owned by
      // the cache module.
      const byLens = new Map<string, QuotaRefreshTarget[]>();
      for (const target of targets) {
        const lens = targetLens(target);
        const group = byLens.get(lens);
        if (group) group.push(target);
        else byLens.set(lens, [target]);
      }
      const cachedByAccount = new Map<string, CachedQuotaEntry | null>();
      for (const [lens, group] of byLens) {
        try {
          const entries = await getCachedQuotaEntries(
            lens,
            group.map((target) => target.accountId),
            deps.redis,
          );
          for (const target of group) {
            cachedByAccount.set(target.accountId, entries.get(target.accountId) ?? null);
          }
        } catch {
          // An unreadable cache reads as "due" for every account in the lens,
          // which is the safe direction.
          for (const target of group) cachedByAccount.set(target.accountId, null);
        }
      }
      const nowMs = now();
      return targets.map((target) => {
        const cached = cachedByAccount.get(target.accountId) ?? null;
        return {
          target,
          ageMs: cachedQuotaAgeMs(cached, nowMs),
        };
      });
    },
    eligible: async (entry) => {
      // Collectorless providers intentionally have no quota surface; do not
      // turn their key-only accounts into recurring quota failures.
      try {
        const collector = await deps.providerRegistry.resolveQuotaCollector(entry.target.providerId);
        if (collector === undefined) return false;
      } catch {
        return false;
      }
      // API-key/JWT accounts use the stored credential directly; OAuth
      // accounts need a provider refresher before their quota can be read.
      if (entry.target.credentialKind === "api_key") return true;
      try {
        return (await deps.providerRegistry.resolveRefresher(entry.target.providerId)) !== undefined;
      } catch {
        return false;
      }
    },
    // Oldest first, capped so one pass cannot run unbounded. Fresh accounts
    // are dropped as skips rather than carried into the wave.
    //
    // Buddy accounts are pulled to the front, ahead of the age ordering. The
    // check-in ride-along has its own per-pass cap and the waves run
    // concurrently, so a buddy account buried behind older non-buddy rows
    // could lose the race for a slot entirely — its attendance then only
    // happened when an operator pressed the button. Attendance is once a day
    // and quota is refreshed every pass, so letting the check-in go first
    // costs the quota leg nothing.
    select: (entries) => selectBatch(entries, minAgeMs, maxPerPass, listPendingCheckins),
    run: async (entry) => {
      attemptedTargets.push(entry.target);
      const outcome = await refreshAccountQuota(
        // The sweep already resolved this account's credential for the
        // check-in leg; hand the quota leg the same cached resolver so one
        // account costs one resolution per pass, not two (W3).
        { ...deps, resolveCredential: resolveCredentialCached },
        entry.target,
        signalFetch(AbortSignal.timeout(QUOTA_REFRESH_TIMEOUT_MS)),
      );
      quotaOutcomes.set(entry.target.accountId, outcome);
      // A fetch that threw is still a failure the operator must see, so it is
      // recorded as one rather than silently counted.
      if (outcome.failure !== null) {
        failed += 1;
        // The check-in ride-along still runs: the daily credit grant is the
        // *remedy* for an account that just reported an exhausted or unreadable
        // quota, and it is a different upstream call that does not depend on the
        // quota leg. Returning here leaves an account sitting at 0 credits — the
        // one that most needs the grant — with no check-in attempted, so the
        // Quota page reads "Check-in due" while the sweep believes it has done
        // its job. Only a credential we could not resolve at all rules the
        // check-in out; that is the one input both legs share.
        if (outcome.failure === "missing_credential") return;
      }
      // Daily growth ride-along: the same item's freshly resolved credential,
      // growth-activity report first and then the check-in claim (see
      // `attemptDailyGrowthPass`). Bounded per pass, and skipped for providers
      // without the billing route — a day marker makes this a no-op on every
      // pass after the first of the day.
      await runCheckinRideAlong(
        deps,
        entry,
        resolveCredentialCached,
        checkinState,
        checkinOutcomes,
      );
    },
    onItemError: (entry, error) => {
      failed += 1;
      quotaOutcomes.set(entry.target.accountId, {
        quota: {
          source: entry.target.providerId,
          plan: null,
          windows: [],
          error: getErrorMessage(error),
        },
        failure: "quota_fetch_failed",
      });
    },
    maxConcurrency: deps.maxConcurrency,
    budgetMs: deps.passBudgetMs ?? DEFAULT_PASS_BUDGET_MS,
    now,
  });

  logSweepAccounts(attemptedTargets, quotaOutcomes, checkinOutcomes, failed, checkinState.claimed);

  // Release the slots for the accounts whose check-in errored, in one
  // round-trip. Releasing inline per account makes a pass that budgets out with
  // twenty failures pay twenty Redis round-trips for bookkeeping that has no
  // bearing on the claim itself.
  const releasedAccountIds: string[] = [];
  for (const outcome of checkinOutcomes.values()) {
    if (outcome.state === "error") releasedAccountIds.push(outcome.accountId);
  }
  if (releasedAccountIds.length > 0) {
    await releaseDaySlotsBatch(deps.db, deps.redis, checkinDayKey(), releasedAccountIds);
  }
  // A pass that could not even list its targets reports no tick: an all-zero
  // tick would read as "nothing was due" rather than "nothing was reachable".
  if (result.aborted) return;
  deps.onTick?.({
    targets: result.listed,
    attempted: result.attempted,
    skipped: result.skipped,
    failed,
    checkins: checkinState.checkins,
  });
}
