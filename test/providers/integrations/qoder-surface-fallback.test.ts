/**
 * Qoder dispatch transport: gRPC by default for billed models, legacy COSY
 * for free-tier rows (`lite`), and `cosy` override.
 *
 * Live verification (2026-11-04): the gRPC surface
 * (`model.chat.ChatService/ChatCompletionStream`) is the only proven carrier
 * of real 1M-token context, but it refuses free-tier rows with `quota
 * exceeded` (116) — free-tier dispatch must use the legacy COSY surface
 * (`/algo/.../agent_chat_generation`).
 */
import { describe, expect, test } from "bun:test";
import {
  createQoderAdapter,
  resolveQoderTransport,
} from "../../../src/providers/integrations/qoder/qoder";
import type { CanonicalRequest } from "../../../src/protocol/canonical-model";
import type {
  ProviderDispatchContext,
  ProviderDispatchTarget,
} from "../../../src/providers/provider-contracts";

/** A device-token credential secret (`dt-...`), never printed. */
const SECRET = new TextEncoder().encode("dt-test-token");
const MACHINE_ID = "00000000-0000-0000-0000-000000000000";

const TARGET: ProviderDispatchTarget = {
  provider_id: "qoder",
  model_id: "qfmodel",
  wire_family: "chat",
  capabilities: {},
} as unknown as ProviderDispatchTarget;

function request(): CanonicalRequest {
  return {
    model: "qfmodel",
    messages: [{ role: "user", content: [{ kind: "text", text: "hi" }] }],
    generation_controls: {},
    stream: true,
    source_surface: "chat",
  } as unknown as CanonicalRequest;
}

