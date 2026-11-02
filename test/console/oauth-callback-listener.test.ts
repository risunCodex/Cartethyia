import { describe, expect, test } from "bun:test";
import { OAuthCallbackListener } from "../../src/console/providers/oauth/callback-listener";

/**
 * The listener binds a real port, so `serve` is stubbed: these tests are about
 * what the handler decides, not about Bun's socket behaviour.
 */
function harness() {
  const completions: {
    providerId: string;
    code: string;
    state: string;
    callbackParams?: Readonly<Record<string, string>>;
  }[] = [];
  let handler: ((request: Request) => Response | Promise<Response>) | undefined;
  const listener = new OAuthCallbackListener({
    completer: {
      async complete(providerId, code, state, callbackParams) {
        completions.push({ providerId, code, state, ...(callbackParams ? { callbackParams } : {}) });
        return { ok: true, message: "done" };
      },
    },
    serve: (options) => {
      handler = options.fetch;
      return { stop() {} };
    },
  });
  const request = async (query: string): Promise<Response> => {
    if (handler === undefined) throw new Error("listener never bound");
    const base = "http://127.0.0.1:1455";
    const target = query.startsWith("/") ? `${base}${query}` : `${base}/callback${query}`;
    return await handler(new Request(target));
  };
  return { listener, request, completions };
}

describe("OAuth callback listener", () => {
  test("a callback carrying `code` completes the flow", async () => {
    const { listener, request, completions } = harness();
    listener.register("http://127.0.0.1:1455/callback", "openrouter", "state-1");
    const response = await request("?code=abc&state=state-1");
    expect(response.status).toBe(200);
    expect(completions).toEqual([{ providerId: "openrouter", code: "abc", state: "state-1" }]);
  });

  test("a callback that carries its payload instead of a code is not rejected", async () => {
    // Trae's page redirects with the refresh token already in the query and no
    // `code` at all. Rejecting that here left the operator with "Missing
    // authorization code" after a login that had in fact succeeded.
    const { listener, request, completions } = harness();
    listener.register("http://127.0.0.1:1455/callback", "trae", "state-2");
    const response = await request("?isRedirect=true&refreshToken=rt-1&loginHost=www.trae.ai");
    expect(response.status).toBe(200);
    expect(completions).toHaveLength(1);
    expect(completions[0]?.providerId).toBe("trae");
    expect(completions[0]?.code).toBe("isRedirect=true&refreshToken=rt-1&loginHost=www.trae.ai");
  });

  test("an empty callback is still refused", async () => {
    const { listener, request, completions } = harness();
    listener.register("http://127.0.0.1:1455/callback", "trae", "state-3");
    const response = await request("");
    expect(response.status).toBe(400);
    expect(completions).toHaveLength(0);
  });

  test("accepts a callback on the provider's second registered path", async () => {
    // Kiro's portal (unpacked IDE 1.4.62) redirects to both `/oauth/callback`
    // and `/signin/callback`. A flow registered for `/oauth/callback` must also
    // accept `/signin/callback`, or the login hangs on a 404.
    const { listener, request, completions } = harness();
    listener.register("http://127.0.0.1:1455/oauth/callback", "kiro", "state-k1");
    const response = await request("/signin/callback?code=abc&state=state-k1");
    expect(response.status).toBe(200);
    expect(completions).toEqual([{ providerId: "kiro", code: "abc", state: "state-k1" }]);
  });

  test("forwards every non-consumed query param to the completer", async () => {
    const { listener, request, completions } = harness();
    listener.register("http://127.0.0.1:1455/oauth/callback", "kiro", "state-k2");
    const response = await request(
      "/oauth/callback?code=abc&state=state-k2&login_option=awsidc&issuer_url=https%3A%2F%2Fidc.example&idc_region=us-east-1&client_id=cli&scopes=a+b",
    );
    expect(response.status).toBe(200);
    expect(completions).toHaveLength(1);
    const c = completions[0]!;
    expect(c.code).toBe("abc");
    expect(c.state).toBe("state-k2");
    expect(c.callbackParams).toEqual({
      login_option: "awsidc",
      issuer_url: "https://idc.example",
      idc_region: "us-east-1",
      client_id: "cli",
      scopes: "a b",
    });
  });

  test("track keeps a flow reachable under a second state (Kiro OIDC phase 2)", async () => {
    const { listener, request, completions } = harness();
    listener.register("http://127.0.0.1:1455/oauth/callback", "kiro", "state-1");
    listener.track("http://127.0.0.1:1455/oauth/callback", "state-1", "state-2");
    const response = await request("/oauth/callback?code=abc&state=state-2");
    expect(response.status).toBe(200);
    expect(completions).toEqual([{ providerId: "kiro", code: "abc", state: "state-2" }]);
  });

  test("a login_option callback without a code still reaches the completer", async () => {
    // OIDC/enterprise portal callbacks can carry `login_option` + issuer fields
    // and no `code`; the listener must not reject them as missing-code.
    const { listener, request, completions } = harness();
    listener.register("http://127.0.0.1:1455/oauth/callback", "kiro", "state-k3");
    const response = await request(
      "/oauth/callback?login_option=builderid&issuer_url=https%3A%2F%2Fbuilder.example&idc_region=us-east-1&state=state-k3",
    );
    expect(response.status).toBe(200);
    expect(completions).toHaveLength(1);
    expect(completions[0]?.providerId).toBe("kiro");
    expect(completions[0]?.state).toBe("state-k3");
    // The code falls back to the raw query so the provider can decide.
    expect(completions[0]?.code).toContain("login_option=builderid");
  });
});
