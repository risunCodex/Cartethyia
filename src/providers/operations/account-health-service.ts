import { randomUUID } from "node:crypto";
import { healthEventBuffer } from "../../persistence/health-event-flush";
import { and, count, desc, eq, inArray, isNotNull, like, lte, or, sql } from "drizzle-orm";
import { affectedRows, pruneExpiredCooldowns } from "../../persistence/dialect";
import type { CartethyiaDatabase } from "../../persistence/db-handle";
import { consoleSettings, healthEvents, providerAccounts } from "../../persistence/schema";
import {
  COOLDOWN_RECOVERY_BATCH,
  accountDeadlineMs,
  applyRuleEscalation,
  classifyAccountError,
  latestDeadlineMs,
  unsupportedModelCooldownMs,
} from "./account-error-classification";
import { resolveAccountDisabledRecoveryMs } from "../../config/cooldowns";
import type { AccountErrorClassification, AccountFailureEvidence } from "./account-error-classification";
import { resolveCooldownRule } from "./cooldown-rules";
import { mapPlanToTier } from "./account-tier";

/**
 * Categories the auto-disable toggle (area 01) targets (D01). Model-scoped
 * verdicts (`model_unreachable`) are not here — they belong to the tier rules
 * (area 03, R-C).
 */
const AUTO_DISABLE_TARGET_CATEGORIES: ReadonlySet<string> = new Set([
  "quota_exhausted",
  "rate_limit_transient",
]);

/** Prefix marking an auto-disable written by the rate-limited intercept (D03/R-B). */
export const AUTO_DISABLE_MARKER_PREFIX = "auto-disable (rate-limited): ";

/** An upstream-stated window shorter than this is not auto-disabled (D04). */
const AUTO_DISABLE_STATED_MIN_MS = 5 * 60 * 1000;

/**
 * Whether the auto-disable preference is on for a tenant (and for shared
 * accounts — `tenantId === null` — when any tenant has it on, D06).
 *
 * The preference lives in `console_settings.preferences` (the C2 cluster added
 * the typed field to `ConsoleSettingsPreferences`). Reading is fail-safe (D01
 * §3.1): a missing row, a failed read, or a preference that is not exactly
 * `true` all mean off — a settings failure must never break a health write.
 */
export async function autoDisableRateLimitedEnabled(
  db: CartethyiaDatabase,
  tenantId: string | null,
): Promise<boolean> {
  try {
    const rows = await db
      .select({ tenantId: consoleSettings.tenantId, preferences: consoleSettings.preferences })
      .from(consoleSettings);
    return rows.some((row) => {
      if (tenantId !== null && row.tenantId !== tenantId) return false;
      const prefs = row.preferences as {
        readonly autoDisableRateLimited?: boolean;
      } | null | undefined;
      return prefs?.autoDisableRateLimited === true;
    });
  } catch {
    return false;
  }
}

export { classifyAccountError, unsupportedModelCooldownMs } from "./account-error-classification";
export type {
  AccountErrorCategory,
  AccountErrorClassification,
  AccountFailureEvidence,
  AccountFailureOrigin,
  AccountFailureScope,
} from "./account-error-classification";

export interface AccountHealthEventRecord {
  readonly id: string;
  readonly accountId: string;
  readonly fromStatus: string | null;
  readonly toStatus: string;
  readonly reason: string | null;
  readonly errorCategory: string | null;
  readonly modelId: string | null;
  readonly createdAt: string;
}

/**
 * Runs a write against the db handle, wrapping it in a transaction when the
 * handle supports one. Kept as a capability probe, not a correctness guard:
 * health writes are reachable with a partially-implemented database handle
 * (the dispatch tests pass a narrow double), and a transaction is an
 * optimization here, not a requirement — the same writes are correct without
 * one. Returns `fallback` when the write throws; health must never fail
 * requests.
 */
async function withTransaction<T>(
  db: CartethyiaDatabase,
  mutate: (tx: CartethyiaDatabase) => Promise<T>,
  fallback: T,
): Promise<T> {
  try {
    if (typeof db.transaction === "function") {
      return await db.transaction((tx) => mutate(tx as CartethyiaDatabase));
    }
    return await mutate(db);
  } catch {
    return fallback;
  }
}

