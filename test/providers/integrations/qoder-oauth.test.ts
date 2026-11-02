import { describe, expect, test } from "bun:test";
import {
  parseQoderExpiry,
  parseQoderOAuthState,
  QoderOAuthClient,
  readQoderUserInfo,
} from "../../../src/providers/integrations/qoder/qoder-oauth";
import {
  isQoderPat,
  qoderMachineIdForAccount,
  qoderOAuthAuth,
} from "../../../src/providers/integrations/qoder/qoder";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function clientWith(fetcher: (url: string, init?: RequestInit) => Promise<Response>): QoderOAuthClient {
  return new QoderOAuthClient(fetcher as typeof fetch);
}

describe("Qoder device flow start", () => {
  test("builds a local verification URI with PKCE, nonce, and machine id", async () => {
    const client = clientWith(async () => {
      throw new Error("start must not touch the network");
    });
    const started = await client.startDeviceAuth();
    expect(started.verificationUri.startsWith("https://qoder.com/device/selectAccounts?")).toBe(true);
    expect(started.verificationUri).toContain("challenge_method=S256");
    // 1:1 with the desktop IDE: the client id is always present and the nonce
    // is a full UUID (dashes included), not a dash-stripped hex string.
    expect(started.verificationUri).toContain("client_id=e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb");
    const nonceMatch = /nonce=([0-9a-f-]{36})/.exec(started.verificationUri);
    expect(nonceMatch).not.toBeNull();
    expect(nonceMatch![1]!).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(started.deviceAuthId).toBe(nonceMatch![1]!);
    expect(started.userCode).toBe("");
    const state = JSON.parse(started.providerState ?? "{}") as Record<string, unknown>;
    expect(typeof state.verifier).toBe("string");
    expect(typeof state.machineId).toBe("string");
    // The verifier comes from the IDE's own alphabet (no base64 `+`/`/`) and
    // is a fixed 64 chars (RFC 7636 §4.1 range [43,128]).
    expect(state.verifier).toMatch(/^[A-Za-z0-9-._~]{64}$/);
  });
});

describe("Qoder device flow poll", () => {
  const providerState = JSON.stringify({ verifier: "verifier-value", machineId: "machine-value" });

  test("202 and 404 mean keep polling", async () => {
    for (const status of [202, 404]) {
      const client = clientWith(async () => new Response("", { status }));
      const result = await client.pollDeviceAuth("nonce-value", {
        providerId: "qoder",
        tenantId: null,
        accountLabel: "",
        providerState,
      });
      expect(result).toEqual({ status: "pending" });
    }
  });

  test("a missing device state fails closed", async () => {
    const client = clientWith(async () => jsonResponse({}));
    const result = await client.pollDeviceAuth("nonce-value", {
      providerId: "qoder",
      tenantId: null,
      accountLabel: "",
    });
    expect(result.status).toBe("failed");
  });

  test("a 200 without a token fails instead of storing an empty credential", async () => {
    const client = clientWith(async () => jsonResponse({ ok: true }));
    const result = await client.pollDeviceAuth("nonce-value", {
      providerId: "qoder",
      tenantId: null,
      accountLabel: "",
      providerState,
    });
    expect(result.status).toBe("failed");
  });

  test("a token completes with auth_state identity and account label", async () => {
    const client = clientWith(async (url) => {
      if (typeof url === "string" && url.includes("deviceToken")) {
        return jsonResponse({
          token: "dt-test-token",
          refresh_token: "rt-test",
          user_id: "user-123",
          expires_in: 2_592_000,
        });
      }
      return jsonResponse({ name: "Ada", email: "ada@example.com", id: "user-123" });
    });
    const result = await client.pollDeviceAuth("nonce-value", {
      providerId: "qoder",
      tenantId: null,
      accountLabel: "",
      providerState,
    });
    expect(result.status).toBe("complete");
    if (result.status !== "complete") return;
    expect(result.result.access).toBe("dt-test-token");
    expect(result.result.refresh).toBe("rt-test");
    expect(result.result.accountLabel).toBe("Ada");
    expect(result.result.auth_state).toEqual({ userId: "user-123", machineId: "machine-value" });
  });

  test("a failed userinfo lookup still completes the login", async () => {
    const client = clientWith(async (url) => {
      if (typeof url === "string" && url.includes("deviceToken")) {
        return jsonResponse({ token: "dt-test-token", user_id: "user-9" });
      }
      return new Response("boom", { status: 500 });
    });
    const result = await client.pollDeviceAuth("nonce-value", {
      providerId: "qoder",
      tenantId: null,
      accountLabel: "",
      providerState,
    });
    expect(result.status).toBe("complete");
    if (result.status !== "complete") return;
    expect(result.result.auth_state).toEqual({ userId: "user-9", machineId: "machine-value" });
    expect(result.result.accountLabel).toBeUndefined();
  });
});

