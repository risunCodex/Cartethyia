import { describe, expect, test } from "bun:test";
import { fetchCommandCodeQuota } from "../../src/providers/integrations/commandcode/quota";
import { totalRemainingCredit } from "../../src/providers/quota/quota-contracts";
import { createDefaultProviderRegistry } from "../../src/providers/default-registry";
import { fetchProviderQuota } from "../../src/providers/quota/quota-support";
import { EligibilityEvaluator } from "../../src/transport/routing/router";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("Command Code quota", () => {
  test("scopes billing to the organization and parses plan limits", async () => {
    const requested: string[] = [];
    const authorizations: string[] = [];
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requested.push(url);
      authorizations.push(new Headers(init?.headers).get("authorization") ?? "");
      if (url.includes("/alpha/whoami")) {
        return jsonResponse({
          user: { name: "Hieu", email: "hieu@example.com" },
          org: { id: "org_1", name: "personal" },
        });
      }
      if (url.includes("/alpha/billing/credits")) {
        return jsonResponse({
          credits: { monthlyCredits: 12.5, purchasedCredits: 1, freeCredits: 0.5 },
          windowLimits: {
            fiveHour: { used: 2, cap: 10, resetAt: 1_796_000_000_000, exceeded: false },
            weekly: { used: 20, cap: 70, resetAt: 1_796_086_400_000, exceeded: false },
          },
        });
      }
      if (url.includes("/alpha/billing/subscriptions")) {
        return jsonResponse({
          data: {
            planId: "individual-goat",
            currentPeriodEnd: "2026-10-01T00:00:00.000Z",
          },
        });
      }
      return jsonResponse({ error: "unexpected URL" }, 404);
    }) as typeof fetch;

    const result = await fetchCommandCodeQuota("user_test", fetcher);

    expect(result.error).toBeNull();
    expect(result.plan).toBe("CommandCode GOAT");
    expect(result.accountLabel).toBe("hieu@example.com");
    expect(requested[0]).toContain("/alpha/whoami?limits=1");
    expect(requested.some((url) => url.includes("/alpha/billing/credits?orgId=org_1"))).toBe(true);
    expect(requested.some((url) => url.includes("/alpha/billing/subscriptions?orgId=org_1"))).toBe(true);
    expect(authorizations.every((value) => value === "Bearer user_test")).toBe(true);
    expect(result.windows).toMatchObject([
      {
        kind: "credits",
        label: "Monthly credits",
        accounting: "pooled",
        used: 57.5,
        limit: 70,
        remaining: 12.5,
        resetsAt: "2026-10-01T00:00:00.000Z",
      },
      {
        kind: "additional_credits",
        label: "Purchased/free credits",
        accounting: "pooled",
        used: null,
        limit: null,
        remaining: 1.5,
        usedPercent: null,
        remainingPercent: null,
        resetsAt: null,
      },
      {
        kind: "five_hour",
        label: "Session (5h)",
        accounting: "independent",
        used: 2,
        limit: 10,
        remaining: 8,
        usedPercent: 20,
        remainingPercent: 80,
      },
      {
        kind: "weekly",
        label: "Weekly",
        accounting: "independent",
        used: 20,
        limit: 70,
        remaining: 50,
      },
    ]);
    expect(result.windows[0]?.usedPercent).toBeCloseTo(57.5 / 70 * 100);
    expect(result.windows[0]?.remainingPercent).toBeCloseTo(12.5 / 70 * 100);
    expect(totalRemainingCredit(result.windows)).toBe(14);
  });

  test("an unused window with resetAt zero has no reset deadline", async () => {
    const fetcher = (async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/whoami")) return jsonResponse({ org: null });
      if (path.endsWith("/credits")) return jsonResponse({
        credits: { monthlyCredits: 10 },
        windowLimits: { fiveHour: { used: 0, cap: 3, resetAt: 0 } },
      });
      return jsonResponse({ data: { planId: "individual-go", currentPeriodEnd: 0 } });
    }) as typeof fetch;
    const result = await fetchCommandCodeQuota("fixture", fetcher);
    expect(result.windows[0]?.resetsAt).toBeNull();
    expect(result.windows[1]).toMatchObject({ kind: "five_hour", remaining: 3, resetsAt: null });
  });

  test("normalizes the Go v1 plan label and credit cap", async () => {
    const fetcher = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/alpha/whoami")) return jsonResponse({ org: { id: "org_go" } });
      if (url.includes("/alpha/billing/credits")) {
        return jsonResponse({ credits: { monthlyCredits: 4, purchasedCredits: 0, freeCredits: 1 } });
      }
      return jsonResponse({ data: { planId: "individual-go-v1", currentPeriodEnd: "2026-11-01T00:00:00Z" } });
    }) as typeof fetch;

    const result = await fetchCommandCodeQuota("user_go", fetcher);

    expect(result.plan).toBe("CommandCode Go");
    expect(result.windows[0]).toMatchObject({ used: 6, limit: 10, remaining: 4, remainingPercent: 40 });
    expect(result.windows[1]).toMatchObject({ remaining: 1, limit: null, resetsAt: null });
    expect(totalRemainingCredit(result.windows)).toBe(5);
  });

  test("derives a team label and ignores the version suffix", async () => {
    const fetcher = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/alpha/whoami")) return jsonResponse({ org: { id: "org_team" } });
      if (url.includes("/alpha/billing/credits")) {
        return jsonResponse({ credits: { monthlyCredits: 30, purchasedCredits: 0, freeCredits: 0 } });
      }
      return jsonResponse({ data: { planId: "teams-pro-v2" } });
    }) as typeof fetch;

    const result = await fetchCommandCodeQuota("user_team", fetcher);

    expect(result.plan).toBe("CommandCode Teams Pro");
    expect(result.windows[0]).toMatchObject({ used: 10, limit: 40, remaining: 30, remainingPercent: 75 });
  });

  test("parses numeric balances and the legacy Pro cap without inventing unused rate limits", async () => {
    const fetcher = (async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/whoami")) return jsonResponse({ user: { name: "Fixture" } });
      if (path.endsWith("/credits")) return jsonResponse({
        credits: { monthlyCredits: "40", purchasedCredits: "2", freeCredits: "1" },
        windowLimits: {
          fiveHour: { used: "1", cap: "5", resetAt: "1796000000" },
          weekly: { used: 0, cap: 0, resetAt: 0 },
        },
      });
      return jsonResponse({ data: { planId: "individual-pro-v1" } });
    }) as typeof fetch;
    const result = await fetchCommandCodeQuota("fixture", fetcher);
    expect(result.plan).toBe("CommandCode Pro");
    expect(result.accountLabel).toBe("Fixture");
    expect(result.windows).toHaveLength(3);
    expect(result.windows[0]).toMatchObject({ used: 40, limit: 80, remaining: 40, remainingPercent: 50 });
    expect(result.windows[2]).toMatchObject({ kind: "five_hour", used: 1, limit: 5, remaining: 4, resetsAt: new Date(1_796_000_000_000).toISOString() });
    expect(totalRemainingCredit(result.windows)).toBe(43);
  });

  test("retains credits when the subscription endpoint is unavailable", async () => {
    const fetcher = (async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/whoami")) return jsonResponse({ org: { id: "org_partial" } });
      if (path.endsWith("/credits")) return jsonResponse({ credits: { monthlyCredits: 4, purchasedCredits: 2 } });
      return jsonResponse({ error: "unavailable" }, 503);
    }) as typeof fetch;
    const result = await fetchCommandCodeQuota("fixture", fetcher);
    expect(result.error).toBeNull();
    expect(result.plan).toBe("Credits");
    expect(result.windows[0]).toMatchObject({ remaining: 4, limit: null, used: null, resetsAt: null });
    expect(totalRemainingCredit(result.windows)).toBe(6);
  });

  test("reports unavailable billing without dropping the account identity", async () => {
    const fetcher = (async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      return path.endsWith("/whoami")
        ? jsonResponse({ user: { email: "fixture@example.com" } })
        : jsonResponse({ error: "unavailable" }, 503);
    }) as typeof fetch;
    const result = await fetchCommandCodeQuota("fixture", fetcher);
    expect(result.error).toBe("Command Code did not answer its billing endpoints");
    expect(result.windows).toEqual([]);
    expect(result.accountLabel).toBe("fixture@example.com");
  });

  for (const planId of ["individual-go-v1", "individual-future-tier"]) {
    test(`${planId} keeps purchased credits spendable through registry and routing`, async () => {
      const fetcher = (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/alpha/whoami")) return jsonResponse({ org: { id: "fixture-org" } });
        if (url.includes("/alpha/billing/credits")) {
          return jsonResponse({ credits: { monthlyCredits: 5, purchasedCredits: 20, freeCredits: 0 } });
        }
        return jsonResponse({ data: { planId, currentPeriodEnd: "2026-12-01T00:00:00Z" } });
      }) as typeof fetch;
      const result = await fetchProviderQuota(createDefaultProviderRegistry(), "commandcode", "fixture-token", fetcher);
      expect(result.error).toBeNull();
      expect(totalRemainingCredit(result.windows)).toBe(25);
      expect(result.windows[0]).toMatchObject({
        remaining: 5,
        limit: planId === "individual-go-v1" ? 10 : null,
        used: planId === "individual-go-v1" ? 5 : null,
        resetsAt: "2026-12-01T00:00:00.000Z",
      });
      expect(result.windows[1]).toMatchObject({ remaining: 20, limit: null, resetsAt: null });
      const candidate = {
        provider_id: "commandcode",
        model_id: "xiaomi/mimo-v2.6-flash",
        wire_family: "responses" as const,
        endpoint: "/alpha/generate",
        capability_profile: {},
        provider_account_id: "fixture-account",
        quota_windows: result.windows,
        usage_floor: 15,
        usage_floor_unit: "credit" as const,
      };
      const evaluator = new EligibilityEvaluator();
      expect(evaluator.evaluate(candidate)).toMatchObject({ eligible: true, reason: "healthy" });
      // Usage floor is not an eligibility exclusion: the account is still routed
      // and upstream decides. Quota only affects ordering.
      expect(evaluator.evaluate({ ...candidate, usage_floor: 25 })).toMatchObject({ eligible: true, reason: "healthy" });
    });
  }
});