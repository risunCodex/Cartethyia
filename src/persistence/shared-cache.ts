// Cross-process cache coordination: a shared L2 in front of Postgres.
//
// Every hot read in the request path is cached in-process. That is correct
// for one process and wrong for several: `main.ts` sets `reusePort: true`, so N
// gateway processes each hold their own copy. With no shared layer, a key
// revoked through the console stays valid for up to a full TTL in every other
// process, and DB read load is multiplied by the process count.
//
// Two mechanisms, deliberately separate because they are not interchangeable:
//
// - `readShared`/`writeShared` — a value cache. Right for small entries whose
//   serialization cost is trivial next to the query they replace (auth
//   snapshots, tenant preferences).
// - `publishInvalidation`/`subscribeInvalidation` — a notification channel.
//   Right for *large* derived structures, above all the route snapshot, which
//   is built from 11 SELECTs. Storing that in Redis would mean serializing a
//   whole routing table on every write and deserializing it on every read;
//   publishing a revision token costs almost nothing and converges just as
//   fast.
//
// Redis absence is not an error. `resolveRedisClient()` returns undefined with
// no URL configured, and every function here degrades to the in-process path —
// the same behaviour the tree has always had when Redis is unset.
import { resolveRedisClient, type RedisClient } from "./redis";

/** Channel carrying cross-process invalidation notices. */
const INVALIDATION_CHANNEL = "cartethyia:cache:invalidate";

/**
 * Namespaces one logical cache.
 *
 * Prefixed so an auth entry and a preferences entry with the same id cannot
 * collide, and so a `FLUSHDB`-free deploy can drop one namespace without
 * touching another.
 */
type SharedCacheNamespace = "auth" | "preferences" | "credential" | "routing" | "public-models";

const NAMESPACE_PREFIX: Readonly<Record<SharedCacheNamespace, string>> = {
  auth: "cartethyia:cache:auth:",
  preferences: "cartethyia:cache:prefs:",
  credential: "cartethyia:cache:cred:",
  // Never read or written as a value either — the model listing is cached
  // in-process and rebuilt from the catalog. Only the invalidation notice
  // uses this namespace.
  "public-models": "cartethyia:cache:pubmodels:",
  // Never read or written as a value — the routing snapshot is 11 SELECTs of
  // derived data and is far too large to round-trip through Redis. This prefix
  // exists only so the namespace is a closed union.
  routing: "cartethyia:cache:routing:",
};

/** One notice that peers must drop an entry. */
interface InvalidationNotice {
  readonly namespace: SharedCacheNamespace;
  /** Omitted means "all keys in the namespace". */
  readonly key?: string;
  /** Originating process, so the publisher can ignore its own echo. */
  readonly origin: string;
}

/** Per-process identity, so a publisher ignores its own broadcast. */
const ORIGIN = `${process.pid}-${Math.random().toString(36).slice(2, 10)}`;

function keyFor(namespace: SharedCacheNamespace, key: string): string {
  return `${NAMESPACE_PREFIX[namespace]}${key}`;
}

/**
 * Reads one entry from the shared layer.
 *
 * Returns `undefined` on a miss, on Redis being absent, and on any error — a
 * cache read must never fail a request, and the caller already has the
 * Postgres path as the fallback.
 */
