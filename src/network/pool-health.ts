import type { CartethyiaDatabase } from "../persistence/db-handle";
import type { NetworkPoolSelector } from "./pool/selector";
import { GatewayError } from "../protocol/gateway-error";
import { metrics } from "../observability/metrics";
import { log } from "../observability/logger";
import { appendPoolProviderEgressAuditRow, upsertProviderCooldownMarker } from "./pool-cooldown-store";
import { resolvePoolProviderRateLimitCooldownMs } from "../config/cooldowns";
import type { EgressVerdict } from "./rate-limit-verdict";

/**
 * Durable pool rate-limit history.
 *
 * Per-(pool, provider) 429 cooldowns live in `NetworkPoolSelector` (fast,
 * volatile, consulted on every dispatch). This recorder mirrors each flag into
 * two durable homes: the append-only `health_events` table
 * (`entity_kind: "pool"`, the same merged log the account recorder writes to
 * for accounts) for audit, and the `provider_cooldowns` column on the pool row
 * as the state boot restores — a restart must not make dispatch forget the
 * egresses the upstream is still refusing. It never touches
 * `network_pools.status`: a single provider's 429 must not flip the whole pool
 * to `cooldown` (that would head-of-line-block every other provider on the
 * pool).
 */

/**
 * Coalescing window for repeated per-(pool, provider) 429 events. Dispatch
 * flags the same pair on every throttled request, but the durable audit log
 * needs one row per cooldown episode — not one per throttled request.
 */
const POOL_COOLDOWN_EVENT_WINDOW_MS = 15 * 60 * 1000;

/** Durable half of `flagPoolCooldown`; not a second public entry point. */
async function recordPoolCooldownEvent(
  db: CartethyiaDatabase,
  poolId: string,
  providerId: string,
  reason: string,
): Promise<void> {
  await appendPoolProviderEgressAuditRow(db, {
    poolId,
    providerId,
    reason,
    blocked: false,
    coalesceWindowMs: POOL_COOLDOWN_EVENT_WINDOW_MS,
  });
}

/**
 * Retires a pool for one provider because the upstream flagged its egress.
 *
 * Separate from `flagPoolCooldown` on purpose: the two facts are not
 * interchangeable. A 429 is an allowance that refills, so the pool returns to
 * rotation when the window ends. A free-tier refusal means the address itself
 * is retired upstream, and putting it back would spend a real request to learn
 * the same answer. The audit row therefore carries `errorCategory:
 * "egress_blocked"` rather than `rate_limit_transient`, which is what the
 * console reads to draw it as a block instead of a cooldown.
 */
export function flagPoolBlocked(
  poolSelector: NetworkPoolSelector,
  db: CartethyiaDatabase,
  poolId: string,
  providerId: string,
  error: GatewayError,
): void {
  const reason = `Provider ${providerId} refused this egress`;
  void poolSelector
    .flagProviderBlocked(poolId, providerId, reason)
    .then((entry) =>
      // Persisted even when the flag was refused (a credential-keyed
      // provider): the selector returned an inert entry, so the mirror
      // records nothing a reader would act on.
      upsertProviderCooldownMarker(db, poolId, providerId, entry),
    )
    .catch((cause: unknown) => {
      metrics.pool_cooldown_record_failed.inc(1);
      log.warn("pool block flag failed", {
        networkPoolId: poolId,
        providerId,
        error: String(cause),
      });
    });
  void recordPoolBlockEvent(db, poolId, providerId, reason, error);
}

/**
 * Durable half of `flagPoolBlocked`.
 *
 * Not coalesced the way a cooldown is: a block happens once per (pool,
 * provider) for the life of the deployment, so there is no burst to collapse.
 * A repeated event means the operator re-enabled the pool and it was refused
 * again, which is worth a second row.
 */
