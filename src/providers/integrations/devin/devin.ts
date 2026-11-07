/**
 * Devin (Codeium Cascade) chat adapter.
 *
 * Speaks Connect-RPC over protobuf: unary `GetUserJwt` (auth), unary
 * `GetCliModelConfigs` (discovery, in `devin-catalog.ts`), and server-
 * streaming `GetChatMessage` (chat). The chat path frames the request as a
 * Connect frame and reads a stream of frames with gzip + trailer handling.
 *
 * Ported from oh-my-pi (`providers/devin.ts`, MIT) with Cartethyia's
 * `ProviderAdapter` contract.
 */

import { randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";
import type {
  CanonicalEvent,
  CanonicalRequest,
  CanonicalStopReason,
  UsageRecord,
} from "../../../protocol/canonical-model";
import { joinTextParts, toolCallParts, toolResultParts } from "../../../protocol/canonical-model";
import type {
  ProviderAdapter,
  ProviderDispatchContext,
  ProviderDispatchTarget,
} from "../../provider-contracts";
import { readCredentialSecret } from "../../provider-contracts";
import {
  CONNECT_END_STREAM_FLAG,
  ConnectFrameDecoder,
  encodeFrame,
  newExecutionId,
  parseTrailer,
} from "./protocol/framing";
import { DevinEnums, DevinMessageTypes, fromEnum } from "./protocol/devin-proto";
import { callDevinUnary } from "./devin-http";
import {
  DEVIN_ASSIGN_MODEL_PATH,
  DEVIN_CHAT_MESSAGE_PATH,
  DEVIN_DEFAULT_BASE_URL,
  DEVIN_DEFAULT_STOP_PATTERNS,
  DEVIN_GET_USER_JWT_PATH,
  devinCliMetadata,
} from "./devin-shared";

const PROVIDER_ID = "devin";

/** Cap on tool-call ids (OpenAI-routed models reject >40 chars). */
const DEVIN_TOOL_CALL_ID_MAX_LENGTH = 40;

interface DevinAuthResult {
  userJwt?: string;
  baseUrl: string;
}

async function fetchDevinAuthMetadata(
  apiKey: string,
  fetcher: typeof fetch,
  signal: AbortSignal,
): Promise<DevinAuthResult> {
  const response = await callDevinUnary<{ userJwt?: string; customApiServerUrl?: string }>(
    DEVIN_GET_USER_JWT_PATH,
    DevinMessageTypes.GetUserJwtRequest,
    DevinMessageTypes.GetUserJwtResponse,
    { metadata: devinCliMetadata(apiKey) },
    { baseUrl: DEVIN_DEFAULT_BASE_URL, fetchImpl: fetcher, signal },
  );
  const result: DevinAuthResult = { baseUrl: response.customApiServerUrl?.trim() || DEVIN_DEFAULT_BASE_URL };
  if (response.userJwt) result.userJwt = response.userJwt;
  return result;
}

interface DevinAssignment {
  assignmentJwt?: string;
  modelUid?: string;
}

async function assignDevinModel(
  apiKey: string,
  userJwt: string | undefined,
  modelRouterUid: string,
  cascadeId: string,
  baseUrl: string,
  fetcher: typeof fetch,
  signal: AbortSignal,
): Promise<DevinAssignment> {
  const response = await callDevinUnary<{ assignment?: DevinAssignment }>(
    DEVIN_ASSIGN_MODEL_PATH,
    DevinMessageTypes.AssignModelRequest,
    DevinMessageTypes.AssignModelResponse,
    {
      metadata: devinCliMetadata(apiKey, userJwt),
      modelRouterUid,
      cascadeId,
    },
    { baseUrl, fetchImpl: fetcher, signal },
  );
  return response.assignment ?? {};
}

function normalizeToolCallId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, DEVIN_TOOL_CALL_ID_MAX_LENGTH);
}

function systemPromptFrom(request: CanonicalRequest): string {
  const parts: string[] = [];
  for (const part of request.system ?? []) {
    if (part.kind === "text") parts.push(part.text);
  }
  for (const part of request.instructions ?? []) {
    if (part.kind === "text") parts.push(part.text);
  }
  return parts.join("\n\n");
}

