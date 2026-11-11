/**
 * Pool health — flag helpers + state machine.
 *
 * Two halves of one domain, kept in one home:
 *
 * - **Flag helpers** (`flagPoolBlocked`, `flagPoolCooldown`,
 *   `flagPoolOnEgressFailure`): durable per-(pool, provider) 429/block
 *   history. The volatile flags live in `NetworkPoolSelector` (fast, consulted
 *   on every dispatch); these mirror each flag into two durable homes — the
 *   append-only `health_events` table (`entity_kind: "pool"`) for audit, and
 *   the `provider_cooldowns` column as the state boot restores. They never
 *   touch `network_pools.status`: a single provider's 429 must not flip the
 *   whole pool to `cooldown`.
 *
 * - **State machine** (`recordPoolDispatchOutcome`, `disablePoolForProxyHttpStatus`,
 *   `recoverNetworkPool`, `sweepExpiredPoolCooldowns`): the pool row's health
 *   transitions, subscriber feed, and recovery sweep.
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNotNull, lte, sql } from "drizzle-orm";
import type { CartethyiaDatabase } from "../../persistence/db-handle";
import { healthEventBuffer } from "../../persistence/health-event-flush";
import { healthEvents, networkPools } from "../../persistence/schema";
import { GatewayError } from "../../protocol/gateway-error";
import { metrics } from "../../observability/metrics";
import { log } from "../../observability/logger";
import { resolvePoolProviderRateLimitCooldownMs, resolvePoolCooldownMs } from "../../config/cooldowns";
import type { NetworkPoolSelector } from "./selector";
import { appendPoolProviderEgressAuditRow, dropProviderCooldownMarker, pruneExpiredProviderCooldownMarkers, upsertProviderCooldownMarker } from "./cooldown-store";
import { drainPoolByteDelta } from "./accounting";
import type { EgressVerdict } from "../verdict";

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

export interface PoolHealthEvent {
  readonly id: string;
  readonly networkPoolId: string;
  readonly fromStatus: string | null;
  readonly toStatus: string;
  readonly reason: string | null;
  readonly errorCategory: string | null;
  readonly createdAt: string;
}

interface PoolHealthSnapshot {
  readonly poolId: string;
  readonly tenantId: string;
  readonly status: "active" | "cooldown" | "disabled";
  readonly consecutiveFailures: number;
  readonly lastError?: string;
  readonly lastErrorCategory?: string;
  readonly lastErrorAt?: string;
  readonly cooldownUntil?: string;
  readonly lastSuccessAt?: string;
}

const POOL_COOLDOWN_MS = resolvePoolCooldownMs;
const subscribers = new Set<(snapshot: PoolHealthSnapshot) => void>();

/** Subscribe to pool health transitions for console SSE delivery. */
export function subscribePoolHealth(listener: (snapshot: PoolHealthSnapshot) => void): () => void {
  subscribers.add(listener);
  return () => subscribers.delete(listener);
}

function publishPoolHealth(snapshot: PoolHealthSnapshot): void {
  for (const listener of subscribers) listener(snapshot);
}

function poolFaultCategory(error: unknown, origin: string | undefined): string | undefined {
  if (origin === "upstream") return undefined;
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") {
    const code = error.code;
    if (["proxy_unreachable", "tunnel_setup_failed", "proxy_auth_required", "tls_rejected", "transport_unavailable", "deadline_exceeded"].includes(code)) return code;
  }
  if (origin === "network") return "proxy_unreachable";
  return undefined;
}

