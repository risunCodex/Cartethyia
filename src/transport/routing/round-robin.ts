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