function chatMessagePrompts(request: CanonicalRequest, cascadeId: string): object[] {
  const out: object[] = [];
  let index = 0;
  const seedFor = (role: string, toolCallId?: string): string =>
    toolCallId ? `${cascadeId}\0${index}\0${role}\0${toolCallId}` : `${cascadeId}\0${index}\0${role}`;

  for (const message of request.messages) {
    index += 1;
    if (message.role === "system" || message.role === "developer") {
      const text = joinTextParts(message.content);
      if (text) {
        out.push({
          messageId: seedFor("user"),
          source: DevinEnums.ChatMessageSource.USER,
          prompt: text,
        });
      }
      continue;
    }
    if (message.role === "user") {
      // No inline images on this wire: a paired live control (2026-11-07)
      // showed `swe-1-6-slow` answers the same "cannot see" with and without
      // an ImageData payload, and `swe-2-flash-medium` rejects it with
      // invalid_argument. Forwarding bytes would only cost tokens.
      const text = joinTextParts(message.content);
      const toolResults = toolResultParts(message);
      const prompt: Record<string, unknown> = {
        messageId: seedFor("user"),
        source: DevinEnums.ChatMessageSource.USER,
        prompt: text,
      };
      if (toolResults.length > 0) {
        prompt.toolCallId = toolResults[0]!.call_id;
        prompt.toolResultIsError = toolResults[0]!.is_error === true;
      }
      out.push(prompt);
      continue;
    }
    if (message.role === "assistant") {
      const text = joinTextParts(message.content);
      const calls = toolCallParts(message);
      const reasoning = message.content.filter((p) => p.kind === "reasoning");
      const prompt: Record<string, unknown> = {
        messageId: seedFor("assistant"),
        source: DevinEnums.ChatMessageSource.SYSTEM,
        prompt: text,
      };
      if (calls.length > 0) {
        prompt.toolCalls = calls.map((call, i) => ({
          id: normalizeToolCallId(call.call_id || `call_${i}`),
          name: call.name,
          argumentsJson: typeof call.arguments === "string" ? call.arguments : JSON.stringify(call.arguments ?? {}),
        }));
      }
      if (reasoning.length > 0) {
        const r = reasoning[0]!;
        if (r.kind === "reasoning") {
          if (typeof r.payload === "string") prompt.thinking = r.payload;
          if (r.signature) prompt.signature = r.signature;
        }
      }
      out.push(prompt);
      continue;
    }
    if (message.role === "tool") {
      const results = toolResultParts(message);
      for (const result of results) {
        const text = Array.isArray(result.content) ? joinTextParts(result.content) : String(result.content ?? "");
        out.push({
          messageId: seedFor("tool", result.call_id),
          source: DevinEnums.ChatMessageSource.TOOL,
          prompt: text,
          toolCallId: result.call_id,
          toolResultIsError: result.is_error === true,
        });
      }
      continue;
    }
  }
  return out;
}

function buildDevinChatRequest(
  request: CanonicalRequest,
  apiKey: string,
  userJwt: string | undefined,
  assignment: DevinAssignment,
  cascadeId: string,
  executionId: string,
): object {
  const model = request.model;
  const chatModelUid = assignment.modelUid?.trim() || model;
  const controls = request.generation_controls;
  const maxTokens = controls.max_tokens ?? controls.max_completion_tokens ?? controls.max_output_tokens ?? 64_000;
  const stopPatterns = [
    ...DEVIN_DEFAULT_STOP_PATTERNS,
    ...(typeof controls.stop === "string" ? [controls.stop] : Array.isArray(controls.stop) ? controls.stop : []),
  ];
  const tools = (request.tools ?? []).map((tool) => ({
    name: tool.name,
    description: tool.description ?? "",
    jsonSchemaString: JSON.stringify(tool.jsonSchema ?? {}),
    ...(tool.strict ? { strict: true } : {}),
  }));

  return {
    metadata: devinCliMetadata(apiKey, userJwt),
    prompt: systemPromptFrom(request),
    chatMessagePrompts: chatMessagePrompts(request, cascadeId),
    requestType: DevinEnums.ChatMessageRequestType.CASCADE,
    plannerMode: DevinEnums.ConversationalPlannerMode.DEFAULT,
    systemPromptCacheOptions: { type: DevinEnums.CacheControlType.EPHEMERAL },
    configuration: {
      numCompletions: 1,
      // uint64 fields must be plain numbers: protobufjs encodes a BigInt on
      // the wire differently here and the upstream answers invalid_argument
      // ("try a different model") on the stream trailer.
      maxTokens,
      maxNewlines: 400,
      temperature: controls.temperature ?? 1,
      topK: 40,
      topP: Math.fround(controls.top_p ?? 0.95),
      stopPatterns,
    },
    ...(tools.length > 0 ? { tools } : {}),
    ...(request.tool_choice === "none" ? {} : { toolChoice: { optionName: "auto" } }),
    ...(request.tool_choice === "none" ? { disableParallelToolCalls: true } : {}),
    cascadeId,
    executionId,
    chatModelUid,
    ...(assignment.assignmentJwt ? { modelAssignmentJwt: assignment.assignmentJwt } : {}),
  };
}

