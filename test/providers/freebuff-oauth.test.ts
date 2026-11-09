/**
 * Freebuff device-flow OAuth tests.
 *
 * The flow is a code login: `POST /api/auth/cli/code` issues a hosted login
 * URL + fingerprint, and `GET /api/auth/cli/status` is polled until the
 * browser sign-in completes. Facts pinned here mirror the donor gateway
 * (freebuff-proxy):
 *
 * - The flow collects NO operator fields — the account identity (email/name)
 *   comes back in the poll response, so the dialog must not ask for an email.
 * - The server reports `expiresAt` as an epoch-millisecond NUMBER; the poll
 *   query must carry it verbatim (a string coercion of a numeric field drops
 *   it, and the upstream answers 401 forever).
 * - `401`/`404` from the status endpoint means "not authorized yet" and is
 *   pending, never a failure — the 401 is the steady state before the
 *   browser approves.
 * - Transient network/timeout failures on code issue retry once on the same
 *   route.
 */
import { describe, expect, test } from "bun:test";
import { FreebuffOAuthClient } from "../../src/providers/integrations/freebuff/freebuff-oauth";

const NOW = Date.now();

function codeBody() {
  return {
    fingerprintId: "fp-1",
    fingerprintHash: "abc123",
    loginUrl: "https://www.codebuff.com/login?auth_code=CODE123",
    expiresAt: NOW + 3_600_000, // epoch-ms number
    expiresInMs: 3_600_000,
  };
}

/** A fetch that records calls and answers the first route whose prefix matches. */
function recordingFetch(routes: Array<{ prefix: string; handler: (url: string) => Response }>) {
  const seen: Array<{ url: string; init?: RequestInit }> = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    seen.push({ url, ...(init === undefined ? {} : { init }) });
    for (const { prefix, handler } of routes) {
      if (url.startsWith(prefix)) return handler(url);
    }
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  return { seen, fetchFn };
}

function clientWith(fetchFn: typeof fetch): FreebuffOAuthClient {
  return new FreebuffOAuthClient(fetchFn);
}

describe("Freebuff device flow", () => {
  test("starts without collecting an email field", async () => {
    // The device flow must not ask the operator for anything: identity comes
    // from the poll response.
    const client = clientWith((async () => new Response("{}", { status: 200 })) as unknown as typeof fetch);
    expect(client.deviceLoginFields).toEqual([]);
    expect(client.supportsDeviceCode).toBe(true);
    expect(client.supportsBrowserCode).toBe(false);
  });

  test("issues a code and keeps the numeric expiresAt for the poll query", async () => {
    const { seen, fetchFn } = recordingFetch([
      { prefix: "https://www.codebuff.com/api/auth/cli/code", handler: () => new Response(JSON.stringify(codeBody()), { status: 200 }) },
    ]);
    const client = clientWith(fetchFn);

    const started = await client.startDeviceAuth();
    expect(started.verificationUri).toBe("https://www.codebuff.com/login?auth_code=CODE123");
    expect(started.deviceAuthId).toMatch(/^[0-9a-f-]{36}$/);
    expect(started.intervalSeconds).toBe(3);
    expect(started.expiresInSeconds).toBe(3600);
    // The providerState must carry the raw numeric expiresAt.
    const state = JSON.parse(started.providerState ?? "{}") as Record<string, unknown>;
    expect(state.expiresAt).toBe(String(NOW + 3_600_000));
    expect(seen).toHaveLength(1);
  });

  test("treats 401 and 404 as pending, not failure", async () => {
    const { fetchFn } = recordingFetch([
      { prefix: "https://www.codebuff.com/api/auth/cli/code", handler: () => new Response(JSON.stringify(codeBody()), { status: 200 }) },
    ]);
    const client = clientWith(fetchFn);
    const started = await client.startDeviceAuth();
    const state = JSON.parse(started.providerState ?? "{}") as { fingerprintId: string; fingerprintHash: string; expiresAt: string };
    const pollCtx = {
      providerId: "freebuff",
      tenantId: null,
      accountLabel: "freebuff",
      providerState: JSON.stringify(state),
    };

    // 401 before browser approval — the donor maps this to pending.
    const unauthenticated = clientWith(
      ((async () => new Response(JSON.stringify({ error: "Authentication failed" }), { status: 401 })) as unknown as typeof fetch),
    );
    const pending = await unauthenticated.pollDeviceAuth(state.fingerprintId, pollCtx);
    expect(pending.status).toBe("pending");

    // 404 (unknown fingerprint) is also pending — the flow is not dead.
    const missing = clientWith((async () => new Response("", { status: 404 })) as unknown as typeof fetch);
    const missingPoll = await missing.pollDeviceAuth(state.fingerprintId, pollCtx);
    expect(missingPoll.status).toBe("pending");
  });

  test("completes when the status response carries the user", async () => {
    const deviceKeyPrefix = "https://www.codebuff.com/api/v1/freebuff/device-keys";
    let signedIn = false;
    const { seen, fetchFn } = recordingFetch([
      { prefix: "https://www.codebuff.com/api/auth/cli/code", handler: () => new Response(JSON.stringify(codeBody()), { status: 200 }) },
      {
        prefix: deviceKeyPrefix,
        handler: () => new Response(JSON.stringify({ keyId: "k_test" }), { status: 200 }),
      },
      {
        prefix: "https://www.codebuff.com/api/auth/cli/status",
        handler: () =>
          signedIn
            ? new Response(
                JSON.stringify({
                  user: {
                    authToken: "token-real",
                    id: "acc_1",
                    email: "person@example.com",
                    name: "Person",
                  },
                }),
                { status: 200 },
              )
            : new Response(JSON.stringify({ error: "Authentication failed" }), { status: 401 }),
      },
    ]);
    const client = clientWith(fetchFn);

    const started = await client.startDeviceAuth();
    const state = JSON.parse(started.providerState ?? "{}") as { fingerprintId: string; fingerprintHash: string; expiresAt: string };
    const pollCtx = {
      providerId: "freebuff",
      tenantId: null,
      accountLabel: "freebuff",
      providerState: JSON.stringify(state),
    };

    // First poll: 401 (pending). Then the browser approves.
    const before = await client.pollDeviceAuth(state.fingerprintId, pollCtx);
    expect(before.status).toBe("pending");
    signedIn = true;

    const polled = await client.pollDeviceAuth(state.fingerprintId, pollCtx);
    expect(polled.status).toBe("complete");
    if (polled.status !== "complete") return;
    expect(polled.result.access).toBe("token-real");
    expect(polled.result.accountLabel).toBe("Person");
    expect(polled.result.auth_state?.accountId).toBe("acc_1");
    const deviceKey = (polled.result.auth_state?.device as { keyId?: string } | undefined)?.keyId;
    expect(deviceKey).toContain("user:acc_1");
    // The device-key registration must have happened with the polled token.
    const deviceCall = seen.find((c) => c.url.startsWith(deviceKeyPrefix));
    expect(deviceCall).toBeDefined();
    const headers = new Headers(deviceCall?.init?.headers);
    expect(headers.get("authorization")).toBe("Bearer token-real");
  });

  test("retries a transient code-issue failure once", async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls += 1;
      if (calls === 1) throw new TypeError("fetch failed");
      return new Response(JSON.stringify(codeBody()), { status: 200 });
    }) as unknown as typeof fetch;
    const client = clientWith(fetchFn);
    const started = await client.startDeviceAuth();
    expect(started.verificationUri).toBe("https://www.codebuff.com/login?auth_code=CODE123");
    expect(calls).toBe(2);
  });
});
