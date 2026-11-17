/**
 * Cursor quota: the two account surfaces, the plan-info weekly reset, and the
 * family split between the two included rails.
 *
 * The invariants under test:
 * 1. The summary outranks the legacy surface entirely — the two count
 *    different currencies (dollars vs requests) and one mixed list would
 *    cross-gate one with the other. The legacy parse stays the api-key
 *    fallback, with empty-bucket suppression (an uncapped zero `gpt-4` row is
 *    not a balance).
 * 2. A quiet surface is a downgrade, not a failure: consumers read a non-null
 *    `error` as "no usable reading at all" (HTTP 502, cache discard), so a
 *    good fallback read must not be mislabeled. `error` is only set when no
 *    window could be produced.
 * 3. The two named rails fund disjoint families ("Cursor Models" vs "Other
 *    Models"): a spent prepaid balance must not mark a Grok request
 *    exhausted, and an empty weekly pool must not refuse a Claude request.
 * 4. Percent-only rails stay percentages — `plan.limit` is not the Other
 *    Models pool size (percent × limit would report $193.76 of $400 for an
 *    account whose real third-party spend was $48.44 of a $100 pool).
 */
import { describe, expect, test } from "bun:test";
import {
  fetchCursorQuota,
  parseLegacyUsage,
  parseUsageSummary,
} from "../../src/providers/integrations/cursor/cursor-quota";
import {
  CURSOR_API_BASE_URL,
  CURSOR_AUTH_USAGE_PATH,
  CURSOR_GET_PLAN_INFO_PATH,
  CURSOR_USAGE_SUMMARY_PATH,
  CURSOR_WEBSITE_BASE_URL,
} from "../../src/providers/integrations/cursor/cursor-wire";
import { fnv1a32 } from "../../src/providers/integrations/shared/hash";
import { filterCandidateQuotaWindows } from "../../src/transport/routing/candidate-evaluation";
import type { ProviderQuotaWindow } from "../../src/providers/quota/quota-contracts";

// ── fake transport ──

interface RecordedCall {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string | null;
}

interface Route {
  readonly status: number;
  readonly body: unknown;
}

/** A fetch that answers by URL and records what each surface received. */
function fakeCursorFetch(routes: Readonly<Record<string, Route>>): {
  fetcher: typeof fetch;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const fetcher = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers: { ...((init?.headers ?? {}) as Record<string, string>) },
      body: typeof init?.body === "string" ? init.body : null,
    });
    const route = routes[url];
    if (route === undefined) return new Response("no route", { status: 404 });
    return new Response(JSON.stringify(route.body), { status: route.status });
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

const LEGACY_URL = `${CURSOR_API_BASE_URL}${CURSOR_AUTH_USAGE_PATH}`;
const SUMMARY_URL = `${CURSOR_WEBSITE_BASE_URL}${CURSOR_USAGE_SUMMARY_PATH}`;
const PLAN_INFO_URL = `${CURSOR_API_BASE_URL}${CURSOR_GET_PLAN_INFO_PATH}`;

/** A bearer credential whose JWT `sub` is the account identity. */
function fakeJwt(subject: string): string {
  const payload = Buffer.from(JSON.stringify({ sub: subject }), "utf8").toString("base64url");
  return `eyJhbGciOiJub25lIn0.${payload}.sig`;
}

const OAUTH_CREDENTIAL = fakeJwt("google-oauth2|user_01TEST");
const API_KEY_CREDENTIAL = "crsr_raw_key_without_identity";

// ── legacy surface ──

