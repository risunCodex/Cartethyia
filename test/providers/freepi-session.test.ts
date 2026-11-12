/**
 * Free-pi connection-bound sessions.
 *
 * The upstream binds native tool_call ids to the `x-session-id` that opened
 * them. A session reused after the affinity/account/model changes answers
 * "does not belong to this session"; the fix is a fresh session per owner and
 * a rebase of the transcript (native ids become plain text) on refusal.
 */
import { describe, expect, test } from "bun:test";
import { FreepiAdapter } from "../../src/providers/integrations/freepi/freepi";
import {
  FreepiSessionRegistry,
  freepiSessionOwner,
  isFreepiSessionOwnershipError,
  rebaseFreepiRequest,
  withFreshFreepiAffinity,
} from "../../src/providers/integrations/freepi/freepi-session";
import { throwFreepiUpstreamError } from "../../src/providers/integrations/freepi/freepi-protocol";
import { GatewayError } from "../../src/protocol/gateway-error";
import type { CanonicalRequest } from "../../src/protocol/canonical-model";
import type { ProviderDispatchContext, ProviderDispatchTarget } from "../../src/providers/provider-contracts";

function baseRequest(overrides: Partial<CanonicalRequest> = {}): CanonicalRequest {
  return {
    model: "deepseek/deepseek-v4-flash",
    messages: [{ role: "user", content: [{ kind: "text", text: "hello there, this is a long enough opening prompt for affinity" }] }],
    stream: true,
    generation_controls: {},
    source_surface: "chat",
    ...overrides,
  };
}

function context(input: {
  readonly accountId?: string;
  readonly headers?: Record<string, string>;
  readonly secret?: string;
  readonly fetch?: typeof fetch;
}): ProviderDispatchContext {
  return {
    credential: {
      provider_id: "freepi" as ProviderDispatchContext["credential"]["provider_id"],
      account_id: input.accountId ?? "acct-1",
      credential_kind: "oauth",
      secret: new TextEncoder().encode(input.secret ?? "jwt-1"),
    },
    deadline: Date.now() + 30_000,
    abort_signal: new AbortController().signal,
    ...(input.fetch === undefined ? {} : { outbound_fetch: input.fetch as unknown as ProviderDispatchContext["outbound_fetch"] }),
    ...(input.headers === undefined ? {} : { request_headers: input.headers }),
  };
}

const candidate: ProviderDispatchTarget = {
  provider_id: "freepi" as ProviderDispatchTarget["provider_id"],
  model_id: "deepseek/deepseek-v4-flash",
  wire_family: "chat",
  endpoint_path: "/v1/chat/completions",
  capabilities: {},
};

