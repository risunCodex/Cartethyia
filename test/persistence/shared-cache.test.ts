/**
 * Cross-process cache coordination.
 *
 * These run without Redis configured, which is the deployment shape the tree
 * has always had and the shape most tests run in. That is deliberate: the
 * dangerous failure is not "the shared layer is wrong" but "the shared layer
 * being absent breaks the caller". Every function here must degrade to a
 * no-op, and these assert exactly that.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  deleteShared,
  publishInvalidation,
  publishRoutingInvalidation,
  readShared,
  subscribeInvalidation,
  subscribeRoutingInvalidation,
  writeShared,
} from "../../src/persistence/shared-cache";
import { closeRedis, resolveRedisClient } from "../../src/persistence/redis";
import { closeRedisSubscribers } from "../../src/persistence/redis-subscribers";
import { testRedisUrl } from "../helpers/database";

/**
 * These tests assert the no-Redis degradation: every shared-cache call must
 * no-op when no Redis is configured. The precondition is "Redis absent", so
 * when a Redis URL is configured (a live local Redis, or an isolated test
 * Redis) the suite is skipped — the shared layer is then genuinely present and
 * these assertions no longer apply.
 */
const redisConfigured =
  (process.env.REDIS_URL?.trim() ?? "") !== "" ||
  (process.env.CARTETHYIA_TEST_REDIS_URL?.trim() ?? "") !== "";

/**
 * Subscriber lifecycle against a real Redis. These tests repoint
 * `REDIS_URL` at the isolated test instance for their duration and restore
 * every variable they touched afterwards — `resolveRedisClient` caches its
 * client on `globalThis`, so the cached handle is cleared before and after
 * too, or a suite running later in this process would keep talking to the
 * test instance.
 */
const redisLifecycleDescribe = testRedisUrl ? describe : describe.skip;
if (!testRedisUrl) {
  console.info(
    "[test-redis] skipped: set CARTETHYIA_TEST_REDIS_URL to run the subscriber lifecycle suite",
  );
}