/** Record a pool-bound attempt. Only failures produced by the proxy/network boundary degrade the pool. */
export async function recordPoolDispatchOutcome(
  db: CartethyiaDatabase,
  poolId: string,
  input: {
    readonly succeeded: boolean;
    readonly error?: unknown;
    readonly errorOrigin?: string;
    /** The provider the attempt dialed; used to clear its stale egress marker on success. */
    readonly providerId?: string;
    readonly snapshotInvalidator?: { invalidate(): unknown };
  },
): Promise<void> {
  const category = input.succeeded ? undefined : poolFaultCategory(input.error, input.errorOrigin);
  // Metered bytes are banked even when health is untouched: an upstream-origin
  // failure still carried traffic through the pool, and the quota bar must
  // count it. Drained here so the high-water mark advances exactly once per
  // flush, whichever branch below performs the write.
  const delta = drainPoolByteDelta(poolId);
  const hasDelta = delta.sent > 0 || delta.received > 0;
  const bankedTotals = hasDelta
    ? {
        bytesSentTotal: sql`${networkPools.bytesSentTotal} + ${delta.sent}`,
        bytesReceivedTotal: sql`${networkPools.bytesReceivedTotal} + ${delta.received}`,
      }
    : {};
  if (!input.succeeded && category === undefined) {
    if (hasDelta) {
      await db.update(networkPools).set(bankedTotals).where(eq(networkPools.id, poolId));
    }
    return;
  }
  const rows = await db.select().from(networkPools).where(eq(networkPools.id, poolId)).limit(1);
  const pool = rows[0];
  if (!pool || pool.status === "disabled") return;
  const now = new Date();
  const fromStatus = pool.status;
  let status = pool.status;
  let failures = pool.consecutiveFailures;
  let cooldownUntil = pool.cooldownUntil;
  let lastError = pool.lastError;
  let lastErrorCategory = pool.lastErrorCategory;
  let lastErrorAt = pool.lastErrorAt;
  let lastSuccessAt = pool.lastSuccessAt;
  if (input.succeeded) {
    failures = 0;
    status = "active";
    cooldownUntil = null;
    lastError = null;
    lastErrorCategory = null;
    lastErrorAt = null;
    lastSuccessAt = now;
    // A completed dispatch proves the egress is serving again for this
    // provider — clear its stale rate-limit marker (the selector's local
    // entry and the Redis copy) so a spent pool is not kept out of rotation
    // after it demonstrably recovered. Fire-and-forget: a failed clear must
    // never fail a completed request.
    if (input.providerId !== undefined) {
      void dropProviderCooldownMarker(db, poolId, input.providerId).catch(() => undefined);
    }
  } else {
    failures += 1;
    // Every failed probe parks the pool: a pool that cannot carry traffic is
    // unusable either way, and the old "degraded until the third failure" tier
    // only meant routing and the console disagreed about whether it was up.
    status = "cooldown";
    cooldownUntil = new Date(now.getTime() + POOL_COOLDOWN_MS());
    lastErrorCategory = category ?? "proxy_unreachable";
    lastError = `Proxy transport failed (${lastErrorCategory})`;
    lastErrorAt = now;
  }
  const statusChanged = status !== fromStatus;
  const healthChanged =
    statusChanged ||
    pool.consecutiveFailures !== failures ||
    pool.lastErrorCategory !== lastErrorCategory ||
    pool.lastError !== lastError ||
    (input.succeeded && pool.consecutiveFailures > 0);
  await db.update(networkPools).set({
    status,
    consecutiveFailures: failures,
    cooldownUntil,
    lastError,
    lastErrorCategory,
    lastErrorAt,
    lastSuccessAt,
    ...bankedTotals,
    ...(input.succeeded && fromStatus !== "active" ? { lastRecoveredAt: now } : {}),
  }).where(eq(networkPools.id, poolId));
  if (statusChanged || (input.succeeded && pool.consecutiveFailures > 0)) {
    // Off the request path when a buffer is installed: this row is
    // append-only and read by nobody in dispatch. The pool's own status write
    // above stays synchronous, because pool selection reads it.
    const buffer = healthEventBuffer();
    const row = {
      entityKind: "pool" as const,
      networkPoolId: poolId,
      fromStatus,
      toStatus: status,
      reason: input.succeeded ? "Proxy dispatch succeeded — pool recovered" : (lastError ?? ""),
      errorCategory: input.succeeded ? null : (category ?? null),
      // The pool's own cooldown deadline is when the state releases, so the log
      // shows a countdown; a recovery releases immediately.
      createdAt: now,
    };
    if (buffer !== undefined) buffer.enqueue(row);
    else await db.insert(healthEvents).values({ id: randomUUID(), ...row } as never);
  }
  if (healthChanged) {
    publishPoolHealth({
      poolId,
      tenantId: pool.tenantId,
      status,
      consecutiveFailures: failures,
      ...(lastError ? { lastError } : {}),
      ...(lastErrorCategory ? { lastErrorCategory } : {}),
      ...(lastErrorAt ? { lastErrorAt: lastErrorAt.toISOString() } : {}),
      ...(cooldownUntil ? { cooldownUntil: cooldownUntil.toISOString() } : {}),
      ...(lastSuccessAt ? { lastSuccessAt: lastSuccessAt.toISOString() } : {}),
    });
  }
  if (statusChanged) await input.snapshotInvalidator?.invalidate();
}

