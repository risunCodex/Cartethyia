/**
 * Perch adapter dispatch (pure HTTP), driven with a stub fetch that answers
 * the SSE model-call stream. Verifies the emitted events, the request body
 * shape (Saffron prompt, Roost tier, attribution, ticket headers), and the
 * error paths.
 */
import { describe, expect, test } from "bun:test";
import type { CanonicalRequest } from "../../src/protocol/canonical-model";
import type { ProviderDispatchContext, ProviderDispatchTarget } from "../../src/providers/provider-contracts";
import { createPerchAdapter } from "../../src/providers/integrations/perch/perch";
import { PERCH_SAFFRON_SYSTEM_PROMPT } from "../../src/providers/integrations/perch/perch-protocol";

const SECRET = new TextEncoder().encode(
  JSON.stringify({
    appUrl: "https://app.perchai.app",
    accessToken: "jwt-access",
    refreshToken: "jwt-refresh",
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    userId: "u1",
    email: "a@b.c",
  }),
);

function request(overrides: Partial<CanonicalRequest> = {}): CanonicalRequest {
  return {
    model: "standard",
    messages: [{ role: "user", content: [{ kind: "text", text: "hello" }] }],
    generation_controls: {},
    stream: false,
    source_surface: "chat",
    ...overrides,
  };
}

function context(overrides: Partial<ProviderDispatchContext> = {}): ProviderDispatchContext {
  return {
    credential: { provider_id: "perch", credential_kind: "oauth", secret: SECRET, account_id: "acc-1" },
    deadline: Date.now() + 120_000,
    abort_signal: new AbortController().signal,
    ...overrides,
  } as unknown as ProviderDispatchContext;
}

function candidate(model = "standard"): ProviderDispatchTarget {
  return {
    provider_id: "perch",
    model_id: model,
    wire_family: "chat",
    endpoint_path: "/api/perch-terminal/model-call",
  } as unknown as ProviderDispatchTarget;
}

