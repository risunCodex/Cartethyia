/**
 * Evidence half of account error classification: turns the thrown error plus
 * the caller's {@link AccountFailureEvidence} into the normalized context the
 * ordered rules read. Pure — reads evidence, writes nothing.
 */
import { isRecord } from "../../protocol/codecs";
import { GatewayError } from "../../protocol/gateway-error";
import { parseProviderResetDuration, parseUpstreamBackoff } from "../../protocol/upstream-parsing";
import { resolveAccountUnclassifiedCooldownMs } from "../../config/cooldowns";
import type {
  AccountErrorCategory,
  AccountErrorClassification,
  AccountErrorResult,
  AccountFailureEvidence,
  AccountFailureOrigin,
  AccountFailureScope,
} from "./account-error-contracts";
import { transientRateLimitWording } from "./account-error-contracts";
import { isBuddyAccountBanned } from "./provider-rules/buddy";

/**
 * Backoff for a failure no rule matched. Short on purpose: an unclassified
 * error is more likely a new upstream shape than a broken account, so the
 * account returns to rotation quickly.
 */
const UNCLASSIFIED_COOLDOWN_MS = resolveAccountUnclassifiedCooldownMs;

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

/** Reads `error.message` from a parsed upstream body object. */
function nestedErrorMessage(body: unknown): string {
  if (typeof body !== "object" || body === null) return "";
  const record = body as Record<string, unknown>;
  if (typeof record["message"] === "string") return record["message"];
  const error = record["error"];
  if (typeof error === "object" && error !== null) {
    const message = (error as Record<string, unknown>)["message"];
    if (typeof message === "string") return message;
  }
  return "";
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
 *
 * Structured Google rpc error details are read too — Vertex/Antigravity returns
 * the reset inside `details[]` as `ErrorInfo.metadata.quotaResetDelay` /
 * `quotaResetTimeStamp` and `RetryInfo.retryDelay` (a Go duration like
 * `596805.017558959s`). Without this a "Resets in 165h46m45s" refusal cooled
 * for the 15-minute fallback and re-entered rotation hours before it could
 * serve. The prose `message` is parsed through `parseProviderResetDuration` as
 * a last resort, because several providers state the window only there.
 */
function parseUpstreamBodyReset(body: unknown): number | null {
  if (typeof body !== "object" || body === null) return null;
  const record = body as Record<string, unknown>;
  // Some providers nest under `error`, some return it at the top level.
  const errorRecord = (record["error"] as Record<string, unknown> | undefined) ?? undefined;
  const candidates = [record, errorRecord];
  let best: number | null = null;
  const consider = (delay: number | null | undefined): void => {
    if (typeof delay !== "number" || !Number.isFinite(delay) || delay <= 0) return;
    best = best === null ? delay : Math.max(best, delay);
  };
  for (const candidate of candidates) {
    if (typeof candidate !== "object" || candidate === null) continue;
    const now = Date.now();

    const absolute = candidate["resets_at"] ?? candidate["reset_at"];
    if (typeof absolute === "number" && Number.isFinite(absolute) && absolute > 0) {
      // Seconds vs milliseconds: a plausible epoch in seconds is ~10 digits, in
      // milliseconds ~13, and the two are four orders of magnitude apart — so
      // the smaller is scaled up rather than guessed from a threshold date.
      const epochMs = absolute < 1e11 ? absolute * 1000 : absolute;
      consider(epochMs - now);
    }

    const relative =
      candidate["resets_in_seconds"] ??
      candidate["reset_in_seconds"] ??
      candidate["retry_after_seconds"];
    if (typeof relative === "number" && Number.isFinite(relative) && relative > 0) {
      consider(relative * 1000);
    }

    const minutes = candidate["limit_window_minutes"] ?? candidate["reset_in_minutes"];
    if (typeof minutes === "number" && Number.isFinite(minutes) && minutes > 0) {
      consider(minutes * 60_000);
    }

    // The body's own prose (both top-level and nested under `error`): providers
    // that state the window only in the message ("Resets in 165h46m45s") are
    // honored rather than cooled for the 15-minute fallback.
    const prose = candidate["message"];
    if (typeof prose === "string" && prose.length > 0) {
      consider(parseProviderResetDuration(prose));
    }
  }

  // Google rpc `details[]` (Vertex/Antigravity error frames): `ErrorInfo`
  // metadata carries the reset delay/timestamp, `RetryInfo` carries the retry
  // delay directly.
  const details = errorRecord?.["details"];
  if (Array.isArray(details)) {
    for (const detail of details) {
      if (typeof detail !== "object" || detail === null) continue;
      const entry = detail as Record<string, unknown>;
      const type = typeof entry["@type"] === "string" ? entry["@type"] : "";
      if (type.includes("google.rpc.ErrorInfo")) {
        const metadata = entry["metadata"] as Record<string, unknown> | undefined;
        const delay = metadata?.["quotaResetDelay"] ?? metadata?.["quotaResetDelaySeconds"];
        consider(parseGoDuration(delay));
        const stamp =
          metadata?.["quotaResetTimeStamp"] ?? metadata?.["quotaResetTimestamp"];
        if (typeof stamp === "string" && stamp.length > 0) {
          const t = new Date(stamp).getTime();
          if (Number.isFinite(t)) consider(t - Date.now());
        }
      }
      if (type.includes("google.rpc.RetryInfo")) {
        consider(parseGoDuration(entry["retryDelay"]));
      }
      // Some providers put the retry delay on the detail without a type.
      consider(parseGoDuration(entry["retryDelay"]));
    }
  }
  return best === null ? null : Math.min(MAX_UPSTREAM_STATED_COOLDOWN_MS, Math.round(best));
}

/** Parses a Go duration string (`596805.017558959s`, `1h30m0s`) to ms. */
function parseGoDuration(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const text = value.trim().replace(/\s+/g, "");
  if (!/^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m)?(?:(\d+(?:\.\d+)?)s)?$/.test(text)) {
    return null;
  }
  const match = /^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m)?(?:(\d+(?:\.\d+)?)s)?$/.exec(text);
  if (!match) return null;
  let ms = 0;
  if (match[1] !== undefined) ms += Number(match[1]) * 3_600_000;
  if (match[2] !== undefined) ms += Number(match[2]) * 60_000;
  if (match[3] !== undefined) ms += Number(match[3]) * 1_000;
  return ms > 0 ? ms : null;
}

