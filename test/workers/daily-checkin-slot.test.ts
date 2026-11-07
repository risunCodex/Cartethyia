import { describe, expect, test } from "bun:test";
import {
  quotaRefreshSweep,
  type QuotaRefreshSweepDeps,
} from "../../src/workers/quota-refresh-sweep";
import type { QuotaRefreshTarget } from "../../src/providers/quota/refresh";
import {
  attemptDailyGrowthPass,
  ledgerKey,
  checkinDayKey,
} from "../../src/workers/daily-checkin";
import type { RedisClient } from "../../src/persistence/redis";
import {
  applySqliteMigrations,
  buildSqliteHandle,
  createSqliteDatabase,
} from "../../src/persistence/db-sqlite";
import { providerAccounts, providers } from "../../src/persistence/schema";

/**
 * The two reasons a buddy account's daily attendance only landed when an
 * operator pressed the button, never on its own.
 *
 * Both are ordering/state bugs rather than missing features, so each case
 * below fails against the code as it stood: the slot guard consumed its
 * budget before asking whether the account even had a check-in route, and a
 * status probe that answered "unavailable" kept the day's slot so no later
 * pass could retry.
 */

/**
 * One sweep pass over a hand-built target list.
 *
 * The quota leg is stubbed to succeed for every account, so the only thing
 * deciding whether the check-in ride-along runs is the slot guard itself.
 * `checkins` is what the sweep reports back, which is exactly the counter the
 * guard reads.
 */