export async function readShared(
  namespace: SharedCacheNamespace,
  key: string,
): Promise<string | undefined> {
  const client = resolveRedisClient();
  if (client === undefined) return undefined;
  try {
    return (await client.get(keyFor(namespace, key))) ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Writes one entry to the shared layer with its own TTL.
 *
 * The TTL is the caller's, not a global default, because these entries have
 * genuinely different freshness needs: an auth snapshot must expire in
 * seconds, a credential can outlive it.
 */
export async function writeShared(
  namespace: SharedCacheNamespace,
  key: string,
  value: string,
  ttlMs: number,
): Promise<void> {
  const client = resolveRedisClient();
  if (client === undefined) return;
  try {
    // `PX` (milliseconds) rather than `EX`: these TTLs are 1.5–5 s, and a
    // seconds-granularity expiry would round 1.5 s up to 2 s.
    await client.set(keyFor(namespace, key), value, "PX", Math.max(1, Math.ceil(ttlMs)));
  } catch {
    // A failed cache write is not a request failure.
  }
}

/** Drops one entry (or a whole namespace when `key` is omitted). */
export async function deleteShared(
  namespace: SharedCacheNamespace,
  key?: string,
): Promise<void> {
  const client = resolveRedisClient();
  if (client === undefined) return;
  try {
    if (key === undefined) {
      await scanDelete(client, `${NAMESPACE_PREFIX[namespace]}*`);
      return;
    }
    await client.del(keyFor(namespace, key));
  } catch {
    // Ignored: the in-process caches carry their own TTL backstop.
  }
}

/**
 * Deletes by pattern without `KEYS`.
 *
 * `KEYS` blocks Redis for the whole keyspace scan, which on a busy instance is
 * a latency spike for every other consumer. `SCAN` iterates in bounded
 * cursors instead.
 */
async function scanDelete(client: RedisClient, pattern: string): Promise<void> {
  let cursor = "0";
  do {
    const [next, batch] = await client.scan(cursor, "MATCH", pattern, "COUNT", 500);
    cursor = next;
    if (batch.length > 0) await client.del(...batch);
  } while (cursor !== "0");
}

/**
 * Broadcasts an invalidation to peer processes.
 *
 * Fire-and-forget by design: the caller has already dropped its own copy, and
 * a peer that misses this notice still converges when its entry's TTL lapses.
 * Redis pub/sub is at-most-once, which is exactly the guarantee this needs.
 */
export function publishInvalidation(notice: Omit<InvalidationNotice, "origin">): void {
  const client = resolveRedisClient();
  if (client === undefined) return;
  try {
    void client
      .publish(INVALIDATION_CHANNEL, JSON.stringify({ ...notice, origin: ORIGIN }))
      .catch(() => undefined);
  } catch {
    // Ignored, as above.
  }
}

/**
 * Broadcasts "the route snapshot changed" to peer processes.
 *
 * Separate from {@link publishInvalidation} only in readability: the snapshot
 * is not a keyed cache entry, so it has no namespace key to name. Peers drop
 * their whole snapshot and rebuild lazily.
 */
export function publishRoutingInvalidation(): void {
  publishInvalidation({ namespace: "routing" });
}

/** Subscribes to peer route-snapshot invalidations. */
export function subscribeRoutingInvalidation(handler: () => void): () => void {
  return subscribeInvalidation((notice) => {
    if (notice.namespace !== "routing") return;
    handler();
  });
}

/**
 * Subscribes to peer invalidations.
 *
 * The returned function unsubscribes. Without Redis this is a no-op that
 * returns a no-op, so callers need no branch of their own.
 */
export function subscribeInvalidation(
  handler: (notice: InvalidationNotice) => void,
): () => void {
  const client = resolveRedisClient();
  if (client === undefined) return () => undefined;
  // One subscriber connection for the process. ioredis puts a connection into
  // subscriber mode permanently, so reusing the shared client for pub/sub
  // would take it out of normal command service.
  const subscriber = client.duplicate();
  let closed = false;
  const onMessage = (channel: string, payload: string): void => {
    if (channel !== INVALIDATION_CHANNEL) return;
    try {
      const parsed = JSON.parse(payload) as InvalidationNotice;
      // Ignore our own echo: the local drop already happened, and re-running
      // it would invalidate work done since the publish.
      if (parsed.origin === ORIGIN) return;
      handler(parsed);
    } catch {
      // A malformed notice is dropped rather than acted on.
    }
  };
  void subscriber.subscribe(INVALIDATION_CHANNEL).catch(() => undefined);
  subscriber.on("message", onMessage);
  return () => {
    if (closed) return;
    closed = true;
    subscriber.off("message", onMessage);
    void subscriber.quit().catch(() => undefined);
  };
}
