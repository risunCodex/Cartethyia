/**
 * Quota fetches leave through the account's own egress.
 *
 * Kiro (AWS) correlates a credential with the address it presents from: a
 * usage read that departs from the host's own IP while the account's traffic
 * rides a pool is refused outright (`401/403`) — which the health surface read
 * as "rejected the stored credential" and parked working accounts over an
 * egress problem, not a credential one. The sweep's check-in leg already rode
 * the per-account pool rotation; these pin the quota leg to the same egress:
 * `quotaFetcherFor` binds the timeout signal onto the pooled fetch, falls back
 * to the direct fetch when no resolver (or resolution) exists, and the sweep
 * hands its egress resolver to the quota leg.
 */
import { describe, expect, test } from "bun:test";
import {
  quotaFetcherFor,
  signalFetchOver,
} from "../../src/providers/quota/refresh";
import {
  quotaRefreshSweep,
  type QuotaRefreshSweepDeps,
} from "../../src/workers/quota-refresh-sweep";
import type { QuotaRefreshTarget } from "../../src/providers/quota/refresh";

function pooledFetchMarker(): { fetch: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const pooled = ((input: RequestInfo | URL) => {
    calls.push(typeof input === "string" ? input : String((input as Request).url));
    return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
  }) as typeof fetch;
  // A marker the wrapper preserves (it delegates, it does not rewrap identity).
  (pooled as unknown as Record<string, unknown>).__pooled = true;
  return { fetch: pooled, calls };
}

describe("quotaFetcherFor", () => {
  test("delegates to the pooled egress and binds the signal", async () => {
    const { fetch: pooled, calls } = pooledFetchMarker();
    const fetcher = await quotaFetcherFor(
      { fetcherFor: async () => pooled },
      "acct-1",
      null,
      AbortSignal.timeout(5_000),
    );
    const response = await fetcher("https://upstream.example/usage");
    expect(response.status).toBe(200);
    // The wrapper delegates: the pooled fetch answered the call itself.
    expect(calls).toEqual(["https://upstream.example/usage"]);
  });

  test("a resolver that throws falls back to the direct fetch", async () => {
    const fetcher = await quotaFetcherFor(
      { fetcherFor: async () => Promise.reject(new Error("pool table unreadable")) },
      "acct-1",
      null,
      AbortSignal.timeout(5_000),
    );
    expect((fetcher as unknown as Record<string, unknown>).__pooled).toBeUndefined();
  });

  test("no resolver means the direct fetch, unchanged", async () => {
    const fetcher = await quotaFetcherFor({}, "acct-1", null, AbortSignal.timeout(5_000));
    expect((fetcher as unknown as Record<string, unknown>).__pooled).toBeUndefined();
  });

  test("signalFetchOver binds the signal onto the pooled fetch", async () => {
    let seenSignal: AbortSignal | null | undefined;
    const pooled = ((_input: RequestInfo | URL, init?: RequestInit) => {
      seenSignal = init?.signal;
      return Promise.resolve(new Response("{}", { status: 200 }));
    }) as unknown as typeof fetch;
    const signal = AbortSignal.timeout(5_000);
    const wrapped = signalFetchOver(pooled, signal);
    await wrapped("https://upstream.example/usage");
    expect(seenSignal).toBe(signal);
  });
});

describe("quota sweep egress", () => {
  test("the quota collector receives the account's pooled fetch", async () => {
    const { fetch: pooled, calls } = pooledFetchMarker();
    const targets: QuotaRefreshTarget[] = [
      { accountId: "acct-egress", providerId: "kiro", tenantId: null, credentialKind: "oauth" },
    ];
    const deps: QuotaRefreshSweepDeps = {
      db: {
        // `recordAccountCheck` projects the row before stamping; a chainable
        // stub that answers "no row" skips the stamp, which is all this test
        // needs.
        select: () => {
          const chain: Record<string, unknown> = {};
          chain.from = () => chain;
          chain.where = () => chain;
          chain.limit = () => chain;
          chain.then = (resolve: (rows: unknown[]) => unknown) => resolve([]);
          return chain;
        },
        update: () => ({ set: () => ({ where: async () => [] }) }),
      } as unknown as QuotaRefreshSweepDeps["db"],
      redis: undefined,
      providerRegistry: {
        resolveQuotaCollector: async () =>
          async (_credential: string, fetcher: typeof fetch) => {
            // The collector's fetcher is the wrapper over the pooled egress:
            // calling it must land on the pooled fetch, not the direct one.
            await fetcher("https://pooled-probe.example/usage");
            return { source: "stub", plan: null, windows: [], error: null };
          },
        resolveRefresher: async () => ({}),
      } as unknown as QuotaRefreshSweepDeps["providerRegistry"],
      resolveCredential: async () => "credential",
      listTargets: async () => targets,
      minAgeMs: 0,
      maxPerPass: targets.length,
      maxCheckinsPerPass: 0,
      // The sweep's egress resolver: the same per-account pool rotation the
      // check-in leg uses.
      checkinFetcherFor: async () => pooled,
    };
    await quotaRefreshSweep(deps);
    // The probe the collector dialed landed on the pooled egress — proof the
    // quota leg rides the account's own fetch, not the direct one.
    expect(calls).toContain("https://pooled-probe.example/usage");
  });
});
