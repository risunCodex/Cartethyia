// Bounded LRU map: the one shared implementation for routing-layer caches.

/**
 * Evicts the oldest-inserted entry while `map.size > cap`. The shared
 * insertion-order bound for caches whose read path must not refresh recency
 * (unlike `BoundedLruMap`, whose `get` does). Eviction is one `keys().next()`
 * and no bookkeeping arrays.
 */
export function evictOldestEntry<K>(map: Map<K, unknown>, cap: number): void {
  while (map.size > cap) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

/**
 * A capacity-bounded LRU `Map`.
 *
 * `get()` refreshes recency; `set()` evicts exactly the least-recently-used
 * entry on overflow. Insertion order is the recency order (head = LRU,
 * tail = MRU), which `Map` maintains for free — so eviction is one
 * `keys().next()` and no bookkeeping arrays.
 *
 * The routing layer previously hand-rolled this shape twice (round-robin
 * state, capability profiles) with subtly different code. One implementation
 * means the bound is provable once: the map's size can never exceed
 * `capacity`, and every entry is reachable through the normal `Map` API the
 * callers already use.
 */
export class BoundedLruMap<K, V> extends Map<K, V> {
  private readonly capacity: number;

  constructor(capacity: number) {
    if (!Number.isFinite(capacity) || capacity < 1 || Math.trunc(capacity) !== capacity) {
      throw new Error(`BoundedLruMap capacity must be a positive integer, got ${capacity}`);
    }
    super();
    this.capacity = Math.trunc(capacity);
  }

  override get(key: K): V | undefined {
    if (!super.has(key)) return undefined;
    // Refresh recency: delete + re-insert moves the entry to the tail.
    const value = super.get(key)!;
    super.delete(key);
    super.set(key, value);
    return value;
  }

  override set(key: K, value: V): this {
    // An existing key is re-inserted at the tail even when the value is the
    // same object, so a read-modify-write cycle cannot leave a hot entry
    // parked at the head one eviction away from disappearing.
    if (super.has(key)) super.delete(key);
    else if (super.size >= this.capacity) {
      const oldest = super.keys().next().value;
      if (oldest !== undefined) super.delete(oldest);
    }
    super.set(key, value);
    return this;
  }
}
