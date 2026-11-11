/**
 * The durable mirror of the pool selector's provider cooldown state.
 *
 * The selector's own map is process-local, mirrored to Redis only when Redis
 * exists — so the usual installation ran with the flags surviving just a
 * restart, while the upstream's refusal of the egress did not. The result was
 * the report that motivated this: no cooldown shown on the proxy page, and
 * still-429 requests, because dispatch re-picked a spent egress it no longer
 * remembered. `network_pools.provider_cooldowns` is that state's home between
 * boots: dispatch flaggers write each marker, boot reads them all back.
 *
 * One entry per cooling provider, keyed by the lowercased provider id — the
 * same normalization the selector applies to its in-memory key.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { CartethyiaDatabase } from "../../persistence/db-handle";
import { networkPools, healthEvents } from "../../persistence/schema";
import { log } from "../../observability/logger";
import { metrics } from "../../observability/metrics";
import { providerRateLimitIsIpScoped } from "../../providers/provider-metadata";
import { resolvePoolProviderRateLimitCooldownMs } from "../../config/cooldowns";
import { PROVIDER_BLOCK_MS, type ProxyCooldownEntry } from "./selector";

type PoolProviderCooldownMap = NonNullable<
  (typeof networkPools.$inferSelect)["providerCooldowns"]
>;

function readMarkerMap(
  db: CartethyiaDatabase,
  poolId: string,
): Promise<PoolProviderCooldownMap> {
  return db
    .select({ providerCooldowns: networkPools.providerCooldowns })
    .from(networkPools)
    .where(eq(networkPools.id, poolId))
    .limit(1)
    .then((rows) => rows[0]?.providerCooldowns ?? {});
}

function writeMarkerMap(
  db: CartethyiaDatabase,
  poolId: string,
  map: PoolProviderCooldownMap,
): Promise<unknown> {
  return db.update(networkPools).set({ providerCooldowns: map }).where(eq(networkPools.id, poolId));
}

function entryOf(marker: Omit<ProxyCooldownEntry, "poolId" | "providerId">): {
  until: number;
  reason: string;
  blocked?: boolean;
} {
  return marker.blocked === true
    ? { until: marker.until, reason: marker.reason, blocked: true }
    : { until: marker.until, reason: marker.reason };
}

/**
 * Writes up (or replaces) one provider's marker on the pool row.
 *
 * Fill-in, not replace: an entry for another cooling provider must survive.
 * Failures are logged and swallowed — the in-memory/Redis state stays
 * conservative for the running process, and only the *next* restart would miss
 * a flag this write failed to land.
 */
export async function upsertProviderCooldownMarker(
  db: CartethyiaDatabase,
  poolId: string,
  providerId: string,
  marker: { until: number; reason: string; blocked?: boolean },
): Promise<void> {
  try {
    const key = providerId.toLowerCase();
    const map = await readMarkerMap(db, poolId);
    map[key] = entryOf(marker);
    await writeMarkerMap(db, poolId, map);
  } catch (error) {
    log.warn("pool provider cooldown mirror write failed", { networkPoolId: poolId, providerId, error: String(error) });
  }
}

/**
 * Removes one provider's marker, optionally only when it is a *block*.
 *
 * `onlyBlocked` mirrors `clearProviderBlockedOnly`: a probe that answered 429
 * may correct a retired claim but must not release a live cooldown, and the
 * same rule applies to the durable copy.
 */
export async function dropProviderCooldownMarker(
  db: CartethyiaDatabase,
  poolId: string,
  providerId: string,
  onlyBlocked = false,
): Promise<void> {
  try {
    const key = providerId.toLowerCase();
    const map = await readMarkerMap(db, poolId);
    const current = map[key];
    if (current === undefined) return;
    if (onlyBlocked && current.blocked !== true) return;
    delete map[key];
    await writeMarkerMap(db, poolId, map);
  } catch (error) {
    log.warn("pool provider cooldown mirror clear failed", { networkPoolId: poolId, providerId, error: String(error) });
  }
}

/**
 * Removes every provider's marker from one pool row (disable/replace paths).
 */
export async function dropAllProviderCooldownMarkers(
  db: CartethyiaDatabase,
  poolId: string,
): Promise<void> {
  try {
    const map = await readMarkerMap(db, poolId);
    if (Object.keys(map).length === 0) return;
    await writeMarkerMap(db, poolId, {});
  } catch (error) {
    log.warn("pool provider cooldown mirror purge failed", { networkPoolId: poolId, error: String(error) });
  }
}

/**
 * Removes expired provider markers from one pool row, keeping live cooldowns
 * and permanent blocks intact. Returns how many markers were dropped.
 *
 * The selector and Redis prune expired entries on read, but the durable JSON
 * mirror is only ever written, never swept — so a marker that expired while
 * the process was down survives on the row forever. Harmless to routing (boot
 * restores only future-dated markers), but it bloats the row and makes the
 * backup/restore surface carry dead state.
 */
