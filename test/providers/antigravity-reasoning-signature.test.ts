/**
 * Antigravity reasoning-signature preservation.
 *
 * The Claude-route upstream requires every `thinking` block in a replayed
 * assistant turn to carry a `signature`. The Gemini wire delivers that
 * signature as `parts[].thoughtSignature`; the decoder used to drop it, so a
 * second turn in the same session replayed a thinking block without a
 * signature and the upstream answered:
 *   `400 messages.1.content.0.thinking.signature: Field required`
 * (dump 1793966931269, 2026-11-06).
 *
 * These tests pin the fix: `responseParts` extracts `thoughtSignature`, and
 * the Antigravity adapter forwards it on the canonical reasoning event so the
 * next turn re-encodes it (`toGeminiPart` → `thoughtSignature`).
 */
import { describe, expect, test } from "bun:test";
import { responseParts } from "../../src/protocol/response/gemini";
import { dropAntigravityUnsignedReasoning } from "../../src/providers/integrations/antigravity/antigravity-protocol";
import { AntigravityAdapter } from "../../src/providers/integrations/antigravity/antigravity";
import type { CanonicalRequest } from "../../src/protocol/canonical-model";
import type { ProviderDispatchContext, ProviderDispatchTarget } from "../../src/providers/provider-contracts";

const THOUGHT_SIGNATURE = "EpMHABCDEFG_opaque_base64_blob==";

/** SSE body carrying one thought part with a signature, then text, then [DONE]. */
function thoughtSse(): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const chunk = (obj: unknown): Uint8Array =>
    encoder.encode(`data: ${JSON.stringify(obj)}\n\n`);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(
        chunk({
          candidates: [
            {
              content: {
                role: "model",
                parts: [
                  { text: "I should respond warmly.", thought: true, thoughtSignature: THOUGHT_SIGNATURE },
                  { text: "Hello!" },
                ],
              },
              finishReason: "STOP",
            },
          ],
        }),
      );
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
}

function makeContext(impl: typeof fetch): ProviderDispatchContext {
  return {
    outbound_fetch: impl,
    deadline: Date.now() + 60_000,
    abort_signal: new AbortController().signal,
    credential: {
      credential_id: "c1",
      provider_id: "antigravity",
      credential_kind: "oauth",
      kind: "oauth",
      secret: new TextEncoder().encode("test-token"),
    },
    user_agent: "test",
  } as unknown as ProviderDispatchContext;
}

function makeTarget(): ProviderDispatchTarget {
  return {
    provider_id: "antigravity",
    wire_family: "chat",
    endpoint_path: "/v1internal:generateContent",
    credential: {
      credential_id: "c1",
      provider_id: "antigravity",
      credential_kind: "oauth",
      kind: "oauth",
      secret: new TextEncoder().encode("test-token"),
    },
  } as unknown as ProviderDispatchTarget;
}

function makeRequest(): CanonicalRequest {
  return {
    model: "claude-sonnet-4-6",
    messages: [{ role: "user", content: [{ type: "text", text: "hai" }] }],
    stream: true,
    generation_controls: {},
    source_surface: "test",
  } as unknown as CanonicalRequest;
}

describe("responseParts thought-signature extraction", () => {
  test("extracts thoughtSignature from a thought part", () => {
    const out = responseParts([
      { text: "thinking…", thought: true, thoughtSignature: THOUGHT_SIGNATURE },
    ]);
    expect(out.thought).toBe("thinking…");
    expect(out.thoughtSignature).toBe(THOUGHT_SIGNATURE);
  });

  test("keeps thoughtSignature empty when the part has none", () => {
    const out = responseParts([{ text: "thinking…", thought: true }]);
    expect(out.thought).toBe("thinking…");
    expect(out.thoughtSignature).toBe("");
  });

  test("joins multiple thought parts and keeps the first signature", () => {
    const out = responseParts([
      { text: "a", thought: true, thoughtSignature: THOUGHT_SIGNATURE },
      { text: "b", thought: true, thoughtSignature: "other==" },
    ]);
    expect(out.thought).toBe("ab");
    expect(out.thoughtSignature).toBe(THOUGHT_SIGNATURE);
  });
});

describe("Antigravity reasoning-signature forwarding", () => {
  test("the reasoning event carries the upstream thoughtSignature", async () => {
    const fetcher = (async (url: unknown): Promise<Response> => {
      if (!String(url).toLowerCase().includes("generatecontent")) {
        return new Response(
          JSON.stringify({
            currentTier: { id: "free-tier" },
            cloudaicompanionProject: "projects/p1",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(thoughtSse(), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as unknown as typeof fetch;

    const adapter = new AntigravityAdapter();
    const reasoning: unknown[] = [];
    for await (const event of adapter.dispatch(
      makeRequest(),
      makeTarget(),
      makeContext(fetcher),
    )) {
      const e = event as { type?: string; content?: { kind?: string; signature?: string } };
      if (e.type === "content_delta" && e.content?.kind === "reasoning") {
        reasoning.push(e.content);
      }
    }
    expect(reasoning.length).toBe(1);
    expect((reasoning[0] as { summary?: string }).summary).toBe("I should respond warmly.");
    expect((reasoning[0] as { signature?: string }).signature).toBe(THOUGHT_SIGNATURE);
  });
});

describe("dropAntigravityUnsignedReasoning", () => {
  function requestWithReasoning(signature?: string): CanonicalRequest {
    return {
      model: "claude-sonnet-4-6",
      messages: [
        { role: "user", content: [{ kind: "text", text: "hai" }] },
        {
          role: "assistant",
          content: [
            { kind: "text", text: "Hello!" },
            {
              kind: "reasoning",
              payload: "thinking…",
              summary: "thinking…",
              ...(signature === undefined ? {} : { signature }),
            },
          ],
        },
      ],
      stream: true,
      generation_controls: {},
      source_surface: "test",
    } as unknown as CanonicalRequest;
  }

  test("drops unsigned reasoning on a Claude route", () => {
    const out = dropAntigravityUnsignedReasoning(requestWithReasoning(), true);
    const assistant = out.messages[1]!;
    expect(assistant.content.map((p) => p.kind)).toEqual(["text"]);
  });

  test("keeps signed reasoning on a Claude route", () => {
    const out = dropAntigravityUnsignedReasoning(
      requestWithReasoning(THOUGHT_SIGNATURE),
      true,
    );
    const assistant = out.messages[1]!;
    expect(assistant.content.map((p) => p.kind)).toEqual(["text", "reasoning"]);
  });

  test("keeps unsigned reasoning on a non-Claude route", () => {
    const out = dropAntigravityUnsignedReasoning(requestWithReasoning(), false);
    const assistant = out.messages[1]!;
    expect(assistant.content.map((p) => p.kind)).toEqual(["text", "reasoning"]);
  });

  test("is a no-op when nothing is dropped (same reference)", () => {
    const request = requestWithReasoning(THOUGHT_SIGNATURE);
    expect(dropAntigravityUnsignedReasoning(request, true)).toBe(request);
  });
});
