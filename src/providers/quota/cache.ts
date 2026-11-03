// Quota cache: two-tier (in-process TtlCache + Redis) store for provider quota reads.
//
// Entries are stored as a versioned envelope so cache retention, last attempt,
// and last successful reading can be tracked independently.
//
// Reads the pre-envelope bare result and v2-v4 envelopes during upgrade;
// writes use v5, which records attempt time, retained-refresh errors, and
// forces a one-time refresh for required quota accounting metadata.
import type { ProviderQuotaResult } from "./quota-contracts";
import type { RedisClient } from "../../persistence/redis";
import { TtlCache } from "../../persistence/ttl-cache";
import { log } from "../../observability/logger";
import { metrics } from "../../observability/metrics";

const QUOTA_KEY_PREFIX = "quota:v5:";
const QUOTA_TTL_SECONDS = 900;
const QUOTA_TTL_MS = QUOTA_TTL_SECONDS * 1000;
const MAX_STALE_QUOTA_AGE_MS = 30 * 60_000;

/**
 * Cache lens for tenant-null (global/shared) accounts. One entry serves every
 * tenant: a shared account's quota is the same fact whoever asks, so keying it
 * per tenant would mean N fetches for one answer and let the sweep warm only
 * the lens it happens to know.
 */
export const GLOBAL_QUOTA_LENS = "global";

interface CachedQuotaEnvelope {
  readonly v: 5;
  readonly fetchedAt: string | null;
  readonly lastAttemptAt: string;
  readonly refreshError: string | null;
  readonly quota: ProviderQuotaResult;
}

export interface CachedQuotaEntry {
  readonly quota: ProviderQuotaResult;
  /** ISO timestamp of the most recent successful fetch. */
  readonly fetchedAt: string | null;
  /** ISO timestamp of the most recent fetch attempt. */
  readonly lastAttemptAt: string | null;
  /** Most recent refresh failure while retaining an older successful reading. */
  readonly refreshError: string | null;
}

const inMemoryQuotaCache = new TtlCache<CachedQuotaEntry>({
  ttlMs: QUOTA_TTL_MS,
  maxEntries: 1024,
});

/** Resolves the cache lens for an account: its owning tenant, or the shared lens. */
export function quotaLens(tenantId: string | null | undefined): string {
  return tenantId ?? GLOBAL_QUOTA_LENS;
}

function quotaKey(lens: string, accountId: string): string {
  return `${QUOTA_KEY_PREFIX}${lens}:${accountId}`;
}

/** Parses a versioned envelope or a release-N bare result. */
function parseCached(raw: string | null | undefined): CachedQuotaEntry | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const inner = record["quota"];
  if (
    (record["v"] === 2 ||
      record["v"] === 3 ||
      record["v"] === 4 ||
      record["v"] === 5) &&
    typeof inner === "object" &&
    inner !== null &&
    !Array.isArray(inner)
  ) {
    const fetchedAt = typeof record["fetchedAt"] === "string" ? record["fetchedAt"] : null;
    return {
      quota: inner as ProviderQuotaResult,
      fetchedAt,
      lastAttemptAt:
        typeof record["lastAttemptAt"] === "string"
          ? record["lastAttemptAt"]
          : fetchedAt,
      refreshError:
        (record["v"] === 3 || record["v"] === 4 || record["v"] === 5) &&
        typeof record["refreshError"] === "string"
          ? record["refreshError"]
          : null,
    };
  }
  // Release N only: the quota result was the whole value, so its age is unknown.
  if (
    typeof record["source"] !== "string" ||
    (record["plan"] !== null && typeof record["plan"] !== "string") ||
    !Array.isArray(record["windows"]) ||
    (record["error"] !== null && typeof record["error"] !== "string")
  ) {
    return null;
  }
  return { quota: parsed as ProviderQuotaResult, fetchedAt: null, lastAttemptAt: null, refreshError: null };
}

/**
 * Returns age since the most recent refresh attempt. Invalid or missing
 * timestamps are due immediately.
 */
export function cachedQuotaAgeMs(entry: CachedQuotaEntry | null | undefined, now = Date.now()): number {
  const timestamp = entry?.lastAttemptAt ?? entry?.fetchedAt;
  if (timestamp === null || timestamp === undefined) return Number.POSITIVE_INFINITY;
  const at = new Date(timestamp).getTime();
  return Number.isFinite(at) ? now - at : Number.POSITIVE_INFINITY;
}

