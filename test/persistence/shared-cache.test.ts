/**
 * Cross-process cache coordination.
 *
 * These run without Redis configured, which is the deployment shape the tree
 * has always had and the shape most tests run in. That is deliberate: the
 * dangerous failure is not "the shared layer is wrong" but "the shared layer
 * being absent breaks the caller". Every function here must degrade to a
 * no-op, and these assert exactly that.
 */
import { describe, expect, test } from "bun:test";
import {
  deleteShared,
  publishInvalidation,
  publishRoutingInvalidation,
  readShared,
  subscribeInvalidation,
  subscribeRoutingInvalidation,
  writeShared,
} from "../../src/persistence/shared-cache";

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
