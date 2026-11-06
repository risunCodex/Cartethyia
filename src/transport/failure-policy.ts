import { GatewayError, type GatewayErrorCode, type GatewayErrorOrigin } from "../protocol/gateway-error";
import { isRecord } from "../protocol/codecs";
import { resolveFallbackRetryBaseMs, resolveFallbackRetryCapMs } from "../config/timeouts";
import { parseUpstreamBackoff } from "../protocol/upstream-parsing";
import { resolveAccountQuotaCooldownMs } from "../config/cooldowns";

/**
 * How much of the upstream's error body is kept and surfaced.
 *
 * 500 bytes cut the CodeBuddy envelope mid-`extError`: the operator saw
 * "request illegal" with none of the `displayMsg` prose that names the actual
 * condition — "prompt is too long: 1048788 tokens > 1048576 maximum" — so a
 * context overflow was indistinguishable from a policy refusal. The envelope
 * runs a few KB; 4000 keeps the whole thing while bounding a hostile body.
 */
const MAX_UPSTREAM_ERROR_BYTES = 4000;
export { MAX_UPSTREAM_ERROR_BYTES };
export {
  parseRetryAfter,
  parseRateLimitReset,
  parseResetAfterMs,
  parseUpstreamBackoff,
  parseProviderResetDuration,
  parseAbsoluteResetTimestamp,
} from "../protocol/upstream-parsing";
/**
 * Extracts only the human-readable text from an upstream error body —
 * `message`/`msg`/`error` fields — deliberately skipping `code`/identifier
 * values. Used by `upstreamMessageAsIs` to decide whether the upstream
 * actually supplied a message: a symbolic code like `"permission_error"` is
 * an identifier, not prose, so it must not count as passthrough text.
 */
export function extractUpstreamMessageText(body: unknown): string {
  let raw = "";
  if (typeof body === "string") raw = body;
  else if (isRecord(body)) {
    if (typeof body.error === "string" && body.error.trim()) raw = body.error;
    else {
      const envelope = isRecord(body.error) ? body.error : body;
      const message = (envelope as Record<string, unknown>).message;
      if (typeof message === "string" && message.trim()) raw = message;
      else if (typeof body.msg === "string" && body.msg.trim()) raw = body.msg;
      else if (typeof (envelope as Record<string, unknown>).msg === "string" && String((envelope as Record<string, unknown>).msg).trim())
        raw = String((envelope as Record<string, unknown>).msg);
      else if (typeof (envelope as Record<string, unknown>).error === "string" && String((envelope as Record<string, unknown>).error).trim())
        raw = String((envelope as Record<string, unknown>).error);
    }
  }
  return raw.replace(/[\r\n]+/g, " ").trim();
}

/** Extracts a bounded, newline-free provider message from any error envelope. */
export function extractUpstreamMessage(body: unknown): string {
  let raw = "";
  if (typeof body === "string") raw = body;
  else if (isRecord(body)) {
    // Cline-style {"error":"Not Found","success":false} — error is a string, not an envelope.
    if (typeof body.error === "string" && body.error.trim()) raw = body.error;
    else {
      const envelope = isRecord(body.error) ? body.error : body;
      const message = (envelope as Record<string, unknown>).message;
      const code = (envelope as Record<string, unknown>).code;
      if (typeof message === "string" && message.trim()) raw = message;
      // A *symbolic* code (`"invalid_api_key"`, `"c"`) is readable on its own, so
      // it still wins over a sibling. A bare-numeric code is an identifier, not a
      // message: the WorkBuddy/CodeBuddy family sends
      // `{"code":"6004","msg":"your usage will reset at <stamp> UTC+8"}`, and
      // taking the digits discarded the only text the account-health machine can
      // parse for a stated reset — so the account fell back to the generic default
      // cooldown and failed every request inside the provider's real window.
      // Skipping digits lets the `msg`/`message` branches below supply the text.
      else if (typeof code === "string" && code.trim() && !/^\d+$/.test(code.trim())) raw = code;
      else if (typeof body.message === "string" && body.message.trim()) raw = body.message;
      // WorkBuddy/CodeBuddy put the human-readable text in a top-level `msg`
      // while `extError.message` repeats it; without this the operator saw an
      // empty message for a 400 that had a perfectly clear one.
      else if (typeof body.msg === "string" && body.msg.trim()) raw = body.msg;
      else if (typeof (envelope as Record<string, unknown>).msg === "string" && String((envelope as Record<string, unknown>).msg).trim())
        raw = String((envelope as Record<string, unknown>).msg);
      else if (typeof (envelope as Record<string, unknown>).error === "string" && String((envelope as Record<string, unknown>).error).trim())
        raw = String((envelope as Record<string, unknown>).error);
      // Last resort: the numeric code is still better than an empty message, since
      // it is what the operator would quote to the provider.
      else if (typeof code === "string" && code.trim()) raw = code;
    }
  }
  return raw.replace(/[\r\n]+/g, " ").trim().slice(0, MAX_UPSTREAM_ERROR_BYTES);
}

/**
 * The provider's own error code from an upstream error body, as a string.
 *
 * Upstreams disagree about where it lives and what type it is:
 *
 *   - `{"error":{"code":"invalid_api_key"}}` — nested, string
 *   - `{"code":11148,"extError":{"code":"tool_call_sequence_broken"}}` —
 *     top-level **number**, with a more specific string nested in `extError`
 *
 * Reading only a nested string dropped the code for the second family
 * entirely, so the operator saw a bare message with no provider code.
 */
/**
 * The provider code hidden inside one string value, or `undefined`.
 *
 * Recognizes both a nested JSON envelope written as an escaped string
 * (`"{\"code\":\"11-128\"}"`) and the bare escaped form (`"\"code\\\":\\\"11-128\""`).
 * Cheap by construction: the scan is a substring test, and only a string that
 * looks like it carries a code is handed to `JSON.parse`, so a large message
 * body costs one `includes` rather than a parse.
 */
