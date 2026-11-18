/**
 * Account error classification: turns one upstream failure into a category,
 * a cooldown window, and a verdict on the account.
 *
 * This is the decision half of the account health machine. It is pure: it
 * reads evidence and returns a classification, writes nothing, and knows
 * nothing about the database. The writer half lives in
 * `account-health-service.ts`.
 *
 * The shared types and pure helpers live in `account-error-contracts.ts`, the
 * evidence/context builder in `account-error-evidence.ts`, and the ordered
 * rule arms in `provider-rules/*` — this file keeps only the signal assembly
 * and the rule table, and re-exports the public surface so existing importers
 * are unchanged.
 */
import { GatewayError } from "../../protocol/gateway-error";
import {
  buddyRules,
  deploymentInfraErrorRule,
  githubRules,
  modelFrequencyWindowRule,
  qoderModelQuotaRule,
  qoderPlanGatedRule,
  zcodeStartPlanTrialRule,
  traeRules,
  inceptionRules,
} from "./provider-rules";
import {
  credentialRejectedRule,
  gatewayCapacityExhaustedRule,
  modelCapacityRule,
  modelPlanGatedRule,
  modelUnreachableRule,
  modelUnsupportedRule,
  priceRefusalRule,
  proxyConnectRefusalRule,
  quotaExhaustedRule,
  rateLimitRule,
  transportFaultRule,
  validationRequiredRule,
} from "./provider-rules/generic";
import { policyRejection as isPolicyRejectionWording } from "./provider-rules/buddy";
import { zcodeTrialRefusal } from "./provider-rules/zcode";
import { accountErrorContext, extractValidationUrl, UNCLASSIFIED_COOLDOWN_MS } from "./account-error-evidence";
import {
  transientRateLimitWording,
  type AccountErrorClassification,
  type AccountErrorRule,
  type AccountErrorSignals,
  type AccountFailureEvidence,
} from "./account-error-contracts";

export * from "./account-error-contracts";
export { accountErrorContext, extractValidationUrl } from "./account-error-evidence";