/** Persists one classified failure to the account row and appends a health event. */
export async function recordAccountFailure(
  db: CartethyiaDatabase,
  accountId: string,
  error: unknown,
  options?: AccountFailureEvidence,
): Promise<AccountErrorClassification | null> {
  const classification = classifyAccountError(error, options);
  /**
   * Logged even when the classification does not mutate the account.
   *
   * `rate_limit_transient` seen on a stream frame carries no credential
   * detail, so it classifies at provider scope and `mutatesAccount` is false
   * — nothing is cooled and the account stays `active`. That part is correct:
   * the upstream's own remedy ("switch to the other models") only works if the
   * account keeps serving. But this returned without writing anything, so a
   * rate-limited request showed up in the request log while the account's
   * health log stayed empty — a symptom with no recorded cause.
   *
   * The row is the whole point of this branch: it records the failure without
   * moving the account. Both status sides are the classification's own, so the
   * dialog names the cause without claiming a transition that never happened.
   */
  if (!classification.mutatesAccount) {
    void writeHealthEvent(db, {
      entityKind: "account",
      accountId,
      fromStatus: classification.status,
      toStatus: classification.status,
      reason: classification.reason,
      errorCategory: classification.category,
      modelId: options?.modelId ?? null,
      createdAt: new Date(),
    }).catch(() => undefined);
    return classification;
  }

  const persist = async (client: CartethyiaDatabase): Promise<AccountErrorClassification | null> => {
    // Projected, not a bare `select()`: this runs on *every* attempt outcome,
    // and a full row drags `credential_ciphertext` (the largest thing stored
    // per account) and `auth_state` over the wire to read a status and a
    // counter. `RouteCatalogRepository` already projects for the same reason.
    const accountRows = await client
      .select({
        status: providerAccounts.status,
        staticToken: providerAccounts.staticToken,
        consecutiveFailures: providerAccounts.consecutiveFailures,
        modelCooldowns: providerAccounts.modelCooldowns,
        // Read only for the unsupported-model ladder; NULL means "never
        // counted", which is the common case and must stay cheap.
        modelBlockHits: providerAccounts.modelBlockHits,
        cooldownUntil: providerAccounts.cooldownUntil,
        // Required by the auto-disable toggle (tenant-level preference read)
        // and by the tier-aware cooldown rules (plan → tier).
        providerId: providerAccounts.providerId,
        tenantId: providerAccounts.tenantId,
        quotaPlan: providerAccounts.quotaPlan,
      })
      .from(providerAccounts)
      .where(eq(providerAccounts.id, accountId))
      .limit(1);
    const account = accountRows[0];
    if (!account || account.status === "disabled") return null;

    // Re-classify with the account's own static-token flag. The caller's
    // evidence is request-scoped and does not carry it, but an auth rejection
    // against a static token must cool the account down rather than park it —
    // there is no refresh to run, and the token may still be valid.
    const effective = account.staticToken
      ? classifyAccountError(error, { ...options, staticToken: true })
      : classification;

    const fromStatus = account.status;
    const now = new Date();

    // ---- Auto-disable intercept (area 01, D01–D06) -------------------------
    // Evaluated after classification and before the model-scoped/account-wide
    // branch, so a 429/quota verdict carrying a modelId is rewritten to an
    // account-wide disable instead of sinking into a per-model cooldown (D02).
    //
    // Only fires when every condition holds:
    // - the tenant's toggle is on (fail-safe read: off on any error),
    // - the classification mutates the account and the origin is upstream,
    // - the category is a target (quota_exhausted / rate_limit_transient),
    // - the verdict is a cooldown (rule-level `disabled` verdicts — bans,
    //   revoked credentials — are untouched),
    // - the provider did not state a sub-5-minute window (D04: Inception's
    //   1m limit must keep its short cooldown, not park the account for 24h).
    const autoDisableTarget =
      AUTO_DISABLE_TARGET_CATEGORIES.has(effective.category) &&
      effective.status === "cooldown" &&
      effective.mutatesAccount &&
      options?.origin === "upstream";
    const statedTooShort =
      effective.providerStated === true &&
      effective.cooldownMs > 0 &&
      effective.cooldownMs < AUTO_DISABLE_STATED_MIN_MS;
    let autoDisableActive = false;
    if (autoDisableTarget && !statedTooShort) {
      autoDisableActive = await autoDisableRateLimitedEnabled(client, account.tenantId);
    }
    // Rewritten classification used by the write paths below.
    const interception = autoDisableActive
      ? {
          ...effective,
          status: "disabled" as const,
          cooldownMs: resolveAccountDisabledRecoveryMs(),
          ruleSource: "fallback" as const,
        }
      : effective;

    const modelId = options?.modelId;
    // Every category here is a verdict about one (account, model) pair rather
    // than about the credential, so all three back off that pair and leave the
    // account routable for every other model. `model_unreachable` joins the two
    // throttles on the same reasoning: an upstream that reports the model does
    // not exist for this account will report it again on the next request.
    const isThrottle =
      effective.category === "rate_limit_transient" ||
      effective.category === "model_capacity" ||
      effective.category === "model_unreachable";
    // D02: when the auto-disable intercept fired, the target category must not
    // sink into a model-scoped cooldown — the outcome is an account-wide
    // disable.
    const shouldModelCooldown = !autoDisableActive && modelId !== undefined && isThrottle;
    // The account-wide streak, escalated for a provider-stated window. Read once
    // so the model-scoped and account-wide paths below cannot disagree about it:
    // this is the count *before* this failure, which the UPDATE below increments.
    const streak = Math.max(0, account.consecutiveFailures ?? 0);
    // Tier-aware rule resolution (area 03, D15–D19): the account's plan is
    // projected on this row, mapped to a tier, and — when a rule exists for
    // the (provider, category, tier) combination — replaces the classifier's
    // duration. The rule duration is a policy decision and never escalates
    // (D18); escalation applies only to the fallback.
    const accountTier =
      account.quotaPlan === null || account.quotaPlan === undefined
        ? null
        : mapPlanToTier(account.providerId, account.quotaPlan);
    // A provider-stated window always wins over a tier rule (D18), so the rule
    // is only consulted when the upstream named nothing.
    const ruleCooldownMs =
      interception.providerStated === true
        ? undefined
        : resolveCooldownRule({
            providerId: account.providerId,
            category: effective.category,
            tier: accountTier,
          });
    const ruleSource = interception.ruleSource;
    const sourceCooldownMs =
      ruleCooldownMs !== undefined ? ruleCooldownMs : interception.cooldownMs;
    const sourceRuleKind: "provider-rule" | "fallback" | undefined =
      ruleCooldownMs !== undefined ? "provider-rule" : ruleSource;
    // The auto-disable recovery window is a policy duration like a tier rule:
    // it must never pass through the fallback escalation ladder, or the 1h cap
    // would truncate the default 24h recovery on the first unstated 429 (D18).
    const resolvedCooldownMs = autoDisableActive
      ? interception.cooldownMs
      : applyRuleEscalation(
          sourceCooldownMs,
          interception.providerStated === true,
          streak,
          sourceRuleKind,
        );
    // When a rule replaces the duration, the classifier's `retryAt` (computed
    // from the old constant/fallback) is stale: a shorter rule would lose to it
    // in the monotonic-max deadline. Recompute from the rule duration instead.
    const retryAtMs =
      ruleCooldownMs !== undefined
        ? Date.now() + ruleCooldownMs
        : effective.retryAt?.getTime();

    // The unsupported-model ladder, computed before the branch: the classifier
    // could only state the base window because the authoritative hit count
    // lives on the row, and it is read here. `hits` is the new total for this
    // pair, so the first report is 1 and gets the base window.
    const blockHits = (account.modelBlockHits as Record<string, number> | null) ?? {};
    const unsupportedHits =
      effective.modelUnsupported === true && modelId !== undefined
        ? Math.max(1, (blockHits[modelId] ?? 0) + 1)
        : undefined;
    // An unsupported-model window is stated by *us*, not by the provider, so it
    // would otherwise be multiplied a second time by `escalateFallbackCooldown`
    // (which reads `consecutiveFailures`, an account-wide counter). The two
    // ladders are different things: one counts how many times this pair was
    // reported unsupported, the other how many failures this account produced.
    const unsupportedCooldownMs =
      unsupportedHits === undefined ? undefined : unsupportedModelCooldownMs(unsupportedHits);

    if (shouldModelCooldown) {
      const existing = (account.modelCooldowns as Record<string, string> | null) ?? {};
      // Monotonic: never move an in-force window earlier (see `latestDeadlineMs`).
      // A provider-stated deadline wins outright because it is already the later
      // of the two whenever the provider really parked the pair longer.
      const previousDeadline = existing[modelId] === undefined ? undefined : Date.parse(existing[modelId]);
      const nextDeadline = latestDeadlineMs(
        retryAtMs,
        Date.now() + (unsupportedCooldownMs ?? resolvedCooldownMs),
        previousDeadline,
      );
      const nextUntil = new Date(nextDeadline).toISOString();
      const previousUntil = existing[modelId];
      // A re-statement is not an event: what the audit row reports is the
      // *entry* into a cooling episode, and the deadline itself is not a
      // column — so a row can only ever say "this pair started cooling for
      // this reason". The upstream answers the same "Try again in 11h" on
      // every retry (and an unstated reset is recomputed from now each time),
      // so writing per failure produced seven identical rows in twenty minutes
      // and read as an account flapping when nothing had changed. The entry is
      // still refreshed below — its error fields are what the dialog explains
      // the cooldown with — while an entry that is still in force suppresses
      // the duplicate row.
      const alreadyCooling =
        previousUntil !== undefined && new Date(previousUntil).getTime() > Date.now();
      // `status`/`cooldownUntil` stay untouched: only this (account, model)
      // pair backs off, and the account remains routable for every other model.
      // The error fields ARE written, because they are what provider detail and
      // the health dialog read to explain *why* a model is cooling — without
      // them the row showed "1 model cooling" with no reason at all.
      //
      // The streak advances here too. Without it the most common throttle — a
      // model-scoped rate limit — never escalated, because the counter was only
      // incremented on the account-wide path below, and `consecutiveFailures`
      // stays honest about what it always claimed to count: how many failures in
      // a row this account has just produced.
      await client
        .update(providerAccounts)
        .set({
          modelCooldowns: { ...existing, [modelId]: nextUntil },
          // Counted only for the unsupported-model ladder, and only when this
          // failure is that verdict — so a rate limit or a capacity refusal
          // never advances it. `model_cooldowns`' own shape is untouched, so
          // routing and the console keep parsing it exactly as before.
          ...(unsupportedHits === undefined
            ? {}
            : { modelBlockHits: { ...blockHits, [modelId]: unsupportedHits } }),
          consecutiveFailures: sql`${providerAccounts.consecutiveFailures} + 1`,
          lastError: effective.reason,
          lastErrorCategory: effective.category,
          lastErrorAt: now,
        })
        .where(eq(providerAccounts.id, accountId));
      if (!alreadyCooling) {
        await writeHealthEvent(client, {
          entityKind: "account",
          accountId,
          // The account's own status, on both sides: a model-scoped throttle
          // never moved it, and writing the classification's status here
          // claimed an `active → cooldown` transition that never happened — the
          // dialog showed "Account status: ACTIVE" above a list of transitions
          // to `cooldown`. The row still names the model and the reason, which
          // is what makes it worth keeping.
          fromStatus: fromStatus as "active" | "cooldown" | "disabled",
          toStatus: fromStatus as "active" | "cooldown" | "disabled",
          reason: effective.reason,
          errorCategory: effective.category,
          modelId: modelId ?? null,
          createdAt: now,
        });
      }
      // The route catalog projects modelCooldowns and stamps this candidate as
      // model_cooldown. Invalidate when its deadline changes, or the cached
      // snapshot keeps routing this pair until some unrelated write rebuilds it.
      return {
        ...classification,
        routesVisible: previousDeadline !== nextDeadline,
        ...(sourceRuleKind === undefined ? {} : { ruleSource: sourceRuleKind }),
      };
    }

    // When the intercept fired, the reason is prefixed with the auto-disable
    // marker — `sweepExpiredCooldowns` (D03/R-B) uses the prefix to tell an
    // auto-disable apart from an operator disable, which stays terminal.
    const writtenReason = autoDisableActive
      ? `${AUTO_DISABLE_MARKER_PREFIX}${effective.reason}`
      : effective.reason;
    // A disabled account's deadline is the auto-disable recovery window — the
    // classifier's `retryAt`/cooldown duration must not leak in, or a terminal
    // disable (`recovery = 0`) would gain a deadline and be swept back.
    const deadlineCandidates = autoDisableActive
      ? [interception.cooldownMs > 0 ? Date.now() + interception.cooldownMs : undefined]
      : [
          retryAtMs,
          resolvedCooldownMs > 0 ? Date.now() + resolvedCooldownMs : undefined,
          account.cooldownUntil?.getTime?.(),
        ];
    await client
      .update(providerAccounts)
      .set({
        status: interception.status,
        consecutiveFailures: sql`${providerAccounts.consecutiveFailures} + 1`,
        lastError: writtenReason,
        lastErrorCategory: effective.category,
        lastErrorAt: now,
        // Monotonic against the account's own in-force deadline, for the same
        // reason as the model path: an unclassified 60-second failure must not
        // release an account the provider parked for hours.
        //
        // A `0` duration contributes no candidate rather than stamping *now*
        // (see `accountDeadlineMs`): the one state that asks for it is a
        // terminal automatic disable, and an elapsed deadline there would hand
        // the row straight back to the recovery sweep.
        cooldownUntil: accountDeadlineMs(deadlineCandidates),
      })
      .where(eq(providerAccounts.id, accountId));

    {
      await writeHealthEvent(client, {
        entityKind: "account",
        accountId,
        fromStatus: fromStatus as "active" | "cooldown" | "disabled",
        toStatus: interception.status,
        reason: writtenReason,
        errorCategory: effective.category,
        modelId: modelId ?? null,
        createdAt: now,
      });
    }
    // This path wrote `status` and `cooldownUntil`, both of which the snapshot
    // projects, so routing has to see it.
    return {
      ...classification,
      routesVisible: true,
      ...(sourceRuleKind === undefined ? {} : { ruleSource: sourceRuleKind }),
    };
  };

  return withTransaction(db, persist, null);
}

