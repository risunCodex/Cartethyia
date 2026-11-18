/**
 * Kiro management usage fetch (`fetchKiroQuota`).
 *
 * The control-plane `Get-Usage-Limits` surface is profile-scoped: with a
 * `profileArn` it answers 200 and the usage breakdown parses; without one it
 * answers 400 `Invalid profileArn.`. The 400 is a provisioning gap (the
 * account's profile is not resolved yet), not a verdict on the credential — so
 * it must be reported as `transient` so the sweep retries it next pass instead
 * of parking the account for hours.
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

  test("a 400 Invalid profileArn is reported transient, not an account verdict", async () => {
    const fetcher = (async () =>
      jsonResponse({ message: "Invalid profileArn.", missingPermissions: null, reason: null }, 400)) as unknown as typeof fetch;
    const result = await fetchKiroQuota("token", fetcher, { auth_state: { region: "us-east-1", authMethod: "google" } });
    expect(result.error).toBe("management-get: HTTP 400");
    expect(result.transient).toBe(true);
  });

  test("a 400 with profileArn wording is also transient", async () => {
    const fetcher = (async () =>
      jsonResponse({ message: "profileArn is required for this request." }, 400)) as unknown as typeof fetch;
    const result = await fetchKiroQuota("token", fetcher, { auth_state: { region: "us-east-1", authMethod: "google" } });
    expect(result.transient).toBe(true);
  });

  test("a non-profile 400 is a normal failure, not transient", async () => {
    const fetcher = (async () =>
      jsonResponse({ message: "Invalid resourceType." }, 400)) as unknown as typeof fetch;
    const result = await fetchKiroQuota("token", fetcher, { auth_state: AUTH });
    expect(result.error).toBe("management-get: HTTP 400");
    expect(result.transient).toBeUndefined();
  });

  test("an auth refusal names the credential, not transport", async () => {
    const fetcher = (async () => jsonResponse({ message: "Unauthorized" }, 401)) as unknown as typeof fetch;
    const result = await fetchKiroQuota("token", fetcher, { auth_state: AUTH });
    expect(result.error).toContain("rejected the stored credential");
    expect(result.transient).toBeUndefined();
  });
});
