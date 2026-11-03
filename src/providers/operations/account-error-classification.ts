/**
 * Account error classification: turns one upstream failure into a category,
 * a cooldown window, and a verdict on the account.
 *
 * This is the decision half of the account health machine. It is pure: it
 * reads evidence and returns a classification, writes nothing, and knows
 * nothing about the database. The writer half lives in
 * `account-health-service.ts`.
 */
import { isRecord } from "../../protocol/codecs";
import { GatewayError } from "../../protocol/gateway-error";
import { BUDDY_PROVIDER_IDS } from "../provider-metadata";
import { parseProviderResetDuration, parseUpstreamBackoff } from "../../protocol/upstream-parsing";
import {
  resolveAccountAuthRejectedCooldownMs,
  resolveAccountCooldownEscalationMaxMs,
  resolveAccountDisabledRecoveryMs,
  resolveAccountModelCapacityCooldownMs,
  resolveAccountPolicyBlockCooldownMs,
  resolveAccountQuotaCooldownMs,
  resolveAccountRateLimitCooldownMs,
  resolveAccountTransientCooldownMs,
  resolveAccountUnclassifiedCooldownMs,
} from "../../config/cooldowns";
const DEFAULT_RATE_LIMIT_COOLDOWN_MS = resolveAccountRateLimitCooldownMs;
/**
 * Inception's per-minute limit window (1 minute).
 *
 * Inception's Free tier throttles per minute (1 000 requests / 1M input
 * tokens / 100K output tokens) and the window resets every minute. The generic
 * 15-minute rate-limit fallback would park a healthy key long after the window
 * refilled; 1 minute is the provider's own cadence, hardcoded because it is a
 * fact about the upstream, not a deployment knob.
 */
const INCEPTION_RATE_LIMIT_COOLDOWN_MS = 60_000;
// Fallback when the error states no usable duration: deliberately short (1h,
// not 24h) — quota state is re-probed on the next failure, so an unknown
// reset cadence self-corrects instead of parking the account for a day.
const DEFAULT_QUOTA_COOLDOWN_MS = resolveAccountQuotaCooldownMs;
const MODEL_CAPACITY_COOLDOWN_MS = resolveAccountModelCapacityCooldownMs;
const TRANSIENT_ERROR_COOLDOWN_MS = resolveAccountTransientCooldownMs;
/**
 * Accounts one cooldown-recovery pass brings back. The sweep ticks every 30s,
 * so a larger backlog drains over successive passes rather than one statement
 * covering every expired row.
 */
export const COOLDOWN_RECOVERY_BATCH = 500;
/**
 * Backoff for a failure no rule matched. Short on purpose: an unclassified
 * error is more likely a new upstream shape than a broken account, so the
 * account returns to rotation quickly.
 */
const UNCLASSIFIED_COOLDOWN_MS = resolveAccountUnclassifiedCooldownMs;
/**
 * xAI Grok Build's free tier resets on a rolling 24-hour window, so its
 * exhaustion is a full-day quota cooldown — never the generic 1h fallback,
 * which let the account re-enter rotation inside the window.
 */
const GROK_QUOTA_COOLDOWN_MS = 24 * 60 * 60 * 1000;
/**
 * Trae answers `4013 "AI service is not available in the current region now."`
 * when the upstream does not serve the account's region. A day because the
 * verdict is durable: it reproduces on every request until the region opens,
 * and the account must not be re-dialled every thirty seconds for the whole
 * window.
 */
const TRAE_REGION_COOLDOWN_MS = 24 * 60 * 60 * 1000;
/**
 * Trae's free-tier quota (`4008` / "exceeded the quota") resets daily, so its
 * exhaustion is a full-day model backoff — never the generic 1h fallback,
 * which let the account re-enter rotation inside the window.
 */
const TRAE_QUOTA_COOLDOWN_MS = 24 * 60 * 60 * 1000;
/**
 * Qoder's quota verdicts (`110` billing-daily-count, the upstream-499 close)
 * are per-model: one model's spend cap does not drain another. A day matches
 * the daily billing window the provider names.
 */
const QODER_QUOTA_COOLDOWN_MS = 24 * 60 * 60 * 1000;
/**
 * The buddy family's policy/channel block (`11140`, `11128`) is a *base* backoff,
 * not a flat penalty — see {@link resolveAccountPolicyBlockCooldownMs}. It used
 * to be two constants, 24h for the content block and 6h for the channel one,
 * both applied on the first observation. That was wrong in the direction that
 * costs most: `11140` is also what a wrong desktop `User-Agent` brand answers
 * (`workbuddy/shared.ts`), so after we fixed a header regression every buddy
 * account stayed dead for up to a further day, and one prompt that failed a
 * safety review cost a whole account a day. As a base it escalates through the
 * consecutive-failure ladder, which tells the two causes apart by what they do
 * next — a genuinely blocked account is refused again immediately and parks
 * itself within minutes.
 */
/**
 * Backoff for a model the upstream says does not exist for this account
 * (Cursor answers Connect `not_found` for a model the credential's plan does
 * not reach). Long, because the verdict is a property of the plan and will not
 * change on the next request — but bounded, so a plan upgrade is picked up
 * without an operator clearing it by hand.
 */
