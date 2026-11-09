/**
 * OAuth account identity at login/poll/refresh time.
 *
 * The failure this pins: a provider that exposes no email/name used to leave
 * every row labelled with just the provider id, while WorkOS variants that do
 * expose an identity lost it before the account store. The store owns both the
 * structured identity and the generated `-N` display label.
 */
import { describe, expect, test } from "bun:test";
import { ClineOAuthClient } from "../../src/providers/integrations/cline/cline-oauth";
import { FactoryOAuthClient } from "../../src/providers/integrations/factory/factory-oauth";
import {
  nextGeneratedOAuthAccountLabel,
  oauthIdentityFingerprint,
} from "../../src/console/providers/oauth/routes";
import { oauthAccountIdentity } from "../../src/providers/authentication/oauth-flow-store";

function jwt(claims: Record<string, unknown>): string {
  const encode = (value: unknown) =>
    btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${encode({ alg: "none" })}.${encode(claims)}.signature`;
}

function fetcher(body: unknown): typeof fetch {
  return (async () => Response.json(body)) as unknown as typeof fetch;
}

function exchangeResult(overrides: Record<string, unknown> = {}): Parameters<typeof oauthIdentityFingerprint>[0] {
  return {
    providerId: "hermes",
    label: "hermes",
    access: "access-token",
    refresh: "refresh-token",
    expiresAt: new Date(0),
    ...overrides,
  } as Parameters<typeof oauthIdentityFingerprint>[0];
}

describe("structured OAuth account identity", () => {
  test("reads email and name from WorkOS response shapes", () => {
    expect(
      oauthAccountIdentity({
        user: { id: "user_1", email: "dev@example.com", name: "Dev User" },
      }),
    ).toEqual({ accountEmail: "dev@example.com", accountName: "Dev User" });
    expect(
      oauthAccountIdentity({
        data: { user: { email: "nested@example.com", first_name: "Nested", last_name: "User" } },
      }),
    ).toEqual({ accountEmail: "nested@example.com", accountName: "Nested User" });
  });

  test("Cline keeps WorkOS email and assembled name through token exchange", async () => {
    const body = {
      access_token: "cline-access",
      refresh_token: "cline-refresh",
      email: "cline@example.com",
      firstName: "Cline",
      lastName: "User",
    };
    const client = new ClineOAuthClient(fetcher(body));
    const refreshed = await client.refresh("cline-refresh");
    expect(refreshed.accountEmail).toBe("cline@example.com");
    expect(refreshed.accountName).toBe("Cline User");
    expect(refreshed.accountLabel).toBe("cline@example.com");
  });

  test("Factory keeps WorkOS user email/name beside JWT claims on refresh", async () => {
    const access = jwt({ sub: "user_9", external_org_id: "org_9", exp: 1_800_000_000 });
    const client = new FactoryOAuthClient(
      fetcher({ access_token: access, user: { id: "user_9", email: "rotated@example.com", name: "Rotated User" } }),
    );
    const refreshed = await client.refresh("workos-refresh");
    expect(refreshed.accountEmail).toBe("rotated@example.com");
    expect(refreshed.accountName).toBe("Rotated User");
    expect(refreshed.auth_state?.["userId"]).toBe("user_9");
  });
});

describe("OAuth generated account labels", () => {
  test("numbers nameless accounts per provider without reusing gaps case-insensitively", () => {
    expect(nextGeneratedOAuthAccountLabel("hermes", [])).toBe("hermes-1");
    expect(nextGeneratedOAuthAccountLabel("hermes", ["hermes", "hermes-1", "HERMES-3"])).toBe("hermes-2");
    expect(nextGeneratedOAuthAccountLabel("other", ["hermes-1"])).toBe("other-1");
  });

  test("a generated label is not an upstream identity", () => {
    const first = exchangeResult({ label: "hermes-1", refresh: "refresh-a" });
    const second = exchangeResult({ label: "hermes-2", refresh: "refresh-b" });
    expect(oauthIdentityFingerprint(first)).not.toBe(oauthIdentityFingerprint(second));
  });

  test("structured identity wins over display label and is stable across token rotation", () => {
    const first = exchangeResult({
      label: "hermes-1",
      accountEmail: "dev@example.com",
      refresh: "refresh-a",
    });
    const second = exchangeResult({
      label: "hermes-2",
      accountEmail: "dev@example.com",
      refresh: "refresh-b",
    });
    expect(oauthIdentityFingerprint(first)).toBe(oauthIdentityFingerprint(second));
  });
});
