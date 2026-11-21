/**
 * Kiro web search over the MCP surface (`POST runtime/mcp`, `tools/call`
 * `web_search`).
 *
 * The measured wire (official 1.4.x IDE identity): JSON-RPC 2.0 body, the
 * subscription profile in the `x-amzn-kiro-profile-arn` header (the one
 * surface that carries it there), no opt-out / agent-mode headers, and a
 * results payload embedded as JSON inside `result.content[0].text` — a second
 * parse inside the envelope.
 */
import { describe, expect, test } from "bun:test";
import { kiroAdapter } from "../../src/providers/integrations/kiro/kiro";
import type { ProviderDispatchContext, ProviderDispatchTarget } from "../../src/providers/provider-contracts";

const PROFILE_ARN = "arn:aws:codewhisperer:us-east-1:1:profile/A";

function context(overrides: Record<string, unknown> = {}): ProviderDispatchContext {
  return {
    credential: {
      provider_id: "kiro",
      credential_kind: "oauth",
      secret: new TextEncoder().encode("tok"),
      auth_state: { authMethod: "google", region: "us-east-1", profileArn: PROFILE_ARN, machineId: "ab".repeat(32) },
    },
    abort_signal: undefined,
    ...overrides,
  } as unknown as ProviderDispatchContext;
}

const CANDIDATE = { model_id: "auto", provider_id: "kiro", endpoint: "" } as unknown as ProviderDispatchTarget;

/** Reads one request's url/headers/body off a captured fetch. */
function capture(
  responses: readonly Response[],
): { calls: { url: string; method: string; headers: Record<string, string>; body: string }[]; fetch: typeof fetch } {
  const calls: { url: string; method: string; headers: Record<string, string>; body: string }[] = [];
  const fetchImpl: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    if (init?.headers) new Headers(init.headers).forEach((value, name) => { headers[name.toLowerCase()] = value; });
    calls.push({
      url: typeof input === "string" ? input : String((input as Request).url),
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? init.body : "",
    });
    return responses[Math.min(calls.length - 1, responses.length - 1)];
  }) as typeof fetch;
  return { calls, fetch: fetchImpl };
}

function mcpResponse(results: readonly Record<string, unknown>[]): Response {
  return new Response(
    JSON.stringify({
      result: {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              results: results,
            }),
          },
        ],
      },
    }),
    { status: 200 },
  );
}

describe("kiro websearch (MCP)", () => {
  test("posts the JSON-RPC tools/call with the profile-arn header", async () => {
    const { calls, fetch } = capture([
      mcpResponse([
        { title: "Result One", url: "https://example.com/a", snippet: "first" },
        { title: "Result Two", url: "https://example.com/b", snippet: "second" },
      ]),
    ]);
    const outcome = await kiroAdapter.websearch!(
      { query: "kiro wire audit" },
      CANDIDATE,
      context({ outbound_fetch: fetch }),
    );
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe("https://runtime.us-east-1.kiro.dev/mcp");
    expect(call.method).toBe("POST");
    expect(call.headers["content-type"]).toBe("application/json");
    // The profile rides in the header here — the one surface that does.
    expect(call.headers["x-amzn-kiro-profile-arn"]).toBe(PROFILE_ARN);
    // Conversation-only headers stay off the MCP surface.
    expect(call.headers["x-amzn-codewhisperer-optout"]).toBeUndefined();
    expect(call.headers["x-amzn-kiro-agent-mode"]).toBeUndefined();
    expect(call.headers["x-kiro-machineid"]).toBeUndefined();
    expect(call.headers["x-amzn-kiro-attempt"]).toBeUndefined();
    expect(call.headers["x-amz-user-agent"]).toContain("KiroIDE-1.4.178-");
    expect(call.headers["x-amz-user-agent"]).toContain("-KAS/0.66.102-hotfix.1 acp-client/kiro-ide");
    expect(call.headers["user-agent"]).toContain("api/kiroruntime#1.0.0 m/N");
    // Social sessions send no TokenType.
    expect(call.headers["tokentype"]).toBeUndefined();

    const body = JSON.parse(call.body) as {
      id: string;
      jsonrpc: string;
      method: string;
      params: { name: string; arguments: { query: string } };
    };
    expect(body.jsonrpc).toBe("2.0");
    expect(body.method).toBe("tools/call");
    expect(body.params.name).toBe("web_search");
    expect(body.params.arguments.query).toBe("kiro wire audit");
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/);

    expect(outcome.results).toHaveLength(2);
    expect(outcome.results[0]).toMatchObject({ title: "Result One", url: "https://example.com/a", snippet: "first" });
    expect(outcome.total_results).toBe(2);
  });

  test("respects max_results and converts an epoch-millis page age", async () => {
    const { fetch } = capture([
      mcpResponse([
        { title: "R1", url: "https://example.com/1", snippet: "s1", published_date: 1_700_000_000_000 },
        { title: "R2", url: "https://example.com/2", snippet: "s2" },
        { title: "R3", url: "https://example.com/3", snippet: "s3" },
      ]),
    ]);
    const outcome = await kiroAdapter.websearch!(
      { query: "q", max_results: 2 },
      CANDIDATE,
      context({ outbound_fetch: fetch }),
    );
    expect(outcome.results).toHaveLength(2);
    expect(outcome.results[0]?.published_at).toBe(new Date(1_700_000_000_000).toISOString());
  });

  test("an idc account sends SSO_OIDC; an api_key account sends API_KEY", async () => {
    for (const [authMethod, expected] of [
      ["idc", "SSO_OIDC"],
      ["api_key", "API_KEY"],
      ["google", undefined],
    ] as const) {
      const { calls, fetch } = capture([mcpResponse([{ title: "t", url: "https://example.com" }])]);
      await kiroAdapter.websearch!(
        { query: "q" },
        CANDIDATE,
        context({
          outbound_fetch: fetch,
          credential: {
            provider_id: "kiro",
            credential_kind: authMethod === "api_key" ? "api_key" : "oauth",
            secret: new TextEncoder().encode("tok"),
            auth_state: { authMethod, region: "us-east-1", profileArn: PROFILE_ARN },
          },
        }),
      );
      expect(calls[0]?.headers["tokentype"]).toBe(expected);
    }
  });

  test("an unrecognized payload is a 502, not zero results", async () => {
    const { fetch } = capture([new Response(JSON.stringify({ unexpected: true }), { status: 200 })]);
    const error = await kiroAdapter
      .websearch!({ query: "q" }, CANDIDATE, context({ outbound_fetch: fetch }))
      .then(() => undefined)
      .catch((thrown: unknown) => thrown as { status?: number });
    expect(error?.status).toBe(502);
  });

  test("an upstream refusal surfaces through the shared error mapping", async () => {
    const { fetch } = capture([new Response(JSON.stringify({ message: "throttled" }), { status: 429 })]);
    const error = await kiroAdapter
      .websearch!({ query: "q" }, CANDIDATE, context({ outbound_fetch: fetch }))
      .then(() => undefined)
      .catch((thrown: unknown) => thrown as { status?: number; code?: string });
    expect(error?.status).toBe(429);
    expect(error?.code).toBe("quota_exceeded");
  });

  test("an empty query is a 400 before any request", async () => {
    const { calls, fetch } = capture([mcpResponse([])]);
    const error = await kiroAdapter
      .websearch!({ query: "   " }, CANDIDATE, context({ outbound_fetch: fetch }))
      .then(() => undefined)
      .catch((thrown: unknown) => thrown as { status?: number });
    expect(error?.status).toBe(400);
    expect(calls).toHaveLength(0);
  });
});