function sweepDeps(
  providerIds: readonly string[],
  maxCheckinsPerPass: number,
  quotaError: string | null = null,
): QuotaRefreshSweepDeps {
  const targets: QuotaRefreshTarget[] = providerIds.map((providerId, index) => ({
    accountId: `acct-${index}`,
    providerId,
    tenantId: null,
    credentialKind: "oauth",
  }));
  const deps: QuotaRefreshSweepDeps = {
    db: {
      update: () => ({ set: () => ({ where: async () => [] }) }),
    } as unknown as QuotaRefreshSweepDeps["db"],
    redis: undefined,
    providerRegistry: {
      resolveQuotaCollector: async () => async () => ({
        source: "stub",
        plan: null,
        windows: [],
        error: quotaError,
      }),
      resolveRefresher: async () => ({}),
    } as unknown as QuotaRefreshSweepDeps["providerRegistry"],
    resolveCredential: async () => "credential",
    listTargets: async () => targets,
    minAgeMs: 0,
    maxPerPass: targets.length,
    maxCheckinsPerPass,
    // No Redis and a fetcher that never claims: every buddy account the guard
    // lets through still counts as one check-in attempted.
    checkinFetcher: (async () =>
      new Response(JSON.stringify({ code: 0, data: { today_checked_in: true, streak_days: 1 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch,
  };
  return deps;
}

async function runPass(
  providerIds: readonly string[],
  maxCheckinsPerPass: number,
): Promise<number> {
  let checkins = 0;
  await quotaRefreshSweep({
    ...sweepDeps(providerIds, maxCheckinsPerPass),
    onTick: (result) => {
      checkins = result.checkins;
    },
  });
  return checkins;
}

describe("quota sweep — the check-in budget is spent on buddy accounts only", () => {
  const CAP = 10;

  test("a buddy account is checked in even when it sits past the per-pass quota cap", async () => {
    // The quota leg caps a pass at two accounts, and the two oldest are not
    // buddy accounts. Without the buddy-first ordering the check-in
    // ride-along never sees the buddy row at all: it is dropped as over the
    // cap, and its attendance only happens when an operator presses the
    // button. Quota is refreshed every pass, so letting the once-a-day
    // check-in go first costs it nothing.
    const providerIds = ["anthropic", "anthropic", "cbcn"];
    let checkins = 0;
    await quotaRefreshSweep({
      ...sweepDeps(providerIds, CAP),
      maxPerPass: 2,
      // Oldest first, and the buddy row is the youngest, so age ordering
      // alone would drop it.
      now: () => 1_000,
      onTick: (result) => {
        checkins = result.checkins;
      },
    });
    expect(checkins).toBe(1);
  });

  test("the cap still bounds real buddy check-ins", async () => {
    // Run one at a time so the count the guard reads is the count of
    // check-ins that already finished, not a stale value shared across a
    // wave. A cap that is only checked after the pass resolves lets the
    // whole wave through.
    const providerIds = Array.from({ length: CAP + 3 }, () => "cbcn");
    let checkins = 0;
    await quotaRefreshSweep({
      ...sweepDeps(providerIds, CAP),
      maxConcurrency: 1,
      onTick: (result) => {
        checkins = result.checkins;
      },
    });
    expect(checkins).toBe(CAP);
  });

  test("every buddy variant is covered, not just one", async () => {
    expect(await runPass(["cb", "cbcn"], CAP)).toBe(2);
  });

  test("a failed quota fetch still attempts the check-in", async () => {
    // The regression: the ride-along returned early on any quota failure, so an
    // account sitting at 0 credits — the one that most needs the daily grant —
    // never had its check-in attempted and the page read "Check-in due" while
    // the sweep believed it had done its job. The two legs are separate
    // upstream calls on one resolved credential.
    let checkins = 0;
    await quotaRefreshSweep({
      ...sweepDeps(["cbcn"], CAP, "quota unavailable"),
      onTick: (result) => {
        checkins = result.checkins;
      },
    });
    expect(checkins).toBe(1);
  });

  test("resolves credentials again on the next sweep pass", async () => {
    let resolutions = 0;
    const accountId = "quota-credential-refresh-regression";
    const deps = sweepDeps(["anthropic"], 0);
    const passDeps: QuotaRefreshSweepDeps = {
      ...deps,
      listTargets: async () => [{
        accountId,
        providerId: "anthropic",
        tenantId: null,
        credentialKind: "oauth",
      }],
      resolveCredential: async () => `credential-${++resolutions}`,
    };

    await quotaRefreshSweep(passDeps);
    await quotaRefreshSweep(passDeps);

    expect(resolutions).toBe(2);
  });
});

/** Minimal Redis double: only the commands the ledger uses. */
function fakeRedis(): RedisClient & { readonly store: Map<string, string> } {
  const store = new Map<string, string>();
  const client = {
    store,
    set: async (key: string, value: string, ...rest: unknown[]) => {
      const nx = rest.includes("NX");
      if (nx && store.has(key)) return null;
      store.set(key, value);
      return "OK";
    },
    del: async (key: string) => {
      const had = store.delete(key);
      return had ? 1 : 0;
    },
    get: async (key: string) => store.get(key) ?? null,
  };
  return client as unknown as RedisClient & { readonly store: Map<string, string> };
}

describe("attemptDailyGrowthPass — the report leg and the day slot", () => {
  const NOW = new Date("2026-07-08T03:00:00Z");

  function fetcherAnswering(body: unknown): typeof fetch {
    return (async () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
  }

  test("the check-in pass no longer runs the activity report", async () => {
    // The report moved to its own once-a-day growth task
    // (`buddy-activity-report`) with its own ledger. The check-in pass is the
    // claim alone now, so an unavailable check-in answers `unavailable` without
    // touching the report leg at all.
    const redis = fakeRedis();
    const pass = await attemptDailyGrowthPass({
      db: undefined,
      redis,
      providerId: "cbcn",
      accountId: "acct-1",
      resolveCredential: async () => "credential",
      fetcher: fetcherAnswering({ code: 0, data: {} }),
      now: () => NOW,
    });
    expect(pass?.checkin.state).toBe("unavailable");
    expect(Object.keys(pass ?? {})).toEqual(["checkin"]);
  });
  test("an unavailable check-in keeps the slot, so the day is not retried forever", async () => {
    const redis = fakeRedis();
    // The status endpoint answers 200 with an envelope the gateway cannot read
    // as a check-in — the shape `fetchDailyCheckin` reports as `unavailable`,
    // i.e. no activity is running. Releasing the marker here both retried a
    // closed door every pass *and* erased the evidence of the attempt, so the
    // console read "Check-in due" forever.
    const first = await attemptDailyGrowthPass({
      db: undefined,
      redis,
      providerId: "cbcn",
      accountId: "acct-1",
      resolveCredential: async () => "credential",
      fetcher: fetcherAnswering({ code: 0, data: {} }),
      now: () => NOW,
    });
    expect(first?.checkin.state).toBe("unavailable");
    expect(redis.store.has(ledgerKey(checkinDayKey(NOW), "acct-1"))).toBe(true);

    const second = await attemptDailyGrowthPass({
      db: undefined,
      redis,
      providerId: "cbcn",
      accountId: "acct-1",
      resolveCredential: async () => "credential",
      fetcher: fetcherAnswering({ code: 0, data: {} }),
      now: () => NOW,
    });
    expect(second).toBeNull();
  });

  test("a settled claim keeps the slot, so the day is not re-attempted", async () => {
    const redis = fakeRedis();
    const pass = await attemptDailyGrowthPass({
      db: undefined,
      redis,
      providerId: "cbcn",
      accountId: "acct-2",
      resolveCredential: async () => "credential",
      fetcher: fetcherAnswering({
        code: 0,
        data: { today_checked_in: true, streak_days: 4 },
      }),
      now: () => NOW,
    });
    expect(pass?.checkin.state).toBe("already_claimed");
    expect(redis.store.has(ledgerKey(checkinDayKey(NOW), "acct-2"))).toBe(true);

    const again = await attemptDailyGrowthPass({
      db: undefined,
      redis,
      providerId: "cbcn",
      accountId: "acct-2",
      resolveCredential: async () => "credential",
      fetcher: fetcherAnswering({ code: 0, data: { today_checked_in: true } }),
      now: () => NOW,
    });
    expect(again).toBeNull();
  });

  test("the SQLite ledger reserves a daily slot only once without Redis", async () => {
    const sqlite = createSqliteDatabase(":memory:");
    await applySqliteMigrations(sqlite);
    const { db, close } = buildSqliteHandle(sqlite);
    try {
      // `daily_checkin_ledger.account_id` now references `provider_accounts.id`
      // (the orphan-prevention FK), so the ledger needs a real account row.
      await db.insert(providers).values({ id: "cbcn" });
      await db.insert(providerAccounts).values({
        id: "sqlite-ledger-account",
        providerId: "cbcn",
        tenantId: null,
        label: "ledger",
        credentialKind: "oauth",
        credentialFingerprint: "fp-ledger",
      });
      const args = {
        db,
        redis: undefined,
        providerId: "cbcn" as const,
        accountId: "sqlite-ledger-account",
        resolveCredential: async () => "credential",
        fetcher: fetcherAnswering({
          code: 0,
          data: { today_checked_in: true, streak_days: 1 },
        }),
        now: () => NOW,
      };

      const first = await attemptDailyGrowthPass(args);
      const second = await attemptDailyGrowthPass(args);

      expect(first?.checkin.state).toBe("already_claimed");
      expect(second).toBeNull();
    } finally {
      await close();
    }
  });
});
