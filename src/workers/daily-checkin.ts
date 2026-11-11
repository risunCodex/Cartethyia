// Daily check-in ride-along.
//
// dynamic-import-ok: the qoder/buddy check-in imports are lazy-loaded
// inside the account loop (B-02) so the boot graph stays clean — this runs
// as a ride-along with the quota sweep, not at startup.
//
// CodeBuddy grants a free credit package once per calendar day. This
// claims it for every stored account and logs one line per account, so an
// operator can confirm each account got its daily login credit.
//
// It deliberately has no timer of its own: it rides along with the quota
// refresh sweep (`quota-refresh-sweep.ts`), which already resolves a fresh
// credential for each account every few minutes. Adding a second scheduled
// task would just duplicate that credential work for a once-a-day action.
//
// Budget is one attempt per account per day. A Redis day marker reserves the
// right to attempt, so a restart cannot double-post; the marker is released
// again when the attempt errors, so a transient failure retries on a later
// pass instead of forfeiting that day's grant.
//

import { and, eq, inArray } from "drizzle-orm";
import type { ValidatedFetch } from "../network/egress/fetch";
import type { ValidatedNetworkBindingFactory } from "../network/egress/factory";
import type { RedisClient } from "../persistence/redis";
import type { CartethyiaDatabase } from "../persistence/db-handle";
import { dailyCheckinLedger, networkPools } from "../persistence/schema";
import type { ProviderId } from "../providers/provider-contracts";
import { log } from "../observability/logger";
import type { DailyCheckinResult } from "../providers/integrations/buddy/buddy-checkin";
import { BUDDY_PROVIDER_IDS } from "../providers/provider-metadata";

export type { DailyCheckinResult };

/**
 * Calendar-day key in UTC, matching the provider's own day boundary.
 *
 * Mirrors `buddy-checkin.ts`'s `checkinDayKey` (a pure two-line util). Kept
 * local so this worker module does not statically import the heavy buddy-checkin
 * graph just for a date key (B-02).
 */
