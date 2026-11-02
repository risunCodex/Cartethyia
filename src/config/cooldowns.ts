/**
 * Account/pool health cooldown fallback resolvers.
 */

import { CONFIG_SPEC, readInt } from "./spec";

/** The spec row shape every cooldown resolver reads. */
type CooldownSpecEntry = {
  readonly kind: "int";
  readonly default: number;
  readonly min: number;
  readonly max: number;
};

/** Shared cache keyed by env-var name, so one resolver per knob stays warm. */
const cooldownCache = new Map<string, number>();

function cachedCooldownMs(name: string, entry: CooldownSpecEntry): number {
  const cached = cooldownCache.get(name);
  if (cached !== undefined) return cached;
  const value = readInt(name, entry);
  cooldownCache.set(name, value);
  return value;
}

/** Fallback cooldown for a provider rate limit (default 15m). */
export function resolveAccountRateLimitCooldownMs(): number {
  return cachedCooldownMs(
    "CARTETHYIA_ACCOUNT_RATE_LIMIT_COOLDOWN_MS",
    CONFIG_SPEC.CARTETHYIA_ACCOUNT_RATE_LIMIT_COOLDOWN_MS,
  );
}

/**
 * Fallback cooldown for provider quota exhaustion when the error states no
 * reset window (default 1h). A provider-specific rule (xAI Grok Build's
 * rolling 24-hour free-tier window) overrides it inside the classifier.
 */
export function resolveAccountQuotaCooldownMs(): number {
  return cachedCooldownMs(
    "CARTETHYIA_ACCOUNT_QUOTA_COOLDOWN_MS",
    CONFIG_SPEC.CARTETHYIA_ACCOUNT_QUOTA_COOLDOWN_MS,
  );
}

/** Fallback cooldown for model-capacity overload (default 2m). */
export function resolveAccountModelCapacityCooldownMs(): number {
  return cachedCooldownMs(
    "CARTETHYIA_ACCOUNT_MODEL_CAPACITY_COOLDOWN_MS",
    CONFIG_SPEC.CARTETHYIA_ACCOUNT_MODEL_CAPACITY_COOLDOWN_MS,
  );
}

/** Backoff for a transient 5xx/network fault, recorded as `cooldown` (default 30s). */
export function resolveAccountTransientCooldownMs(): number {
  return cachedCooldownMs(
    "CARTETHYIA_ACCOUNT_TRANSIENT_COOLDOWN_MS",
    CONFIG_SPEC.CARTETHYIA_ACCOUNT_TRANSIENT_COOLDOWN_MS,
  );
}

/** Backoff for a failure no rule matched, recorded as `cooldown` (default 1m). */
export function resolveAccountUnclassifiedCooldownMs(): number {
  return cachedCooldownMs(
    "CARTETHYIA_ACCOUNT_UNCLASSIFIED_COOLDOWN_MS",
    CONFIG_SPEC.CARTETHYIA_ACCOUNT_UNCLASSIFIED_COOLDOWN_MS,
  );
}

/**
 * Ceiling an escalated fallback cooldown may reach (default 1h).
 *
 * A fallback duration is one the provider never stated, so escalating it is our
 * own estimate. The cap keeps that estimate from outliving a short transient
 * window: an account that recovers on its own must not sit parked for a day
 * because a burst of 5xx happened to arrive while it was already cooling.
 */
export function resolveAccountCooldownEscalationMaxMs(): number {
  return cachedCooldownMs(
    "CARTETHYIA_ACCOUNT_COOLDOWN_ESCALATION_MAX_MS",
    CONFIG_SPEC.CARTETHYIA_ACCOUNT_COOLDOWN_ESCALATION_MAX_MS,
  );
}

/** How long a proxy pool stays `cooldown` after a transport fault (default 2m). */
export function resolvePoolCooldownMs(): number {
  return cachedCooldownMs(
    "CARTETHYIA_POOL_COOLDOWN_MS",
    CONFIG_SPEC.CARTETHYIA_POOL_COOLDOWN_MS,
  );
}

