/**
 * DeepAI provider tests: catalog rows, quota collector, browser OAuth.
 */
import { describe, expect, test } from "bun:test";
import { DEEPAI_SPEC } from "../../src/providers/integrations/deepai/provider";
import { DEEPAI_DEFAULT_MODELS } from "../../src/providers/integrations/deepai/deepai-catalog";
import { fetchDeepAIQuota } from "../../src/providers/integrations/deepai/deepai-quota";
import { DeepAIOAuthClient } from "../../src/providers/integrations/deepai/deepai-oauth";
import { createApiKeyAdapter } from "../../src/providers/configured-provider";
import type { FetchLike } from "../../src/providers/quota/quota-contracts";
import type { CanonicalRequest } from "../../src/protocol/canonical-model";
import type { ProviderDispatchContext, ProviderDispatchTarget, ValidatedOutboundFetch } from "../../src/providers/provider-contracts";

const API_KEY = "deepai_test_key";

describe("DeepAI catalog", () => {
  test("spec targets chat + responses wires with the DeepAI base", () => {
    expect(DEEPAI_SPEC.provider_id).toBe("deepai");
    expect(DEEPAI_SPEC.base_url).toBe("https://api.deepai.org");
    expect(DEEPAI_SPEC.endpoint_paths_by_wire_family?.chat).toBe("/deepai_code/chat/completions");
    expect(DEEPAI_SPEC.endpoint_paths_by_wire_family?.responses).toBe("/deepai_code/responses");
    expect(DEEPAI_SPEC.credential_forwarding).toBe("never");
  });

  test("the eleven live-verified free rows carry the freeTier marker and zero cost", () => {
    const free = DEEPAI_DEFAULT_MODELS.filter((m) => m.freeTier === true);
    expect(free.length).toBe(11);
    for (const model of free) {
      expect(model.cost.input).toBe(0);
      expect(model.cost.output).toBe(0);
      expect(model.wireFamily).toBe("chat");
      expect(model.endpointPath).toBe("/deepai_code/chat/completions");
    }
    const ids = free.map((m) => m.modelId).sort();
    expect(ids).toEqual([
      "crouton-alpha",
      "deepai-cyber",
      "deepseek-v4.1-flash",
      "glm-5.3-flash",
      "glyph-cluster",
      "gpt-6-luna",
      "mimo-2.6-flash",
      "mimo-2.6-pro",
      "minimax-m3.1-flash",
      "qwen-3.8-flash",
      "solar-mini-4",
    ]);
  });

  test("gpt-6-astra is the only responses-wire row", () => {
    const responses = DEEPAI_DEFAULT_MODELS.filter((m) => m.wireFamily === "responses");
    expect(responses.length).toBe(1);
    expect(responses[0]?.modelId).toBe("gpt-6-astra");
    expect(responses[0]?.endpointPath).toBe("/deepai_code/responses");
  });

  test("metered rows are not free-tier", () => {
    const metered = DEEPAI_DEFAULT_MODELS.filter((m) => m.freeTier !== true);
    expect(metered.length).toBe(11);
    for (const model of metered) {
      expect(model.freeTier).not.toBe(true);
    }
  });
});

