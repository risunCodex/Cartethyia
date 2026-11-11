/**
 * Per-provider, per-pool inflight admission.
 *
 * Three ceilings apply to one proxied request and each bounds a different
 * thing: `provider_routing_settings.max_inflight` bounds one *account*,
 * `network_pools.max_inflight` bounds one *pool across every provider*, and
 * `provider_routing_settings.max_inflight_per_proxy` bounds one *provider's
 * share of one pool*. This file pins the third, which is the only one that did
 * not exist before.
 *
 * The properties worth pinning are the ones a regression would break silently:
 *
 * - Unlimited (the default) is byte-for-byte the old path: no counter, no
 *   extra key, no behavioural change.
 * - A saturated provider fails over to a pool that still has room, rather than
 *   failing the request while an eligible pool sits idle.
 * - Both counters move together. A release that decrements only one bleeds a
 *   slot per request until the pool is permanently full — the failure mode that
 *   looks like "the proxy died" and needs a restart.
 *
 * No Redis here: the local path is exercised directly, and the Redis path is
 * covered by the script's own contract below.
 */
import { describe, expect, test } from "bun:test";
import { NetworkPoolSelector } from "../../src/network/pool/selector";
import {
  POOL_PROVIDER_ADMIT_SCRIPT,
  POOL_PROVIDER_RELEASE_SCRIPT,
  proxyInflightKey,
  proxyProviderInflightKey,
} from "../../src/network/pool/scripts";

const POOL_A = "pool-a";
const POOL_B = "pool-b";

describe("per-provider pool inflight", () => {
  test("unlimited provider is unaffected and keeps no counter", async () => {
    const selector = new NetworkPoolSelector();
    const slots = [];
    for (let index = 0; index < 12; index += 1) {
      const slot = await selector.tryAcquireAvailablePool([POOL_A], "opencode", { [POOL_A]: 20 });
      if (!slot) break;
      slots.push(slot);
    }
    expect(slots).toHaveLength(12);
    // No provider ceiling was passed, so nothing was recorded for it.
    expect(selector.getProviderInflight(POOL_A, "opencode")).toBe(0);
    for (const slot of slots) slot.release();
    expect(selector.getInflight(POOL_A)).toBe(0);
  });

  test("caps one provider's share without touching the pool's own capacity", async () => {
    const selector = new NetworkPoolSelector();
    const held = [];
    for (let index = 0; index < 3; index += 1) {
      const slot = await selector.tryAcquireAvailablePool(
        [POOL_A],
        "opencode",
        { [POOL_A]: 10 },
        undefined,
        undefined,
        3,
      );
      expect(slot).toBeDefined();
      if (slot) held.push(slot);
    }
    // The pool still has 7 of its 10 slots free…
    expect(selector.getInflight(POOL_A)).toBe(3);
    // …but this provider may not take any more of them.
    const blocked = await selector.tryAcquireAvailablePool(
      [POOL_A],
      "opencode",
      { [POOL_A]: 10 },
      undefined,
      undefined,
      3,
    );
    expect(blocked).toBeUndefined();

    // A different provider on the same pool is untouched.
    const other = await selector.tryAcquireAvailablePool([POOL_A], "claude", { [POOL_A]: 10 });
    expect(other).toBeDefined();
    other?.release();

    for (const slot of held) slot.release();
    expect(selector.getInflight(POOL_A)).toBe(0);
    expect(selector.getProviderInflight(POOL_A, "opencode")).toBe(0);
  });

  test("fails over to another pool that still has room for the provider", async () => {
    const selector = new NetworkPoolSelector();
    // Fill pool A for this provider.
    const heldA = [];
    for (let index = 0; index < 2; index += 1) {
      const slot = await selector.tryAcquireAvailablePool(
        [POOL_A],
        "opencode",
        { [POOL_A]: 10 },
        undefined,
        undefined,
        2,
      );
      if (slot) heldA.push(slot);
    }
    expect(heldA).toHaveLength(2);

    // Both pools are eligible; A is full for this provider, B is empty.
    const slot = await selector.tryAcquireAvailablePool(
      [POOL_A, POOL_B],
      "opencode",
      { [POOL_A]: 10, [POOL_B]: 10 },
      undefined,
      undefined,
      2,
    );
    expect(slot?.poolId).toBe(POOL_B);
    expect(selector.getProviderInflight(POOL_B, "opencode")).toBe(1);

    slot?.release();
    for (const held of heldA) held.release();
    expect(selector.getProviderInflight(POOL_A, "opencode")).toBe(0);
    expect(selector.getProviderInflight(POOL_B, "opencode")).toBe(0);
  });

  test("release is idempotent and moves both counters exactly once", async () => {
    const selector = new NetworkPoolSelector();
    const slot = await selector.tryAcquireAvailablePool(
      [POOL_A],
      "opencode",
      { [POOL_A]: 10 },
      undefined,
      undefined,
      2,
    );
    expect(slot).toBeDefined();
    expect(selector.getInflight(POOL_A)).toBe(1);
    expect(selector.getProviderInflight(POOL_A, "opencode")).toBe(1);

    slot?.release();
    slot?.release();
    slot?.release();
    // A double release would drive these negative and, with the local map
    // clamped at zero, quietly free a slot someone else holds.
    expect(selector.getInflight(POOL_A)).toBe(0);
    expect(selector.getProviderInflight(POOL_A, "opencode")).toBe(0);
  });

  test("a zero ceiling admits nothing instead of being ignored", async () => {
    const selector = new NetworkPoolSelector();
    const slot = await selector.tryAcquireAvailablePool(
      [POOL_A],
      "opencode",
      { [POOL_A]: 10 },
      undefined,
      undefined,
      0,
    );
    expect(slot).toBeUndefined();
    expect(selector.getInflight(POOL_A)).toBe(0);
  });

  test("a full pool is reported as provider capacity, not pool capacity", async () => {
    const selector = new NetworkPoolSelector();
    const held = [];
    for (let index = 0; index < 2; index += 1) {
      const slot = await selector.tryAcquireAvailablePool(
        [POOL_A],
        "opencode",
        { [POOL_A]: 10 },
        undefined,
        undefined,
        2,
      );
      if (slot) held.push(slot);
    }
    const failure = await selector.getSelectionFailure(
      [POOL_A],
      "opencode",
      { [POOL_A]: 10 },
      undefined,
      2,
    );
    // The operator's fix differs between the two: raise this provider's share
    // vs. add pool capacity. The reason has to say which.
    expect(failure.reason).toBe("provider_at_capacity");
    expect(failure.pools[0]?.providerMaxInflight).toBe(2);
    expect(failure.pools[0]?.providerInflight).toBe(2);
    for (const slot of held) slot.release();
  });

  test("pool exhaustion still reports pool capacity when a ceiling is configured", async () => {
    const selector = new NetworkPoolSelector();
    const held = [];
    for (let index = 0; index < 2; index += 1) {
      const slot = await selector.tryAcquireAvailablePool(
        [POOL_A],
        "opencode",
        { [POOL_A]: 2 },
        undefined,
        undefined,
        5,
      );
      if (slot) held.push(slot);
    }
    const failure = await selector.getSelectionFailure(
      [POOL_A],
      "opencode",
      { [POOL_A]: 2 },
      undefined,
      5,
    );
    // Pool 2/2, provider 2/5: the pool is the binding constraint.
    expect(failure.reason).toBe("at_capacity");
    for (const slot of held) slot.release();
  });
});

