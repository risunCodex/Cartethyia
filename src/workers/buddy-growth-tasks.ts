/**
 * The buddy growth/credit tasks: one scheduled task per upstream capability.
 *
 * // dynamic-import-ok: all integration imports are lazy-loaded inside the
 * task bodies (B-02) so the boot graph never pulls the buddy/qoder
 * integration modules — these tasks run once a day, not at startup.
 *
 * Six tasks, each independently switchable through `CARTETHYIA_DISABLED_TASKS`,
 * because each is a write to an account's growth state and an operator may want
 * some of them and not others. Registration lives in `src/boot/dependencies.ts`;
 * this module owns what a tick actually does.
 *
 * Two properties hold for every task here:
 *
 * 1. **Once per account per day**, enforced by `buddy_task_ledger` — the same
 *    day-marker pattern the daily check-in uses. Inserting a row that conflicts
 *    is exactly the "already settled today" answer, so a sweep that ticks every
 *    few minutes cannot re-POST a claim.
 * 2. **A gamification failure never marks an account unhealthy.** No task here
 *    records a health failure: an endpoint that 404s or answers a business error
 *    is a display-level miss, and cooling an account over it would take working
 *    models out of rotation for a growth-page problem.
 */
import { and, eq } from "drizzle-orm";
import type { CartethyiaDatabase } from "../persistence/db-handle";
import { buddyTaskLedger, providerAccounts } from "../persistence/schema";
import { log } from "../observability/logger";
import { sleep } from "../shared/sleep";
import type {
  BuddyGrowthCall,
  BuddyGrowthResult,
} from "../providers/integrations/buddy/lifecycle";
import { withDirectFallback } from "./daily-checkin";
import { providerBaseUrl, BUDDY_PROVIDER_IDS } from "../providers/provider-metadata";
import type { FetchLike } from "../providers/quota/quota-contracts";

/** The task names an operator can switch off. */
export const BUDDY_TASK_NAMES = [
  "buddy-streak",
  "buddy-adopt",
  "buddy-activity-report",
] as const;
export type BuddyTaskName = (typeof BUDDY_TASK_NAMES)[number];

/** One account a growth task can run for. */
export interface BuddyTaskAccount {
  readonly id: string;
  readonly providerId: string;
  readonly label?: string | null;
}

export interface BuddyTaskDeps {
  readonly db: CartethyiaDatabase;
  /** Resolves the stored credential through the refresh-aware path. */
  readonly resolveCredential: (providerId: string, accountId: string) => Promise<string>;
  readonly fetcher: FetchLike;
  /** Accounts to walk; defaults to every buddy account with a credential. */
  readonly listAccounts?: () => Promise<readonly BuddyTaskAccount[]>;
  /** Injected clock so a test can advance the day. */
  readonly now?: () => Date;
  /** Pause between accounts, so a pass does not look like a burst. */
  readonly interAccountDelayMs?: number;
  /**
   * Wall-clock cap for the whole pass; the walk stops at the next account
   * boundary past it (G-04). These tasks run on their own cadence (daily /
   * six-hourly), so the budget is sized generously — it bounds a runaway scan
   * without truncating a legitimate fleet mid-pass; an account the budget
   * leaves unvisited is picked up on the next pass by its ledger.
   */
  readonly budgetMs?: number;
}

/** Providers whose growth facade is worth calling. */
function isBuddy(providerId: string): boolean {
  return BUDDY_PROVIDER_IDS.has(providerId);
}

/** The upstream's own day boundary: growth days roll at 00:00 CST. */
export function buddyDayKey(now: Date = new Date()): string {
  return new Date(now.getTime() + 8 * 3600_000).toISOString().slice(0, 10);
}

/**
 * Marks one (day, account, task) settled.
 *
 * Only ever writes a slot, never releases one — the caller is asserting "this
 * account is done with this task today", which is exactly what the row means.
 * A conflict is the ordinary case after a restart and is not an error.
 */
async function markClaimed(
  db: CartethyiaDatabase,
  dayKey: string,
  accountId: string,
  task: string,
): Promise<void> {
  try {
    await db
      .insert(buddyTaskLedger)
      .values({ dayKey, accountId, task })
      .onConflictDoNothing();
  } catch (error) {
    log.warn(`[${task}] ledger stamp failed for account=${accountId}`, error as Error);
  }
}

/** True when this (day, account, task) already has a marker. */
async function claimedToday(
  db: CartethyiaDatabase,
  dayKey: string,
  accountId: string,
  task: string,
): Promise<boolean> {
  try {
    const rows = await db
      .select({ dayKey: buddyTaskLedger.dayKey })
      .from(buddyTaskLedger)
      .where(
        and(
          eq(buddyTaskLedger.dayKey, dayKey),
          eq(buddyTaskLedger.accountId, accountId),
          eq(buddyTaskLedger.task, task),
        ),
      )
      .limit(1);
    return rows.length > 0;
  } catch {
    // Unreadable means unknown, never "not claimed": the safe answer is to try,
    // and the upstream's own idempotency is the backstop.
    return false;
  }
}
/** Every credential-bearing buddy account. */
async function defaultAccounts(db: CartethyiaDatabase): Promise<readonly BuddyTaskAccount[]> {
  const rows = await db
    .select({
      id: providerAccounts.id,
      providerId: providerAccounts.providerId,
      label: providerAccounts.label,
    })
    .from(providerAccounts)
    .where(eq(providerAccounts.status, "active"));
  return rows.filter((row) => isBuddy(row.providerId));
  }