/** Clears failure state after a successful dispatch; true when the account changed. */
export async function recordAccountSuccess(
  db: CartethyiaDatabase,
  accountId: string,
): Promise<boolean> {
  const mutate = async (client: CartethyiaDatabase): Promise<boolean> => {
    // `recordAccountSuccess` runs on every successful dispatch, and for a
    // healthy account `hadFailures` is false — the row was fetched purely to
    // decide nothing. Projected so that no-op path does not pull the
    // credential ciphertext across the wire.
    const rows = await client
      .select({
        status: providerAccounts.status,
        consecutiveFailures: providerAccounts.consecutiveFailures,
        // Read only to decide whether there is anything to clear: the common
        // case (no unsupported-model hit ever recorded) must not write.
        modelBlockHits: providerAccounts.modelBlockHits,
      })
      .from(providerAccounts)
      .where(eq(providerAccounts.id, accountId))
      .limit(1);
    const account = rows[0];
    if (!account || account.status === "disabled") return false;
    const fromStatus = account.status;
    const hadFailures = (account.consecutiveFailures ?? 0) > 0 || account.status !== "active";
    const now = new Date();
    // The unsupported-model escalation restarts after a success: a model that
    // just served is not "not supported", so the next report of it must start
    // from the base window again rather than from wherever the ladder had
    // reached. `modelCooldowns` is deliberately NOT cleared — an in-force
    // window the provider stated survives, which is the existing behavior and
    // the reference gateways' too.
    const blockHits = account.modelBlockHits as Record<string, number> | null;
    const hasBlockHits = blockHits !== null && Object.keys(blockHits).length > 0;
    await client
      .update(providerAccounts)
      .set({
        status: "active",
        consecutiveFailures: 0,
        cooldownUntil: null,
        lastSuccessAt: now,
        ...(hadFailures ? { lastRecoveredAt: now } : {}),
        ...(hasBlockHits ? { modelBlockHits: {} } : {}),
      })
      .where(eq(providerAccounts.id, accountId));
    if (hadFailures && typeof client.insert === "function") {
      await client.insert(healthEvents).values({
        id: randomUUID(),
        entityKind: "account",
        accountId,
        fromStatus: fromStatus as "active" | "cooldown" | "disabled",
        toStatus: "active",
        reason: "Request dispatched successfully",
        errorCategory: null,
        createdAt: now,
      });
    }
    return hadFailures;
  };
  return withTransaction(db, mutate, false);
}