function parseEmbeddedCode(value: string): string | undefined {
  if (!value.includes("code")) return undefined;
  // An escaped envelope: try it as JSON first, then with its escapes collapsed.
  for (const candidate of [value, value.replace(/\\+"/g, '"')]) {
    const trimmed = candidate.trim();
    if (!trimmed.startsWith("{") && !trimmed.startsWith('"')) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const code = upstreamProviderCode(parsed);
    if (code !== undefined) return code;
  }
  // A bare `"code": "11-128"` fragment inside a longer message.
  const match = value.match(/\\*["']?code\\*["']?\s*:\s*\\*["']?([A-Za-z0-9_.:-]{3,32})/i);
  return match?.[1];
}

export function upstreamProviderCode(body: unknown): string | undefined {
  if (!isRecord(body)) return undefined;
  const nested = isRecord(body.error) ? body.error : undefined;
  const ext = isRecord(body.extError) ? body.extError : undefined;
  for (const candidate of [ext?.code, nested?.code, body.code]) {
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
  }
  // A provider may embed its error envelope as an *escaped string* rather than a
  // nested object — `"error": "{\"code\":\"11-128\",...}"` — so none of the
  // candidates above is a record and the code is invisible. That is the shape
  // the reference gateways detect, and it matters because the channel code is
  // what decides whether an account is cooled: missing it, a blocked account
  // stays in rotation failing every request.
  for (const candidate of [ext, nested, body]) {
    if (!isRecord(candidate)) continue;
    for (const value of Object.values(candidate)) {
      if (typeof value !== "string") continue;
      const embedded = parseEmbeddedCode(value);
      if (embedded !== undefined) return embedded;
    }
  }
  // A numeric code is still the provider's identifier; keep it as text so an
  // operator can search for it. The nested string above wins when both exist.
  const numeric = ext?.code ?? nested?.code ?? body.code;
  if (typeof numeric === "number" && Number.isFinite(numeric)) return String(numeric);
  return undefined;
}

/**
 * Extracts the stable request ID header used in provider diagnostics.
 *
 * Each candidate is trimmed and treated as absent when empty. `Headers.get`
 * returns `""` — not `null` — for a header that was sent with no value, and `??`
 * falls through only on null, so a provider emitting a bare `x-request-id:` used
 * to discard a perfectly good `request-id` or `cf-ray` on the same response. The
 * id is the only handle an operator has for a provider support ticket
 * (`probe-phases` appends it to the surfaced error text, `codex-errors` stores it
 * in `details.upstreamRequestId`), so losing it makes the failing request
 * uncorrelatable upstream.
 */
export function upstreamRequestId(headers: Headers | undefined): string | undefined {
  if (!headers) return undefined;
  for (const name of ["x-request-id", "request-id", "x-amzn-requestid", "cf-ray"]) {
    const value = headers.get(name)?.trim();
    if (value) return value;
  }
  return undefined;
}

/**
 * Canonical status→code mapping for upstream HTTP failures.
 *
 * Structured error identifiers are refined by `classifyUpstreamError`; this
 * status-only table keeps distinct HTTP failure classes distinct without
 * guessing whether a generic 404 names a model or an upstream route.
 */
export function statusToGatewayErrorCode(status: number): GatewayErrorCode {
  if (status === 401 || status === 403) return "authentication_failed";
  if (status === 402 || status === 429) return "quota_exceeded";
  if (status === 404) return "upstream_not_found";
  if (status === 407) return "proxy_auth_required";
  if (status === 408 || status === 504) return "deadline_exceeded";
  if (status === 409) return "upstream_conflict";
  if (status === 413) return "request_too_large";
  if (status === 415) return "unsupported_media_type";
  if (status === 422) return "upstream_unprocessable";
  if (status === 529) return "upstream_overloaded";
  if (status >= 500 && status <= 599) return "platform_unavailable";
  return "invalid_request";
}

/** Normalized account-health evidence and retry decision for one failure. */
export interface UpstreamFailurePolicy {
  readonly retryable: boolean;
  readonly mutatesAccount: boolean;
  readonly cooldownMs?: number;
  readonly category: string;
  readonly scope?: "account" | "provider" | "network";
  readonly origin: GatewayErrorOrigin;
  readonly providerCode?: string;
  readonly credentialEvidence?: boolean;
  readonly retryAfterMs?: number;
  readonly statusCode?: number;
  /** Provider that produced the failure, for the buddy policy blocks (`11140`, and `11-128` channel verification). */
  readonly providerId?: string;
}

/** Classifies one dispatch failure for both fallback routing and account health. */
export function classifyUpstreamFailure(error: unknown): UpstreamFailurePolicy {
  if (!(error instanceof GatewayError)) {
    return { retryable: true, mutatesAccount: false, category: "network", scope: "network", origin: "network" };
  }
  const providerCode = typeof error.details.providerCode === "string" ? error.details.providerCode : undefined;
  const providerId = typeof error.details.providerId === "string" ? error.details.providerId : undefined;
  const credentialEvidence = error.details.credentialEvidence === true || error.details.accountScope === true;
  // The buddy family reuses `11-128` for two unrelated rejections, so the code
  // alone is not evidence:
  //
  // - "conversation id missing" — a malformed outbound request. The fault is
  //   this gateway's, so cooling the account would burn a healthy credential
  //   on a body that fails identically everywhere.
  // - "request illegal" / "failed channel verification … not sent from an
  //   official client" — a verdict on the account's channel. Proven account-
  //   scoped: two live share-page requests carrying byte-identical bodies and
  //   headers to the same model differed only in the pooled account, and the
  //   blocked one 400'd while the other 200'd (2026-10-16).
  //
  // Only the second may mutate account health, hence the message test.
  const message = error.message.toLowerCase();
  const channelBlockEvidence =
    providerCode === "11-128" &&
    (message.includes("request illegal") || message.includes("channel verification"));
  const policyAccountEvidence = providerCode === "11140" || channelBlockEvidence;
  let scope: "network" | "account" | "provider";
  if (error.origin === "network") scope = "network";
  else if (credentialEvidence || policyAccountEvidence) scope = "account";
  else scope = "provider";
  const retryAfterMs = typeof error.details.retryAfterMs === "number" ? error.details.retryAfterMs : undefined;
  // The retry decision follows `statusToGatewayErrorCode` — the canonical
  // status→code table above — rather than a hand-rolled range. The two disagreed:
  // the table classifies the whole 500–599 band as `platform_unavailable`, while
  // this predicate retried only 500–504. An upstream 505/507/520/522/524/530/599
  // therefore produced a `platform_unavailable` error that this called terminal,
  // and `runAttemptLoop` stopped on it (`!isRetryableFailure(error)` sets
  // `terminalAttempt`) even with healthy candidates left.
  //
  // The reachable cases are exactly the ones failover exists for: Cloudflare
  // answers 520/521/522/523/524 when the ORIGIN is down or timing out — a
  // per-route condition a sibling candidate would survive — and 530 is an origin
  // DNS failure. Failing the client request instead of failing over is the wrong
  // outcome for a whole class the table already names as platform-wide.
  const statusCode = error.status;
  // Qoder answers an exhausted quota by closing the stream with an upstream 499
  // (nginx client-close style). That is a refusal from the upstream — the
  // gateway's own aborts are `transport_closed`, produced locally, and never
  // carry a qoder providerId — so a 499 scoped to qoder is quota, not a
  // malformed request. Without this it fell through to `invalid_request`
  // (non-retryable, no cooldown) and the account was re-dialled on every
  // request inside the exhausted window until a late 429 finally classified it.
  if (
    error.origin === "upstream" &&
    statusCode === 499 &&
    (providerId === "qoder" || providerId === "qodercn")
  ) {
    const cooldownMs = resolveAccountQuotaCooldownMs();
    return {
      retryable: true,
      mutatesAccount: true,
      category: "quota_exceeded",
      scope: "account",
      origin: error.origin,
      ...(providerCode ? { providerCode } : {}),
      ...(providerId ? { providerId } : {}),
      cooldownMs,
      statusCode,
    };
  }
  const retryableByStatus =
    statusCode === 401 ||
    statusCode === 403 ||
    statusCode === 429 ||
    (statusCode >= 500 && statusCode <= 599);
  const mutatesAccount = error.origin === "upstream" && scope === "account";
  const retryable =
    // Gateway-wide overload: no sibling candidate can help, because the whole
    // process is short of memory. The correct move is the client retrying after
    // the hint, not another attempt here.
    error.code === "overloaded"
      ? false
      : mutatesAccount || // account-scoped failure: try a sibling regardless of status
        error.code === "capability_unsupported" ||
    error.code === "model_not_found" ||
    error.code === "admission_unavailable" ||
    error.code === "route_unavailable" ||
    error.code === "capacity_exhausted" ||
    error.code === "upstream_overloaded" ||
    // A provider max-inflight rejection: the plan's next sibling account may
    // have a free slot, exactly as with an API-key concurrency rejection.
    error.code === "provider_capacity_exhausted" ||
    // The upstream accepted the request and is holding it in a queue. Another
    // account of the same provider is very likely not queued, so failover is
    // the faster answer — and if every account is queued, the caller still has
    // the stated interval to wait for.
    error.code === "upstream_queued" ||
    error.code === "accounts_unavailable" ||
    error.code === "accounts_rate_limited" ||
    error.code === "quota_exceeded" ||
    error.code === "rate_limited" ||
    error.code === "authentication_failed" ||
    error.code === "proxy_auth_required" ||
    error.code === "deadline_exceeded" ||
    // An overflow is a property of the window the *chosen* route offers, not
    // of the request: a sibling on a larger window may take it unchanged. 413
    // is not in `retryableByStatus`, so without this the client got the first
    // candidate's overflow even when a candidate that fit was next in line.
    // Nothing here shrinks or rewrites the prompt — a candidate that fits is
    // tried verbatim, and only exhausting them returns the overflow.
    error.code === "context_length_exceeded" ||
    retryableByStatus;
  return {
    retryable,
    mutatesAccount,
    category: error.code,
    scope,
    origin: error.origin,
    ...(providerCode ? { providerCode } : {}),
    ...(providerId ? { providerId } : {}),
    ...(credentialEvidence ? { credentialEvidence: true } : {}),
    ...(retryAfterMs === undefined ? {} : { retryAfterMs, cooldownMs: retryAfterMs }),
    statusCode: error.status,
  };
}

/**
 * Transport-level failure signatures a runtime fetch body can raise when the
 * upstream socket dies mid-response. Bun (this gateway's runtime) raises
 * `TypeError` with `code: "ECONNRESET"` ("The socket connection was closed
 * unexpectedly"); Node/undici raises `TypeError: terminated`; libuv surfaces
 * `ECONNRESET`/`EPIPE` on the error. All mean the same thing: the upstream
 * connection dropped — an upstream transport failure, not an unexplained
 * gateway fault.
 */
function isUpstreamSocketDrop(error: unknown): boolean {
  if (!(error instanceof TypeError) && !(error instanceof Error)) return false;
  if ("code" in error && typeof error.code === "string") {
    if (error.code === "ECONNRESET" || error.code === "EPIPE" || error.code === "UND_ERR_SOCKET") {
      return true;
    }
  }
  const message = String(error.message ?? "");
  return (
    message.includes("socket connection was closed unexpectedly") ||
    message.startsWith("terminated") ||
    message.includes("other side closed")
  );
}

/**
 * Terminal telemetry category for one failed attempt.
 *
 * A raw abort is not an unexplained gateway failure: our own deadline timers
 * abort with a `TimeoutError`, a client disconnect bridges the inbound signal
 * or the stream's `cancel()` (both `AbortError`s), and the stall watchdog
 * aborts with a `GatewayError` the reader may surface only as an abort.
 * Labeling every non-GatewayError `unknown_error` recorded ordinary client
 * cancels as "the upstream failure could not be classified" — blameless
 * diagnostics lost the real outcome. Only a failure with no abort behind it
 * stays unknown.
 */
export function classifyTerminalCategory(
  error: unknown,
  signal: AbortSignal,
): GatewayErrorCode | "unknown_error" {
  if (error instanceof GatewayError) return error.code;
  const reason: unknown = signal.reason;
  // The reader often rejects with a bare AbortError while the signal carries
  // the actual cause (watchdog deadline, shutdown).
  if (reason instanceof GatewayError) return reason.code;
  if (signal.aborted) {
    if (reason instanceof DOMException && reason.name === "TimeoutError") return "deadline_exceeded";
    return "transport_closed";
  }
  // A mid-response upstream socket drop reaches here as a raw runtime error:
  // the upstream's transport failed, so the blame is upstream, not unknown.
  if (isUpstreamSocketDrop(error) || isUpstreamSocketDrop(reason)) {
    return "transport_unavailable";
  }
  return "unknown_error";
}

/**
 * Whether a failed attempt is a **client cancel** — the one case the console
 * records as `cancelled` (499) rather than `failed`.
 *
 * The request controller aborts for three different reasons, and only one of
 * them is the client's:
 *
 * - **Client disconnect** — the inbound signal bridges the client's
 *   `AbortError`; the request truly has no client left.
 * - **Deadline / stall watchdog** — our own timer aborts with a
 *   `deadline_exceeded` `GatewayError` or a `TimeoutError`. The client is
 *   still there and is owed the 504/502.
 * - **Drain** — a shutdown `GatewayError`; the caller gets a 503.
 *
 * Reading `signal.aborted` alone conflated all three: a request that failed
 * because the upstream ended without a terminal event (`transport_unavailable`,
 * 502) was recorded `cancelled`/499 whenever the watchdog had also fired,
 * producing a row whose status (499), error category (`transport_unavailable`)
 * and http status (502) disagreed — the drawer could not be trusted. The
 * decision must key on *why* the controller aborted, not that it did.
 *
 * A `transport_closed` `GatewayError` is our own "no client left" marker (the
 * attempt loop raises it when the signal is already aborted at entry), so it
 * counts as a cancel even without a signal reason. Every other abort —
 * including a bare `AbortError` whose signal reason is a watchdog/drain
 * `GatewayError` — is a failure, not a cancel.
 */
export function isClientCancellation(error: unknown, signal: AbortSignal): boolean {
  // A typed error names the outcome directly: only our own "no client left"
  // marker is a cancel, whatever the signal says.
  if (error instanceof GatewayError) return error.code === "transport_closed";
  // Otherwise the reader rejected with a bare abort and the signal reason says
  // why. A watchdog (deadline/stall) or drain abort is a gateway-side outcome.
  const reason: unknown = signal.reason;
  if (reason instanceof GatewayError) return false;
  if (reason instanceof DOMException && reason.name === "TimeoutError") return false;
  return signal.aborted && reason instanceof DOMException && reason.name === "AbortError";
}

/** The three terminal fields that must never disagree about one failed attempt. */
export interface TerminalOutcome {
  readonly status: "cancelled" | "failed";
  readonly errorCategory: GatewayErrorCode | "unknown_error";
  readonly errorOrigin: GatewayErrorOrigin;
  /**
   * The HTTP status the row should carry. `undefined` means the caller has a
   * better one (the wire status of an actual response) and should keep it;
   * a raw error has none, and the caller's own fallback was 500 — which
   * read as a gateway fault for what was an upstream transport drop.
   */
  readonly httpStatus?: number;
}

/** The HTTP status each classifier-derived category carries when no wire response named one. */
const CATEGORY_HTTP_STATUS: Partial<Record<GatewayErrorCode | "unknown_error", number>> = {
  // The upstream's transport died mid-response: a bad gateway, not a fault
  // in this process.
  transport_unavailable: 502,
  platform_unavailable: 502,
  upstream_overloaded: 529,
  deadline_exceeded: 504,
  transport_closed: 499,
  shutting_down: 503,
  overloaded: 529,
  route_unavailable: 503,
  model_not_allowed: 403,
  rate_limited: 429,
  unknown_error: 500,
};

/**
 * Derives a failed attempt's status, error category, and error origin **from
 * one decision**, so the three can never contradict each other.
 *
 * Computing them independently at a dispatch call site lets them
 * drift: a request that failed on an upstream condition could be recorded
 * `cancelled` (499) while its category said `transport_unavailable` and its
 * http status said 502 — a row no operator could trust. Bundling them here
 * makes the inconsistency unrepresentable: a cancel always carries
 * `transport_closed` (the only category a cancel can produce), and any other
 * outcome carries the real code and origin.
 */
export function classifyTerminalOutcome(error: unknown, signal: AbortSignal): TerminalOutcome {
  const category = classifyTerminalCategory(error, signal);
  const gateway = error instanceof GatewayError ? error : signal.reason instanceof GatewayError ? signal.reason : undefined;
  return {
    status: isClientCancellation(error, signal) ? "cancelled" : "failed",
    errorCategory: category,
    // The classifier owns the blame. An upstream socket drop arrives as a
    // raw runtime error — no `GatewayError` wraps it — and calling that ours
    // made the row accuse the gateway for an upstream failure.
    errorOrigin: gateway
      ? gateway.origin
      : category === "transport_unavailable"
        ? "upstream"
        : "cartethyia",
    // A `GatewayError` carries its own status; a raw error takes the
    // category's, so an upstream drop is 502 rather than the 500 fallback.
    ...(gateway || CATEGORY_HTTP_STATUS[category] !== undefined
      ? { httpStatus: gateway ? gateway.status : CATEGORY_HTTP_STATUS[category] }
      : {}),
  };
}

/**
 * Structured upstream identifiers meaning "the request exceeded the model's
 * context window".
 *
 * Matched as exact identifiers on `error.code` / `error.type` (and the same
 * keys at the top level) — never as substrings of a free-text message. A
 * substring rule fires on any message containing the word, including text the
 * client itself wrote, and prose scans for phrases like "context window" or
 * "too many tokens" misfire the same way. Those heuristics
 * mislabel unrelated failures, so we read only the machine-readable field.
 */
const CONTEXT_LENGTH_CODES: ReadonlySet<string> = new Set([
  "context_length_exceeded",
  "context_too_large",
  "model_context_window_exceeded",
  // InferHub's spelling for the same condition.
  "context_too_long",
  // Trae answers an overflow on its streaming surface with the bare numeric
  // code `4026` and the prose "We're sorry, your context length has exceeded
  // the maximum limit." — no HTTP status, no symbolic code (verified live
  // 2026-10: `event:error data:{"code":4026,"message":"..."}`). Without it
  // the frame fell to the 502 `platform_unavailable` fallback and the client
  // never saw the 413 it compacts on.
  "4026",
]);

/**
 * The measured-size shape of a prose overflow, e.g.
 * `"prompt is too long: 100001 tokens > 100000 maximum"`.
 *
 * This is not a prose scan. It requires the upstream to state two numbers and
 * the comparison between them, which is the difference between an overflow
 * report and a message that merely quotes one: a client whose own prompt text
 * contains "prompt is too long" still does not match, because it states no
 * measured size and no ceiling. Requiring `larger > smaller` rules out the
 * remaining accidental matches, since a real overflow always reports more
 * tokens than the window allows.
 */
const PROSE_OVERFLOW_PATTERN =
  /(?:the\s+)?(?:prompt|request|input|context|messages?|conversation)\b[^.\n]{0,80}?(?:is\s+|are\s+)?too\s+long[^.\n]{0,40}?:?\s*(\d[\d_,]*)\s*(?:tokens?|chars?|characters?)\s*(?:>|>=|exceeds?|over)\s*(\d[\d_,]*)/i;

/** Digits with optional thousands separators, as `Number` wants them. */
function parseCount(raw: string): number {
  return Number(raw.replace(/[_,]/g, ""));
}

/**
 * Reads a prose overflow's measured size and ceiling, in tokens.
 *
 * Returns `undefined` unless the text states both numbers with the measured
 * side larger — so a malformed or coincidental match cannot promote a 400 to
 * a 413. When it does match, the numbers are returned so the error can quote
 * them: a client that compacts on overflow needs to know how far it overshot.
 */
export function proseOverflowLimit(text: string): { used: number; maximum: number } | undefined {
  const match = PROSE_OVERFLOW_PATTERN.exec(text);
  if (!match) return undefined;
  const used = parseCount(match[1]!);
  const maximum = parseCount(match[2]!);
  if (!Number.isFinite(used) || !Number.isFinite(maximum)) return undefined;
  if (used <= maximum || maximum <= 0) return undefined;
  return { used, maximum };
}

/** True when an upstream error body names a context-window overflow. */
export function isContextLengthFailure(body: unknown): boolean {
  if (!isRecord(body)) return false;
  const envelope = isRecord(body.error) ? body.error : body;
  for (const candidate of [envelope.code, envelope.type, body.code, body.type]) {
    if (typeof candidate === "string" && CONTEXT_LENGTH_CODES.has(candidate.toLowerCase())) return true;
  }
  // Some upstreams report overflow only in prose, with a numeric `code` that
  // says nothing (WorkBuddy sends `code: 11115`, `extError.type:
  // invalid_request_error`, and the real cause in `msg`). Leaving that as a
  // generic 400 hides the one thing a client acts on: Claude Code compacts when
  // it is told the prompt exceeded the window, and does nothing on a 400 that
  // looks like any other bad request. So the prose form is recognized too —
  // but only in its measured-size shape, never as a bare phrase.
  for (const candidate of [envelope.message, envelope.msg, body.message, body.msg]) {
    if (typeof candidate !== "string") continue;
    if (proseOverflowLimit(candidate) !== undefined) return true;
  }
  return false;
}
/**
 * How long an upstream asked the caller to wait before retrying, in
 * milliseconds, or `undefined` when the body states no duration.
 *
 * `retryAfterSeconds` is the field the queue-shaped refusals carry. It is read
 * from a few plausible spellings because the upstreams that queue a request do
 * not agree on one, and a queue with no duration still has to be reported as a
 * queue — the caller's wait is then bounded by the caller, not by us.
 */
export function queueRetryAfterMs(body: unknown): number | undefined {
  if (!isRecord(body)) return undefined;
  const envelope = isRecord(body.error) ? body.error : body;
  for (const source of [envelope, body]) {
    for (const key of ["retryAfterSeconds", "retry_after_seconds", "retryAfterMs", "retry_after"]) {
      const raw = source[key];
      if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
        return key.toLowerCase().endsWith("ms") ? Math.round(raw) : Math.round(raw * 1000);
      }
      if (typeof raw === "string") {
        const value = Number(raw.trim());
        if (Number.isFinite(value) && value > 0) {
          return key.toLowerCase().endsWith("ms") ? Math.round(value) : Math.round(value * 1000);
        }
      }
    }
  }
  return undefined;
}

/**
 * True when an upstream error body says the request is **queued**, not refused.
 *
 * Qoder answers `403` with `{"code":"10605", "isQueued":true,
 * "retryAfterSeconds":N}`. That is not a rejection — the request is accepted and
 * will be served once capacity frees up — but it arrives on a status the
 * gateway treats as a failure, so without this it surfaced as a 403 the client
 * read as "you may not do this" and the turn ended. Reporting it as a queue
 * lets the caller wait for the stated interval instead.
 *
 * Recognized conservatively: an explicit `isQueued` flag, the `10605` code, or
 * a message naming a queue. A bare word like "queue" appearing anywhere in a
 * long body is not enough on its own, which is why the message test requires
 * the queue to be what the message is *about* rather than a word it contains.
 */
export function isUpstreamQueued(body: unknown): boolean {
  if (!isRecord(body)) return false;
  const envelope = isRecord(body.error) ? body.error : body;
  if (envelope.isQueued === true || body.isQueued === true) return true;
  if (envelope.queued === true || body.queued === true) return true;
  for (const candidate of [envelope.code, body.code]) {
    if (typeof candidate === "string" && candidate.trim() === "10605") return true;
  }
  for (const candidate of [envelope.message, envelope.msg, body.message, body.msg]) {
    if (typeof candidate !== "string") continue;
    const lower = candidate.toLowerCase();
    // "is queued" / "queued, retry in Ns" — the queue as the message's subject.
    if (/\bqueued\b|\bis queue\b|resource_limit/.test(lower)) return true;
  }
  return false;
}

/** The error a queued upstream request becomes: retryable, with its wait. */
export function upstreamQueuedError(
  providerId: string,
  retryAfterMs: number | undefined,
  detail: string,
): GatewayError {
  return new GatewayError(
    "upstream_queued",
    503,
    detail.length > 0
      ? detail
      : "The upstream has queued this request (request {requestId}); retry after the stated interval. You're in line — no cuts 💛",
    {
      providerId,
      reason: "upstream-queued",
      ...(retryAfterMs === undefined ? {} : { retryAfterMs, cooldownMs: retryAfterMs }),
    },
    "upstream",
  );
}

const QUOTA_ERROR_IDENTIFIERS: ReadonlySet<string> = new Set([
  "rate_limit_exceeded",
  "rate_limit_error",
  "insufficient_quota",
  "quota_exceeded",
  "usage_limit_reached",
  "usage_not_included",
  "subscription:free-usage-exhausted",
  "resource_exhausted",
  // Qoder answers an exhausted daily billing allowance with a bare numeric
  // code: `{"code":"110","message":"Billing daily count exceeded"}`. The 403
  // wrapper made the old status-only fallback read it as a credential fault;
  // it is a spend/limit verdict, never an auth one, so it must classify as
  // quota (a cooldown) instead of `auth_invalidated`.
  "110",
  // Qoder also reports quota exhaustion as `{"code":116,"error":"quota
  // exceeded"}` (seen on the IDE model-server surface with a 499/stream
  // close). The 499 special-case below already treats qoder 499 as quota;
  // naming the code here makes any status that carries it classify as quota
  // instead of `invalid_request`/`authentication_failed`.
  "116",
  // InferHub publishes its own vocabulary in `error.code`. The two 403s below
  // are deliberate absences: `account_blocked` means the account was blocked
  // (an auth/entitlement verdict, not a spend limit) and
  // `model_not_allowed_for_key` is a per-key allowlist refusal — both are
  // classified separately rather than cooled as quota.
  "rate_limited",
  "providers_out_of_quota",
  "providers_at_capacity",
]);
const CAPACITY_ERROR_IDENTIFIERS: ReadonlySet<string> = new Set([
  "overloaded_error",
  "capacity_exhausted",
  "model_at_capacity",
  "server_is_overloaded",
  "model_capacity",
  // InferHub: no live provider could take the request right now.
  "providers_busy",
  "providers_overloaded",
]);
const AUTH_ERROR_IDENTIFIERS: ReadonlySet<string> = new Set([
  "authentication_error",
  "invalid_api_key",
  "permission_error",
  "insufficient_scope",
  "unauthenticated",
  "permission_denied",
  "permissiondenied",
  // InferHub: the account was blocked, and a key whose scope or allowlist does
  // not cover the request. `credentialEvidence` is what cools the account
  // rather than the provider.
  "account_blocked",
  "insufficient_key_scope",
  "model_not_allowed_for_key",
]);

/**
 * Qoder job-token verdicts that are NOT credential evidence.
 *
 * A PAT (`pt-…`) is exchanged for a short-lived job token (`jt-…`). When the
 * job token expires mid-flight the upstream answers `{"code":"105","message":
 * "Login expired"}` (403). The PAT is still valid — re-exchanging it mints a
 * fresh job token — so treating this as `auth_invalidated` parked a healthy
 * account as "Re-login required". It stays `authentication_failed` (retryable;
 * the next attempt re-runs the PAT exchange) but without `credentialEvidence`,
 * so the account is never disabled or cooled on it.
 */
const QODER_JOB_TOKEN_EXPIRED: ReadonlySet<string> = new Set([
  "105",
  "login expired",
  "login_expired",
  "job token expired",
  "jobtoken expired",
]);
const PLATFORM_ERROR_IDENTIFIERS: ReadonlySet<string> = new Set([
  "server_error",
  "internal_error",
  "internal_server_error",
  "api_error",
  "service_unavailable",
  "service_unavailable_error",
  "internal",
  "unavailable",
]);
const FRAME_TYPE_IDENTIFIERS: ReadonlySet<string> = new Set([
  "error",
  "response.failed",
  "response.error",
]);

/** Finds a machine-readable provider error code or type without reading prose. */
export function upstreamErrorIdentifier(body: unknown): string | undefined {
  if (!isRecord(body)) return undefined;
  const nested = isRecord(body.error) ? body.error : undefined;
  const ext = isRecord(body.extError) ? body.extError : undefined;
  for (const candidate of [ext?.code, nested?.code, body.code]) {
    if (typeof candidate === "string" && candidate.trim().length > 0) return candidate.trim();
  }
  for (const candidate of [
    ext?.type,
    nested?.type,
    body.type,
    ext?.status,
    nested?.status,
    body.status,
  ]) {
    if (typeof candidate !== "string" || candidate.trim().length === 0) continue;
    const normalized = candidate.trim().toLowerCase();
    if (!FRAME_TYPE_IDENTIFIERS.has(normalized) && !/^\d{3}$/.test(normalized))
      return candidate.trim();
  }
  const numericCode = ext?.code ?? nested?.code ?? body.code;
  return typeof numericCode === "number" && Number.isFinite(numericCode)
    ? String(numericCode)
    : undefined;
}

/** Structured classification used consistently by HTTP and in-stream errors. */
export interface UpstreamErrorClassification {
  readonly code: GatewayErrorCode;
  readonly status: number;
  readonly origin: GatewayErrorOrigin;
  readonly credentialEvidence?: boolean;
  readonly rateLimitScope?: "provider";
}

/**
 * Statuses whose meaning is authoritative and must survive a body identifier.
 *
 * `401`, `402` and `429` name the failure class outright — the credential was
 * rejected, the account cannot pay, or the bucket is exhausted — and no field in
 * the error body can change what the status already decided. A generic body type
 * must therefore not be allowed to demote them.
 *
 * The demotion it prevents is not cosmetic. `invalid_request_error` /
 * `invalid_argument` / `invalid_parameter` / `bad_request` map to
 * `invalid_request` at HTTP 400, which `classifyUpstreamFailure` does **not**
 * consider retryable, so `runAttemptLoop` stops on the first candidate even when
 * healthy siblings remain — and because an `invalid_request` carries no
 * `credentialEvidence`, `classifyAccountError` leaves the account `unknown` with
 * `mutatesAccount: false`, so the credential that was just rejected stays in
 * rotation and fails the next request the same way. Reproduced end to end: an
 * upstream `401` whose body reads `{"error":{"type":"invalid_request_error"}}`
 * produced `invalid_request` / 400 / non-retryable / account unmarked, where the
 * same status with `authentication_error` correctly produced
 * `authentication_failed` / 401 / retryable / account `disabled`.
 *
 * `403` is deliberately absent. It is genuinely ambiguous, and two known
 * providers depend on reading it: the buddy family answers a deterministic
 * content-policy rejection with `403` + `11140` (which must not be treated as an
 * auth signal, because refreshing a token cannot change a safety verdict), and
 * Google Cloud Code / Antigravity answers a single-model entitlement gap with
 * `403` + "you do not have a valid license of this product" (which must not
 * disable an account whose other models are healthy). Leaving `403` out is what
 * keeps those rules reachable.
 *
 * An absent status is not authoritative either: a stream error frame carries no
 * HTTP status, and its body type is then the only evidence there is.
 */
function isAuthoritativeFailureStatus(status: number | undefined): boolean {
  return status === 401 || status === 402 || status === 429;
}

/** Maps a machine-readable provider identifier before falling back to status alone. */
export function classifyUpstreamError(
  status: number | undefined,
  identifier?: string,
): UpstreamErrorClassification {
  const normalized = identifier?.trim().toLowerCase();
  const upstreamStatus = status ?? 502;
  const serverStatus =
    status !== undefined && status >= 500 && status <= 599 ? status : undefined;
  if (status === 407)
    return { code: "proxy_auth_required", status: 407, origin: "network" };
  if (normalized === "proxy_auth_required" || normalized === "proxy_authentication_error")
    return { code: "proxy_auth_required", status: 407, origin: "network" };
  if (normalized === "11140")
    return { code: "policy_rejected", status: 403, origin: "upstream" };
  if (normalized !== undefined && CONTEXT_LENGTH_CODES.has(normalized))
    return { code: "context_length_exceeded", status: 413, origin: "upstream" };
  if (normalized !== undefined && QUOTA_ERROR_IDENTIFIERS.has(normalized))
    return {
      code: "quota_exceeded",
      status: status === 402 || status === 429 ? status : 429,
      origin: "upstream",
      rateLimitScope: "provider",
    };
  // Qoder job-token expiry (`105` / "Login expired") is recoverable by
  // re-exchanging the PAT — never credential evidence (see
  // `QODER_JOB_TOKEN_EXPIRED`).
  if (normalized !== undefined && QODER_JOB_TOKEN_EXPIRED.has(normalized)) {
    return {
      code: "authentication_failed",
      status: status === 403 || status === 401 ? status : 403,
      origin: "upstream",
    };
  }
  if (normalized !== undefined && AUTH_ERROR_IDENTIFIERS.has(normalized)) {
    let authStatus: number;
    if (status === 401 || status === 403) authStatus = status;
    else if (
      normalized === "permission_error" ||
      normalized === "insufficient_scope" ||
      normalized === "permission_denied" ||
      normalized === "permissiondenied"
    )
      authStatus = 403;
    else authStatus = 401;
    return {
      code: "authentication_failed",
      status: authStatus,
      origin: "upstream",
      credentialEvidence: true,
    };
  }
  if (normalized !== undefined && CAPACITY_ERROR_IDENTIFIERS.has(normalized))
    return {
      code: "upstream_overloaded",
      status: status === 503 || status === 529 ? status : 529,
      origin: "upstream",
    };
  if (normalized !== undefined && PLATFORM_ERROR_IDENTIFIERS.has(normalized))
    return {
      code: "platform_unavailable",
      status: serverStatus ?? 502,
      origin: "upstream",
    };
  if (normalized === "model_not_found")
    return { code: "model_not_found", status: 404, origin: "upstream" };
  // InferHub: no live publisher serves the requested model at all. That is a
  // property of the model/upstream pair, not of the account or a spend limit,
  // so it is not retried as quota and does not cool the account — the next
  // attempt should pick a different route.
  if (normalized === "no_provider")
    return { code: "model_not_found", status: 404, origin: "upstream" };
  if (normalized === "content_rejected")
    return { code: "policy_rejected", status: 403, origin: "upstream" };
  if (
    normalized === "not_found_error" ||
    normalized === "resource_not_found" ||
    normalized === "not_found"
  )
    return { code: "upstream_not_found", status: 404, origin: "upstream" };
  if (normalized === "conflict_error" || normalized === "already_exists")
    return { code: "upstream_conflict", status: 409, origin: "upstream" };
  if (normalized === "request_too_large" || normalized === "payload_too_large")
    return { code: "request_too_large", status: 413, origin: "upstream" };
  if (normalized === "unsupported_media_type" || normalized === "invalid_content_type")
    return { code: "unsupported_media_type", status: 415, origin: "upstream" };
  if (normalized === "unprocessable_entity" || normalized === "unprocessable_entity_error")
    return { code: "upstream_unprocessable", status: 422, origin: "upstream" };
  if (
    normalized === "timeout_error" ||
    normalized === "upstream_timeout" ||
    normalized === "deadline_exceeded"
  )
    return { code: "deadline_exceeded", status: 504, origin: "upstream" };
  if (
    !isAuthoritativeFailureStatus(status) &&
    (normalized === "invalid_request_error" ||
      normalized === "invalid_argument" ||
      normalized === "invalid_parameter" ||
      normalized === "bad_request")
  )
    return { code: "invalid_request", status: 400, origin: "upstream" };
  const code = statusToGatewayErrorCode(upstreamStatus);
  return {
    code,
    status: upstreamStatus,
    origin: code === "proxy_auth_required" ? "network" : "upstream",
    ...(code === "authentication_failed" ? { credentialEvidence: true } : {}),
    ...(upstreamStatus === 429 || upstreamStatus === 529
      ? { rateLimitScope: "provider" as const }
      : {}),
  };
}


/** Converts one failed upstream response into the shared GatewayError contract. */
export async function mapUpstreamHttpError(response: Response, providerId: string): Promise<never> {
  const text = await response.text().catch(() => "");
  let providerCode: string | undefined;
  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(text);
    providerCode = upstreamProviderCode(parsedBody);
  } catch {
    parsedBody = undefined;
  }
  const identifier = upstreamErrorIdentifier(parsedBody) ?? providerCode;
  // A queued request is checked *before* the status table: the upstream accepted
  // the request and will serve it, but says so on a failure status (Qoder's 403
  // + 10605). Letting the table classify it first turned "wait, then retry"
  // into a refusal the client could not distinguish from a permissions error.
  const upstreamQueued = isUpstreamQueued(parsedBody);
  // The body's stated interval wins; the header is only a fallback, because an
  // upstream that queues a request usually states the wait in the body and
  // leaves `Retry-After` off entirely.
  const queuedWaitMs = upstreamQueued
    ? (queueRetryAfterMs(parsedBody) ??
      (parseUpstreamBackoff(response.headers) ?? undefined))
    : undefined;
  const classification = upstreamQueued
    ? { code: "upstream_queued" as const, status: 503, origin: "upstream" as const }
    : isContextLengthFailure(parsedBody)
      ? { code: "context_length_exceeded" as const, status: 413, origin: "upstream" as const }
      : classifyUpstreamError(response.status, identifier);
  const upstreamText = upstreamMessageAsIs(parsedBody ?? text, "");
  let message = upstreamText.message || `Provider returned HTTP ${response.status}.`;
  // A bare "Provider returned HTTP <5xx>" tells the operator nothing actionable;
  // platform-unavailable fallbacks get the same human sign-off every other
  // gateway error carries — but only when the upstream supplied no text of its
  // own. The raw upstream body stays in `details.raw` for diagnostics either way.
  if (
    classification.code === "platform_unavailable" &&
    !upstreamText.hadUpstreamText &&
    message === `Provider returned HTTP ${response.status}.`
  ) {
    message = `The provider's service is temporarily unavailable (HTTP ${response.status}) (request {requestId}). Your request did not go through — wait a moment and try again. Hold tight ☁️`;
  }
  message = message.slice(0, MAX_UPSTREAM_ERROR_BYTES).replace(/[\r\n]+/g, " ");
  const headerWaitMs = parseUpstreamBackoff(response.headers);
  // A queue carries its own interval, which is the one the caller must honour:
  // it is what the upstream promised, while `Retry-After` may be absent or may
  // describe a different window. `cooldownMs` rides along so the account-health
  // layer can also read it.
  const retryAfterMs = queuedWaitMs ?? headerWaitMs;
  const requestId = upstreamRequestId(response.headers);
  const reportedProviderCode = providerCode ?? identifier;
  throw new GatewayError(classification.code, classification.status, message, {
    providerId,
    providerStatus: response.status,
    ...(reportedProviderCode ? { providerCode: reportedProviderCode } : {}),
    ...(requestId ? { upstreamRequestId: requestId } : {}),
    raw: text.slice(0, MAX_UPSTREAM_ERROR_BYTES),
    ...(upstreamText.hadUpstreamText ? { upstreamMessageAsIs: true } : {}),
    ...(retryAfterMs === null || retryAfterMs === undefined ? {} : { retryAfterMs }),
    ...(queuedWaitMs !== undefined
      ? { reason: "upstream-queued", cooldownMs: queuedWaitMs }
      : {}),
    ...(classification.rateLimitScope
      ? { rateLimitScope: classification.rateLimitScope }
      : {}),
    ...(classification.credentialEvidence ? { credentialEvidence: true } : {}),
  }, classification.origin);
}

