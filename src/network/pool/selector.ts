/**
 * `NetworkPoolSelector` — distributed pool admission: weighted, cooldown-aware
 * selection plus inflight accounting (local map + Redis counters for
 * multi-process correctness).
 *
 * Role files: `pool-scripts.ts` (Redis scripts + key builders),
 * `pool-state.ts` (local inflight/rotation/cooldown state). This file keeps
 * the selection algorithm and the `NetworkPoolSelector` public surface.
 */
import { redisEvalNumber, type RedisClient } from "../../persistence/redis";
import { resolveInflightTtlSeconds } from "../../config/timeouts";
import { log } from "../../observability/logger";
import { providerRateLimitIsIpScoped } from "../../providers/provider-metadata";
import {
  COOLDOWN_CLEAR_SCRIPT,
  COOLDOWN_FLAG_SCRIPT,
  POOL_ADMIT_SCRIPT,
  POOL_PROVIDER_ADMIT_SCRIPT,
  POOL_PROVIDER_RELEASE_SCRIPT,
  POOL_RELEASE_SCRIPT,
  proxyCooldownKey,
  proxyCooldownProvidersKey,
  proxyInflightKey,
  proxyProviderInflightKey,
} from "./pool-scripts";
import {
  advanceRotation,
  createPoolLocalState,
  enforceCooldownLimit,
  enforceInflightLimit,
  parseCooldownEntry,
  rotationStart,
  type PoolLocalState,
  type PoolRotation,
  type PoolUsageSnapshot,
  type ProxyCooldownEntry,
} from "./pool-state";

export type { PoolRotation, ProxyCooldownEntry };

// Pool selector
/**
 * How long a flagged egress stays out of rotation.
 *
 * This is not a cooldown: a free-tier refusal means the upstream has retired
 * the address, and the only thing that clears it is the operator replacing the
 * proxy. Ten years is "until someone intervenes" — long enough that no request
 * spends itself rediscovering the refusal, short enough to stay a bounded
 * timestamp instead of a nullable flag every reader would have to branch on.
 */
export const PROVIDER_BLOCK_MS = 10 * 365 * 24 * 60 * 60 * 1000;

const DEFAULT_PROXY_CONCURRENCY = 10;
const DEFAULT_PROXY_WEIGHT = 100;
const MAX_PROXY_WEIGHT = 1000;
// Crash-recovery bound, not a lease duration: normal releases DECR/DEL the
// key immediately, so the TTL only matters when a holder dies mid-request.
// Derived by `resolveInflightTtlSeconds` from the same resolvers the dispatch
// path uses, so raising either timeout keeps the invariant — and so this
// selector and the routing admission controller expire their slots on the same
// bound, since both hold one for the same request duration.
function poolInflightTtlSeconds(): number {
  return resolveInflightTtlSeconds();
}
function effectiveConcurrency(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1) return 0;
  return limit;
}

/**
 * In-place Fisher–Yates shuffle. The `random` pool strategy uses it to scatter
 * each selection across the eligible pools instead of always scanning from a
 * fixed (or cursor-driven) order, so a burst does not clump onto the first
 * pool and burn it while siblings sit idle.
 */
function shuffleArray<T>(items: T[]): void {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const swap = items[i]!;
    items[i] = items[j]!;
    items[j] = swap;
  }
}

function normalizedWeight(weight: number | undefined): number {
  if (weight === undefined) return DEFAULT_PROXY_WEIGHT;
  if (!Number.isInteger(weight) || weight < 1 || weight > MAX_PROXY_WEIGHT) return 0;
  return weight;
}

/** Local-map key for a provider's share of a pool. NUL cannot appear in either id. */
function providerInflightStateKey(poolId: string, providerId: string): string {
  return `${poolId}\u0000${providerId.toLowerCase()}`;
}

function decrementLocal(counter: Map<string, number>, key: string): void {
  const value = counter.get(key) ?? 1;
  if (value <= 1) counter.delete(key);
  else counter.set(key, value - 1);
}

type PoolSelectionFailureReason =
  | "at_capacity"
  | "provider_at_capacity"
  | "cooldown"
  /** Every eligible pool was retired by the upstream for this provider. */
  | "blocked"
  | "coordination_unavailable"
  | "no_active_pool";

interface PoolCooldownState {
  readonly inCooldown: boolean;
  readonly resetsAt: Date | null;
  readonly reason: string | null;
  readonly blocked: boolean;
}

interface PoolCapacitySnapshot {
  readonly poolId: string;
  readonly maxInflight: number;
  readonly currentInflight: number;
  readonly available: number;
  readonly weight: number;
  readonly retryAt?: number;
  /** This provider's ceiling on this pool, when one is configured. */
  readonly providerMaxInflight?: number;
  /** This provider's current share of this pool, when a ceiling is configured. */
  readonly providerInflight?: number;
  /** True when the upstream refused this egress for this provider outright,
   * as opposed to throttling it for a window. */
  readonly blocked?: boolean;
}

export interface PoolSelectionFailure {
  readonly reason: PoolSelectionFailureReason;
  readonly pools: readonly PoolCapacitySnapshot[];
  readonly retryAt?: number;
}

export class NetworkPoolSelector {
  private readonly state: PoolLocalState = createPoolLocalState();

  constructor(private readonly redis?: RedisClient) {}

  getInflight(poolId: string): number {
    return this.state.inflight.get(poolId) ?? 0;
  }

