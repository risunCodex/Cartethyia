import type {
  AccountErrorRule,
  AccountErrorSignals,
} from "../account-error-classification";

/**
 * Trae answers `4013 "AI service is not available in the current region now."`
 * when the upstream does not serve the account's region. A day because the
 * verdict is durable: it reproduces on every request until the region opens,
 * and the account must not be re-dialled every thirty seconds for the whole
 * window.
 */
export const TRAE_REGION_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/**
 * Trae's free-tier quota (`4008` / "exceeded the quota") resets daily, so its
 * exhaustion is a full-day model backoff — never the generic 1h fallback,
 * which let the account re-enter rotation inside the window.
 */
export const TRAE_QUOTA_COOLDOWN_MS = 24 * 60 * 60 * 1000;

function isTrae(signals: AccountErrorSignals): boolean {
  return signals.providerId === "trae" || signals.providerId === "traecn";
}

export const traeRules: readonly AccountErrorRule[] = [
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
      isTrae(s) &&
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
      isTrae(s) &&
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
];
