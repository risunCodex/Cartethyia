/**
 * In-flight request de-duplication.
 *
 * When several callers ask for the same resource at the same moment (e.g. two
 * console requests triggering the same version lookup), only one upstream call
 * should run. `dedupeRequest` collapses concurrent calls for an identical key
 * onto one promise and forgets the key once it settles, so a later call starts
 * fresh instead of returning a stale result.
 */

const inFlight = new Map<string, Promise<unknown>>();

/** Cardinality bound; oldest entries evicted first under burst fan-out. */
const MAX_INFLIGHT_DEDUP_KEYS = 1000;

/**
 * Runs `fn` for `key`, sharing one in-flight promise across concurrent callers.
 * The entry is removed when the promise settles, so this de-duplicates bursts
 * rather than caching. Failures propagate to every waiter and are not memoized.
 */
export function dedupeRequest<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const existing = inFlight.get(key);
  if (existing !== undefined) return existing as Promise<T>;

  const task = fn().finally(() => {
    // Only clear the entry this call created; a later call may have replaced it.
    if (inFlight.get(key) === task) inFlight.delete(key);
  });
  // Evict oldest first: refusing to track past the cap would silently run the
  // work twice, which is worse than dropping an older dedup entry.
  if (inFlight.size >= MAX_INFLIGHT_DEDUP_KEYS) {
    const oldest = inFlight.keys().next();
    if (!oldest.done) inFlight.delete(oldest.value);
  }
  inFlight.set(key, task);
  return task;
}