interface DecodedChatResponse {
  deltaText?: string;
  deltaThinking?: string;
  deltaSignature?: string;
  stopReason?: number;
  deltaToolCalls?: { id?: string; name?: string; argumentsJson?: string }[];
  usage?: { inputTokens?: string | number; outputTokens?: string | number; cacheReadTokens?: string | number; cacheWriteTokens?: string | number };
  creditCost?: number;
  committedCreditCost?: number;
  committedAcuCost?: number;
  actualModelUid?: string;
  messageId?: string;
  outputId?: string;
  phase?: number;
}

function decodeChatResponse(payload: Uint8Array): DecodedChatResponse {
  const decoded = DevinMessageTypes.GetChatMessageResponse.decode(payload) as unknown as Record<string, unknown>;
  return decoded as DecodedChatResponse;
}

function usageFromChat(decoded: DecodedChatResponse): UsageRecord | undefined {
  const u = decoded.usage;
  if (!u) return undefined;
  const toNum = (v: string | number | undefined): number => (v === undefined ? 0 : typeof v === "number" ? v : Number(v));
  const input = toNum(u.inputTokens);
  const output = toNum(u.outputTokens);
  const cacheRead = toNum(u.cacheReadTokens);
  const cacheWrite = toNum(u.cacheWriteTokens);
  const creditCost = decoded.creditCost ?? 0;
  return {
    input_tokens: input,
    cached_input_tokens: cacheRead,
    cache_write_tokens: cacheWrite,
    uncached_input_tokens: Math.max(0, input - cacheRead),
    output_tokens: output,
    reasoning_tokens: "unavailable",
    estimated_cost: null,
    ...(creditCost > 0 ? { credit_used: creditCost } : {}),
    total_tokens: input + output,
  };
}

function mapStopReason(raw: number | undefined, hasToolCalls: boolean): CanonicalStopReason {
  if (hasToolCalls) return "tool_use";
  if (raw === DevinEnums.StopReason.MAX_TOKENS || raw === DevinEnums.StopReason.MAX_NEWLINES || raw === DevinEnums.StopReason.INCOMPLETE || raw === DevinEnums.StopReason.PARTIAL) {
    return "length";
  }
  if (raw === DevinEnums.StopReason.CONTENT_FILTER) return "content_filter";
  return "stop";
}

