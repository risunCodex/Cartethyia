/**
 * Freebuff adapter dispatch test with a staged mock upstream: catalog →
 * admission → agent-runs START → chat (SSE 200) → FINISH → session DELETE.
 * Asserts the chat request carries the desktop identity group and the official
 * body shape (handle model, codebuff_metadata, provider, 37 tools, worker
 * system, tool_choice, stream) — the exact wire facts that return 200 live.
 */
import { describe, expect, test } from "bun:test";
import type { CanonicalRequest } from "../../src/protocol/canonical-model";
import { createFreebuffAdapter, freebuffMintDeviceKey } from "../../src/providers/integrations/freebuff/freebuff";
import { FREEBUFF_WORKER_SYSTEM_PROMPT } from "../../src/providers/integrations/freebuff/freebuff-constants";
import { FREEBUFF_OFFICIAL_TOOLS } from "../../src/providers/integrations/freebuff/freebuff-constants";
import type { ProviderDispatchContext, ProviderDispatchTarget } from "../../src/providers/provider-contracts";

let FIXTURE_DEVICE: { version: 1; publicKey: string; privateKey: string; keyId: string; installId: string } | undefined;

async function fixtureDevice() {
  if (!FIXTURE_DEVICE) {
    const fetchFn = (async () =>
      new Response(JSON.stringify({ keyId: "k_fixture" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    FIXTURE_DEVICE = await freebuffMintDeviceKey("token-fixture", {
      fetchFn,
      accountId: "acc_1",
    });
  }
  return FIXTURE_DEVICE;
}

function canonicalRequest(): CanonicalRequest {
  return {
    model: "m-8db1ccbba6",
    messages: [{ role: "user", content: [{ kind: "text", text: "say hello" }] }],
    stream: true,
    source_surface: "chat",
    generation_controls: {},
  };
}

function dispatchTarget(): ProviderDispatchTarget {
  return {
    provider_id: "freebuff",
    model_id: "m-8db1ccbba6",
    wire_family: "chat",
    endpoint_path: "/api/v1/chat/completions",
    capabilities: {},
  };
}

async function dispatchContext(seen: Array<{ url: string; init: RequestInit }>): Promise<ProviderDispatchContext> {
  const device = await fixtureDevice();
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    seen.push({ url: String(input), init: init ?? {} });
    const url = String(input);
    if (url.includes("/api/v1/freebuff/models")) {
      return new Response(
        JSON.stringify({
          fetchId: "fbf1.fixture",
          rows: [
            { key: "m-8db1ccbba6", displayName: "DeepSeek", handle: "fbm1.AAAFixture", access: "open", premium: false },
            { key: "m-096e75164d", displayName: "DeepSeek Fast", handle: "fbm1.AAAFast", access: "open", premium: false },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ) as Response;
    }
    if (url.includes("/session/admission")) {
      return new Response(
        JSON.stringify({
          status: "active",
          accessTier: "limited",
          instanceId: "inst-1",
          model: "m-8db1ccbba6",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ) as Response;
    }
    if (url.includes("/agent-runs")) {
      const method = (init?.method ?? "POST").toUpperCase();
      if (method === "POST") {
        return new Response(
          JSON.stringify({ runId: "run-1" }),
          { status: 200, headers: { "content-type": "application/json" } },
        ) as Response;
      }
      return new Response(JSON.stringify({ success: true }), { status: 200 }) as Response;
    }
    if (url.includes("/chat/completions")) {
      const sse = [
        'data: {"choices":[{"delta":{"role":"assistant","content":"Hel"},"index":0}]}',
        "",
        'data: {"choices":[{"delta":{"content":"lo"},"index":0}]}',
        "",
        'data: {"choices":[{"delta":{},"index":0,"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":2}}',
        "",
        'data: [DONE]',
        "",
      ].join("\n");
      return new Response(sse, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }) as Response;
    }
    if (url.includes("/session")) {
      return new Response(JSON.stringify({ status: "ended" }), { status: 200 }) as Response;
    }
    return new Response("{}", { status: 200 }) as Response;
  }) as unknown as typeof fetch;
  return {
    credential: {
      provider_id: "freebuff",
      credential_kind: "oauth",
      secret: new TextEncoder().encode("token-fixture"),
      auth_state: { accountId: "acc_1", device },
    },
    deadline: Date.now() + 60_000,
    abort_signal: new AbortController().signal,
    outbound_fetch: fetchFn as unknown as typeof fetch,
  };
}

describe("Freebuff adapter dispatch", () => {
  test("sends the desktop identity group and official body on chat", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const adapter = createFreebuffAdapter();
    const events: unknown[] = [];
    for await (const ev of adapter.dispatch(canonicalRequest(), dispatchTarget(), await dispatchContext(seen))) {
      events.push(ev);
    }

    const chatCall = seen.find((c) => c.url.includes("/chat/completions"));
    expect(chatCall).toBeDefined();
    const headers = chatCall!.init.headers as Record<string, string>;
    // Identity group.
    expect(headers["x-freebuff-client"]).toBe("desktop");
    expect(headers["x-freebuff-client-version"]).toBe("0.0.201");
    expect(headers["x-freebuff-install-id"]).toBe(FIXTURE_DEVICE!.installId);
    expect(headers["x-freebuff-sse-gzip-recovery"]).toBe("1");
    expect(headers["x-freebuff-acting-user-id"]).toBe("acc_1");
    expect(headers["x-freebuff-catalog-fetch"]).toBe("fbf1.fixture");
    expect(headers["x-freebuff-device-key"]).toBe(FIXTURE_DEVICE!.keyId);
    expect(headers["x-freebuff-device-ts"]).toMatch(/^\d+$/);
    expect(headers["x-freebuff-device-sig"]).toBeDefined();
    expect(headers["user-agent"]).toContain("ai-sdk/openai-compatible");

    const body = JSON.parse(String(chatCall!.init.body)) as Record<string, unknown>;
    expect(body["model"]).toBe("fbm1.AAAFixture");
    expect(body["stream"]).toBe(true);
    expect(body["tool_choice"]).toBe("auto");
    expect(body["provider"]).toEqual({ allow_fallbacks: true });
    const tools = body["tools"] as unknown[];
    expect(tools.length).toBe(37);
    expect(tools).toEqual(JSON.parse(JSON.stringify(FREEBUFF_OFFICIAL_TOOLS)));
    const metadata = body["codebuff_metadata"] as Record<string, unknown>;
    expect(metadata["freebuff_instance_id"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(metadata["freebuff_multi_session"]).toBe("1");
    expect(metadata["run_id"]).toBe("run-1");
    expect(metadata["client_id"]).toMatch(/^[0-9a-z]{11,13}$/);
    expect(metadata["cost_mode"]).toBe("free");
    const messages = body["messages"] as Array<{ role: string; content: string }>;
    expect(messages[0]?.role).toBe("system");
    expect(messages[0]?.content).toBe(FREEBUFF_WORKER_SYSTEM_PROMPT);

    // The stream decoded into content_delta events.
    const texts = events
      .filter((e) => (e as { type: string }).type === "content_delta")
      .map((e) => {
        const content = (e as { content: { kind: string; text?: string } }).content;
        return content.kind === "text" ? (content.text ?? "") : "";
      })
      .join("");
    expect(texts).toBe("Hello");
  });

  test("errors when device identity is missing", async () => {
    const context = await dispatchContext([]);
    const credential = { ...context.credential, auth_state: { accountId: "acc_1" } };
    const noDeviceContext: ProviderDispatchContext = { ...context, credential };
    const adapter = createFreebuffAdapter();
    let threw = false;
    try {
      const sink: unknown[] = [];
      for await (const ev of adapter.dispatch(canonicalRequest(), dispatchTarget(), noDeviceContext)) {
        sink.push(ev);
      }
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});