describe("parseQoderExpiry", () => {
  test("accepts ms-epoch numbers, numeric strings, and RFC3339", () => {
    expect(parseQoderExpiry(1_786_622_470_000, undefined)).toBe(1_786_622_470_000);
    expect(parseQoderExpiry("1786622470000", undefined)).toBe(1_786_622_470_000);
    expect(parseQoderExpiry("2026-06-16T07:15:04Z", undefined)).toBe(Date.parse("2026-06-16T07:15:04Z"));
  });

  test("falls back to seconds-from-now, then to 30 days", () => {
    const before = Date.now();
    const fromSeconds = parseQoderExpiry(undefined, 3600);
    expect(fromSeconds).toBeGreaterThanOrEqual(before + 3_599_000);
    const fallback = parseQoderExpiry(undefined, undefined);
    expect(fallback).toBeGreaterThanOrEqual(before + 29 * 24 * 60 * 60 * 1000);
  });
});

describe("Qoder dispatch credential branches", () => {
  test("only pt- secrets take the PAT exchange path", () => {
    expect(isQoderPat("pt-abc")).toBe(true);
    expect(isQoderPat("dt-abc")).toBe(false);
    expect(isQoderPat("jt-abc")).toBe(false);
    expect(isQoderPat("")).toBe(false);
  });

  test("machine ids are stable per account and distinct across accounts", () => {
    expect(qoderMachineIdForAccount("a")).toBe(qoderMachineIdForAccount("a"));
    expect(qoderMachineIdForAccount("a")).not.toBe(qoderMachineIdForAccount("b"));
  });

  test("OAuth auth uses the token directly with the persisted identity", () => {
    const auth = qoderOAuthAuth(
      "dt-test-token",
      { userId: "user-123", machineId: "machine-value" },
      "account-1",
    );
    expect(auth).toMatchObject({
      userId: "user-123",
      securityOauthToken: "dt-test-token",
      machineId: "machine-value",
    });
  });

  test("OAuth auth without an identity fails closed", () => {
    expect(() => qoderOAuthAuth("dt-test-token", {}, "account-1")).toThrow(
      /sign in again/,
    );
    expect(() => qoderOAuthAuth("dt-test-token", undefined, "account-1")).toThrow(
      /sign in again/,
    );
  });

  test("parseQoderOAuthState rejects identity without both fields", () => {
    expect(parseQoderOAuthState({ userId: "u", machineId: "m" })).toEqual({
      userId: "u",
      machineId: "m",
    });
    expect(parseQoderOAuthState({ userId: "u" })).toBeUndefined();
    expect(parseQoderOAuthState(null)).toBeUndefined();
  });

  test("parseQoderOAuthState accepts the JSON-string form the loader stores", () => {
    // The credential loader persists `auth_state` as JSON text in SQLite and
    // hands the adapter that string on a cold cache, so the parser must accept
    // both shapes or a working login breaks on the next cache eviction.
    const serialized = JSON.stringify({ userId: "u", machineId: "m" });
    expect(parseQoderOAuthState(serialized)).toEqual({ userId: "u", machineId: "m" });
    expect(parseQoderOAuthState(JSON.stringify({ userId: "u" }))).toBeUndefined();
    expect(parseQoderOAuthState("{ not json")).toBeUndefined();
  });
});

describe("readQoderUserInfo", () => {
  test("an organization id alone makes the account an organization", () => {
    // The case the organization check exists for: an enterprise account whose
    // `userType` still reads personal is enterprise as soon as it carries one.
    const info = readQoderUserInfo({ organization_id: "org_1234567890", user_type: "personal" });
    expect(info.isOrganization).toBe(true);
    // Only the first 8 characters of the id, so a long one cannot overflow the
    // badge: `org_1234567890` truncates to `org_1234`.
    expect(info.organizationLabel).toBe("org org_1234");
  });

  test("an organization name is preferred for the label", () => {
    const info = readQoderUserInfo({ organization_name: "Acme Corp", organization_id: "org_1" });
    expect(info.isOrganization).toBe(true);
    expect(info.organizationLabel).toBe("Acme Corp");
  });

  test("the camelCase spellings are read too", () => {
    // The two login paths (OAuth and PAT import) do not agree on a spelling, so
    // an account that took the other path would otherwise read as personal.
    expect(readQoderUserInfo({ organizationId: "org_9" }).isOrganization).toBe(true);
    expect(readQoderUserInfo({ userType: "enterprise" }).isOrganization).toBe(true);
  });

  test("a userType naming a team or enterprise is enough", () => {
    expect(readQoderUserInfo({ user_type: "team" }).isOrganization).toBe(true);
    expect(readQoderUserInfo({ user_type: "ENTERPRISE" }).isOrganization).toBe(true);
    expect(readQoderUserInfo({ user_type: "personal" }).isOrganization).toBe(false);
  });

  test("a shared credit pool is enough", () => {
    expect(readQoderUserInfo({ credits: { shared: { size: 4 } } }).isOrganization).toBe(true);
    expect(readQoderUserInfo({ credits: { shared: { unlimited: true } } }).isOrganization).toBe(
      true,
    );
    expect(readQoderUserInfo({ credits: { shared: { size: 0 } } }).isOrganization).toBe(false);
  });

  test("a personal account is not an organization and has no label", () => {
    const info = readQoderUserInfo({ name: "Ada", user_type: "personal" });
    expect(info.isOrganization).toBe(false);
    expect(info.organizationLabel).toBe("");
    expect(info.name).toBe("Ada");
  });

  test("an empty body yields empty fields rather than throwing", () => {
    const info = readQoderUserInfo({});
    expect(info.isOrganization).toBe(false);
    expect(info.id).toBe("");
  });
});
