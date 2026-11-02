import { describe, expect, test } from "bun:test";
import { OpenAICompatibleAdapter, withBearerAuthentication } from "../../src/providers/adapters/compatible-adapter";
import { GrokConfig } from "../../src/providers/integrations/grok/grok";
import type { CanonicalRequest } from "../../src/protocol/canonical-model";

describe("Grok request compression (zstd)", () => {
  test("adapter config enables zstd", () => {
    expect((GrokConfig as { request_compression?: string }).request_compression).toBe("zstd");
  });

  test("postUpstreamJson sends a zstd-compressed body with Content-Encoding header", async () => {
    let capturedBody: Uint8Array | string | undefined;
    let capturedEncoding: string | null | undefined;
    const outboundFetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = init?.body as Uint8Array | string;
      capturedEncoding = new Headers(init?.headers).get("content-encoding");
      return new Response(JSON.stringify({ id: "resp_1", object: "response", status: "completed", output: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const adapter = new OpenAICompatibleAdapter(
      withBearerAuthentication({
        provider_id: "grok",
        base_url: "https://cli-chat-proxy.grok.com",
        endpoint_paths_by_wire_family: { responses: "/v1/responses" },
        extra_headers: { accept: "text/event-stream", "accept-encoding": "identity" },
        request_compression: "zstd",
        fetchImpl: outboundFetch as typeof fetch,
      }),
    );

    const request: CanonicalRequest = {
      model: "grok-4.7",
      messages: [{ role: "user", content: [{ kind: "text", text: "hi" }] }],
      generation_controls: {},
      stream: true,
      source_surface: "chat",
    };
    const context = {
      credential: { credential_kind: "oauth", provider_id: "grok", secret: new TextEncoder().encode("token") },
      request_headers: {},
      request_identity: {},
      abort_signal: new AbortController().signal,
      user_agent: undefined,
    } as never;

    const candidate = {
      provider_id: "grok",
      model_id: "grok-4.7",
      wire_family: "responses",
      endpoint_path: "/v1/responses",
      capabilities: {},
    } as never;

    // dispatch() is an async generator: iterate it to run the transport.
    const events: unknown[] = [];
    for await (const ev of adapter.dispatch(request, candidate, context)) {
      events.push(ev);
    }
    expect(events.length).toBeGreaterThan(0);
    expect(capturedEncoding).toBe("zstd");
    expect(capturedBody).toBeInstanceOf(Uint8Array);
    // Decompress and verify it's the original JSON
    const decompressed = JSON.parse(Bun.zstdDecompressSync(capturedBody as Uint8Array).toString());
    expect(decompressed.model).toBe("grok-4.7");
    expect(decompressed.stream).toBe(true);
  });
});
