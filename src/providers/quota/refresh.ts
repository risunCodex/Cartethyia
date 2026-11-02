// Shared account-quota refresh: one home for "resolve credential → fetch quota →
// cache under the right lens → stamp the account row".
//
// Four callers need exactly this sequence — the console's single/bulk refresh
// routes, the overview's background fill, the periodic sweep worker, and the
// global-admin refresh — so it lives here rather than inside the route module.
// A drift between them would mean the page and the worker disagree about what
// "refreshed" means.
import { and, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import type { CartethyiaDatabase } from "../../persistence/db-handle";
import { providerAccounts } from "../../persistence/schema";
import type { RedisClient } from "../../persistence/redis";
import { log } from "../../observability/logger";
import { fetchProviderQuota } from "./quota-support";
import { type FetchLike, type ProviderQuotaResult } from "./quota-contracts";
import type { ProviderId } from "../provider-contracts";
import type { ProviderRegistry } from "../provider-registry";
import { quotaLens, setCachedQuota } from "./cache";
import { persistQuotaSnapshot } from "./snapshot";
import { asJsonbRecord } from "../../shared/coerce";
import { KIRO_DEFAULT_LABELS } from "../integrations/kiro/kiro-oauth";

/**
 * The stock Kiro fallback labels as a SQL literal list. Built once from the
 * canonical set (`KIRO_DEFAULT_LABELS`) and escaped for the single-quote SQL
 * literal; the values are compile-time constants, so this fragment is static.
 */
const KIRO_DEFAULT_LABEL_IN = sql.raw(
  [...KIRO_DEFAULT_LABELS]
    .map((label) => `'${label.replace(/'/g, "''")}'`)
    .join(", "),
);

/** Why an account quota refresh failed; `null` means the fetch succeeded. */
export type QuotaRefreshFailureCode = "missing_credential" | "quota_fetch_failed";

export interface QuotaRefreshOutcome {
  readonly quota: ProviderQuotaResult;
  readonly failure: QuotaRefreshFailureCode | null;
  /** Display identity the quota surface reported, when it reported one. */
  readonly accountLabel?: string;
}

/** Abort budget for one upstream quota fetch. */
export const QUOTA_REFRESH_TIMEOUT_MS = 15_000;

/**
 * Consecutive quota refusals before an account is parked. One refusal can be
 * the provider's own hiccup; three in a row is the quota surface not coming
 * back, and the account should stop being dialed until the cooldown elapses.
 */
export const QUOTA_FAILURE_PARK_THRESHOLD = 3;
/** How long a quota-parked account stays out of rotation. */
export const QUOTA_FAILURE_COOLDOWN_MS = 6 * 60 * 60 * 1000;

export interface QuotaRefreshDeps {
  readonly db: CartethyiaDatabase;
  readonly redis: RedisClient | undefined;
  readonly providerRegistry: ProviderRegistry;
  /**
   * Resolves a stored credential through the refresh-aware path (OAuth tokens
   * are refreshed before use), returning `""` when the account has none.
   * API-key accounts are wrapped in the provider's key envelope when one
   * exists, so a key-only credential never reaches an OAuth-only surface.
   */
  readonly resolveCredential: (providerId: ProviderId, accountId: string) => Promise<string>;
  /** Marks a stored api_key credential with the upstream-distinguishable envelope. */
  readonly markApiKeyCredential?: (providerId: string, credential: string) => string;
  /** Invalidates the route snapshot when a stamped figure may exclude an account. */
  readonly snapshotInvalidator?: { invalidate(): unknown } | undefined;
}

/** Bound on concurrently tracked single-flight quota refreshes; keys are account ids, so the real bound is the account count. */
const MAX_INFLIGHT = 1_000;

/**
 * In-flight promise deduplication map for account quota refreshes. Keyed by
 * accountId so concurrent callers (a manual refresh plus the sweep, or two
 * rapid clicks) share one upstream fetch instead of hammering the provider.
 */
export const inFlightAccountQuotaRefreshes = new Map<string, Promise<QuotaRefreshOutcome>>();

/**
 * Binds an abort signal to outbound quota fetches while preserving Bun's
 * `fetch.preconnect` static, so the wrapper satisfies `FetchLike`.
 */
export function signalFetch(signal: AbortSignal): typeof fetch {
  const wrapped = (
    url: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => fetch(url, { ...init, signal });
  return Object.assign(wrapped, {
    preconnect: (...args: Parameters<typeof fetch.preconnect>): void =>
      fetch.preconnect(...args),
  });
}

/** Combines the caller's abort signal with the fetch budget. */
export function timeoutSignal(requestSignal: AbortSignal, ms: number): AbortSignal {
  return AbortSignal.any([requestSignal, AbortSignal.timeout(ms)]);
}

/**
 * Records one quota-refresh outcome on the account row so the dashboard's
 * "Last check" reflects what the fetch actually found. Success stamps
 * `lastSuccessAt` and clears the error fields; failure stamps the error
 * fields and keeps the last success.
 *
 * A *counted* failure also advances `consecutiveFailures`, and once an account
 * has `QUOTA_FAILURE_PARK_THRESHOLD` of them in a row it is parked — this is
 * the one place a quota result may move `status`, because a quota surface that
 * refuses three times is an account problem rather than a transient one. A
 * transient timeout is annotated but never counted, so it cannot park
 * (see `isTransientTimeout`).
 *
 * The error fields are written only while the account is `active`, because for
 * a parked account (cooldown/disabled) those fields carry the reason
 * the health machine parked it. A periodic quota sweep runs against every OAuth
 * account, and a failing quota endpoint reported "Invalid or expired
 * credentials" for an entire provider — overwriting the `auth_invalidated`
 * reason a dispatch 401 had just recorded with `quota_fetch_failed`, so the
 * dashboard blamed the wrong thing. A check cannot reclassify a parked account;
 * its own failure is still visible through the quota cache the page renders.
 */
/**
 * A failure that says nothing about the account.
 *
 * A quota fetch that ran out of its own abort budget timed out against *our*
 * egress, not against the credential: the upstream may never have seen the
 * request. Counting it like a refusal meant three slow passes parked a healthy
 * account for six hours — and the buddy family is the worst case, because its
 * quota and check-in legs share one pass and rotate egress per account, so a
 * single slow pool produced three timeouts in a row.
 *
 * Matched on the message the timeout paths produce. Deliberately narrow: a
 * refusal that merely mentions a timeout is still a refusal.
 */
function isTransientTimeout(error: string | null | undefined): boolean {
  if (!error) return false;
  const lower = error.toLowerCase();
  return (
    lower.includes("the operation timed out") ||
    lower.includes("operation timed out") ||
    lower.includes("timeout") && lower.includes("abort")
  );
}

export async function recordAccountCheck(
  db: CartethyiaDatabase,
  accountId: string,
  outcome: { ok: boolean; error?: string | null; category?: string | null },
): Promise<void> {
  const activeOnly = and(
    eq(providerAccounts.id, accountId),
    eq(providerAccounts.status, "active"),
  );
  if (outcome.ok) {
    await db
      .update(providerAccounts)
      .set({
        lastSuccessAt: new Date(),
        lastError: null,
        lastErrorCategory: null,
        lastErrorAt: null,
        consecutiveFailures: 0,
      })
      .where(activeOnly);
    return;
  }
  const transient = isTransientTimeout(outcome.error);
  // Count the failure in the same statement — unless it is a transient
  // timeout (see below). A quota endpoint that keeps refusing is an account
  // problem, and the row has to say so: the dashboard reads
  // `consecutiveFailures` for the pill, and a check that only wrote the error
  // text left the account looking healthy while every refresh failed.
  //
  // A timeout is annotated but NOT counted: it is evidence about the network,
  // not the credential, and letting it advance the streak is what parked
  // healthy accounts for six hours over three slow passes.
  const failing = await db
    .update(providerAccounts)
    .set({
      lastError: (outcome.error ?? "Account check failed").slice(0, 500),
      lastErrorCategory: outcome.category ?? "check_failed",
      lastErrorAt: new Date(),
      ...(transient ? {} : { consecutiveFailures: sql`${providerAccounts.consecutiveFailures} + 1` }),
    })
    .where(activeOnly)
    .returning({ consecutiveFailures: providerAccounts.consecutiveFailures });
  if (transient) return;
  const failures = failing[0]?.consecutiveFailures ?? 0;
  // Past the threshold the account is parked, not just annotated. Three
  // consecutive refusals is a quota surface that is not coming back on its
  // own, and leaving the account in rotation only repeats the failure every
  // pass. The cooldown clears itself; a success before it elapses resets the
  // count above.
  if (failures >= QUOTA_FAILURE_PARK_THRESHOLD) {
    await db
      .update(providerAccounts)
      .set({
        status: "cooldown",
        cooldownUntil: new Date(Date.now() + QUOTA_FAILURE_COOLDOWN_MS),
      })
      .where(activeOnly);
  }
}

/** One account that a quota refresh can be attempted for. */
export interface QuotaRefreshTarget {
  readonly accountId: string;
  readonly providerId: string;
  /** Owning tenant, or `null` for a global/shared account. */
  readonly tenantId: string | null;
  /**
   * Stored credential kind. Key-only credentials never reach an OAuth-only
   * quota surface: the collector routes `api_key` to the `/models`
   * connectivity probe instead, while OAuth keeps `users/me`.
   */
  readonly credentialKind?: "api_key" | "oauth" | "none" | null;
  /**
   * Human identity for logs. OAuth rows carry `Name <email@host>` because the
   * account label is seeded from the token's own identity claims, so sweep
   * lines can name the account instead of dumping a uuid.
   */
  readonly label?: string | null;
  /**
   * Non-secret per-account auth configuration. A collector whose billing
   * surface is region- or profile-scoped needs it; most ignore it.
   */
  readonly authState?: unknown;
}

/** Cache lens an account's quota belongs under. */
export function targetLens(target: QuotaRefreshTarget): string {
  return quotaLens(target.tenantId);
}

const TARGET_COLUMNS = {
  accountId: providerAccounts.id,
  providerId: providerAccounts.providerId,
  tenantId: providerAccounts.tenantId,
  credentialKind: providerAccounts.credentialKind,
  label: providerAccounts.label,
  authState: providerAccounts.authState,
};

/**
 * Credential-bearing accounts eligible for the periodic quota sweep.
 *
 * OAuth accounts use the refresh-aware resolver; api_key accounts (including
 * pasted JWTs) use the stored bearer exactly as issued. Both need quota refresh
 * and Buddy daily check-in, while `none` has no credential to probe.
 *
 * An account already marked `auth_invalidated` is excluded: its credential was
 * rejected outright and does not repair itself, so every sweep is a guaranteed
 * 401 that only re-confirms the row and floods the log — the operator needs a
 * re-login, not another probe. It returns to the sweep once it is re-authed or
 * recovered, which is when its credential is expected to work again.
 *
 * Every other credential-bearing account is swept, `disabled` included. A
 * disabled account is not necessarily revoked — it may have been parked for a
 * reason unrelated to its credential — and skipping it would let a credential
 * die silently while the row still reads healthy.
 */
export async function listQuotaRefreshTargets(
  db: CartethyiaDatabase,
): Promise<readonly QuotaRefreshTarget[]> {
  return db
    .select(TARGET_COLUMNS)
    .from(providerAccounts)
    .where(
      and(
        inArray(providerAccounts.credentialKind, ["oauth", "api_key"]),
        or(
          isNull(providerAccounts.lastErrorCategory),
          ne(providerAccounts.lastErrorCategory, "auth_invalidated"),
        ),
      ),
    );
}

/**
 * Loads one account scoped to its owner.
 *
 * `tenantId` undefined means "any owner"; `null` means a shared/global row,
 * and a supplied tenant id matches only that tenant's own rows. Explicitly
 * selecting `null` keeps global-admin refreshes from addressing tenant-owned
 * accounts by id.
 */
export async function loadQuotaTarget(
  db: CartethyiaDatabase,
  accountId: string,
  tenantId?: string | null,
): Promise<QuotaRefreshTarget | undefined> {
  const ownerPredicate =
    tenantId === undefined
      ? undefined
      : tenantId === null
        ? isNull(providerAccounts.tenantId)
        : eq(providerAccounts.tenantId, tenantId);
  const where = ownerPredicate
    ? and(eq(providerAccounts.id, accountId), ownerPredicate)
    : eq(providerAccounts.id, accountId);
  const rows = await db.select(TARGET_COLUMNS).from(providerAccounts).where(where).limit(1);
  return rows[0];
}

/**
 * Fetches one account's quota through the refresh-aware credential path, then
 * persists the outcome: the result is cached under the account's lens and the
 * account row is stamped with the check result. Concurrent callers for the same
 * account share one upstream fetch via `inFlightAccountQuotaRefreshes`.
 */
export async function refreshAccountQuota(
  deps: QuotaRefreshDeps,
  target: QuotaRefreshTarget,
  fetcher: FetchLike,
): Promise<QuotaRefreshOutcome> {
  const existing = inFlightAccountQuotaRefreshes.get(target.accountId);
  if (existing) return existing;
  // Eviction guard: keys are account ids (bounded by the accounts table), but a
  // runaway caller could still fan out unique keys; drop the oldest in-flight
  // task rather than grow without bound. An evicted task's `.finally` delete is
  // a no-op for a key no longer present, and the caller still awaits its own
  // promise — eviction only costs it deduplication, never its result.
  if (inFlightAccountQuotaRefreshes.size >= MAX_INFLIGHT) {
    const oldestKey = inFlightAccountQuotaRefreshes.keys().next().value;
    if (oldestKey !== undefined) inFlightAccountQuotaRefreshes.delete(oldestKey);
  }
  const task = runQuotaRefresh(deps, target, fetcher).finally(() => {
    inFlightAccountQuotaRefreshes.delete(target.accountId);
  });
  inFlightAccountQuotaRefreshes.set(target.accountId, task);
  return task;
}

async function runQuotaRefresh(
  deps: QuotaRefreshDeps,
  target: QuotaRefreshTarget,
  fetcher: FetchLike,
): Promise<QuotaRefreshOutcome> {
  let credential: string | undefined;
  let resolveError: string | undefined;
  try {
    credential = await deps.resolveCredential(target.providerId as ProviderId, target.accountId);
  } catch (error) {
    resolveError = error instanceof Error ? error.message : "Failed to resolve credential";
  }

  let quota: ProviderQuotaResult;
  let failure: QuotaRefreshFailureCode | null = null;
  if (resolveError !== undefined) {
    quota = { source: target.providerId, plan: null, windows: [], error: resolveError };
    failure = "quota_fetch_failed";
  } else if (!credential) {
    quota = {
      source: target.providerId,
      plan: null,
      windows: [],
      error: "Account has no stored credential",
    };
    failure = "missing_credential";
  } else {
    // OAuth accounts must never see the api-key mark: the marker routes the
    // collector to the key-only probe, and OAuth credentials carry no key.
    const marked =
      target.credentialKind === "api_key"
        ? (deps.markApiKeyCredential?.(target.providerId, credential) ?? credential)
        : credential;
    try {
      const authState = asJsonbRecord(target.authState);
      quota = await fetchProviderQuota(deps.providerRegistry, target.providerId, marked, fetcher, {
        // Carried so a collector can reuse a reading captured from real
        // traffic rather than spending a request to rediscover it.
        ...(target.accountId === undefined ? {} : { accountId: target.accountId }),
        ...(authState === undefined ? {} : { auth_state: authState }),
        ...(target.credentialKind === null || target.credentialKind === undefined
          ? {}
          : { credential_kind: target.credentialKind }),
      });
    } catch (error) {
      quota = {
        source: target.providerId,
        plan: null,
        windows: [],
        error: error instanceof Error ? error.message : "Failed to refresh quota",
      };
    }
    failure = quota.error === null ? null : "quota_fetch_failed";
  }

  // Cache even a failed fetch: the error view ("credential expired", "quota
  // unsupported") is itself the answer the page must render, and caching it
  // stops every page open from re-hitting a provider that just refused us.
  await setCachedQuota(targetLens(target), target.accountId, quota, deps.redis);
  // Persist the plan the provider reported, because routing gates on it: some
  // upstreams refuse a model on a free plan and nothing but the account's own
  // plan says which. The cache above is a short in-process TTL and empty after
  // a restart, so it cannot be the only copy — the row is what survives one.
  //
  // A failed fetch leaves the last known plan in place rather than clearing
  // it. The refresh failing is evidence about the network or the credential,
  // not evidence that the account's plan changed, and clearing on failure
  // would drop the router back to "unknown" on every transient error.
  if (quota.plan !== null) {
    try {
      await deps.db
        .update(providerAccounts)
        .set({ quotaPlan: quota.plan })
        .where(eq(providerAccounts.id, target.accountId));
    } catch (error) {
      log.warn(`[quota] failed to record plan for account=${target.accountId}`, error as Error);
    }
  }
  // Persist the whole successful read, not just the plan. The row survives a
  // restart that empties the in-process cache, so a cold console open renders
  // the last known balance instead of nothing (and the sweep refreshes it). A
  // failed fetch leaves the previous snapshot in place — same reasoning as the
  // plan column: failure is evidence about the network/credential, not that
  // the account's balance changed.
  if (quota.error === null) {
    await persistQuotaSnapshot(deps.db, target.accountId, quota);
  }
  // A quota surface that names the account adopts the identity — but only over
  // a default label. An operator's custom rename is never overwritten, and the
  // CASE keeps the read and the write in one statement so a concurrent rename
  // cannot lose to the background sweep.
  if (quota.accountLabel !== undefined && quota.accountLabel.trim().length > 0) {
    try {
      await deps.db
        .update(providerAccounts)
        .set({
          // Adopted when the stored label is still the provider id *or* still
          // the credential's own subject. A collector that reduces an identity
          // to an opaque tag must be able to replace that identity, and the
          // provider-id test alone left the real subject in place — which is
          // the thing the tag exists to remove.
          label: sql`CASE
            WHEN lower(trim(${providerAccounts.label})) = lower(trim(${providerAccounts.providerId})) THEN ${quota.accountLabel}
            WHEN ${providerAccounts.label} LIKE '%|%' THEN ${quota.accountLabel}
            WHEN ${providerAccounts.label} IN (${KIRO_DEFAULT_LABEL_IN}) THEN ${quota.accountLabel}
            ELSE ${providerAccounts.label}
          END`,
        })
        .where(eq(providerAccounts.id, target.accountId));
    } catch (error) {
      log.warn(`[quota] failed to adopt account label for account=${target.accountId}`, error as Error);
    }
  }
  try {
    await recordAccountCheck(deps.db, target.accountId, {
      ok: quota.error === null,
      ...(quota.error === null ? {} : { error: quota.error, category: failure ?? "quota_fetch_failed" }),
    });
  } catch (error) {
    // A stamp failure must not lose the freshly fetched quota.
    log.warn(`[quota] failed to stamp check outcome for account=${target.accountId}`, error as Error);
  }
  return {
    quota,
    failure: quota.error === null ? null : (failure ?? "quota_fetch_failed"),
    ...(quota.accountLabel === undefined ? {} : { accountLabel: quota.accountLabel }),
  };
}
