/**
 * Shared read-through cache for console responses.
 *
 * Answering several console endpoints parses the retained telemetry window,
 * which is the console's dominant cost and runs on the event loop that serves
 * the gateway. Redis is configured on every deployment and this store only ever
 * pinged it, so the same window was re-parsed per instance, per poll, per
 * endpoint. A short TTL makes that once per window across the whole fleet.
 *
 * A Redis that is slow or down must never fail a request: every cache step
 * falls through to computing the answer, which is exactly what the request
 * would have done before there was a cache.
 *
 * ## Validators
 *
 * The endpoints answer dashboard polls that repeat every few seconds while the
 * underlying telemetry window changes every minute. Without a validator every
 * poll ships the whole payload — 8.8 KiB to 150 KiB of it — even when nothing
 * changed. An ETag turns that into a ~200-byte `304`.
 *
 * Strong, not weak: the hash covers the exact serialized bytes the client
 * would otherwise have received, so a matching validator means byte-identical
 * content. A weaker or unstable hash would answer `304` for changed data and
 * leave the dashboard showing stale numbers, which is worse than the bytes it
 * saves.
 *
 * The ETag is computed **once per write**, never per read: hashing a 150 KiB
 * body on every poll would move the cost off the wire and onto the CPU.
 */

import { createHash } from "node:crypto";

/** The slice of Redis this cache needs, so it can be tested without a server. */
export interface ReadThroughCacheClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: "EX", ttlSeconds: number): Promise<unknown>;
}

/**
 * Default lifetime of a cached response. Callers whose underlying data changes
 * more often pass a shorter TTL; this value suits the dashboard's polling
 * cadence and the append-only telemetry log.
 */
export const READ_THROUGH_DEFAULT_TTL_SECONDS = 10;

/** The cached value plus the strong validator for the bytes it serializes to. */
export interface CachedResult<T> {
  readonly value: T;
  readonly etag: string;
}

/** Quoted per RFC 9110: an entity-tag is always `"…"`. */
function etagFor(bytes: string): string {
  // SHA-256 over the exact serialized bytes. Not the FNV-1a in
  // `payload-store.ts` — that one is module-private, and adding a second hash
  // implementation would risk two different collision profiles for one
  // purpose. SHA-256 is already used in `share-stats.ts` for cache identity.
  return `"${createHash("sha256").update(bytes, "utf8").digest("hex").slice(0, 32)}"`;
}

/** The sibling key holding the validator, so a cached body is never re-hashed. */
export function etagKey(key: string): string {
  return `${key}:etag`;
}

/**
 * In-memory fallback store used when no Redis client is configured (the
 * embedded lite backend). Keyed by the same cache key, storing the value and
 * its validator with a TTL. Bounded so a busy gateway cannot grow it without
 * limit.
 */
const LOCAL_CACHE_MAX_ENTRIES = 2000;
const localCache = new Map<string, { at: number; value: string; etag: string }>();

function localGet(key: string): { value: string; etag: string } | undefined {
  const entry = localCache.get(key);
  if (entry === undefined) return undefined;
  if (Date.now() - entry.at >= READ_THROUGH_DEFAULT_TTL_SECONDS * 1000) {
    localCache.delete(key);
    return undefined;
  }
  return { value: entry.value, etag: entry.etag };
}

function localSet(key: string, value: string, etag: string): void {
  if (localCache.size >= LOCAL_CACHE_MAX_ENTRIES) {
    // Evict the oldest entry (Map iterates in insertion order).
    const oldest = localCache.keys().next();
    if (!oldest.done) localCache.delete(oldest.value);
  }
  localCache.set(key, { at: Date.now(), value, etag });
}