/**
 * Reads the account uid from a JWT, memoised per credential.
 *
 * A growth pass walks many accounts, and the uid is only ever present in a
 * JWT; an opaque API key has none. Decoding the token once per account is
 * cheap, but the same credential can appear in several tasks in one pass, so
 * the decode is cached per pass instead of per call.
 */
type UidDecoder = (credential: string) => string | undefined;

function resolveUid(
  credential: string,
  cache: Map<string, string | undefined>,
  decode: UidDecoder,
): string | undefined {
  const cached = cache.get(credential);
  if (cached !== undefined) return cached;
  const uid = decode(credential);
  cache.set(credential, uid);
  return uid;
}

/** One account's task run, with the credential resolved and the call wired. */
async function forAccount(
  uidCache: Map<string, string | undefined>,
  deps: BuddyTaskDeps,
  account: BuddyTaskAccount,
  task: BuddyTaskName,
  run: (call: BuddyGrowthCall) => Promise<BuddyGrowthResult | null>,
): Promise<BuddyGrowthResult | null> {
  let credential: string;
  try {
    credential = await deps.resolveCredential(account.providerId, account.id);
  } catch (error) {
    log.warn(
      `[${task}] account=${account.id} credential unresolved:`,
      error instanceof Error ? error : new Error(String(error)),
    );
    return null;
  }
  if (credential.length === 0) return null;
  // The buddy-oauth-shared graph is lazy-loaded: the uid decoder runs once per
  // pass, and only for accounts whose credential carries a JWT (B-02).
  const { buddyAccountUid } = await import(
    "../providers/integrations/buddy/account"
  );
  const call: BuddyGrowthCall = {
    baseUrl: providerBaseUrl(account.providerId) ?? "",
    headers: { "X-Product": "SaaS", "Content-Type": "application/json", Accept: "application/json" },
    accountId: account.id,
    providerId: account.providerId,
    credential,
    fetcher: withDirectFallback(deps.fetcher) as FetchLike,
    ...(resolveUid(credential, uidCache, buddyAccountUid) === undefined
      ? {}
      : { uid: resolveUid(credential, uidCache, buddyAccountUid) }),
  };
  if (call.baseUrl.length === 0) return null;
  return run(call);
}

/** Walks the accounts, skipping any already settled today. */
async function runTask(
  deps: BuddyTaskDeps,
  task: BuddyTaskName,
  run: (call: BuddyGrowthCall) => Promise<BuddyGrowthResult | null>,
): Promise<{ readonly attempted: number; readonly claimed: number }> {
  const dayKey = buddyDayKey(deps.now?.() ?? new Date());
  const uidCache = new Map<string, string | undefined>();
  const accounts = await (deps.listAccounts?.() ?? defaultAccounts(deps.db));
  let attempted = 0;
  let claimed = 0;
  const delay = deps.interAccountDelayMs ?? 0;
  const startedAt = Date.now();
  const budgetMs = deps.budgetMs;
  for (const [index, account] of accounts.entries()) {
    if (budgetMs !== undefined && Date.now() - startedAt >= budgetMs) {
      log.info(
        `[${task}] pass budget reached: stopped after ${attempted} attempted / ${index} accounts walked`,
      );
      break;
    }
    if (index > 0 && delay > 0) await sleep(delay);
    if (await claimedToday(deps.db, dayKey, account.id, task)) continue;
    attempted += 1;
    let result: BuddyGrowthResult | null = null;
    try {
      result = await forAccount(uidCache, deps, account, task, run);
    } catch (error) {
      log.warn(
        `[${task}] account=${account.id} failed:`,
        error instanceof Error ? error : new Error(String(error)),
      );
    }
    if (result !== null) {
      log.info(
        `[${task}] account=${account.id} provider=${account.providerId} state=${result.state}` +
          `${result.credit !== null ? ` credit=${result.credit}` : ""}` +
          `${result.error !== null ? ` detail=${result.error}` : ""}`,
      );
      if (result.state === "claimed" || result.state === "already") claimed += 1;
    }
    // Marked whether it landed or not: a repeat write the same day can only
    // produce the duplicate answer, and not marking would re-POST it forever.
    await markClaimed(deps.db, dayKey, account.id, task);
  }
  return { attempted, claimed };
}

// ---------------------------------------------------------------------------
// The six tasks
// ---------------------------------------------------------------------------

/**
 * Streak makeup: spend a card on yesterday's miss so the streak does not break.
 *
 * Everything other than an actual spend is `skipped`, so an account with no
 * miss, no card, or no heatmap produces no log noise beyond one info line.
 */