  /**
   * Live usage across every locally tracked pool: one `{poolId, inflight}`
   * row per pool the selector has admitted since boot. Zero-count pools drop
   * out of the map on release, so an idle pool reads as absent (i.e. zero)
   * rather than as a stale row. Process-local like `getInflight` — the Usage
   * page's pool card renders its own instance's view.
   */
  snapshotPoolUsage(): readonly PoolUsageSnapshot[] {
    const out: PoolUsageSnapshot[] = [];
    for (const [poolId, currentInflight] of this.state.inflight) {
      out.push({ poolId, currentInflight });
    }
    return out;
  }

  private readonly poolUsageListeners = new Set<(usage: readonly PoolUsageSnapshot[]) => void>();

  /**
   * Push-on-change subscription for pool usage, mirroring the in-flight
   * request counter's pub/sub. Emitted on every acquire/release so an SSE
   * stream can forward only real transitions instead of polling.
   */
  subscribePoolUsage(listener: (usage: readonly PoolUsageSnapshot[]) => void): () => void {
    this.poolUsageListeners.add(listener);
    return () => {
      this.poolUsageListeners.delete(listener);
    };
  }

  private notifyPoolUsage(): void {
    if (this.poolUsageListeners.size === 0) return;
    const snapshot = this.snapshotPoolUsage();
    for (const listener of this.poolUsageListeners) listener(snapshot);
  }

