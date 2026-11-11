/** Local accounting state behind `NetworkPoolSelector`: inflight, rotation, cooldowns. */
import { log } from "../../observability/logger";
import { isRecord } from "../../protocol/codecs";

export interface ProxyCooldownEntry {
  readonly poolId: string;
  readonly providerId: string;
  readonly until: number;
  readonly reason: string;
  /**
   * True when the upstream retired this egress rather than throttling it.
   *
   * Kept as a field rather than inferred from `until`: a long cooldown and a
   * block are different facts, and reading one as the other is exactly the
   * confusion this flag exists to prevent.
   */
  readonly blocked?: boolean;
}

/**
 * Round-robin rotation request for one selection — present ⇒ rotate across
 * the eligible pools instead of scoring by load. `key` scopes the cursor (the
 * pool-owning tenant, so two tenants never share rotation position);
 * `rotateCount` is how many requests one pool serves before advancing,
 * clamped to 1..1000 exactly like the account strategy. Absent ⇒ the default
 * weighted least-loaded scan.
 */
export interface PoolRotation {
  readonly key: string;
  readonly rotateCount: number;
  /**
   * The strategy that produced this rotation request. `round_robin` serves
   * `rotateCount` requests per pool before advancing; `random` scatters each
   * selection across the eligible pools in a fresh random order. Absent means
   * the default weighted least-loaded scan.
   */
  readonly strategy?: "round_robin" | "random";
}

export interface PoolUsageSnapshot {
  readonly poolId: string;
  readonly currentInflight: number;
}

export function parseCooldownEntry(raw: string): ProxyCooldownEntry | undefined {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      isRecord(parsed) &&
      typeof parsed.poolId === "string" &&
      typeof parsed.providerId === "string" &&
      typeof parsed.until === "number" &&
      Number.isFinite(parsed.until) &&
      typeof parsed.reason === "string"
    ) {
      return {
        poolId: parsed.poolId,
        providerId: parsed.providerId.toLowerCase(),
        until: parsed.until,
        reason: parsed.reason.slice(0, 200),
        ...(parsed.blocked === true ? { blocked: true } : {}),
      };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** Bound on locally tracked inflight counters (paranoia: keys are pool ids, so the real bound is the pool count). */
export const MAX_INFLIGHT_ENTRIES = 10_000;
/** Bound on locally cached cooldown entries (pools × providers). */
export const MAX_COOLDOWN_ENTRIES = 5_000;
/** Bound on round-robin rotation cursors (one per pool-owning tenant). */
export const MAX_ROTATION_KEYS = 5_000;

export interface PoolLocalState {
  readonly inflight: Map<string, number>;
  /**
   * Provider-scoped inflight, keyed `${poolId}\u0000${providerId}`.
   *
   * Only populated for providers that configured a per-pool ceiling — an
   * unlimited provider never creates an entry, so this map stays empty on a
   * deployment that has not opted in.
   */
  readonly providerInflight: Map<string, number>;
  readonly cooldowns: Map<string, ProxyCooldownEntry>;
  /** Per-key round-robin state: scan position + admissions the pool at that position has served. */
  readonly rotationCursors: Map<string, { pos: number; served: number }>;
  fairnessCursor: number;
}

export function createPoolLocalState(): PoolLocalState {
  return {
    inflight: new Map(),
    providerInflight: new Map(),
    cooldowns: new Map(),
    rotationCursors: new Map(),
    fairnessCursor: 0,
  };
}

/** Evicts expired cooldown entries first, then oldest-inserted ones past the bound. */
export function enforceCooldownLimit(cooldowns: Map<string, ProxyCooldownEntry>): void {
  if (cooldowns.size < MAX_COOLDOWN_ENTRIES) return;
  const now = Date.now();
  for (const [key, entry] of cooldowns) {
    if (now >= entry.until) cooldowns.delete(key);
  }
  while (cooldowns.size >= MAX_COOLDOWN_ENTRIES) {
    const oldestKey = cooldowns.keys().next().value;
    if (oldestKey === undefined) break;
    cooldowns.delete(oldestKey);
  }
}

/**
 * Bounds the local inflight map by evicting the oldest-inserted counter.
 * With Redis the evicted pool's count stays authoritative there; the local
 * map only re-seeds, so worst case one pool briefly over-admits locally.
 */
export function enforceInflightLimit(inflight: Map<string, number>): void {
  if (inflight.size < MAX_INFLIGHT_ENTRIES) return;
  const oldestKey = inflight.keys().next().value;
  if (oldestKey !== undefined) {
    inflight.delete(oldestKey);
    log.warn(
      `[pool-selector] local inflight map exceeded ${MAX_INFLIGHT_ENTRIES} entries; evicted oldest counter`,
    );
  }
}

/** Next rotation start offset for `key`; an unknown key starts at 0. */
export function rotationStart(cursors: PoolLocalState["rotationCursors"], key: string, length: number): number {
  const pos = cursors.get(key)?.pos ?? 0;
  return ((pos % length) + length) % length;
}

/**
 * Record a successful admission at `absoluteIndex` — called only after the
 * pool actually acquired a slot, so a failed or cooling selection never
 * consumes rotation position. The scan resumes at `pos` until this pool has
 * served `rotateCount` requests, then advances by exactly one position:
 * striding the position by `rotateCount` steps per admission skips pools
 * whenever the pool count and `rotateCount` share a factor (2 pools with
 * `rotateCount` 2 pinned one pool forever). An index that is not `pos`
 * means the eligible list changed under the scan (shrank, or failover
 * jumped past a full pool); re-anchor there with a fresh served count.
 * State is per-process like the account `RoundRobinState`; the map is
 * bounded oldest-inserted-first.
 */
export function advanceRotation(
  cursors: PoolLocalState["rotationCursors"],
  key: string,
  length: number,
  absoluteIndex: number,
  rotateCount: number,
): void {
  if (!cursors.has(key) && cursors.size >= MAX_ROTATION_KEYS) {
    const oldest = cursors.keys().next().value;
    if (oldest !== undefined) cursors.delete(oldest);
  }
  const safeCount = Math.max(1, Math.min(1000, Math.trunc(rotateCount)));
  const current = cursors.get(key) ?? { pos: 0, served: 0 };
  if (absoluteIndex !== current.pos) {
    cursors.set(key, { pos: absoluteIndex, served: 1 });
    return;
  }
  const served = current.served + 1;
  cursors.set(
    key,
    served >= safeCount
      ? { pos: (absoluteIndex + 1) % length, served: 0 }
      : { pos: current.pos, served },
  );
}