/** Operator-initiated recovery: forces the account back to active and logs the transition. */
export async function recoverAccount(
  db: CartethyiaDatabase,
  accountId: string,
  reason = "manual_operator_recovery",
): Promise<boolean> {
  const recover = async (client: CartethyiaDatabase): Promise<boolean> => {
    const accountRows = await client
      .select()
      .from(providerAccounts)
      .where(eq(providerAccounts.id, accountId))
      .limit(1);
    const account = accountRows[0];
    if (!account) return false;
    const fromStatus = account.status;
    const now = new Date();
    await client
      .update(providerAccounts)
      .set({
        status: "active",
        consecutiveFailures: 0,
        cooldownUntil: null,
        lastRecoveredAt: now,
        // Recovery is the operator asserting the account works now, so it must
        // clear EVERY routing exclusion, not just the account-wide ones. A
        // per-model cooldown entry excludes the (account, model) pair in
        // `route-catalog.ts`, so leaving it behind kept the account blocked for
        // that model through `/v1` even though the account read `active` and a
        // direct probe (which addresses the account by id, bypassing routing
        // eligibility) succeeded. Clearing the error fields for the same reason:
        // a stale reason on a recovered row misreports the current state.
        modelCooldowns: {},
        lastError: null,
        lastErrorCategory: null,
        lastErrorAt: null,
      })
      .where(eq(providerAccounts.id, accountId));
    {
      await writeHealthEvent(client, {
        entityKind: "account",
        accountId,
        fromStatus: fromStatus as "active" | "cooldown" | "disabled",
        toStatus: "active",
        reason,
        errorCategory: null,
        createdAt: now,
      });
    }
    return true;
  };
  return withTransaction(db, recover, false);
}

