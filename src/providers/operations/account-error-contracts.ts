/**
 * Shared contract for account error classification: the evidence/result types,
 * the ordered-rule shape, and the pure helpers both the classifier and the
 * `provider-rules/*` families read. No I/O, no env reads — every cooldown
 * resolver stays behind a call site so this file stays a leaf module.
 */
import type { AccountTier } from "./account-tier";
import { resolveAccountCooldownEscalationMaxMs } from "../../config/cooldowns";

// ===== health/account-recorder.ts =====
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

export type AccountErrorCategory =
  | "quota_exhausted"
  | "rate_limit_transient"
  | "model_capacity"
  | "model_unreachable"
  | "auth_invalidated"
  /**
   * A credential rejection the upstream stated but that is *recoverable*: the
   * verdict cools the account down (`status: "cooldown"`) instead of disabling
   * it, because the evidence is weak — a bare 401/403, an expired-but-
   * refreshable token, or a static token that may still work. Distinguished
   * from {@link auth_invalidated}, which is the terminal verdict reserved for
   * a named revocation or a definitive refresh-grant failure: that state
   * needs a re-login, this one heals on its own.
   */
  | "auth_rejected"
  /**
   * The upstream banned this credential: a verdict on the account, e.g. buddy
   * `11140` "request illegal" with "Your account has been restricted due to
   * unusual activity". Cooldown cannot help — the account is not throttled, it
   * is refused. Disabling immediately is a *feature*: a client's retry budget
   * is spent in seconds, so surviving attempts burn sibling accounts that are
   * still healthy.
   */
  | "policy_blocked_banned"
  /**
   * The upstream refused this request: a verdict on the request. e.g. buddy
   * `11-128` "request illegal" with no account restriction. Distinguished from
   * {@link policy_blocked_banned} because the correct responses differ — a
   * banned account must be disabled, a malformed request must only stop being
   * retried verbatim.
   */
  | "policy_blocked_invalid_request"
  | "server_error"
  | "timeout"
  | "validation_required"
  | "unknown";
export type AccountFailureOrigin = "cartethyia" | "upstream" | "network";
export type AccountFailureScope =
  | "account"
  | "provider"
  | "model"
  | "pool"
  | "tenant"
  | "request"
  | "network"
  | "unknown";

export interface AccountFailureEvidence {
  readonly origin?: AccountFailureOrigin;
  readonly scope?: AccountFailureScope;
  readonly credentialKind?: string;
  /**
   * The account's credential is a static bearer token used as issued and never
   * refreshed. An auth rejection against a static token is not a refreshable
   * fault: refreshing cannot help, and disabling the account discards a token
   * that may still be valid for other requests. Such a failure cools the
   * account down instead of parking it.
   */
  readonly staticToken?: boolean;
  readonly providerCode?: string;
  readonly credentialEvidence?: boolean;
  readonly retryAfterMs?: number;
  readonly statusCode?: number | null;
  readonly headers?: Headers | Record<string, string> | null;
  readonly modelId?: string;
  /**
   * Provider that produced the failure. Used only for the one
   * provider-family-specific policy rule (the buddy family's `11140`
   * content-policy block), never to broaden what disables an account.
   */
  readonly providerId?: string;
  /**
   * How many times this (account, model) pair has already been reported
   * unsupported, when the caller has read them. Best-effort: the classifier
   * states the base window without it, and the writer recomputes against the
   * count it reads itself.
   */
  readonly modelBlockHits?: number;
  /**
   * The upstream's own error body, when the caller has it.
   *
   * Providers state a reset window in structured fields far more reliably than
   * in prose — a body carrying `resets_at`, `resets_in_seconds` or
   * `limit_window_minutes` is an exact statement, while the same body's
   * `message` ("The usage limit has been reached") names no window at all.
   * Without this the classifier falls back to a fixed 15-minute cooldown for a
   * limit the provider said resets in 23 days.
   */
  readonly upstreamBody?: unknown;
  /**
   * The account's tier, derived from its plan (`mapPlanToTier`). Read only by
   * the writer when it resolves tier-aware cooldown rules; the classifier
   * itself does not branch on it.
   */
  readonly accountTier?: AccountTier;
}

