/**
 * Provider-agnostic early arms of the classifier: verdicts that are about
 * transport infrastructure or one (account, model) window rather than any
 * provider family, so they carry no provider-id gate.
 */
import {
  resolveAccountAuthRejectedCooldownMs,
  resolveAccountDisabledRecoveryMs,
  resolveAccountModelCapacityCooldownMs,
  resolveAccountQuotaCooldownMs,
  resolveAccountRateLimitCooldownMs,
  resolveAccountTransientCooldownMs,
} from "../../../config/cooldowns";
import type { AccountErrorRule } from "../account-error-contracts";
import {
  MODEL_UNREACHABLE_COOLDOWN_MS,
  NUMERIC_PROVIDER_CODE,
  isUnsupportedModelEvidence,
  modelUnreachableEscalating,
  transientRateLimitWording,
} from "../account-error-contracts";
import { GROK_QUOTA_COOLDOWN_MS, isGrokFreeTierExhaustion } from "./grok";

/**
 * Deployment/proxy infrastructure errors (DEPLOYMENT_DISABLED, etc.) are
 * transport-level proxy pool failures, not account quota exhaustion.
 * Mutating the account parks it for an hour while the pool itself stays
 * healthy — the next request picks the same dying pool and the same error
 * repeats. These must not cooldown the account.
 */
export const deploymentInfraErrorRule: AccountErrorRule = {
  name: "deployment-infra",
  match: (s) => s.deploymentInfraError,
  decide: (s) =>
    s.result(
      "server_error",
      "cooldown",
      60_000,
      null,
      `Proxy deployment error: ${s.message.slice(0, 160)}`,
      false,
    ),
};

/**
 * A (CodeBuddy/WorkBuddy) *frequency* window is a verdict on one
 * (account, model) pair, not on the account: `{"code":"6004","msg":"usage
 * exceeds frequency limit ... your usage will reset at <stamp> UTC+8,
 * alternatively, you can switch to the other models to continue using it."}`.
 * The provider names the remedy itself — use a different model — which is
 * only a remedy if the account still serves every other model. Taken as
 * account-wide `quota_exhausted` it parked the whole account until the reset,
 * so the switch the upstream offered was refused by our own gateway and every
 * sibling model went dark with it; the account also read COOLDOWN /
 * quota_exhausted while only that pair was throttled.
 *
 * Classified `rate_limit_transient` so the writer scopes it to the model:
 * `recordAccountFailure` writes `modelCooldowns[modelId]` and leaves the
 * account's own status alone. Kept ahead of `quotaSignal`, which matches a
 * *broader* slice of the same wording (`usage exceeds` + `frequency limit`)
 * and would otherwise claim this message as an account-wide quota window.
 * Narrow on purpose — the extra phrase is what says the other models still
 * work; without it the failure stays account-wide.
 */
export const modelFrequencyWindowRule: AccountErrorRule = {
  name: "model-frequency-window",
  match: (s) => s.modelFrequencyWindow,
  decide: (s) => {
    const cooldownMs = s.statedCooldownMs ?? resolveAccountQuotaCooldownMs();
    return s.result(
      "rate_limit_transient",
      "cooldown",
      cooldownMs,
      new Date(Date.now() + cooldownMs),
      s.reason("Provider frequency limit for this model"),
      // Provider-scoped evidence still has to reach the writer: a stream frame
      // carries no credential detail, so `canMutate` is false and without this
      // the pair would be retried for the whole window it was closed for.
      s.origin === "upstream" && s.scope === "provider",
    );
  },
};

const DEFAULT_RATE_LIMIT_COOLDOWN_MS = resolveAccountRateLimitCooldownMs;
// Fallback when the error states no usable duration: deliberately short (1h,
// not 24h) — quota state is re-probed on the next failure, so an unknown
// reset cadence self-corrects instead of parking the account for a day.
const DEFAULT_QUOTA_COOLDOWN_MS = resolveAccountQuotaCooldownMs;
const MODEL_CAPACITY_COOLDOWN_MS = resolveAccountModelCapacityCooldownMs;
const TRANSIENT_ERROR_COOLDOWN_MS = resolveAccountTransientCooldownMs;

