/**
 * Perch OAuth client: authorize URL shape, GoTrue JSON code exchange, refresh.
 *
 * Serves the console browser flow: beginAuthorize builds the authorize URL,
 * the browser returns a code, exchangeCode finishes it.
 */
import { describe, expect, test } from "bun:test";
import { PerchOAuthClient } from "../../src/providers/integrations/perch/perch-oauth";

function stubFetch() {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String(input);
    calls.push({ url, ...(init === undefined ? {} : { init }) });
    if (url.includes("/auth/v1/token")) {
      return new Response(
        JSON.stringify({
          access_token: "jwt-access",
          refresh_token: "jwt-refresh",
          expires_in: 3600,
          user: { id: "u1", email: "a@b.c" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.includes("/auth/v1/user")) {
      return new Response(JSON.stringify({ id: "u1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe("PerchOAuthClient", () => {
  test("builds a Supabase authorize URL with provider and explicit Google scopes", () => {
    const { fetchImpl } = stubFetch();
    const client = new PerchOAuthClient(fetchImpl);
    const url = client.buildAuthorizeUrl({
      state: "st-1",
      codeChallenge: "challenge-1",
      redirectUri: "http://127.0.0.1:1455/callback",
    });
    const parsed = new URL(url);
    expect(parsed.origin).toBe("https://zlfuvsfjtgsdtqcaykia.supabase.co");
    expect(parsed.pathname).toBe("/auth/v1/authorize");
    expect(parsed.searchParams.get("provider")).toBe("google");
    expect(parsed.searchParams.get("client_id")).toBe("sb_publishable_w4R_pNkUpygBFIljZCoOlA_67ACg0FO");
    expect(parsed.searchParams.get("scope")).toBe("openid email profile");
    // GoTrue does not echo `state` on the callback, so the state is embedded
    // in `redirect_to` itself — the callback then carries it.
    const redirectTo = new URL(parsed.searchParams.get("redirect_to") ?? "");
    expect(redirectTo.origin + redirectTo.pathname).toBe("http://127.0.0.1:1455/callback");
    expect(redirectTo.searchParams.get("state")).toBe("st-1");
    expect(parsed.searchParams.get("redirect_uri")).toBeNull();
    expect(parsed.searchParams.get("code_challenge")).toBe("challenge-1");
    expect(parsed.searchParams.get("code_challenge_method")).toBe("S256");
    expect(parsed.searchParams.get("state")).toBe("st-1");
  });

  test("exchanges a code via JSON with grant_type=pkce and auth_code", async () => {
    const { fetchImpl, calls } = stubFetch();
    const client = new PerchOAuthClient(fetchImpl);
    const result = await client.exchangeCode(
      "code-1",
      "verifier-1",
      "http://127.0.0.1:1455/callback",
      "st-1",
    );

    expect(result.access).toBe("jwt-access");
    expect(result.refresh).toBe("jwt-refresh");
    expect(result.expiresAt).toBeInstanceOf(Date);

    const tokenCall = calls.find((c) => c.url.includes("/auth/v1/token"));
    expect(tokenCall).toBeDefined();
    const parsed = new URL(tokenCall!.url);
    expect(parsed.searchParams.get("grant_type")).toBe("pkce");
    expect(tokenCall!.init?.method).toBe("POST");
    const headers = new Headers(tokenCall!.init?.headers);
    expect(headers.get("apikey")).toBe("sb_publishable_w4R_pNkUpygBFIljZCoOlA_67ACg0FO");
    expect(headers.get("content-type")).toBe("application/json");
    const body = JSON.parse(String(tokenCall!.init?.body)) as Record<string, unknown>;
    expect(body["auth_code"]).toBe("code-1");
    expect(body["code_verifier"]).toBe("verifier-1");
    // The embedded state is replayed exactly as in buildAuthorizeUrl.
    expect(body["redirect_to"]).toBe("http://127.0.0.1:1455/callback?state=st-1");

    // The CLI stamps signup_source=cli after exchange.
    const userCall = calls.find((c) => c.url.includes("/auth/v1/user") && c.init?.method === "PUT");
    expect(userCall).toBeDefined();
    const userBody = JSON.parse(String(userCall!.init?.body)) as Record<string, unknown>;
    expect((userBody["data"] as Record<string, unknown>)["signup_source"]).toBe("cli");
  });

  test("refreshes via JSON with grant_type=refresh_token", async () => {
    const { fetchImpl, calls } = stubFetch();
    const client = new PerchOAuthClient(fetchImpl);
    const refreshed = await client.refresh("refresh-1");

    expect(refreshed.access).toBe("jwt-access");
    expect(refreshed.refresh).toBe("jwt-refresh");

    const tokenCall = calls.find((c) => c.url.includes("/auth/v1/token"));
    const parsed = new URL(tokenCall!.url);
    expect(parsed.searchParams.get("grant_type")).toBe("refresh_token");
    const headers = new Headers(tokenCall!.init?.headers);
    expect(headers.get("content-type")).toBe("application/json");
    const body = JSON.parse(String(tokenCall!.init?.body)) as Record<string, unknown>;
    expect(body["refresh_token"]).toBe("refresh-1");
  });
});
