/**
 * Kiro management usage fetch (`fetchKiroQuota`).
 *
 * The control-plane `Get-Usage-Limits` surface is profile-scoped: with a
 * `profileArn` it answers 200 and the usage breakdown parses; without one it
 * answers 400 `Invalid profileArn.`. A 400 refuses the query shape, not the
 * credential — the account stays ACTIVE and routable — so it is reported without
 * an error: the health surface must not flag `quota_fetch_failed` (or park the
 * account) over a usage read the account does not need to route. Only an auth
 * refusal (401/403) is a credential verdict.
 */
import { describe, expect, test } from "bun:test";
import { fetchKiroQuota } from "../../src/providers/integrations/kiro/kiro-quota";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const USAGE_BODY = {
  nextDateReset: 1.7960832e9,
  subscriptionInfo: { subscriptionTitle: "KIRO FREE" },
  usageBreakdownList: [
    {
      resourceType: "AGENTIC_REQUEST",
      currentUsageWithPrecision: 10,
      usageLimitWithPrecision: 100,
    },
  ],
};

const AUTH = {
  region: "us-east-1",
  authMethod: "google",
  profileArn: "arn:aws:codewhisperer:us-east-1:699475941385:profile/EHGA3GRVQMUK",
  machineId: "m1",
};

describe("fetchKiroQuota", () => {
  test("a profile-scoped 200 parses usage windows", async () => {
    const fetcher = (async () => jsonResponse(USAGE_BODY)) as unknown as typeof fetch;
    const result = await fetchKiroQuota("token", fetcher, { auth_state: AUTH });
    expect(result.error).toBeNull();
    expect(result.plan).toBe("KIRO FREE");
    expect(result.windows).toHaveLength(1);
    expect(result.windows[0]!.kind).toBe("agentic_request");
    expect(result.windows[0]!.usedPercent).toBe(10);
    expect(result.transient).toBeUndefined();
  });

  test("a 400 Invalid profileArn is ignored, not an account verdict", async () => {
    const fetcher = (async () =>
      jsonResponse({ message: "Invalid profileArn.", missingPermissions: null, reason: null }, 400)) as unknown as typeof fetch;
    const result = await fetchKiroQuota("token", fetcher, { auth_state: { region: "us-east-1", authMethod: "google" } });
    // The usage surface refused the query shape, not the credential: the account
    // stays routable, so no error is reported and the health surface never flags
    // `quota_fetch_failed` over it.
    expect(result.error).toBeNull();
    expect(result.transient).toBeUndefined();
  });

  test("a 400 with profileArn wording is ignored too", async () => {
    const fetcher = (async () =>
      jsonResponse({ message: "profileArn is required for this request." }, 400)) as unknown as typeof fetch;
    const result = await fetchKiroQuota("token", fetcher, { auth_state: { region: "us-east-1", authMethod: "google" } });
    expect(result.error).toBeNull();
  });

  test("a non-profile 400 is ignored as well", async () => {
    const fetcher = (async () =>
      jsonResponse({ message: "Invalid resourceType." }, 400)) as unknown as typeof fetch;
    const result = await fetchKiroQuota("token", fetcher, { auth_state: AUTH });
    expect(result.error).toBeNull();
    expect(result.transient).toBeUndefined();
  });

  test("an auth refusal names the credential, not transport", async () => {
    const fetcher = (async () => jsonResponse({ message: "Unauthorized" }, 401)) as unknown as typeof fetch;
    const result = await fetchKiroQuota("token", fetcher, { auth_state: AUTH });
    expect(result.error).toContain("rejected the stored credential");
    expect(result.transient).toBeUndefined();
  });
});
