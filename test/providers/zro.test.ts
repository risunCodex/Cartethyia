/**
 * Zro (moonmath) provider tests: Messages-wire adapter + bearer auth, model
 * discovery (live `/v1/models` forced onto Messages), and the key-validity
 * quota probe.
 *
 * The wire facts under test were verified live 2026-11-09:
 * - `POST /v1/messages` with `Authorization: Bearer sk-...` answers 200 and
 *   returns an Anthropic-shaped envelope (id/type/role/content/usage).
 * - The full Claude Code header set is accepted but not required.
 * - `GET /v1/models` is the entitlement surface — a key only sees the models
 *   it may call; a model outside that set answers 403 `user_model_access_denied`.
 * - No billing/quota endpoint exists (all probe paths 404).
 */
import { describe, expect, test } from "bun:test";
import type { CanonicalRequest } from "../../src/protocol/canonical-model";
import { createZroAdapter, ZRO_MODELS, zroModelDiscovery, fetchZroQuota } from "../../src/providers/integrations/zro/zro";
import type { ProviderDispatchContext, ProviderDispatchTarget } from "../../src/providers/provider-contracts";

/** A synthesized `/v1/models` response in Zro's entitlement shape. */
const MODELS_PAYLOAD = JSON.stringify({
  object: "list",
  data: [
    { id: "deepseek-v4-flash-0731", mode: "chat", max_input_tokens: 1_048_576, max_output_tokens: 64_000 },
    { id: "zro/deepseek-v4-flash-0731", mode: "chat", max_input_tokens: 1_048_576, max_output_tokens: 64_000 },
    { id: "deepseek-v4.1-flash", mode: "chat", max_input_tokens: 1_048_576, max_output_tokens: 64_000 },
    { id: "zro/deepseek-v4.1-flash", mode: "chat", max_input_tokens: 1_048_576, max_output_tokens: 64_000 },
  ],
});

