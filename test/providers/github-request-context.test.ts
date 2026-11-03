import { describe, expect, test } from "bun:test";
import type {
  ProviderDispatchContext,
  ProviderDispatchTarget,
} from "../../src/providers/provider-contracts";
import { githubAdapter } from "../../src/providers/integrations/github/github";

import type { CanonicalRequest } from "../../src/protocol/canonical-model";

const candidate = {
  provider_id: "github",
  model_id: "gpt-4.1",
  wire_family: "chat",
  endpoint_path: "/chat/completions",
  capabilities: {},
} as unknown as ProviderDispatchTarget;

const baseRequest = {
  model: "gpt-4.1",
  messages: [{ role: "user", content: [{ kind: "text", text: "hi" }] }],
  generation_controls: {},
  stream: false,
} as unknown as CanonicalRequest;

interface CapturedRequest {
  readonly headers: Headers;
  readonly body: Record<string, unknown>;
}

async function capture(
  request: CanonicalRequest,
  credential = "account-a",
  envelope?: { access?: string; apiHost?: string; github?: string },
): Promise<CapturedRequest> {
  let captured: CapturedRequest | undefined;
  const outboundFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    captured = {
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    };
    return new Response(JSON.stringify({
      choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    }), { headers: { "content-type": "application/json" } });
  }) as unknown as ProviderDispatchContext["outbound_fetch"];
  const stream = githubAdapter.dispatch(request, candidate, {
    credential: {
      provider_id: "github",
      credential_kind: "oauth",
      secret: new TextEncoder().encode(JSON.stringify({
        access: envelope?.access ?? "copilot-access",
        apiHost: envelope?.apiHost ?? "copilot.example",
        github: credential,
      })),
    },
    deadline: Date.now() + 30_000,
    abort_signal: new AbortController().signal,
    outbound_fetch: outboundFetch,
    request_id: "gateway-request-123",
  } as unknown as ProviderDispatchContext);
  try {
    for await (const _event of stream) void _event;
  } catch {
    // The captured outbound request is the assertion; response decoding is irrelevant here.
  }
  expect(captured).toBeDefined();
  return captured!;
}