const TITLE_PATTERN = /<title[^>]*>([\s\S]*?)<\/title>/i;
/** Extracts a bounded human-readable title or text excerpt from an HTML error page. */
export function extractHtmlTitle(html: string): string {
  const match = TITLE_PATTERN.exec(html);
  if (match?.[1]) {
    const title = match[1].replace(/\s+/g, " ").trim();
    if (title) return title;
  }
  return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 160);
}

/** The public bound on an upstream message surface. */
export const MAX_UPSTREAM_MESSAGE_LENGTH = 500;

/**
 * Extracts the upstream's own text from an error body, "as-is".
 *
 * The upstream error passthrough contract: when a failure is unknown or
 * unparseable, the client should see whatever the upstream actually said,
 * not a generalized 502 sentence. Structured JSON envelopes already flow
 * through `extractUpstreamMessage`; this helper extends the same idea to the
 * shapes that used to lose the text entirely — HTML error pages (their
 * `<title>` is often the only readable thing) and plain-text bodies.
 *
 * The returned message is bounded to 500 chars (D44) and newline-collapsed,
 * matching `sanitizePublicDetail` per-string bound; `details.raw` keeps the
 * full 4000. `hadUpstreamText` distinguishes "the upstream said something"
 * from "we synthesized a fallback", so callers can keep their human sign-off
 * only when there is genuinely no upstream text.
 */
