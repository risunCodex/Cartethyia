// Devin chat adapter end-to-end test against a fake Connect transport.
// Verifies the whole dispatch path: GetUserJwt -> GetChatMessage frame ->
// canonical events (text, thinking, tool calls, usage, terminal), without
// touching the network.

import { describe, expect, test } from "bun:test";
import { gzipSync, gunzipSync } from "node:zlib";
import type { CanonicalRequest } from "../../src/protocol/canonical-model";
import type { ProviderDispatchContext, ProviderDispatchTarget } from "../../src/providers/provider-contracts";
import { devinAdapter } from "../../src/providers/integrations/devin/devin";
import { DevinMessageTypes } from "../../src/providers/integrations/devin/protocol/devin-proto";
import { CONNECT_END_STREAM_FLAG } from "../../src/providers/integrations/shared/connect";

function frame(payload: object, flags = 0): Buffer {
  const bytes = Buffer.from(DevinMessageTypes.GetChatMessageResponse.encode(payload).finish());
  const header = Buffer.alloc(5);
  header[0] = flags;
  header.writeUInt32BE(bytes.length, 1);
  return Buffer.concat([header, bytes]);
}

function endStreamFrame(): Buffer {
  const body = Buffer.from("{}");
  const header = Buffer.alloc(5);
  header[0] = CONNECT_END_STREAM_FLAG;
  header.writeUInt32BE(body.length, 1);
  return Buffer.concat([header, body]);
}

function fakeFetch(chunks: Buffer[]): typeof fetch {
  const state = { calls: [] as { url: string; headers: Record<string, string>; body: Buffer }[] };
  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = init?.body ? Buffer.from(init.body as Uint8Array) : Buffer.alloc(0);
    state.calls.push({ url, headers, body });

    if (url.includes("GetUserJwt")) {
      const bytes = Buffer.from(
        DevinMessageTypes.GetUserJwtResponse.encode({ userJwt: "jwt-123" }).finish(),
      );
      return new Response(bytes, { status: 200, headers: { "content-type": "application/proto" } });
    }
    if (url.includes("GetChatMessage")) {
      return new Response(
        new ReadableStream({
          start(controller) {
            for (const chunk of chunks) controller.enqueue(new Uint8Array(chunk));
            controller.close();
          },
        }),
        { status: 200, headers: { "content-type": "application/connect+proto" } },
      );
    }
    return new Response("unexpected path", { status: 404 });
  };
  Object.defineProperty(impl, "calls", { get: () => state.calls });
  return impl as unknown as typeof fetch;
}

function context(fetcher: typeof fetch): ProviderDispatchContext {
  return {
    credential: {
      provider_id: "devin" as never,
      credential_kind: "api_key",
      secret: new TextEncoder().encode("sk-ws-test-key"),
    },
    deadline: Date.now() + 30_000,
    abort_signal: new AbortController().signal,
    outbound_fetch: fetcher as never,
  };
}

const target: ProviderDispatchTarget = {
  provider_id: "devin" as never,
  model_id: "swe-2-flash-medium",
  wire_family: "chat" as never,
  endpoint_path: "/exa.api_server_pb.ApiServerService/GetChatMessage",
  capabilities: {},
};

const request: CanonicalRequest = {
  model: "swe-2-flash-medium",
  system: [{ kind: "text", text: "You are helpful." }],
  messages: [{ role: "user", content: [{ kind: "text", text: "hello" }] }],
  generation_controls: {},
  stream: true,
  source_surface: "chat",
};