/**
 * The provider-agnostic arms of the classifier, in their original evaluation
 * order. The classifier interleaves them with the provider-family rule sets —
 * see `ACCOUNT_ERROR_RULES` in `account-error-classification.ts` — so each arm
 * is exported by name rather than bundled here.
 */
export const gatewayCapacityExhaustedRule: AccountErrorRule = {
  // Must precede "rate-limit": this rejection is a 429 whose own text says
  // "rate limit", so the broader arm claimed it and cooled the account for
  // the full 15-minute rate-limit window.
  //
  // A full max-inflight is a statement about the gateway's own routing, not
  // about the credential: every account serving the model is busy right now.
  // Cooling them marks healthy accounts as `cooldown` for a limit their
  // provider never applied, which is what made every account read busy while
  // incoming requests piled up — the accounts were never the problem, the
  // ceiling was.
  name: "gateway-capacity-exhausted",
  match: (s) =>
    s.lower.includes("at its concurrency limit") ||
    s.lower.includes("every proxy pool for this provider is at its concurrency limit") ||
    s.lower.includes("the gateway is at its concurrency limit"),
  decide: (s) =>
    s.result(
      "model_capacity",
      // `status` is the status the account would move to; it is never
      // applied because `mutatesAccount` is false below, so this names the
      // shape rather than a transition. Zero cooldown is the point: no wait
      // is attached to the account, so the next request may use it at once.
      "cooldown",
      0,
      null,
      s.reason("Gateway concurrency ceiling reached; no account was at fault"),
      // Never mutates: there is nothing wrong with the account to record.
      false,
    ),
};

export const proxyConnectRefusalRule: AccountErrorRule = {
  // Must precede the unclassified fallback: the fallback is account-blind and
  // would stamp this as a provider-wide failure, which is how one proxy
  // refusing CONNECT put every account of every provider behind that pool
  // into cooldown — opencode's dead front door taking codebuddy down with it.
  //
  // A CONNECT refusal is a statement about the proxy pool, not about a
  // credential: the tunnel was never established, so no upstream ever saw the
  // request and no account can be at fault. Scoped to the pool so the
  // provider's own accounts stay in rotation.
  name: "proxy-connect-refusal",
  match: (s) =>
    s.lower.includes("proxy connect failed") ||
    (s.lower.includes("connect") && s.lower.includes("tunnel") && s.lower.includes("refus")),
  decide: (s) =>
    s.result(
      "model_unreachable",
      "cooldown",
      0,
      null,
      s.reason("Proxy pool refused the CONNECT tunnel"),
      // Never mutates: the pool owns this failure, not the account.
      false,
    ),
};

export const validationRequiredRule: AccountErrorRule = {
  name: "validation-required",
  match: (s) => s.validationRequired,
  // The upstream named the verdict; the account cannot serve until the
  // operator completes verification. It is still a *timed* cooldown, never
  // a permanent `disabled`: the account comes back after the window, retries,
  // and re-cools if verification is still outstanding — so a machine verdict
  // can never park a credential forever. `validation_required` is a hard
  // category (see `HARD_COOLDOWN_CATEGORIES`), so the account is excluded
  // while cooling instead of being dialed and failing again.
  decide: (s) => {
    const cooldownMs = s.statedCooldownMs ?? DEFAULT_RATE_LIMIT_COOLDOWN_MS();
    return s.result(
      "validation_required",
      "cooldown",
      cooldownMs,
      new Date(Date.now() + cooldownMs),
      s.validationUrl !== undefined
        ? `${s.reason("Google account verification required")} — ${s.validationUrl}`
        : s.reason("Google account verification required"),
      true,
    );
  },
};

