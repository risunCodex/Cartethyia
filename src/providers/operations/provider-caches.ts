/**
 * In-process caches for model catalogs, model discovery, and client/provider versions.
 */

import type { ModelDefinition } from "../provider-model-definition";
import { trackModelCatalogLoad } from "../../observability/performance-metrics";
import { resolveRedisClient } from "../../persistence/redis";
import { cachedRead } from "../../console/shared/read-through-cache";
import { TtlCacheFamily } from "../../persistence/ttl-cache";
import { retryWithBackoff } from "../../network/retry";

/* -------------------------------------------------------------------------- */
/* 1. Model Catalog Cache                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Provider entries retained before the least-recently-used catalog is evicted.
 *
 * Must clear the bundled provider count — there are **73** of them — because a
 * cap below it thrashes: a catalog rebuild evicts a provider it is about to
 * need again, so `bundledModelCatalog()` re-imports a module it already had.
 * Sized above that count with room for BYOK rows. One entry is a model list, so
 * the bound still matters; it just has to be the right one.
 */
export const MODEL_CATALOG_CACHE_MAX_ENTRIES = 128;

/**
 * Cross-instance tier lifetime. Static provider catalogs change only on a
 * deploy, so a short shared window keeps every instance from rebuilding the
 * same expensive dynamic import. The key is versioned so a shape change is a
 * new key rather than a stale read.
 */
const MODEL_CATALOG_TTL_SECONDS = 60;
const MODEL_CATALOG_KEY_PREFIX = "catalog:v1:";

const catalogCache = new Map<string, Promise<readonly ModelDefinition[]>>();

/**
 * Evicts the least-recently-used provider before inserting a new one once the
 * cache is at its bound. `Map` preserves insertion order and every cache hit
 * re-inserts its entry at the tail, so the head is the LRU key.
 */
function evictLeastRecentlyUsedCatalog(maxEntries: number): void {
  if (catalogCache.size < maxEntries) return;
  const oldestKey = catalogCache.keys().next().value;
  if (oldestKey !== undefined) catalogCache.delete(oldestKey);
}

/** Returns the cached catalog promise for `providerId`, loading it once on first call. */
export function getCachedModels(
  providerId: string,
  loader: () => Promise<readonly ModelDefinition[]>,
  maxEntries = MODEL_CATALOG_CACHE_MAX_ENTRIES,
): Promise<readonly ModelDefinition[]> {
  const cached = catalogCache.get(providerId);
  if (cached !== undefined) {
    // Refresh recency so a hot provider survives eviction pressure.
    catalogCache.delete(providerId);
    catalogCache.set(providerId, cached);
    return cached;
  }
  evictLeastRecentlyUsedCatalog(maxEntries);
  const startedAt = performance.now();
  // The in-memory entry holds the *promise*, so concurrent and repeated calls
  // for one provider still share a single load — the shared tier only widens
  // that deduplication to other instances.
  const task = cachedRead<readonly ModelDefinition[]>(
    resolveRedisClient(),
    `${MODEL_CATALOG_KEY_PREFIX}${providerId}`,
    async () => {
      const models = await loader();
      trackModelCatalogLoad(providerId, performance.now() - startedAt);
      return models;
    },
    MODEL_CATALOG_TTL_SECONDS,
  ).catch((error: unknown) => {
    // Never cache a failure: a transient import error must be retryable.
    catalogCache.delete(providerId);
    throw error;
  });
  catalogCache.set(providerId, task);
  return task;
}

/** Drops all cached catalogs. Test-only: keeps isolated tests from sharing state. */
export function resetModelCatalogCacheForTesting(): void {
  catalogCache.clear();
}

/** Live entry count, for the `/metrics` gauge. */
export function modelCatalogCacheSize(): number {
  return catalogCache.size;
}

/* -------------------------------------------------------------------------- */
/* 2. Model Discovery Cache                                                   */
/* -------------------------------------------------------------------------- */

const MODEL_DISCOVERY_CACHE_TTL_MS = 10 * 60 * 1000;
const discoveryCaches = new TtlCacheFamily<readonly ModelDefinition[]>({
  defaultTtlMs: MODEL_DISCOVERY_CACHE_TTL_MS,
});

export interface CachedModelDiscoveryOptions {
  readonly ttlMs?: number;
}

/** Returns cached models, retrying null/empty loads on the next call. */
export async function getCachedModelDiscovery(
  key: string,
  loader: () => Promise<readonly ModelDefinition[] | null>,
  options: CachedModelDiscoveryOptions = {},
): Promise<readonly ModelDefinition[] | null> {
  return discoveryCaches.for(options.ttlMs).load(key, loader, {
    namespace: "model-discovery",
    shouldCache: (models) => models.length > 0,
  });
}

/** Drops all cached discoveries. Test-only. */
export function resetModelDiscoveryCacheForTesting(): void {
  discoveryCaches.clear();
}

/* -------------------------------------------------------------------------- */
/* 3. Provider Version Cache                                                  */
/* -------------------------------------------------------------------------- */

const VERSION_CACHE_TTL_MS = 5 * 60 * 1000;
const versionCaches = new TtlCacheFamily<string>({ defaultTtlMs: VERSION_CACHE_TTL_MS });

export interface CachedVersionOptions {
  readonly ttlMs?: number;
  readonly maxRetries?: number;
}

export async function getCachedVersion(
  key: string,
  loader: () => Promise<string | null>,
  options: CachedVersionOptions = {},
): Promise<string | null> {
  const loadWithRetry = () => retryWithBackoff(loader, { maxRetries: options.maxRetries ?? 2 });
  return versionCaches.for(options.ttlMs).load(key, loadWithRetry, {
    namespace: "provider-version",
  });
}

/** Drops all cached versions. Test-only. */
export function resetVersionCacheForTesting(): void {
  versionCaches.clear();
}