/** Recovers accounts whose cooldown elapsed and prunes expired per-model keys. */
export async function sweepExpiredCooldowns(db: CartethyiaDatabase): Promise<number> {
  const recover = async (client: CartethyiaDatabase): Promise<number> => {
    const now = new Date();
    const nowIso = now.toISOString();
    const expired = await client
      .select({
        id: providerAccounts.id,
        status: providerAccounts.status,
      })
      .from(providerAccounts)
      .where(
        // An ordinary cooldown, recovered as soon as its window elapses; plus
        // (D03/R-B) an account the *auto-disable* intercept disabled — only
        // when its category is a target AND the reason carries the auto-disable
        // marker AND its recovery deadline has elapsed. An auto-disable is the
        // machine's own verdict, so the sweep may undo it; an operator disable
        // (no marker) stays terminal.
        and(
          or(
            and(
              eq(providerAccounts.status, "cooldown"),
              isNotNull(providerAccounts.cooldownUntil),
              lte(providerAccounts.cooldownUntil, now),
            ),
            and(
              eq(providerAccounts.status, "disabled"),
              inArray(providerAccounts.lastErrorCategory, [...AUTO_DISABLE_TARGET_CATEGORIES]),
              isNotNull(providerAccounts.lastError),
              like(providerAccounts.lastError, `${AUTO_DISABLE_MARKER_PREFIX}%`),
              isNotNull(providerAccounts.cooldownUntil),
              lte(providerAccounts.cooldownUntil, now),
            ),
          ),
        ),
      )
      // One pass recovers a bounded batch. The sweep runs every 30s, so a
      // backlog larger than this drains over successive ticks instead of one
      // statement covering every expired row — that statement holds its locks
      // for as long as the backlog takes.
      .limit(COOLDOWN_RECOVERY_BATCH);
    if (expired.length > 0) {
      await client
        .update(providerAccounts)
        .set({
          status: "active",
          consecutiveFailures: 0,
          cooldownUntil: null,
          lastRecoveredAt: now,
          // Cleared with the state it described. A recovered row that kept
          // `auth_invalidated` still rendered the console's "Re-login required"
          // pill above an `active` status, so the account read healthy to
          // routing and broken to the operator at the same time.
          lastErrorCategory: null,
        })
        .where(inArray(providerAccounts.id, expired.map((account) => account.id)));
      if (typeof client.insert === "function") {
        for (let offset = 0; offset < expired.length; offset += 500) {
          await client.insert(healthEvents).values(
            expired.slice(offset, offset + 500).map((account) => ({
              id: randomUUID(),
              entityKind: "account" as const,
              accountId: account.id,
              fromStatus: account.status,
              toStatus: "active" as const,
              reason: "Cooldown period elapsed — auto-recovered",
              errorCategory: null,
              createdAt: now,
            })),
          );
        }
      }
    }

    // Prune per-model cooldowns: remove entries whose ISO timestamp has passed.
    //
    // One set-based UPDATE rather than a SELECT followed by an UPDATE per row.
    // The per-row form issued one statement per account holding any cooldown —
    // on a deployment where many accounts are throttled at once that is the
    // sweep's dominant cost, and it all runs inside this transaction, holding
    // its locks for the whole pass. Recomputing the object in SQL does the same
    // work in one statement.
    //
    // `jsonb_typeof(...) = 'object'` guards the shape: a malformed value must
    // not abort the whole sweep. `IS DISTINCT FROM` keeps the update from
    // rewriting rows it
    // did not change, so the returned row count is the number of accounts whose
    // cooldown set actually shrank — the same thing the loop counted.
    const pruning = pruneExpiredCooldowns(sql`${providerAccounts.modelCooldowns}`, sql`${nowIso}`);
    const pruned = await client
      .update(providerAccounts)
      .set({ modelCooldowns: pruning.value })
      .where(pruning.changed);
    return expired.length + affectedRows(pruned);
  };
  return withTransaction(db, recover, 0);
}

