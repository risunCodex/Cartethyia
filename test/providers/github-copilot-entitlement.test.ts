/**
 * The GitHub Copilot device-login gate, exercised against a stub upstream.
 *
 * OAuth itself succeeds for any GitHub account; entitlement is the only signal
 * that the account can chat. This pins the gate added to `GithubOAuthClient`:
 * an explicit `chat_enabled: false` denial blocks the login before any Copilot
 * token is minted, while a valid account still completes.
 */
import { describe, expect, test } from "bun:test";
import {
  GithubOAuthClient,
  GITHUB_CLIENT_ID,
  GITHUB_OPENCODE_CLIENT_ID,
  GITHUB_OPENCODE_API_HOST,
} from "../../src/providers/integrations/github/github-oauth";

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
    const client = new GithubOAuthClient(fetcher, GITHUB_CLIENT_ID);

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
    const client = new GithubOAuthClient(fetcher, GITHUB_CLIENT_ID);

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
    const client = new GithubOAuthClient(fetcher, GITHUB_CLIENT_ID);

    const poll = await client.pollDeviceAuth("device-code-3", {
      providerState: "github.com",
      providerId: "github",
      tenantId: "tenant-1",
      accountLabel: "account",
    });
    expect(poll.status).toBe("complete");
    if (poll.status !== "complete") throw new Error("unreachable");
    expect(calls.some((call) => call.url.includes("copilot_internal/v2/token"))).toBe(true);
    const parsed = JSON.parse(poll.result.access) as { profile?: string };
    expect(parsed.profile).toBe("vscode-client-real");
    expect(poll.result.auth_state).toEqual({ github_copilot_profile: "vscode-client-real" });
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
    const client = new GithubOAuthClient(fetcher, GITHUB_CLIENT_ID);

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

  test("OpenCode client id completes without minting a Copilot token", async () => {
    const { fetch: fetcher, calls } = stubFetch((call) => {
      if (call.url.includes("/login/oauth/access_token")) {
        return Response.json({ access_token: "github-token" });
      }
      if (call.url.includes("/copilot_internal/user")) {
        return userProfile(true);
      }
      if (call.url.includes("/user")) {
        return Response.json({ login: "octocat" });
      }
      return new Response("not found", { status: 404 });
    });
    const client = new GithubOAuthClient(fetcher, GITHUB_OPENCODE_CLIENT_ID);

    const poll = await client.pollDeviceAuth("device-code-5", {
      providerState: "github.com",
      providerId: "github",
      tenantId: "tenant-1",
      accountLabel: "account",
    });
    expect(poll.status).toBe("complete");
    if (poll.status !== "complete") throw new Error("unreachable");
    // The OpenCode flow must never hit the VS Code mint endpoint (it rejects
    // the OpenCode client id with 403) — the raw GitHub token is the credential.
    expect(calls.some((call) => call.url.includes("copilot_internal/v2/token"))).toBe(false);
    const parsed = JSON.parse(poll.result.access as string) as {
      access?: string;
      apiHost?: string;
      github?: string;
      profile?: string;
    };
    expect(parsed.access).toBe("github-token");
    expect(parsed.apiHost).toBe(GITHUB_OPENCODE_API_HOST);
    expect(parsed.github).toBe("github-token");
    expect(parsed.profile).toBe("opencode-copilot");
    expect(poll.result.auth_state).toEqual({ github_copilot_profile: "opencode-copilot" });
    expect(poll.result.refresh).toBe("github-token");
    expect(poll.result.accountLabel).toBe("octocat");
  });

  test("default login client follows the complete profile's OAuth app ID", async () => {
    const originalMode = process.env.CARTETHYIA_GITHUB_COPILOT_MODE;
    try {
      for (const [mode, expectedClientId] of [
        ["opencode-copilot", GITHUB_OPENCODE_CLIENT_ID],
        ["vscode-client-real", GITHUB_CLIENT_ID],
      ] as const) {
        process.env.CARTETHYIA_GITHUB_COPILOT_MODE = mode;
        let requestBody = "";
        const fetcher = (async (_url: string | URL | Request, init?: RequestInit) => {
          requestBody = String(init?.body ?? "");
          return Response.json({
            device_code: "device-code",
            user_code: "ABCD-EFGH",
            verification_uri: "https://github.com/login/device",
          });
        }) as unknown as typeof fetch;
        await new GithubOAuthClient(fetcher).startDeviceAuth();
        expect(new URLSearchParams(requestBody).get("client_id")).toBe(expectedClientId);
      }
    } finally {
      if (originalMode === undefined) delete process.env.CARTETHYIA_GITHUB_COPILOT_MODE;
      else process.env.CARTETHYIA_GITHUB_COPILOT_MODE = originalMode;
    }
  });

  test("refuses cross-profile refresh before calling the mint endpoint", async () => {
    const { fetch: fetcher, calls } = stubFetch(() => new Response("unexpected", { status: 500 }));
    const client = new GithubOAuthClient(fetcher, GITHUB_CLIENT_ID);
    await expect(client.refresh("github-token", undefined, {
      account_id: "account-1",
      auth_state: { github_copilot_profile: "opencode-copilot" },
    })).rejects.toThrow("github_copilot_profile_mismatch");
    expect(calls).toHaveLength(0);
  });

  test("OpenCode refresh keeps the raw token without minting", async () => {
    const { fetch: fetcher, calls } = stubFetch(() => {
      return new Response("not found", { status: 404 });
    });
    const client = new GithubOAuthClient(fetcher, GITHUB_OPENCODE_CLIENT_ID);

    const refreshed = await client.refresh("github-token");
    expect(calls.some((call) => call.url.includes("copilot_internal/v2/token"))).toBe(false);
    const parsed = JSON.parse(refreshed.access as string) as {
      access?: string;
      apiHost?: string;
      github?: string;
      profile?: string;
    };
    expect(parsed.access).toBe("github-token");
    expect(parsed.apiHost).toBe(GITHUB_OPENCODE_API_HOST);
    expect(parsed.github).toBe("github-token");
    expect(parsed.profile).toBe("opencode-copilot");
    expect(refreshed.auth_state).toEqual({ github_copilot_profile: "opencode-copilot" });
    expect(refreshed.refresh).toBe("github-token");
  });
});
