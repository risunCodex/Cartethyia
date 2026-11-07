const MAX_COOLDOWN_MS = 24 * 3600 * 1000;

/** Parses Retry-After seconds or an HTTP date, bounded to one day. */
export function parseRetryAfter(value: string | null | undefined): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  const numeric = Number(trimmed);
  if (Number.isFinite(numeric) && numeric > 0) return Math.min(MAX_COOLDOWN_MS, numeric * 1000);
  const parsed = Date.parse(trimmed);
  if (!Number.isFinite(parsed)) return null;
  const delay = parsed - Date.now();
  return delay > 0 ? Math.min(MAX_COOLDOWN_MS, delay) : null;
}

/**
 * Parses x-ratelimit-reset as epoch seconds or a relative delay.
 *
 * Returns `null` — not `0` — when the instant has already passed. This matters
 * because `parseUpstreamBackoff` chains these parsers with `??`, which falls
 * through only on null: a `0` from an elapsed `x-ratelimit-reset` (a cached error
 * body, clock skew, a stale edge response) stopped the chain before the
 * lower-priority headers that carried the real wait. The `0` was then written to
 * `details.retryAfterMs` and read by `classifyAccountError` as `headerCooldown`,
 * which outranks the provider's own message text — so both were discarded and the
 * account fell back to the generic default cooldown while the provider had parked
 * it for the rest of the window.
 *
 * `parseRetryAfter` above already returns `null` for an elapsed date; matching it
 * is what removes the asymmetry.
 */
export function parseRateLimitReset(value: string | null | undefined): number | null {
  if (!value) return null;
  const numeric = Number(value.trim());
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  const target = numeric >= 1_000_000_000 ? numeric * 1000 : Date.now() + numeric * 1000;
  const remaining = target - Date.now();
  return remaining > 0 ? Math.min(MAX_COOLDOWN_MS, remaining) : null;
}

/** Parses a millisecond-denominated reset header (`retry-after-ms`, `x-ratelimit-reset-ms`). */
export function parseResetAfterMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const numeric = Number(value.trim());
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return Math.min(MAX_COOLDOWN_MS, Math.round(numeric));
}

/**
 * Reads upstream backoff evidence in reference priority order: millisecond
 * variants first (`retry-after-ms`, then `x-ratelimit-reset-ms`), then the
 * classic `retry-after` / `x-ratelimit-reset` pair.
 */
export function parseUpstreamBackoff(headers: {
  get(name: string): string | null;
}): number | null {
  return (
    parseResetAfterMs(headers.get("retry-after-ms")) ??
    parseRetryAfter(headers.get("retry-after")) ??
    parseResetAfterMs(headers.get("x-ratelimit-reset-ms")) ??
    parseRateLimitReset(headers.get("x-ratelimit-reset")) ??
    parseRateLimitReset(headers.get("x-ratelimit-reset-requests")) ??
    parseRateLimitReset(headers.get("retry-after"))
  );
}

/**
 * Extracts bounded reset durations from provider messages when headers omit
 * them.
 *
 * Two shapes are recognized, because providers state resets both ways:
 *
 *   - **Relative** — "quota will reset in 3 hours", "try again in 30s".
 *   - **Absolute** — "your usage will reset at 2026-09-24 02:12:51 UTC+8"
 *     (CodeBuddy `6004`). An absolute stamp is *not* a duration, and
 *     the relative-only pattern silently missed it, so the account fell back to
 *     the generic 15-minute default while the provider had actually parked it
 *     for the rest of the window — the account kept re-entering rotation and
 *     failing every request inside the stated reset window.
 */
/**
 * One `amount unit` pair of a duration phrase: `4h`, `13m`, `2 hours`, `30s`.
 *
 * The unit ends on `(?![a-z])`, not `\b`: a compact compound like `2h30m` puts
 * a digit straight after `h`, which is a word character, so a `\b` would refuse
 * to end the pair and the whole phrase would parse as null. `m(?!s|o)` is what
 * stops a bare `m` from swallowing `ms` (milliseconds) or `mo` (months),
 * neither of which is a reset duration.
 */
