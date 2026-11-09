/**
 * Kiro adapter dispatch — conversation-id integrity.
 *
 * The resolver mints a fresh UUID only when a request carries no session
 * header, no conversation id, and no derivable opening-turn affinity. Before
 * the M-35 consolidation, dispatch resolved it twice, giving
 * `conversationId` and `rootConversationId` two different UUIDs on that
 * fallback path and keying the session-cache estimate under yet another one.
 * These tests pin the fix: one resolution per dispatch, reused for both wire
 * fields and the cache key.
 */
import { describe, expect, test } from "bun:test";
import { createKiroAdapter } from "../../src/providers/integrations/kiro/kiro";
import type { CanonicalRequest } from "../../src/protocol/canonical-model";
import type { ProviderDispatchContext, ProviderDispatchTarget } from "../../src/providers/provider-contracts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A request with no session, conversation id, or derivable affinity → fallback. */
function fallbackRequest(overrides: Partial<CanonicalRequest> = {}): CanonicalRequest {
  return {
    model: "auto",
    stream: true,
    source_surface: "chat",
    messages: [{ role: "user", content: [{ kind: "text", text: "ping" }] }],
    generation_controls: {},
    ...overrides,
  } as CanonicalRequest;
}

function context(overrides: Partial<ProviderDispatchContext> = {}): ProviderDispatchContext {
  return {
    credential: {
      provider_id: "kiro",
      credential_kind: "api_key",
      secret: new TextEncoder().encode("tok"),
      account_id: "acc-1",
      auth_state: { authMethod: "api_key", region: "us-east-1" },
    },
    deadline: Date.now() + 120_000,
    abort_signal: new AbortController().signal,
    ...overrides,
  } as unknown as ProviderDispatchContext;
}

function target(): ProviderDispatchTarget {
  return {
    provider_id: "kiro",
    model_id: "auto",
    wire_family: "chat",
    endpoint_path: "/generateAssistantResponse",
    capabilities: {},
  } as unknown as ProviderDispatchTarget;
}

async function dispatchBody(req: CanonicalRequest, ctx: ProviderDispatchContext): Promise<Record<string, unknown>> {
  let capturedBody = "";
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    capturedBody = String(init?.body ?? "");
    // Empty body: the stream loop finishes immediately with no events; the
    // adapter still yields usage + terminal and the wire body is inspectable.
    return new Response("", { status: 200 });
  }) as unknown as typeof fetch;
  const adapter = createKiroAdapter({ fetch: fetchImpl });
  for await (const _event of adapter.dispatch(req, target(), ctx)) {
    // drain
  }
  const parsed = JSON.parse(capturedBody) as Record<string, unknown>;
  return (parsed["conversationState"] as Record<string, unknown>) ?? {};
}

describe("Kiro conversation-id resolution at dispatch", () => {
  test("fallback path mints ONE id, shared by conversationId and rootConversationId", async () => {
    const cs = await dispatchBody(fallbackRequest(), context());
    const conversationId = cs["conversationId"] as string;
    expect(conversationId).toMatch(UUID_RE);
    expect(cs["rootConversationId"]).toBe(conversationId);
  });

  test("healthy path uses the inbound session id for both fields", async () => {
    const cs = await dispatchBody(
      fallbackRequest(),
      context({ request_headers: { "x-session-id": "ses-42" } }),
    );
    expect(cs["conversationId"]).toBe("ses-42");
    expect(cs["rootConversationId"]).toBe("ses-42");
  });

  test("healthy path keeps the caller's own conversation id", async () => {
    const cs = await dispatchBody(
      fallbackRequest({ conversation_id: "conv-7" }),
      context(),
    );
    expect(cs["conversationId"]).toBe("conv-7");
    expect(cs["rootConversationId"]).toBe("conv-7");
  });
});