export async function getCachedQuotaEntry(
  lens: string,
  accountId: string,
  redis: RedisClient | undefined,
): Promise<CachedQuotaEntry | null> {
  const key = quotaKey(lens, accountId);
  const inMem = inMemoryQuotaCache.get(key);
  if (inMem !== undefined) return inMem;
  // Memory backend: the in-process tier above is the whole cache.
  if (redis === undefined) return null;

  let raw: string | null = null;
  try {
    raw = await redis.get(key);
  } catch (error) {
    log.warn("quota cache read failed", { key, error: String(error) });
    return null;
  }
  const entry = parseCached(raw);
  if (entry) inMemoryQuotaCache.set(key, entry);
  return entry;
}

/**
 * Batch read for one lens: the memory tier answers what it can, then the
 * remaining keys go to Redis in a single `MGET`. The overview renders every
 * account at once, so one round trip per account would make the page's
 * latency scale with the account count.
 */
export async function getCachedQuotaEntries(
  lens: string,
  accountIds: readonly string[],
  redis: RedisClient | undefined,
): Promise<Map<string, CachedQuotaEntry>> {
  const found = new Map<string, CachedQuotaEntry>();
  const missing: string[] = [];
  for (const accountId of accountIds) {
    const key = quotaKey(lens, accountId);
    const hit = inMemoryQuotaCache.get(key);
    if (hit !== undefined) found.set(accountId, hit);
    else missing.push(accountId);
  }
  if (missing.length === 0) return found;
  // Memory backend (or a client without MGET): per-key reads, which hit the
  // in-process tier first and return null beyond it.
  if (redis === undefined || typeof redis.mget !== "function") {
    for (const accountId of missing) {
      const entry = await getCachedQuotaEntry(lens, accountId, redis);
      if (entry) found.set(accountId, entry);
    }
    return found;
  }

  try {
    const raws = (await redis.mget(...missing.map((accountId) => quotaKey(lens, accountId)))) as Array<
      string | null
    >;
    missing.forEach((accountId, index) => {
      const entry = parseCached(raws[index] ?? null);
      if (!entry) return;
      inMemoryQuotaCache.set(quotaKey(lens, accountId), entry);
      found.set(accountId, entry);
    });
  } catch (error) {
    // Redis outage: the memory tier already answered everything it could.
    log.warn("quota cache batch read failed", { lens, error: String(error) });
  }
  return found;
}

export async function setCachedQuota(
  lens: string,
  accountId: string,
  quota: ProviderQuotaResult,
  redis: RedisClient | undefined,
  fetchedAt: Date = new Date(),
): Promise<void> {
  const key = quotaKey(lens, accountId);
  const previous = await getCachedQuotaEntry(lens, accountId, redis);
  const attemptedAt = fetchedAt.toISOString();
  const previousSuccessAt =
    previous?.fetchedAt === null || previous?.fetchedAt === undefined
      ? null
      : new Date(previous.fetchedAt).getTime();
  const retainedSuccess =
    quota.error !== null &&
    previous?.quota.error === null &&
    previousSuccessAt !== null &&
    Number.isFinite(previousSuccessAt) &&
    fetchedAt.getTime() - previousSuccessAt <= MAX_STALE_QUOTA_AGE_MS;
  const entry: CachedQuotaEntry = retainedSuccess
    ? {
        quota: previous.quota,
        fetchedAt: previous.fetchedAt,
        lastAttemptAt: attemptedAt,
        refreshError: quota.error,
      }
    : {
        quota,
        fetchedAt: quota.error === null ? attemptedAt : null,
        lastAttemptAt: attemptedAt,
        refreshError: null,
      };
  inMemoryQuotaCache.set(key, entry);
  if (redis === undefined) return;
  try {
    const envelope: CachedQuotaEnvelope = {
      v: 5,
      fetchedAt: entry.fetchedAt,
      lastAttemptAt: attemptedAt,
      refreshError: entry.refreshError,
      quota: entry.quota,
    };
    await redis.set(key, JSON.stringify(envelope), "EX", QUOTA_TTL_SECONDS);
  } catch (error) {
    // In-memory cache holds the record if Redis is unavailable.
    log.warn("quota cache write failed", { key, error: String(error) });
  }
}

