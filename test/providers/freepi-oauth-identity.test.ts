/**
 * Free-pi device login identity: the issued JWT carries the GitHub user
 * (`sub` / `email`), and the flow must resolve it so one account exists per
 * GitHub user. Before this, every device login minted the same static label
 * (`freepi-device`), the OAuth identity fingerprint collided on it, and
 * adding a second account silently replaced the first — the same failure the
 * oauth-relogin-identity suite pins for Cursor.
 */
import { describe, expect, test } from "bun:test";
import { FreepiOAuthClient } from "../../src/providers/integrations/freepi/freepi-oauth";

function stubFetch(token: string) {
  const fetchImpl = (async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = typeof input === "string" ? input : String(input);
    if (url.includes("/auth/token")) {
      return new Response(JSON.stringify({ token }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/auth/github/device")) {
      return new Response(
        JSON.stringify({
          session_id: "sess-1",
          user_code: "ABCD-EFGH",
          verification_uri: "https://github.com/login/device",
          interval: 5,
          expires_in: 900,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  return fetchImpl;
}

function jwt(payload: Record<string, unknown>): string {
  const b64 = (input: string) => Buffer.from(input).toString("base64url");
  return `${b64(JSON.stringify({ alg: "none" }))}.${b64(JSON.stringify(payload))}.`;
}

describe("FreepiOAuthClient device identity", () => {
  test("resolves the GitHub email from the JWT as the account label", async () => {
    const client = new FreepiOAuthClient(stubFetch(jwt({ sub: "12345", email: "octo@example.com" })));
    const poll = await client.pollDeviceAuth("sess-1", {
      providerId: "freepi",
      tenantId: "t1",
      accountLabel: "freepi-device",
    });
    expect(poll.status).toBe("complete");
    if (poll.status !== "complete") throw new Error("unreachable");
    expect(poll.result.accountLabel).toBe("octo@example.com");
    expect(poll.result.auth_state).toEqual({
      freepi_user_id: "12345",
      email: "octo@example.com",
    });
  });

  test("falls back to the GitHub user id when the JWT has no email", async () => {
    const client = new FreepiOAuthClient(stubFetch(jwt({ sub: "42" })));
    const poll = await client.pollDeviceAuth("sess-1", {
      providerId: "freepi",
      tenantId: "t1",
      accountLabel: "freepi-device",
    });
    expect(poll.status).toBe("complete");
    if (poll.status !== "complete") throw new Error("unreachable");
    expect(poll.result.accountLabel).toBe("freepi-42");
    expect(poll.result.auth_state).toEqual({ freepi_user_id: "42" });
  });

  test("different GitHub users resolve to different labels", async () => {
    const a = new FreepiOAuthClient(stubFetch(jwt({ sub: "1", email: "a@example.com" })));
    const b = new FreepiOAuthClient(stubFetch(jwt({ sub: "2", email: "b@example.com" })));
    const pa = await a.pollDeviceAuth("sess-1", {
      providerId: "freepi", tenantId: "t1", accountLabel: "freepi-device",
    });
    const pb = await b.pollDeviceAuth("sess-1", {
      providerId: "freepi", tenantId: "t1", accountLabel: "freepi-device",
    });
    expect(pa.status).toBe("complete");
    expect(pb.status).toBe("complete");
    if (pa.status !== "complete" || pb.status !== "complete") throw new Error("unreachable");
    expect(pa.result.accountLabel).not.toBe(pb.result.accountLabel);
  });

  test("import resolves the email label too", async () => {
    const client = new FreepiOAuthClient(stubFetch("unused"));
    const result = await client.importCredential({
      credential: jwt({ sub: "7", email: "seven@example.com" }),
      fields: {},
    });
    expect(result.accountLabel).toBe("seven@example.com");
    expect(result.auth_state).toEqual({ freepi_user_id: "7", email: "seven@example.com" });
  });
});
