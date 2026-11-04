import { describe, expect, test } from "bun:test";
import type {
  ProviderDispatchContext,
  ProviderDispatchTarget,
} from "../../src/providers/provider-contracts";
import {
  GITHUB_AUTO_MODEL_TIERS,
  githubAdapter,
} from "../../src/providers/integrations/github/github";
import type { CanonicalEvent, CanonicalRequest } from "../../src/protocol/canonical-model";
import { applyParamQuirks } from "../../src/protocol/translation/quirks";
import { chatAdapter } from "../../src/transport/surface/chat/adapter";

const credential = JSON.stringify({
  access: "copilot-access",
  apiHost: "copilot.example",
  github: "account-auto",
});

const request = {
  model: "gpt-6-luna",
  messages: [{ role: "user", content: [{ kind: "text", text: "Find the bug." }] }],
  generation_controls: { temperature: 0.2 },
  source_surface: "chat",
  stream: false,
} as unknown as CanonicalRequest;

const candidate: ProviderDispatchTarget = {
  provider_id: "github",
  model_id: "gpt-6-luna",
  wire_family: "chat",
  endpoint_path: "/chat/completions",
  capabilities: {},
};

describe("GitHub Copilot Auto routing", () => {
  test("maps catalog variants to supported Auto tiers", () => {
    expect(GITHUB_AUTO_MODEL_TIERS.get("auto")).toBe("balance");
    expect(GITHUB_AUTO_MODEL_TIERS.get("gpt-6-luna")).toBe("efficiency");
    expect(GITHUB_AUTO_MODEL_TIERS.has("gpt-6-luna-low")).toBe(false);
    expect(GITHUB_AUTO_MODEL_TIERS.has("gpt-6-luna-medium")).toBe(false);
    expect(GITHUB_AUTO_MODEL_TIERS.has("gpt-6-luna-high")).toBe(false);
    expect(GITHUB_AUTO_MODEL_TIERS.has("auto-intelligence")).toBe(false);
  });

  test("applies GitHub sampling quirks before wire serialization", () => {
    const requestWithSampling = {
      ...request,
      generation_controls: { temperature: 0.2, top_p: 0.8, max_tokens: 128 },
    } as CanonicalRequest;
    const prepared = applyParamQuirks(requestWithSampling, "github");

    expect(prepared.generation_controls.temperature).toBeUndefined();
    expect(prepared.generation_controls.top_p).toBe(0.8);
    expect(prepared.generation_controls.max_tokens).toBe(128);
    expect(requestWithSampling.generation_controls.temperature).toBe(0.2);
  });

  test("reuses the Auto model and session token across tool turns", async () => {
    const requests: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
    const outboundFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      requests.push({ url, headers: new Headers(init?.headers), body });
      if (url.endsWith("/auto")) {
        return new Response(JSON.stringify({
          selected_model: { id: "routed-model", supported_endpoints: ["/responses", "ws:/responses"] },
          session_token: "auto-session-token",
          expires_at: Math.floor(Date.now() / 1_000) + 3_600,
        }), {
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/models")) {
        return new Response(JSON.stringify({
          data: [{ id: "routed-model", supported_endpoints: ["/responses"] }],
        }), { headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({
        id: "response-1",
        object: "response",
        status: "completed",
        output: [
          {
            id: "reasoning-1",
            type: "reasoning",
            encrypted_content: "opaque-reasoning-artifact",
            summary: [{ type: "summary_text", text: "I will inspect the relevant file." }],
            content: [{ type: "reasoning_text", text: "raw private reasoning" }],
          },
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "fixed", annotations: [] }],
          },
        ],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      }), { headers: { "content-type": "application/json" } });
    }) as unknown as ProviderDispatchContext["outbound_fetch"];

    const context = {
      credential: {
        provider_id: "github",
        credential_kind: "oauth",
        secret: new TextEncoder().encode(credential),
      },
      deadline: Date.now() + 30_000,
      abort_signal: new AbortController().signal,
      outbound_fetch: outboundFetch,
      request_headers: { "x-session-id": "auto-session-1" },
    } as unknown as ProviderDispatchContext;
    const firstRequest = {
      ...request,
      messages: [
        { role: "user", content: [{ kind: "text", text: "An earlier question." }] },
        { role: "assistant", content: [{ kind: "text", text: "An earlier answer." }] },
        request.messages[0],
      ],
    } as unknown as CanonicalRequest;
    const firstTurnEvents: CanonicalEvent[] = [];
    for await (const event of githubAdapter.dispatch(
      firstRequest,
      candidate,
      { ...context, request_id: "auto-request-1" },
    )) firstTurnEvents.push(event);

    const followupRequest = {
      ...firstRequest,
      messages: [
        ...firstRequest.messages,
        {
          role: "assistant",
          content: [
            { kind: "reasoning", payload: "I should inspect the source." },
            {
              kind: "toolCall",
              call_id: "call-read-file",
              name: "read_file",
              arguments: JSON.stringify({ path: "src/index.ts" }),
            },
          ],
        },
        {
          role: "tool",
          content: [{
            kind: "toolResult",
            call_id: "call-read-file",
            content: "The route is declared here.",
          }],
        },
      ],
      tools: [{
        name: "read_file",
        description: "Read a source file",
        jsonSchema: { type: "object", properties: { path: { type: "string" } } },
      }],
    } as unknown as CanonicalRequest;
    const followupEvents: CanonicalEvent[] = [];
    for await (const event of githubAdapter.dispatch(
      followupRequest,
      candidate,
      { ...context, request_id: "auto-request-2" },
    )) followupEvents.push(event);

    expect(requests.map(({ url }) => new URL(url).pathname)).toEqual([
      "/auto",
      "/responses",
      "/responses",
    ]);
    expect(requests[0]?.body).toEqual({
      prompt: "Find the bug.",
      tier: "efficiency",
    });
    expect(requests[0]?.headers.get("x-github-api-version")).toBe("2026-08-01");
    // Default opencode-copilot mode: raw GitHub token + minimal headers.
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer account-auto");
    expect(requests[0]?.headers.get("user-agent")).toBe("opencode/0.1.0");
    expect(requests[0]?.headers.get("VScode-SessionId")).toBeNull();
    expect(requests[0]?.headers.get("x-vscode-user-agent-library-version")).toBeNull();
    expect(requests[1]?.headers.get("authorization")).toBe("Bearer account-auto");
    expect(requests[1]?.headers.get("copilot-session-token")).toBe("auto-session-token");
    expect(requests[1]?.body.model).toBe("routed-model");
    expect(requests[1]?.body.temperature).toBeUndefined();
    expect(requests[1]?.body.reasoning).toBeUndefined();
    expect(requests[0]?.body.multi_turn).toBeUndefined();
    expect(requests[0]?.headers.get("copilot-session-token")).toBeNull();
    expect(requests[1]?.headers.get("copilot-session-token")).toBe("auto-session-token");
    expect(requests[2]?.headers.get("copilot-session-token")).toBe("auto-session-token");
    const followupInput = requests[2]?.body.input as Array<Record<string, unknown>>;
    expect(followupInput.some((item) => item.type === "function_call")).toBe(true);
    expect(followupInput.some((item) => item.type === "function_call_output")).toBe(true);
    expect(followupInput.some((item) => item.type === "reasoning")).toBe(true);
    const clientResponse = JSON.parse(
      new TextDecoder().decode(chatAdapter.encode(firstTurnEvents).bytes),
    ) as {
      choices: Array<{ message: { reasoning_content?: string } }>;
    };
    expect(clientResponse.choices[0]?.message.reasoning_content)
      .toBe("I will inspect the relevant file. raw private reasoning");
    expect(JSON.stringify(clientResponse)).not.toContain("opaque-reasoning-artifact");
    expect(JSON.stringify(clientResponse)).toContain("raw private reasoning");
  });

  test("waits for the routed streaming response after the Auto selection", async () => {
    const streamCredential = JSON.stringify({
      access: "copilot-stream-access",
      apiHost: "copilot.example",
      github: "account-auto-stream",
    });
    const requests: string[] = [];
    const responseEvents = [
      {
        type: "response.created",
        response: { id: "response-stream-1", model: "gpt-6-luna", status: "in_progress" },
      },
      {
        type: "response.reasoning_summary_text.delta",
        item_id: "reasoning-item-1",
        output_index: 0,
        summary_index: 0,
        delta: "When it reaches",
      },
      {
        type: "response.reasoning_summary_text.delta",
        item_id: "reasoning-item-2",
        output_index: 1,
        summary_index: 0,
        delta: "GitHub Copilot's parser",
      },
      { type: "response.output_text.delta", delta: "routed answer" },
      {
        type: "response.completed",
        response: {
          id: "response-stream-1",
          model: "gpt-6-luna",
          status: "completed",
          output: [],
          usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
        },
      },
    ];
    const outboundFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push(new URL(url).pathname);
      if (url.endsWith("/auto")) {
        return new Response(JSON.stringify({
          selected_model: {
            id: "gpt-6-luna",
            supported_endpoints: ["/responses", "ws:/responses"],
          },
          session_token: "auto-stream-session-token",
          expires_at: Math.floor(Date.now() / 1_000) + 3_600,
          selection_reason: "Auto selected GPT-6 Luna.",
        }), { headers: { "content-type": "application/json" } });
      }
      if (url.endsWith("/responses")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        expect(body.model).toBe("gpt-6-luna");
        expect(new Headers(init?.headers).get("copilot-session-token"))
          .toBe("auto-stream-session-token");
        const sse = responseEvents
          .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
          .join("");
        return new Response(sse, { headers: { "content-type": "text/event-stream" } });
      }
      throw new Error(`Unexpected Copilot request: ${url}`);
    }) as unknown as ProviderDispatchContext["outbound_fetch"];
    const context = {
      credential: {
        provider_id: "github",
        credential_kind: "oauth",
        secret: new TextEncoder().encode(streamCredential),
      },
      deadline: Date.now() + 30_000,
      abort_signal: new AbortController().signal,
      outbound_fetch: outboundFetch,
      request_headers: { "x-session-id": "auto-stream-session-1" },
    } as unknown as ProviderDispatchContext;
    const streamingRequest = { ...request, stream: true } as CanonicalRequest;
    const events: CanonicalEvent[] = [];
    for await (const event of githubAdapter.dispatch(
      streamingRequest,
      candidate,
      { ...context, request_id: "auto-stream-request-1" },
    )) events.push(event);

    expect(requests).toEqual(["/auto", "/responses"]);
    expect(events.map((event) => event.type)).toEqual([
      "response_start",
      "content_delta",
      "content_delta",
      "content_delta",
      "terminal",
    ]);
    expect(events[3]).toMatchObject({
      type: "content_delta",
      content: { kind: "text", text: "routed answer" },
    });
    const clientResponse = JSON.parse(
      new TextDecoder().decode(chatAdapter.encode(events).bytes),
    ) as { choices: Array<{ message: { reasoning_content?: string } }> };
    expect(clientResponse.choices[0]?.message.reasoning_content)
      .toBe("When it reaches GitHub Copilot's parser");
    expect(JSON.stringify(events)).not.toContain("Auto selected GPT-6 Luna.");
    expect(events[4]).toMatchObject({ type: "terminal", state: "complete" });
  });
});