export const credentialRejectedRule: AccountErrorRule = {
  name: "credential-rejected",
  match: (s) =>
    !s.quotaSignal &&
    !s.policyRejection &&
    !s.hostedToolFailure &&
    !s.modelEntitlementFailure &&
    !s.queuedUpstream &&
    (s.providerCode === "authentication_failed" ||
      s.folded.includes("invalid api key") ||
      s.folded.includes("incorrect api key") ||
      s.folded.includes("invalid token") ||
      s.folded.includes("token revoked") ||
      s.folded.includes("invalidated oauth token") ||
      s.folded.includes("reauthorization required") ||
      s.folded.includes("account deactivated") ||
      // Trae answers `1001 "we are not able to authenticate you"` when the
      // credential is dead or invalidated — it is the provider's own auth
      // verdict, but the code is numeric, so it is excluded from the bare
      // 401/403 arm below. Recognising it here keeps the account out of the
      // `unknown` fallback (which never mutates and leaves the account in
      // rotation to be re-dialled on every request).
      ((s.providerId === "trae" || s.providerId === "traecn") &&
        s.providerCode === "1001") ||
      // A bare 401/403 only proves the credential when the body actually
      // says so. A purely numeric provider code carries no auth vocabulary —
      // providers encode limit/entitlement verdicts as numbers too (Qoder's
      // `110`, buddy's `6004`) — and treating an unknown one as credential
      // evidence parked healthy accounts as "Re-login required". Unmapped
      // numeric codes fall through to the unclassified cooldown instead of
      // ever invalidating.
      ((s.statusCode === 401 || s.statusCode === 403) &&
        s.accountEvidence &&
        !NUMERIC_PROVIDER_CODE.test(s.providerCode))),
  decide: (s) => {
    // A static token has no refresh to run, so an auth rejection must not park
    // the account: disabling it throws away a token that may still work (a
    // single upstream 401 can be transient). A cooldown lets the next attempt
    // retry the same token without losing the account.
    const oauthRecovery =
      !s.staticToken &&
      s.credentialKind === "oauth" &&
      (s.lower.includes("expired") || s.lower.includes("refresh"));
    // A *named* revocation is the strongest auth evidence: the upstream said
    // the credential itself is dead — not that it expired, not that this
    // request was refused — so there is no window to wait out and no refresh
    // to run. Every other auth rejection is weak evidence (clock skew, a key
    // rotated a moment ago, an edge answering before the credential loads) and
    // cools down on a short window.
    //
    // Neither state disables the account permanently: `auth_invalidated` lands
    // as a *timed* cooldown on the recovery window, so the machine can undo
    // its own verdict once it elapses while an operator's decision still
    // outranks it — see `resolveAccountDisabledRecoveryMs`. A permanent
    // `disabled` is reserved for the operator.
    const revoked = s.revocationNamed;
    const recoverable = s.staticToken || oauthRecovery || !revoked;
    const disabledRecoveryMs = resolveAccountDisabledRecoveryMs();
    const disabledRetryAt =
      disabledRecoveryMs > 0 ? new Date(Date.now() + disabledRecoveryMs) : null;
    const cooldownMs = recoverable ? resolveAccountAuthRejectedCooldownMs() : disabledRecoveryMs;
    return s.result(
      // `auth_rejected` is the recoverable verdict: it cools the account down
      // and heals on its own. `auth_invalidated` stays reserved for the
      // named-revocation arm — the only auth outcome the console may render
      // "Re-login required" — but it is a timed cooldown, not a permanent
      // disable.
      recoverable ? "auth_rejected" : "auth_invalidated",
      "cooldown",
      cooldownMs,
      recoverable ? new Date(Date.now() + cooldownMs) : disabledRetryAt,
      s.reason(
        !revoked
          ? "Provider credential rejected; retrying after a backoff"
          : s.staticToken
            ? "Static token rejected; retrying without a refresh"
            : oauthRecovery
              ? "OAuth credential requires refresh"
              : "Provider credential revoked",
      ),
      s.canMutate,
    );
  },
};

export const priceRefusalRule: AccountErrorRule = {
  name: "price-refusal",
  match: (s) => s.priceRefusal,
  decide: (s) =>
    s.result("quota_exhausted", "cooldown", 0, null, s.reason("Request price refused by the provider"), false),
};