/**
 * Backoff for an auth rejection that names no revocation (default 5m).
 *
 * A bare `401`/`403` is weak evidence: it covers clock skew, a key rotated
 * upstream a moment ago, an edge cache, and a load balancer that answers before
 * the credential is loaded. None of those is the credential's death, and
 * `disabled` is the one state no sweep recovers — the account would leave
 * rotation until an operator noticed. A cooldown costs the same
 * requests for five minutes and comes back on its own.
 *
 * Only a *named* revocation (`token revoked`, `invalidated oauth token`) still
 * parks the account: the upstream stated the credential itself is dead, there is
 * no expiry to wait out and no refresh to run, so a cooldown would only return
 * it to rotation to fail again. Set this to `0` to return the account to
 * rotation immediately, with no backoff to wait out.
 */
export function resolveAccountAuthRejectedCooldownMs(): number {
  return cachedCooldownMs(
    "CARTETHYIA_ACCOUNT_AUTH_REJECTED_COOLDOWN_MS",
    CONFIG_SPEC.CARTETHYIA_ACCOUNT_AUTH_REJECTED_COOLDOWN_MS,
  );
}

/**
 * Base backoff for the buddy policy/channel block (default 5m).
 *
 * Deliberately a *base*, not the 24h flat penalty it replaced. `11140` has two
 * documented causes our classifier cannot separate from the response alone: the
 * user's prompt failed a safety review, **and** sending the wrong desktop
 * `User-Agent` brand (`workbuddy/shared.ts`). A flat 24h meant that after we
 * fixed a header regression every buddy account stayed dead for up to a further
 * day, and one unsafe prompt cost a whole account a day.
 *
 * As a base it escalates through the consecutive-failure ladder instead, which
 * distinguishes the two causes by what they do next: a genuinely blocked account
 * is refused again on its very next request and parks itself within minutes,
 * while a single bad prompt costs five minutes.
 */
export function resolveAccountPolicyBlockCooldownMs(): number {
  return cachedCooldownMs(
    "CARTETHYIA_ACCOUNT_POLICY_BLOCK_COOLDOWN_MS",
    CONFIG_SPEC.CARTETHYIA_ACCOUNT_POLICY_BLOCK_COOLDOWN_MS,
  );
}

/**
 * How long an **automatically** disabled account stays out of rotation (default 24h).
 *
 * A credential rejected once — a revoked key, a definitively dead refresh grant —
 * would otherwise leave rotation until an operator noticed and clicked Recover by
 * hand. That is the wrong default for a credential that may come back on its own:
 * keys get re-issued, grants get re-authorized, and an upstream's notion of
 * "invalid" can outrun ours.
 *
 * The deadline is what makes this safe to automate rather than a policy guess. A row
 * this gateway disables **by itself** carries the deadline; a row an **operator**
 * disables keeps `cooldownUntil` null, and the recovery sweep selects only rows whose
 * deadline has elapsed. So an operator's decision still outranks the machine, with no
 * extra column and no way to confuse the two.
 *
 * Long on purpose: the states that reach here are the ones where retrying sooner
 * only reproduces the refusal. Set to `0` to make an automatic disable terminal.
 */
export function resolveAccountDisabledRecoveryMs(): number {
  return cachedCooldownMs(
    "CARTETHYIA_ACCOUNT_DISABLED_RECOVERY_MS",
    CONFIG_SPEC.CARTETHYIA_ACCOUNT_DISABLED_RECOVERY_MS,
  );
}

/**
 * Fallback cooldown for a provider-scoped egress 429 when the upstream named no
 * window (default 1h). See `CARTETHYIA_POOL_PROVIDER_RATE_LIMIT_COOLDOWN_MS`.
 * An upstream `retryAfterMs` always wins over this.
 */
export function resolvePoolProviderRateLimitCooldownMs(): number {
  return cachedCooldownMs(
    "CARTETHYIA_POOL_PROVIDER_RATE_LIMIT_COOLDOWN_MS",
    CONFIG_SPEC.CARTETHYIA_POOL_PROVIDER_RATE_LIMIT_COOLDOWN_MS,
  );
}

/**
 * Resets all cached cooldown values. Call this in tests that override
 * cooldown env-vars between test cases.
 */
export function resetCooldownCacheForTests(): void {
  cooldownCache.clear();
}
