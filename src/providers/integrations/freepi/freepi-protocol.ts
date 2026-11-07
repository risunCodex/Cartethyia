// Free-pi wire protocol: request body and SSE translation.
//
// The wire is OpenAI-completions (`/v1/chat/completions`) with a JWT bearer.
// Streaming returns OpenAI-style SSE: `data:` JSON chunks (no `event:` name),
// terminated by `[DONE]`. Errors come as HTTP status + JSON
// `{code, message, error: {code, message}}`.
//
// The client (0.6.14) sends `model` (the catalog id), `messages`, `stream`,
// and optionally `max_tokens`; the upstream resolves the catalog id to the
// real model and echoes it in each chunk (`choices[0].delta.model`).

import type { CanonicalRequest, ContentPart } from "../../../protocol/canonical-model";
import { GatewayError } from "../../../protocol/gateway-error";

/** Upstream chat body (OpenAI-completions shape). */
export interface FreepiChatBody {
  readonly model: string;
  readonly messages: readonly FreepiMessage[];
  readonly stream: boolean;
  readonly max_tokens?: number;
  readonly temperature?: number;
  readonly top_p?: number;
  readonly tools?: readonly FreepiToolDeclaration[];
}

export interface FreepiMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string;
  readonly tool_call_id?: string;
  readonly tool_calls?: readonly FreepiToolCall[];
}

export interface FreepiToolDeclaration {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description?: string;
    readonly parameters: unknown;
  };
}

export interface FreepiToolCall {
  readonly id: string;
  readonly type: "function";
  readonly function: { readonly name: string; readonly arguments: string };
}

function textOf(part: ContentPart): string {
  return part.kind === "text" ? part.text : "";
}

function toolArguments(args: unknown): string {
  if (typeof args === "string") return args;
  try {
    return JSON.stringify(args ?? {});
  } catch {
    return "{}";
  }
}

function toolResultText(content: readonly ContentPart[] | string): string {
  if (typeof content === "string") return content;
  return content
    .map((part) => (part.kind === "text" ? part.text : ""))
    .filter((text) => text.length > 0)
    .join("\n");
}

/** Builds the upstream chat body from a canonical request. */
export function buildFreepiChatBody(
  modelId: string,
  request: CanonicalRequest,
  maxOutputTokens?: number,
): FreepiChatBody {
  const messages: FreepiMessage[] = [];
  const systemParts: string[] = [];
  for (const part of request.system ?? []) {
    const text = textOf(part);
    if (text.length > 0) systemParts.push(text);
  }
  for (const part of request.instructions ?? []) {
    const text = textOf(part);
    if (text.length > 0) systemParts.push(text);
  }
  if (systemParts.length > 0) {
    messages.push({ role: "system", content: systemParts.join("\n\n") });
  }

  for (const message of request.messages) {
    if (message.role === "system" || message.role === "developer") {
      const text = message.content.map(textOf).filter((t) => t.length > 0).join("\n\n");
      if (text.length > 0) systemParts.push(text);
      continue;
    }
    const parts: string[] = [];
    const toolCalls: FreepiToolCall[] = [];
    let toolResult: { callId: string; text: string } | undefined;
    for (const part of message.content) {
      if (part.kind === "toolCall") {
        toolCalls.push({
          id: part.call_id,
          type: "function",
          function: { name: part.name, arguments: toolArguments(part.arguments) },
        });
        continue;
      }
      if (part.kind === "toolResult") {
        toolResult = { callId: part.call_id, text: toolResultText(part.content) };
        continue;
      }
      const text = textOf(part);
      if (text.length > 0) parts.push(text);
    }
    if (toolResult !== undefined) {
      messages.push({ role: "tool", content: toolResult.text, tool_call_id: toolResult.callId });
      continue;
    }
    if (parts.length === 0 && toolCalls.length === 0) continue;
    messages.push({
      role: message.role === "assistant" ? "assistant" : "user",
      content: parts.join("\n"),
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    });
  }

  const body: FreepiChatBody = {
    model: modelId,
    messages,
    stream: request.stream,
  };
  const extra: Record<string, unknown> = {};
  if (maxOutputTokens !== undefined && Number.isFinite(maxOutputTokens) && maxOutputTokens > 0) {
    extra["max_tokens"] = Math.min(maxOutputTokens, 8192);
  }
  const controls = request.generation_controls;
  if (typeof controls.temperature === "number" && Number.isFinite(controls.temperature)) {
    extra["temperature"] = controls.temperature;
  }
  if (typeof controls.top_p === "number" && Number.isFinite(controls.top_p)) {
    extra["top_p"] = controls.top_p;
  }
  const tools = request.tools;
  if (tools !== undefined && tools.length > 0) {
    extra["tools"] = tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        ...(tool.description ? { description: tool.description } : {}),
        parameters: tool.jsonSchema,
      },
    }));
  }
  return { ...body, ...extra } as FreepiChatBody;
}

/** One parsed SSE frame. */
export interface FreepiSseFrame {
  readonly event: string;
  readonly data: unknown;
}

/** Parses an SSE byte stream into frames (OpenAI-style, `data:` only). */
export async function* parseFreepiSse(
  body: ReadableStream<Uint8Array>,
): AsyncIterable<FreepiSseFrame> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = "";
  let data: string[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (line === "") {
          if (data.length > 0) {
            const payload = data.join("\n");
            data = [];
            if (payload.trim() === "[DONE]") {
              yield { event: "done", data: { finish_reason: "stop" } };
            } else {
              let parsed: unknown = payload;
              try {
                parsed = JSON.parse(payload);
              } catch {
                parsed = payload;
              }
              yield { event: "message", data: parsed };
            }
          }
        } else if (line.startsWith(":")) {
          continue;
        } else if (line.startsWith("data")) {
          let value = line.slice(4);
          if (value.startsWith(" ")) value = value.slice(1);
          data.push(value);
        }
        newline = buffer.indexOf("\n");
      }
    }
    if (data.length > 0) {
      const payload = data.join("\n");
      if (payload.trim() === "[DONE]") {
        yield { event: "done", data: { finish_reason: "stop" } };
      } else {
        let parsed: unknown = payload;
        try {
          parsed = JSON.parse(payload);
        } catch {
          parsed = payload;
        }
        yield { event: "message", data: parsed };
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** Maps upstream error JSON (code/message/error nested) to a GatewayError. */
export function throwFreepiUpstreamError(code: unknown, message: unknown): never {
  const msg = typeof message === "string" && message.trim() ? message : "free-pi upstream error";
  const codeStr = code === undefined ? undefined : String(code);
  // Entitlement/plan walls the gateway classifies as quota.
  if (codeStr === "guest_unavailable" || codeStr === "model_requires_credits") {
    throw new GatewayError("quota_exceeded", 403, `${msg} (request {requestId}). The free-pi account cannot serve this — check credits or sign in. 💸`, { upstream_code: codeStr }, "upstream");
  }
  // Server-side model unavailability.
  if (codeStr === "model_at_capacity" || codeStr === "model_unavailable") {
    throw new GatewayError("capacity_exhausted", 503, `${msg} (request {requestId}). Upstream has this model hard-down right now. 🔄`, { upstream_code: codeStr }, "upstream");
  }
  if (codeStr === "upstream_error") {
    throw new GatewayError("platform_unavailable", 502, `${msg} (request {requestId}). The upstream model host errored. 🌙`, { upstream_code: codeStr }, "upstream");
  }
  throw new GatewayError("platform_unavailable", 502, `${msg} (request {requestId}). The free-pi upstream refused the request. 🌙`, { upstream_code: codeStr }, "upstream");
}