redisLifecycleDescribe("invalidation subscribers on real Redis", () => {
  const savedEnv = {
    REDIS_URL: process.env.REDIS_URL,
    REDIS_PUBLIC_URL: process.env.REDIS_PUBLIC_URL,
    REDISHOST: process.env.REDISHOST,
    REDISPORT: process.env.REDISPORT,
    REDISUSER: process.env.REDISUSER,
    REDISPASSWORD: process.env.REDISPASSWORD,
  };
  const unsubscribes: (() => void)[] = [];

  /** Subscribes and records the teardown so afterAll can always release it. */
  function subscribe(handler: (notice: { namespace: string; key?: string }) => void): void {
    unsubscribes.push(subscribeInvalidation(handler));
  }

  /**
   * Pub/sub delivery is asserted as arrival-vs-non-arrival, not speed: the
   * shared local test Redis also serves the rest of the suite under the
   * runner's 4x parallelism, and an occasional multi-second delivery delay is
   * exactly the load the deadline must absorb. A genuinely broken subscriber
   * (subscribe never lands, handler never fires) still fails here — it just
   * fails ten seconds later.
   */
  async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error("timed out waiting for pub/sub delivery");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  // Env and the cached client must be in place before the first subscription.
  // `beforeAll` (not the describe body) is the earliest point that never runs
  // for a skipped suite — `describe.skip` still evaluates its callback.
  beforeAll(() => {
    process.env.REDIS_URL = testRedisUrl;
    delete process.env.REDIS_PUBLIC_URL;
    delete process.env.REDISHOST;
    delete process.env.REDISPORT;
    delete process.env.REDISUSER;
    delete process.env.REDISPASSWORD;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (globalThis as any).__cartethyiaRedis;
  });

  afterAll(async () => {
    for (const unsubscribe of unsubscribes.splice(0)) unsubscribe();
    await closeRedisSubscribers();
    await closeRedis();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (globalThis as any).__cartethyiaRedis;
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  /**
   * Waits until the subscriber connection's SUBSCRIBE has actually landed on
   * the server — publishing before that races the handshake and the notice is
   * legitimately missed.
   */
  async function waitForSubscription(): Promise<void> {
    const client = resolveRedisClient();
    if (client === undefined) throw new Error("expected a resolved Redis client");
    const deadline = Date.now() + 10_000;
    for (;;) {
      const channels = (await client.pubsub("CHANNELS", "cartethyia:cache:invalidate")) as string[];
      if (channels.includes("cartethyia:cache:invalidate")) return;
      if (Date.now() > deadline) throw new Error("subscriber never appeared in PUBSUB CHANNELS");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  test("a foreign-origin notice reaches the subscriber; own echo is filtered", async () => {
    // `publishInvalidation` stamps this process's ORIGIN, and the subscriber
    // drops its own echo by design — so peer delivery is exercised by
    // publishing the wire payload directly with a foreign origin, exactly what
    // a peer process's publish looks like on the channel.
    const seen: string[] = [];
    subscribe((notice) => {
      if (notice.namespace === "preferences") seen.push(notice.key ?? "");
    });
    await waitForSubscription();

    const client = resolveRedisClient();
    if (client === undefined) throw new Error("expected a resolved Redis client");
    const foreignKey = `peer-${crypto.randomUUID()}`;
    const selfKey = `self-${crypto.randomUUID()}`;
    /**
     * The foreign notice is re-published until the handler actually sees it.
     * The shared local test Redis (the old Windows 5.0 port) serves the whole
     * suite under the runner's 4x parallelism and can stall deliveries for
     * seconds at a time — a single publish would tie this assertion to that
     * stall instead of to the delivery contract. Arrival is what the
     * assertion owns. The self echo is published exactly once after arrival
     * is confirmed, so a broken origin-filter still shows up as `selfKey`
     * in `seen`.
     */
    await waitFor(() => {
      void client.publish(
        "cartethyia:cache:invalidate",
        JSON.stringify({ namespace: "preferences", key: foreignKey, origin: "peer-process" }),
      );
      return seen.includes(foreignKey);
    });
    publishInvalidation({ namespace: "preferences", key: selfKey });

    // Give the self echo a beat to (not) arrive, then assert the foreign
    // notice was delivered and this process's own echo was filtered. The
    // foreign key may have arrived more than once — re-publication is the
    // mechanism, not a failure.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(seen.includes(foreignKey)).toBe(true);
    expect(seen).not.toContain(selfKey);
  });

  test("unsubscribing detaches the handler", async () => {
    const seen: string[] = [];
    subscribe((notice) => {
      if (notice.namespace === "preferences") seen.push(notice.key ?? "");
    });
    await waitForSubscription();

    const unsubscribe = unsubscribes.pop()!;
    unsubscribe();
    const client = resolveRedisClient();
    if (client === undefined) throw new Error("expected a resolved Redis client");
    await client.publish(
      "cartethyia:cache:invalidate",
      JSON.stringify({
        namespace: "preferences",
        key: `after-${crypto.randomUUID()}`,
        origin: "peer-process",
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(seen).toHaveLength(0);
  });
});

describe("shared cache without Redis", () => {
  test("a read is a miss, not an error", async () => {
    if (redisConfigured) return;
    await expect(readShared("auth", "hash-1")).resolves.toBeUndefined();
  });

  test("a write is accepted and does not throw", async () => {
    if (redisConfigured) return;
    await expect(writeShared("auth", "hash-1", "{}", 5_000)).resolves.toBeUndefined();
    // And the write is not served back: no Redis means no L2 at all, rather
    // than an L2 that silently lies about being shared.
    await expect(readShared("auth", "hash-1")).resolves.toBeUndefined();
  });

  test("a delete is accepted and does not throw", async () => {
    if (redisConfigured) return;
    await expect(deleteShared("auth", "hash-1")).resolves.toBeUndefined();
    await expect(deleteShared("auth")).resolves.toBeUndefined();
  });

  test("publishing an invalidation does not throw", () => {
    if (redisConfigured) return;
    expect(() => publishInvalidation({ namespace: "auth", key: "id-1" })).not.toThrow();
    expect(() => publishInvalidation({ namespace: "auth" })).not.toThrow();
    expect(() => publishRoutingInvalidation()).not.toThrow();
  });

  test("subscribing returns an unsubscribe that is safe to call twice", () => {
    if (redisConfigured) return;
    const unsubscribe = subscribeRoutingInvalidation(() => undefined);
    expect(typeof unsubscribe).toBe("function");
    expect(() => {
      unsubscribe();
      unsubscribe();
    }).not.toThrow();
  });

  test("a routing subscription ignores other namespaces", () => {
    if (redisConfigured) return;
    // Wired but never fired without Redis; the point is that constructing it
    // and tearing it down is safe, which is all the boot path needs.
    let fired = 0;
    const unsubscribe = subscribeInvalidation((notice) => {
      if (notice.namespace === "routing") fired += 1;
    });
    unsubscribe();
    expect(fired).toBe(0);
  });
});