export interface AccountErrorContext {
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
  readonly result: AccountErrorResult;
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
export function extractValidationUrl(
  message: string,
  rawUpstreamResponse: string | undefined,
): string | undefined {
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
export function accountErrorContext(
  error: unknown,
  options?: AccountFailureEvidence,
): AccountErrorContext {
  const errorRecord = isRecord(error) ? error : undefined;
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
  const rawUpstreamResponse =
    origin === "upstream" &&
    error instanceof GatewayError &&
    typeof error.details.raw === "string"
      ? error.details.raw
      : undefined;
  // The surface `message` may be a generic placeholder ("Provider returned HTTP
  // 429.") even when the upstream body states a reset window. Fall through to
  // the raw body's prose when the surface message names none, so a
  // "Resets in 165h46m45s" refusal is honored instead of cooling for the
  // 15-minute fallback.
  const messageCooldown =
    parseProviderResetDuration(message) ??
    (rawUpstreamResponse === undefined
      ? null
      : parseProviderResetDuration(rawUpstreamResponse)) ??
    (options?.upstreamBody === undefined
      ? null
      : typeof options.upstreamBody === "string"
        ? parseProviderResetDuration(options.upstreamBody)
        : parseProviderResetDuration(nestedErrorMessage(options.upstreamBody)));
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
  const result: AccountErrorResult = (
    category: AccountErrorCategory,
    status: AccountErrorClassification["status"],
    cooldownMs: number,
    retryAt: Date | null,
    explanation: string,
    mutatesAccount = canMutate,
    modelUnsupported = false,
    modelScoped = false,
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
    // The provider's own stated window, before any rule floors it — see
    // `AccountErrorClassification.statedCooldownMs`.
    statedCooldownMs,
    // Usage-limit exhaustion, spending caps, and credential verdicts rotate to a
    // sibling account now; transient throttles (per-minute, capacity) do not.
    // The transient guard also applies to a category the classifier resolved to
    // `quota_exhausted` — a TPM/RPM throttle phrased with quota wording
    // ("tpm exhausted (type=quota_exceeded_error)") still self-heals within the
    // minute and must not burn a sibling credential.
    rotateAccount:
      (category === "quota_exhausted" || category === "policy_blocked_banned") &&
      !(statusCode === 429 && transientRateLimitWording(lower)) &&
      !(statusCode === 503 || statusCode === 529),
    modelUnsupported,
    modelScoped,
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

/** Unclassified-failure backoff, re-exported for the classifier's fallback arm. */
export { UNCLASSIFIED_COOLDOWN_MS };