  async getInflightAuthoritative(poolId: string): Promise<number> {
    if (!this.redis) return this.getInflight(poolId);
    const raw = await this.redis.get(proxyInflightKey(poolId));
    if (raw === null) return 0;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`invalid pool inflight counter: ${poolId}`);
    }
    return value;
  }

  /**
   * This provider's inflight share of one pool. Zero when the provider has no
   * ceiling configured, because nothing ever records a count for it.
   */
  getProviderInflight(poolId: string, providerId: string): number {
    return this.state.providerInflight.get(providerInflightStateKey(poolId, providerId)) ?? 0;
  }

  async getProviderInflightAuthoritative(poolId: string, providerId: string): Promise<number> {
    if (!this.redis) return this.getProviderInflight(poolId, providerId);
    const raw = await this.redis.get(proxyProviderInflightKey(poolId, providerId));
    if (raw === null) return 0;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`invalid provider inflight counter: ${poolId}/${providerId}`);
    }
    return value;
  }

  /**
   * One local slot acquisition: checks every map's ceiling, bumps each counter,
   * and returns a release that decrements all of them exactly once. Shared by
   * `acquire` (single pool counter) and `acquireProvider` (pool + provider
   * share) so the release closure and the local bookkeeping live in one place.
   */
  private acquireLocalSlot(
    increments: ReadonlyArray<{
      readonly map: Map<string, number>;
      readonly key: string;
      readonly capacity: number;
    }>,
  ): { acquired: boolean; release: () => void } {
    for (const increment of increments) {
      const current = increment.map.get(increment.key) ?? 0;
      if (current >= increment.capacity) return { acquired: false, release: () => {} };
    }
    for (const increment of increments) {
      enforceInflightLimit(increment.map);
      increment.map.set(increment.key, (increment.map.get(increment.key) ?? 0) + 1);
    }
    this.notifyPoolUsage();

    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      for (const increment of increments) decrementLocal(increment.map, increment.key);
      this.notifyPoolUsage();
    };
    return { acquired: true, release };
  }

  /**
   * Raise this provider's share of a pool, enforcing both the pool ceiling and
   * the provider ceiling. The pool half is still checked here so a caller that
   * already admitted the pool through `acquire` does not double-count it — use
   * this instead of `acquire` whenever a provider ceiling applies.
   */
  acquireProvider(
    poolId: string,
    providerId: string,
    poolCapacity: number,
    providerCapacity: number,
  ): { acquired: boolean; release: () => void } {
    return this.acquireLocalSlot([
      { map: this.state.inflight, key: poolId, capacity: poolCapacity },
      {
        map: this.state.providerInflight,
        key: providerInflightStateKey(poolId, providerId),
        capacity: providerCapacity,
      },
    ]);
  }

  acquire(
    poolId: string,
    maxInflight = DEFAULT_PROXY_CONCURRENCY,
  ): { acquired: boolean; release: () => void } {
    return this.acquireLocalSlot([
      { map: this.state.inflight, key: poolId, capacity: maxInflight },
    ]);
  }

  private cooldownKey(poolId: string, providerId: string): string {
    return `${poolId}::${providerId.toLowerCase()}`;
  }

  /**
   * Seeds one cooldown entry into the local map without touching Redis.
   *
   * Boot restore is the only writer: it replays the durable markers the
   * previous process recorded (`network_pools.provider_cooldowns`, see
   * `pool-cooldown-store.ts`) so dispatch starts remembering the egresses the
   * upstream is still refusing. Anything whose window already passed is
   * dropped by `restore…` before this is reached.
   */
  hydrateProviderCooldown(entry: ProxyCooldownEntry): void {
    enforceCooldownLimit(this.state.cooldowns);
    this.state.cooldowns.set(this.cooldownKey(entry.poolId, entry.providerId), entry);
  }

  async flagProviderCooldown(
    poolId: string,
    providerId: string,
    durationMs: number = 15 * 60 * 1000,
    reason = "Rate limited by upstream provider (429)",
  ): Promise<ProxyCooldownEntry> {
    const until = Date.now() + durationMs;
    const entry: ProxyCooldownEntry = {
      poolId,
      providerId: providerId.toLowerCase(),
      until,
      reason: reason.slice(0, 200),
    };
    enforceCooldownLimit(this.state.cooldowns);
    this.state.cooldowns.set(this.cooldownKey(poolId, providerId), entry);
    if (this.redis) {
      try {
        const ttlSec = Math.max(1, Math.ceil(durationMs / 1000));
        // One script, not `SET` then `SADD`: a crash between the two left the
        // marker unindexed (invisible to the pool listing) or the index
        // pointing at a marker that expired. The script also arms the index
        // set's own TTL, which must be armed or the index grows without bound.
        await redisEvalNumber(
          this.redis,
          COOLDOWN_FLAG_SCRIPT,
          2,
          proxyCooldownKey(poolId, providerId),
          proxyCooldownProvidersKey(poolId),
          JSON.stringify(entry),
          ttlSec,
          entry.providerId,
        );
      } catch {
        // The local entry remains conservative for this process.
      }
    }
    return entry;
  }

  /**
   * Retires an egress permanently for one provider.
   *
   * A free-tier refusal means the upstream flagged this address, and the
   * request was never read — so the address stays flagged for as long as the
   * upstream remembers it. A timed cooldown would put it back into rotation and
   * spend a real request discovering it is still refused, which is why this is
   * a far-future `until` rather than a short window.
   *
   * The entry uses the same storage as a cooldown so every reader that already
   * skips a cooling pool skips this one too; `reason` is what the console
   * renders to tell an operator-blocked proxy from a throttled one.
   *
   * Refuses to retire an egress for a provider whose limits belong to a
   * credential. An address-scoped verdict only exists for providers that count
   * requests by egress (`ipScopedRateLimit` — opencode); for everyone else a
   * refusal belongs to the account that was dialed, so retiring the pool would
   * sideline an address that is still serving every sibling account. Callers
   * keep their own guard, and this one is the backstop that makes the rule
   * impossible to route around from a new call site.
   */
  async flagProviderBlocked(
    poolId: string,
    providerId: string,
    reason = "Upstream refused this egress address",
  ): Promise<ProxyCooldownEntry> {
    if (!providerRateLimitIsIpScoped(providerId)) {
      log.warn("[pool-selector] refused to block an egress for a non-IP-scoped provider", {
        networkPoolId: poolId,
        providerId,
      });
      return {
        poolId,
        providerId: providerId.toLowerCase(),
        until: Date.now(),
        reason,
      };
    }
    const entry = await this.flagProviderCooldown(poolId, providerId, PROVIDER_BLOCK_MS, reason);
    const blocked: ProxyCooldownEntry = { ...entry, blocked: true };
    // Rewrite both copies with the flag: the cooldown write above is shared
    // with the 429 path, so the marker has to be re-stamped rather than
    // threaded through a second parameter that only this caller sets.
    this.state.cooldowns.set(this.cooldownKey(poolId, providerId), blocked);
    if (this.redis) {
      try {
        await redisEvalNumber(
          this.redis,
          COOLDOWN_FLAG_SCRIPT,
          2,
          proxyCooldownKey(poolId, providerId),
          proxyCooldownProvidersKey(poolId),
          JSON.stringify(blocked),
          Math.max(1, Math.ceil(PROVIDER_BLOCK_MS / 1000)),
          blocked.providerId,
        );
      } catch {
        // The local entry stays authoritative for this process.
      }
    }
    return blocked;
  }

  /**
   * Whether this pool is out of rotation for this provider, and why.
   *
   * `blocked` separates the two facts the caller must not conflate: a 429 is a
   * window that ends, while a free-tier refusal retires the address for good.
   * The rejection message says which one the operator is looking at, because
   * the fix differs — wait, or replace the proxy.
   */
  async isProviderCooldown(
    poolId: string,
    providerId: string,
  ): Promise<PoolCooldownState> {
    const k = this.cooldownKey(poolId, providerId);
    const local = this.state.cooldowns.get(k);
    if (local) {
      if (Date.now() < local.until) {
        return {
          inCooldown: true,
          resetsAt: new Date(local.until),
          reason: local.reason,
          blocked: local.blocked === true,
        };
      }
      this.state.cooldowns.delete(k);
    }
    if (this.redis) {
      try {
        const raw = await this.redis.get(proxyCooldownKey(poolId, providerId));
        const parsed = raw ? parseCooldownEntry(raw) : undefined;
        if (parsed && Date.now() < parsed.until) {
          enforceCooldownLimit(this.state.cooldowns);
          this.state.cooldowns.set(k, parsed);
          return {
            inCooldown: true,
            resetsAt: new Date(parsed.until),
            reason: parsed.reason,
            blocked: parsed.blocked === true,
          };
        }
        if (raw) {
          await this.clearRedisCooldown(poolId, providerId);
        }
      } catch {
        return {
          inCooldown: true,
          resetsAt: null,
          reason: "cooldown store unavailable",
          blocked: false,
        };
      }
    }
    return { inCooldown: false, resetsAt: null, reason: null, blocked: false };
  }

  async getPoolCooldowns(poolId: string): Promise<readonly ProxyCooldownEntry[]> {
    const now = Date.now();
    const active = new Map<string, ProxyCooldownEntry>();

    for (const [key, entry] of this.state.cooldowns.entries()) {
      if (entry.poolId !== poolId) continue;
      if (now < entry.until) active.set(entry.providerId, entry);
      else this.state.cooldowns.delete(key);
    }

    if (this.redis) {
      const providerIds = await this.redis.smembers(proxyCooldownProvidersKey(poolId));
      // A pool with no cooling providers — the common case, and every pool when
      // nothing is throttled — lists no members. `MGET` requires at least one
      // key, so calling it with an empty spread makes Redis reject the command
      // and the whole pool read fail; a healthy pool must report zero cooldowns,
      // not an error. The loop below is a no-op for an empty list, so returning
      // early is the same result without the round trip.
      if (providerIds.length === 0) return [...active.values()];
      // One MGET for every listed member instead of a GET per member: this is
      // the pool overview's hot read, so a serial scan made its latency scale
      // with the pool's provider count.
      const raws = (await this.redis.mget(
        ...providerIds.map((providerId) => proxyCooldownKey(poolId, providerId)),
      )) as Array<string | null>;
      const staleMarkerKeys: string[] = [];
      const staleMembers: string[] = [];
      for (let index = 0; index < providerIds.length; index += 1) {
        const providerId = providerIds[index];
        if (providerId === undefined) continue;
        const raw = raws[index] ?? null;
        const entry = raw ? parseCooldownEntry(raw) : undefined;
        if (!entry) {
          if (raw) staleMarkerKeys.push(proxyCooldownKey(poolId, providerId));
          staleMembers.push(providerId);
          continue;
        }
        if (entry.poolId === poolId && now < entry.until) active.set(entry.providerId, entry);
        else staleMembers.push(providerId);
      }
      // One batched cleanup instead of serial del/srem per stale member.
      await Promise.all([
        ...(staleMarkerKeys.length > 0 ? [this.redis.del(...staleMarkerKeys)] : []),
        ...(staleMembers.length > 0
          ? staleMembers.map((member) => this.redis!.srem(proxyCooldownProvidersKey(poolId), member))
          : []),
      ]);
    }

    return [...active.values()];
  }
  async clearProviderCooldown(poolId: string, providerId: string): Promise<void> {
    this.state.cooldowns.delete(this.cooldownKey(poolId, providerId));
    if (!this.redis) return;
    await this.clearRedisCooldown(poolId, providerId);
  }

  /**
   * Releases a *retired* egress only, leaving a cooldown intact.
   *
   * The two are one key, so `clearProviderCooldown` cannot be reused: it would
   * also drop a live 429 cooldown and hand a spent address back to dispatch.
   * This is the correction a 429 probe is entitled to make — the address is
   * answering its own rate limiter, so it was never retired — and nothing more.
   *
   * No-op when the marker is a cooldown, and no-op when there is no marker.
   */
  async clearProviderBlockedOnly(poolId: string, providerId: string): Promise<void> {
    const key = this.cooldownKey(poolId, providerId);
    const local = this.state.cooldowns.get(key);
    if (local !== undefined) {
      if (local.blocked !== true) return;
      this.state.cooldowns.delete(key);
    }
    if (!this.redis) return;
    try {
      const raw = await this.redis.get(proxyCooldownKey(poolId, providerId));
      const entry = raw ? parseCooldownEntry(raw) : undefined;
      // A missing or unparseable marker says nothing about the address, and
      // deleting a key we cannot read would drop a cooldown this is forbidden
      // from touching. Only a marker that names itself a block is released.
      if (entry?.blocked !== true) return;
      await this.clearRedisCooldown(poolId, providerId);
    } catch {
      // The local copy is already corrected; the Redis mirror stays until its
      // TTL or the next write.
    }
  }

  /**
   * Removes one cooldown marker and its index entry in one atomic step.
   *
   * The two writes must not be separate `DEL` + `SREM`: a crash between them
   * would leave the index listing a provider whose marker is gone — a pool
   * would report a cooldown that no longer applies until the index entry
   * expires.
   */
  private async clearRedisCooldown(poolId: string, providerId: string): Promise<void> {
    if (!this.redis) return;
    await redisEvalNumber(
      this.redis,
      COOLDOWN_CLEAR_SCRIPT,
      2,
      proxyCooldownKey(poolId, providerId),
      proxyCooldownProvidersKey(poolId),
      providerId.toLowerCase(),
    );
  }

  /**
   * Drops every cooldown this pool holds, marker and index together.
   *
   * Called when a pool is deleted: without it the index set and its markers
   * outlive the pool row, so a later pool reusing the id inherits cooldowns it
   * never earned.
   */
  async clearPoolCooldowns(poolId: string): Promise<void> {
    for (const key of [...this.state.cooldowns.keys()]) {
      if (key.startsWith(`${poolId}::`)) this.state.cooldowns.delete(key);
    }
    if (!this.redis) return;
    const indexKey = proxyCooldownProvidersKey(poolId);
    const providerIds = await this.redis.smembers(indexKey);
    for (const providerId of providerIds) {
      await this.redis.del(proxyCooldownKey(poolId, providerId));
    }
    await this.redis.del(indexKey);
  }

  /**
   * Tries one local candidate: bump the local counters (pool, and provider
   * share when a ceiling is set) and return its release. `undefined` when the
   * candidate is full or the provider share is exhausted.
   */
  private localAcquire(
    candidate: { readonly poolId: string; readonly capacity: number },
    providerId: string,
    providerCapacity: number | undefined,
  ): { poolId: string; release: () => void } | undefined {
    const slot =
      providerCapacity === undefined
        ? this.acquire(candidate.poolId, candidate.capacity)
        : this.acquireProvider(candidate.poolId, providerId, candidate.capacity, providerCapacity);
    return slot.acquired ? { poolId: candidate.poolId, release: slot.release } : undefined;
  }

  /**
   * One atomic Redis admit (the compare-and-increment script) for a candidate:
   * bumps both the remote and local counters on success and returns a release
   * that decrements both. `undefined` when the pool or provider share is full
   * (1 admitted; 0 pool full; 2 provider full — either full result fails over
   * to the next pool, which is the whole point of the ceiling).
   */
  private async redisAdmit(
    redis: RedisClient,
    candidate: { readonly poolId: string; readonly capacity: number },
    providerId: string,
    providerCapacity: number | undefined,
  ): Promise<{ poolId: string; release: () => void } | undefined> {
    const providerKey =
      providerCapacity === undefined
        ? undefined
        : proxyProviderInflightKey(candidate.poolId, providerId);
    const result =
      providerKey === undefined
        ? await redisEvalNumber(
            redis,
            POOL_ADMIT_SCRIPT,
            1,
            proxyInflightKey(candidate.poolId),
            String(candidate.capacity),
            String(poolInflightTtlSeconds()),
          )
        : await redisEvalNumber(
            redis,
            POOL_PROVIDER_ADMIT_SCRIPT,
            2,
            proxyInflightKey(candidate.poolId),
            providerKey,
            String(candidate.capacity),
            String(providerCapacity),
            String(poolInflightTtlSeconds()),
          );
    if (result !== 1) return undefined;
    enforceInflightLimit(this.state.inflight);
    this.state.inflight.set(candidate.poolId, this.getInflight(candidate.poolId) + 1);
    if (providerKey !== undefined) {
      enforceInflightLimit(this.state.providerInflight);
      const localProviderKey = providerInflightStateKey(candidate.poolId, providerId);
      this.state.providerInflight.set(
        localProviderKey,
        this.getProviderInflight(candidate.poolId, providerId) + 1,
      );
    }
    this.notifyPoolUsage();
    let released = false;
    return {
      poolId: candidate.poolId,
      release: () => {
        if (released) return;
        released = true;
        decrementLocal(this.state.inflight, candidate.poolId);
        if (providerKey !== undefined) {
          decrementLocal(
            this.state.providerInflight,
            providerInflightStateKey(candidate.poolId, providerId),
          );
        }
        this.notifyPoolUsage();
        const script = providerKey === undefined ? POOL_RELEASE_SCRIPT : POOL_PROVIDER_RELEASE_SCRIPT;
        const keys =
          providerKey === undefined
            ? [proxyInflightKey(candidate.poolId)]
            : [proxyInflightKey(candidate.poolId), providerKey];
        void redisEvalNumber(redis, script, keys.length, ...keys).catch((error: unknown) => {
          log.error("[pool-selector] failed to release distributed slot", error as Error);
        });
      },
    };
  }

  /**
   * Distributed pool admission — the selection algorithm:
   *
   * 1. Eligibility: a pool is skipped while it (or any pool) has an active
   *    provider cooldown (429 from upstream), a non-positive capacity
   *    (`effectiveConcurrency`), or a non-positive weight.
   * 2. Weighted least-loaded scoring: each eligible pool is scored by
   *    `inflight / (capacity × weight)`, so heavy pools carry proportionally
   *    more traffic and a higher `weight` makes a pool proportionally more
   *    attractive. Inflight comes from the local map in single-process mode
   *    or the authoritative Redis counter when coordinated.
   * 3. Fair tie-breaking: a rotating `fairnessCursor` staggers the scan order
   *    so equal-scoring pools are filled round-robin instead of always
   *    favoring the first candidate.
   * 4. Atomic acquisition: with Redis, each candidate is tried in scored
   *    order via the `POOL_ADMIT_SCRIPT` compare-and-increment, so two
   *    processes cannot both grab the last slot. The returned `release()`
   *    decrements both the local map and the Redis counter (fire-and-forget:
   *    a failed release is logged; the 480s TTL bounds crash leakage).
   *
   * Returns `undefined` when every pool is cooling, at capacity, or
   * uncoordinated — callers convert that into a `proxy_pool_unavailable` /
   * `PoolSelectionFailure` response rather than falling back to direct
   * egress.
   *
   * When `rotation` is supplied, scoring is replaced by strict round-robin:
   * the tenant cursor picks the start, one pool serves `rotateCount`
   * successful admissions before the cursor advances by one, and a pool that
   * is full or cooling falls through to the next offset (failover),
   * preserving every gate above.
   */
  async tryAcquireAvailablePool(
    eligiblePoolIds: readonly string[],
    providerId: string,
    limitsByPool?: Record<string, number>,
    weightsByPool?: Record<string, number>,
    rotation?: PoolRotation,
    /**
     * This provider's per-pool ceiling. `undefined` means unlimited and keeps
     * the original single-counter path exactly: no extra key, no extra call.
     * When set, every candidate must clear it in addition to its pool capacity.
     */
    providerMaxInflight?: number,
  ): Promise<{ poolId: string; release: () => void } | undefined> {
    if (eligiblePoolIds.length === 0) return undefined;
    const providerCapacity =
      providerMaxInflight === undefined ? undefined : effectiveConcurrency(providerMaxInflight);
    // A ceiling of zero admits nothing; treat it as "no pool is eligible"
    // rather than silently ignoring the operator's choice.
    if (providerCapacity === 0) return undefined;
    const cooldownChecks = await Promise.all(
      eligiblePoolIds.map(async (poolId) => ({
        poolId,
        inCooldown: (await this.isProviderCooldown(poolId, providerId)).inCooldown,
      })),
    );
    const scored = cooldownChecks
      .filter((check) => !check.inCooldown)
      .map((check) => {
        const capacity = effectiveConcurrency(
          limitsByPool?.[check.poolId] ?? DEFAULT_PROXY_CONCURRENCY,
        );
        const weight = normalizedWeight(weightsByPool?.[check.poolId]);
        return { poolId: check.poolId, capacity, weight };
      })
      .filter((candidate) => candidate.capacity > 0 && candidate.weight > 0);
    if (scored.length === 0) return undefined;

    if (!this.redis) {
      if (rotation?.strategy === "random") {
        // Random scatter: shuffle the eligible pools and take the first one
        // with a free slot, falling through like the ordered scans do.
        shuffleArray(scored);
        for (const candidate of scored) {
          if (this.getInflight(candidate.poolId) >= candidate.capacity) continue;
          const slot = this.localAcquire(candidate, providerId, providerCapacity);
          if (slot) return slot;
        }
        return undefined;
      }
      if (rotation) {
        // Round robin: scan from the tenant cursor; a pool that is full falls
        // through to the next offset (failover). Only a successful admission
        // counts: the head pool serves `rotateCount` requests, then the
        // position advances by exactly one.
        const start = rotationStart(this.state.rotationCursors, rotation.key, scored.length);
        for (let offset = 0; offset < scored.length; offset += 1) {
          const absolute = (start + offset) % scored.length;
          const candidate = scored[absolute];
          if (!candidate) continue;
          if (this.getInflight(candidate.poolId) >= candidate.capacity) continue;
          const slot = this.localAcquire(candidate, providerId, providerCapacity);
          if (!slot) continue;
          advanceRotation(this.state.rotationCursors, rotation.key, scored.length, absolute, rotation.rotateCount);
          return slot;
        }
        return undefined;
      }
      let bestPool: (typeof scored)[number] | undefined;
      let minRatio = Number.POSITIVE_INFINITY;
      const start = this.state.fairnessCursor++ % scored.length;
      for (let offset = 0; offset < scored.length; offset += 1) {
        const candidate = scored[(start + offset) % scored.length];
        if (!candidate) continue;
        const current = this.getInflight(candidate.poolId);
        if (current >= candidate.capacity) continue;
        // A pool this provider has already filled is skipped exactly like a
        // full pool, so the scan fails over to one with headroom instead of
        // stalling on the emptiest pool that cannot serve this provider.
        if (
          providerCapacity !== undefined &&
          this.getProviderInflight(candidate.poolId, providerId) >= providerCapacity
        ) {
          continue;
        }
        const ratio = current / (candidate.capacity * candidate.weight);
        if (ratio < minRatio) {
          minRatio = ratio;
          bestPool = candidate;
        }
      }
      if (!bestPool) return undefined;
      return this.localAcquire(bestPool, providerId, providerCapacity);
    }

    const redis = this.redis;
    // One MGET for every candidate instead of a GET per candidate: the
    // per-pool script below already guarantees capacity atomically, so the
    // pre-read is only a score, but serial GETs made admission latency scale
    // with the candidate count on exactly the path that runs per request.
    const inflightKeys = scored.map((candidate) => proxyInflightKey(candidate.poolId));
    if (providerCapacity !== undefined) {
      for (const candidate of scored) {
        inflightKeys.push(proxyProviderInflightKey(candidate.poolId, providerId));
      }
    }
    const rawCounts = (await redis.mget(...inflightKeys)) as Array<string | null>;
    const withCounts = scored.map((candidate, index) => {
      const raw = rawCounts[index] ?? null;
      const count = raw === null ? 0 : Number(raw);
      if (!Number.isFinite(count) || count < 0) {
        throw new Error(`invalid pool inflight counter: ${candidate.poolId}`);
      }
      // The provider half is read in the same MGET, so scoring a
      // provider-limited pool costs no extra round trip.
      const providerRaw =
        providerCapacity === undefined ? null : (rawCounts[scored.length + index] ?? null);
      const providerCount = providerRaw === null ? 0 : Number(providerRaw);
      if (!Number.isFinite(providerCount) || providerCount < 0) {
        throw new Error(`invalid provider inflight counter: ${candidate.poolId}/${providerId}`);
      }
      return {
        ...candidate,
        count,
        providerCount,
        // A pool with no room for this provider scores as fully loaded, so the
        // least-loaded scan prefers a pool that can actually take the request.
        ratio:
          providerCapacity !== undefined && providerCount >= providerCapacity
            ? Number.POSITIVE_INFINITY
            : count / (candidate.capacity * candidate.weight),
      };
    });
    // Original (pre-sort) index = absolute rotation position and
    // deterministic tie-breaking.
    const absoluteIndex = new Map(withCounts.map((candidate, index) => [candidate.poolId, index]));
    if (rotation?.strategy === "random") {
      // Random scatter: shuffle before the admit loop, which still enforces
      // capacity and fails over to the next pool exactly like the ordered
      // scans — but the order each request tries is fresh, so a burst does
      // not gang up on the first pools in a fixed order.
      shuffleArray(withCounts);
    } else if (rotation) {
      // Round robin orders strictly by the tenant cursor; the CAS admit below
      // still enforces capacity, so a full pool falls through to the next
      // offset exactly like account failover.
      const start = rotationStart(this.state.rotationCursors, rotation.key, withCounts.length);
      withCounts.sort(
        (left, right) =>
          (((absoluteIndex.get(left.poolId) ?? 0) - start + withCounts.length) %
            withCounts.length) -
          (((absoluteIndex.get(right.poolId) ?? 0) - start + withCounts.length) %
            withCounts.length),
      );
    } else {
      const start = this.state.fairnessCursor++ % withCounts.length;
      const tieOrder = absoluteIndex;
      withCounts.sort((left, right) => {
        const ratioDifference = left.ratio - right.ratio;
        if (ratioDifference !== 0) return ratioDifference;
        const leftIndex = tieOrder.get(left.poolId) ?? 0;
        const rightIndex = tieOrder.get(right.poolId) ?? 0;
        return ((leftIndex - start + withCounts.length) % withCounts.length) -
          ((rightIndex - start + withCounts.length) % withCounts.length);
      });
    }
    for (const candidate of withCounts) {
      const admitted = await this.redisAdmit(redis, candidate, providerId, providerCapacity);
      if (admitted === undefined) continue;
      if (rotation && rotation.strategy !== "random") {
        advanceRotation(
          this.state.rotationCursors,
          rotation.key,
          withCounts.length,
          absoluteIndex.get(candidate.poolId) ?? 0,
          rotation.rotateCount,
        );
      }
      return admitted;
    }
    return undefined;
  }

  /**
   * Infight counter from a Redis `MGET` row. `null` (unset counter) is zero;
   * a malformed counter is the same hard error the per-key read raises, so a
   * corrupt key is never silently treated as 0.
   */
  private parseInflightCounter(raw: string | null, what: string): number {
    if (raw === null) return 0;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`invalid pool inflight counter: ${what}`);
    }
    return value;
  }

  /**
   * Per-pool cooldown resolution with the same semantics as
   * `isProviderCooldown`: the local cooldown map wins when it has a live
   * entry; otherwise a non-expired Redis row is admitted (bounded) and an
   * expired Redis row is cleared. Used by the batched failure path, which
   * reads all cooldown keys in one `MGET` and resolves each row here.
   */
  private cooldownFromBatchState(
    poolId: string,
    providerId: string,
    raw: string | null,
  ): PoolCooldownState {
    const k = this.cooldownKey(poolId, providerId);
    const local = this.state.cooldowns.get(k);
    if (local) {
      if (Date.now() < local.until) {
        return {
          inCooldown: true,
          resetsAt: new Date(local.until),
          reason: local.reason,
          blocked: local.blocked === true,
        };
      }
      this.state.cooldowns.delete(k);
    }
    const parsed = raw ? parseCooldownEntry(raw) : undefined;
    if (parsed && Date.now() < parsed.until) {
      enforceCooldownLimit(this.state.cooldowns);
      this.state.cooldowns.set(k, parsed);
      return {
        inCooldown: true,
        resetsAt: new Date(parsed.until),
        reason: parsed.reason,
        blocked: parsed.blocked === true,
      };
    }
    if (raw) {
      void this.clearRedisCooldown(poolId, providerId);
    }
    return { inCooldown: false, resetsAt: null, reason: null, blocked: false };
  }

  /**
   * The original per-pool failure check: one Redis read per pool for each of
   * cooldown, pool inflight, and provider inflight. Retained as the fallback
   * for the non-Redis path and for a Redis outage during the batched read.
   */
  private async perPoolSelectionChecks(
    eligiblePoolIds: readonly string[],
    providerId: string,
    limitsByPool?: Record<string, number>,
    weightsByPool?: Record<string, number>,
    providerCapacity?: number,
  ): Promise<Array<{ cooldown: PoolCooldownState; pool: PoolCapacitySnapshot }>> {
    return Promise.all(
      eligiblePoolIds.map(async (poolId) => {
        const cooldown = await this.isProviderCooldown(poolId, providerId);
        const maxInflight = effectiveConcurrency(
          limitsByPool?.[poolId] ?? DEFAULT_PROXY_CONCURRENCY,
        );
        const weight = normalizedWeight(weightsByPool?.[poolId]);
        const currentInflight = await this.getInflightAuthoritative(poolId);
        const providerInflight =
          providerCapacity === undefined
            ? undefined
            : await this.getProviderInflightAuthoritative(poolId, providerId);
        return {
          cooldown,
          pool: {
            poolId,
            maxInflight,
            currentInflight,
            available: Math.max(0, maxInflight - currentInflight),
            weight,
            ...(cooldown.resetsAt ? { retryAt: cooldown.resetsAt.getTime() } : {}),
            ...(cooldown.blocked ? { blocked: true } : {}),
            ...(providerCapacity === undefined
              ? {}
              : { providerMaxInflight: providerCapacity, providerInflight: providerInflight ?? 0 }),
          } satisfies PoolCapacitySnapshot,
        };
      }),
    );
  }

  /**
   * Batched failure check: one `MGET` per key family (cooldowns, pool
   * inflight, provider inflight) instead of three serial GETs per pool. On a
   * Redis error the whole read falls back to per-pool reads so the failure
   * report keeps the "cooldown store unavailable" per-pool detail.
   */
  private async batchSelectionChecks(
    eligiblePoolIds: readonly string[],
    providerId: string,
    limitsByPool?: Record<string, number>,
    weightsByPool?: Record<string, number>,
    providerCapacity?: number,
  ): Promise<Array<{ cooldown: PoolCooldownState; pool: PoolCapacitySnapshot }>> {
    const cooldownKeys = eligiblePoolIds.map((poolId) => proxyCooldownKey(poolId, providerId));
    const inflightKeys = eligiblePoolIds.map((poolId) => proxyInflightKey(poolId));
    const providerInflightKeys =
      providerCapacity === undefined
        ? []
        : eligiblePoolIds.map((poolId) => proxyProviderInflightKey(poolId, providerId));
    try {
      const [cooldownRaws, inflightRaws, providerRaws] = await Promise.all([
        this.redis!.mget(...cooldownKeys),
        this.redis!.mget(...inflightKeys),
        providerInflightKeys.length === 0
          ? Promise.resolve([] as Array<string | null>)
          : this.redis!.mget(...providerInflightKeys),
      ]);
      return eligiblePoolIds.map((poolId, index) => {
        const cooldown = this.cooldownFromBatchState(poolId, providerId, cooldownRaws[index] ?? null);
        const maxInflight = effectiveConcurrency(
          limitsByPool?.[poolId] ?? DEFAULT_PROXY_CONCURRENCY,
        );
        const weight = normalizedWeight(weightsByPool?.[poolId]);
        const currentInflight = this.parseInflightCounter(inflightRaws[index] ?? null, poolId);
        const providerInflight =
          providerCapacity === undefined
            ? undefined
            : this.parseInflightCounter(providerRaws[index] ?? null, `${poolId}/${providerId}`);
        return {
          cooldown,
          pool: {
            poolId,
            maxInflight,
            currentInflight,
            available: Math.max(0, maxInflight - currentInflight),
            weight,
            ...(cooldown.resetsAt ? { retryAt: cooldown.resetsAt.getTime() } : {}),
            ...(cooldown.blocked ? { blocked: true } : {}),
            ...(providerCapacity === undefined
              ? {}
              : { providerMaxInflight: providerCapacity, providerInflight: providerInflight ?? 0 }),
          } satisfies PoolCapacitySnapshot,
        };
      });
    } catch {
      return this.perPoolSelectionChecks(
        eligiblePoolIds,
        providerId,
        limitsByPool,
        weightsByPool,
        providerCapacity,
      );
    }
  }

  async getSelectionFailure(
    eligiblePoolIds: readonly string[],
    providerId: string,
    limitsByPool?: Record<string, number>,
    weightsByPool?: Record<string, number>,
    providerMaxInflight?: number,
  ): Promise<PoolSelectionFailure> {
    if (eligiblePoolIds.length === 0) return { reason: "no_active_pool", pools: [] };
    const providerCapacity =
      providerMaxInflight === undefined ? undefined : effectiveConcurrency(providerMaxInflight);
    try {
      // One batch pass instead of per-pool Redis reads: cooldowns and inflight
      // counters are read in one `MGET` per key family (three total), not
      // three serial GETs per pool. The per-pool resolution below consumes the
      // raw rows with the same semantics `isProviderCooldown` /
      // `getInflightAuthoritative` / `getProviderInflightAuthoritative` apply.
      const checks =
        this.redis === undefined
          ? await this.perPoolSelectionChecks(eligiblePoolIds, providerId, limitsByPool, weightsByPool, providerCapacity)
          : await this.batchSelectionChecks(eligiblePoolIds, providerId, limitsByPool, weightsByPool, providerCapacity);
      const pools = checks.map((check) => check.pool);
      const cooldowns = checks.map((check) => check.cooldown);
      if (cooldowns.some((entry) => entry.reason === "cooldown store unavailable")) {
        return { reason: "coordination_unavailable", pools };
      }
      const active = pools.filter((pool) => pool.maxInflight > 0 && pool.weight > 0);
      if (active.length === 0) return { reason: "no_active_pool", pools };
      const allCooling = cooldowns.every((entry) => entry.inCooldown);
      if (allCooling) {
        // A retired egress is not a cooldown: nothing clears it on a timer, so
        // telling the operator to "retry once the cooldown resets" would be a
        // lie they could wait on indefinitely. Report the stronger fact.
        if (cooldowns.every((entry) => entry.blocked)) {
          return { reason: "blocked", pools };
        }
        const retryAt = Math.min(
          ...cooldowns
            .map((entry) => entry.resetsAt?.getTime())
            .filter((value): value is number => value !== undefined),
        );
        return {
          reason: "cooldown",
          pools,
          ...(Number.isFinite(retryAt) ? { retryAt } : {}),
        };
      }
      // Distinguish "every pool is full" from "every pool has room, but not
      // for this provider" — the operator's fix differs (add capacity vs.
      // raise this provider's share).
      if (
        providerCapacity !== undefined &&
        active.every((pool) => (pool.providerInflight ?? 0) >= providerCapacity)
      ) {
        return { reason: "provider_at_capacity", pools };
      }
      return { reason: "at_capacity", pools };
    } catch {
      return { reason: "coordination_unavailable", pools: [] };
    }
  }
}