function stubFetch(requests: { url: string; init?: RequestInit }[]) {
  let seq = 0;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String(input);
    requests.push({ url, ...(init === undefined ? {} : { init }) });
    seq++;
    if (url.includes("/turn-ticket")) {
      return new Response(
        JSON.stringify({ ok: true, ticket: `tk-${seq}`, runId: `run-${seq}` }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.includes("/api/perchai/account")) {
      return new Response(
        JSON.stringify({
          ok: true,
          session: { userId: "u1", workspaceId: "w1", orgId: "o1", planCode: "pilot" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.includes("/model-call")) {
      const sse = [
        'data: {"type":"keepalive"}',
        'data: {"type":"answer_delta","text":"pong"}',
        'data: {"type":"done","ok":true,"text":"pong","model":"deepseek-v4.1-flash-1017","provider":"perch","usage":{"inputTokens":61,"outputTokens":4,"totalTokens":6593}}',
        "",
      ].join("\n");
      return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
  return fetchImpl;
}

async function drain(
  adapter: { dispatch: (r: CanonicalRequest, c: ProviderDispatchTarget, x: ProviderDispatchContext) => AsyncIterable<unknown> },
  req: CanonicalRequest,
  cand: ProviderDispatchTarget,
  ctx: ProviderDispatchContext,
): Promise<unknown[]> {
  const events: unknown[] = [];
  for await (const event of adapter.dispatch(req, cand, ctx)) {
    events.push(event);
  }
  return events;
}

describe("PerchAdapter (HTTP)", () => {
  test("emits message_start, content_delta, usage, terminal on success", async () => {
    const requests: { url: string; init?: RequestInit }[] = [];
    const adapter = createPerchAdapter({ fetch: stubFetch(requests) });
    const events = await drain(adapter, request(), candidate(), context());
    expect(events.map((e) => (e as { type: string }).type)).toEqual([
      "message_start",
      "content_delta",
      "usage",
      "terminal",
    ]);
    const delta = events[1] as { content: { kind: string; text: string } };
    expect(delta.content.text).toBe("pong");
    const terminal = events[3] as { state: string; provider_metadata?: Record<string, unknown> };
    expect(terminal.state).toBe("complete");
    expect(terminal.provider_metadata?.model).toBe("deepseek-v4.1-flash-1017");
    const usageEvent = events[2] as { usage: { input_tokens: number; output_tokens: number } };
    expect(usageEvent.usage.input_tokens).toBe(61);
    expect(usageEvent.usage.output_tokens).toBe(4);
  });

  test("sends the full CLI envelope: Saffron prompt, Roost tier, attribution, ticket", async () => {
    const requests: { url: string; init?: RequestInit }[] = [];
    const adapter = createPerchAdapter({ fetch: stubFetch(requests) });
    await drain(adapter, request(), candidate("standard 1m"), context());

    const call = requests.find((r) => r.url.includes("/model-call"));
    expect(call).toBeDefined();
    const headers = new Headers(call!.init?.headers);
    expect(headers.get("authorization")).toBe("Bearer jwt-access");
    expect(headers.get("x-perch-call-delta")).toBe("1");
    // Ticket mint is the second request (account first? no — mint is first,
    // then account, then model-call). The stub increments its sequence per
    // request: ticket=1, account=2, model-call=3 → ticket tk-1.
    expect(headers.get("x-perch-turn-ticket")).toBe("tk-1");
    expect(headers.get("user-agent")).toBe("perchai-cli/unknown");
    expect(headers.get("accept")).toBe("text/event-stream");

    const body = JSON.parse(String(call!.init?.body)) as Record<string, unknown>;
    expect(body["roostModelChoice"]).toBe("standard_max");
    expect(body["clientSurface"]).toBe("cli");
    expect(body["runId"]).toBe("run-1");
    expect(body["resendAfterOutput"]).toBe(true);
    const attribution = body["attribution"] as Record<string, unknown>;
    expect(attribution["userId"]).toBe("u1");
    expect(attribution["workspaceId"]).toBe("w1");
    expect(attribution["source"]).toBe("cli");
    const req = body["request"] as { messages: { role: string; content: string }[] };
    expect(req.messages[0]?.role).toBe("system");
    expect(req.messages[0]?.content).toBe(PERCH_SAFFRON_SYSTEM_PROMPT);
    expect(req.messages[1]?.role).toBe("user");
    expect(req.messages[1]?.content).toBe("hello");
  });

  test("pins starter-pool models via manualModelOptionId", async () => {
    const requests: { url: string; init?: RequestInit }[] = [];
    const adapter = createPerchAdapter({ fetch: stubFetch(requests) });
    await drain(adapter, request({ model: "glm-5.3-flash-starter" }), candidate("glm-5.3-flash-starter"), context());

    const call = requests.find((r) => r.url.includes("/model-call"));
    expect(call).toBeDefined();
    const body = JSON.parse(String(call!.init?.body)) as Record<string, unknown>;
    expect(body["strictManual"]).toBe(true);
    expect(body["preferredModelId"]).toBe("openrouter-z-ai-glm-5-3-flash-crusoe");
    expect(body["manualModelOptionId"]).toBe("openrouter-z-ai-glm-5-3-flash-crusoe");
    expect(body["roostModelChoice"]).toBe("standard");
  });

  test("uses the validated outbound fetch for ticket, account, and model-call", async () => {
    const requests: { url: string; init?: RequestInit }[] = [];
    const validated = stubFetch(requests);
    const adapter = createPerchAdapter({
      fetch: (() => { throw new Error("global fetch must not be used"); }) as unknown as typeof fetch,
    });
    await drain(adapter, request(), candidate(), context({ outbound_fetch: validated }));
    expect(requests.some((r) => r.url.includes("/turn-ticket"))).toBe(true);
    expect(requests.some((r) => r.url.includes("/api/perchai/account"))).toBe(true);
    expect(requests.some((r) => r.url.includes("/model-call"))).toBe(true);
  });

  test("mints the ticket with the CLI surface body", async () => {
    const requests: { url: string; init?: RequestInit }[] = [];
    const adapter = createPerchAdapter({ fetch: stubFetch(requests) });
    await drain(adapter, request(), candidate(), context());
    const ticketReq = requests.find((r) => r.url.includes("/turn-ticket"));
    expect(ticketReq).toBeDefined();
    const body = JSON.parse(String(ticketReq!.init?.body)) as Record<string, unknown>;
    expect(body["surface"]).toBe("cli");
    expect(body["profile"]).toBe("standard");
  });

  test("emits error + failed terminal when the upstream fails", async () => {
    const requests: { url: string; init?: RequestInit }[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : String(input);
      requests.push({ url, ...(init === undefined ? {} : { init }) });
      if (url.includes("/turn-ticket")) {
        return new Response(JSON.stringify({ ok: true, ticket: "tk-1", runId: "run-1" }), { status: 200 });
      }
      if (url.includes("/api/perchai/account")) {
        return new Response(JSON.stringify({ ok: true, session: {} }), { status: 200 });
      }
      if (url.includes("/model-call")) {
        return new Response(
          JSON.stringify({ ok: false, error: "Model busy", errorCode: "capacity_reached" }),
          { status: 403, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("{}", { status: 404 });
    }) as unknown as typeof fetch;

    const adapter = createPerchAdapter({ fetch: fetchImpl });
    await expect(drain(adapter, request(), candidate(), context())).rejects.toThrow();
  });

  test("ships the Saffron prompt as a bundled literal", () => {
    // The compiled binary has no .txt asset: a file-backed constant used to
    // fall back to a two-line stub, which the upstream rejected with
    // `403 perch_surface_required`.
    expect(PERCH_SAFFRON_SYSTEM_PROMPT.length).toBeGreaterThan(400);
    expect(PERCH_SAFFRON_SYSTEM_PROMPT).toContain("You're not an assistant");
  });
});