/**
 * One arm of the classifier: an ordered `(match, decide)` pair.
 *
 * The arms are **not** independent predicates. Later arms are deliberately
 * broader than earlier ones — `quotaSignal` matches every price refusal, and
 * `authSignal` matches a superset of the request-scoped codes — so a match
 * only wins because it is tried first. That is why they live in one ordered
 * list rather than behind a dispatch map or a set of independent `if`s: the
 * list is the precedence, and reading it top to bottom is reading the
 * decision.
 *
 * `match` is a pure function of the shared signals (no closure over the
 * classifier's locals, no allocation per classification): the table is built
 * once per call from values already computed for every arm.
 */
export interface AccountErrorRule {
  readonly name: string;
  readonly match: (signals: AccountErrorSignals) => boolean;
  readonly decide: (signals: AccountErrorSignals) => AccountErrorClassification;
}

/**
 * The result-builder signature every arm calls. Kept structural (not tied to
 * the evidence module's `AccountErrorContext`) so this file stays a leaf.
 */
export type AccountErrorResult = (
  category: AccountErrorCategory,
  status: AccountErrorClassification["status"],
  cooldownMs: number,
  retryAt: Date | null,
  explanation: string,
  mutatesAccount?: boolean,
  modelUnsupported?: boolean,
  modelScoped?: boolean,
) => AccountErrorClassification;

/** The shared signals every arm reads, computed once per classification. */
export interface AccountErrorSignals {
  readonly message: string;
  readonly lower: string;
  readonly folded: string;
  readonly statusCode: number | null;
  readonly origin: AccountFailureOrigin;
  readonly scope: AccountFailureScope;
  readonly providerCode: string;
  readonly statedCooldownMs: number | null;
  readonly reason: (prefix: string) => string;
  readonly result: AccountErrorResult;
  readonly canMutate: boolean;
  readonly accountEvidence: boolean;
  readonly revocationNamed: boolean;
  /** Echo of the caller's evidence; read only by the arms that need it. */
  readonly providerId: string | undefined;
  readonly modelId: string | undefined;
  readonly modelBlockHits: number;
  readonly staticToken: boolean;
  readonly credentialKind: string | undefined;
  /** Buddy-family provider: the only family with provider-specific codes below. */
  readonly buddyBanned: boolean;
  readonly priceRefusal: boolean;
  readonly quotaSignal: boolean;
  readonly policyRejection: boolean;
  /** Deployment/proxy pool failure: transport infrastructure, not the account. */
  readonly deploymentInfraError: boolean;
  /** A buddy-family (account, model) frequency window the provider named a reset for. */
  readonly modelFrequencyWindow: boolean;
  /** A Zcode Start Plan refusal that named the selected model. */
  readonly zcodeTrialRefused: boolean;
  readonly hostedToolFailure: boolean;
  readonly modelEntitlementFailure: boolean;
  readonly queuedUpstream: boolean;
  readonly validationRequired: boolean;
  readonly validationUrl: string | undefined;
  /** True when this failure should switch to a sibling account rather than wait. */
  readonly rotateAccount: boolean;
}

export interface AccountErrorClassification {
  readonly category: AccountErrorCategory;
  readonly status: "cooldown" | "disabled";
  readonly cooldownMs: number;
  readonly reason: string;
  readonly retryAt: Date | null;
  readonly mutatesAccount: boolean;
  /**
   * True when this write changed a field the routing snapshot actually reads.
   *
   * Routing reads account-wide `status`/`cooldownUntil` and the per-model
   * `modelCooldowns` map (`route-catalog.ts`). Writes to any of those must drop
   * the snapshot; failure streaks and diagnostic text remain invisible to
   * routing.
   *
   * Only a changed deadline is routing-visible. Re-reporting the same active
   * model cooldown must not rebuild the snapshot again.
   */
  readonly routesVisible: boolean;
  /**
   * True when `cooldownMs` came from the provider's own statement — a parsed
   * `Retry-After`-family header, or a reset quoted in its message — rather than
   * from one of this module's fallback constants.
   *
   * A property of the *evidence*, not of the category, so it is the same for
   * every branch of one classification. Only {@link escalateFallbackCooldown}
   * reads it: a provider-stated window is the truth and is never multiplied.
   */
  readonly providerStated?: boolean;
  /**
   * The window the provider itself stated, in milliseconds, when the evidence
   * carried one (`null`/`undefined` when it did not). This is the *raw* stated
   * value, before any rule floors or defaults it — `cooldownMs` may be larger
   * (the rate-limit arm floors a trivially short `retry_after` up to the
   * configured cooldown). Writers that need the provider's own number — the
   * auto-disable gate's sub-5-minute exemption — read this, not `cooldownMs`.
   */
  readonly statedCooldownMs?: number | null;