describe("Devin chat adapter (fake transport)", () => {
  test("an oversized history is refused before the upstream call as context_length_exceeded", async () => {
    // Devin's own answer to an oversized prompt is a SILENT stream close
    // (HTTP 200, no frames, no trailer — live-verified 2026-11-17), which the
    // generic decoder reads as "ended without content" and the gateway maps
    // to a 502. The pre-dispatch guard names the overflow instead.
    const filler = Array.from({ length: 20 }, (_, i) => ({
      role: "user" as const,
      content: [{ kind: "text" as const, text: `Note ${i}: ${"the quick brown fox jumps over the lazy dog. ".repeat(2000)}` }],
    }));
    const fetcher = fakeFetch([]);
    const events = [];
    for await (const event of devinAdapter.dispatch(
      { ...request, messages: [...filler, { role: "user" as const, content: [{ kind: "text" as const, text: "ready?" }] }] },
      target,
      context(fetcher),
    )) {
      events.push(event);
    }
    // Guard fired before any upstream call.
    const calls = (fetcher as unknown as { calls: { url: string }[] }).calls;
    expect(calls.length).toBe(0);
    const terminal = events.find((e) => e.type === "terminal") as { state: string; stop_details?: Record<string, unknown> };
    expect(terminal.state).toBe("failed");
    expect(terminal.stop_details?.code).toBe("context_length_exceeded");
    expect(terminal.stop_details?.status).toBe(413);
    expect((events.find((e) => e.type === "error") as { message: string }).message).toContain("context window");
  });

  test("message ids are proper UUIDs and empty assistant turns are skipped", async () => {
    const chunks = [frame({ deltaText: "ok" }), endStreamFrame()];
    const fetcher = fakeFetch(chunks);
    const events = [];
    for await (const event of devinAdapter.dispatch(
      {
        ...request,
        messages: [
          { role: "user" as const, content: [{ kind: "text" as const, text: "hello" }] },
          // A foreign assistant turn with reasoning + signature: the signature
          // must NOT reach the wire (it belongs to the provider that minted it).
          {
            role: "assistant" as const,
            content: [
              { kind: "reasoning" as const, payload: "foreign thinking", signature: "foreign-signature" },
              { kind: "text" as const, text: "hi there" },
            ],
          },
          // An assistant turn with nothing at all: skipped entirely.
          { role: "assistant" as const, content: [] },
          { role: "user" as const, content: [{ kind: "text" as const, text: "again" }] },
        ],
      },
      target,
      context(fetcher),
    )) {
      events.push(event);
    }
    expect(events.some((e) => e.type === "terminal" && (e as { state: string }).state === "complete")).toBe(true);

    const callLog = (fetcher as unknown as { calls: { url: string; body: Buffer }[] }).calls;
    const chatCall = callLog.find((call) => call.url.includes("GetChatMessage"))!;
    const framed = chatCall.body;
    const gzipFlag = framed[0] === 1;
    const body = gzipFlag ? gunzipSync(framed.subarray(5)) : framed.subarray(5);
    const decoded = DevinMessageTypes.GetChatMessageRequest.decode(body) as {
      chatMessagePrompts?: Array<{ messageId?: string; thinking?: string; signature?: string }>;
    };
    const prompts = decoded.chatMessagePrompts ?? [];
    // user, assistant, user — the empty assistant turn is gone.
    expect(prompts.length).toBe(3);
    for (const prompt of prompts) {
      expect(prompt.messageId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
    const assistant = prompts[1]!;
    expect(assistant.thinking).toBe("foreign thinking");
    expect(assistant.signature ?? "").toBe("");
  });

  test("full dispatch: auth, framed stream, canonical events", async () => {
    const chunks = [
      frame({ messageId: "m1", deltaThinking: "thinking...", deltaSignature: "sig" }),
      frame({ deltaText: "Hello " }),
      frame({ deltaText: "world", stopReason: 0 }),
      frame({
        usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 1 },
        creditCost: 0.5,
      }),
      endStreamFrame(),
    ];
    const fetcher = fakeFetch(chunks);
    const events = [];
    for await (const event of devinAdapter.dispatch(request, target, context(fetcher))) {
      events.push(event);
    }

    expect((fetcher as unknown as { calls: { url: string }[] }).calls.length).toBe(2);
    expect((fetcher as unknown as { calls: { url: string }[] }).calls[0]!.url).toContain("GetUserJwt");
    expect((fetcher as unknown as { calls: { url: string }[] }).calls[1]!.url).toContain("GetChatMessage");

    expect(events.some((e) => e.type === "response_start")).toBe(true);
    const reasoning = events.find((e) => e.type === "content_delta" && (e as { content: { kind: string } }).content.kind === "reasoning");
    expect(reasoning).toBeDefined();
    const texts = events.filter((e) => e.type === "content_delta" && (e as { content: { kind: string } }).content.kind === "text");
    expect(texts.map((e) => (e as { content: { text: string } }).content.text).join("")).toBe("Hello world");
    const usage = events.find((e) => e.type === "usage");
    expect(usage).toBeDefined();
    expect((usage as { usage: { input_tokens: number } }).usage.input_tokens).toBe(10);
    const terminal = events.at(-1);
    expect(terminal?.type).toBe("terminal");
    expect((terminal as { stop_reason: string }).stop_reason).toBe("stop");
  });

  test("tool-call stream accumulates arguments and emits tool_use", async () => {
    const chunks = [
      frame({ deltaToolCalls: [{ id: "call-1", name: "read_file", argumentsJson: '{"path":' }] }),
      frame({ deltaToolCalls: [{ id: "call-1", name: "read_file", argumentsJson: '"a.txt"}' }] }),
      frame({ stopReason: 10 }),
      endStreamFrame(),
    ];
    const events = [];
    for await (const event of devinAdapter.dispatch(request, target, context(fakeFetch(chunks)))) {
      events.push(event);
    }
    const deltas = events.filter((e) => e.type === "tool_call_delta");
    expect(deltas.length).toBe(2);
    expect(deltas.map((e) => (e as { arguments_delta: string }).arguments_delta).join("")).toBe('{"path":"a.txt"}');
    const terminal = events.at(-1);
    expect((terminal as { stop_reason: string }).stop_reason).toBe("tool_use");
  });

  test("MAX_TOKENS maps to length", async () => {
    const chunks = [frame({ deltaText: "partial", stopReason: 3 }), endStreamFrame()];
    const events = [];
    for await (const event of devinAdapter.dispatch(request, target, context(fakeFetch(chunks)))) {
      events.push(event);
    }
    expect((events.at(-1) as { stop_reason: string }).stop_reason).toBe("length");
  });

  test("trailer error envelope surfaces as an error event", async () => {
    const body = Buffer.from(JSON.stringify({ error: { code: "invalid_argument", message: "bad request" } }));
    const header = Buffer.alloc(5);
    header[0] = CONNECT_END_STREAM_FLAG;
    header.writeUInt32BE(body.length, 1);
    const chunks = [frame({ deltaText: "before" }), Buffer.concat([header, body])];
    const events = [];
    for await (const event of devinAdapter.dispatch(request, target, context(fakeFetch(chunks)))) {
      events.push(event);
    }
    expect(events.some((e) => e.type === "error")).toBe(true);
    expect((events.find((e) => e.type === "error") as { message: string }).message).toContain("invalid_argument");
  });

  test("gzip-compressed response frames decode", async () => {
    const payload = Buffer.from(
      DevinMessageTypes.GetChatMessageResponse.encode({ deltaText: "compressed" }).finish(),
    );
    const gz = gzipSync(payload);
    const header = Buffer.alloc(5);
    header[0] = 0x01;
    header.writeUInt32BE(gz.length, 1);
    const chunks = [Buffer.concat([header, gz]), endStreamFrame()];
    const events = [];
    for await (const event of devinAdapter.dispatch(request, target, context(fakeFetch(chunks)))) {
      events.push(event);
    }
    const texts = events.filter((e) => e.type === "content_delta" && (e as { content: { kind: string } }).content.kind === "text");
    expect(texts.map((e) => (e as { content: { text: string } }).content.text).join("")).toBe("compressed");
  });

  test("inline tool-invocation markup becomes tool_call_delta", async () => {    const chunks = [
      frame({ deltaText: "<|message_model|>get_weather<|content_invoke_tool_json|>" }),
      frame({ deltaText: '{"name":"get_weather","args":{"city":"Paris"}}<|end_message|>' }),
      frame({ stopReason: 10 }),
      endStreamFrame(),
    ];
    const events = [];
    for await (const event of devinAdapter.dispatch(request, target, context(fakeFetch(chunks)))) {
      events.push(event);
    }
    const deltas = events.filter((e) => e.type === "tool_call_delta");
    expect(deltas.length).toBe(1);
    expect((deltas[0] as { name: string }).name).toBe("get_weather");
    expect((deltas[0] as { arguments_delta: string }).arguments_delta).toBe('{"city":"Paris"}');
    const texts = events.filter((e) => e.type === "content_delta" && (e as { content: { kind: string } }).content.kind === "text");
    expect(texts.length).toBe(0);
    expect((events.at(-1) as { stop_reason: string }).stop_reason).toBe("tool_use");
  });

  test("image parts are dropped (unsupported on this wire)", async () => {
    const chunks = [frame({ deltaText: "Red blue", stopReason: 0 }), endStreamFrame()];
    let captured: Buffer | undefined;
    const spyFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("GetChatMessage") && init?.body) captured = Buffer.from(init.body as Uint8Array);
      return fakeFetch(chunks)(input, init);
    }) as typeof fetch;
    const imageRequest: CanonicalRequest = {
      ...request,
      messages: [{ role: "user", content: [
        { kind: "text", text: "What colors?" },
        { kind: "image", payload: { url: "data:image/png;base64,aGVsbG8=" } },
      ] }],
    };
    const events = [];
    for await (const event of devinAdapter.dispatch(imageRequest, target, context(spyFetch))) events.push(event);

    expect(captured).toBeDefined();
    const framePayload = captured![0] === 1
      ? (await import("node:zlib")).gunzipSync(captured!.subarray(5))
      : captured!.subarray(5);
    const decoded = DevinMessageTypes.GetChatMessageRequest.decode(framePayload) as unknown as {
      chatMessagePrompts?: { images?: unknown[] }[];
    };
    // Paired live control proved neither available model consumes inline
    // images, so the adapter must not spend bytes sending them.
    expect(decoded.chatMessagePrompts?.[0]?.images ?? []).toHaveLength(0);
    expect(events.at(-1)?.type).toBe("terminal");
  });

  test("truncated frame reports upstream error instead of a fake stop", async () => {
    const full = frame({ deltaText: "partial" });
    const chunks = [full.subarray(0, 7)]; // header + 2 bytes, no complete payload
    const events = [];
    for await (const event of devinAdapter.dispatch(request, target, context(fakeFetch(chunks)))) {
      events.push(event);
    }
    expect(events.some((e) => e.type === "error")).toBe(true);
    expect(events.at(-1)?.type).toBe("error");
    expect(events.some((e) => e.type === "terminal")).toBe(false);
  });
});