describe("GitHub Copilot request context", () => {
  test("adds initiator, image, and stable correlation headers only to inference requests", async () => {
    const userRequest = await capture(baseRequest);
    expect(userRequest.headers.get("x-github-api-version")).toBe("2026-08-01");
    expect(userRequest.headers.get("editor-version")).toBe("vscode/1.144.0");
    expect(userRequest.headers.get("editor-plugin-version")).toBe("copilot-chat/0.72.0");
    expect(userRequest.headers.get("editor-device-id")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(userRequest.headers.get("x-initiator")).toBe("user");
    expect(userRequest.headers.get("copilot-vision-request")).toBeNull();
    expect(userRequest.headers.get("x-request-id")).toBe("gateway-request-123");
    expect(userRequest.headers.get("x-agent-task-id")).toBe("gateway-request-123");
    expect(userRequest.headers.get("x-interaction-id")).not.toBe("gateway-request-123");
    expect(userRequest.headers.get("x-vscode-user-agent-library-version")).toBe("node-http");
    expect(userRequest.headers.get("VScode-SessionId")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(userRequest.headers.get("VScode-MachineId")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(userRequest.headers.get("openai-intent")).toBe("conversation-agent");
    expect(userRequest.headers.get("x-interaction-type")).toBe("conversation-agent");
    expect(userRequest.headers.get("Openai-Organization")).toBe("github-copilot");
    // anthropic-beta is scoped to the Messages wire only.
    expect(userRequest.headers.get("anthropic-beta")).toBeNull();

    const agentRequest = await capture({
      ...baseRequest,
      messages: [{ role: "assistant", content: [{ kind: "text", text: "continuing" }] }],
    } as unknown as CanonicalRequest);
    expect(agentRequest.headers.get("x-initiator")).toBe("agent");

    const toolResultRequest = await capture({
      ...baseRequest,
      messages: [{
        role: "user",
        content: [{
          kind: "toolResult",
          call_id: "call-1",
          content: [{ kind: "image", payload: { data: "tool-image" } }],
        }],
      }],
    } as unknown as CanonicalRequest);
    expect(toolResultRequest.headers.get("x-initiator")).toBe("agent");
    expect(toolResultRequest.headers.get("copilot-vision-request")).toBe("true");

    const imageRequest = await capture({
      ...baseRequest,
      messages: [{
        role: "user",
        content: [{ kind: "image", payload: { data: "image-data" } }],
      }],
    } as unknown as CanonicalRequest);
    expect(imageRequest.headers.get("copilot-vision-request")).toBe("true");
    expect(agentRequest.headers.get("editor-device-id")).toBe(
      userRequest.headers.get("editor-device-id"),
    );
  });

  test("does not invent a context tier on the chat body", async () => {
    const captured = await capture(baseRequest);
    expect(captured.body.contextTier).toBeUndefined();
  });

  test("machine id is per-account and stable, not shared across accounts", async () => {
    const firstAccount = await capture(baseRequest, "account-a", {
      access: "copilot-access-1",
      apiHost: "copilot.example",
    });
    const secondAccount = await capture(baseRequest, "account-b", {
      access: "copilot-access-2",
      apiHost: "copilot.example",
    });
    const firstAgain = await capture(baseRequest, "account-a", {
      access: "copilot-access-1",
      apiHost: "copilot.example",
    });
    const machineA = firstAccount.headers.get("VScode-MachineId");
    const machineB = secondAccount.headers.get("VScode-MachineId");
    const machineAAgain = firstAgain.headers.get("VScode-MachineId");
    expect(machineA).not.toBeNull();
    expect(machineA).not.toBe(machineB);
    expect(machineA).toBe(machineAAgain);
    expect(firstAccount.headers.get("editor-device-id")).toBe(machineA);
  });

  test("adds anthropic-beta only on the Messages wire", async () => {
    const messagesCandidate = {
      provider_id: "github",
      model_id: "claude-opus-5.5",
      wire_family: "messages",
      endpoint_path: "/v1/messages",
      capabilities: {},
    } as unknown as ProviderDispatchTarget;
    let capturedMessages: CapturedRequest | undefined;
    const outboundFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      capturedMessages = {
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      };
      return new Response(JSON.stringify({
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "claude-opus-5.5",
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      }), { headers: { "content-type": "application/json" } });
    }) as unknown as ProviderDispatchContext["outbound_fetch"];
    const stream = githubAdapter.dispatch(baseRequest, messagesCandidate, {
      credential: {
        provider_id: "github",
        credential_kind: "oauth",
        secret: new TextEncoder().encode(JSON.stringify({
          access: "copilot-access",
          apiHost: "copilot.example",
          github: "account-a",
        })),
      },
      deadline: Date.now() + 30_000,
      abort_signal: new AbortController().signal,
      outbound_fetch: outboundFetch,
      request_id: "gateway-request-456",
    } as unknown as ProviderDispatchContext);
    try {
      for await (const _event of stream) void _event;
    } catch {
      // Captured request is the assertion.
    }
    expect(capturedMessages).toBeDefined();
    expect(capturedMessages!.headers.get("anthropic-beta")).toBe(
      "interleaved-thinking-2025-05-14",
    );
    expect(capturedMessages!.headers.get("x-interaction-id")).not.toBe("gateway-request-456");
  });

  test("caps a reasoning effort above high at high", async () => {
    for (const effort of ["max", "xhigh"]) {
      const captured = await capture({
        ...baseRequest,
        reasoning: { effort },
      } as unknown as CanonicalRequest);
      expect(captured.body.reasoning_effort).toBe("high");
    }
    const kept = await capture({
      ...baseRequest,
      reasoning: { effort: "medium" },
    } as unknown as CanonicalRequest);
    expect(kept.body.reasoning_effort).toBe("medium");
  });
});