/**
 * Reads through the cache and returns a strong validator alongside the value.
 *
 * The validator is computed once, at the moment the body is written, and read
 * back from its own key: a hit never hashes the payload. On a validator miss
 * with a body hit — a partial eviction, or a row written by an older build —
 * the body is re-hashed rather than discarded, so the pair cannot disagree.
 *
 * With no cache configured (`client === undefined`) the value is computed and
 * the validator is still returned, so conditional requests keep working for
 * the length of the client's own polling loop; only the cross-instance sharing
 * is lost. A process-local Map serves the same TTL when Redis is absent, so a
 * poller still gets cache hits.
 */
export async function cachedReadWithEtag<T>(
  client: ReadThroughCacheClient | undefined,
  key: string,
  compute: () => Promise<T>,
  ttlSeconds: number = READ_THROUGH_DEFAULT_TTL_SECONDS,
): Promise<CachedResult<T>> {
  if (client === undefined) {
    const entry = localGet(key);
    if (entry !== undefined) {
      return { value: JSON.parse(entry.value) as T, etag: entry.etag };
    }
    const fresh = await compute();
    const bytes = JSON.stringify(fresh) ?? "null";
    const etag = etagFor(bytes);
    localSet(key, bytes, etag);
    return { value: fresh, etag };
  }
  try {
    const hit = await client.get(key);
    if (hit !== null) {
      const value = JSON.parse(hit) as T;
      try {
        const stored = await client.get(etagKey(key));
        return { value, etag: stored ?? etagFor(hit) };
      } catch {
        return { value, etag: etagFor(hit) };
      }
    }
  } catch {
    // A cache read must never fail a request; compute instead.
  }
  const value = await compute();
  const bytes = JSON.stringify(value) ?? "null";
  const etag = etagFor(bytes);
  try {
    await client.set(key, bytes, "EX", ttlSeconds);
    await client.set(etagKey(key), etag, "EX", ttlSeconds);
  } catch {
    // A cache write must never fail a request that already has its answer.
  }
  return { value, etag };
}

/** `undefined` when the row was never cached, so a computed `null` is cacheable. */
export async function cachedRead<T>(
  client: ReadThroughCacheClient | undefined,
  key: string,
  compute: () => Promise<T>,
  ttlSeconds: number = READ_THROUGH_DEFAULT_TTL_SECONDS,
): Promise<T> {
  const { value } = await cachedReadWithEtag(client, key, compute, ttlSeconds);
  return value;
}

/**
 * `cache-control` for a cached console read.
 *
 * `no-cache`, not `no-store`: the response may be stored, it simply must be
 * revalidated, which is exactly what the ETag is for. `no-store` would forbid
 * storing and so forbid the `304` this exists to enable.
 */
const CACHE_CONTROL = "no-cache";

/**
 * Answers a conditional GET from a {@link CachedResult}.
 *
 * A match returns a bodiless `304`. An `If-None-Match` that does not match, or
 * a request that sent none, returns the body with the validator attached so
 * the next poll can be the cheap one.
 *
 * `If-None-Match` may carry several validators or the `*` form, so the header
 * is parsed rather than compared as one string.
 */
export function conditionalResponse<T>(
  ifNoneMatch: string | null,
  result: CachedResult<T>,
  body: unknown,
): Response {
  if (matchesEtag(ifNoneMatch, result.etag)) {
    return new Response(null, {
      status: 304,
      headers: { etag: result.etag, "cache-control": CACHE_CONTROL },
    });
  }
  const response = Response.json(body);
  response.headers.set("etag", result.etag);
  response.headers.set("cache-control", CACHE_CONTROL);
  return response;
}

/** True when an `If-None-Match` header names this validator. */
export function matchesEtag(header: string | null, etag: string): boolean {
  if (header === null) return false;
  const trimmed = header.trim();
  if (trimmed === "*") return true;
  for (const part of trimmed.split(",")) {
    // The weak prefix is stripped: a weak validator still names the same
    // representation, and the client that sent it asked to be told if the
    // current one matches.
    const candidate = part.trim().replace(/^W\//, "");
    if (candidate === etag) return true;
  }
  return false;
}