function sse(...frames: unknown[]): ReadableStream<Uint8Array> {
  const text = frames
    .map((frame) => (typeof frame === "string" ? `data: ${frame}\n\n` : `data: ${JSON.stringify(frame)}\n\n`))
    .join("") + "data: [DONE]\n\n";
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

describe("Free-pi session identity", () => {
  test("a changed affinity is a fresh session; a stable affinity reuses it", () => {
    const registry = new FreepiSessionRegistry();
    const a = freepiSessionOwner({ secret: "jwt", context: context({}), request: baseRequest(), modelId: "m" });
    const same = freepiSessionOwner({ secret: "jwt", context: context({}), request: baseRequest(), modelId: "m" });
    expect(registry.get(a).sessionId).toBe(registry.get(same).sessionId);

    const changed = freepiSessionOwner({
      secret: "jwt",
      context: context({ headers: { "x-session-affinity": "other-conversation" } }),
      request: baseRequest(),
      modelId: "m",
    });
    expect(registry.get(changed).sessionId).not.toBe(registry.get(a).sessionId);
  });

  test("a new account never inherits the old account's session", () => {
    const registry = new FreepiSessionRegistry();
    const one = freepiSessionOwner({ secret: "jwt", context: context({ accountId: "a" }), request: baseRequest(), modelId: "m" });
    const two = freepiSessionOwner({ secret: "jwt", context: context({ accountId: "b" }), request: baseRequest(), modelId: "m" });
    expect(one.key).not.toBe(two.key);
    expect(registry.get(one).sessionId).not.toBe(registry.get(two).sessionId);
  });

  test("rotate drops the owner and a fresh affinity mints a different id", () => {
    const registry = new FreepiSessionRegistry();
    const owner = freepiSessionOwner({ secret: "jwt", context: context({}), request: baseRequest(), modelId: "m" });
    const before = registry.get(owner).sessionId;
    registry.rotate(owner);
    const after = registry.get(owner).sessionId;
    expect(after).not.toBe(before);
    const fresh = withFreshFreepiAffinity(owner);
    expect(fresh.key).not.toBe(owner.key);
    expect(registry.get(fresh).sessionId).not.toBe(after);
  });
});

describe("Free-pi ownership refusal and rebase", () => {
  test("HTTP and 200-SSE 'does not belong to' are both classified", () => {
    const http = new GatewayError("upstream_conflict", 409, "nope", {
      raw: JSON.stringify({ code: "session_mismatch", message: "tool_call_id does not belong to this session" }),
    }, "upstream");
    expect(isFreepiSessionOwnershipError(http)).toBe(true);
    let sseError: unknown;
    try {
      throwFreepiUpstreamError("upstream_error", "input item does not belong to this connection");
    } catch (error) {
      sseError = error;
    }
    expect(sseError).toBeInstanceOf(GatewayError);
    expect(isFreepiSessionOwnershipError(sseError)).toBe(true);
    expect(isFreepiSessionOwnershipError(new GatewayError("quota_exceeded", 429, "slow down"))).toBe(false);
  });

  test("rebase turns native tool ids into text and drops the stale cache key", () => {
    const request = baseRequest({
      messages: [
        { role: "assistant", content: [{ kind: "toolCall", call_id: "call_1", name: "lookup", arguments: { q: "x" } }] },
        { role: "tool", content: [{ kind: "toolResult", call_id: "call_1", content: "found it" }] },
        { role: "user", content: [{ kind: "text", text: "now answer" }] },
      ],
      generation_controls: { "extension:prompt_cache_key": "old-affinity" } as CanonicalRequest["generation_controls"],
    });
    const rebased = rebaseFreepiRequest(request);
    const json = JSON.stringify(rebased.messages);
    expect(json).not.toContain("call_1");
    expect(json).toContain("Earlier tool call lookup");
    expect(json).toContain("Earlier tool result: found it");
    expect(rebased.generation_controls["extension:prompt_cache_key"]).toBeUndefined();
  });

  test("an ownership refusal rotates the session, rebases, and retries once", async () => {
    const sessionIds: string[] = [];
    const bodies: Record<string, unknown>[] = [];
    let chatCalls = 0;
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/ads/")) return new Response("{}", { status: 204 });
      chatCalls += 1;
      const headers = (init?.headers ?? {}) as Record<string, string>;
      sessionIds.push(headers["x-session-id"] ?? "");
      bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      if (chatCalls === 1) {
        return new Response(JSON.stringify({
          code: "session_mismatch",
          message: "tool_call_id does not belong to this session",
        }), { status: 409, headers: { "content-type": "application/json" } });
      }
      return new Response(sse({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as unknown as typeof fetch;

    const adapter = new FreepiAdapter({ fetch: fetcher });
    const request = baseRequest({
      messages: [
        { role: "assistant", content: [{ kind: "toolCall", call_id: "call_stale", name: "lookup", arguments: "{}" }] },
        { role: "tool", content: [{ kind: "toolResult", call_id: "call_stale", content: "value" }] },
      ],
    });
    const events = [];
    for await (const event of adapter.dispatch(request, candidate, context({ fetch: fetcher }))) events.push(event);
    expect(chatCalls).toBe(2);
    expect(sessionIds[0]).not.toBe(sessionIds[1]);
    expect(JSON.stringify(bodies[1])).not.toContain("call_stale");
    expect(JSON.stringify(bodies[1])).toContain("Earlier tool call lookup");
    expect(events.some((event) => event.type === "content_delta")).toBe(true);
  });

  test("a non-ownership error is terminal, not retried", async () => {
    let chatCalls = 0;
    const fetcher = (async (input: RequestInfo | URL) => {
      if (String(input).includes("/ads/")) return new Response("{}", { status: 204 });
      chatCalls += 1;
      return new Response(JSON.stringify({ code: "model_at_capacity", message: "busy" }), {
        status: 503,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const adapter = new FreepiAdapter({ fetch: fetcher });
    let thrown: unknown;
    try {
      for await (const _ of adapter.dispatch(baseRequest(), candidate, context({ fetch: fetcher }))) { /* drain */ }
    } catch (error) {
      thrown = error;
    }
    expect(chatCalls).toBe(1);
    expect(thrown).toBeInstanceOf(GatewayError);
  });
});