export function checkinDayKey(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * The Buddy and Qoder providers the daily check-in claims a credit for.
 *
 * Derived from the shared buddy family set plus the Qoder check-in list, the
 * same shape as `buddy-checkin.ts`'s `DAILY_CHECKIN_PROVIDER_IDS`. Kept local
 * so this worker module does not statically import the heavy buddy/qoder
 * graphs for a constant id list (B-02).
 */
const QODER_CHECKIN_PROVIDER_IDS: readonly string[] = ["qoder", "qodercn"];
export const DAILY_CHECKIN_PROVIDER_IDS: readonly string[] = [
  ...BUDDY_PROVIDER_IDS,
  ...QODER_CHECKIN_PROVIDER_IDS,
];

/**
 * Pending check-in requests handed to the sweep by a caller outside it.
 *
 * A newly imported account is the reason this exists: the import path is
 * deliberately free of upstream calls so a paste of forty credentials lands as
 * one local write, and the credit claim therefore has to happen later. Rather
 * than giving it a second timer — which would duplicate the credential
 * resolution the quota sweep already does — the import enqueues here and the
 * sweep drains this on its next pass.
 *
 * Bounded: an import bigger than the cap drops the excess instead of growing
 * without limit, because every entry is still subject to the day marker and a
 * later pass picks the account up anyway. This queue is a nudge, not a
 * guarantee — it says "worth trying on the next pass", never "must run".
 */
const QUEUE_MAX = 200;
const checkinQueue = new Map<string, PendingCheckinRequest>();

/** One account a caller asked the sweep to consider for a check-in. */
export interface PendingCheckinRequest {
  readonly accountId: string;
  readonly providerId: string;
  readonly tenantId: string | null;
}

/** Accounts a caller has asked the sweep to check in, oldest request first. */
export function pendingCheckinRequests(): readonly PendingCheckinRequest[] {
  return [...checkinQueue.values()];
}

/** Number of accounts currently waiting. Bounded by `QUEUE_MAX`. */
export function pendingCheckinCount(): number {
  return checkinQueue.size;
}

/** Drops every queued request. Tests only. */
export function clearPendingCheckinRequests(): void {
  checkinQueue.clear();
}

/**
 * Queues a check-in for a newly added account.
 *
 * Non-blocking by construction: it records the id and returns, so an import
 * that adds a hundred accounts still answers as one local write. Returns
 * `false` for an account the check-in cannot serve at all (wrong provider, or
 * a queue already at its cap) so the caller can skip the work rather than
 * enqueue something the sweep would silently drop.
 */
export function enqueueCheckin(request: PendingCheckinRequest): boolean {
  if (!supportsDailyCheckin(request.providerId)) return false;
  // Already queued: keep the original position rather than re-inserting, which
  // in a Map would move it to the back and let a repeated import starve it.
  if (checkinQueue.has(request.accountId)) return true;
  // Oldest requests drain first, so a bounded queue drops the newest rather
  // than the ones that have already waited a pass. A dropped request is not a
  // lost check-in: the sweep reaches the account through its normal listing.
  if (checkinQueue.size >= QUEUE_MAX) return false;
  checkinQueue.set(request.accountId, request);
  return true;
}

/** Removes one account's queued request once the sweep has acted on it. */
export function dequeueCheckin(accountId: string): void {
  checkinQueue.delete(accountId);
}

const LEDGER_KEY_PREFIX = "cartethyia:daily-checkin";
/**
 * Ledger TTL. The key is already scoped to one calendar day, so the TTL only
 * needs to outlive that day; three days covers any timezone/clock skew without
 * relying on the key expiring for correctness.
 */
const LEDGER_TTL_SECONDS = 3 * 24 * 60 * 60;

/** The day-marker key for one account. Exported so the console reads the same key the sweep writes. */
export function ledgerKey(dayKey: string, accountId: string): string {
  return `${LEDGER_KEY_PREFIX}:${dayKey}:${accountId}`;
}

/**
 * True when this pass won the account's day slot and must do the work.
 *
 * Two guards, because the deployment shape decides which one is authoritative.
 * With Redis the `SET NX EX` is the cross-process guard (two gateway instances
 * cannot both attempt the same account). Without it the ledger *table* is the
 * guard, and its composite PK makes the insert atomic — so Lite records the
 * attempt it just made instead of silently returning `true`, which leaves the
 * console unable to answer "attempted today" and shows "Check-in due" forever.
 */
async function reserveDaySlot(
  db: CartethyiaDatabase | undefined,
  redis: RedisClient | undefined,
  dayKey: string,
  accountId: string,
): Promise<boolean> {
  if (redis === undefined) {
    if (db === undefined) {
      // No ledger at all: one process needs no distributed guard, so the slot is
      // always won and the sweep's once-a-day cadence is the only throttle.
      return true;
    }
    // A handle without a query builder (the SQLite lite backend wraps its own)
    // cannot write the ledger. Fall back to "always won" rather than throwing:
    // the day marker is bookkeeping, and losing it costs a possible duplicate
    // claim tomorrow instead of forfeiting today's grant.
    if (typeof db.insert !== "function") return true;
    try {
      const inserted = await db
        .insert(dailyCheckinLedger)
        .values({ dayKey, accountId })
        .onConflictDoNothing()
        .returning({ accountId: dailyCheckinLedger.accountId });
      return inserted.length > 0;
    } catch (error) {
      log.warn(`[daily-checkin] ledger reserve failed for account=${accountId}`, error as Error);
      return true;
    }
  }
  const set = await redis.set(ledgerKey(dayKey, accountId), "1", "EX", LEDGER_TTL_SECONDS, "NX");
  return set !== null;
}
/**
 * Releases today's slot for many accounts in one round-trip.
 *
 * The sweep reserves a slot per account as it walks the wave; releasing them
 * one at a time on the error path turns every failed pass into a Redis RTT per
 * failed account. A pass that budgets out with twenty failures pays twenty
 * round-trips for bookkeeping that has no bearing on the claim itself.
 *
 * A pipeline is used when Redis is present (one `MULTI/DEL` for the whole
 * batch). The DB path issues one `DELETE ... WHERE (day_key, account_id) IN (...)`
 * instead of N single deletes.
 */
export async function releaseDaySlotsBatch(
  db: CartethyiaDatabase | undefined,
  redis: RedisClient | undefined,
  dayKey: string,
  accountIds: readonly string[],
): Promise<void> {
  if (accountIds.length === 0) return;
  if (redis !== undefined) {
    const pipeline = redis.pipeline();
    for (const accountId of accountIds) {
      pipeline.del(ledgerKey(dayKey, accountId));
    }
    await pipeline.exec().catch(() => undefined);
    return;
  }
  if (db === undefined) return;
  try {
    await db
      .delete(dailyCheckinLedger)
      .where(
        and(
          inArray(dailyCheckinLedger.dayKey, [dayKey]),
          inArray(dailyCheckinLedger.accountId, [...accountIds]),
        ),
      );
  } catch (error) {
    log.warn(
      `[daily-checkin] batch ledger release failed for ${accountIds.length} account(s)`,
      error as Error,
    );
  }
}

/**
 * Stamps today's check-in slot for an account.
 * Exists so a caller that deliberately bypasses the ledger — an operator
 * pressing "check in now" — still leaves the evidence that today's attempt
 * happened. Without the stamp the sweep re-POSTs the claim on its next pass
 * and the console reads "Check-in due" for an account that was checked in
 * minutes ago; the request itself is harmless (`forceClaim` answers
 * `already_claimed` upstream) but the day's budget is spent twice.
 *
 * Only writes the slot; it never releases one. A caller that attempted the
 * check-in is asserting "this account is settled for today", which is exactly
 * what the slot means.
 */
export async function markCheckinAttempted(args: {
  readonly db: CartethyiaDatabase | undefined;
  readonly redis: RedisClient | undefined;
  readonly accountId: string;
  readonly now?: () => Date;
}): Promise<void> {
  const dayKey = checkinDayKey(args.now?.() ?? new Date());
  if (args.redis !== undefined) {
    await args.redis
      .set(ledgerKey(dayKey, args.accountId), "1", "EX", LEDGER_TTL_SECONDS)
      .catch((error: unknown) => {
        log.warn(`[daily-checkin] ledger stamp failed for account=${args.accountId}`, error as Error);
      });
    return;
  }
  if (args.db === undefined) return;
  try {
    await args.db
      .insert(dailyCheckinLedger)
      .values({ dayKey, accountId: args.accountId })
      .onConflictDoNothing();
  } catch (error) {
    log.warn(`[daily-checkin] ledger stamp failed for account=${args.accountId}`, error as Error);
  }
}

/**
 * Reads whether today's check-in slot is settled for an account.
 *
 * The read belongs next to the writes because there are two places the marker
 * can live — the Redis key when Redis is present, the `daily_checkin_ledger`
 * row when it is not — and only this module knows which one its own writes
 * used. A caller that reads the Redis key directly answers "not attempted" on
 * every Lite deployment, where the sweep writes the row.
 *
 * Absent or unreadable means unknown, never "not claimed": the sweep may
 * simply not have reached the account yet.
 */
/**
 * The same question as {@link checkinAttemptedToday}, asked once for many
 * accounts.
 *
 * The console answers it for every account on the page, and doing that one
 * account at a time cost a round trip per account — one `GET` to Redis, or one
 * `SELECT` to Postgres — on the route the dashboard polls. This is one `MGET`
 * when Redis is present, or one `SELECT ... WHERE day_key = ? AND account_id
 * IN (...)` when it is not, which is the same shape the release path already
 * uses.
 *
 * An account absent from the result was not attempted, matching the single
 * read's "absent means unknown, never claimed".
 */
/**
 * Shared Redis marker read. One `MGET` when the client supports it; otherwise
 * (a minimal double, or a client without the command) a `GET` loop. Returns
 * `undefined` when the ledger is unreadable — unknown, never "not claimed".
 */
async function readRedisMarkers(
  redis: RedisClient,
  dayKey: string,
  accountIds: readonly string[],
): Promise<Map<string, boolean> | undefined> {
  const attempted = new Map<string, boolean>();
  try {
    if (typeof redis.mget === "function") {
      // One command for every account: one key per account is small, and a
      // single `MGET` keeps the cost flat instead of linear in the count.
      const values = await redis.mget(
        ...accountIds.map((id) => ledgerKey(dayKey, id)),
      );
      accountIds.forEach((accountId, index) => {
        attempted.set(accountId, values[index] != null);
      });
      return attempted;
    }
    for (const accountId of accountIds) {
      attempted.set(accountId, (await redis.get(ledgerKey(dayKey, accountId))) !== null);
    }
    return attempted;
  } catch {
    return undefined;
  }
}

export async function checkinAttemptedTodayBatch(args: {
  readonly db: CartethyiaDatabase | undefined;
  readonly redis: RedisClient | undefined;
  readonly accountIds: readonly string[];
  readonly now?: () => Date;
}): Promise<Map<string, boolean>> {
  const attempted = new Map<string, boolean>();
  if (args.accountIds.length === 0) return attempted;
  const dayKey = checkinDayKey(args.now?.() ?? new Date());
  if (args.redis !== undefined) {
    const fromRedis = await readRedisMarkers(args.redis, dayKey, args.accountIds);
    if (fromRedis !== undefined) return fromRedis;
    // Fall through: an unreadable ledger means unknown, and the DB path is
    // the only other place the marker could be.
  }
  if (args.db === undefined) return attempted;
  try {
    const rows = await args.db
      .select({ accountId: dailyCheckinLedger.accountId })
      .from(dailyCheckinLedger)
      .where(
        and(
          eq(dailyCheckinLedger.dayKey, dayKey),
          inArray(dailyCheckinLedger.accountId, [...args.accountIds]),
        ),
      );
    const present = new Set(rows.map((row) => row.accountId));
    for (const accountId of args.accountIds) {
      attempted.set(accountId, present.has(accountId));
    }
  } catch {
    // Unknown, per account, as above.
  }
  return attempted;
}

export async function checkinAttemptedToday(args: {
  readonly db: CartethyiaDatabase | undefined;
  readonly redis: RedisClient | undefined;
  readonly accountId: string;
  readonly now?: () => Date;
}): Promise<boolean> {
  const dayKey = checkinDayKey(args.now?.() ?? new Date());
  if (args.redis !== undefined) {
    const fromRedis = await readRedisMarkers(args.redis, dayKey, [args.accountId]);
    if (fromRedis !== undefined) return fromRedis.get(args.accountId) ?? false;
  }
  if (args.db === undefined) return false;
  try {
    const rows = await args.db
      .select({ dayKey: dailyCheckinLedger.dayKey })
      .from(dailyCheckinLedger)
      .where(
        and(
          eq(dailyCheckinLedger.dayKey, dayKey),
          eq(dailyCheckinLedger.accountId, args.accountId),
        ),
      )
      .limit(1);
    return rows.length > 0;
  } catch {
    return false;
  }
}

/** Providers whose billing facade exposes the daily check-in routes. */
export function supportsDailyCheckin(providerId: string): boolean {
  return (DAILY_CHECKIN_PROVIDER_IDS as readonly string[]).includes(providerId);
}

/**
 * Wraps a proxy-bound fetcher so a 403 falls back to a direct connection once.
 *
 * A proxy that answers 403 (auth, expired pool credential, a provider that
 * rejects the egress) would fail the whole claim even though the account's own
 * credential was fine — the proxy is the only thing wrong. One direct retry
 * costs nothing when the proxy was healthy (the first attempt already
 * succeeded) and rescues the claim when it was not.
 *
 * The fallback only fires on 403, not on every error: a 401 means the account
 * credential itself is rejected, and retrying that direct would only burn the
 * same round-trip to the same verdict. When the caller already passed
 * `globalThis.fetch` (no proxy in play) the wrapper is a pass-through.
 */
export function withDirectFallback(fetcher: typeof fetch): typeof fetch {
  if (fetcher === globalThis.fetch) return fetcher;
  const wrapped: typeof fetch = (async (input, init) => {
    const viaProxy = await fetcher(input, init);
    if (viaProxy.status !== 403) return viaProxy;
    return globalThis.fetch(input, init);
  }) as typeof fetch;
  return wrapped;
}
/**
 * The outcome of one daily check-in pass: the claim alone. The
 * growth-activity report runs as its own once-a-day growth task
 * (`buddy-activity-report`) with its own ledger, so it is not re-POSTed on
 * every sweep. See `buddy-growth-tasks.ts`.
 */
type DailyGrowthPassResult = {
  readonly checkin: DailyCheckinResult;
};

export async function attemptDailyGrowthPass(args: {
  readonly db: CartethyiaDatabase | undefined;
  readonly redis: RedisClient | undefined;
  readonly providerId: ProviderId;
  readonly accountId: string;
  /** Refresh-aware credential resolution (the quota sweep's own resolver). */
  readonly resolveCredential: (providerId: ProviderId, accountId: string) => Promise<string>;
  readonly fetcher?: typeof fetch;
  readonly now?: () => Date;
}): Promise<DailyGrowthPassResult | null> {
  const fetcher = withDirectFallback(args.fetcher ?? globalThis.fetch);
  const { db, redis, providerId, accountId, resolveCredential } = args;
  const dayKey = checkinDayKey(args.now?.() ?? new Date());

  let reserved = false;
  try {
    reserved = await reserveDaySlot(db, redis, dayKey, accountId);
  } catch (error) {
    log.warn(`[daily-checkin] ledger unavailable for account=${accountId}`, error as Error);
    reserved = true;
  }
  if (!reserved) return null;

  let credential = "";
  try {
    credential = await resolveCredential(providerId, accountId);
  } catch (error) {
    return {
      checkin: {
        providerId,
        accountId,
        state: "error",
        credit: null,
        streakDays: null,
        error: error instanceof Error ? error.message : "Daily check-in failed.",
      },
    };
  }
  let checkin: DailyCheckinResult;
  try {
    // The buddy/qoder check-in graphs are lazy-loaded: only the provider on
    // this account needs its surface, and neither should sit on the boot graph
    // (B-02).
    const isQoderCheckinProvider = (
      await import("../providers/integrations/qoder/qoder-checkin")
    ).isQoderCheckinProvider;
    if (isQoderCheckinProvider(String(providerId))) {
      const { fetchQoderDailyCheckin } = await import(
        "../providers/integrations/qoder/qoder-checkin"
      );
      const { DrizzleQoderNativeIdentityStore } = await import(
        "../providers/integrations/qoder/qoder-native-identity-store"
      );
      checkin = await fetchQoderDailyCheckin({
        providerId: String(providerId),
        accountId,
        credential,
        fetcher,
        ...(db ? { nativeIdentityStore: new DrizzleQoderNativeIdentityStore(db) } : {}),
      });
    } else {
      const { fetchDailyCheckin } = await import(
        "../providers/integrations/buddy/buddy-checkin"
      );
      checkin = await fetchDailyCheckin({
        providerId,
        accountId,
        credential,
        fetcher,
      });
    }
  } catch (error) {
    checkin = {
      providerId,
      accountId,
      state: "error",
      credit: null,
      streakDays: null,
      error: error instanceof Error ? error.message : "Daily check-in failed.",
    };
  }

  // Only a transient `error` releases the slot so a later pass today can retry
  // (network, 5xx). `unavailable` is the status probe answering that no
  // activity is running — retrying that every pass spends the account's daily
  // slot on a door the provider has closed, and releasing the marker also
  // erases the evidence that anything was attempted: the console then reads
  // "Check-in due" forever while the sweep retries once a minute.
  // `already_claimed`, `not_eligible`, and `event_ended` are terminal for the
  // day and keep the slot.
  return { checkin };
}
export function dailyCheckinEgressForPass(args: {
  readonly db: CartethyiaDatabase;
  readonly networkBindingFactory: ValidatedNetworkBindingFactory;
}): (accountId: string, tenantId?: string | null) => Promise<ValidatedFetch> {
  const { db, networkBindingFactory } = args;
  let poolsPromise: Promise<readonly { id: string; tenantId: string | null }[]> | undefined;
  const cursors = new Map<string, number>();

  return async (_accountId, tenantId) => {
    poolsPromise ??= Promise.resolve()
      .then(() =>
        db
          .select({ id: networkPools.id, tenantId: networkPools.tenantId })
          .from(networkPools)
          .where(eq(networkPools.status, "active")),
      )
      .catch(() => []);
    const pools = await poolsPromise;
    const global = pools.filter((pool) => pool.tenantId === null);
    const owned =
      tenantId === undefined || tenantId === null
        ? []
        : pools.filter((pool) => pool.tenantId === tenantId);
    const candidates = [...owned, ...global];
    if (candidates.length === 0) return globalThis.fetch;

    const cursorKey = tenantId ?? "global";
    const cursor = cursors.get(cursorKey) ?? 0;
    const pool = candidates[cursor % candidates.length]!;
    cursors.set(cursorKey, cursor + 1);
    try {
      return networkBindingFactory.fetch(pool.id, tenantId ?? undefined);
    } catch {
      return globalThis.fetch;
    }
  };
}