/**
 * Single attempt health reporter: one home for the success/failure writes
 * every dispatch attempt ends with. Success records recovery; failure
 * records with caller-supplied evidence (origin/scope classification plus
 * model id). A mutating write invalidates the route snapshot so the next
 * plan sees fresh health. Never throws — health must not fail requests.
 */
export interface AttemptHealthReport {
  readonly accountId: string | undefined;
  readonly modelId?: string;
  readonly error?: unknown;
  readonly evidence?: AccountFailureEvidence;
  readonly snapshotService?: { invalidate(): unknown };
}

/**
 * Writes one health audit row, off the request path when a buffer is installed.
 *
 * `health_events` is append-only and read by nobody in the request path, so it
 * does not need to land before the request finishes — unlike the
 * `provider_accounts` UPDATE beside it, which routing reads and which therefore
 * stays synchronous and transactional.
 */
async function writeHealthEvent(
  client: CartethyiaDatabase,
  row: {
    readonly entityKind: "account";
    readonly accountId: string;
    readonly fromStatus: "active" | "cooldown" | "disabled" | null;
    readonly toStatus: "active" | "cooldown" | "disabled";
    readonly reason: string;
    readonly errorCategory: string | null;
    readonly modelId?: string | null;
    readonly createdAt: Date;
  },
): Promise<void> {
  const buffer = healthEventBuffer();
  if (buffer !== undefined) {
    buffer.enqueue({ ...row, modelId: row.modelId ?? null });
    return;
  }
  if (typeof client.insert !== "function") return;
  await client.insert(healthEvents).values({ id: randomUUID(), ...row });
}