export async function pruneExpiredProviderCooldownMarkers(
  db: CartethyiaDatabase,
  poolId: string,
): Promise<number> {
  try {
    const map = await readMarkerMap(db, poolId);
    const now = Date.now();
    const expiredKeys: string[] = [];
    for (const [providerKey, marker] of Object.entries(map)) {
      if (marker.until <= now) expiredKeys.push(providerKey);
    }
    if (expiredKeys.length === 0) return 0;
    for (const providerKey of expiredKeys) delete map[providerKey];
    await writeMarkerMap(db, poolId, map);
    return expiredKeys.length;
  } catch (error) {
    log.warn("pool provider cooldown mirror prune failed", { networkPoolId: poolId, error: String(error) });
    return 0;
  }
}

/** Max simultaneously tracked (pool, provider) coalescing keys. */
const MAX_TRACKED_PAIRS = 5_000;

/** Last coalesced row timestamp per (pool, provider), for the cooldown window only. */
const lastRecordedByPoolProvider = new Map<string, number>();

/**
 * Appends one provider-scoped egress verdict row to `health_events` — the
 * durable audit log the console's pool page reads.
 *
 * Shared by the three writers of this row shape: the dispatch-side 429
 * recorder (`recordPoolCooldownEvent`), the egress-block recorder
 * (`recordPoolBlockEvent`), and the probe verdict recorder
 * (`recordProbeVerdict`). The row is always `entityKind: "pool"`,
 * `fromStatus: null`, `toStatus: "cooldown"`, and the category is chosen by
 * `blocked`; the only divergences are the optional code suffix (block path)
 * and the optional coalescing window (cooldown path).
 *
 * Coalescing: `coalesceWindowMs` suppresses a duplicate row for the same
 * (pool, provider) pair within the window — used by the cooldown path, where
 * dispatch flags the same pair on every throttled request and the audit log
 * needs one row per episode, not one per request. The default `undefined`
 * means no coalescing, so block and probe rows are never deduped; it also
 * means the pair never enters the tracking map, so the eviction sweep below
 * only ever sees coalesced pairs. A failed insert does not stamp the pair, so
 * the next attempt within the window is still tried.
 *
 * Swallow contract: this never throws to dispatch (observability writes are
 * non-fatal); failures bump `pool_cooldown_record_failed` and are logged.
 */
export async function appendPoolProviderEgressAuditRow(
  db: CartethyiaDatabase,
  opts: {
    poolId: string;
    providerId: string;
    reason: string;
    blocked: boolean;
    codeSuffix?: string;
    coalesceWindowMs?: number;
  },
): Promise<void> {
  const { poolId, providerId, reason, blocked, codeSuffix, coalesceWindowMs } = opts;
  let key: string | undefined;
  let now = 0;
  if (coalesceWindowMs !== undefined) {
    key = `${poolId}::${providerId.toLowerCase()}`;
    now = Date.now();
    const last = lastRecordedByPoolProvider.get(key);
    if (last !== undefined && now - last < coalesceWindowMs) return;
  }
  try {
    await db.insert(healthEvents).values({
      id: randomUUID(),
      entityKind: "pool",
      networkPoolId: poolId,
      fromStatus: null,
      toStatus: "cooldown",
      reason: `provider ${providerId}: ${reason}${codeSuffix ?? ""}`,
      errorCategory: blocked ? "egress_blocked" : "rate_limit_transient",
      createdAt: new Date(),
    });
  } catch (error) {
    metrics.pool_cooldown_record_failed.inc(1);
    log.warn("pool provider egress audit row failed", {
      networkPoolId: poolId,
      providerId,
      error: String(error),
    });
    return;
  }
  if (key !== undefined && coalesceWindowMs !== undefined) {
    lastRecordedByPoolProvider.set(key, now);
    if (lastRecordedByPoolProvider.size > MAX_TRACKED_PAIRS) {
      for (const [trackedKey, recordedAt] of lastRecordedByPoolProvider) {
        if (now - recordedAt >= coalesceWindowMs) {
          lastRecordedByPoolProvider.delete(trackedKey);
        }
      }
    }
  }
}

/**
 * Writes a probe-measured verdict the same way a dispatch-side event would be
 * recorded: one mirror marker and one audit row.
 *
 * The probe is the only writer that can flag a cooldown from the control
 * plane — its 429 is a fresh measurement of "this egress is out of allowance"
 * (a cooldown marker), and its 403 is a fresh measurement of "this egress was
 * retired" (a block marker). Without this, an operator who tested a
 * rate-limited or retired pool saw the verdict once, refreshing lost it, and
 * the activity panel showed nothing: the fact existed only in the remembered
 * HTTP response.
 *
 * Not coalesced: a probe is operator-initiated and one row per click is the
 * visible history the panel exists for.
 */
export async function recordProbeVerdict(
  db: CartethyiaDatabase,
  poolId: string,
  providerId: string,
  marker: { until: number; reason: string; blocked?: boolean },
): Promise<void> {
  await upsertProviderCooldownMarker(db, poolId, providerId, marker);
  await appendPoolProviderEgressAuditRow(db, {
    poolId,
    providerId,
    reason: marker.reason,
    blocked: marker.blocked === true,
  });
}