describe("Cursor quota — legacy surface", () => {
  test("an uncapped zero bucket is suppressed, not reported as a balance", () => {
    // Usage-based plans answer `/auth/usage` with this exact shape while
    // their real spend sits on the summary.
    expect(parseLegacyUsage({ "gpt-4": { numRequests: 0, maxRequestUsage: null } })).toEqual([]);
  });

  test("a capped request bucket becomes a model-scoped window", () => {
    const windows = parseLegacyUsage({ "gpt-4": { numRequests: 12, maxRequestUsage: 500 } });
    expect(windows).toHaveLength(1);
    expect(windows[0]!.kind).toBe("cursor:requests:gpt-4");
    expect(windows[0]!.modelIds).toEqual(["gpt-4"]);
    expect(windows[0]!.used).toBe(12);
    expect(windows[0]!.limit).toBe(500);
    expect(windows[0]!.accounting).toBe("independent");
  });

  test("a usd-spelling key becomes a usd window without model scoping", () => {
    const windows = parseLegacyUsage({ planUsage: { usdUsed: 250, usdLimit: 1000 } });
    expect(windows).toHaveLength(1);
    expect(windows[0]!.kind).toBe("cursor:usd:planusage");
    expect(windows[0]!.modelIds).toBeUndefined();
    expect(windows[0]!.used).toBe(250);
    expect(windows[0]!.limit).toBe(1000);
  });
});

// ── summary surface ──

describe("Cursor quota — classic plan rails", () => {
  const classic = {
    individualUsage: {
      planName: "Ultra",
      plan: { enabled: true, limit: 40000, autoPercentUsed: 12, apiPercentUsed: 48.44, totalPercentUsed: 30 },
    },
  };

  test("the two rails stay percentages — the $193.76/$400 regression", () => {
    // `plan.limit` (40000 cents = $400) is the plan's own cap, not the Other
    // Models pool. Percent × limit would report $193.76 of $400 for an
    // account whose real third-party spend was $48.44 of a $100 pool.
    const { windows, plan } = parseUsageSummary(classic);
    expect(plan).toBe("Ultra");
    expect(windows.map((w) => w.kind)).toEqual(["cursor:usd:individual-auto", "cursor:usd:individual-api"]);

    const api = windows[1]!;
    expect(api.label).toBe("Other Models");
    expect(api.usedPercent).toBe(48.44);
    expect(api.used).toBeNull();
    expect(api.limit).toBeNull();

    const auto = windows[0]!;
    expect(auto.label).toBe("Cursor Models");
    expect(auto.usedPercent).toBe(12);
    expect(auto.used).toBeNull();
  });

  test("a usable overall bucket wins over the plan rails and reports cents as USD", () => {
    const { windows } = parseUsageSummary({
      individualUsage: {
        planName: "Pro",
        overall: { enabled: true, used: 2550, limit: 20000 },
        plan: classic.individualUsage.plan,
      },
    });
    expect(windows.map((w) => w.kind)).toEqual(["cursor:usd:individual-overall"]);
    expect(windows[0]!.used).toBe(25.5);
    expect(windows[0]!.limit).toBe(200);
    expect(windows[0]!.usedPercent).toBeCloseTo(12.75);
    expect(windows[0]!.accounting).toBe("independent");
  });

  test("on-demand spend is kept as pooled credit only when it carries a real cap", () => {
    const withCap = parseUsageSummary({
      individualUsage: { plan: { enabled: true, totalPercentUsed: 5 }, onDemand: { enabled: true, used: 100, limit: 5000 } },
    });
    const meter = withCap.windows.find((w) => w.kind === "cursor:usd:individual-ondemand");
    expect(meter).toBeDefined();
    expect(meter!.used).toBe(1);
    expect(meter!.limit).toBe(50);
    expect(meter!.accounting).toBe("pooled");

    const uncapped = parseUsageSummary({
      individualUsage: { plan: { enabled: true, totalPercentUsed: 5 }, onDemand: { enabled: true, used: 100 } },
    });
    expect(uncapped.windows.some((w) => w.kind === "cursor:usd:individual-ondemand")).toBe(false);
  });
});