function stubFetch(body: string, status = 200): typeof fetch {
  return (async () =>
    new Response(body, { status, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
}

async function discover(body: string, status = 200) {
  const loader = zroModelDiscovery();
  const discovery = await loader();
  return discovery({
    baseUrl: "https://zro.moonmath.ai",
    credential: "sk-test",
    fetcher: stubFetch(body, status),
  });
}

function canonicalRequest(): CanonicalRequest {
  return {
    model: "deepseek-v4.1-flash",
    messages: [{ role: "user", content: [{ kind: "text", text: "say hello" }] }],
    stream: false,
    source_surface: "chat",
    generation_controls: {},
  };
}

function dispatchTarget(): ProviderDispatchTarget {
  return {
    provider_id: "zro",
    model_id: "deepseek-v4.1-flash",
    wire_family: "messages",
    endpoint_path: "/v1/messages",
    capabilities: {},
  };
}

function dispatchContext(
  seen: Array<{ url: string; init: RequestInit }>,
): ProviderDispatchContext {
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    seen.push({ url: String(input), init: init ?? {} });
    return new Response(
      JSON.stringify({
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "deepseek-v4.1-flash",
        content: [{ type: "text", text: "hello" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ) as Response;
  }) as unknown as typeof fetch;
  return {
    credential: {
      provider_id: "zro",
      credential_kind: "api_key",
      secret: new TextEncoder().encode("sk-test"),
    },
    deadline: Date.now() + 60_000,
    abort_signal: new AbortController().signal,
    outbound_fetch: fetchFn as unknown as typeof fetch,
  };
}

describe("Zro adapter dispatch", () => {
  test("sends the Messages wire with bearer auth and an Anthropic body", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const adapter = createZroAdapter();
    const events: unknown[] = [];
    for await (const ev of adapter.dispatch(canonicalRequest(), dispatchTarget(), dispatchContext(seen))) {
      events.push(ev);
    }

    const call = seen[0]!;
    expect(call.url).toBe("https://zro.moonmath.ai/v1/messages");
    const headers = call.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer sk-test");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(headers["content-type"]).toBe("application/json");

    const body = JSON.parse(String(call.init.body)) as Record<string, unknown>;
    expect(body.model).toBe("deepseek-v4.1-flash");
    // The shared Claude encoder stamps a `cache_control` breakpoint on the
    // user text; assert the parts that are the provider's contract, not the
    // encoder's cache policy.
    const messages = body.messages as Array<{ role: string; content: Array<{ type: string; text: string }> }>;
    expect(messages[0]?.role).toBe("user");
    expect(messages[0]?.content[0]?.type).toBe("text");
    expect(messages[0]?.content[0]?.text).toBe("say hello");

    const texts = events
      .filter((e) => (e as { type: string }).type === "content_delta")
      .map((e) => {
        const content = (e as { content: { kind: string; text?: string } }).content;
        return content.kind === "text" ? (content.text ?? "") : "";
      })
      .join("");
    expect(texts).toBe("hello");
  });

  test("rejects a non-api_key credential kind", async () => {
    const context = dispatchContext([]);
    const credential = {
      ...context.credential,
      credential_kind: "oauth" as const,
    };
    const adapter = createZroAdapter();
    let threw = false;
    try {
      const sink: unknown[] = [];
      for await (const ev of adapter.dispatch(canonicalRequest(), dispatchTarget(), { ...context, credential })) {
        sink.push(ev);
      }
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});

describe("Zro static catalog", () => {
  test("seeds the live reachable models on the Messages wire", () => {
    expect(ZRO_MODELS.length).toBeGreaterThanOrEqual(2);
    for (const model of ZRO_MODELS) {
      expect(model.wireFamily).toBe("messages");
      expect(model.endpointPath).toBe("/v1/messages");
      expect(model.modelId).toMatch(/^deepseek/);
    }
    const ids = new Set(ZRO_MODELS.map((m) => m.modelId));
    expect(ids.size).toBe(ZRO_MODELS.length);
  });
});

describe("Zro model discovery", () => {
  test("queries the /v1 entitlement surface, not the public /models catalog", async () => {
    let requested = "";
    const loader = zroModelDiscovery();
    const discovery = await loader();
    await discovery({
      baseUrl: "https://zro.moonmath.ai",
      credential: "sk-test",
      fetcher: (async (input: RequestInfo | URL): Promise<Response> => {
        requested = String(input);
        return new Response(MODELS_PAYLOAD, { status: 200 });
      }) as unknown as typeof fetch,
    });
    expect(requested).toBe("https://zro.moonmath.ai/v1/models");
  });

  test("dedupes the zro/ alias onto the bare id", async () => {
    const models = await discover(MODELS_PAYLOAD);
    expect(models).not.toBeNull();
    const ids = (models ?? []).map((model) => model.modelId).sort();
    expect(ids).toEqual([
      "deepseek-v4-flash-0731",
      "deepseek-v4.1-flash",
    ]);
    // No alias rows survive.
    expect(ids.some((id) => id.startsWith("zro/"))).toBe(false);
  });

  test("forces every discovered row onto the Messages wire", async () => {
    const models = await discover(MODELS_PAYLOAD);
    for (const model of models ?? []) {
      expect(model.wireFamily).toBe("messages");
      expect(model.endpointPath).toBe("/v1/messages");
    }
  });

  test("carries the limits the upstream declares", async () => {
    const models = await discover(MODELS_PAYLOAD);
    const flash = (models ?? []).find((model) => model.modelId === "deepseek-v4.1-flash");
    expect(flash?.contextLimit).toBe(1_048_576);
    expect(flash?.outputLimit).toBe(64_000);
  });

  test("falls back to the offline catalog on a failed fetch", async () => {
    const models = await discover("nope", 500);
    expect(models).not.toBeNull();
    expect(models).toHaveLength(ZRO_MODELS.length);
    for (const model of models ?? []) {
      expect(model.wireFamily).toBe("messages");
      expect(model.endpointPath).toBe("/v1/messages");
    }
  });
});

describe("Zro quota collector", () => {
  test("probes the /v1 entitlement surface, not the public /models catalog", async () => {
    let requested = "";
    const result = await fetchZroQuota("sk-test", (async (input: RequestInfo | URL): Promise<Response> => {
      requested = String(input);
      return new Response(JSON.stringify({ object: "list", data: [] }), { status: 200 });
    }) as unknown as typeof fetch);
    expect(requested).toBe("https://zro.moonmath.ai/v1/models");
    expect(result.error).toBeNull();
    expect(result.plan).toBe("limited");
  });

  test("reports a revoked key as an error", async () => {
    const result = await fetchZroQuota("sk-bad", (async () =>
      new Response(JSON.stringify({ error: { message: "Authentication Error" } }), { status: 401 })) as unknown as typeof fetch);
    expect(result.error).not.toBeNull();
    expect(result.plan).toBeNull();
  });
});