/**
 * The one internal seam that applies a health verdict to an account row.
 *
 * Every producer that persists account-state semantics — dispatch failure
 * classification, OAuth refresh definitive failure, quota refresh parking —
 * converges here instead of writing `status`/`cooldownUntil`/error fields
 * independently. Producers may still classify differently; they may not
 * persist account-state semantics separately.
 *
 * This writes the account-wide health state plus a health audit row, inside the
 * caller's transaction (`client`). It returns `true` when the account row was
 * actually updated (i.e. the account exists and is not operator-disabled with
 * `preserveOperatorDisable`), so the caller knows whether routing must be
 * invalidated (routesVisible) or the lease released.
 */
export async function applyAccountVerdict(
  client: CartethyiaDatabase,
  verdict: {
    readonly accountId: string;
    readonly status: "cooldown" | "disabled";
    readonly reason: string;
    readonly category: string | null;
    readonly cooldownUntil?: Date | null;
    /** When true, an operator-disable (status `disabled`, no deadline) is left untouched. */
    readonly preserveOperatorDisable?: boolean;
    /** Health event transition status (defaults to the verdict status). */
    readonly fromStatus?: "active" | "cooldown" | "disabled" | null;
    readonly modelId?: string | null;
    readonly createdAt?: Date;
  },
): Promise<boolean> {
  return withTransaction(
    client,
    async (tx) => {
      const rows = await tx
        .select({
          status: providerAccounts.status,
          cooldownUntil: providerAccounts.cooldownUntil,
        })
        .from(providerAccounts)
        .where(eq(providerAccounts.id, verdict.accountId))
        .limit(1);
      const row = rows[0];
      if (!row) return false;
      if (verdict.preserveOperatorDisable === true) {
        const isOperatorDisable = row.status === "disabled" && row.cooldownUntil == null;
        if (isOperatorDisable) return false;
      }
      const now = verdict.createdAt ?? new Date();
      await tx
        .update(providerAccounts)
        .set({
          status: verdict.status,
          lastError: (verdict.reason ?? "Account failed").slice(0, 500),
          lastErrorCategory: verdict.category ?? "check_failed",
          lastErrorAt: now,
          ...(verdict.cooldownUntil === undefined
            ? {}
            : { cooldownUntil: verdict.cooldownUntil }),
        })
        .where(eq(providerAccounts.id, verdict.accountId));
      await writeHealthEvent(tx, {
        entityKind: "account",
        accountId: verdict.accountId,
        fromStatus: verdict.fromStatus ?? (row.status as "active" | "cooldown" | "disabled" | null),
        toStatus: verdict.status,
        reason: verdict.reason,
        errorCategory: verdict.category,
        modelId: verdict.modelId ?? null,
        createdAt: now,
      });
      return true;
    },
    false,
  );
}