  /**
   * True when the classification is a verdict on the *credential* (not a
   * transient backoff): the request should rotate to a sibling account now
   * instead of waiting out the cooldown on this one. Usage-limit exhaustion,
   * spending caps, and banned/revoked credentials rotate; per-minute
   * throttles (TPM/RPM), model-capacity overload, and concurrency caps back
   * off on the same account instead.
   */
  readonly rotateAccount?: boolean;
  /**
   * True when the upstream reported the model as one it does not serve (the
   * buddy family's `11102`), rather than one this account merely cannot reach.
   *
   * A property of the classification, because both verdicts land in the same
   * `model_unreachable` category and the writer cannot otherwise tell them
   * apart — it needs to know whether to count the hit and escalate the window.
   */
  readonly modelUnsupported?: boolean;
  /**
   * This quota verdict closes only the requested model on an otherwise usable
   * account. Kept separate from `category`: quota exhaustion remains the
   * operator-facing cause, while the writer routes it through modelCooldowns.
   */
  readonly modelScoped?: boolean;
  /**
   * Where the cooldown duration came from (D18). A duration resolved from a
   * tier/provider rule (`provider-rule`) is a policy decision and must NOT go
   * through `escalateFallbackCooldown` — the 1h escalation cap would cut the
   * 24h Trae rule down to an hour on the first failure. Only a pure fallback
   * (`fallback`) escalates.
   */
  readonly ruleSource?: "provider-rule" | "fallback";
}

/**
 * How many doublings a fallback cooldown may take before the cap takes over.
 *
 * Four is enough to reach the cap from every fallback default (the longest is
 * the 1h quota fallback, which reaches it on the first doubling) while keeping
 * the ladder short enough to reason about.
 */
const COOLDOWN_ESCALATION_MAX_LEVEL = 4;

/**
 * Accounts one cooldown-recovery pass brings back. The sweep ticks every 30s,
 * so a larger backlog drains over successive passes rather than one statement
 * covering every expired row.
 */
export const COOLDOWN_RECOVERY_BATCH = 500;

/**
 * A provider code that is digits only. Such codes are identifiers, not auth
 * vocabulary — providers encode spend/entitlement verdicts as numbers (Qoder's
 * `110`, buddy's `6004`) — so the bare-401/403 credential arm must not treat
 * an unknown one as evidence that the credential died.
 */
export const NUMERIC_PROVIDER_CODE = /^\d+$/;

/**
 * Escalates a *fallback* cooldown for an account that keeps failing.
 *
 * `consecutiveFailures` has been incremented on every account failure since the
 * health machine was written, but nothing ever read it — so a broken upstream
 * was re-dialled once a minute forever, and an account whose quota had an
 * unstated reset came straight back into rotation every time its short fallback
 * lapsed. The count is now a backoff level: each further consecutive failure
 * doubles the fallback, clamped to the escalation cap resolver.
 *
 * Two guards keep it from overriding the provider. A duration the provider
 * *stated* is never multiplied — that window is the truth. And the caller writes
 * the result through a monotonic maximum, so a burst of concurrent in-flight
 * failures advances the deadline to the longest of them instead of compounding
 * once per failure.
 */
