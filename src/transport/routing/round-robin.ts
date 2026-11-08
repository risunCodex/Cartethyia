// Round-robin rotation state and its bounded per-key LRU.
import type { RouteCandidate } from "./route-model";
import { BoundedLruMap } from "./bounded-lru";

export class RoundRobinState {
  private idx = 0;
  private servedByCurrent = 0;
  next(candidates: readonly RouteCandidate[], rotateCount: number): RouteCandidate | undefined {
    if (candidates.length === 0) return undefined;
    const safeCount = Math.max(1, Math.min(1000, Math.trunc(rotateCount)));
    const c = candidates[this.idx % candidates.length];
    this.servedByCurrent += 1;
    if (this.servedByCurrent >= safeCount) {
      this.idx = (this.idx + 1) % 1000000;
      this.servedByCurrent = 0;
    }
    return c;
  }
}
/**
 * Upper bound on per-key round-robin state. Keys are tenant/provider/model
 * combinations; without a cap, a deployment serving a long tail of unique
 * combinations would retain one entry forever. 1000 is far above the working
 * set of any real catalog, so eviction only ever targets genuinely cold keys.
 */
const MAX_ROUND_ROBIN_ENTRIES = 1000;

/**
 * Creates the bounded LRU map the router keeps round-robin state in.
 *
 * The bound is the same 1000-entry cap the hand-rolled version enforced;
 * `BoundedLruMap` is now the single implementation of that behavior, so the
 * eviction rule (get refreshes recency, overflow evicts the LRU head) cannot
 * drift between this cache and the capability-profile cache.
 */
export function createRoundRobinMap(): BoundedLruMap<string, RoundRobinState> {
  return new BoundedLruMap<string, RoundRobinState>(MAX_ROUND_ROBIN_ENTRIES);
}

/** One session's sticky account: which provider account last served it, and when. */
export interface StickySession {
  readonly accountId: string;
  readonly lastUsedAtMs: number;
  /** Set only by an explicit operator pin; automatic warm stickiness leaves it absent. */
  readonly explicit?: true;
}

/**
 * Session → account stickiness per provider, bounded by an LRU. Used by the
 * router to prefer the account that last served a session within the warm
 * window — prompt-cache warmth is worth more than perfect load balance. A
 * session id that is absent, evicted, or past the warm window simply carries
 * no preference.
 */
export class StickySessionStore {
  private readonly byProvider = new Map<string, BoundedLruMap<string, StickySession>>();

  constructor(private readonly maxSessionsPerProvider: number) {}

  private mapFor(providerId: string): BoundedLruMap<string, StickySession> {
    let map = this.byProvider.get(providerId);
    if (map === undefined) {
      map = new BoundedLruMap<string, StickySession>(this.maxSessionsPerProvider);
      this.byProvider.set(providerId, map);
    }
    return map;
  }

  /** The account last pinned to this session, or undefined. */
  get(providerId: string, sessionId: string | undefined): StickySession | undefined {
    if (sessionId === undefined) return undefined;
    return this.mapFor(providerId).get(sessionId);
  }

  /** Record that `accountId` served `sessionId` now (or pin it explicitly). */
  set(providerId: string, sessionId: string | undefined, accountId: string, explicit = false): void {
    if (sessionId === undefined) return;
    const now = Date.now();
    this.mapFor(providerId).set(sessionId, {
      accountId,
      lastUsedAtMs: now,
      ...(explicit ? { explicit: true as const } : {}),
    });
  }

  /** Drop one session's stickiness (e.g. after the account is invalidated). */
  clear(providerId: string, sessionId: string | undefined): void {
    if (sessionId === undefined) return;
    this.mapFor(providerId).delete(sessionId);
  }

  /** Total retained sticky entries across providers (for metrics/tests). */
  size(): number {
    let total = 0;
    for (const map of this.byProvider.values()) total += map.size;
    return total;
  }
}