describe("provider inflight redis keys and scripts", () => {
  test("the provider key is scoped to both pool and provider, and is not the pool key", () => {
    const key = proxyProviderInflightKey(POOL_A, "OpenCode");
    expect(key).toBe(`proxy:inflight:${POOL_A}:opencode`);
    // A shared hash or a bare pool key would make the pool release script's
    // DEL wipe every provider's count with it.
    expect(key).not.toBe(proxyInflightKey(POOL_A));
    expect(proxyProviderInflightKey(POOL_A, "opencode")).not.toBe(
      proxyProviderInflightKey(POOL_B, "opencode"),
    );
  });

  test("admit raises both counters or neither", () => {
    // Structural: one script, both keys, and no path that increments one
    // before the other's ceiling is checked.
    expect(POOL_PROVIDER_ADMIT_SCRIPT).toContain("KEYS[1]");
    expect(POOL_PROVIDER_ADMIT_SCRIPT).toContain("KEYS[2]");
    const poolCheck = POOL_PROVIDER_ADMIT_SCRIPT.indexOf("if pool >=");
    const providerCheck = POOL_PROVIDER_ADMIT_SCRIPT.indexOf("if provider >=");
    const firstIncr = POOL_PROVIDER_ADMIT_SCRIPT.indexOf("redis.call('INCR'");
    expect(poolCheck).toBeGreaterThan(-1);
    expect(providerCheck).toBeGreaterThan(poolCheck);
    expect(firstIncr).toBeGreaterThan(providerCheck);
  });

  test("release touches every key it is given, and none it is not", () => {
    expect(POOL_PROVIDER_RELEASE_SCRIPT).toContain("for index = 1, #KEYS do");
    // Releasing a key that is already gone (TTL expired first) is not an error.
    expect(POOL_PROVIDER_RELEASE_SCRIPT).not.toContain("error(");
  });
});
