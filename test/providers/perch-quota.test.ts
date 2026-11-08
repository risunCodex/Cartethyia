/**
 * Perch quota collector with a stub fetcher.
 */
import { describe, expect, test } from "bun:test";
import { fetchPerchQuota } from "../../src/providers/integrations/perch/perch-quota";
import type { FetchLike } from "../../src/providers/quota/quota-contracts";

const CRED = JSON.stringify({
  accessToken: "jwt-access",
  refreshToken: "r",
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
  email: "a@b.c",
});
function fetcher(account: unknown): FetchLike {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : String(input);
    if (url.includes("/api/perchai/account")) {
      return new Response(JSON.stringify(account), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("{}", { status: 404 });
  }) as unknown as FetchLike;
}

describe("fetchPerchQuota", () => {
  test("reads plan and monthly USD allowance", async () => {
    const result = await fetchPerchQuota(
      CRED,
      fetcher({
        ok: true,
        profile: { id: "u1", email: "a@b.c", name: "A" },
        session: { planCode: "pilot", planName: "Starter", membershipRole: "member" },
        usageMeter: {
          monthlyUsd: 3.25,
          roostRolling: {
            enabled: true,
            window5hUsd: 1,
            window5hCapUsd: 5,
            window7dUsd: 2,
            window7dCapUsd: 10,
          },
        },
      }),
    );
    expect(result.plan).toBe("pilot");
    expect(result.accountLabel).toBe("a@b.c");
    expect(result.error).toBeNull();
    const kinds = result.windows.map((w) => w.kind);
    expect(kinds).toContain("usd_monthly");
    expect(kinds).toContain("usd_5h");
    expect(kinds).toContain("usd_weekly");
    const monthly = result.windows.find((w) => w.kind === "usd_monthly");
    expect(monthly?.used).toBeCloseTo(3.25, 5);
    expect(monthly?.limit).toBe(20);
    expect(monthly?.usedPercent).toBeCloseTo(16.25, 5);
  });

  test("returns null windows when account read fails", async () => {
    const result = await fetchPerchQuota(CRED, fetcher(null));
    expect(result.plan).toBeNull();
    expect(result.windows).toEqual([]);
    expect(result.error).not.toBeNull();
  });

  test("returns an error when the account read fails", async () => {
    const result = await fetchPerchQuota(
      "raw-token",
      (async () => new Response("unauthorized", { status: 401 })) as unknown as FetchLike,
    );
    expect(result.error).not.toBeNull();
    expect(result.windows).toEqual([]);
  });
});