/**
 * Reads every live marker back into the selector at boot.
 *
 * Only future-dated entries are restored: an expired marker describes an
 * allowance that refilled while the process was down, and resurrecting it
 * would sideline a working address. Repeat 429s re-insert markers, so nothing
 * is lost by dropping the expired ones.
 */
export async function restoreProviderCooldownMarkers(
  selector: { hydrateProviderCooldown(entry: ProxyCooldownEntry): void },
  db: CartethyiaDatabase,
): Promise<number> {
  const rows = await db
    .select({ id: networkPools.id, providerCooldowns: networkPools.providerCooldowns })
    .from(networkPools);
  let restored = 0;
  for (const row of rows) {
    const map = row.providerCooldowns;
    if (map === null || map === undefined) continue;
    for (const [providerId, marker] of Object.entries(map)) {
      if (Date.now() >= marker.until) continue;
      selector.hydrateProviderCooldown({
        poolId: row.id,
        providerId,
        until: marker.until,
        reason: marker.reason,
        ...(marker.blocked === true ? { blocked: true } : {}),
      });
      restored += 1;
    }
  }
  return restored;
}

/** The columns the probe-verdict reconciliation reads, mirroring the row's own read path. */
function probeEndpointOf(endpointConfig: unknown): string {
  const raw = (endpointConfig ?? {}) as Record<string, unknown>;
  return typeof raw["endpoint"] === "string" ? raw["endpoint"] : "";
}

/**
 * Re-enforces the stored probe verdicts at boot (new: replay, read-ahead).
 *
 * A stored verdict is a *state*, not a decoration. If the marker the probe
 * flagged failed to persist, or the verdict predated the marker column, the
 * egress would return to rotation after restart and get refused again — dispatch
 * spending a real request to rediscover a refusal the row already knew. So the
 * boot read reconciles:
 *
 * - A fresh `blocked` verdict for an address-keyed provider becomes a block
 *   flag, even when the mirror has nothing (or has an older, cooler entry — the
 *   retirement claim is the sharper fact and wins).
 * - A fresh `throttled` verdict for an address-keyed provider becomes the same
 *   cooldown a dispatch-side 429 would have written. The probe measured the
 *   rate-limit window itself (`provider_probe_at` is when it observed the 429),
 *   so the replayed window starts at that measurement, not at boot — without
 *   the monotonic clock, a restart mid-window would shorten the cool-off the
 *   probe proved. The configured default window is applied when the probe did
 *   not record a duration.
 *
 * Returns how many verdicts were replayed.
 */
export async function restorePoolProbeVerdicts(
  selector: { hydrateProviderCooldown(entry: ProxyCooldownEntry): void },
  db: CartethyiaDatabase,
): Promise<number> {
  const probeCooldownMs = resolvePoolProviderRateLimitCooldownMs();
  const rows = await db
    .select({
      id: networkPools.id,
      status: networkPools.status,
      endpointConfig: networkPools.endpointConfig,
      providerProbeProviderId: networkPools.providerProbeProviderId,
      providerProbeStatus: networkPools.providerProbeStatus,
      providerProbeReason: networkPools.providerProbeReason,
      providerProbeEndpoint: networkPools.providerProbeEndpoint,
      providerProbeAt: networkPools.providerProbeAt,
    })
    .from(networkPools);
  let replayed = 0;
  for (const row of rows) {
    if (row.status !== "active") continue;
    if (row.providerProbeStatus !== "blocked" && row.providerProbeStatus !== "throttled") continue;
    if (row.providerProbeEndpoint !== probeEndpointOf(row.endpointConfig)) continue;
    const providerId = row.providerProbeProviderId;
    if (typeof providerId !== "string" || !providerRateLimitIsIpScoped(providerId)) continue;
    if (row.providerProbeStatus === "blocked") {
      selector.hydrateProviderCooldown({
        poolId: row.id,
        providerId: providerId.toLowerCase(),
        until: Date.now() + PROVIDER_BLOCK_MS,
        reason: row.providerProbeReason ?? "Upstream refused this egress address",
        blocked: true,
      });
      replayed += 1;
      continue;
    }
    // `throttled`: replay the cooldown the probe measured. The upstream's
    // window began when the probe saw the 429, so the marker expires at
    // `probeAt + window`, unless that is already past — an allowance that
    // refilled while the process was down must not be resurrected.
    const probeAt = row.providerProbeAt?.getTime();
    const until =
      probeAt !== undefined ? probeAt + probeCooldownMs : Date.now() + probeCooldownMs;
    if (until <= Date.now()) continue;
    selector.hydrateProviderCooldown({
      poolId: row.id,
      providerId: providerId.toLowerCase(),
      until,
      reason: row.providerProbeReason ?? "Operator probe measured a provider 429",
    });
    replayed += 1;
  }
  return replayed;
}