export async function reportAttemptOutcome(
  db: CartethyiaDatabase,
  report: AttemptHealthReport,
): Promise<void> {
  if (!report.accountId) return;
  if (report.error === undefined) {
    const recovered = await recordAccountSuccess(db, report.accountId).catch(() => false);
    if (recovered) await report.snapshotService?.invalidate();
    return;
  }
  const classification = await recordAccountFailure(db, report.accountId, report.error, {
    ...report.evidence,
    ...(report.modelId === undefined ? {} : { modelId: report.modelId }),
  }).catch(() => null);
  // Gated on `routesVisible`, not on `mutatesAccount`: a model cooldown changes
  // routing, while a repeated report with the same deadline or a streak-only
  // write does not.
  if (classification?.routesVisible) await report.snapshotService?.invalidate();
}

export async function listAccountHealthEvents(
  db: CartethyiaDatabase,
  accountId: string,
  limit = 50,
): Promise<readonly AccountHealthEventRecord[]> {
  try {
    const rows = await db
      .select()
      .from(healthEvents)
      .where(and(eq(healthEvents.entityKind, "account"), eq(healthEvents.accountId, accountId)))
      .orderBy(desc(healthEvents.createdAt))
      .limit(limit);

    return rows.map((r) => ({
      id: r.id,
      accountId: r.accountId as string,
      fromStatus: r.fromStatus,
      toStatus: r.toStatus,
      modelId: r.modelId ?? null,
      reason: r.reason,
      errorCategory: r.errorCategory,
      createdAt: r.createdAt.toISOString(),
    }));
  } catch {
    return [];
  }
}

/** Every stored row across accounts and pools — the size the purge offers to delete. */
export async function countAllHealthEvents(db: CartethyiaDatabase): Promise<number> {
  try {
    const rows = await db.select({ total: count() }).from(healthEvents);
    return rows[0]?.total ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Deletes stored health & error rows.
 *
 * Unlike the read above, a failed delete surfaces: an operator who purged
 * believes the trail is gone, so "it failed" must not read as "it succeeded
 * with zero rows". Callers own the flush-buffer barrier (`drain`) so a queued
 * write cannot land after these rows are gone.
 */
export async function deleteAccountHealthEvents(
  db: CartethyiaDatabase,
  accountId: string,
): Promise<number> {
  const rows = await db
    .delete(healthEvents)
    .where(and(eq(healthEvents.entityKind, "account"), eq(healthEvents.accountId, accountId)))
    .returning({ id: healthEvents.id });
  return rows.length;
}

export async function deleteAllHealthEvents(db: CartethyiaDatabase): Promise<number> {
  const rows = await db.delete(healthEvents).returning({ id: healthEvents.id });
  return rows.length;
}
