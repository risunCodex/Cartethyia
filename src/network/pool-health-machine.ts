import { randomUUID } from "node:crypto";
import { healthEventBuffer } from "../persistence/health-event-flush";
import { and, desc, eq, inArray, isNotNull, lte, sql } from "drizzle-orm";
import type { CartethyiaDatabase } from "../persistence/db-handle";
import { healthEvents, networkPools } from "../persistence/schema";
import { drainPoolByteDelta } from "./pool/byte-accounting";
import { resolvePoolCooldownMs } from "../config/cooldowns";
import { dropProviderCooldownMarker, pruneExpiredProviderCooldownMarkers } from "./pool-cooldown-store";
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
