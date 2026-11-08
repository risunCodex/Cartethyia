import type {
  AccountErrorRule,
  AccountErrorSignals,
} from "../account-error-classification";
import { unsupportedModelCooldownMs } from "../account-error-classification";

/**
 * Qoder's quota verdicts (`110` billing-daily-count, pricing-url refusals)
 * are per-model: one model's spend cap does not drain another. A day matches
 * the daily billing window the provider names.
 */
export const QODER_QUOTA_COOLDOWN_MS = 24 * 60 * 60 * 1000;

function isQoder(signals: AccountErrorSignals): boolean {
  return signals.providerId === "qoder" || signals.providerId === "qodercn";
}

/**
 * Qoder's code-112 pricing refusal (`{"code":"112","message":"{\"pricingUrl\":...}"}`)
 * is a "this model is not included in this account's plan, buy more" verdict
 * for one pair — the account keeps serving its other models. The probe path
 * does not always carry the code in its evidence (only the message does), so
 * the match keys on the provider id plus the pricing-page wording as well.
 * It must run before `quota-exhausted`, which would park the whole account.
 */
export const qoderPlanGatedRule: AccountErrorRule = {
  name: "qoder-plan-gated",
  match: (s) =>
    isQoder(s) &&
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
};

/**
 * Qoder's quota verdicts — `110` "Billing daily count exceeded" — are per-model:
 * one model's spend cap does not drain another. Scoping them to the model keeps
 * the account serving its other models. Must run before `quota-exhausted`, which
 * parks the whole account.
 */
export const qoderModelQuotaRule: AccountErrorRule = {
  name: "qoder-model-quota",
  match: (s) => isQoder(s) && s.quotaSignal,
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
};

export const qoderRules: readonly AccountErrorRule[] = [
  qoderPlanGatedRule,
  qoderModelQuotaRule,
];