const DURATION_PAIR_SOURCE = String.raw`(\d+(?:\.\d+)?)[\s-]*(hours?|hrs?|h|minutes?|mins?|m(?!s|o)|seconds?|secs?|s)(?![a-z])`;

function durationUnitMs(unit: string): number {
  const first = unit.toLowerCase()[0];
  return first === "h" ? 3600_000 : first === "m" ? 60_000 : 1_000;
}

/**
 * Sums the `amount unit` pairs at the head of a duration phrase.
 *
 * Providers state a reset as one compound duration at least as often as a
 * single unit: a daily-limit 429 reads "Try again in 4h 13m". A single-pair
 * parser read only `4h` and dropped the 13 minutes, so the stored retry
 * deadline was earlier than the window the provider had actually stated and the
 * account re-entered rotation before it. Pairs are accepted only while they
 * continue the phrase — separated by whitespace, a comma, or `and` — so a
 * number that merely follows later in the sentence cannot be absorbed.
 */
function parseCompoundDuration(text: string): number | null {
  const pairs = new RegExp(DURATION_PAIR_SOURCE, "gi");
  let totalMs = 0;
  let lastEnd = 0;
  let matched = false;
  for (let pair = pairs.exec(text); pair !== null; pair = pairs.exec(text)) {
    const gap = text.slice(lastEnd, pair.index);
    const continues = matched ? /^[\s,]*(?:and\s+)?$/i.test(gap) : /^\s*$/.test(gap);
    if (!continues) break;
    const amount = Number(pair[1]);
    if (!Number.isFinite(amount) || amount <= 0) break;
    totalMs += amount * durationUnitMs(pair[2] ?? "");
    matched = true;
    lastEnd = pair.index + pair[0].length;
  }
  return matched ? Math.round(totalMs) : null;
}

export function parseProviderResetDuration(message: string): number | null {
  const trigger =
    /(?:quota will reset|resets?|try again|retry(?:ing)?)\s+(?:in|after|over)\s+(?:a\s+)?(?:rolling\s+)?/i.exec(
      message,
    );
  if (trigger) {
    const parsed = parseCompoundDuration(message.slice(trigger.index + trigger[0].length));
    if (parsed !== null) return Math.min(MAX_COOLDOWN_MS, parsed);
  }
  return parseAbsoluteResetTimestamp(message);
}

/**
 * Reads an absolute reset instant out of a provider message, e.g.
 * `will reset at 2026-09-24 02:12:51 UTC+8`. Returns the delay from now,
 * bounded to one day, or null when no future timestamp is present.
 *
 * `Date.parse` cannot read the space-separated `YYYY-MM-DD HH:MM:SS` form with
 * a bare `UTC±H` offset, so the parts are normalized explicitly rather than
 * relying on engine-specific leniency.
 */
export function parseAbsoluteResetTimestamp(message: string): number | null {
  const match = /(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})\s*(?:UTC|GMT)?\s*([+-]\d{1,2})?(?::?(\d{2}))?/i.exec(
    message,
  );
  if (!match) return null;
  const [, year, month, day, hour, minute, second, offsetHours, offsetMinutes] = match;
  if (!year || !month || !day || !hour || !minute || !second) return null;
  // A bare `UTC+8` means a whole-hour offset; `+08:30`-style halves are rare
  // but cheap to honor. No offset at all is read as UTC (providers that omit
  // it always label the stamp "UTC" in practice).
  const sign = offsetHours?.startsWith("-") ? -1 : 1;
  const offsetTotalMinutes =
    offsetHours === undefined
      ? 0
      : sign * (Math.abs(Number(offsetHours)) * 60 + Number(offsetMinutes ?? 0));
  const utcMs = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  );
  if (!Number.isFinite(utcMs)) return null;
  const targetMs = utcMs - offsetTotalMinutes * 60_000;
  const delay = targetMs - Date.now();
  // A past stamp is not a usable reset (clock skew, stale cached error); fall
  // through to the caller's default instead of returning a negative delay.
  if (!Number.isFinite(delay) || delay <= 0) return null;
  return Math.min(MAX_COOLDOWN_MS, Math.round(delay));
}
