/** Bounded process-local authorization cache; shared-cache I/O stays in the auth service. */
export const AUTH_CACHE_TTL_MS = 3_000;
const AUTH_CACHE_MAX_ENTRIES = 10_000;
export const AUTH_NEGATIVE_CACHE_TTL_MS = 1_500;
const AUTH_FAILURE_COOLDOWN_MS = 1_000;

interface CacheEntry<T> {
  readonly at: number;
  readonly value: T;
  readonly keyId: string;
}

type Lookup<T> =
  | { readonly kind: "positive"; readonly value: T }
  | { readonly kind: "negative" }
  | { readonly kind: "miss" };

/** Create the process-local positive/negative authorization cache. */
export function createApiKeyAuthorizationCache<T>() {
  const entries = new Map<string, CacheEntry<T>>();
  const hashesByKeyId = new Map<string, Set<string>>();
  const negativeEntries = new Map<string, number>();
  let failureUntil = 0;

  const evictOldest = (): void => {
    while (entries.size > AUTH_CACHE_MAX_ENTRIES) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) return;
      const entry = entries.get(oldest);
      entries.delete(oldest);
      if (entry === undefined) continue;
      const hashes = hashesByKeyId.get(entry.keyId);
      if (hashes === undefined) continue;
      hashes.delete(oldest);
      if (hashes.size === 0) hashesByKeyId.delete(entry.keyId);
    }
  };

  const evictNegativeOldest = (): void => {
    while (negativeEntries.size > AUTH_CACHE_MAX_ENTRIES) {
      const oldest = negativeEntries.keys().next().value;
      if (oldest === undefined) return;
      negativeEntries.delete(oldest);
    }
  };

  return {
    lookup(hash: string, now: number): Lookup<T> {
      const negativeAt = negativeEntries.get(hash);
      if (negativeAt !== undefined) {
        if (now - negativeAt < AUTH_NEGATIVE_CACHE_TTL_MS) return { kind: "negative" };
        negativeEntries.delete(hash);
      }
      const cached = entries.get(hash);
      if (cached === undefined || now - cached.at >= AUTH_CACHE_TTL_MS) return { kind: "miss" };
      entries.delete(hash);
      entries.set(hash, cached);
      return { kind: "positive", value: cached.value };
    },

    rememberPositive(hash: string, keyId: string, value: T, now: number): void {
      entries.set(hash, { at: now, value, keyId });
      negativeEntries.delete(hash);
      const hashes = hashesByKeyId.get(keyId) ?? new Set<string>();
      hashes.add(hash);
      hashesByKeyId.set(keyId, hashes);
      evictOldest();
    },

    rememberNegative(hash: string, now: number): void {
      negativeEntries.set(hash, now);
      evictNegativeOldest();
    },

    invalidate(keyId?: string): void {
      negativeEntries.clear();
      if (keyId === undefined) {
        entries.clear();
        hashesByKeyId.clear();
        return;
      }
      const hashes = hashesByKeyId.get(keyId);
      if (hashes === undefined) return;
      for (const hash of hashes) entries.delete(hash);
      hashesByKeyId.delete(keyId);
    },

    markStoreUnavailable(now: number): void {
      failureUntil = now + AUTH_FAILURE_COOLDOWN_MS;
    },

    isStoreUnavailable(now: number): boolean {
      return now < failureUntil;
    },
  };
}
