/**
 * OAuth credential import for Codex and Antigravity, plus `tokens` envelope
 * unwrapping in `parsePastedOAuthCredential`.
 */
import { describe, expect, test } from "bun:test";
import { CodexOAuthClient } from "../../src/providers/integrations/codex/codex-oauth";
import { AntigravityOAuthClient } from "../../src/providers/integrations/antigravity/antigravity-oauth";
import { parsePastedOAuthCredential } from "../../src/console/providers/catalog/store-helpers";
import {
  attachProviderCapabilities,
  sanitizeProviderResponse,
} from "../../src/console/providers/catalog/provider-operations-projection";
import { createDefaultProviderRegistry } from "../../src/providers/default-registry";

function fakeJwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  return `${encode({ alg: "RS256", typ: "JWT" })}.${encode(payload)}.sig`;
}

function codexAccessJwt(email = "user@example.com", accountId = "acct_123"): string {
  return fakeJwt({
    exp: Math.floor(Date.now() / 1000) + 3600,
    "https://api.openai.com/auth": { chatgpt_account_id: accountId },
    "https://api.openai.com/profile": { email },
  });
}

describe("Codex & Antigravity OAuth credential import", () => {
  test("attachProviderCapabilities advertises import and refreshable for codex and antigravity", async () => {
    const registry = createDefaultProviderRegistry();

    const codexProjected = await attachProviderCapabilities(
      sanitizeProviderResponse({ providerId: "codex", isBuiltIn: true }),
      registry,
    );
    expect(codexProjected.oauthFlows?.import).toBe(true);
    expect(codexProjected.oauthFlows?.refreshable).toBe(true);

    const agProjected = await attachProviderCapabilities(
      sanitizeProviderResponse({ providerId: "antigravity", isBuiltIn: true }),
      registry,
    );
    expect(agProjected.oauthFlows?.import).toBe(true);
    expect(agProjected.oauthFlows?.refreshable).toBe(true);
  });

  test("parsePastedOAuthCredential unwraps Codex CLI tokens envelope", () => {
    const parsed = parsePastedOAuthCredential(
      JSON.stringify({
        tokens: {
          access_token: "at-cli",
          refresh_token: "rt-cli",
          account_id: "acct_cli",
        },
        providerSpecificData: { projectId: "proj_1" },
      }),
    );
    expect(parsed.accessToken).toBe("at-cli");
    expect(parsed.refreshToken).toBe("rt-cli");
    expect(parsed.authState).toEqual({ projectId: "proj_1" });
  });

  test("Codex importCredential accepts a valid full export without calling fetch and preserves providerSpecificData", async () => {
    let fetchCalls = 0;
    const client = new CodexOAuthClient((() => {
      fetchCalls += 1;
      throw new Error("unexpected fetch");
    }) as unknown as typeof fetch);

    const jwt = codexAccessJwt("mig@example.com", "acct_mig");
    const result = await client.importCredential({
      credential: JSON.stringify({
        accessToken: jwt,
        refreshToken: "rt-codex-valid",
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        providerSpecificData: { workspace: "team-a" },
      }),
      fields: {},
    });

    expect(fetchCalls).toBe(0);
    expect(result.access).toBe(jwt);
    expect(result.refresh).toBe("rt-codex-valid");
    expect(result.accountLabel).toBe("mig@example.com");
    expect(result.auth_state).toEqual({ workspace: "team-a" });
  });

  test("Codex importCredential supports Codex CLI tokens shape and bare refresh token via refresh", async () => {
    const freshJwt = codexAccessJwt("refreshed@example.com", "acct_ref");
    const client = new CodexOAuthClient((async () => {
      return new Response(
        JSON.stringify({
          access_token: freshJwt,
          refresh_token: "rt-rotated",
          expires_in: 3600,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch);

    const fromTokens = await client.importCredential({
      credential: JSON.stringify({
        tokens: {
          access_token: "expired-at",
          refresh_token: "rt-cli-old",
          expires_at: 1_000_000,
        },
      }),
      fields: {},
    });
    expect(fromTokens.access).toBe(freshJwt);
    expect(fromTokens.refresh).toBe("rt-rotated");
    expect(fromTokens.accountLabel).toBe("refreshed@example.com");

    const fromBare = await client.importCredential({
      credential: "rt-bare-only",
      fields: {},
    });
    expect(fromBare.access).toBe(freshJwt);
    expect(fromBare.refresh).toBe("rt-rotated");
  });

  test("Antigravity importCredential supports valid JSON export and bare refresh token", async () => {
    const urls: string[] = [];
    const client = new AntigravityOAuthClient((async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("oauth2.googleapis.com/token")) {
        return new Response(
          JSON.stringify({
            access_token: "ag-at-new",
            refresh_token: "ag-rt-new",
            expires_in: 3600,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("userinfo")) {
        return new Response(JSON.stringify({ email: "ag@example.com" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ cloudaicompanionProject: "proj-ag" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch);

    const direct = await client.importCredential({
      credential: JSON.stringify({
        access_token: "ag-at-valid",
        refresh_token: "ag-rt-valid",
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        email: "preset@example.com",
        providerSpecificData: { projectId: "cloud-proj" },
      }),
      fields: {},
    });
    expect(direct.access).toBe("ag-at-valid");
    expect(direct.refresh).toBe("ag-rt-valid");
    expect(direct.accountLabel).toBe("preset@example.com");
    expect(direct.auth_state).toEqual({ projectId: "cloud-proj" });
    expect(urls).toHaveLength(0);

    const refreshed = await client.importCredential({
      credential: "1//0g-bare-refresh",
      fields: {},
    });
    expect(refreshed.access).toBe("ag-at-new");
    expect(refreshed.refresh).toBe("ag-rt-new");
    expect(refreshed.accountLabel).toBe("ag@example.com");
    expect(urls.some((u) => u.includes("oauth2.googleapis.com/token"))).toBe(true);
    expect(urls.some((u) => u.includes("userinfo"))).toBe(true);

    const noRotateClient = new AntigravityOAuthClient((async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("oauth2.googleapis.com/token")) {
        return new Response(
          JSON.stringify({ access_token: "ag-at-keep", expires_in: 3600 }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch);
    const preserved = await noRotateClient.importCredential({
      credential: "1//0g-keep-me",
      fields: {},
    });
    expect(preserved.access).toBe("ag-at-keep");
    expect(preserved.refresh).toBe("1//0g-keep-me");
  });

  test("rejects empty credentials and JSON without refresh_token", async () => {
    const codex = new CodexOAuthClient();
    const ag = new AntigravityOAuthClient();
    await expect(codex.importCredential({ credential: "   ", fields: {} })).rejects.toThrow(
      "required",
    );
    await expect(
      ag.importCredential({ credential: JSON.stringify({ access_token: "only-at" }), fields: {} }),
    ).rejects.toThrow("refresh_token");
  });
});
