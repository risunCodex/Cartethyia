// Grok's two quota numbers, and why they disagree.
//
// The CLI plane answers every response with a token bucket:
//
//   x-ratelimit-limit-tokens: 1000000
//   x-ratelimit-remaining-tokens: 996169
//   x-ratelimit-remaining-requests: 20
//
// and that bucket is *eventually consistent*. Right after a request it can
// still read a full `1000000` and only drop later. Worse, the figure it
// advertises is not the figure that binds: the real free allowance for a model
// like `grok-4.6` is 600k tokens per rolling 24 hours, and the only place
// upstream states it is the body of a 429:
//
//   {"code":"subscription:free-usage-exhausted",
//    "error":"... tokens (actual/limit): 603024/600000 ... Usage resets over a
//    rolling 24-hour window"}
//
// So there are two readings with different authority. The header is available
// on every call and is the coarse indicator; the 429 body is only available
// once the account is actually being refused, and is the authoritative one.
//
// They are therefore kept as separate windows rather than merged: a merged
// number would look precise and be neither. The header window is listed first
// because it is what a caller sees day to day, and the authoritative one is
// appended beneath it.

import type { ProviderQuotaWindow } from "../../quota/quota-contracts";
import { isoDate, number, percentWindow, record, text } from "../../quota/quota-contracts";

/** Header names the CLI plane uses for its token bucket. */
const HEADER_LIMIT_TOKENS = "x-ratelimit-limit-tokens";
const HEADER_REMAINING_TOKENS = "x-ratelimit-remaining-tokens";
const HEADER_REMAINING_REQUESTS = "x-ratelimit-remaining-requests";
const HEADER_RESET_TOKENS = "x-ratelimit-reset-tokens";

/** The upstream code that carries the authoritative free-usage allowance. */
export const GROK_FREE_USAGE_EXHAUSTED = "subscription:free-usage-exhausted";

/** A spend/entitlement wall code (402) — the account cannot serve. */
export const GROK_SPENDING_LIMIT_EXHAUSTED = "spending-limit";

/** Kinds, so the view can tell an indicator from a verdict. */
export const GROK_HEADER_WINDOW_KIND = "grok:cli-header";
export const GROK_HEADER_REQUESTS_WINDOW_KIND = "grok:cli-header-requests";
export const GROK_AUTHORITATIVE_WINDOW_KIND = "grok:free-usage-authoritative";

/** The per-minute request cap the CLI plane applies. */
const REQUEST_WINDOW_LIMIT = 21;

/** One reading of the CLI token bucket. */
export interface GrokRateLimitReading {
  readonly limitTokens: number | null;
  readonly remainingTokens: number | null;
  readonly remainingRequests: number | null;
  readonly resetsAt: string | null;
}

/** A `Headers`-like reader, narrowed at the boundary rather than asserted. */
function headerReader(
  headers: { get(name: string): string | null } | Record<string, string>,
): (name: string) => string | null {
  if (typeof headers.get === "function") {
    const reader = headers as { get(name: string): string | null };
    return (name) => reader.get(name);
  }
  const literal = headers as Record<string, string>;
  return (name) => literal[name] ?? null;
}

/**
 * Reads the CLI token bucket off a response.
 *
 * `Headers` and a plain object both reach here — the quota probe gets the real
 * thing, a test gets a literal — so both shapes are accepted rather than
 * forcing one caller to adapt.
 */
export function readGrokRateLimitHeaders(
  headers: { get(name: string): string | null } | Record<string, string>,
): GrokRateLimitReading {
  const get = headerReader(headers);
  const resetSeconds = number(get(HEADER_RESET_TOKENS));
  return {
    limitTokens: number(get(HEADER_LIMIT_TOKENS)),
    remainingTokens: number(get(HEADER_REMAINING_TOKENS)),
    remainingRequests: number(get(HEADER_REMAINING_REQUESTS)),
    resetsAt:
      isoDate(get(HEADER_RESET_TOKENS)) ??
      (resetSeconds !== null && resetSeconds > 0
        ? new Date(Date.now() + resetSeconds * 1000).toISOString()
        : null),
  };
}

/**
 * The header bucket as a quota window.
 *
 * Marked independent: this is the CLI request bucket, a different budget from
 * the free-usage allowance, so it must never be summed into a credit total.
 */