export function escalateFallbackCooldown(
  cooldownMs: number,
  providerStated: boolean,
  consecutiveFailures: number,
): number {
  if (providerStated || cooldownMs <= 0) return cooldownMs;
  const level = Math.min(Math.max(0, consecutiveFailures), COOLDOWN_ESCALATION_MAX_LEVEL);
  return Math.min(cooldownMs * 2 ** level, resolveAccountCooldownEscalationMaxMs());
}

/**
 * Returns a cooldown duration with the D18 escalation split applied.
 *
 * A duration that came from a tier/provider rule (`ruleSource === "provider-rule"`)
 * is a policy decision and must never pass through
 * {@link escalateFallbackCooldown}: the 1h cap would truncate the 24h Trae
 * free-tier rule to one hour on the first failure. Only a pure fallback
 * (`ruleSource === "fallback"`, or unset for callers that predate the split)
 * escalates.
 */
export function applyRuleEscalation(
  cooldownMs: number,
  providerStated: boolean,
  consecutiveFailures: number,
  ruleSource: "provider-rule" | "fallback" | undefined,
): number {
  if (ruleSource === "provider-rule") return cooldownMs;
  return escalateFallbackCooldown(cooldownMs, providerStated, consecutiveFailures);
}

/**
 * The later of a candidate deadline and the one already recorded.
 *
 * Every fallback duration is recomputed from *now* on each failure, so writing
 * it unconditionally let a fresh short failure *shorten* a longer window already
 * in force: a 60-second unclassified cooldown overwrote the provider's own
 * "Try again in 11h" and released the pair back into rotation inside a window
 * the upstream had closed, where it failed again — once a minute, forever.
 * A cooling deadline may only ever move later.
 */
export function latestDeadlineMs(...candidates: readonly (number | undefined | null)[]): number {
  let latest = 0;
  for (const value of candidates) {
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    if (value > latest) latest = value;
  }
  return latest;
}

/**
 * The account-wide deadline to write, or `null` for "no deadline".
 *
 * {@link latestDeadlineMs} cannot express *no* deadline — it floors at 0 — and
 * the account-wide write has one state that needs it. With
 * `CARTETHYIA_ACCOUNT_DISABLED_RECOVERY_MS=0` an automatic disable is meant to
 * be terminal again, and the classifier correctly reports `retryAt: null`.
 * Deriving the deadline from `Date.now() + cooldownMs` instead stamps *now*.
 * The recovery sweep then treats that elapsed deadline as
 * an automatic disable awaiting recovery and returns the row to rotation on its
 * next tick — the escape hatch enabled exactly the behavior it documents
 * itself as disabling.
 *
 * A candidate only exists when there is a real window to state. Monotonicity is
 * preserved: a deadline already in force still wins over a new `null`.
 */
export function accountDeadlineMs(
  candidates: readonly (number | undefined | null)[],
): Date | null {
  const latest = latestDeadlineMs(...candidates);
  return latest > 0 ? new Date(latest) : null;
}

/**
 * Backoff for a model the upstream says does not exist for this account
 * (a Connect `not_found` names a model the credential's plan does not reach).
 * Long, because the verdict is a property of the plan and will not
 * change on the next request — but bounded, so a plan upgrade is picked up
 * without an operator clearing it by hand.
 */
export const MODEL_UNREACHABLE_COOLDOWN_MS = 6 * 60 * 60 * 1000;

/**
 * Backoff for a model the upstream does not serve at all (buddy family
 * business code `11102` — `service info not found` — or a `model ... not
 * found/supported` message). Mirrors the reference gateways'
 * `MODEL_SITE_BLOCK_S` → `MODEL_SITE_BLOCK_MAX_S`.
 *
 * Escalating rather than flat: the pair is re-dialled after the first window
 * and answers the same thing, so a flat 6h let a permanently unsupported model
 * consume a request every six hours forever. The ladder tops out at a day,
 * which is long enough to stop the redial and short enough that a backend that
 * starts serving the model is picked up without an operator clearing it.
 *
 * This is the one place the references' *strict* behaviour is adopted as a
 * backoff rather than as a 400: nothing currently succeeds through it, so no
 * client is broken by it.
 */
