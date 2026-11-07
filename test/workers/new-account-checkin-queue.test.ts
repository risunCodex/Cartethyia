import { beforeEach, describe, expect, test } from "bun:test";
import {
  clearPendingCheckinRequests,
  enqueueCheckin,
  pendingCheckinCount,
  pendingCheckinRequests,
} from "../../src/workers/daily-checkin";
import { quotaRefreshSweep } from "../../src/workers/quota-refresh-sweep";
import type { QuotaRefreshSweepDeps } from "../../src/workers/quota-refresh-sweep";
import type { QuotaRefreshTarget } from "../../src/providers/quota/refresh";
import type { PendingCheckinRequest } from "../../src/workers/daily-checkin";
import { GLOBAL_QUOTA_LENS, setCachedQuota } from "../../src/providers/quota/cache";

/**
 * A newly imported buddy account used to wait a full sweep cycle before it
 * could claim its daily credit.
 *
 * The import deliberately makes no upstream call so a paste of many
 * credentials lands as one local write, so the claim has to happen afterwards.
 * The queue is what carries it: the import records the id, and the sweep —
 * which already holds the refreshed credential, the rotated egress, and the
 * once-per-day marker — drains it on its next pass.
 */

function target(accountId: string, providerId: string): QuotaRefreshTarget {
  return { accountId, providerId, tenantId: null, credentialKind: "oauth" };
}

/** Fixed clock for the sweep, so "seconds old" stays a real age. */
const NOW = 1_700_000_000_000;

/**
 * Seeds the in-process quota cache so an account has a real cache age.
 *
 * Without an entry `cachedQuotaAgeMs` answers `Infinity` and the freshness gate
 * passes for everything, which would make the "still skipped" case below pass
 * for the wrong reason.
 */
async function seedCacheAge(accountId: string, at: Date): Promise<void> {
  await setCachedQuota(
    GLOBAL_QUOTA_LENS,
    accountId,
    { source: "stub", plan: null, windows: [], error: null },
    undefined,
    at,
  );
}

/** A sweep pass whose check-in leg records every account it was offered. */
function sweepDeps(targets: readonly QuotaRefreshTarget[], minAgeMs: number): QuotaRefreshSweepDeps {
  return {
    db: {
      update: () => ({ set: () => ({ where: async () => [] }) }),
    } as unknown as QuotaRefreshSweepDeps["db"],
    redis: undefined,
    providerRegistry: {
      resolveQuotaCollector: async () => async () => ({
        source: "stub",
        plan: null,
        windows: [],
        error: null,
      }),
      resolveRefresher: async () => ({}),
    } as unknown as QuotaRefreshSweepDeps["providerRegistry"],
    resolveCredential: async () => "credential",
    listTargets: async () => targets,
    // A fetcher that never claims: what matters is which accounts the sweep
    // decided to offer the check-in to, not what upstream answered.
    checkinFetcher: (async () => new Response(JSON.stringify({ code: 0, data: { active: true } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch,
    minAgeMs,
    maxPerPass: targets.length,
    maxCheckinsPerPass: targets.length,
    now: () => NOW,
  };
}

beforeEach(() => {
  clearPendingCheckinRequests();
});

describe("enqueueCheckin — only accounts the check-in can serve", () => {
  test("a buddy provider is queued", () => {
    expect(enqueueCheckin({ accountId: "a1", providerId: "cb", tenantId: null })).toBe(true);
    expect(pendingCheckinCount()).toBe(1);
  });

  test("a non-buddy provider is refused rather than queued to be dropped", () => {
    // Refusing is the point: the caller can skip the work instead of enqueuing
    // something the sweep would silently discard.
    expect(enqueueCheckin({ accountId: "a1", providerId: "deepseek", tenantId: null })).toBe(false);
    expect(pendingCheckinCount()).toBe(0);
  });

  test("re-enqueueing an already-queued account does not duplicate it", () => {
    enqueueCheckin({ accountId: "a1", providerId: "cb", tenantId: null });
    enqueueCheckin({ accountId: "a1", providerId: "cb", tenantId: null });
    expect(pendingCheckinCount()).toBe(1);
  });

  test("the queue is bounded", () => {
    for (let n = 0; n < 200; n += 1) {
      expect(enqueueCheckin({ accountId: `a${n}`, providerId: "cb", tenantId: null })).toBe(true);
    }
    // One over the cap is refused rather than growing the map without limit.
    expect(enqueueCheckin({ accountId: "overflow", providerId: "cb", tenantId: null })).toBe(false);
    expect(pendingCheckinCount()).toBe(200);
  });
});

describe("quotaRefreshSweep — a queued new account is admitted while fresh", () => {
  test("an account newer than the freshness gate still gets its check-in", async () => {
    // The account's cached reading is seconds old and `minAgeMs` is an hour, so
    // the usual gate would drop it. Being queued is what admits it.
    const targets = [target("new-1", "cb")];
    await seedCacheAge("new-1", new Date(NOW));
    enqueueCheckin({ accountId: "new-1", providerId: "cb", tenantId: null });
    const attempted: string[] = [];
    await quotaRefreshSweep({
      ...sweepDeps(targets, 60 * 60_000),
      listPendingCheckins: () => pendingCheckinRequests(),
      checkinFetcher: (async () => {
        attempted.push("new-1");
        return new Response(JSON.stringify({ code: 0, data: { active: true } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch,
    });
    // Compared as a set: one account, however many requests its pass took. The
    // status probe and the claim are both hits on the same fetcher, so counting
    // calls would assert the upstream contract, not the sweep's admission.
    expect(new Set(attempted)).toEqual(new Set(["new-1"]));
  });

  test("a fresh account that was not queued is still skipped", async () => {
    // Proves the queue is what admitted it above, not a blanket removal of the
    // freshness gate.
    const targets = [target("fresh-1", "cb")];
    await seedCacheAge("fresh-1", new Date(NOW));
    const attempted: string[] = [];
    await quotaRefreshSweep({
      ...sweepDeps(targets, 60 * 60_000),
      listPendingCheckins: () => pendingCheckinRequests(),
      checkinFetcher: (async () => {
        attempted.push("fresh-1");
        return new Response(JSON.stringify({ code: 0, data: { active: true } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch,
    });
    expect(attempted).toEqual([]);
  });

  test("the sweep drains what it served, so the next pass does not redo it", async () => {
    const targets = [target("new-2", "cbcn")];
    await seedCacheAge("new-2", new Date(NOW));
    enqueueCheckin({ accountId: "new-2", providerId: "cbcn", tenantId: null });
    expect(pendingCheckinCount()).toBe(1);
    await quotaRefreshSweep({
      ...sweepDeps(targets, 60 * 60_000),
      listPendingCheckins: () => pendingCheckinRequests(),
    });
    expect(pendingCheckinCount()).toBe(0);
  });

  test("a queued request for a provider outside the family is not admitted", async () => {
    // The queue refuses these at the door, but the sweep filters again: an
    // injected or legacy entry must not buy a check-in attempt.
    const targets = [target("other-1", "deepseek")];
    await seedCacheAge("other-1", new Date(NOW));
    const forced: readonly PendingCheckinRequest[] = [
      { accountId: "other-1", providerId: "deepseek", tenantId: null },
    ];
    const attempted: string[] = [];
    await quotaRefreshSweep({
      ...sweepDeps(targets, 60 * 60_000),
      listPendingCheckins: () => forced,
      checkinFetcher: (async () => {
        attempted.push("other-1");
        return new Response(JSON.stringify({ code: 0, data: { active: true } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch,
    });
    expect(attempted).toEqual([]);
  });
});
