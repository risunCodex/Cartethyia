/**
 * Kiro chat translation — `buildKiroWireRequest`.
 *
 * Pins the wire shape the adapter produces for a canonical chat request. The
 * shape is the camelCase `conversationState` ledger observed live (CLI
 * 2.37.0 / IDE 1.4.62): `{conversationState:{conversationId,history,
 * currentMessage,chatTriggerType,agentTaskType}, profileArn}`.
 */
import { describe, expect, test } from "bun:test";
import { buildKiroWireRequest } from "../../src/providers/integrations/kiro/kiro-request";
import type { CanonicalRequest } from "../../src/protocol/canonical-model";

const PROFILE = "arn:aws:codewhisperer:us-east-1:638616132270:profile/AAAACCCCXXXX";

function chatRequest(overrides: Partial<CanonicalRequest> = {}): CanonicalRequest {
  return {
    model: "auto",
    stream: true,
    source_surface: "chat",
    messages: [{ role: "user", content: [{ kind: "text", text: "ping" }] }],
    generation_controls: {},
    ...overrides,
  } as CanonicalRequest;
}

function build(request: CanonicalRequest) {
  const built = buildKiroWireRequest(request, {
    conversationId: "conv-1",
    rootConversationId: "conv-1",
    modelId: "auto",
    profileArn: PROFILE,
  });
  if (!built.ok) throw new Error(`build failed: ${built.error.problems.join(",")}`);
  return built.value.payload;
}

describe("buildKiroWireRequest", () => {
  test("emits the camelCase conversationState ledger with profileArn in the body", () => {
    const payload = build(chatRequest());
    expect(Object.keys(payload).sort()).toEqual(["conversationState", "profileArn"]);
    expect(payload.profileArn).toBe(PROFILE);
    const cs = payload.conversationState as Record<string, unknown>;
    expect(Object.keys(cs).sort()).toEqual([
      "agentContinuationId",
      "agentTaskType",
      "chatTriggerType",
      "conversationId",
      "currentMessage",
      "history",
      "rootConversationId",
    ]);
    expect(cs.conversationId).toBe("conv-1");
    expect(cs.rootConversationId).toBe("conv-1");
    expect(cs.chatTriggerType).toBe("MANUAL");
    expect(cs.agentTaskType).toBe("vibe");
  });

  test("carries the current user turn in currentMessage", () => {
    const cs = build(chatRequest()).conversationState as Record<string, unknown>;
    const current = (cs.currentMessage as { userInputMessage: Record<string, unknown> }).userInputMessage;
    expect(current.content).toContain("ping");
    expect(current.modelId).toBe("auto");
    expect(current.origin).toBe("AI_EDITOR");
    // No tools/context on a plain chat request — matches adapter behavior.
    expect(current.userInputMessageContext).toBeUndefined();
  });

  test("history holds the stable prefix pair when system text is present", () => {
    const payload = build(
      chatRequest({
        system: [{ kind: "text", text: "You are helpful." }],
      }),
    );
    const cs = payload.conversationState as { history: unknown[] };
    expect(cs.history).toHaveLength(2);
    const first = cs.history[0] as { userInputMessage: { content: string } };
    expect(first.userInputMessage.content).toContain("You are helpful.");
  });

  test("tool definitions travel on the current turn with agentTaskType spectask", () => {
    const payload = build(
      chatRequest({
        tools: [
          {
            name: "my_tool",
            description: "Does things",
            jsonSchema: {
              type: "object",
              properties: { x: { type: "string" } },
              required: ["x"],
            },
          },
        ],
      }),
    );
    const cs = payload.conversationState as {
      agentTaskType: string;
      currentMessage: { userInputMessage: { userInputMessageContext?: { tools?: unknown[] } } };
    };
    expect(cs.agentTaskType).toBe("spectask");
    const tools = cs.currentMessage.userInputMessage.userInputMessageContext?.tools ?? [];
    expect(tools).toHaveLength(1);
    const spec = tools[0] as { toolSpecification: { name: string } };
    expect(spec.toolSpecification.name).toBe("my_tool");
  });

  test("rejects an unpaired tool call", () => {
    const built = buildKiroWireRequest(
      chatRequest({
        messages: [
          {
            role: "assistant",
            content: [
              { kind: "toolCall", call_id: "call_1", name: "my_tool", arguments: { x: "1" } },
            ],
          },
        ],
      }),
      { conversationId: "c", modelId: "auto", profileArn: PROFILE },
    );
    expect(built.ok).toBe(false);
    if (!built.ok) expect(built.error.problems.length).toBeGreaterThan(0);
  });

  test("rootConversationId defaults to conversationId when absent", () => {
    const built = buildKiroWireRequest(chatRequest(), {
      conversationId: "conv-9",
      modelId: "auto",
      profileArn: PROFILE,
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const cs = built.value.payload.conversationState as Record<string, unknown>;
    expect(cs.rootConversationId).toBe("conv-9");
  });
});