export const modelPlanGatedRule: AccountErrorRule = {
  name: "model-plan-gated",
  match: (s) => s.quotaSignal && s.providerCode === "112",
  decide: (s) => modelUnreachableEscalating(s, "Model not included in this account's plan"),
};

export const quotaExhaustedRule: AccountErrorRule = {
  name: "quota-exhausted",
  match: (s) =>
    s.origin === "upstream" &&
    s.quotaSignal &&
    // A transient rolling throttle phrased with quota wording (TPM/RPM
    // "tpm exhausted (type=quota_exceeded_error)") self-heals within the
    // minute; it belongs to the rate-limit arm below, never here.
    !transientRateLimitWording(s.lower),
  decide: (s) => {
    // xAI Grok Build's free tier resets on a rolling window. Use a duration
    // stated by the provider when present; otherwise park for the conservative
    // 24-hour fallback.
    const grokFreeTier = isGrokFreeTierExhaustion(s);
    // Only the explicit free-usage allowance is model-scoped. Subscription
    // spending caps are account-level and still park the whole credential.
    const grokFreeUsageModelScope =
      s.providerId === "grok" &&
      (s.providerCode === "subscription:free-usage-exhausted" ||
        s.lower.includes("subscription:free-usage-exhausted") ||
        s.lower.includes("included free usage"));
    const buddyCreditsExhausted =
      s.providerCode === "14018" || s.lower.includes("credits exhausted");
    const cooldownMs = grokFreeTier
      ? (s.statedCooldownMs ?? GROK_QUOTA_COOLDOWN_MS)
      : buddyCreditsExhausted
        ? (s.statedCooldownMs ?? 12 * 60 * 60 * 1000)
        : (s.statedCooldownMs ?? DEFAULT_QUOTA_COOLDOWN_MS());
    // The caller records against the concrete account that just failed
    // upstream, so a provider-scoped quota error still cools THAT account
    // down (enables fallback to the next account). Local-origin quota must
    // never mutate an upstream account.
    return s.result(
      "quota_exhausted",
      "cooldown",
      cooldownMs,
      new Date(Date.now() + cooldownMs),
      s.reason("Provider quota exhausted"),
      s.origin === "upstream",
      false,
      grokFreeUsageModelScope && s.modelId !== undefined,
    );
  },
};

export const rateLimitRule: AccountErrorRule = {
  name: "rate-limit",
  match: (s) =>
    s.origin === "upstream" &&
    (s.statusCode === 429 ||
      s.providerCode === "rate_limit_exceeded" ||
      s.lower.includes("rate_limit") ||
      s.lower.includes("rate limit") ||
      s.lower.includes("too many requests") ||
      s.lower.includes("requests per minute") ||
      s.lower.includes("tokens per minute") ||
      s.lower.includes("tpm limit") ||
      s.lower.includes("rpm limit")),
  decide: (s) => {
    const fallbackMs = DEFAULT_RATE_LIMIT_COOLDOWN_MS();
    // A provider-stated window still wins when it is *longer* than the
    // configured cooldown, but a trivially short `retry_after` (OpenRouter's
    // `retry_after_seconds: 1`) is not a real reset window — honoring it
    // verbatim expired the cooldown before the sweep's next tick and left the
    // account churning active → cooldown → active with no visible backoff.
    // The configured rate-limit cooldown is therefore a floor, not just a
    // fallback. The raw stated value still rides on the classification
    // (`statedCooldownMs`) so the auto-disable gate's sub-5-minute exemption
    // keeps reading the provider's own number.
    const cooldownMs =
      s.statedCooldownMs === null
        ? fallbackMs
        : Math.max(s.statedCooldownMs, fallbackMs);
    // Same per-account reasoning as quota above: the failing account (or
    // its model, when modelId is present) backs off so routing tries the
    // next candidate instead of hammering the same key.
    return s.result(
      "rate_limit_transient",
      "cooldown",
      cooldownMs,
      new Date(Date.now() + cooldownMs),
      s.reason("Provider rate limit"),
      s.origin === "upstream",
    );
  },
};

