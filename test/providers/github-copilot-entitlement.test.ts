/**
 * The GitHub Copilot device-login gate, exercised against a stub upstream.
 *
 * OAuth itself succeeds for any GitHub account; entitlement is the only signal
 * that the account can chat. This pins the gate added to `GithubOAuthClient`:
 * an explicit `chat_enabled: false` denial blocks the login before any Copilot
 * token is minted, while a valid account still completes.
 */
import { describe, expect, test } from "bun:test";
import { GithubOAuthClient } from "../../src/providers/integrations/github/github-oauth";

interface StubCall {
  readonly url: string;
  readonly body: string;
}

function stubFetch(
  handler: (call: StubCall) => Response,
): { fetch: typeof fetch; calls: StubCall[] } {
  const calls: StubCall[] = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), body: String(init?.body ?? "") };
    calls.push(call);
    return handler(call);
  }) as unknown as typeof fetch;
  return { fetch: fetcher, calls };
}

/** The /copilot_internal/user profile; `chat_enabled: false` is a denial. */
function userProfile(chatEnabled: boolean, canSignupLimited = false): Response {
  return Response.json({
    chat_enabled: chatEnabled,
    can_signup_for_limited: canSignupLimited,
  });
}

describe("GitHub Copilot device-login entitlement gate", () => {
  test("rejects a login when the account has no Copilot access", async () => {
    const { fetch: fetcher, calls } = stubFetch((call) => {
      if (call.url.includes("/login/oauth/access_token")) {
        return Response.json({ access_token: "github-token" });
      }
      if (call.url.includes("/copilot_internal/user")) {
        return userProfile(false);
      }
      return new Response("not found", { status: 404 });
    });
    const client = new GithubOAuthClient(fetcher);

    const poll = await client.pollDeviceAuth("device-code-1", {
      providerState: "github.com",
      providerId: "github",
      tenantId: "tenant-1",
      accountLabel: "account",
    });
    expect(poll.status).toBe("failed");
    if (poll.status !== "failed") throw new Error("unreachable");
    expect(poll.reason).toContain("does not have GitHub Copilot access");
    // The denial must happen before any token is minted.
    expect(calls.some((call) => call.url.includes("copilot_internal/v2/token"))).toBe(false);
  });

  test("guides a free-tier signup when the account can sign up", async () => {
    const { fetch: fetcher } = stubFetch((call) => {
      if (call.url.includes("/login/oauth/access_token")) {
        return Response.json({ access_token: "github-token" });
      }
      if (call.url.includes("/copilot_internal/user")) {
        return userProfile(false, true);
      }
      return new Response("not found", { status: 404 });
    });
    const client = new GithubOAuthClient(fetcher);

    const poll = await client.pollDeviceAuth("device-code-2", {
      providerState: "github.com",
      providerId: "github",
      tenantId: "tenant-1",
      accountLabel: "account",
    });
    expect(poll.status).toBe("failed");
    if (poll.status !== "failed") throw new Error("unreachable");
    expect(poll.reason).toContain("Sign up for Copilot Free");
  });

  test("completes the login for an entitled account", async () => {
    const { fetch: fetcher, calls } = stubFetch((call) => {
      if (call.url.includes("/login/oauth/access_token")) {
        return Response.json({ access_token: "github-token" });
      }
      if (call.url.includes("/copilot_internal/user")) {
        return userProfile(true);
      }
      if (call.url.includes("copilot_internal/v2/token")) {
        return Response.json({
          token: "proxy-ep=api.copilot.example;expires_at=1893456000;",
          expires_at: 1_893_456_000,
        });
      }
      if (call.url.includes("/user")) {
        return Response.json({ login: "octocat" });
      }
      return new Response("not found", { status: 404 });
    });
    const client = new GithubOAuthClient(fetcher);

    const poll = await client.pollDeviceAuth("device-code-3", {
      providerState: "github.com",
      providerId: "github",
      tenantId: "tenant-1",
      accountLabel: "account",
    });
    expect(poll.status).toBe("complete");
    if (poll.status !== "complete") throw new Error("unreachable");
    expect(calls.some((call) => call.url.includes("copilot_internal/v2/token"))).toBe(true);
    expect(poll.result.refresh).toBe("github-token");
    expect(poll.result.accountLabel).toBe("octocat");
  });

  test("an entitlement lookup failure does not lock out an approved account", async () => {
    const { fetch: fetcher, calls } = stubFetch((call) => {
      if (call.url.includes("/login/oauth/access_token")) {
        return Response.json({ access_token: "github-token" });
      }
      if (call.url.includes("/copilot_internal/user")) {
        return new Response("gateway timeout", { status: 504 });
      }
      if (call.url.includes("copilot_internal/v2/token")) {
        return Response.json({
          token: "proxy-ep=api.copilot.example;expires_at=1893456000;",
          expires_at: 1_893_456_000,
        });
      }
      return new Response("not found", { status: 404 });
    });
    const client = new GithubOAuthClient(fetcher);

    const poll = await client.pollDeviceAuth("device-code-4", {
      providerState: "github.com",
      providerId: "github",
      tenantId: "tenant-1",
      accountLabel: "account",
    });
    expect(poll.status).toBe("complete");
    if (poll.status !== "complete") throw new Error("unreachable");
    expect(calls.some((call) => call.url.includes("copilot_internal/v2/token"))).toBe(true);
  });
});