async function recordPoolBlockEvent(
  db: CartethyiaDatabase,
  poolId: string,
  providerId: string,
  reason: string,
  error: GatewayError,
): Promise<void> {
  await appendPoolProviderEgressAuditRow(db, {
    poolId,
    providerId,
    reason,
    blocked: true,
    codeSuffix: providerCodeSuffix(error),
  });
}

/** The upstream's own code, when it named one, so the audit row is actionable. */
function providerCodeSuffix(error: GatewayError): string {
  const code = error.details.providerCode;
  return typeof code === "string" && code.length > 0 ? ` (${code})` : "";
}

/** Cooldown applied when an upstream 429 carries no `retryAfterMs`. */
const DEFAULT_PROVIDER_COOLDOWN_MS = 15 * 60 * 1000;

/**
 * The fallback window for a provider-scoped egress cooldown. Upstream `Retry-After`
 * always wins; the configured default exists because a request-counted free
 * tier — the one provider that flags at all — stays refused for hours after
 * the 15-minute guess this function used before.
 */
function providerCooldownFallbackMs(): number {
  return Math.max(resolvePoolProviderRateLimitCooldownMs(), DEFAULT_PROVIDER_COOLDOWN_MS);
}

/**
 * Records a provider-scoped 429 cooldown: the volatile per-(pool, provider)
 * flag consulted on every dispatch, its durable audit row, and the durable
 * state boot restores from.
 *
 * Both paths that reach this decision — the non-streaming attempt loop and
 * the streaming failure path — call this one function, because each write
 * reports its own failure through the same metric and warn log. Two copies
 * would have to be edited together, and a divergence would surface only as
 * telemetry that silently differs by response mode.
 *
 * Callers gate on `shouldCooldownPool`, which narrows the error to the
 * upstream/provider-scoped 429 this function is written for.
 */
export function flagPoolCooldown(
  poolSelector: NetworkPoolSelector,
  db: CartethyiaDatabase,
  poolId: string,
  providerId: string,
  error: GatewayError,
): void {
  const reason = `Provider ${providerId} rate limit`;
  const retryAfterMs =
    typeof error.details.retryAfterMs === "number"
      ? error.details.retryAfterMs
      : providerCooldownFallbackMs();
  void poolSelector
    .flagProviderCooldown(poolId, providerId, retryAfterMs, reason)
    .then((entry) => upsertProviderCooldownMarker(db, poolId, providerId, entry))
    .catch((cause: unknown) => {
      metrics.pool_cooldown_record_failed.inc(1);
      log.warn("pool cooldown flag failed", {
        networkPoolId: poolId,
        providerId,
        error: String(cause),
      });
    });
  void recordPoolCooldownEvent(db, poolId, providerId, reason);
}

/**
 * One egress-failure verdict → pool-flag dispatch, shared by the attempt loop
 * and the streaming finalizer.
 *
 * Both paths classify the same failure with `classifyEgressFailure`, then must
 * retire the same pool the same way; a policy change — which verdict maps to a
 * cooldown vs a block, or a new verdict — belongs here so the two response
 * modes cannot drift in telemetry.
 *
 * The call sites compute the verdict (the attempt loop also needs it for its
 * retry decision) and pass it in; the gating is identical to what both
 * previously applied by hand: only a real pool id + selector pair, only a
 * `GatewayError`, and never a `"none"` verdict. The flags themselves are
 * fire-and-forget advisory writes that never fail the request.
 */
export function flagPoolOnEgressFailure(
  poolSelector: NetworkPoolSelector | undefined,
  db: CartethyiaDatabase,
  poolId: string | undefined,
  providerId: string,
  error: unknown,
  verdict: EgressVerdict,
): void {
  if (poolId === undefined || poolSelector === undefined || !(error instanceof GatewayError)) return;
  if (verdict.kind === "cooldown") {
    flagPoolCooldown(poolSelector, db, poolId, providerId, error);
  } else if (verdict.kind === "blocked") {
    flagPoolBlocked(poolSelector, db, poolId, providerId, error);
  }
}
