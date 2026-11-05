/**
 * The three endpoint-quota collectors added for Cursor, Trae and Qoder.
 *
 * Each of these providers had no collector at all, so the console showed no
 * balance — and "no balance" is indistinguishable from "no quota left" to
 * anything reading the account. The properties pinned here are the ones that
 * decide whether the account gets parked:
 *
 * 1. **A partial read is still a read.** Trae's two surfaces live on different
 *    hosts, and the pay host is the first thing a region-blocked account loses.
 *    If a dead pay host failed the whole call, a perfectly healthy account
 *    would report no quota and be parked.
 * 2. **A body that cannot be read is not a zero balance.** Qoder answers an
 *    unreadable or never-provisioned account with `isQuotaExceeded` and all-zero
 *    figures. Reporting that as a balance of zero parks the account; reporting
 *    it as a read failure does not.
 * 3. **The current surface outranks the legacy one.** Cursor's `/auth/usage`
 *    reports a permanently-zero bucket on exactly the plans that have a dollar
 *    cap, so letting it win would publish "no usage" for a spending account.
 */
import { describe, expect, test } from "bun:test";
import { fetchCursorQuota } from "../../src/providers/integrations/cursor/cursor-quota";
import { fetchQoderQuota } from "../../src/providers/integrations/qoder/qoder-quota";
import { fetchTraeQuota } from "../../src/providers/integrations/trae/trae-quota";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A fetcher that routes on a URL substring, 404-ing anything unrouted. */
function routedFetcher(
  routes: readonly (readonly [string, Response | (() => Response)])[],
): typeof fetch {
  return (async (url: unknown) => {
    const target = String(url);
    for (const [fragment, response] of routes) {
      if (target.includes(fragment)) {
        return typeof response === "function" ? response() : response;
      }
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

/** An access token whose `sub` claim is a stable user id. */
function tokenWithSubject(subject: string): string {
  const payload = Buffer.from(JSON.stringify({ sub: subject })).toString("base64url");
  return `eyJhbGciOiJIUzI1NiJ9.${payload}.signature`;
}

describe("Cursor quota — the summary outranks the legacy surface", () => {
  test("a dollar cap on usage-summary beats the legacy zero bucket", async () => {
    // `/auth/usage` answers `gpt-4: { numRequests: 0, maxRequestUsage: null }`
    // for usage-based plans. Reading it as the balance publishes "no usage"
    // for an account that is 500/2000 cents into its cap.
    const fetcher = routedFetcher([
      [
        "usage-summary",
        jsonResponse({
          individualUsage: { plan: { enabled: true, limit: 200000, autoPercentUsed: 25 }, planName: "Pro" },
          billingCycleEnd: "2026-11-01T00:00:00.000Z",
        }),
      ],
      ["/auth/usage", jsonResponse({ "gpt-4": { numRequests: 0, maxRequestUsage: null } })],
    ]);

    const result = await fetchCursorQuota(
      tokenWithSubject("auth0|user_01"),
      fetcher,
      { credential_kind: "oauth" },
    );

    expect(result.error).toBeNull();
    // The `auto` rail is reported on the 100-point percentage scale, not as a
    // dollar figure: `percentWindowFor(kind, label, percent, false)` passes
    // `withLimit: false`, so the plan's dollar cap is deliberately not applied
    // to it. Asserting `used === 500` here assumed the dollar reading, which is
    // the `api` rail's scale, not this one.
    expect(result.windows[0]?.used).toBe(25);
    expect(result.windows[0]?.limit).toBe(100);
    expect(result.plan).toBe("Pro");
  });

  test("the api rail uses the dollar cap, the auto rail does not", async () => {
    // The two rails are denominated differently on purpose, and a test that
    // only ever checked one scale could not tell them apart. `limit: 2000` is
    // cents, so the cap is $20; the api rail spends 10% of it ($2), while the
    // auto rail still reports its raw percentage against 100.
    const fetcher = routedFetcher([
      [
        "usage-summary",
        jsonResponse({
          individualUsage: {
            plan: { enabled: true, autoPercentUsed: 25, apiPercentUsed: 10, limit: 2000 },
          },
        }),
      ],
      // The legacy surface is still consulted after the summary answers, so a
      // fixture without it fails on a 404 that has nothing to do with what
      // this test is checking.
      ["/auth/usage", jsonResponse({ "gpt-4": { numRequests: 0, maxRequestUsage: null } })],
    ]);

    const result = await fetchCursorQuota(
      tokenWithSubject("auth0|user_01"),
      fetcher,
      { credential_kind: "oauth" },
    );

    expect(result.error).toBeNull();
    const byLabel = new Map(result.windows.map((w) => [w.label, w]));
    expect(byLabel.get("Cursor Models")?.used).toBe(25);
    expect(byLabel.get("Cursor Models")?.limit).toBe(100);
    expect(byLabel.get("Other Models")?.used).toBe(2);
    expect(byLabel.get("Other Models")?.limit).toBe(20);
  });

  test("an api-key account falls back to the legacy surface", async () => {
    // The summary needs a user id from the access token and only answers on the
    // default host, so an api-key account has no summary to prefer over this.
    const fetcher = routedFetcher([
      [
        "/auth/usage",
        jsonResponse({
          "gpt-4": { numRequests: 12, maxRequestUsage: 150 },
          billingCycleEnd: "2026-11-01T00:00:00.000Z",
        }),
      ],
    ]);

    const result = await fetchCursorQuota("key-abc", fetcher, { credential_kind: "api_key" });

    expect(result.windows).toHaveLength(1);
    expect(result.windows[0]?.used).toBe(12);
    expect(result.windows[0]?.limit).toBe(150);
  });
});

describe("Trae quota — the two surfaces are independent", () => {
  const routes = [
    [
      "get_session_usage",
      jsonResponse({
        remain_usage: { advanced_model: 40, premium_model_fast_request: 9 },
        usage: { advanced_model: { limit: 100 }, premium_model_fast_request: { limit: 50 } },
      }),
    ],
    [
      "ide_user_ent_usage",
      jsonResponse({ data: { entitlement_list: [{ ent_title: "Pro", total: 500, remain: 120 }] } }),
    ],
  ] as const;

  test("remaining is read from remain_usage and the cap from usage", async () => {
    // `remain_usage` carries a bare number per bucket, not a nested object; the
    // caps are on the sibling `usage` object. Reading the wrong side leaves a
    // limit with no remaining — a window that cannot say how much is left.
    const result = await fetchTraeQuota("token", routedFetcher(routes), {
      auth_state: { realm: "intl", uid: "u1" },
    });

    expect(result.error).toBeNull();
    const advanced = result.windows.find((w) => w.kind === "trae:Advanced model requests");
    expect(advanced?.used).toBe(60); // 100 - 40
    expect(advanced?.limit).toBe(100);
    const fast = result.windows.find((w) => w.kind === "trae:Premium fast requests");
    expect(fast?.used).toBe(41); // 50 - 9
  });

  test("a dead pay host does not erase a readable meter", async () => {
    // The pay host is the first thing a region-blocked account loses. Failing
    // the whole read here would report no quota and park a healthy account.
    const fetcher = routedFetcher([
      [
        "get_session_usage",
        jsonResponse({
          remain_usage: { advanced_model: 40 },
          usage: { advanced_model: { limit: 100 } },
        }),
      ],
      ["ide_user_ent_usage", () => new Response("upstream down", { status: 500 })],
    ]);

    const result = await fetchTraeQuota("token", fetcher, {
      auth_state: { realm: "intl", uid: "u1" },
    });

    expect(result.windows.length).toBeGreaterThan(0);
    // The quiet surface is logged, not returned: `error` is what flags the
    // account quota_fetch_failed and cools it.
    expect(result.error).toBeNull();
  });

  test("both surfaces dead is a read failure, not a zero balance", async () => {
    const fetcher = routedFetcher([]);
    const result = await fetchTraeQuota("token", fetcher, {
      auth_state: { realm: "intl", uid: "u1" },
    });

    expect(result.windows).toHaveLength(0);
    // No windows and no error: an unreachable surface is not evidence about
    // the account, and must not cool it.
    expect(result.error).toBeNull();
  });
});

describe("Qoder quota — an unreadable body is not a zero balance", () => {
  test("plan and granted credits are pooled, and the shared pool is included", async () => {
    const fetcher = routedFetcher([
      [
        "quota/usage",
        jsonResponse({
          userQuota: { remaining: 300, total: 1000, used: 700 },
          addOnQuota: { remaining: 50, total: 80, used: 30 },
        }),
      ],
    ]);

    const result = await fetchQoderQuota("token", fetcher, {});

    expect(result.error).toBeNull();
    expect(result.windows).toHaveLength(2);
    for (const window of result.windows) expect(window.accounting).toBe("pooled");

    // Pooled windows must carry a computable percent so the console can render
    // a real bar/tone (all-null percents rendered every Qoder account grey).
    const plan = result.windows.find((w) => w.kind === "qoder:plan");
    const addOn = result.windows.find((w) => w.kind === "qoder:addon");
    expect(plan?.remainingPercent).toBeCloseTo(30, 5);
    expect(plan?.usedPercent).toBeCloseTo(70, 5);
    expect(addOn?.remainingPercent).toBeCloseTo(62.5, 5);
    expect(addOn?.usedPercent).toBeCloseTo(37.5, 5);
  });

  test("an exhausted account with a usable shared pool is not reported as empty", async () => {
    // A team account can have its own allowance spent while the org pool still
    // has credit. Dropping the pool reports an empty balance for an account
    // that can still serve.
    const fetcher = routedFetcher([
      [
        "quota/usage",
        jsonResponse({
          userQuota: { remaining: 0, total: 1000, used: 1000 },
          orgResourcePackage: { used: 1548, remaining: 952, cap: 2500, available: true },
        }),
      ],
    ]);

    const result = await fetchQoderQuota("token", fetcher, {});

    const shared = result.windows.find((w) => w.kind === "qoder:shared");
    expect(shared?.limit).toBe(2500);
  });

  test("a live free-tier zero balance is reported, not discarded", async () => {
    // Verified against a real credential: a live free-tier account answers
    // `userQuota` all zeroes with `isQuotaExceeded: true`. That is a balance of
    // zero, not an unreadable body — discarding it hid the account entirely.
    const fetcher = routedFetcher([
      [
        "quota/usage",
        jsonResponse({
          isQuotaExceeded: true,
          totalUsagePercentage: 0,
          userQuota: { total: 0, used: 0, remaining: 0 },
        }),
      ],
    ]);

    const result = await fetchQoderQuota("token", fetcher, {});

    expect(result.windows).toHaveLength(1);
    expect(result.windows[0]?.used).toBe(0);
    expect(result.windows[0]?.limit).toBe(0);
    // A spent 0/0 balance reads as 0% remaining, not an uncolored row.
    expect(result.windows[0]?.remainingPercent).toBe(0);
    expect(result.error).toBeNull();
  });

  test("both quota objects missing yields no balance and no error", async () => {
    const result = await fetchQoderQuota(
      "token",
      routedFetcher([["quota/usage", jsonResponse({ isQuotaExceeded: false })]]),
      {},
    );

    expect(result.windows).toHaveLength(0);
    expect(result.error).toBeNull();
  });

  test("a far-future reset sentinel is treated as no reset", async () => {
    // The business API answers "never resets" as `9999-12-31T00:00:00.000Z`;
    // surfacing it rendered a 7978-year countdown on every window.
    const fetcher = routedFetcher([
      [
        "quota/usage",
        jsonResponse({
          expiresAt: "9999-12-31T00:00:00.000Z",
          userQuota: { remaining: 300, total: 1000, used: 700 },
          addOnQuota: { remaining: 50, total: 80, used: 30 },
        }),
      ],
    ]);

    const result = await fetchQoderQuota("token", fetcher, {});

    for (const window of result.windows) expect(window.resetsAt).toBeNull();
  });

  test("a PAT is exchanged for a job token before the quota read", async () => {
    // Verified live 2026-11-02: a raw `pt-…` bearer on `/api/v2/quota/usage`
    // answers 401 `TOKEN_EXPIRE`, while the exchanged `jt-…` answers 200. The
    // collector must exchange first. The exchange itself is a POST to the
    // realm's job-token endpoint; route both calls and assert the quota read
    // used the exchanged token and the exchange actually happened.
    const pat = "pt-test-pat-value";
    const jobToken = "jt-exchanged-value";
    const quotaRequests: Array<{ url: string; authorization: string | undefined }> = [];
    let exchanges = 0;

    const fetcher = (async (url: unknown, init?: RequestInit): Promise<Response> => {
      const target = String(url);
      if (target.includes("jobToken")) {
        exchanges++;
        return jsonResponse({
          token: jobToken,
          refresh_token: "",
        });
      }
      if (target.includes("quota/usage")) {
        const authorization = new Headers(init?.headers).get("authorization") ?? undefined;
        quotaRequests.push({ url: target, authorization });
        return jsonResponse({
          userQuota: { remaining: 300, total: 1000, used: 700 },
          addOnQuota: { remaining: 50, total: 80, used: 30 },
        });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    const result = await fetchQoderQuota(pat, fetcher, {});

    expect(exchanges).toBe(1);
    expect(quotaRequests).toHaveLength(1);
    expect(quotaRequests[0]?.authorization).toBe(`Bearer ${jobToken}`);
    expect(result.error).toBeNull();
    expect(result.windows).toHaveLength(2);
  });

  test("a device token is used directly, no exchange", async () => {
    // Device tokens (`dt-…`) are already active bearers on the business API —
    // only PATs need the exchange. The exchange URL must never be hit.
    const deviceToken = "dt-test-device-token";
    let exchanges = 0;
    const seenAuth: string[] = [];

    const fetcher = (async (url: unknown, init?: RequestInit): Promise<Response> => {
      const target = String(url);
      if (target.includes("jobToken")) {
        exchanges++;
        return jsonResponse({ id: "u", securityOauthToken: "jt-never" });
      }
      if (target.includes("quota/usage")) {
        seenAuth.push(new Headers(init?.headers).get("authorization") ?? "");
        return jsonResponse({ userQuota: { remaining: 5, total: 10, used: 5 } });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    const result = await fetchQoderQuota(deviceToken, fetcher, {});

    expect(exchanges).toBe(0);
    expect(seenAuth).toEqual([`Bearer ${deviceToken}`]);
    expect(result.error).toBeNull();
    expect(result.windows).toHaveLength(1);
  });
});

describe("Cursor — the legacy bucket and the account identity", () => {
  test("an empty legacy bucket is not shown as a window", async () => {
    // Usage-based plans answer `/auth/usage` with `gpt-4: {numRequests: 0,
    // maxRequestUsage: null}` while their real spend sits on the summary. The
    // empty row was shown above the number that mattered.
    const fetcher = routedFetcher([
      [
        "usage-summary",
        jsonResponse({
          individualUsage: { plan: { enabled: true, autoPercentUsed: 25, apiPercentUsed: 10, limit: 2000 } },
        }),
      ],
      ["/auth/usage", jsonResponse({ "gpt-4": { numRequests: 0, maxRequestUsage: null } })],
    ]);

    const result = await fetchCursorQuota(tokenWithSubject("google-oauth2|user_01ABC"), fetcher, {
      credential_kind: "oauth",
    });

    // The named rails, not the empty legacy bucket.
    expect(result.windows.map((w) => w.label).join(",")).toBe("Cursor Models,Other Models");
  });

  test("the account identity is reduced to an opaque tag", () => {
    // The access token's subject is a real identity; showing it as the account
    // label published it. The tag is derived, so one account keeps one tag.
    const fetcher = routedFetcher([
      [
        "usage-summary",
        jsonResponse({ individualUsage: { plan: { enabled: true, autoPercentUsed: 5 } } }),
      ],
    ]);
    return fetchCursorQuota(tokenWithSubject("google-oauth2|user_01ABC"), fetcher, {
      credential_kind: "oauth",
    }).then((result) => {
      expect(result.accountLabel).toMatch(/^cursor-[a-z0-9]+$/);
      expect(result.accountLabel).not.toContain("google-oauth2");
    });
  });
});