export async function buddyStreakTask(deps: BuddyTaskDeps) {
  // The buddy-growth-shared graph is lazy-loaded: this task only runs once a
  // day, and must not pull the integration into the boot graph (B-02).
  const { useBuddyMakeupCard } = await import(
    "../providers/integrations/buddy/lifecycle"
  );
  return runTask(deps, "buddy-streak", (call) => useBuddyMakeupCard(call));
}

/**
 * First-buddy adoption: accept the agreement, then adopt.
 *
 * Gated on the task actually being offered and unlocked — adopting blind writes
 * to an account's growth state on the strength of an endpoint existing.
 */
export async function buddyAdoptTask(deps: BuddyTaskDeps) {
  // The buddy-growth-shared graph is lazy-loaded: this task only runs once a
  // day, and must not pull the integration into the boot graph (B-02).
  const {
    adoptFirstBuddy,
    agreeBuddyAgreement,
    readBuddyFirstTask,
    readBuddyInfo,
  } = await import("../providers/integrations/buddy/lifecycle");
  return runTask(deps, "buddy-adopt", async (call) => {
    const info = await readBuddyInfo(call);
    if (info === null || info.hasBuddy) return null;
    const task = await readBuddyFirstTask(call);
    if (task === null) return null;
    const agreed = await agreeBuddyAgreement(call);
    // Only a hard error stops the sequence; a duplicate agreement is fine.
    if (agreed.state === "error") return agreed;
    return adoptFirstBuddy(call);
  });
}

/**
 * Growth-activity report: the `/v2/report` batch that lights the login streak and
 * scores the daily growth event.
 *
 * It is a once-a-day task with its own ledger, gated by the same
 * (day, account, task) ledger as every other growth task: running it on the
 * quota sweep would post two rounds of four events per account per sweep, and
 * the sweep runs every minute.
 *
 * The report is not a credit claim, so its failure never marks an account
 * unhealthy — the result is logged and the ledger is stamped either way.
 */
export async function buddyActivityReportTask(deps: BuddyTaskDeps) {
  // The buddy-checkin graph is lazy-loaded: this task only runs once a day,
  // and must not pull the integration into the boot graph (B-02).
  const { fetchBuddyActivityReport } = await import(
    "../providers/integrations/buddy/lifecycle"
  );
  return runTask(deps, "buddy-activity-report", async (call) => {
    if (call.uid === undefined) {
      return { state: "skipped", error: "No uid in this credential.", credit: null };
    }
    const report = await fetchBuddyActivityReport({
      providerId: call.providerId,
      accountId: call.accountId,
      credential: call.credential,
      userId: call.uid,
      fetcher: call.fetcher,
    });
    if (report.state === "reported") return { state: "claimed", error: null, credit: null };
    if (report.state === "unavailable") return { state: "already", error: null, credit: null };
    return { state: "skipped", error: report.error, credit: null };
  });
}

// ---------------------------------------------------------------------------
// Usage sync: the real credit deductions, stored
// ---------------------------------------------------------------------------

/** Days of usage detail to read. The upstream's own window is 30. */
const USAGE_DAYS = 30;

/**
 * Reads and stores every buddy account's real credit deductions.
 *
 * Not a growth task — it is a read — but it shares the walk and the credential
 * resolution, and it is what gives the console a usage figure the upstream
 * actually reported.
 */
export async function syncBuddyUsage(deps: BuddyTaskDeps): Promise<number> {
  const accounts = await (deps.listAccounts?.() ?? defaultAccounts(deps.db));
  let stored = 0;
  // The buddy usage graphs are lazy-loaded: this task runs only on its own
  // six-hourly cadence, and must not pull the integrations into the boot
  // graph (B-02).
  const { fetchBuddyRequestUsage } = await import(
    "../providers/integrations/buddy/account"
  );
  const { saveBuddyUsageSnapshots } = await import(
    "../providers/integrations/buddy/account"
  );
  const { buddyAccountUid } = await import(
    "../providers/integrations/buddy/account"
  );
  const startedAt = Date.now();
  const budgetMs = deps.budgetMs;
  for (const account of accounts) {
    if (budgetMs !== undefined && Date.now() - startedAt >= budgetMs) break;
    let credential: string;
    try {
      credential = await deps.resolveCredential(account.providerId, account.id);
    } catch {
      continue;
    }
    if (credential.length === 0) continue;
    const base = providerBaseUrl(account.providerId);
    if (base === undefined || base.length === 0) continue;
    const usage = await fetchBuddyRequestUsage({
      // The usage-detail endpoint hangs off the provider's own origin, not the
      // `/v2` chat prefix.
      url: `${base.replace(/\/+$/, "").replace(/\/v2$/, "")}/billing/meter/get-user-request-usage`,
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      credential,
      fetcher: deps.fetcher,
      days: USAGE_DAYS,
      ...(buddyAccountUid(credential) === undefined
        ? {}
        : { uid: buddyAccountUid(credential) }),
    });
    if (usage.rows.length === 0) continue;
    stored += await saveBuddyUsageSnapshots(deps.db, account.id, usage.rows);
  }
  return stored;
}