export const modelCapacityRule: AccountErrorRule = {
  name: "model-capacity",
  match: (s) =>
    s.origin === "upstream" &&
    (s.statusCode === 503 ||
      s.statusCode === 529 ||
      s.providerCode === "model_capacity" ||
      s.queuedUpstream ||
      s.lower.includes("model overloaded") ||
      s.lower.includes("capacity exceeded") ||
      s.lower.includes("temporarily unavailable")),
  decide: (s) => {
    const cooldownMs = s.statedCooldownMs ?? MODEL_CAPACITY_COOLDOWN_MS();
    const modelScopedMutation = s.origin === "upstream" && s.modelId !== undefined;
    return s.result(
      "model_capacity",
      "cooldown",
      cooldownMs,
      new Date(Date.now() + cooldownMs),
      s.reason("Provider model capacity"),
      // With a model id the pair backs off (model-scoped). Without one there
      // is no pair to cool, but the account must still back off — leaving it
      // `active` meant it stayed at the head of the plan and was re-dialed on
      // every request, failing over and over with no cooldown ever written.
      // `canMutate` is true for account-scoped evidence, so the undefined case
      // lands as an account-wide cooldown (soft, so a single-account
      // deployment still routes).
      modelScopedMutation,
      false,
      modelScopedMutation,
    );
  },
};

export const modelUnsupportedRule: AccountErrorRule = {
  name: "model-unsupported",
  match: (s) => isUnsupportedModelEvidence(s.statusCode, s.providerCode, s.folded),
  decide: (s) => modelUnreachableEscalating(s, "Model not supported by this upstream"),
};

export const modelUnreachableRule: AccountErrorRule = {
  name: "model-unreachable",
  match: (s) => s.providerCode === "not_found" || s.modelEntitlementFailure,
  decide: (s) => {
    const cooldownMs = MODEL_UNREACHABLE_COOLDOWN_MS;
    // Not credential evidence, so `classifyUpstreamFailure` scopes this to the
    // provider and the `scope === "account"` gate the throttles use would
    // forbid the mutation outright — leaving the probe reporting a failure that
    // cooled nothing. The verdict is still about one (account, model) pair:
    // `recordAccountFailure` writes `modelCooldowns[modelId]` and leaves the
    // account's own status untouched, so all that is required is a model to
    // write against.
    const modelScopedMutation = s.origin === "upstream" && s.modelId !== undefined;
    return s.result(
      "model_unreachable",
      "cooldown",
      cooldownMs,
      new Date(Date.now() + cooldownMs),
      s.reason("Model unreachable for this account"),
      modelScopedMutation,
    );
  },
};

export const transportFaultRule: AccountErrorRule = {
  name: "transport-fault",
  match: (s) =>
    (s.statusCode !== null && s.statusCode >= 500 && s.statusCode <= 504) ||
    s.lower.includes("timeout") ||
    s.lower.includes("abort") ||
    s.lower.includes("econnrefused") ||
    s.lower.includes("fetch failed"),
  decide: (s) => {
    // A transport-shaped fault clears on its own, so it is a cooldown with a
    // deadline rather than a state needing an operator. The deadline matters:
    // `sweepExpiredCooldowns` selects on `cooldownUntil IS NOT NULL`, so a row
    // parked without one is never recovered and stays out of rotation.
    //
    // `canMutate` rather than a flat `false`: a 5xx whose failure the caller
    // scoped to the account (an edge/WAF challenge answered to one account's
    // requests while its siblings on the same egress served fine) must cool
    // that account down, or it stays `active` and is re-dialled for as long as
    // the block lasts. Provider-scoped 5xx does not: the upstream is
    // indiscriminately failing and no single account is at fault.
    const transientMs = TRANSIENT_ERROR_COOLDOWN_MS();
    return s.result(
      s.lower.includes("timeout") ? "timeout" : "server_error",
      "cooldown",
      transientMs,
      new Date(Date.now() + transientMs),
      s.reason(`Provider ${s.statusCode ?? "network"} failure`),
      s.canMutate,
    );
  },
};