/** Disables a proxy pool after a proxy-origin payment or authentication failure. */
export async function disablePoolForProxyHttpStatus(
  db: CartethyiaDatabase,
  poolId: string,
  statusCode: number,
  snapshotInvalidator?: { invalidate(): unknown },
): Promise<boolean> {
  const failure =
    statusCode === 402
      ? {
          category: "proxy_payment_required",
          reason: "HTTP 402 Payment Required — proxy reachable but unusable",
        }
      : statusCode === 407
        ? {
            category: "proxy_auth_required",
            reason: "HTTP 407 Proxy Authentication Required — proxy reachable but unusable",
          }
        : undefined;
  if (!failure) return false;

  const rows = await db.select().from(networkPools).where(eq(networkPools.id, poolId)).limit(1);
  const pool = rows[0];
  if (!pool || pool.status === "disabled") return false;

  const now = new Date();
  const updated = await db
    .update(networkPools)
    .set({
      status: "disabled",
      cooldownUntil: null,
      lastError: failure.reason,
      lastErrorCategory: failure.category,
      lastErrorAt: now,
    })
    .where(and(eq(networkPools.id, poolId), eq(networkPools.status, pool.status)))
    .returning({ id: networkPools.id });
  if (!updated[0]) return false;

  await db.insert(healthEvents).values({
    id: randomUUID(),
    entityKind: "pool",
    networkPoolId: poolId,
    fromStatus: pool.status,
    toStatus: "disabled",
    reason: failure.reason,
    errorCategory: failure.category,
    createdAt: now,
  });
  publishPoolHealth({
    poolId,
    tenantId: pool.tenantId,
    status: "disabled",
    consecutiveFailures: pool.consecutiveFailures,
    lastError: failure.reason,
    lastErrorCategory: failure.category,
    lastErrorAt: now.toISOString(),
  });
  await snapshotInvalidator?.invalidate();
  return true;
}

/** Operator recovery mirrors account recovery and records the transition. */
export async function recoverNetworkPool(db: CartethyiaDatabase, tenantId: string, poolId: string): Promise<boolean> {
  const rows = await db.select().from(networkPools).where(and(eq(networkPools.tenantId, tenantId), eq(networkPools.id, poolId))).limit(1);
  const pool = rows[0];
  if (!pool) return false;
  const now = new Date();
  await db.update(networkPools).set({ status: "active", consecutiveFailures: 0, cooldownUntil: null, lastRecoveredAt: now }).where(and(eq(networkPools.tenantId, tenantId), eq(networkPools.id, poolId)));
  await db.insert(healthEvents).values({ id: randomUUID(), entityKind: "pool", networkPoolId: poolId, fromStatus: pool.status, toStatus: "active", reason: "Manual operator recovery", errorCategory: null, createdAt: now });
  publishPoolHealth({ poolId, tenantId: pool.tenantId, status: "active", consecutiveFailures: 0 });
  return true;
}

/** List recent health and recovery events for a tenant-owned pool. */
export async function listNetworkPoolHealthEvents(db: CartethyiaDatabase, tenantId: string, poolId: string, limit = 50): Promise<readonly PoolHealthEvent[]> {
  const owned = await db.select({ id: networkPools.id }).from(networkPools).where(and(eq(networkPools.tenantId, tenantId), eq(networkPools.id, poolId))).limit(1);
  if (!owned[0]) return [];
  const rows = await db.select().from(healthEvents).where(and(eq(healthEvents.entityKind, "pool"), eq(healthEvents.networkPoolId, poolId))).orderBy(desc(healthEvents.createdAt)).limit(limit);
  return rows.map((row) => ({ id: row.id, networkPoolId: row.networkPoolId ?? poolId, fromStatus: row.fromStatus, toStatus: row.toStatus, reason: row.reason, errorCategory: row.errorCategory, createdAt: row.createdAt.toISOString() }));
}

/** Pools one recovery pass brings back; a larger backlog drains over successive ticks. */
const POOL_COOLDOWN_RECOVERY_BATCH = 500;

/** Recover expired cooling pools; operator-disabled pools are never swept. */
export async function sweepExpiredPoolCooldowns(db: CartethyiaDatabase): Promise<number> {
  const now = new Date();
  const expired = await db.select({ id: networkPools.id, tenantId: networkPools.tenantId, status: networkPools.status }).from(networkPools).where(and(inArray(networkPools.status, ["cooldown"]), isNotNull(networkPools.cooldownUntil), lte(networkPools.cooldownUntil, now))).limit(POOL_COOLDOWN_RECOVERY_BATCH);
  if (expired.length === 0) return 0;
  await db.update(networkPools).set({ status: "active", consecutiveFailures: 0, cooldownUntil: null, lastRecoveredAt: now }).where(inArray(networkPools.id, expired.map((row) => row.id)));
  await db.insert(healthEvents).values(expired.map((row) => ({ id: randomUUID(), entityKind: "pool" as const, networkPoolId: row.id, fromStatus: row.status, toStatus: "active" as const, reason: "Cooldown elapsed — auto-recovered", errorCategory: null, createdAt: now })));
  for (const row of expired) publishPoolHealth({ poolId: row.id, tenantId: row.tenantId, status: "active", consecutiveFailures: 0 });
  // The pool-level cooldown elapsed, so the same window's provider markers are
  // expired too. Drop them from the durable JSON mirror — the selector and
  // Redis prune on read, but the row's stale copy would otherwise live forever.
  await Promise.all(expired.map((row) => pruneExpiredProviderCooldownMarkers(db, row.id)));
  return expired.length;
}