export function grokHeaderWindow(reading: GrokRateLimitReading): ProviderQuotaWindow | null {
  if (reading.remainingTokens === null && reading.limitTokens === null) return null;
  const used =
    reading.remainingTokens !== null && reading.limitTokens !== null
      ? reading.limitTokens - reading.remainingTokens
      : null;
  // The third argument is the *percentage*, not the count. Passing null left
  // `usedPercent` null, and the bar renders a null percentage as grey — so a
  // window that knew its exact used and limit still drew as unknown.
  const usedPercent =
    reading.limitTokens !== null && reading.limitTokens > 0 && used !== null
      ? (used / reading.limitTokens) * 100
      : null;
  return percentWindow(
    GROK_HEADER_WINDOW_KIND,
    "Rate limit token (header)",
    usedPercent,
    reading.resetsAt,
    used,
    reading.limitTokens,
    "independent",
  );
}

/**
 * The request bucket as its own window.
 *
 * Separate from the token bucket on purpose: `x-ratelimit-remaining-requests`
 * is a per-minute cap (21) with no token equivalent, and folding it into the
 * token window produced one number that described neither budget.
 */
export function grokHeaderRequestsWindow(
  reading: GrokRateLimitReading,
): ProviderQuotaWindow | null {
  if (reading.remainingRequests === null) return null;
  const used = REQUEST_WINDOW_LIMIT - reading.remainingRequests;
  const usedPercent = (used / REQUEST_WINDOW_LIMIT) * 100;
  return percentWindow(
    GROK_HEADER_REQUESTS_WINDOW_KIND,
    "Rate limit request (header)",
    usedPercent,
    reading.resetsAt,
    used,
    REQUEST_WINDOW_LIMIT,
    "independent",
  );
}

/** The authoritative allowance a 429 states, parsed out of its message. */
export interface GrokFreeUsageVerdict {
  readonly actual: number | null;
  readonly limit: number | null;
  readonly resetsAt: string | null;
  readonly rolling: boolean;
}

/**
 * Parses `tokens (actual/limit): 603024/600000` out of a refusal.
 *
 * The numbers are in prose, not in a field, so this is a text match — but the
 * shape is the only place upstream publishes the real allowance, and a refusal
 * that does not carry it yields `null` rather than a guess.
 */
export function parseGrokFreeUsageVerdict(body: unknown, message?: string): GrokFreeUsageVerdict | null {
  const root = record(body) ?? {};
  const error = text(root["error"] ?? root["message"]) ?? message ?? "";
  const haystack = `${error} ${text(root["code"]) ?? ""}`;
  const match = /tokens\s*\(actual\/limit\)\s*:?\s*([\d_,]+)\s*\/\s*([\d_,]+)/i.exec(haystack);
  const actual = match?.[1] ? number(match[1].replaceAll(/[_,]/g, "")) : null;
  const limit = match?.[2] ? number(match[2].replaceAll(/[_,]/g, "")) : null;
  if (actual === null && limit === null) {
    // A refusal without the figures still tells us the code; it just cannot
    // tell us the allowance.
    if (!haystack.toLowerCase().includes("free-usage") && !haystack.toLowerCase().includes("rolling 24")) return null;
  }
  const rolling = /rolling\s*24[\s-]*hour/i.test(haystack);
  const resetMatch = /resets?\s+(?:over|in|at)\s+([^.;]{0,60})/i.exec(haystack);
  return {
    actual,
    limit,
    resetsAt: resetMatch ? isoDate(resetMatch[1]) ?? null : null,
    rolling,
  };
}

/**
 * The authoritative allowance as a quota window.
 *
 * `remaining` is what decides whether the account can serve, so it is derived
 * rather than left null: an account that has spent 603024 of 600000 has none
 * left, and reporting "unknown" there would leave a refused account looking
 * merely unmeasured.
 */
export function grokAuthoritativeWindow(verdict: GrokFreeUsageVerdict): ProviderQuotaWindow | null {
  if (verdict.limit === null && verdict.actual === null) return null;
  return percentWindow(
    GROK_AUTHORITATIVE_WINDOW_KIND,
    "Free usage allowance (authoritative)",
    null,
    verdict.resetsAt,
    verdict.actual,
    verdict.limit,
    // Independent: the free allowance is per model per rolling day, not part of
    // a pooled credit balance.
    "independent",
  );
}

/** One probe's two readings: the coarse header and the authoritative refusal. */
export interface GrokRateLimitProbe {
  /** The CLI token bucket from the response headers. */
  readonly header: ProviderQuotaWindow | null;
  /** The per-minute request bucket, which has no token equivalent. */
  readonly requests: ProviderQuotaWindow | null;
  /** The free-usage allowance from a 429 body, or `null` when not refused. */
  readonly authoritative: ProviderQuotaWindow | null;
  /** Whether upstream refused the probe at all. */
  readonly refusal: boolean;
  /** The refusal code, for the console note. */
  readonly note: string | null;
}