/**
 * Subtracts credits a completed request reported from the account's cached
 * pooled balance.
 *
 * The quota sweep is the only thing that writes this cache, and it runs at
 * most every four minutes. Between sweeps the floor keeps selecting an account
 * whose balance has already crossed the threshold, because nothing told the
 * cache the request spent anything. The chat response carries the credits that
 * request consumed, not a new balance, so this debits the last known one.
 *
 * It is not a fresh reading: `fetchedAt` is preserved, so the sweep still
 * refreshes an account on its own schedule instead of treating the debit as a
 * just-completed fetch and skipping it. No cached entry, or one whose last
 * fetch failed, is left alone — a debit must not invent a balance the floor
 * would then treat as measured.
 */
export async function debitCachedQuota(
  lens: string,
  accountId: string,
  credits: number,
  redis: RedisClient | undefined,
): Promise<void> {
  if (!Number.isFinite(credits) || credits <= 0) return;
  const entry = await getCachedQuotaEntry(lens, accountId, redis);
  if (entry === null || entry.quota.error !== null) return;
  let remaining = credits;
  const windows = entry.quota.windows.map((window) => {
    if (remaining <= 0) return window;
    if (window.accounting !== "pooled") return window;
    const limit = window.limit;
    if (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0) return window;
    const balance =
      typeof window.remaining === "number" && Number.isFinite(window.remaining)
        ? window.remaining
        : typeof window.used === "number" && Number.isFinite(window.used)
          ? limit - window.used
          : null;
    if (balance === null) return window;
    const spent = Math.min(remaining, Math.max(0, balance));
    remaining -= spent;
    const next = Math.max(0, balance - spent);
    const used = limit - next;
    const usedPercent = Math.min(100, Math.max(0, (used / limit) * 100));
    return {
      ...window,
      remaining: next,
      used,
      usedPercent,
      remainingPercent: Math.max(0, 100 - usedPercent),
    };
  });
  if (remaining === credits) return;
  const fetchedAt =
    entry.fetchedAt !== null && Number.isFinite(Date.parse(entry.fetchedAt))
      ? new Date(entry.fetchedAt)
      : new Date();
  await setCachedQuota(
    lens,
    accountId,
    { ...entry.quota, windows },
    redis,
    fetchedAt,
  );
}

/** Drops one account from one lens (credential rotation, status change, delete). */
export async function invalidateQuotaCache(
  lens: string,
  accountId: string,
  redis: RedisClient | undefined,
): Promise<void> {
  const key = quotaKey(lens, accountId);
  inMemoryQuotaCache.delete(key);
  if (redis === undefined) return;
  try {
    await redis.del(key);
  } catch (error) {
    metrics.quota_cache_invalidate_failed.inc(1);
    log.warn("quota cache invalidate failed", { key, error: String(error) });
  }
}

/**
 * Drops many accounts from one lens in a single pass.
 *
 * The batch-delete route clears several accounts' quota caches at once. The
 * in-process tier is swept once (one `keys()` pass), and Redis is cleared with
 * one pipeline, so the cost does not scale with per-account round trips.
 */
export async function invalidateQuotaCaches(
  lens: string,
  accountIds: readonly string[],
  redis: RedisClient | undefined,
): Promise<void> {
  if (accountIds.length === 0) return;
  const keys = accountIds.map((accountId) => quotaKey(lens, accountId));
  const keySet = new Set(keys);
  for (const key of inMemoryQuotaCache.keys()) {
    if (keySet.has(key)) inMemoryQuotaCache.delete(key);
  }
  if (redis === undefined) return;
  try {
    const pipeline = redis.pipeline();
    for (const key of keys) pipeline.del(key);
    await pipeline.exec().catch(() => undefined);
  } catch (error) {
    metrics.quota_cache_invalidate_failed.inc(1);
    log.warn("quota cache batch invalidate failed", { lens, error: String(error) });
  }
}

/** Tracked keys in the in-process tier, for the runtime-metrics gauge. */
export function quotaCacheSize(): number {
  return inMemoryQuotaCache.size;
}

/** Test seam: the in-process tier is process-wide and must not leak across suites. */
export function clearQuotaCacheForTests(): void {
  inMemoryQuotaCache.clear();
}
