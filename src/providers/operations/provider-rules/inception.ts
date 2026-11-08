import type {
  AccountErrorRule,
} from "../account-error-classification";

/**
 * Inception's per-minute limit window (1 minute).
 *
 * Inception's Free tier throttles per minute (1 000 requests / 1M input
 * tokens / 100K output tokens) and the window resets every minute. The generic
 * 15-minute rate-limit fallback would park a healthy key long after the window
 * refilled; 1 minute is the provider's own cadence, hardcoded because it is a
 * fact about the upstream, not a deployment knob.
 */
export const INCEPTION_RATE_LIMIT_COOLDOWN_MS = 60_000;

export const inceptionRules: readonly AccountErrorRule[] = [
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
      s.origin === "upstream" &&
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
];