describe("Cursor quota — unified membership (X Subscription)", () => {
  const unified = {
    membershipType: "unified_creator",
    individualUsage: {
      planName: "X Subscription",
      plan: { enabled: true, limit: 10000, used: 2500, totalPercentUsed: 25 },
      onDemand: { enabled: true, used: 500, limit: 5000 },
    },
  };

  test("the weekly pool and the prepaid credit are two disjoint windows", () => {
    const { windows } = parseUsageSummary(unified, "2026-12-01T00:00:00.000Z");
    expect(windows.map((w) => w.kind)).toEqual(["cursor:usd:individual-auto", "cursor:usd:individual-api"]);

    const pool = windows[0]!;
    expect(pool.label).toBe("Cursor Models");
    expect(pool.resetsAt).toBe("2026-12-01T00:00:00.000Z");
    // 2500 of 10000 cents consumed → $25 of the $100 weekly pool.
    expect(pool.used).toBe(25);
    expect(pool.limit).toBe(100);
    expect(pool.accounting).toBe("independent");

    const credit = windows[1]!;
    expect(credit.label).toBe("Other Models (prepaid credit)");
    expect(credit.used).toBe(5);
    expect(credit.limit).toBe(50);
    // Prepaid credit has no calendar reset: a pinned reset would keep an
    // empty balance visible as "not yet reset" instead of "top it up".
    expect(credit.resetsAt).toBeNull();
    expect(credit.accounting).toBe("pooled");
  });

  test("prepaid credit that is off is a spent 0/0 balance, not an absent one", () => {
    for (const onDemand of [{ enabled: false }, { enabled: true, limit: 0 }]) {
      const { windows } = parseUsageSummary({
        membershipType: "unified_creator",
        individualUsage: { plan: unified.individualUsage.plan, onDemand },
      });
      const credit = windows.find((w) => w.kind === "cursor:usd:individual-api");
      expect(credit).toBeDefined();
      expect(credit!.usedPercent).toBe(100);
      expect(credit!.used).toBe(0);
      expect(credit!.limit).toBe(0);
      expect(credit!.accounting).toBe("pooled");
    }
  });
});

// ── family scoping ──

describe("Cursor quota — family scoping", () => {
  test("the two named rails never cross-gate each other's family", () => {
    const { windows } = parseUsageSummary(
      {
        membershipType: "unified_creator",
        individualUsage: {
          plan: { enabled: true, limit: 10000, used: 2500, totalPercentUsed: 25 },
          onDemand: { enabled: false },
        },
      },
      "2026-12-01T00:00:00.000Z",
    );
    // The prepaid-off window is fully spent: it must not reach Grok.
    const grok = filterCandidateQuotaWindows(windows, { provider_id: "cursor", model_id: "grok-4.7" });
    expect(grok.map((w) => w.kind)).toEqual(["cursor:usd:individual-auto"]);

    const composer = filterCandidateQuotaWindows(windows, { provider_id: "cursor", model_id: "composer-2.5" });
    expect(composer.map((w) => w.kind)).toEqual(["cursor:usd:individual-auto"]);

    const claude = filterCandidateQuotaWindows(windows, { provider_id: "cursor", model_id: "claude-opus-5-high" });
    expect(claude.map((w) => w.kind)).toEqual(["cursor:usd:individual-api"]);

    // Unknown ids default to the third-party side: the owned families are a
    // closed set (Grok, Composer, Auto).
    const unknown = filterCandidateQuotaWindows(windows, { provider_id: "cursor", model_id: "some-new-model" });
    expect(unknown.map((w) => w.kind)).toEqual(["cursor:usd:individual-api"]);
  });

  test("account-wide meters and model-scoped request buckets pass through untouched", () => {
    const windows: ProviderQuotaWindow[] = [
      {
        kind: "cursor:usd:individual-overall",
        label: "Personal Usage",
        accounting: "independent",
        usedPercent: 10,
        remainingPercent: 90,
        resetsAt: null,
      },
      {
        kind: "cursor:requests:gpt-4",
        label: "gpt-4 requests",
        accounting: "independent",
        usedPercent: 50,
        remainingPercent: 50,
        resetsAt: null,
        modelIds: ["gpt-4"],
      },
    ];
    const forGrok = filterCandidateQuotaWindows(windows, { provider_id: "cursor", model_id: "grok-4.7" });
    expect(forGrok.map((w) => w.kind)).toEqual(["cursor:usd:individual-overall"]);
    const forGpt = filterCandidateQuotaWindows(windows, { provider_id: "cursor", model_id: "gpt-4" });
    expect(forGpt.map((w) => w.kind)).toEqual(["cursor:usd:individual-overall", "cursor:requests:gpt-4"]);
  });
});

