/**
 * `service_tier` is an OpenAI-style control that only a small set of
 * upstreams understand (`openai`, `codex`, `anthropic`). Every other
 * OpenAI-compatible provider either ignores it or rejects the whole request
 * with `unsupported_value` (measured: GitHub Copilot returns 400). The shared
 * `OpenAICompatibleAdapter` must strip it everywhere else.
 */
import { describe, expect, test } from "bun:test";
import { OpenAICompatibleAdapter, withBearerAuthentication } from "../../src/providers/adapters/compatible-adapter";
import type { CanonicalRequest } from "../../src/protocol/canonical-model";
import type { ProviderDispatchContext, ProviderDispatchTarget, ProviderId } from "../../src/providers/provider-contracts";

interface CapturedRequest {
  readonly body: Record<string, unknown>;
}

async function capture(
  providerId: ProviderId,
): Promise<CapturedRequest> {
  let captured: CapturedRequest | undefined;
  const outboundFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    captured = {
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    };
    return new Response(JSON.stringify({
      id: "resp_1",
      object: "response",
      status: "completed",
      output: [],
    }), { headers: { "content-type": "application/json" } });
  }) as unknown as ProviderDispatchContext["outbound_fetch"];

  const adapter = new OpenAICompatibleAdapter(
    withBearerAuthentication({
      provider_id: providerId,
      base_url: "https://example.api",
      endpoint_paths_by_wire_family: { chat: "/v1/chat/completions", responses: "/v1/responses" },
      fetchImpl: outboundFetch as typeof fetch,
    }),
  );

  const request: CanonicalRequest = {
    model: "test-model",
    messages: [{ role: "user", content: [{ kind: "text", text: "hi" }] }],
    generation_controls: { service_tier: "priority" },
    stream: true,
    source_surface: "chat",
  };
  const candidate = {
    provider_id: providerId,
    model_id: "test-model",
    wire_family: "chat",
    endpoint_path: "/v1/chat/completions",
    capabilities: {},
  } as unknown as ProviderDispatchTarget;
  const context = {
    credential: { credential_kind: "oauth", provider_id: providerId, secret: new TextEncoder().encode("token") },
    request_headers: {},
    request_identity: {},
    abort_signal: new AbortController().signal,
    user_agent: undefined,
  } as unknown as ProviderDispatchContext;

  const events: unknown[] = [];
  for await (const ev of adapter.dispatch(request, candidate, context)) {
    events.push(ev);
  }
  expect(captured).toBeDefined();
  return captured!;
}

describe("service_tier allowlist", () => {
  const pid = (id: string): ProviderId => id as ProviderId;

  test("keeps service_tier for supported providers (openai, codex, anthropic)", async () => {
    for (const providerId of ["openai", "codex", "anthropic"]) {
      const captured = await capture(pid(providerId));
      expect(captured.body.service_tier).toBe("priority");
    }
  });

  test("strips service_tier for unsupported providers", async () => {
    for (const providerId of ["github", "grok", "openrouter", "cursor", "x"]) {
      const captured = await capture(pid(providerId));
      expect(captured.body.service_tier).toBeUndefined();
    }
  });
});