export const devinAdapter: ProviderAdapter = {
  provider_id: PROVIDER_ID,

  async *dispatch(
    request: CanonicalRequest,
    candidate: ProviderDispatchTarget,
    context: ProviderDispatchContext,
  ): AsyncIterable<CanonicalEvent> {
    const apiKey = readCredentialSecret(context.credential, "Devin credential is missing");
    const fetcher = (context.outbound_fetch ?? fetch) as typeof fetch;
    const signal = context.abort_signal;
    let seq = 0;
    const nextSeq = (): number => ++seq;

    // 1. Auth: mint user JWT (and possibly a custom API server URL).
    let auth: DevinAuthResult;
    try {
      auth = await fetchDevinAuthMetadata(apiKey, fetcher, signal);
    } catch (error) {
      yield { type: "error", sequence_number: nextSeq(), category: "auth", message: error instanceof Error ? error.message : String(error), retryable: false };
      return;
    }

    // 2. Optional router assignment.
    const cascadeId = request.conversation?.conversation_id ?? randomUUID();
    let assignment: DevinAssignment = {};
    if (candidate.capabilities["modelRouter"]) {
      try {
        assignment = await assignDevinModel(apiKey, auth.userJwt, request.model, cascadeId, auth.baseUrl, fetcher, signal);
      } catch (error) {
        yield { type: "error", sequence_number: nextSeq(), category: "router", message: error instanceof Error ? error.message : String(error), retryable: false };
        return;
      }
    }

    const executionId = newExecutionId();
    const chatRequest = buildDevinChatRequest(request, apiKey, auth.userJwt, assignment, cascadeId, executionId);
    const body = DevinMessageTypes.GetChatMessageRequest.encode(chatRequest as object).finish();
    const frame = encodeFrame(Buffer.from(body), true);

    let response: Response;
    try {
      response = await fetcher(`${auth.baseUrl}${DEVIN_CHAT_MESSAGE_PATH}`, {
        method: "POST",
        headers: {
          "content-type": "application/connect+proto",
          "connect-protocol-version": "1",
          "connect-content-encoding": frame[0] === 1 ? "gzip" : "identity",
          "accept-encoding": "identity",
          "connect-accept-encoding": "gzip",
          "user-agent": "connect-go/1.18.1 (go1.26.3)",
        },
        body: new Uint8Array(frame),
        signal,
      });
    } catch (error) {
      yield { type: "error", sequence_number: nextSeq(), category: "transport", message: error instanceof Error ? error.message : String(error), retryable: true };
      return;
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      yield {
        type: "error",
        sequence_number: nextSeq(),
        category: "upstream",
        message: `Devin HTTP ${response.status}: ${text.slice(0, 1024)}`,
        retryable: response.status >= 500 || response.status === 429,
      };
      return;
    }

    yield { type: "response_start", sequence_number: nextSeq(), model: request.model, response_id: randomUUID() };

    // 3. Stream decoder.
    const decoder = new ConnectFrameDecoder();
    let latestStopReason: number | undefined;
    let hasToolCalls = false;
    let sawContent = false;
    const toolBlocks = new Map<string, { name: string; args: string }>();
    // Some SWE lanes (live-verified: swe-2-flash-medium) emit tool invocation
    // as inline markup in `deltaText` instead of `deltaToolCalls`. Buffer the
    // text so a markup token split across frames still parses.
    let rawText = "";
    const reader = response.body?.getReader();
    if (!reader) {
      yield { type: "error", sequence_number: nextSeq(), category: "upstream", message: "Devin returned no body", retryable: false };
      return;
    }

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      let frames;
      try {
        frames = decoder.push(value);
      } catch (error) {
        yield { type: "error", sequence_number: nextSeq(), category: "upstream", message: error instanceof Error ? error.message : String(error), retryable: false };
        return;
      }
      for (const frame of frames) {
        if ((frame.flags & CONNECT_END_STREAM_FLAG) !== 0) {
          // Connect end-stream trailers may also carry the compressed flag.
          const trailerPayload = frame.compressed ? gunzipSync(frame.payload) : frame.payload;
          const trailer = parseTrailer(trailerPayload);
          if (trailer.error) {
            const code = trailer.error.code ?? "unknown";
            const message = trailer.error.message ?? "unknown error";
            yield {
              type: "error",
              sequence_number: nextSeq(),
              category: "upstream",
              message: `Devin stream error ${code}: ${message}`,
              retryable: code === "unavailable" || code === "resource_exhausted",
            };
            return;
          }
          continue;
        }
        let decoded: DecodedChatResponse;
        try {
          const payload = frame.compressed ? gunzipSync(frame.payload) : frame.payload;
          decoded = decodeChatResponse(payload);
        } catch (error) {
          yield { type: "error", sequence_number: nextSeq(), category: "upstream", message: error instanceof Error ? error.message : String(error), retryable: false };
          return;
        }

        if (decoded.deltaThinking) {
          sawContent = true;
          yield {
            type: "content_delta",
            sequence_number: nextSeq(),
            content: { kind: "reasoning", payload: decoded.deltaThinking },
          };
        }
        if (decoded.deltaText) {
          rawText += decoded.deltaText;
          // Inline tool-invocation markup: <|message_model|>NAME<|content_invoke_tool_json|>{...}<|end_message|>
          const MARKUP = /<\|message_model\|>([^<]*)<\|content_invoke_tool_json\|>([\s\S]*?)<\|end_message\|>/g;
          let cursor = 0;
          let match: RegExpExecArray | null;
          let plain = "";
          while ((match = MARKUP.exec(rawText)) !== null) {
            plain += rawText.slice(cursor, match.index);
            cursor = match.index + match[0]!.length;
            const toolName = match[1]!.trim() || "unknown_tool";
            let args = match[2]!.trim();
            try {
              const parsed = JSON.parse(args) as { name?: string; args?: unknown };
              if (parsed.args !== undefined) args = JSON.stringify(parsed.args);
            } catch { /* keep raw */ }
            const id = normalizeToolCallId(`call_${toolBlocks.size}`);
            toolBlocks.set(id, { name: toolName, args });
            hasToolCalls = true;
            yield {
              type: "tool_call_delta",
              sequence_number: nextSeq(),
              call_id: id,
              name: toolName,
              arguments_delta: args,
            };
          }
          plain += rawText.slice(cursor);
          // Hold back an incomplete markup prefix until the next frame.
          const partialAt = plain.indexOf("<|message_model|>");
          const emit = partialAt < 0 ? plain : plain.slice(0, partialAt);
          rawText = partialAt < 0 ? "" : plain.slice(partialAt);
          if (emit) {
            sawContent = true;
            yield {
              type: "content_delta",
              sequence_number: nextSeq(),
              content: { kind: "text", text: emit },
            };
          }
        }
        if (decoded.deltaToolCalls?.length) {
          hasToolCalls = true;
          for (const tc of decoded.deltaToolCalls) {
            const id = tc.id ?? `call_${toolBlocks.size}`;
            const existing = toolBlocks.get(id);
            if (existing) {
              existing.args += tc.argumentsJson ?? "";
            } else {
              toolBlocks.set(id, { name: tc.name ?? "", args: tc.argumentsJson ?? "" });
            }
            yield {
              type: "tool_call_delta",
              sequence_number: nextSeq(),
              call_id: id,
              ...(tc.name !== undefined ? { name: tc.name } : {}),
              ...(tc.argumentsJson !== undefined ? { arguments_delta: tc.argumentsJson } : {}),
            };
          }
        }
        if (decoded.usage) {
          const usage = usageFromChat(decoded);
          if (usage) yield { type: "usage", sequence_number: nextSeq(), usage };
        }
        if (decoded.stopReason !== undefined) latestStopReason = decoded.stopReason;
      }
    }

    if (decoder.hasPartial) {
      yield { type: "error", sequence_number: nextSeq(), category: "upstream", message: "Devin stream ended mid-frame (truncated)", retryable: true };
      return;
    }

    // Flush a leftover text prefix that never completed a markup token.
    if (rawText && !rawText.startsWith("<|message_model|>")) {
      sawContent = true;
      yield {
        type: "content_delta",
        sequence_number: nextSeq(),
        content: { kind: "text", text: rawText },
      };
      rawText = "";
    }

    if (!sawContent && !hasToolCalls) {
      yield { type: "error", sequence_number: nextSeq(), category: "upstream", message: "Devin stream ended without content", retryable: true };
      return;
    }

    // Tool-call arguments are fully delivered through `tool_call_delta` events
    // above; no `tool_result` is emitted (that event belongs to a client's tool
    // output, not to the model's call). `toolBlocks` only tracks accumulation.
    const stopReason = mapStopReason(latestStopReason, hasToolCalls);
    yield {
      type: "terminal",
      sequence_number: nextSeq(),
      state: "complete",
      stop_reason: stopReason,
      provider_stop_reason: fromEnum(DevinEnums.StopReason, latestStopReason),
    };
  },
};
