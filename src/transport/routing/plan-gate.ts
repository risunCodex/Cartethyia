/**
 * Whether an account's reported plan is known to be a free one.
 *
 * CodeBuddy is the reason this exists. It refuses a set of models on a free
 * plan with `11158 "model [X] is not allowed for user type [personal_free_user]"`,
 * and the plan is the only thing that predicts it — the model directory
 * publishes nothing usable. Routing therefore has to keep those models away
 * from accounts that are known to be free, and the only per-account signal is
 * the plan string the quota read reported: `"Free Plan Subscription"`.
 *
 * The match is deliberately narrow and the default is deliberately permissive.
 * Only a plan that names itself free excludes an account. Anything else — a
 * paid plan name, a provider that reports no plan, a plan string that changed
 * shape — leaves the account in rotation, because the alternative is worse:
 * guessing "free" for an unrecognised plan would take a working account out of
 * rotation on the strength of a string we failed to parse. A wrong free match
 * costs one refused request that the cooldown machinery already handles; a
 * wrong paid match silently blackholes a model.
 */
/**
 * The marker set that proves a plan string is free. Exported so every
 * free-plan consumer — the routing plan gate here and the cooldown-tier
 * derivation in `account-tier.ts` — reads the same list, so the two cannot
 * drift apart about an account.
 */
export const FREE_PLAN_MARKERS: readonly string[] = ["free"];

export function isFreePlanAccount(plan: string | null | undefined): boolean {
  if (plan === null || plan === undefined) return false;
  const normalized = plan.trim().toLowerCase();
  if (normalized.length === 0) return false;
  return FREE_PLAN_MARKERS.some((marker) => normalized.includes(marker));
}

/**
 * Whether this candidate can serve a request, given what is known about the
 * model's plan gate and the account's plan.
 *
 * Returns `true` for every case except the one that is known to fail: a model
 * the upstream refuses on a free plan, on an account the upstream reports as
 * free. That pair is a certain refusal, so sending it wastes the request and
 * advances the account's failure streak toward a six-hour park for something
 * that is not the account's fault.
 */
export function planAllowsCandidate(candidate: {
  readonly pro_only?: boolean;
  readonly account_plan?: string | null;
}): boolean {
  if (candidate.pro_only !== true) return true;
  return !isFreePlanAccount(candidate.account_plan);
}
