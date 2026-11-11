/**
 * Manual account tests must leave through the same proxy dispatch would pick.
 *
 * The button used to call global `fetch`, so a healthy proxy pool never saw
 * the probe and the 15-second direct dial died as "The operation timed out".
 * These tests pin the decisions that keep that from coming back: an active pool
 * is selected and bound, a deployment with no pool at all dials direct instead
 * of failing, a pool that exists but cannot be selected fails closed, and only
 * an explicit skip-proxy provider dials direct while pools exist.
 */
import { describe, expect, test } from "bun:test";
import { GatewayError } from "../../src/protocol/gateway-error";
import { selectAccountTestEgress } from "../../src/console/quota/account-test-egress";
import type { CartethyiaDatabase } from "../../src/persistence/db-handle";
import type { NetworkPoolSelector } from "../../src/network/pool/selector";
import type { ValidatedNetworkBindingFactory } from "../../src/network/egress/factory";

interface RoutingRow {
  readonly tenantId: string | null;
  readonly skipProxy: boolean;
}
interface PoolRow {
  readonly id: string;
  readonly maxInflight: number | null;
  readonly weight: number | null;
}
interface StrategyRow {
  readonly strategy: "least_loaded" | "round_robin";
  readonly rotateCount: number;
}

function dbDouble(input: {
  readonly routing?: readonly RoutingRow[];
  readonly pools?: readonly PoolRow[];
  readonly strategy?: StrategyRow;
}): CartethyiaDatabase {
  const db = {
    select: (shape: Record<string, unknown>) => ({
      from: () => ({
        where: () => {
          if ("skipProxy" in shape) {
            const rows = input.routing ?? [];
            return Object.assign(Promise.resolve(rows), { limit: async () => rows });
          }
          if ("maxInflight" in shape) {
            const rows = input.pools ?? [];
            return Object.assign(Promise.resolve(rows), { limit: async () => rows });
          }
          const rows = input.strategy ? [input.strategy] : [];
          return Object.assign(Promise.resolve(rows), { limit: async () => rows });
        },
      }),
    }),
  };
  return db as unknown as CartethyiaDatabase;
}

function selectorDouble(
  slot?: { poolId: string; release: () => void },
): NetworkPoolSelector & { readonly calls: unknown[][] } {
  const calls: unknown[][] = [];
  return {
    calls,
    tryAcquireAvailablePool: async (...args: unknown[]) => {
      calls.push(args);
      return slot;
    },
    getSelectionFailure: async () => ({ reason: "no_active_pool" as const, pools: [] }),
  } as unknown as NetworkPoolSelector & { readonly calls: unknown[][] };
}

function bindingDouble(): ValidatedNetworkBindingFactory & { readonly bound: string[] } {
  const bound: string[] = [];
  return {
    bound,
    fetch: (poolId?: string) => {
      bound.push(poolId ?? "direct");
      return async () => new Response("ok");
    },
  } as unknown as ValidatedNetworkBindingFactory & { readonly bound: string[] };
}

const signal = AbortSignal.timeout(15_000);

describe("manual account-test egress", () => {
  test("binds the pool selected for the provider", async () => {
    let released = false;
    const selector = selectorDouble({ poolId: "pool-a", release: () => { released = true; } });
    const binding = bindingDouble();
    const egress = await selectAccountTestEgress(
      {
        db: dbDouble({ pools: [{ id: "pool-a", maxInflight: 4, weight: 100 }] }),
        poolSelector: selector,
        networkBindingFactory: binding,
      },
      { tenantId: "tenant-1", providerId: "openai", signal },
    );

    expect(selector.calls).toEqual([[["pool-a"], "openai", { "pool-a": 4 }, { "pool-a": 100 }, undefined]]);
    expect(binding.bound).toEqual(["pool-a"]);
    egress.release();
    expect(released).toBe(true);
  });

  test("dials direct when the tenant has no pool at all", async () => {
    // The default deployment. Dispatch serves it directly, so the test button
    // must too: failing closed here made "Test" unusable until the operator
    // added a pool or manually flipped the provider to direct.
    const binding = bindingDouble();
    const egress = await selectAccountTestEgress(
      {
        db: dbDouble({ pools: [] }),
        poolSelector: selectorDouble({ poolId: "pool-a", release: () => undefined }),
        networkBindingFactory: binding,
      },
      { tenantId: "tenant-1", providerId: "openai", signal },
    );

    expect(binding.bound).toEqual(["direct"]);
    // Nothing was acquired, so releasing is a no-op rather than an error.
    expect(() => egress.release()).not.toThrow();
    await expect(egress.fetch("https://example.test")).resolves.toBeInstanceOf(Response);
  });

  test("uses the tenant round-robin strategy", async () => {
    const selector = selectorDouble({ poolId: "pool-b", release: () => undefined });
    await selectAccountTestEgress(
      {
        db: dbDouble({
          pools: [{ id: "pool-b", maxInflight: null, weight: null }],
          strategy: { strategy: "round_robin", rotateCount: 3 },
        }),
        poolSelector: selector,
        networkBindingFactory: bindingDouble(),
      },
      { tenantId: "tenant-1", providerId: "openai", signal },
    );

    expect(selector.calls[0]?.[4]).toEqual({ key: "tenant-1", rotateCount: 3 });
  });

  test("fails closed when proxy is required and no pool can be selected", async () => {
    const binding = bindingDouble();
    const error = await selectAccountTestEgress(
      {
        db: dbDouble({ pools: [{ id: "pool-a", maxInflight: 1, weight: 100 }] }),
        poolSelector: selectorDouble(undefined),
        networkBindingFactory: binding,
      },
      { tenantId: "tenant-1", providerId: "openai", signal },
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GatewayError);
    expect((error as GatewayError).code).toBe("proxy_pool_unavailable");
    expect(binding.bound).toEqual([]);
  });

  test("dials direct only when the provider skips proxy", async () => {
    const selector = selectorDouble({ poolId: "pool-a", release: () => undefined });
    const binding = bindingDouble();
    await selectAccountTestEgress(
      {
        db: dbDouble({
          routing: [{ tenantId: "tenant-1", skipProxy: true }],
          pools: [{ id: "pool-a", maxInflight: 1, weight: 100 }],
        }),
        poolSelector: selector,
        networkBindingFactory: binding,
      },
      { tenantId: "tenant-1", providerId: "openai", signal },
    );

    expect(selector.calls).toEqual([]);
    expect(binding.bound).toEqual(["direct"]);
  });
});