const MODEL_UNREACHABLE_COOLDOWN_MS = 6 * 60 * 60 * 1000;
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
function isUnsupportedModelEvidence(
  statusCode: number | null,
  providerCode: string,
  lower: string,
): boolean {
  if (statusCode !== 400 && statusCode !== 404) return false;
  return providerCode === "11102" || UNSUPPORTED_MODEL_MESSAGE.test(lower);
}

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
   * Deprecated: an upstream ban. Kept so existing health rows keep rendering
   * instead of showing a blank cause. No longer produced — see
   * `policy_blocked_banned` and `policy_blocked_invalid_request`.
   */
  | "policy_blocked"
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
   * True when the upstream reported the model as one it does not serve (the
   * buddy family's `11102`), rather than one this account merely cannot reach.
   *
   * A property of the classification, because both verdicts land in the same
   * `model_unreachable` category and the writer cannot otherwise tell them
   * apart — it needs to know whether to count the hit and escalate the window.
   */
  readonly modelUnsupported?: boolean;
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
 * A provider code that is digits only. Such codes are identifiers, not auth
 * vocabulary — providers encode spend/entitlement verdicts as numbers (Qoder's
 * `110`, buddy's `6004`) — so the bare-401/403 credential arm must not treat
 * an unknown one as evidence that the credential died.
 */
const NUMERIC_PROVIDER_CODE = /^\d+$/;

/**
 * Escalates a *fallback* cooldown for an account that keeps failing.
 *
 * `consecutiveFailures` has been incremented on every account failure since the
 * health machine was written, but nothing ever read it — so a broken upstream
 * was re-dialled once a minute forever, and an account whose quota had an
 * unstated reset came straight back into rotation every time its short fallback
 * lapsed. The count is now a backoff level: each further consecutive failure
 * doubles the fallback, clamped to {@link resolveAccountCooldownEscalationMaxMs}.
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
 * Whether the upstream named a restriction on the account itself.
 *
 * The buddy family reuses "request illegal" for two unrelated rejections, and
 * the difference is only in the body:
 *
 * - `11140` carries `displayMsg` about the account being restricted ("Your
 *   account has been restricted due to unusual activity") and `actions`
 *   offering an appeal. That is a ban — the account is refused, not throttled.
 * - `11-128` is a refusal of this request; the account is fine.
 *
 * Proven account-scoped (2026-10-16): two live share-page requests carrying
 * byte-identical bodies and headers to the same model differed only in the
 * pooled account, and the blocked one 400'd while the other 200'd.
 *
 * Matched on the code *and* the account-restriction wording, so an unrelated
 * upstream that happens to say "restricted" in prose cannot disable accounts.
 */
function isBuddyAccountBanned(
  lower: string,
  providerCode: string,
  upstreamBody: unknown,
): boolean {
  if (providerCode !== "11140") return false;
  if (banWording(lower)) return true;
  // The message alone is not enough, and this is the case that proved it: the
  // provider's message for a ban is the same two words it uses for a refused
  // request — "request illegal" — while the actual verdict ("Your account has
  // been restricted due to unusual activity") lives in `displayMsg`, which the
  // message extractor never reads. Matching only the message therefore read
  // every ban as a mere request refusal: no category, no disable, and the
  // account kept serving.
  const body = isRecord(upstreamBody) ? upstreamBody : undefined;
  if (body === undefined) return false;
  for (const field of ["displayMsg", "displayTips", "msg", "message"]) {
    const value = body[field];
    if (typeof value === "string" && banWording(value.toLowerCase())) return true;
    // `displayMsg` is a per-language map: `{ en: "…", zh: "…" }`. Any
    // language states the same verdict, so all of them are read.
    if (!isRecord(value)) continue;
    for (const nested of Object.values(value)) {
      if (typeof nested === "string" && banWording(nested.toLowerCase())) return true;
    }
  }
  // `actions` names the remedy: an appeal can only be offered for a verdict
  // about the account, and "edit input" only ever describes a request.
  const actions = body["actions"];
  if (Array.isArray(actions)) {
    for (const action of actions) {
      if (typeof action !== "string") continue;
      if (action.toLowerCase().includes("appeal") || action.toLowerCase().includes("feedback")) {
        return true;
      }
    }
  }
  return false;
}

/** The wording an upstream uses when it restricted the account, not the request. */
function banWording(lower: string): boolean {
  return (
    lower.includes("restricted") ||
    lower.includes("has been banned") ||
    lower.includes("unusual activity") ||
    lower.includes("appeal this restriction") ||
    lower.includes("submit feedback to appeal") ||
    lower.includes("account has been") ||
    lower.includes("账号存在异常行为") ||
    lower.includes("帳號存在異常行為")
  );
}

/**
 * Bounded to a day, matching `MAX_COOLDOWN_MS` in the failure policy: a stated
 * window longer than that is a monthly or plan-level limit, and parking an
 * account for a month on one upstream field is a decision for the operator,
 * not an automatic one.
 */
const MAX_UPSTREAM_STATED_COOLDOWN_MS = 24 * 3600 * 1000;

/** Parses the stored upstream text as JSON. Returns `undefined` when it is not. */
function tryParseUpstreamBody(text: string): unknown {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Reads a reset window the upstream stated in structured fields.
 *
 * A body like `{"error":{"type":"usage_limit_reached","resets_at":1795019113,
 * "resets_in_seconds":2072028}}` states the window exactly, while its own
 * `message` ("The usage limit has been reached") states none — so parsing only
 * prose leaves a 23-day limit cooling for the 15-minute fallback, and the
 * account re-enters rotation hours before it can serve.
 *
 * Both spellings are read because providers use both: an absolute epoch
 * (`resets_at`, seconds or milliseconds) and a relative delay
 * (`resets_in_seconds`). The later of the two wins, since they are the same
 * claim computed at slightly different instants.
 */
function parseUpstreamBodyReset(body: unknown): number | null {
  if (typeof body !== "object" || body === null) return null;
  const record = body as Record<string, unknown>;
  // Some providers nest under `error`, some return it at the top level.
  const candidates = [record, (record["error"] as Record<string, unknown> | undefined) ?? undefined];
  let best: number | null = null;
  for (const candidate of candidates) {
    if (typeof candidate !== "object" || candidate === null) continue;
    const now = Date.now();

    const absolute = candidate["resets_at"] ?? candidate["reset_at"];
    if (typeof absolute === "number" && Number.isFinite(absolute) && absolute > 0) {
      // Seconds vs milliseconds: a plausible epoch in seconds is ~10 digits, in
      // milliseconds ~13, and the two are four orders of magnitude apart — so
      // the smaller is scaled up rather than guessed from a threshold date.
      const epochMs = absolute < 1e11 ? absolute * 1000 : absolute;
      const delay = epochMs - now;
      if (delay > 0) best = best === null ? delay : Math.max(best, delay);
    }

    const relative =
      candidate["resets_in_seconds"] ??
      candidate["reset_in_seconds"] ??
      candidate["retry_after_seconds"];
    if (typeof relative === "number" && Number.isFinite(relative) && relative > 0) {
      const delay = relative * 1000;
      best = best === null ? delay : Math.max(best, delay);
    }

    const minutes = candidate["limit_window_minutes"] ?? candidate["reset_in_minutes"];
    if (typeof minutes === "number" && Number.isFinite(minutes) && minutes > 0) {
      const delay = minutes * 60_000;
      best = best === null ? delay : Math.max(best, delay);
    }
  }
  return best === null ? null : Math.min(MAX_UPSTREAM_STATED_COOLDOWN_MS, Math.round(best));
}


interface AccountErrorContext {
  readonly message: string;
  readonly lower: string;
  readonly folded: string;
  readonly statusCode: number | null;
  readonly origin: AccountFailureOrigin;
  readonly scope: AccountFailureScope;
  readonly revocationNamed: boolean;
  readonly accountEvidence: boolean;
  readonly canMutate: boolean;
  readonly providerCode: string;
  readonly statedCooldownMs: number | null;
  /** Echo of the caller's evidence; read only by the arms that need it. */
  readonly providerId: string | undefined;
  /** The raw upstream response body, when the dispatch path stored it. */
  readonly rawUpstreamResponse: string | undefined;
  /**
   * The upstream named a restriction on the account, not a refusal of the
   * request. Read by the policy arm to pick between disabling the account and
   * merely refusing the request.
   */
  readonly buddyBanned: boolean;
  readonly reason: (prefix: string) => string;
  readonly result: (
    category: AccountErrorCategory,
    status: AccountErrorClassification["status"],
    cooldownMs: number,
    retryAt: Date | null,
    explanation: string,
    mutatesAccount?: boolean,
    modelUnsupported?: boolean,
  ) => AccountErrorClassification;
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
interface AccountErrorRule {
  readonly name: string;
  readonly match: (signals: AccountErrorSignals) => boolean;
  readonly decide: (signals: AccountErrorSignals) => AccountErrorClassification;
}

/** The shared signals every arm reads, computed once per classification. */
interface AccountErrorSignals {
  readonly message: string;
  readonly lower: string;
  readonly folded: string;
  readonly statusCode: number | null;
  readonly origin: AccountFailureOrigin;
  readonly scope: AccountFailureScope;
  readonly providerCode: string;
  readonly statedCooldownMs: number | null;
  readonly reason: (prefix: string) => string;
  readonly result: AccountErrorContext["result"];
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
  readonly hostedToolFailure: boolean;
  readonly modelEntitlementFailure: boolean;
  readonly queuedUpstream: boolean;
  readonly validationRequired: boolean;
  readonly validationUrl: string | undefined;
}

const VALIDATION_URL_RE = /https?:\/\/[^\s"'\\]+/;

/**
 * Extracts the Google `validation_url` from an Antigravity rejection.
 *
 * The URL can appear either in the message itself or nested in the raw
 * upstream JSON (`details[].metadata.validation_url`). Returning `undefined`
 * means nothing actionable was found — the classifier then just parks the
 * account without a link.
 */
function extractValidationUrl(message: string, rawUpstreamResponse: string | undefined): string | undefined {
  if (rawUpstreamResponse !== undefined && rawUpstreamResponse.includes("validation_url")) {
    try {
      const parsed = JSON.parse(rawUpstreamResponse) as {
        error?: {
          details?: Array<{ metadata?: Record<string, unknown> }>;
        };
      };
      for (const detail of parsed?.error?.details ?? []) {
        const url = detail?.metadata?.["validation_url"];
        if (typeof url === "string" && url.length > 0 && url.startsWith("http")) return url;
      }
    } catch {
      /* fall through to message regex */
    }
  }
  const m = VALIDATION_URL_RE.exec(message);
  return m?.[0];
}

/** Build the request-independent evidence consumed by the ordered classifier. */
function accountErrorContext(error: unknown, options?: AccountFailureEvidence): AccountErrorContext {  const errorRecord = isRecord(error) ? error : undefined;
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : typeof errorRecord?.message === "string"
          ? errorRecord.message
          : String(error ?? "Unknown error");
  const lower = message.toLowerCase();
  const statusCode =
    options?.statusCode ??
    (typeof errorRecord?.status === "number" ? errorRecord.status : null);
  const origin = options?.origin ?? "cartethyia";
  const scope = options?.scope ?? "unknown";
  // Providers write the same phrase with different separators: codex reports
  // `token_revoked`, others `token revoked` or `token-revoked`. Folding the
  // separators once lets every match below see one spelling.
  const folded = lower.replace(/[_-]+/g, " ");
  // A revocation named in the message is evidence about the credential itself,
  // whichever scope the caller could establish. A stream error frame carries
  // no `credentialEvidence` detail and classifies at provider scope, so without
  // this the account stays in rotation: the phrase is recognised and then
  // discarded because nothing mutates on provider scope.
  const revocationNamed = folded.includes("token revoked") || folded.includes("invalidated oauth token");
  const accountEvidence =
    options?.credentialEvidence === true ||
    revocationNamed ||
    (options?.origin === "upstream" && options.scope === "account");
  // A named revocation mutates even at provider scope: the message is the
  // evidence, and provider scope is what a frame with no credential detail
  // classifies as. Every other signal still needs account scope.
  const canMutate = origin === "upstream" && (revocationNamed || (scope === "account" && accountEvidence));
  const providerCode =
    options?.providerCode?.toLowerCase() ??
    (error instanceof GatewayError && typeof error.details.providerCode === "string"
      ? error.details.providerCode.toLowerCase()
      : "");

  const getHeader = (name: string): string | null => {
    const headers = options?.headers;
    if (!headers) return null;
    if ("get" in headers && typeof headers.get === "function") return headers.get(name);
    const wanted = name.toLowerCase();
    const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === wanted);
    return entry?.[1] ?? null;
  };

  const headerCooldown =
    options?.retryAfterMs ??
    parseUpstreamBackoff({ get: getHeader });
  const messageCooldown = parseProviderResetDuration(message);
  const rawUpstreamResponse =
    origin === "upstream" &&
    error instanceof GatewayError &&
    typeof error.details.raw === "string"
      ? error.details.raw
      : undefined;
  // The body's own fields, when they can be reached. Checked alongside the
  // header and the prose rather than instead of them: a provider may state the
  // window in any of the three, and the longest honest statement wins.
  //
  // `details.raw` is tried even when no caller passed a parsed body, because
  // that is where the upstream's JSON actually reaches this function — the
  // dispatch path stores the response text there. A structured window read from
  // it is the difference between a 15-minute fallback and the 23 days the
  // provider stated.
  const bodyCooldown =
    parseUpstreamBodyReset(options?.upstreamBody) ??
    (rawUpstreamResponse === undefined ? null : parseUpstreamBodyReset(tryParseUpstreamBody(rawUpstreamResponse)));
  // The body the ban is named in. The caller's parsed body when there is one,
  // and the raw response text otherwise — the dispatch path stores the
  // upstream's JSON there, and that is where `displayMsg` lives.
  const banBody =
    options?.upstreamBody ??
    (rawUpstreamResponse === undefined ? undefined : tryParseUpstreamBody(rawUpstreamResponse));
  // Whether the provider itself named a window. Decided once, from the
  // evidence, so every branch of this classification agrees about it.
  const providerStated =
    headerCooldown !== null || messageCooldown !== null || bodyCooldown !== null;
  const statedCooldownMs =
    [headerCooldown, messageCooldown, bodyCooldown].reduce<number | null>(
      (best, value) => (value === null ? best : best === null ? value : Math.max(best, value)),
      null,
    );
  const reason = (prefix: string): string => `${prefix}: ${message.slice(0, 160)}`;
  const result = (
    category: AccountErrorCategory,
    status: AccountErrorClassification["status"],
    cooldownMs: number,
    retryAt: Date | null,
    explanation: string,
    mutatesAccount = canMutate,
    modelUnsupported = false,
  ): AccountErrorClassification => ({
    category,
    status,
    cooldownMs,
    reason: origin === "upstream" ? rawUpstreamResponse ?? message.slice(0, 160) : explanation,
    retryAt,
    mutatesAccount,
    // Set below by the caller that knows which columns it wrote, not here:
    // the same classification feeds both the account-wide path (status +
    // cooldownUntil — routing-visible) and the model-scoped path (neither —
    // invisible). Defaulting true keeps existing callers conservative.
    routesVisible: true,
    providerStated,
    modelUnsupported,
  });

  return {
    message,
    lower,
    folded,
    statusCode,
    origin,
    scope,
    revocationNamed,
    accountEvidence,
    canMutate,
    providerCode,
    providerId: options?.providerId,
    statedCooldownMs,
    rawUpstreamResponse,
    buddyBanned: isBuddyAccountBanned(lower, providerCode, banBody),
    reason,
    result,
  };
}

export function classifyAccountError(
  error: unknown,
  options?: AccountFailureEvidence,
): AccountErrorClassification {
  const {
    message,
    lower,
    folded,
    statusCode,
    origin,
    scope,
    revocationNamed,
    accountEvidence,
    canMutate,
    providerCode,
    rawUpstreamResponse,
    statedCooldownMs,
    buddyBanned,
    reason,
    result,
  } = accountErrorContext(error, options);
  const modelId = options?.modelId;
  const modelBlockHits = Math.max(1, Math.floor(options?.modelBlockHits ?? 1));
  const staticToken = options?.staticToken === true;
  const credentialKind = options?.credentialKind;

  // Start Plan is a separate provider: its named trial refusal rests only that model.
  const providerId = options?.providerId ?? (error instanceof GatewayError ? error.details.providerId : undefined);
  const refusedModel = statusCode === 400
    ? /no active limited quota for ([\w.-]+)/i.exec(message)?.[1]
    : statusCode === 429
      ? /limited quota(?: for)? ([\w.-]+)(?: is)? exhausted/i.exec(message)?.[1]
      : undefined;
  if (providerId === "zcode-start" && modelId !== undefined && refusedModel !== undefined &&
    refusedModel.toLowerCase().replace(/-trial$/, "") === modelId.toLowerCase().replace(/-trial$/, "")) {
    const cooldownMs = statedCooldownMs ?? DEFAULT_QUOTA_COOLDOWN_MS();
    return result("model_unreachable", "cooldown", cooldownMs, new Date(Date.now() + cooldownMs),
      reason("Start Plan trial unavailable for this model"), origin === "upstream");
  }

  // A price refusal is a verdict on the *request*, not on the account. inferhub
  // answers 402 with `no provider's ask matches your max-per-mtok bid`: the
  // caller's own price ceiling was below every upstream ask, which says nothing
  // about the credential or its balance. Classified as quota it cooled a
  // fully-credited account down for an hour and the operator reported it as
  // "blocked, unusable at all". Detected before the quota branch and recorded
  // without mutating the account, so only that request fails.
  const priceRefusal =
    lower.includes("max-per-mtok") ||
    lower.includes("no provider's ask") ||
    (lower.includes("ask") && lower.includes("bid"));
  // Deployment/proxy infrastructure errors (DEPLOYMENT_DISABLED, etc.) are
  // transport-level proxy pool failures, not account quota exhaustion.
  // Mutating the account parks it for an hour while the pool itself stays
  // healthy — the next request picks the same dying pool and the same error
  // repeats. These must not cooldown the account.
  const deploymentInfraError =
    lower.includes("deployment_disabled") ||
    lower.includes("deployment disabled") ||
    (lower.includes("sin1::") && lower.includes("deployment"));
  if (deploymentInfraError) {
    return result("server_error", "cooldown", 60_000, null, `Proxy deployment error: ${message.slice(0, 160)}`, false);
  }
  // A (CodeBuddy/WorkBuddy) *frequency* window is a verdict on one
  // (account, model) pair, not on the account: `{"code":"6004","msg":"usage
  // exceeds frequency limit ... your usage will reset at <stamp> UTC+8,
  // alternatively, you can switch to the other models to continue using it."}`.
  // The provider names the remedy itself — use a different model — which is
  // only a remedy if the account still serves every other model. Taken as
  // account-wide `quota_exhausted` it parked the whole account until the reset,
  // so the switch the upstream offered was refused by our own gateway and every
  // sibling model went dark with it; the account also read COOLDOWN /
  // quota_exhausted while only that pair was throttled.
  //
  // Classified `rate_limit_transient` so the writer scopes it to the model:
  // `recordAccountFailure` writes `modelCooldowns[modelId]` and leaves the
  // account's own status alone. Kept ahead of `quotaSignal`, which matches a
  // *broader* slice of the same wording (`usage exceeds` + `frequency limit`)
  // and would otherwise claim this message as an account-wide quota window.
  // Narrow on purpose — the extra phrase is what says the other models still
  // work; without it the failure stays account-wide.
  const modelFrequencyWindow =
    lower.includes("frequency limit") && lower.includes("switch to the other models");
  if (modelFrequencyWindow) {
    const cooldownMs = statedCooldownMs ?? DEFAULT_QUOTA_COOLDOWN_MS();
    return result(
      "rate_limit_transient",
      "cooldown",
      cooldownMs,
      new Date(Date.now() + cooldownMs),
      reason("Provider frequency limit for this model"),
      // Provider-scoped evidence still has to reach the writer: a stream frame
      // carries no credential detail, so `canMutate` is false and without this
      // the pair would be retried for the whole window it was closed for.
      origin === "upstream" && scope === "provider",
    );
  }

  // Quota-shaped provider codes/messages (e.g. xAI's
  const quotaSignal =
    !priceRefusal &&
    !deploymentInfraError &&
    (statusCode === 402 ||
      // Qoder answers an exhausted credit balance with
      // `{"code":"112","message":"{\"pricingUrl\":...}"}` — the body points at
      // the pricing page, i.e. "buy more", which is a balance verdict, not an
      // auth one. It fell through to `auth_invalidated` and the console showed
      // "Re-login required" on an account whose credential was fine, sending
      // operators to re-authenticate instead of topping up.
      // Recognising it here keeps it out of `auth_invalidated`; the branch
      // below scopes the resulting cooldown to the model, because the account
      // keeps serving its other models.
      providerCode === "112" ||
      providerCode === "110" ||
      providerCode === "116" ||
      providerCode === "insufficient_quota" ||
      providerCode === "quota_exceeded" ||
      providerCode === "subscription:free-usage-exhausted" ||
      providerCode === "14018" ||
      // CodeBuddy/WorkBuddy rate limit: `{"code":"6004","msg":"usage exceeds
      // frequency limit ... your usage will reset at <stamp> UTC+8"}`. The
      // message names a reset, so this is a parked window, not a transient
      // 429 — without it the account fell through to `unknown` with
      // `mutates=false`, stayed in rotation, and was re-picked for every
      // request inside the window the provider had actually named.
      //
      // Matched on the message's own wording, not on the `6004` code: that code
      // is not unique to this surface (the artifact-release API reuses it), so a
      // code match would sweep an unrelated failure into a quota cooldown. The
      // phrase is the reliable key, and `usage exceeds` + `frequency limit` is
      // the pair this family actually prints.
      (lower.includes("usage exceeds") && lower.includes("frequency limit")) ||
      lower.includes("insufficient_quota") ||
      lower.includes("quota_exceeded") ||
      lower.includes("usage_limit_reached") ||
      lower.includes("usage-exhausted") ||
      lower.includes("usage_exhausted") ||
      lower.includes("usage exhausted") ||
      lower.includes("usage exceeds") ||
      lower.includes("frequency limit") ||
      lower.includes("free-usage") ||
      lower.includes("free usage") ||
      lower.includes("exceeded your current quota") ||
      // Trae answers an exhausted quota with **HTTP 502** and the body `Your
      // requests have exceeded the quota.` The status is what misled the
      // classifier: 502 read as a gateway failure, so this fell through to
      // `server_error` — a 30s cooldown that does not mutate the account, so
      // the account stayed in rotation and every other model on it kept being
      // invoked inside a window the provider had already closed. The body is
      // the verdict; the 502 is incidental. Matched on the phrase, not on the
      // status, which is why this sits in `quotaSignal` ahead of the 5xx arm.
      lower.includes("have exceeded the quota") ||
      lower.includes("balance exhausted") ||
      lower.includes("insufficient balance") ||
      lower.includes("out of credits") ||
      lower.includes("credits exhausted") ||
      lower.includes("spending limit") ||
      lower.includes("billing daily count exceeded") ||
      // Same Qoder family reached by body text when the code is not parsed out.
      (lower.includes("pricingurl") && lower.includes("qoder.com/pricing")));
  // A deterministic content-policy rejection is NOT credential invalidation.
  // CodeBuddy returns HTTP 403 with provider code 11140 ("request illegal",
  // "did not pass the safety review") — refreshing the token cannot change
  // that outcome and the account itself is healthy, so it must never flip the
  // account to auth_invalidated/disabled. Only real auth signals do.
  const policyRejection =
    providerCode === "11140" ||
    lower.includes("safety review") ||
    lower.includes("content did not pass") ||
    lower.includes("request illegal") ||
    lower.includes("content blocked") ||
    lower.includes("account suspended");
  // A ban is a verdict on the credential, and cooldown cannot answer it: the
  // account is refused, not throttled. Disabling is the fix, and disabling
  // *immediately* is a feature — a client's retry budget is spent in seconds,
  // so a banned account that merely cooled stayed in the plan and burned
  // sibling accounts that were still healthy before the window expired.
  //
  // The two shapes are told apart by the body, not the code alone: `11140`
  // names a restriction on the account, `11-128` refuses the request.
  const policyBlock =
    policyRejection &&
    options?.providerId !== undefined &&
    BUDDY_PROVIDER_IDS.has(options.providerId.toLowerCase());
  if (policyBlock) {
    if (buddyBanned) {
      return result(
        "policy_blocked_banned",
        "disabled",
        0,
        null,
        reason("Account banned by upstream"),
        // A ban is evidence about the credential even at provider scope, for
        // the same reason a named revocation is: the message is the evidence.
        // Without this a stream frame's missing credential detail would leave a
        // banned account serving.
        true,
      );
    }
    // Not a ban: the upstream refused this request. The account is fine, so the
    // only correct move is to stop retrying it verbatim. Cooling the account
    // here was the bug that made one malformed request look like a dead
    // credential.
    return result(
      "policy_blocked_invalid_request",
      "cooldown",
      0,
      null,
      reason("Upstream refused this request"),
      // Never mutates: a malformed body fails identically on every account, so
      // cooling would burn a healthy credential on the gateway's own fault.
      false,
    );
  }
  // These codes are a verdict on the request, not the account. Cooling the
  // account for them burns a healthy credential on a body that will fail the
  // same way on every other account:
  //
  // - `11148` tool-call/result mismatch — the transcript is broken; the
  //   pre-payload repair is supposed to prevent it, and a slip is still the
  //   body's fault.
  // - `11135` the image cannot be processed, `11133` the model rejected a
  //   parameter, `11101` the body failed to parse — deterministic for that
  //   payload.
  // - `12153` the session is dead — a refresh problem, not a reason to park
  //   the account on the first observation.
  // - `14017` trial not activated — the account may recover once registration
  //   finishes, so a hard cooldown would keep it out after it becomes usable.
  //
  // Recognised before the auth and quota branches: several of these arrive as
  // 401/403/429, which those branches would otherwise treat as account evidence.
  const requestScoped =
    providerCode === "11148" ||
    providerCode === "11135" ||
    providerCode === "11133" ||
    providerCode === "11101" ||
    providerCode === "12153" ||
    providerCode === "14017" ||
    lower.includes("tool_call_sequence_broken") ||
    lower.includes("unmarshal chat params failed") ||
    lower.includes("invalid image_url content") ||
    lower.includes("offline user session not found") ||
    lower.includes("trial not activated") ||
    lower.includes("trial version is not yet activated");
  if (requestScoped && BUDDY_PROVIDER_IDS.has(options?.providerId?.toLowerCase() ?? "")) {
    return result(
      "unknown",
      "cooldown",
      0,
      null,
      reason("Request-scoped upstream rejection"),
      false,
    );
  }
  // A channel rejection (`11128`) is the same shape: the upstream is refusing
  // the caller for this account, not this particular prompt, and it keeps
  // refusing on every invocation. Classifying it as `unknown` with
  // `mutates=false` would leave the account in rotation failing every request —
  // and since every account fails the same way, the whole pool looks dead with
  // nothing ever parked.
  const channelRejection =
    providerCode === "11128" || lower.includes("unapproved channel");
  const channelBlock =
    channelRejection &&
    options?.providerId !== undefined &&
    BUDDY_PROVIDER_IDS.has(options.providerId.toLowerCase());
  if (channelBlock) {
    // Same split as the policy arm above: a ban disables, a channel refusal
    // only stops this request. `11-128` is the request shape, so this branch
    // nearly always takes the refusal path — but it shares the ban test so a
    // `11140`-shaped body arriving as a channel rejection still disables.
    if (buddyBanned) {
      return result(
        "policy_blocked_banned",
        "disabled",
        0,
        null,
        reason("Account banned by upstream"),
        true,
      );
    }
    return result(
      "policy_blocked_invalid_request",
      "cooldown",
      0,
      null,
      reason("Provider channel rejection"),
      // The credential is valid; the upstream refuses this calling channel.
      // Cooling was the bug: it kept a refused account in the plan, where a
      // client's retry budget burned healthy siblings for the whole window.
      false,
    );
  }
  // server-side tool (web search, x search, web fetch), not evidence about the
  // credential or the account's quota. Some providers surface it as 403, which
  // would otherwise look like an auth signal — refreshing the token cannot fix
  // a search backend, so it must never disable the account.
  const hostedToolFailure =
    lower.includes("web_search") ||
    lower.includes("web search") ||
    lower.includes("web_search_preview") ||
    lower.includes("x_search") ||
    lower.includes("web_fetch") ||
    lower.includes("tool invocation") ||
    lower.includes("tool call failed") ||
    lower.includes("search backend");
  // A model-scoped license or entitlement rejection is NOT credential invalidation.
  // Google Cloud Code / Antigravity answers HTTP 403 with "You do not have a valid
  // license of this product" when an account lacks entitlement for one specific model
  // (e.g. claude-opus-4-6), while the account itself and its tokens remain fully valid
  // for all other models. Disabling the whole account breaks healthy models.
  const modelEntitlementFailure =
    statusCode === 403 &&
    ((providerId === "commandcode" && lower.includes("model_not_in_plan")) ||
      lower.includes("not have a valid license") ||
      lower.includes("valid license of this product") ||
      lower.includes("model not supported") ||
      lower.includes("not entitled to") ||
      lower.includes("no access to model") ||
      lower.includes("model_not_supported") ||
      lower.includes("not available in your region"));
  /**
   * Google Cloud Code / Antigravity account verification: the upstream answers
   * an unverified account with HTTP 403 `PERMISSION_DENIED` and a
   * `VALIDATION_REQUIRED` reason plus a `validation_url`. The operator must
   * complete verification before the credential can ever serve again, so the
   * account must be parked (`disabled`) — not left `active`, and not a
   * cooldown (no amount of waiting clears it). The validation URL is carried
   * in the recorded reason so the dashboard can surface it as an actionable
   * pill link.
   */
  const validationRequired =
    (statusCode === 403 || lower.includes("permission_denied")) &&
    (lower.includes("validation_required") ||
      lower.includes("verify your account") ||
      lower.includes("validation_url"));
  const validationUrl = validationRequired ? extractValidationUrl(message, rawUpstreamResponse) : undefined;
  /**
   * The upstream accepted the request and put it in a queue behind other
   * callers — it is busy, not rejecting the caller's credential.
   *
   * Qoder answers `403 {"code":"10605","message":"{\"isQueued\":true,
   * \"modelKey\":\"dfmodel\",\"queueCount\":1395,...}"}`. The 403 is what made
   * this misclassify: the generic `(401 || 403) && accountEvidence` arm claimed
   * it as `auth_invalidated`, so a healthy account was parked as "Re-login
   * required" purely because the provider was busy, and an operator was sent
   * to re-authenticate a credential that was never rejected.
   *
   * Matched on the queue evidence rather than on the bare `10605`, so an
   * unrelated 403 that happens to share the code is not swept in. The bodies
   * are nested JSON, so the tell is the key, not a parse of the envelope.
   */
  const queuedUpstream =
    providerCode === "10605" ||
    lower.includes("isqueued") ||
    lower.includes("queuecount") ||
    lower.includes("queuetype") ||
    (lower.includes("queue") && lower.includes("modelkey"));

  const signals: AccountErrorSignals = {
    message,
    lower,
    folded,
    statusCode,
    origin,
    scope,
    providerCode,
    statedCooldownMs,
    reason,
    result,
    canMutate,
    accountEvidence,
    revocationNamed,
    providerId: options?.providerId,
    modelId,
    modelBlockHits,
    staticToken,
    credentialKind,
    buddyBanned,
    priceRefusal,
    quotaSignal,
    policyRejection,
    hostedToolFailure,
    modelEntitlementFailure,
    queuedUpstream,
    validationRequired,
    validationUrl,
  };

  for (const rule of ACCOUNT_ERROR_RULES) {
    if (rule.match(signals)) return rule.decide(signals);
  }

  // Same reasoning as above, with the shortest backoff: an unmapped failure
  // must still be retried automatically rather than parked forever.
  const unclassifiedMs = UNCLASSIFIED_COOLDOWN_MS();
  return result(
    "unknown",
    "cooldown",
    unclassifiedMs,
    new Date(Date.now() + unclassifiedMs),
    reason("Unclassified provider failure"),
    false,
  );
}

/**
 * The ordered arms of {@link classifyAccountError}, tried top to bottom; the
 * first match decides. Order is behavior, not presentation — see
 * {@link AccountErrorRule}.
 */
const ACCOUNT_ERROR_RULES: readonly AccountErrorRule[] = [
  {
    // Must precede "rate-limit": this rejection is a 429 whose own text says
    // "rate limit", so the broader arm claimed it and cooled the account for
    // the full 15-minute rate-limit window.
    //
    // A full max-inflight is a statement about the gateway's own routing, not
    // about the credential: every account serving the model is busy right now.
    // Cooling them marks healthy accounts as `cooldown` for a limit their
    // provider never applied, which is what made every account read busy while
    // incoming requests piled up — the accounts were never the problem, the
    // ceiling was.
    name: "gateway-capacity-exhausted",
    match: (s) =>
      s.lower.includes("at its concurrency limit") ||
      s.lower.includes("every proxy pool for this provider is at its concurrency limit") ||
      s.lower.includes("the gateway is at its concurrency limit"),
    decide: (s) =>
      s.result(
        "model_capacity",
        // `status` is the status the account would move to; it is never
        // applied because `mutatesAccount` is false below, so this names the
        // shape rather than a transition. Zero cooldown is the point: no wait
        // is attached to the account, so the next request may use it at once.
        "cooldown",
        0,
        null,
        s.reason("Gateway concurrency ceiling reached; no account was at fault"),
        // Never mutates: there is nothing wrong with the account to record.
        false,
      ),
  },
  {
    // Must precede the unclassified fallback: the fallback is account-blind and
    // would stamp this as a provider-wide failure, which is how one proxy
    // refusing CONNECT put every account of every provider behind that pool
    // into cooldown — opencode's dead front door taking codebuddy down with it.
    //
    // A CONNECT refusal is a statement about the proxy pool, not about a
    // credential: the tunnel was never established, so no upstream ever saw the
    // request and no account can be at fault. Scoped to the pool so the
    // provider's own accounts stay in rotation.
    name: "proxy-connect-refusal",
    match: (s) =>
      s.lower.includes("proxy connect failed") ||
      (s.lower.includes("connect") && s.lower.includes("tunnel") && s.lower.includes("refus")),
    decide: (s) =>
      s.result(
        "model_unreachable",
        "cooldown",
        0,
        null,
        s.reason("Proxy pool refused the CONNECT tunnel"),
        // Never mutates: the pool owns this failure, not the account.
        false,
      ),
  },
  {
    name: "validation-required",
    match: (s) => s.validationRequired,
    decide: (s) =>
      s.result(
        "validation_required",
        "disabled",
        0,
        null,
        s.validationUrl !== undefined
          ? `${s.reason("Google account verification required")} — ${s.validationUrl}`
          : s.reason("Google account verification required"),
        // The upstream named the verdict; the account cannot serve until the
        // operator completes verification.
        true,
      ),
  },
  {
    name: "credential-rejected",
    match: (s) =>
      !s.quotaSignal &&
      !s.policyRejection &&
      !s.hostedToolFailure &&
      !s.modelEntitlementFailure &&
      !s.queuedUpstream &&
      (s.providerCode === "authentication_failed" ||
        s.folded.includes("invalid api key") ||
        s.folded.includes("incorrect api key") ||
        s.folded.includes("invalid token") ||
        s.folded.includes("token revoked") ||
        s.folded.includes("invalidated oauth token") ||
        s.folded.includes("reauthorization required") ||
        s.folded.includes("account deactivated") ||
        // Trae answers `1001 "we are not able to authenticate you"` when the
        // credential is dead or invalidated — it is the provider's own auth
        // verdict, but the code is numeric, so it is excluded from the bare
        // 401/403 arm below. Recognising it here keeps the account out of the
        // `unknown` fallback (which never mutates and leaves the account in
        // rotation to be re-dialled on every request).
        ((s.providerId === "trae" || s.providerId === "traecn") &&
          s.providerCode === "1001") ||
        // A bare 401/403 only proves the credential when the body actually
        // says so. A purely numeric provider code carries no auth vocabulary —
        // providers encode limit/entitlement verdicts as numbers too (Qoder's
        // `110`, buddy's `6004`) — and treating an unknown one as credential
        // evidence parked healthy accounts as "Re-login required". Unmapped
        // numeric codes fall through to the unclassified cooldown instead of
        // ever invalidating.
        ((s.statusCode === 401 || s.statusCode === 403) &&
          s.accountEvidence &&
          !NUMERIC_PROVIDER_CODE.test(s.providerCode))),
    decide: (s) => {
      // A static token has no refresh to run, so an auth rejection must not park
      // the account: disabling it throws away a token that may still work (a
      // single upstream 401 can be transient). A cooldown lets the next attempt
      // retry the same token without losing the account.
      const oauthRecovery =
        !s.staticToken &&
        s.credentialKind === "oauth" &&
        (s.lower.includes("expired") || s.lower.includes("refresh"));
      // A *named* revocation is the one auth outcome that still parks the account.
      // The upstream said the credential itself is dead — not that it expired, not
      // that this request was refused — so there is no window to wait out and no
      // refresh to run, and a cooldown would only return it to rotation to fail
      // again. Every other auth rejection is weak evidence (clock skew, a key
      // rotated a moment ago, an edge answering before the credential loads) and
      // cools down instead.
      //
      // This distinction is the whole fix. Reaching `disabled` from the generic
      // `401`/`403` branch would be unrecoverable by any sweep, so one transient
      // rejection would remove the account from rotation until an operator
      // noticed — the exact outcome the comment above says a static token must
      // not suffer.
      const revoked = s.revocationNamed;
      const recoverable = s.staticToken || oauthRecovery || !revoked;
      // An automatic disable is **not** terminal any more, but the deadline is what
      // makes that safe: `sweepExpiredCooldowns` recovers a disabled row only when
      // its `cooldownUntil` has elapsed, and an operator-disabled row keeps that
      // column null. So the machine can undo its own verdict while an operator's
      // decision still outranks it — see `resolveAccountDisabledRecoveryMs`.
      const disabledRecoveryMs = resolveAccountDisabledRecoveryMs();
      const disabledRetryAt =
        disabledRecoveryMs > 0 ? new Date(Date.now() + disabledRecoveryMs) : null;
      const cooldownMs = recoverable ? resolveAccountAuthRejectedCooldownMs() : disabledRecoveryMs;
      return s.result(
        "auth_invalidated",
        recoverable ? "cooldown" : "disabled",
        cooldownMs,
        recoverable ? new Date(Date.now() + cooldownMs) : disabledRetryAt,
        s.reason(
          !revoked
            ? "Provider credential rejected; retrying after a backoff"
            : s.staticToken
              ? "Static token rejected; retrying without a refresh"
              : oauthRecovery
                ? "OAuth credential requires refresh"
                : "Provider credential revoked",
        ),
        s.canMutate,
      );
    },
  },
  {
    name: "price-refusal",
    match: (s) => s.priceRefusal,
    decide: (s) =>
      s.result("quota_exhausted", "cooldown", 0, null, s.reason("Request price refused by the provider"), false),
  },
  {
    // Qoder's code-112 pricing refusal (`{"code":"112","message":"{\"pricingUrl\":...}"}`)
    // is a "this model is not included in this account's plan, buy more" verdict
    // for one pair — the account keeps serving its other models. The probe path
    // does not always carry the code in its evidence (only the message does), so
    // the match keys on the provider id plus the pricing-page wording as well.
    // It must run before `quota-exhausted`, which would park the whole account.
    name: "qoder-plan-gated",
    match: (s) =>
      (s.providerId === "qoder" || s.providerId === "qodercn") &&
      (s.providerCode === "112" || s.lower.includes("pricingurl")),
    decide: (s) => {
      const cooldownMs = unsupportedModelCooldownMs(s.modelBlockHits);
      return s.result(
        "model_unreachable",
        "cooldown",
        cooldownMs,
        new Date(Date.now() + cooldownMs),
        s.reason("Model not included in this account's plan"),
        s.origin === "upstream" && s.modelId !== undefined,
        true,
      );
    },
  },
  {
    name: "model-plan-gated",
    match: (s) => s.quotaSignal && s.providerCode === "112",
    decide: (s) => {
      const cooldownMs = unsupportedModelCooldownMs(s.modelBlockHits);
      return s.result(
        "model_unreachable",
        "cooldown",
        cooldownMs,
        new Date(Date.now() + cooldownMs),
        s.reason("Model not included in this account's plan"),
        s.origin === "upstream" && s.modelId !== undefined,
        true,
      );
    },
  },
  {
    // Trae answers `4013 "AI service is not available in the current region
    // now."` when the upstream does not serve the account's region. That is a
    // durable verdict on the account, not a transient transport fault: it
    // reproduces on every request until the region opens, so it must cool hard
    // for a day rather than be re-dialled every thirty seconds. Must run
    // before `transport-fault`, which would read the 502 as a short
    // `server_error`.
    name: "trae-region-unavailable",
    match: (s) =>
      (s.providerId === "trae" || s.providerId === "traecn") &&
      (s.providerCode === "4013" || s.lower.includes("not available in the current region")),
    decide: (s) => {
      const cooldownMs = TRAE_REGION_COOLDOWN_MS;
      return s.result(
        "quota_exhausted",
        "cooldown",
        cooldownMs,
        new Date(Date.now() + cooldownMs),
        s.reason("Trae service unavailable in the current region"),
        // Account-scoped provider evidence still has to reach the writer: a
        // stream frame carries no credential detail, so `canMutate` is false
        // and without this the account stays in rotation to reproduce the
        // refusal for the whole window the region is closed for.
        true,
      );
    },
  },
  {
    // Trae's free-tier quota (`4008` / "exceeded the quota") resets daily.
    // Treating it like the generic quota cooldown (1h account-wide fallback)
    // let the account re-enter rotation inside the window and reproduce the
    // refusal every few minutes — the "cooldown not holding" report. The
    // verdict is a full-day backoff on *any* model (the account's quota is
    // spent, so every model on it shares the wall). Scoped to the model so
    // the account is not disabled wholesale; the 1-day window means a model
    // stays parked for the day instead of flapping. Must run before
    // `quota-exhausted`, which would apply the generic shorter fallback.
    name: "trae-quota-exhausted",
    match: (s) =>
      (s.providerId === "trae" || s.providerId === "traecn") &&
      (s.providerCode === "4008" || s.lower.includes("have exceeded the quota")),
    decide: (s) => {
      const cooldownMs = s.statedCooldownMs ?? TRAE_QUOTA_COOLDOWN_MS;
      return s.result(
        "model_unreachable",
        "cooldown",
        cooldownMs,
        new Date(Date.now() + cooldownMs),
        s.reason("Trae quota exhausted for this model"),
        s.origin === "upstream" && s.modelId !== undefined,
      );
    },
  },
  {
    // Qoder's quota verdicts — `110` "Billing daily count exceeded" and the
    // upstream-499 exhausted-quota close — are per-model: one model's spend
    // cap does not drain another. Scoping them to the model keeps the account
    // serving its other models. Must run before `quota-exhausted`, which
    // parks the whole account.
    name: "qoder-model-quota",
    match: (s) =>
      (s.providerId === "qoder" || s.providerId === "qodercn") && s.quotaSignal,
    decide: (s) => {
      const cooldownMs = s.statedCooldownMs ?? QODER_QUOTA_COOLDOWN_MS;
      return s.result(
        "model_unreachable",
        "cooldown",
        cooldownMs,
        new Date(Date.now() + cooldownMs),
        s.reason("Qoder quota exhausted for this model"),
        s.origin === "upstream" && s.modelId !== undefined,
      );
    },
  },
  {
    name: "quota-exhausted",
    match: (s) => s.quotaSignal,
    decide: (s) => {
      // xAI Grok Build's free tier resets on a rolling window. Use a duration
      // stated by the provider when present; otherwise park for the conservative
      // 24-hour fallback.
      const grokFreeTier =
        s.providerCode === "subscription:free-usage-exhausted" ||
        s.providerCode.startsWith("subscription:") ||
        // A 402 spend/entitlement wall (`personal-team-blocked:spending-limit`,
        // "out of credits") is the same verdict: the account cannot serve until
        // the operator tops up or upgrades. The default 1h fallback re-dialled
        // it every hour inside a window that will not clear on its own.
        s.providerCode.includes("spending") ||
        s.providerCode.includes("credits") ||
        s.lower.includes("free-usage") ||
        s.lower.includes("free usage") ||
        s.lower.includes("included free usage") ||
        s.lower.includes("rolling 24-hour") ||
        s.lower.includes("rolling 24 hour") ||
        s.lower.includes("spending limit") ||
        s.lower.includes("out of credits") ||
        s.lower.includes("run out of credits") ||
        s.lower.includes("need a grok subscription");
      const buddyCreditsExhausted =
        s.providerCode === "14018" || s.lower.includes("credits exhausted");
      const cooldownMs = grokFreeTier
        ? (s.statedCooldownMs ?? GROK_QUOTA_COOLDOWN_MS)
        : buddyCreditsExhausted
          ? (s.statedCooldownMs ?? 12 * 60 * 60 * 1000)
          : (s.statedCooldownMs ?? DEFAULT_QUOTA_COOLDOWN_MS());
      // The caller records against the concrete account that just failed
      // upstream, so a provider-scoped quota error still cools THAT account
      // down (enables fallback to the next account). Local-origin quota must
      // never mutate an upstream account.
      return s.result(
        "quota_exhausted",
        "cooldown",
        cooldownMs,
        new Date(Date.now() + cooldownMs),
        s.reason("Provider quota exhausted"),
        s.origin === "upstream",
      );
    },
  },
  {
    // Inception's Free tier throttles per minute (1 000 requests / 1M input
    // tokens / 100K output tokens) and the window resets every minute. A
    // generic 429 would cool the account for the 15-minute default, leaving a
    // healthy key parked long after the window refilled — the source of
    // "limitasiya lumayan keras". This arm must run before `rate-limit`: it
    // matches the same signals and shortens the window to 1 minute so routing
    // moves to the next account and the flagged one returns almost at once.
    name: "inception-per-minute-limit",
    match: (s) =>
      s.providerId === "inception" &&
      (s.statusCode === 429 ||
        s.providerCode === "rate_limit_reached" ||
        s.providerCode === "rate_limit_exceeded" ||
        s.lower.includes("rate_limit") ||
        s.lower.includes("rate limit") ||
        s.lower.includes("too many requests") ||
        s.lower.includes("tokens per minute") ||
        s.lower.includes("input token")),
    decide: (s) => {
      const cooldownMs = s.statedCooldownMs ?? INCEPTION_RATE_LIMIT_COOLDOWN_MS;
      return s.result(
        "rate_limit_transient",
        "cooldown",
        cooldownMs,
        new Date(Date.now() + cooldownMs),
        s.reason("Inception per-minute input-token limit"),
        s.origin === "upstream",
      );
    },
  },
  {
    name: "rate-limit",
    match: (s) =>
      s.statusCode === 429 ||
      s.providerCode === "rate_limit_exceeded" ||
      s.lower.includes("rate_limit") ||
      s.lower.includes("rate limit") ||
      s.lower.includes("too many requests") ||
      s.lower.includes("requests per minute") ||
      s.lower.includes("tokens per minute") ||
      s.lower.includes("tpm limit") ||
      s.lower.includes("rpm limit"),
    decide: (s) => {
      const cooldownMs = s.statedCooldownMs ?? DEFAULT_RATE_LIMIT_COOLDOWN_MS();
      // Same per-account reasoning as quota above: the failing account (or
      // its model, when modelId is present) backs off so routing tries the
      // next candidate instead of hammering the same key.
      return s.result(
        "rate_limit_transient",
        "cooldown",
        cooldownMs,
        new Date(Date.now() + cooldownMs),
        s.reason("Provider rate limit"),
        s.origin === "upstream",
      );
    },
  },
  {
    name: "model-capacity",
    match: (s) =>
      s.statusCode === 503 ||
      s.statusCode === 529 ||
      s.providerCode === "model_capacity" ||
      s.queuedUpstream ||
      s.lower.includes("model overloaded") ||
      s.lower.includes("capacity exceeded") ||
      s.lower.includes("temporarily unavailable"),
    decide: (s) => {
      const cooldownMs = s.statedCooldownMs ?? MODEL_CAPACITY_COOLDOWN_MS();
      const modelScopedMutation = s.origin === "upstream" && s.modelId !== undefined;
      return s.result(
        "model_capacity",
        "cooldown",
        cooldownMs,
        new Date(Date.now() + cooldownMs),
        s.reason("Provider model capacity"),
        modelScopedMutation,
      );
    },
  },
  {
    name: "model-unsupported",
    match: (s) => isUnsupportedModelEvidence(s.statusCode, s.providerCode, s.folded),
    decide: (s) => {
      const cooldownMs = unsupportedModelCooldownMs(s.modelBlockHits);
      return s.result(
        "model_unreachable",
        "cooldown",
        cooldownMs,
        new Date(Date.now() + cooldownMs),
        s.reason("Model not supported by this upstream"),
        s.origin === "upstream" && s.modelId !== undefined,
        true,
      );
    },
  },
  {
    name: "model-unreachable",
    match: (s) => s.providerCode === "not_found" || s.modelEntitlementFailure,
    decide: (s) => {
      const cooldownMs = MODEL_UNREACHABLE_COOLDOWN_MS;
      // Not credential evidence, so `classifyUpstreamFailure` scopes this to the
      // provider and the `scope === "account"` gate the throttles use would
      // forbid the mutation outright — leaving the probe reporting a failure that
      // cooled nothing. The verdict is still about one (account, model) pair:
      // `recordAccountFailure` writes `modelCooldowns[modelId]` and leaves the
      // account's own status untouched, so all that is required is a model to
      // write against.
      const modelScopedMutation = s.origin === "upstream" && s.modelId !== undefined;
      return s.result(
        "model_unreachable",
        "cooldown",
        cooldownMs,
        new Date(Date.now() + cooldownMs),
        s.reason("Model unreachable for this account"),
        modelScopedMutation,
      );
    },
  },
  {
    // Qoder closes an exhausted-quota stream with upstream 499 (nginx
    // client-close style). The gateway's own aborts are local `transport_closed`
    // and never carry a qoder providerId, so a 499 scoped to qoder is a quota
    // verdict, not a transport fault. It must run before `transport-fault`,
    // which otherwise reads the status as a 5xx-class outage and cools the
    // account for the shorter transient window — or leaves it unmutated.
    //
    // The verdict is per-model, like Qoder's other quota signs: one model's
    // spend cap does not drain another, so it cools the pair, never the whole
    // account.
    name: "qoder-499-quota",
    match: (s) =>
      (s.providerId === "qoder" || s.providerId === "qodercn") &&
      s.statusCode === 499 &&
      s.origin === "upstream",
    decide: (s) => {
      const cooldownMs = s.statedCooldownMs ?? QODER_QUOTA_COOLDOWN_MS;
      return s.result(
        "model_unreachable",
        "cooldown",
        cooldownMs,
        new Date(Date.now() + cooldownMs),
        s.reason("Qoder quota exhausted for this model (upstream 499)"),
        s.origin === "upstream" && s.modelId !== undefined,
      );
    },
  },
  {
    name: "transport-fault",
    match: (s) =>
      (s.statusCode !== null && s.statusCode >= 500 && s.statusCode <= 504) ||
      s.lower.includes("timeout") ||
      s.lower.includes("abort") ||
      s.lower.includes("econnrefused") ||
      s.lower.includes("fetch failed"),
    decide: (s) => {
      // A transport-shaped fault clears on its own, so it is a cooldown with a
      // deadline rather than a state needing an operator. The deadline matters:
      // `sweepExpiredCooldowns` selects on `cooldownUntil IS NOT NULL`, so a row
      // parked without one is never recovered and stays out of rotation.
      //
      // `canMutate` rather than a flat `false`: a 5xx whose failure the caller
      // scoped to the account (an edge/WAF challenge answered to one account's
      // requests while its siblings on the same egress served fine) must cool
      // that account down, or it stays `active` and is re-dialled for as long as
      // the block lasts. Provider-scoped 5xx does not: the upstream is
      // indiscriminately failing and no single account is at fault.
      const transientMs = TRANSIENT_ERROR_COOLDOWN_MS();
      return s.result(
        s.lower.includes("timeout") ? "timeout" : "server_error",
        "cooldown",
        transientMs,
        new Date(Date.now() + transientMs),
        s.reason(`Provider ${s.statusCode ?? "network"} failure`),
        s.canMutate,
      );
    },
  },
];