function streamOk(): Response {
  return new Response(
    "data: {\"object\":\"chat.completion.chunk\",\"choices\":[{\"delta\":{\"content\":\"ok\"},\"finish_reason\":null}]}\n\n",
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

function context(fetcher: typeof fetch): ProviderDispatchContext {
  return {
    outbound_fetch: fetcher,
    deadline: Date.now() + 60_000,
    abort_signal: new AbortController().signal,
    credential: {
      credential_id: "c1",
      provider_id: "qoder",
      credential_kind: "oauth",
      secret: SECRET,
      auth_state: { userId: "u1", machineId: MACHINE_ID },
    },
    user_agent: "test",
    request_headers: {},
  } as unknown as ProviderDispatchContext;
}

async function collect(
  adapter: ReturnType<typeof createQoderAdapter>,
  fetcher: typeof fetch,
  modelId = "qfmodel",
): Promise<void> {
  const target: ProviderDispatchTarget = { ...TARGET, model_id: modelId };
  for await (const _event of adapter.dispatch(request(), target, context(fetcher))) {
    void _event;
  }
}

describe("Qoder transport selection", () => {
  test("defaults to legacy COSY for a billed model (gRPC host is dead)", () => {
    expect(resolveQoderTransport(undefined, { id: "dmodel", display_name: "DeepSeek", max_input_tokens: 1_000_000, is_vl: true, is_reasoning: true })).toBe("cosy");
  });

  test("dispatch defaults to legacy COSY for a billed model (no surface override)", async () => {
    const urls: string[] = [];
    let calls = 0;
    const fetcher = (async (input: unknown, _init?: RequestInit): Promise<Response> => {
      calls++;
      urls.push(String(input));
      return streamOk();
    }) as typeof fetch;
    const adapter = createQoderAdapter();
    await collect(adapter, fetcher, "dmodel");
    expect(calls).toBe(1);
    expect(urls[0]).toContain("/algo/api/v2/service/pro/sse/agent_chat_generation");
  });

  test("free-tier row (`lite`) uses legacy COSY", () => {
    expect(resolveQoderTransport(undefined, { id: "lite", display_name: "Lite-Qwen-3.7-Plus", max_input_tokens: 1_000_000, is_vl: true, is_reasoning: false, is_free: true })).toBe("cosy");
  });

  test("explicit `cosy` override forces legacy for any model", () => {
    expect(resolveQoderTransport("cosy", { id: "dmodel", display_name: "DeepSeek", max_input_tokens: 1_000_000, is_vl: true, is_reasoning: true })).toBe("cosy");
  });

  test("explicit `grpc` override is honored for a billed model", () => {
    expect(resolveQoderTransport("grpc", { id: "dmodel", display_name: "DeepSeek", max_input_tokens: 1_000_000, is_vl: true, is_reasoning: true })).toBe("grpc");
  });
});

describe("Qoder dispatch surface (COSY)", () => {
  test("free-tier `lite` dispatch goes straight to legacy COSY, no modern attempt", async () => {
    const urls: string[] = [];
    let calls = 0;
    const fetcher = (async (input: unknown, _init?: RequestInit): Promise<Response> => {
      calls++;
      urls.push(String(input));
      return streamOk();
    }) as typeof fetch;
    const adapter = createQoderAdapter();
    await collect(adapter, fetcher, "lite");
    expect(calls).toBe(1);
    expect(urls[0]).toContain("/algo/api/v2/service/pro/sse/agent_chat_generation");
  });

  test("explicit `cosy` surface uses legacy directly", async () => {
    const urls: string[] = [];
    let calls = 0;
    const fetcher = (async (input: unknown, _init?: RequestInit): Promise<Response> => {
      calls++;
      urls.push(String(input));
      return streamOk();
    }) as typeof fetch;
    const adapter = createQoderAdapter({ surface: "cosy" });
    await collect(adapter, fetcher);
    expect(calls).toBe(1);
    expect(urls[0]).toContain("/algo/api/v2/service/pro/sse/agent_chat_generation");
  });

  test("legacy surface surfaces an upstream 402/116 error as-is for a billed model", async () => {
    const urls: string[] = [];
    let calls = 0;
    const fetcher = (async (input: unknown, _init?: RequestInit): Promise<Response> => {
      calls++;
      urls.push(String(input));
      return new Response(JSON.stringify({ code: 116, error: "quota exceeded" }), {
        status: 402,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const adapter = createQoderAdapter({ surface: "cosy" });
    await expect(collect(adapter, fetcher, "smodel")).rejects.toThrow();
    expect(calls).toBe(1);
    expect(urls[0]).toContain("/algo/api/v2/service/pro/sse/agent_chat_generation");
  });

  test("probe-forced `ide` surface uses the modern /model/v1 endpoint and surfaces provider metadata", async () => {
    const urls: string[] = [];
    let calls = 0;
    const rawUsage = {
      data: {
        completion_tokens: 37,
        provider_model: "qwen3.7-plus",
        supply_model: "qwen3.7-plus",
        supply_region: "global",
        model_level: "lite",
        target: "bailian-qwen3.7-plus-free-260401",
      },
    };
    const ideStream = new Response(
      "data: " +
        JSON.stringify({
          choices: [],
          model: "lite",
          raw_usage: rawUsage,
        }) +
        "\n\n",
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
    const fetcher = (async (input: unknown, _init?: RequestInit): Promise<Response> => {
      calls++;
      urls.push(String(input));
      return ideStream;
    }) as typeof fetch;
    const adapter = createQoderAdapter();
    const target: ProviderDispatchTarget = {
      ...TARGET,
      model_id: "lite",
      probe_surface: "ide",
    };
    const events: Array<Record<string, unknown>> = [];
    for await (const event of adapter.dispatch(request(), target, context(fetcher))) {
      events.push(event as unknown as Record<string, unknown>);
    }
    expect(calls).toBe(1);
    expect(urls[0]).toContain("/model/v1/chat/completions");
    const terminal = events.find((e) => e["type"] === "terminal");
    expect(terminal?.["provider_metadata"]).toEqual({
      provider_model: "qwen3.7-plus",
      supply_model: "qwen3.7-plus",
      supply_region: "global",
      model_level: "lite",
      target: "bailian-qwen3.7-plus-free-260401",
    });
  });
});