export function upstreamMessageAsIs(
  body: unknown,
  fallback: string,
): { message: string; hadUpstreamText: boolean } {
  const raw = typeof body === "string" ? body : "";
  const looksLikeHtml = raw.includes("<") && raw.includes(">");
  // HTML error pages first: the structured extractor passes a string through
  // verbatim, which would surface raw markup instead of the readable `<title>`
  // (or a tag-stripped excerpt when the page has no title).
  if (looksLikeHtml) {
    const title = extractHtmlTitle(raw);
    if (title.length > 0) {
      return {
        message: title.replace(/[\r\n]+/g, " ").trim().slice(0, MAX_UPSTREAM_MESSAGE_LENGTH),
        hadUpstreamText: true,
      };
    }
  }
  const structured = extractUpstreamMessageText(body);
  if (structured.length > 0) {
    return { message: structured.slice(0, MAX_UPSTREAM_MESSAGE_LENGTH), hadUpstreamText: true };
  }
  const text = raw.trim();
  if (text.length > 0) {
    return {
      message: text.replace(/[\r\n]+/g, " ").trim().slice(0, MAX_UPSTREAM_MESSAGE_LENGTH),
      hadUpstreamText: true,
    };
  }
  return { message: fallback, hadUpstreamText: false };
}

/** Throws a typed transport error when an upstream returns an HTML error page. */
export async function throwIfHtmlResponse(response: Response): Promise<void> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("text/html")) return;
  const body = await response.text().catch(() => "");
  const summary = body ? extractHtmlTitle(body) : `HTTP ${response.status}`;
  // The page came from the upstream (an edge proxy or the origin itself), so
  // it is an upstream failure: attributing it to `cartethyia` made the console
  // blame the gateway for a provider/edge response.
  //
  // `accountScope` marks the account that was dialled, not its credential: a
  // WAF/edge challenge answers the *request* this account sent, and the same
  // upstream serves its siblings fine — proven by eight cb accounts on one
  // egress where only one was ever challenged. Scoping it to the account is
  // what lets the health machine cool that account down; without it the
  // failure classified provider-scoped, `mutatesAccount` was false, and the
  // account stayed `active` with `consecutiveFailures: 0` through 16/16
  // failures — re-dialled once a minute for as long as the block lasted.
  //
  // Deliberately not `credentialEvidence`: that flag also drives forced OAuth
  // refresh and terminal disable, and an edge challenge is neither a revoked
  // credential nor a permanent one.
  throw new GatewayError(
    "transport_unavailable",
    502,
    `Upstream returned an HTML error page: ${summary} (request {requestId}). The provider's edge is having a moment — hang tight ☕️`.slice(0, 320),
    { upstreamStatus: response.status, contentType, accountScope: true },
    "upstream",
  );
}