export function classifyAccountError(
  error: unknown,
  options?: AccountFailureEvidence,
): AccountErrorClassification {
  const {
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
    rawUpstreamResponse,
    statedCooldownMs,
    buddyBanned,
    reason,
    result,
  } = accountErrorContext(error, options);
  const modelId = options?.modelId;
  const modelBlockHits = Math.max(1, Math.floor(options?.modelBlockHits ?? 1));
  const staticToken = options?.staticToken === true;
  const credentialKind = options?.credentialKind;

  // The resolved provider id: the caller's evidence when it names one, the
  // thrown error's identity otherwise (dispatch stores it on GatewayError
  // details). Every provider-gated rule reads this resolved value, so a
  // GatewayError that carries its own provider still reaches them.
  const errorProviderId =
    error instanceof GatewayError && typeof error.details.providerId === "string"
      ? error.details.providerId
      : undefined;
  const providerId = options?.providerId ?? errorProviderId;
  // Start Plan is a separate provider: its named trial refusal rests only that
  // model (see the `zcode-start-plan-trial` rule).
  const zcodeTrialRefused = zcodeTrialRefusal(providerId, statusCode, message, modelId);

  // A price refusal is a verdict on the *request*, not on the account. inferhub
  // answers 402 with `no provider's ask matches your max-per-mtok bid`: the
  // caller's own price ceiling was below every upstream ask, which says nothing
  // about the credential or its balance. Classified as quota it cooled a
  // fully-credited account down for an hour and the operator reported it as
  // "blocked, unusable at all". Detected before the quota branch and recorded
  // without mutating the account, so only that request fails.
  const priceRefusal =
    lower.includes("max-per-mtok") ||
    lower.includes("no provider's ask") ||
    (lower.includes("ask") && lower.includes("bid"));
  // Deployment/proxy infrastructure errors (DEPLOYMENT_DISABLED, etc.) are
  // transport-level proxy pool failures, not account quota exhaustion.
  // Mutating the account parks it for an hour while the pool itself stays
  // healthy — the next request picks the same dying pool and the same error
  // repeats. These must not cooldown the account.
  const deploymentInfraError =
    lower.includes("deployment_disabled") ||
    lower.includes("deployment disabled") ||
    (lower.includes("sin1::") && lower.includes("deployment"));
  // A (CodeBuddy/WorkBuddy) *frequency* window is a verdict on one
  // (account, model) pair, not on the account: `{"code":"6004","msg":"usage
  // exceeds frequency limit ... your usage will reset at <stamp> UTC+8,
  // alternatively, you can switch to the other models to continue using it."}`.
  // The provider names the remedy itself — use a different model — which is
  // only a remedy if the account still serves every other model. Taken as
  // account-wide `quota_exhausted` it parked the whole account until the reset,
  // so the switch the upstream offered was refused by our own gateway and every
  // sibling model went dark with it; the account also read COOLDOWN /
  // quota_exhausted while only that pair was throttled.
  //
  // Classified `rate_limit_transient` so the writer scopes it to the model:
  // `recordAccountFailure` writes `modelCooldowns[modelId]` and leaves the
  // account's own status alone. Kept ahead of `quotaSignal`, which matches a
  // *broader* slice of the same wording (`usage exceeds` + `frequency limit`)
  // and would otherwise claim this message as an account-wide quota window.
  // Narrow on purpose — the extra phrase is what says the other models still
  // work; without it the failure stays account-wide.
  const modelFrequencyWindow =
    lower.includes("frequency limit") && lower.includes("switch to the other models");

  // Quota-shaped provider codes/messages (e.g. xAI's
  const quotaSignal =
    !priceRefusal &&
    !deploymentInfraError &&
    (statusCode === 402 ||
      providerCode === "insufficient_quota" ||
      providerCode === "quota_exceeded" ||
      providerCode === "subscription:free-usage-exhausted" ||
      providerCode === "14018" ||
      // CodeBuddy/WorkBuddy rate limit: `{"code":"6004","msg":"usage exceeds
      // frequency limit ... your usage will reset at <stamp> UTC+8"}`. The
      // message names a reset, so this is a parked window, not a transient
      // 429 — without it the account fell through to `unknown` with
      // `mutates=false`, stayed in rotation, and was re-picked for every
      // request inside the window the provider had actually named.
      //
      // Matched on the message's own wording, not on the `6004` code: that code
      // is not unique to this surface (the artifact-release API reuses it), so a
      // code match would sweep an unrelated failure into a quota cooldown. The
      // phrase is the reliable key, and `usage exceeds` + `frequency limit` is
      // the pair this family actually prints.
      (lower.includes("usage exceeds") && lower.includes("frequency limit")) ||
      lower.includes("insufficient_quota") ||
      lower.includes("quota_exceeded") ||
      lower.includes("usage_limit_reached") ||
      lower.includes("usage-exhausted") ||
      lower.includes("usage_exhausted") ||
      lower.includes("usage exhausted") ||
      lower.includes("usage exceeds") ||
      lower.includes("frequency limit") ||
      lower.includes("free-usage") ||
      lower.includes("free usage") ||
      lower.includes("exceeded your current quota") ||
      // Trae answers an exhausted quota with **HTTP 502** and the body `Your
      // requests have exceeded the quota.` The status is what misled the
      // classifier: 502 read as a gateway failure, so this fell through to
      // `server_error` — a 30s cooldown that does not mutate the account, so
      // the account stayed in rotation and every other model on it kept being
      // invoked inside a window the provider had already closed. The body is
      // the verdict; the 502 is incidental. Matched on the phrase, not on the
      // status, which is why this sits in `quotaSignal` ahead of the 5xx arm.
      lower.includes("have exceeded the quota") ||
      lower.includes("balance exhausted") ||
      lower.includes("insufficient balance") ||
      lower.includes("insufficient credits") ||
      lower.includes("out of credits") ||
      lower.includes("credits exhausted") ||
      lower.includes("spending limit") ||
      lower.includes("spending cap") ||
      lower.includes("monthly spend limit") ||
      lower.includes("billing daily count exceeded"));
  // A deterministic content-policy rejection is NOT credential invalidation.
  // CodeBuddy returns HTTP 403 with provider code 11140 ("request illegal",
  // "did not pass the safety review") — refreshing the token cannot change
  // that outcome and the account itself is healthy, so it must never flip the
  // account to auth_invalidated/disabled. Only real auth signals do. The
  // buddy-family arms that act on it live in `buddyRules` at the top of
  // `ACCOUNT_ERROR_RULES`.
  const policyRejection = isPolicyRejectionWording(providerCode, lower);
  // server-side tool (web search, x search, web fetch), not evidence about the
  // credential or the account's quota. Some providers surface it as 403, which
  // would otherwise look like an auth signal — refreshing the token cannot fix
  // a search backend, so it must never disable the account.
  const hostedToolFailure =
    lower.includes("web_search") ||
    lower.includes("web search") ||
    lower.includes("web_search_preview") ||
    lower.includes("x_search") ||
    lower.includes("web_fetch") ||
    lower.includes("tool invocation") ||
    lower.includes("tool call failed") ||
    lower.includes("search backend");
  // A model-scoped license or entitlement rejection is NOT credential invalidation.
  // Google Cloud Code / Antigravity answers HTTP 403 with "You do not have a valid
  // license of this product" when an account lacks entitlement for one specific model
  // (e.g. claude-opus-4-6), while the account itself and its tokens remain fully valid
  // for all other models. Disabling the whole account breaks healthy models.
  const modelEntitlementFailure =
    statusCode === 403 &&
    ((providerId === "commandcode" && lower.includes("model_not_in_plan")) ||
      lower.includes("not have a valid license") ||
      lower.includes("valid license of this product") ||
      lower.includes("model not supported") ||
      lower.includes("not entitled to") ||
      lower.includes("no access to model") ||
      lower.includes("model_not_supported") ||
      lower.includes("not available in your region"));
  /**
   * Google Cloud Code / Antigravity account verification: the upstream answers
   * an unverified account with HTTP 403 `PERMISSION_DENIED` and a
   * `VALIDATION_REQUIRED` reason plus a `validation_url`. The operator must
   * complete verification before the credential can ever serve again, so the
   * account must be parked (`disabled`) — not left `active`, and not a
   * cooldown (no amount of waiting clears it). The validation URL is carried
   * in the recorded reason so the dashboard can surface it as an actionable
   * pill link.
   */
  const validationRequired =
    (statusCode === 403 || lower.includes("permission_denied")) &&
    (lower.includes("validation_required") ||
      lower.includes("verify your account") ||
      lower.includes("validation_url"));
  const validationUrl = validationRequired ? extractValidationUrl(message, rawUpstreamResponse) : undefined;
  /**
   * The upstream accepted the request and put it in a queue behind other
   * callers — it is busy, not rejecting the caller's credential.
   *
   * Matched on the queue evidence rather than on the bare code, so an
   * unrelated 403 that happens to share a code is not swept in. The bodies
   * are nested JSON, so the tell is the key, not a parse of the envelope.
   * (Qoder was the original source of this signal; the match stays for any
   * provider that emits the same queue vocabulary.)
   */
  const queuedUpstream =
    providerCode === "10605" ||
    lower.includes("isqueued") ||
    lower.includes("queuecount") ||
    lower.includes("queuetype") ||
    (lower.includes("queue") && lower.includes("modelkey"));

  const signals: AccountErrorSignals = {
    message,
    lower,
    folded,
    statusCode,
    origin,
    scope,
    providerCode,
    statedCooldownMs,
    reason,
    result,
    canMutate,
    accountEvidence,
    revocationNamed,
    providerId,
    modelId,
    modelBlockHits,
    staticToken,
    credentialKind,
    buddyBanned,
    priceRefusal,
    quotaSignal,
    policyRejection,
    deploymentInfraError,
    modelFrequencyWindow,
    zcodeTrialRefused,
    hostedToolFailure,
    modelEntitlementFailure,
    queuedUpstream,
    validationRequired,
    validationUrl,
    // A quota/spend/cap signal rotates to a sibling account; a per-minute
    // throttle, model capacity, or concurrency cap backs off on the same one.
    // `quotaSignal` is the broad price-refusal match — exclude explicit
    // throttles it would otherwise sweep (see the rate-limit and Inception
    // arms, which match the same signals and must keep backoff-only behavior).
    rotateAccount:
      quotaSignal &&
      !modelFrequencyWindow &&
      !(statusCode === 429 && transientRateLimitWording(lower)) &&
      !(statusCode === 503 || statusCode === 529),
  };

  for (const rule of ACCOUNT_ERROR_RULES) {
    if (rule.match(signals)) return rule.decide(signals);
  }

  // Same reasoning as above, with the shortest backoff: an unmapped failure
  // must still be retried automatically rather than parked forever. When the
  // evidence is account-scoped (`canMutate`), write the cooldown so the
  // account backs off instead of staying `active` at the head of the plan and
  // being re-dialed on every request; provider-scoped evidence stays
  // non-mutating (the upstream is failing for everyone, no single account is
  // at fault).
  const unclassifiedMs = UNCLASSIFIED_COOLDOWN_MS();
  return result(
    "unknown",
    "cooldown",
    unclassifiedMs,
    new Date(Date.now() + unclassifiedMs),
    reason("Unclassified provider failure"),
    canMutate,
  );
}

/**
 * The ordered arms of {@link classifyAccountError}, tried top to bottom; the
 * first match decides. Order is behavior, not presentation — see
 * {@link AccountErrorRule}.
 */
const ACCOUNT_ERROR_RULES: readonly AccountErrorRule[] = [
  // The early-return arms that used to precede this table, kept first so the
  // precedence is unchanged: the zcode trial refusal, the deployment-infra
  // verdict, the per-model frequency window, then the buddy family.
  zcodeStartPlanTrialRule,
  deploymentInfraErrorRule,
  modelFrequencyWindowRule,
  ...buddyRules,
  gatewayCapacityExhaustedRule,
  proxyConnectRefusalRule,
  validationRequiredRule,
  ...githubRules,
  credentialRejectedRule,
  priceRefusalRule,
  qoderPlanGatedRule,
  modelPlanGatedRule,
  ...traeRules,
  qoderModelQuotaRule,
  quotaExhaustedRule,
  ...inceptionRules,
  rateLimitRule,
  modelCapacityRule,
  modelUnsupportedRule,
  modelUnreachableRule,
  transportFaultRule,
];