// ── fetch orchestration ──

describe("Cursor quota — fetch orchestration", () => {
  test("the summary outranks the legacy surface entirely", async () => {
    const { fetcher, calls } = fakeCursorFetch({
      [LEGACY_URL]: { status: 200, body: { "gpt-4": { numRequests: 12, maxRequestUsage: 500 } } },
      [SUMMARY_URL]: {
        status: 200,
        body: { individualUsage: { planName: "Pro", overall: { enabled: true, used: 2550, limit: 20000 } } },
      },
    });
    const result = await fetchCursorQuota(OAUTH_CREDENTIAL, fetcher);
    expect(result.error).toBeNull();
    expect(result.plan).toBe("Pro");
    // The legacy request bucket must not ride along: the surfaces count
    // different currencies and routing gates by the lowest remaining percent.
    expect(result.windows.map((w) => w.kind)).toEqual(["cursor:usd:individual-overall"]);
    expect(calls.map((c) => c.url).sort()).toEqual([LEGACY_URL, SUMMARY_URL].sort());
  });

  test("an api-key account without an identity never touches the cookie surface", async () => {
    const { fetcher, calls } = fakeCursorFetch({
      [LEGACY_URL]: { status: 200, body: { "gpt-4": { numRequests: 12, maxRequestUsage: 500 } } },
      [SUMMARY_URL]: { status: 500, body: {} },
    });
    const result = await fetchCursorQuota(API_KEY_CREDENTIAL, fetcher);
    expect(calls.map((c) => c.url)).toEqual([LEGACY_URL]);
    expect(result.error).toBeNull();
    expect(result.windows.map((w) => w.kind)).toEqual(["cursor:requests:gpt-4"]);
  });

  test("the summary authenticates with the session cookie, never a bearer header", async () => {
    const { fetcher, calls } = fakeCursorFetch({
      [LEGACY_URL]: { status: 200, body: {} },
      [SUMMARY_URL]: {
        status: 200,
        body: { individualUsage: { planName: "Pro", overall: { enabled: true, used: 1, limit: 100 } } },
      },
    });
    await fetchCursorQuota(OAUTH_CREDENTIAL, fetcher);
    const summary = calls.find((c) => c.url === SUMMARY_URL)!;
    expect(summary.headers["cookie"]).toBe(
      `WorkosCursorSessionToken=${encodeURIComponent(`google-oauth2|user_01TEST::${OAUTH_CREDENTIAL}`)}`,
    );
    expect(summary.headers["authorization"]).toBeUndefined();
    // The legacy surface keeps bearer auth.
    const legacy = calls.find((c) => c.url === LEGACY_URL)!;
    expect(legacy.headers["authorization"]).toBe(`Bearer ${OAUTH_CREDENTIAL}`);
  });

  test("the account tag is stable across reads and derived, not random", async () => {
    const routes = {
      [LEGACY_URL]: { status: 200, body: { "gpt-4": { numRequests: 1, maxRequestUsage: 10 } } },
    };
    const first = await fetchCursorQuota(OAUTH_CREDENTIAL, fakeCursorFetch(routes).fetcher);
    const second = await fetchCursorQuota(OAUTH_CREDENTIAL, fakeCursorFetch(routes).fetcher);
    expect(first.accountLabel).toBe(second.accountLabel);
    expect(first.accountLabel).toMatch(/^cursor-[0-9a-z]{7}$/);
    expect(first.accountLabel).toBe(`cursor-${fnv1a32(OAUTH_CREDENTIAL).toString(36).padStart(7, "0").slice(0, 7)}`);
  });

  test("GetPlanInfo supplies the weekly reset and is only called for unified memberships", async () => {
    const resetMs = 1_773_000_000_000;
    const { fetcher, calls } = fakeCursorFetch({
      [LEGACY_URL]: { status: 200, body: {} },
      [SUMMARY_URL]: {
        status: 200,
        body: {
          membershipType: "unified_creator",
          individualUsage: {
            plan: { enabled: true, limit: 10000, used: 2500, totalPercentUsed: 25 },
            onDemand: { enabled: true, used: 500, limit: 5000 },
          },
        },
      },
      [PLAN_INFO_URL]: { status: 200, body: { planInfo: { includedUsageResetsAt: resetMs } } },
    });
    const result = await fetchCursorQuota(OAUTH_CREDENTIAL, fetcher);
    expect(result.error).toBeNull();
    const pool = result.windows.find((w) => w.kind === "cursor:usd:individual-auto")!;
    expect(pool.resetsAt).toBe(new Date(resetMs).toISOString());

    const planInfo = calls.find((c) => c.url === PLAN_INFO_URL)!;
    // Connect-JSON unary: empty request body, protocol version pinned.
    expect(planInfo.method).toBe("POST");
    expect(planInfo.body).toBe("{}");
    expect(planInfo.headers["connect-protocol-version"]).toBe("1");
    expect(planInfo.headers["authorization"]).toBe(`Bearer ${OAUTH_CREDENTIAL}`);
  });

  test("a classic membership never fetches GetPlanInfo", async () => {
    const { fetcher, calls } = fakeCursorFetch({
      [LEGACY_URL]: { status: 200, body: {} },
      [SUMMARY_URL]: {
        status: 200,
        body: { individualUsage: { planName: "Pro", overall: { enabled: true, used: 1, limit: 100 } } },
      },
      [PLAN_INFO_URL]: { status: 200, body: { planInfo: { includedUsageResetsAt: 1_773_000_000_000 } } },
    });
    await fetchCursorQuota(OAUTH_CREDENTIAL, fetcher);
    expect(calls.some((c) => c.url === PLAN_INFO_URL)).toBe(false);
  });

  test("a failed plan-info read degrades to a reset-less pool, not to an error", async () => {
    const { fetcher } = fakeCursorFetch({
      [LEGACY_URL]: { status: 200, body: {} },
      [SUMMARY_URL]: {
        status: 200,
        body: {
          membershipType: "unified_creator",
          individualUsage: { plan: { enabled: true, limit: 10000, used: 0, totalPercentUsed: 0 }, onDemand: { enabled: true, used: 0, limit: 100 } },
        },
      },
      [PLAN_INFO_URL]: { status: 500, body: {} },
    });
    const result = await fetchCursorQuota(OAUTH_CREDENTIAL, fetcher);
    expect(result.error).toBeNull();
    const pool = result.windows.find((w) => w.kind === "cursor:usd:individual-auto")!;
    expect(pool.resetsAt).toBeNull();
  });

  test("a quiet summary surface degrades to the legacy read instead of failing it", async () => {
    const { fetcher } = fakeCursorFetch({
      [LEGACY_URL]: { status: 200, body: { "gpt-4": { numRequests: 12, maxRequestUsage: 500 } } },
      [SUMMARY_URL]: { status: 401, body: { error: "not_authenticated" } },
    });
    const result = await fetchCursorQuota(OAUTH_CREDENTIAL, fetcher);
    // Consumers read `error` as "no usable reading at all" — the legacy
    // window IS a usable reading, so the downgrade must not surface here.
    expect(result.error).toBeNull();
    expect(result.windows.map((w) => w.kind)).toEqual(["cursor:requests:gpt-4"]);
  });

  test("with no usable reading at all the error names every quiet surface", async () => {
    const { fetcher } = fakeCursorFetch({
      [LEGACY_URL]: { status: 500, body: {} },
      [SUMMARY_URL]: { status: 401, body: { error: "not_authenticated" } },
    });
    const result = await fetchCursorQuota(OAUTH_CREDENTIAL, fetcher);
    expect(result.windows).toEqual([]);
    expect(result.error).toContain("auth/usage");
    expect(result.error).toContain("usage-summary");
  });
});