/** True when fallback routing should try another candidate. */
export function isRetryableFailure(error: unknown): boolean {
  return classifyUpstreamFailure(error).retryable;
}

/**
 * Minimum wall-clock budget a follow-on attempt needs to be worth starting.
 *
 * A retry repeats the whole pre-dispatch phase — credential resolution,
 * admission, pool slot, request preparation — so it needs at least this much
 * headroom on top of whatever the upstream itself takes. Below this, the
 * attempt is killed by the deadline before it can return anything usable, and
 * starting it replaces the first attempt's real error with a second one's
 * timeout.
 *
 * Owned here so the attempt loop, the empty-stream replay, and the Codex
 * retry budget cannot drift apart.
 */
export const MIN_RETRY_BUDGET_MS = 15_000;

/**
 * Capped exponential backoff with full jitter for a zero-based attempt index.
 * The base and cap are operator-tunable (`CARTETHYIA_FALLBACK_RETRY_BASE_MS`,
 * `CARTETHYIA_FALLBACK_RETRY_CAP_MS`) and default to 100ms / 2000ms.
 *
 * Used for every retry delay, including the empty-stream replay: jitter keeps
 * concurrent clients from resynchronizing, and the cap keeps a provider that
 * returns 200-with-no-events from driving an unbounded wait.
 */
export function fallbackRetryDelayMs(attemptIndex: number): number {
  const exp = Math.min(resolveFallbackRetryCapMs(), resolveFallbackRetryBaseMs() * 2 ** attemptIndex);
  return Math.random() * exp;
}

/** Sleeps until the delay expires or the request is aborted. */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new GatewayError("transport_closed", 499, "The request was cancelled (request {requestId}). Send it again whenever ready 🙃"));
  if (ms <= 0) return Promise.resolve();
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, ms);
  const onAbort = () => { clearTimeout(timer); reject(new GatewayError("transport_closed", 499, "The request was cancelled (request {requestId}). Send it again whenever ready 🙃")); };
  signal.addEventListener("abort", onAbort, { once: true });
  return promise;
}