const UNSUPPORTED_MODEL_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const UNSUPPORTED_MODEL_COOLDOWN_MAX_MS = 24 * 60 * 60 * 1000;
/** How many doublings an unsupported-model cooldown may take before the cap. */
const UNSUPPORTED_MODEL_MAX_LEVEL = 8;

/**
 * The cooldown for the *nth* consecutive unsupported-model report (`hits` is
 * the new total, so the first report is `hits === 1`).
 *
 * Exported because the writer, not the classifier, is the only place that
 * reads the authoritative hit count — the classifier sees only the count the
 * caller supplied, which is absent on the first report of a pair.
 */
export function unsupportedModelCooldownMs(hits: number): number {
  const level = Math.min(Math.max(0, Math.round(hits) - 1), UNSUPPORTED_MODEL_MAX_LEVEL);
  return Math.min(
    UNSUPPORTED_MODEL_COOLDOWN_MS * 2 ** level,
    UNSUPPORTED_MODEL_COOLDOWN_MAX_MS,
  );
}

/**
 * The wording an upstream uses for "we do not serve this model at all", as
 * opposed to "this account cannot reach it" (403 entitlement, above) or "this
 * route does not exist" (404 `upstream_not_found`).
 */
const UNSUPPORTED_MODEL_MESSAGE =
  /service info not found|model\s.{0,80}?\bnot\s+(?:found|supported)\b/;

/**
 * True when the evidence says the upstream does not serve the model.
 *
 * Narrow on purpose, and narrower than `model_unreachable`: only a 400/404
 * carrying the buddy family's `11102` or one of the two phrasings above. A
 * 4xx that merely *mentions* a model is far more often a payload the caller
 * got wrong, and cooling a pair for six hours over that takes a working model
 * out of rotation for a request bug.
 */
export function isUnsupportedModelEvidence(
  statusCode: number | null,
  providerCode: string,
  lower: string,
): boolean {
  if (statusCode !== 400 && statusCode !== 404) return false;
  return providerCode === "11102" || UNSUPPORTED_MODEL_MESSAGE.test(lower);
}

/**
 * True when the wording names a *transient* rolling throttle — per-minute
 * token/request windows (TPM/RPM), "too many requests", "per minute" — that
 * self-heals within the window, so it must back off on the same account rather
 * than rotate to a sibling. Mirrors oh-my-pi's `RATE_LIMIT_EXCEEDED` lane.
 */
export function transientRateLimitWording(lower: string): boolean {
  return (
    lower.includes("rate limit") ||
    lower.includes("rate_limit") ||
    lower.includes("too many requests") ||
    lower.includes("per minute") ||
    lower.includes("tokens per minute") ||
    lower.includes("requests per minute") ||
    lower.includes("tpm limit") ||
    lower.includes("rpm limit") ||
    lower.includes("tpm exhausted") ||
    lower.includes("rpm exhausted") ||
    lower.includes("ratelimitexceeded.endpointtpm") ||
    lower.includes("ratelimitexceeded.endpointrpm") ||
    lower.includes("presque")
  );
}

/**
 * The escalating verdict shared by every rule that cools one (account, model)
 * pair on the unsupported-model ladder — the Qoder plan gate, the generic
 * `model-plan-gated` arm, and `model-unsupported`. Cooldowns double per
 * consecutive report (see {@link unsupportedModelCooldownMs}), and the mutation
 * is model-scoped: the account keeps serving its other models.
 */
export function modelUnreachableEscalating(
  signals: Pick<
    AccountErrorSignals,
    "result" | "reason" | "modelBlockHits" | "origin" | "modelId"
  >,
  explanation: string,
): AccountErrorClassification {
  const cooldownMs = unsupportedModelCooldownMs(signals.modelBlockHits);
  return signals.result(
    "model_unreachable",
    "cooldown",
    cooldownMs,
    new Date(Date.now() + cooldownMs),
    signals.reason(explanation),
    signals.origin === "upstream" && signals.modelId !== undefined,
    true,
  );
}
