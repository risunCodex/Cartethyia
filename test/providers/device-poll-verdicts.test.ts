/**
 * Factory/Grok device-poll verdicts after the M-30 consolidation onto the
 * shared `pollGenericDeviceAuth` state machine. These pin the RFC 8628
 * backoff mapping (400/428 → pending/slow_down), the failed verdict on a
 * 2xx body without a token, the enriched complete result (Factory's
 * JWT-claim envelope; Grok's identity header), and the never-throws poll
 * contract.
 */
import { describe, expect, test } from "bun:test";
import { FactoryOAuthClient } from "../../src/providers/integrations/factory/factory-oauth";
import { GrokOAuthClient } from "../../src/providers/integrations/grok/grok-oauth";
import { decodeFactoryDroidCredential } from "../../src/security/credential-codec";

const FACTORY_TOKEN_URL = "https://api.workos.com/user_management/authenticate";
const GROK_TOKEN_URL = "https://auth.x.ai/oauth2/token";

function stubFetch(response: Response, urlContains: string | null = null): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    void init;
    const url = String(input);
    if (urlContains === null || url.includes(urlContains)) return response;
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function jwt(claims: Record<string, unknown>): string {
  const encode = (value: unknown) =>
    btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${encode({ alg: "none" })}.${encode(claims)}.signature`;
}

const FACTORY_ACCESS = jwt({
  sub: "user_01",
  email: "dev@example.com",
  external_org_id: "org_123",
  exp: 1_800_000_000,
});

describe("Factory Droid poll verdicts", () => {
  test("authorization_pending on 400 stays pending", async () => {
    const client = new FactoryOAuthClient(stubFetch(json({ error: "authorization_pending" }, 400), FACTORY_TOKEN_URL));
    const poll = await client.pollDeviceAuth("device-code-1");
    expect(poll.status).toBe("pending");
  });

  test("slow_down on 428 carries the server interval", async () => {
    const client = new FactoryOAuthClient(stubFetch(json({ error: "slow_down", interval: 10 }, 428), FACTORY_TOKEN_URL));
    const poll = await client.pollDeviceAuth("device-code-1");
    expect(poll).toEqual({ status: "slow_down", retryAfterSeconds: 10 });
  });

  test("an unrecognized 400 error is failed with the error key", async () => {
    const client = new FactoryOAuthClient(stubFetch(json({ error: "invalid_grant" }, 400), FACTORY_TOKEN_URL));
    const poll = await client.pollDeviceAuth("device-code-1");
    expect(poll.status).toBe("failed");
    expect(poll.status === "failed" && poll.reason).toBe("invalid_grant");
  });

  test("a 2xx body without an access token is failed, not complete", async () => {
    const client = new FactoryOAuthClient(stubFetch(json({ error: "authorization_expired" }), FACTORY_TOKEN_URL));
    const poll = await client.pollDeviceAuth("device-code-1");
    expect(poll.status).toBe("failed");
  });

  test("completes with the JWT-claim envelope, keeping the refresh grant", async () => {
    const client = new FactoryOAuthClient(
      stubFetch(json({ access_token: FACTORY_ACCESS, refresh_token: "workos-refresh" }), FACTORY_TOKEN_URL),
    );
    const poll = await client.pollDeviceAuth("device-code-1");
    expect(poll.status).toBe("complete");
    if (poll.status !== "complete") throw new Error("unreachable");
    expect(poll.result.refresh).toBe("workos-refresh");
    const envelope = decodeFactoryDroidCredential(poll.result.access);
    expect(envelope.orgId).toBe("org_123");
    expect(poll.result.auth_state).toMatchObject({ orgId: "org_123", email: "dev@example.com", userId: "user_01" });
  });

  test("refuses a token carrying no organization claim", async () => {
    const client = new FactoryOAuthClient(
      stubFetch(json({ access_token: jwt({ sub: "user_01" }) }), FACTORY_TOKEN_URL),
    );
    const poll = await client.pollDeviceAuth("device-code-1");
    expect(poll.status).toBe("failed");
    expect(poll.status === "failed" && poll.reason).toMatch(/organization claim/);
  });
});

describe("Grok poll verdicts", () => {
  test("invalid JSON body is failed with Grok's message", async () => {
    const client = new GrokOAuthClient(stubFetch(new Response("not json", { status: 200 }), GROK_TOKEN_URL));
    const poll = await client.pollDeviceAuth("device-code-1");
    expect(poll.status).toBe("failed");
    expect(poll.status === "failed" && poll.reason).toBe("grok token endpoint returned invalid JSON");
  });

  test("a 200 body with an error field and no token is failed", async () => {
    const client = new GrokOAuthClient(stubFetch(json({ error: "access_denied" }), GROK_TOKEN_URL));
    const poll = await client.pollDeviceAuth("device-code-1");
    expect(poll.status).toBe("failed");
    expect(poll.status === "failed" && poll.reason).toBe("access_denied");
  });

  test("error_description wins over error for non-200 failures", async () => {
    const client = new GrokOAuthClient(
      stubFetch(json({ error: "invalid_request", error_description: "device is stale" }, 400), GROK_TOKEN_URL),
    );
    const poll = await client.pollDeviceAuth("device-code-1");
    expect(poll.status).toBe("failed");
    expect(poll.status === "failed" && poll.reason).toBe("device is stale");
  });

  test("an error field on a 200 that is a poll state still gets the backoff verdict", async () => {
    const client = new GrokOAuthClient(stubFetch(json({ error: "authorization_pending", interval: 5 }), GROK_TOKEN_URL));
    const poll = await client.pollDeviceAuth("device-code-1");
    expect(poll.status).toBe("pending");
    expect(poll.status === "pending" && poll.retryAfterSeconds).toBe(5);
  });

  test("completes and enriches the identity", async () => {
    const access = jwt({ exp: 1_800_000_000 });
    const fetcher = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/oauth2/token")) return json({ access_token: access });
      if (url.includes("/v1/user")) {
        return json({ email: "grok@example.com", userId: "uid-1" });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;
    const client = new GrokOAuthClient(fetcher);
    const poll = await client.pollDeviceAuth("device-code-1");
    expect(poll.status).toBe("complete");
    if (poll.status !== "complete") throw new Error("unreachable");
    expect(poll.result.accountLabel).toBe("grok@example.com");
    expect(poll.result.auth_state).toMatchObject({ userId: "uid-1" });
  });
});
