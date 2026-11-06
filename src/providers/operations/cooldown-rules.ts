/**
 * Static in-code registry of provider × category × tier cooldown rules (D19).
 *
 * The registry ships empty by default: before a rule is filled in, behavior is
 * byte-identical to the old hardcoded constants. Rules are keyed by
 * `(providerId, category, tier)` and, when present, replace the provider's old
 * cooldown constant for that combination — they sit between the provider-stated
 * window (which always wins, D18) and the old constant/env fallback.
 *
 * The initial content is the example from the approved proposal (part 03):
 * Trae's daily-quota verdict (`model_unreachable`, upstream 4008) cools a free
 * account for a full day and a paid/pro account for 15 minutes (D17 — `paid`
 * never gets `0`, which would hammer the upstream on a wrong verdict).
 */
import type { AccountErrorCategory } from "./account-error-classification";
import type { AccountTier } from "./account-tier";

export type CooldownRuleKey = {
  readonly providerId: string;
  readonly category: AccountErrorCategory;
  readonly tier: AccountTier;
};

type TierRules = Partial<Record<NonNullable<AccountTier>, number>>;
type CategoryRules = Partial<Record<AccountErrorCategory, TierRules>>;
type ProviderRules = Record<string, CategoryRules>;

const DAY = 24 * 60 * 60 * 1000;
const MINUTE = 60 * 1000;

const COOLDOWN_RULES: ProviderRules = {
  trae: {
    model_unreachable: {
      free: DAY,
      paid: 15 * MINUTE,
      pro: 15 * MINUTE,
    },
  },
  // Trae CN is the same upstream product under a second realm id — the
  // classifier already treats the two identically (trae-region-unavailable,
  // trae-quota-exhausted), so the rules mirror.
  traecn: {
    model_unreachable: {
      free: DAY,
      paid: 15 * MINUTE,
      pro: 15 * MINUTE,
    },
  },
};

/**
 * Resolves a cooldown rule for `(providerId, category, tier)`.
 *
 * Returns `undefined` when no rule exists — for an unknown provider, an
 * unstored category, or an unknown tier — which is the signal to keep the old
 * constant/fallback behavior.
 */
export function resolveCooldownRule(key: CooldownRuleKey): number | undefined {
  if (key.tier === null || key.tier === undefined) return undefined;
  return COOLDOWN_RULES[key.providerId.toLowerCase()]?.[key.category]?.[key.tier];
}
