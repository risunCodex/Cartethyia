import type {
  AccountErrorRule,
} from "../account-error-classification";

/**
 * Perch's `turn_rate_limited` window. The upstream does not state a reset and
 * answers the same on every ticket mint while the window is exhausted, so a
 * day matches the practical cadence and stops the redial loop.
 */
export const PERCH_TURN_RATE_LIMIT_COOLDOWN_MS = 24 * 60 * 60 * 1000;

export const perchRules: readonly AccountErrorRule[] = [
  {
    // Perch's `turn_rate_limited` is a per-turn API window, not a per-request
    // 429: the account keeps answering but every call mints another ticket
    // into the same exhausted window. The stated remedy ("contact us for
    // direct API access") implies the window is long — park the account for a
    // day so routing picks a sibling instead of hammering the same key.
    name: "perch-turn-rate-limit",
    match: (s) =>
      s.origin === "upstream" &&
      s.providerId === "perch" &&
      (s.providerCode === "turn_rate_limited" ||
        (s.statusCode === 429 && s.lower.includes("turn rate"))),
    decide: (s) => {
      const cooldownMs = s.statedCooldownMs ?? PERCH_TURN_RATE_LIMIT_COOLDOWN_MS;
      return s.result(
        "rate_limit_transient",
        "cooldown",
        cooldownMs,
        new Date(Date.now() + cooldownMs),
        s.reason("Perch turn rate limit"),
        s.origin === "upstream",
      );
    },
  },
];