describe("fetchDeepAIQuota", () => {
  function fetcher(theos: unknown, summary?: unknown): FetchLike {
    return (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : String(input);
      if (url.endsWith("/deepai_code/theos")) {
        return new Response(JSON.stringify(theos), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/get_usage_summary")) {
        return new Response(JSON.stringify(summary ?? {}), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("{}", { status: 404 });
    }) as unknown as FetchLike;
  }

  test("reads the daily Theos window and free plan", async () => {
    const result = await fetchDeepAIQuota(
      API_KEY,
      fetcher(
        {
          enabled: true,
          lane_version: 4,
          balance: "49.88669",
          granted: "50.00000",
          refresh_at: "2026-11-12T15:51:29+00:00",
          check_in: { nonce: "aaa", seconds: 600 },
        },
        { is_authenticated: true, is_pro: false },
      ),
    );
    expect(result.error).toBeNull();
    expect(result.plan).toBe("free");
    const theos = result.windows.find((w) => w.kind === "theos_daily");
    expect(theos).toBeDefined();
    expect(theos?.limit).toBeCloseTo(50, 5);
    expect(theos?.used).toBeCloseTo(0.11331, 5);
    expect(theos?.resetsAt).toBe(new Date("2026-11-12T15:51:29+00:00").toISOString());
    expect(theos?.accounting).toBe("pooled");
  });

  test("reports pro plan when the usage summary says so", async () => {
    const result = await fetchDeepAIQuota(
      API_KEY,
      fetcher(
        { enabled: true, balance: "49", granted: "50", refresh_at: "2026-11-12T00:00:00Z" },
        { is_authenticated: true, is_pro: true },
      ),
    );
    expect(result.plan).toBe("pro");
  });

  test("returns empty windows when theos read fails", async () => {
    const result = await fetchDeepAIQuota(
      API_KEY,
      (async () => new Response("unauthorized", { status: 401 })) as unknown as FetchLike,
    );
    expect(result.plan).toBeNull();
    expect(result.windows).toEqual([]);
    expect(result.error).not.toBeNull();
  });
});

describe("DeepAIOAuthClient", () => {
  function stubFetch() {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : String(input);
      calls.push({ url, ...(init === undefined ? {} : { init }) });
      if (url.includes("/deepai_code/desktop_auth/exchange/")) {
        return new Response(
          JSON.stringify({ api_key: "deepai_exchanged", username: "jinhsera", is_pro: false }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.endsWith("/deepai_code/theos")) {
        return new Response(JSON.stringify({ enabled: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;
    return { fetchImpl, calls };
  }

  test("authorize URL carries state and the loopback port", () => {
    const { fetchImpl } = stubFetch();
    const client = new DeepAIOAuthClient(fetchImpl);
    const url = client.buildAuthorizeUrl({
      state: "st-123",
      codeChallenge: "challenge",
      redirectUri: "http://127.0.0.1:48916/callback",
    });
    const parsed = new URL(url);
    expect(parsed.origin).toBe("https://api.deepai.org");
    expect(parsed.pathname).toBe("/deepai_code/desktop_auth/");
    expect(parsed.searchParams.get("state")).toBe("st-123");
    expect(parsed.searchParams.get("port")).toBe("48916");
  });

  test("authorize URL falls back to the default port for a public redirect", () => {
    const { fetchImpl } = stubFetch();
    const client = new DeepAIOAuthClient(fetchImpl);
    const url = client.buildAuthorizeUrl({
      state: "st-456",
      codeChallenge: "challenge",
      redirectUri: "https://cartethyia.example.com/providers/oauth/callback",
    });
    const parsed = new URL(url);
    expect(parsed.searchParams.get("port")).toBe("59653");
    expect(parsed.searchParams.get("state")).toBe("st-456");
  });

  test("exchange posts the code and returns the api_key", async () => {
    const { fetchImpl, calls } = stubFetch();
    const client = new DeepAIOAuthClient(fetchImpl);
    const result = await client.exchangeCode("code-1", "verifier", "http://127.0.0.1:48916/callback");
    expect(result.access).toBe("deepai_exchanged");
    expect(result.accountLabel).toBe("jinhsera");
    expect(result.auth_state?.["is_pro"]).toBe(false);
    const exchangeCall = calls.find((c) => c.url.includes("/deepai_code/desktop_auth/exchange/"));
    expect(exchangeCall).toBeDefined();
    expect(JSON.parse(String(exchangeCall?.init?.body))).toEqual({ code: "code-1" });
  });

  test("import validates the key against /theos", async () => {
    const { fetchImpl } = stubFetch();
    const client = new DeepAIOAuthClient(fetchImpl);
    const result = await client.importCredential({ credential: "deepai_pasted", fields: {} });
    expect(result.access).toBe("deepai_pasted");
    expect(result.auth_state?.["via"]).toBe("import");
  });

  test("import rejects an invalid key", async () => {
    const fetchImpl = (async () => new Response("unauthorized", { status: 401 })) as unknown as typeof fetch;
    const client = new DeepAIOAuthClient(fetchImpl);
    await expect(client.importCredential({ credential: "bad", fields: {} })).rejects.toThrow();
  });
});

describe("DeepAI adapter dispatch", () => {
  const TARGET: ProviderDispatchTarget = {
    provider_id: "deepai",
    model_id: "glm-5.3-flash",
    wire_family: "chat",
    endpoint_path: "/deepai_code/chat/completions",
    capabilities: {},
  };

  function request(): CanonicalRequest {
    return {
      model: "glm-5.3-flash",
      messages: [{ role: "user", content: [{ kind: "text", text: "hi" }] }],
      generation_controls: {},
      stream: false,
      source_surface: "chat",
    };
  }

  function context(fetcher: ValidatedOutboundFetch): ProviderDispatchContext {
    return {
      credential: {
        provider_id: "deepai",
        credential_kind: "oauth",
        secret: new TextEncoder().encode(API_KEY),
      },
      deadline: Date.now() + 30_000,
      abort_signal: new AbortController().signal,
      outbound_fetch: fetcher,
    };
  }

  test("stamps Api-Key and lane headers; no bearer", async () => {
    let captured: { url: string; init?: RequestInit } | undefined;
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      captured = { url: typeof input === "string" ? input : String(input), ...(init === undefined ? {} : { init }) };
      return new Response(
        JSON.stringify({
          id: "gen_1",
          object: "chat.completion",
          model: "z-ai/glm-5.3-flash",
          choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as ValidatedOutboundFetch;

    const adapter = createApiKeyAdapter(DEEPAI_SPEC);
    let events = 0;
    for await (const _event of adapter.dispatch(request(), TARGET, context(fetcher))) events += 1;
    expect(events).toBeGreaterThan(0);

    expect(captured).toBeDefined();
    expect(captured?.url).toBe("https://api.deepai.org/deepai_code/chat/completions");
    const headers = captured?.init?.headers as Record<string, string> | undefined;
    expect(headers?.["Api-Key"]).toBe(API_KEY);
    expect(headers?.["X-DeepAI-Code-Theos"]).toBe("4");
    expect(headers?.["X-DeepAI-Code-Instance"]).toMatch(/^[0-9a-f]{32}$/);
    expect(headers?.["authorization"]).toBeUndefined();
  });
});
