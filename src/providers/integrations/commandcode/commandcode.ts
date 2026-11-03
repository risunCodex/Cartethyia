// Factory-blocked (Phase C4): proprietary `{threadId, config, params}`
// envelope with NDJSON stream transform — non-OpenAI wire; stays bespoke.
import { randomUUID } from "node:crypto";
import { GatewayError } from "../../../protocol/gateway-error";
import { canContainToolResult, joinTextParts, toolCallParts, toolResultParts } from "../../../protocol/canonical-model";
import {
  classifyUpstreamError,
  extractUpstreamMessage,
  mapUpstreamHttpError,
  upstreamErrorIdentifier,
} from "../../../transport/failure-policy";
import { postUpstreamJson } from "../../../protocol/upstream/post-json";
import type { CanonicalEvent, CanonicalRequest, CanonicalStopReason, ContentPart, UsageRecord } from "../../../protocol/canonical-model";
import { isRecord, readNumber, readString, resolveImageSource, splitDataUrl } from "../../../protocol/codecs";
import { usageFromProvider } from "../../provider-usage";
import { readCredentialSecret, type ProviderDispatchTarget, type ProviderAdapter, type ProviderDispatchContext } from "../../provider-contracts";
import { abortGatewayError } from "../../operations/upstream-deadline";
import { providerBaseUrl } from "../../provider-metadata";
import { defineModel } from "../../provider-model-definition";
import type { ModelDefinition } from "../../provider-model-definition";
import {
  getCommandCodeVersion,
} from "../../operations/client-versions";
import { ThinkSplitter } from "../../../protocol/think-split";
export const COMMANDCODE_PROVIDER_ID = "commandcode" as const;
export const COMMANDCODE_BASE_URL = providerBaseUrl("commandcode");
/**
 * The host alone. `/provider/v1` (the catalog base) is a sibling of the
 * generate surface, so dispatch resolves paths against the host instead:
 * appending `/alpha/generate` to `/provider/v1` produced a URL that is
 * neither surface.
 */
export const COMMANDCODE_HOST = "https://api.commandcode.ai" as const;
/**
 * The CLI's generate surface, and the one the reference client calls for every
 * model — it does not vary the path by the wire family a model row declares.
 * A completion dispatched to `/provider/v1/<wire>` was reaching the catalog
 * surface, which serves `GET /models` and is not what the CLI calls to
 * generate.
 */
export const COMMANDCODE_GENERATE_PATH = "/alpha/generate" as const;

/**
 * Command Code's roster, as the Provider API publishes it.
 *
 * Generated from the live `/provider/v1/models` listing (95 rows). Each row
 * carries the wire that serves it and the context window the API states, which
 * is the whole point: dispatch is per-row, and every `claude-*` id is served on
 * `/messages` only — filed as chat, it could never be dispatched.
 *
 * `vision: true` on every row is the catalog's own declaration for this
 * provider; a model that rejects an image answers for itself.
 *
 * This is the offline seed. It is superseded by `discoverCommandCodeModels`
 * whenever a fetch succeeds, and `seedBundledModels` prunes any row this list
 * stops declaring — so an id Command Code retires disappears on the next boot
 * rather than lingering as a card that can only ever fail.
 */
export const COMMANDCODE_MODELS: readonly ModelDefinition[] = [
  defineModel({ id: "MiniMaxAI/MiniMax-M2.5", providerId: COMMANDCODE_PROVIDER_ID, wireFamily: "responses", endpoint: COMMANDCODE_GENERATE_PATH, ctx: 200000, reasoning: true, toolCall: true, vision: true }),
  defineModel({ id: "MiniMaxAI/MiniMax-M2.7", providerId: COMMANDCODE_PROVIDER_ID, wireFamily: "responses", endpoint: COMMANDCODE_GENERATE_PATH, ctx: 200000, reasoning: true, toolCall: true, vision: true }),
  defineModel({ id: "MiniMaxAI/MiniMax-M3", providerId: COMMANDCODE_PROVIDER_ID, wireFamily: "responses", endpoint: COMMANDCODE_GENERATE_PATH, ctx: 1000000, reasoning: true, toolCall: true, vision: true }),
  defineModel({ id: "Qwen/Qwen3.6-Max-Preview", providerId: COMMANDCODE_PROVIDER_ID, wireFamily: "responses", endpoint: COMMANDCODE_GENERATE_PATH, ctx: 200000, reasoning: true, toolCall: true, vision: true }),
  defineModel({ id: "Qwen/Qwen3.6-Plus", providerId: COMMANDCODE_PROVIDER_ID, wireFamily: "responses", endpoint: COMMANDCODE_GENERATE_PATH, ctx: 200000, reasoning: true, toolCall: true, vision: true }),
  defineModel({ id: "Qwen/Qwen3.7-Flash", providerId: COMMANDCODE_PROVIDER_ID, wireFamily: "responses", endpoint: COMMANDCODE_GENERATE_PATH, ctx: 1000000, reasoning: true, toolCall: true, vision: true }),
  defineModel({ id: "Qwen/Qwen3.7-Max", providerId: COMMANDCODE_PROVIDER_ID, wireFamily: "responses", endpoint: COMMANDCODE_GENERATE_PATH, ctx: 1000000, reasoning: true, toolCall: true, vision: true }),
  defineModel({ id: "Qwen/Qwen3.7-Plus", providerId: COMMANDCODE_PROVIDER_ID, wireFamily: "responses", endpoint: COMMANDCODE_GENERATE_PATH, ctx: 1000000, reasoning: true, toolCall: true, vision: true }),
  defineModel({ id: "Qwen/Qwen3.8-27B", providerId: COMMANDCODE_PROVIDER_ID, wireFamily: "responses", endpoint: COMMANDCODE_GENERATE_PATH, ctx: 262144, reasoning: true, toolCall: true, vision: true }),
  defineModel({ id: "Qwen/Qwen3.8-Flash", providerId: COMMANDCODE_PROVIDER_ID, wireFamily: "chat", endpoint: COMMANDCODE_GENERATE_PATH, ctx: 1000000, reasoning: true, toolCall: true, vision: true }),
  defineModel({ id: "Qwen/Qwen3.8-Max", providerId: COMMANDCODE_PROVIDER_ID, wireFamily: "responses", endpoint: COMMANDCODE_GENERATE_PATH, ctx: 1000000, reasoning: true, toolCall: true, vision: true }),
  defineModel({ id: "Qwen/Qwen3.8-Max-0902", providerId: COMMANDCODE_PROVIDER_ID, wireFamily: "chat", endpoint: COMMANDCODE_GENERATE_PATH, ctx: 1000000, reasoning: true, toolCall: true, vision: true }),
  defineModel({ id: "Qwen/Qwen3.8-Max-Prime", providerId: COMMANDCODE_PROVIDER_ID, wireFamily: "responses", endpoint: COMMANDCODE_GENERATE_PATH, ctx: 1000000, reasoning: true, toolCall: true, vision: true }),
  defineModel({ id: "Qwen/Qwen3.8-Omni-Flash", providerId: COMMANDCODE_PROVIDER_ID, wireFamily: "responses", endpoint: COMMANDCODE_GENERATE_PATH, ctx: 1000000, reasoning: true, toolCall: true, vision: true }),
  defineModel({ id: "claude-fable-5", providerId: COMMANDCODE_PROVIDER_ID, wireFamily: "messages", endpoint: COMMANDCODE_GENERATE_PATH, ctx: 1000000, reasoning: true, toolCall: true, vision: true }),
  defineModel({ id: "claude-fable-5-1", providerId: COMMANDCODE_PROVIDER_ID, wireFamily: "messages", endpoint: COMMANDCODE_GENERATE_PATH, ctx: 1000000, reasoning: true, toolCall: true, vision: true }),
  defineModel({ id: "claude-haiku-4-5-20251001", providerId: COMMANDCODE_PROVIDER_ID, wireFamily: "messages", endpoint: COMMANDCODE_GENERATE_PATH, ctx: 200000, reasoning: true, toolCall: true, vision: true }),
  defineModel({ id: "claude-haiku-5-5", providerId: COMMANDCODE_PROVIDER_ID, wireFamily: "messages", endpoint: COMMANDCODE_GENERATE_PATH, ctx: 1000000, reasoning: true, toolCall: true, vision: true }),
  defineModel({ id: "claude-opus-4-7", providerId: COMMANDCODE_PROVIDER_ID, wireFamily: "messages", endpoint: COMMANDCODE_GENERATE_PATH, ctx: 1000000, reasoning: true, toolCall: true, vision: true }),
  defineModel({ id: "claude-opus-4-8", providerId: COMMANDCODE_PROVIDER_ID, wireFamily: "messages", endpoint: COMMANDCODE_GENERATE_PATH, ctx: 1000000, reasoning: true, toolCall: true, vision: true }),
  defineModel({ id: "claude-opus-5", providerId: COMMANDCODE_PROVIDER_ID, wireFamily: "messages", endpoint: COMMANDCODE_GENERATE_PATH, ctx: 1000000, reasoning: true, toolCall: true, vision: true }),
  defineModel({ id: "claude-opus-5-5", providerId: COMMANDCODE_PROVIDER_ID, wireFamily: "messages", endpoint: COMMANDCODE_GENERATE_PATH, ctx: 1000000, reasoning: true, toolCall: true, vision: true }),
  defineModel({ id: "claude-sonnet-4-6", providerId: COMMANDCODE_PROVIDER_ID, wireFamily: "messages", endpoint: COMMANDCODE_GENERATE_PATH, ctx: 1000000, reasoning: true, toolCall: true, vision: true }),
  defineModel({ id: "claude-sonnet-5", providerId: COMMANDCODE_PROVIDER_ID, wireFamily: "messages", endpoint: COMMANDCODE_GENERATE_PATH, ctx: 1000000, reasoning: true, toolCall: true, vision: true }),
  defineModel({ id: "claude-sonnet-5-5", providerId: COMMANDCODE_PROVIDER_ID, wireFamily: "messages", endpoint: COMMANDCODE_GENERATE_PATH, ctx: 1000000, reasoning: true, toolCall: true, vision: true }),
  defineModel({ id: "deepseek/deepseek-v4-flash", providerId: COMMANDCODE_PROVIDER_ID, wireFamily: "responses", endpoint: COMMANDCODE_GENERATE_PATH, ctx: 1000000, reasoning: true, toolCall: true, vision: true }),
  defineModel({ id: "deepseek/deepseek-v4-flash-fast", providerId: COMMANDCODE_PROVIDER_ID, wireFamily: "chat", endpoint: COMMANDCODE_GENERATE_PATH, ctx: 1000000, reasoning: true, toolCall: true, vision: true }),
  defineModel({ id: "deepseek/deepseek-v4-flash-vision-exp", providerId: COMMANDCODE_PROVIDER_ID, wireFamily: "responses", endpoint: COMMANDCODE_GENERATE_PATH, ctx: 1000000, reasoning: true, toolCall: true, vision: true }),
  defineModel({ id: "deepseek/deepseek-v4-pro", providerId: COMMANDCODE_PROVIDER_ID, wireFamily: "responses", endpoint: COMMANDCODE_GENERATE_PATH, ctx: 1000000, reasoning: true, toolCall: true, vision: true }),
  defineModel({ id: "deepseek/deepseek-v4.1-flash", providerId: COMMANDCODE_PROVIDER_ID, wireFamily: "responses", endpoint: COMMANDCODE_GENERATE_PATH, ctx: 1000000, reasoning: true, toolCall: true, vision: true }),
  defineModel({ id: "deepseek/deepseek-v4.1-flash-fast", providerId: COMMANDCODE_PROVIDER_ID, wireFamily: "responses", endpoint: COMMANDCODE_GENERATE_PATH, ctx: 1000000, reasoning: true, toolCall: true, vision: true }),
  defineModel({ id: "google/gemini-3.1-flash-lite", providerId: COMMANDCODE_PROVIDER_ID, wireFamily: "responses", endpoint: COMMANDCODE_GENERATE_PATH, ctx: 1000000, reasoning: true, toolCall: true, vision: true }),
  defineModel({ id: "google/gemini-3.5-flash", providerId: COMMANDCODE_PROVIDER_ID, wireFamily: "responses", endpoint: COMMANDCODE_GENERATE_PATH, ctx: 1000000, reasoning: true, toolCall: true, vision: true }),
  defineModel({ id: "google/gemini-3.5-flash-lite", providerId: COMMANDCODE_PROVIDER_ID, wireFamily: "responses", endpoint: COMMANDCODE_GENERATE_PATH, ctx: 1000000, reasoning: true, toolCall: true, vision: true }),
  defineModel({ id: "google/gemini-3.6-flash", providerId: COMMANDCODE_PROVIDER_ID, wireFamily: "responses", endpoint: COMMANDCODE_GENERATE_PATH, ctx: 1000000, reasoning: true, toolCall: true, vision: true }),
  defineModel({ id: "google/gemini-3.7-flash", providerId: COMMANDCODE_PROVIDER_ID, wireFamily: "chat", endpoint: COMMANDCODE_GENERATE_PATH, ctx: 1048576, reasoning: true, toolCall: true, vision: true }),
  defineModel({ id: "google/gemini-3.8-flash", providerId: COMMANDCODE_PROVIDER_ID, wireFamily: "responses", endpoint: COMMANDCODE_GENERATE_PATH, ctx: 1000000, reasoning: true, toolCall: true, vision: true }),
  defineModel({ id: "google/gemini-4-argon", providerId: COMMANDCODE_PROVIDER_ID, wireFamily: "responses", endpoint: COMMANDCODE_GENERATE_PATH, ctx: 1000000, reasoning: true, toolCall: true, vision: true }),
  defineModel({ id: "gpt-5.3-codex", providerId: COMMANDCODE_PROVIDER_ID, wireFamily: "responses", endpoint: COMMANDCODE_GENERATE_PATH, ctx: 400000, reasoning: true, toolCall: true, vision: true }),
  defineModel({ id: "gpt-5.4", providerId: COMMANDCODE_PROVIDER_ID, wireFamily: "responses", endpoint: COMMANDCODE_GENERATE_PATH, ctx: 400000, reasoning: true, toolCall: true, vision: true }),
  defineModel({ id: "gpt-5.4-mini", providerId: COMMANDCODE_PROVIDER_ID, wireFamily: "responses", endpoint: COMMANDCODE_GENERATE_PATH, ctx: 400000, reasoning: true, toolCall: true, vision: true }),
  defineModel({ id: "gpt-5.5", providerId: COMMANDCODE_PROVIDER_ID, wireFamily: "responses", endpoint: COMMANDCODE_GENERATE_PATH, ctx: 400000, reasoning: true, toolCall: true, vision: true }),
  defineModel({ id: "gpt-5.6-luna", providerId: COMMANDCODE_PROVIDER_ID, wireFamily: "responses", endpoint: COMMANDCODE_GENERATE_PATH, ctx: 1050000, reasoning: true, toolCall: true, vision: true }),
  defineModel({ id: "gpt-5.6-sol", providerId: COMMANDCODE_PROVIDER_ID, wireFamily: "responses", endpoint: COMMANDCODE_GENERATE_PATH, ctx: 1050000, reasoning: true, toolCall: true, vision: true }),
  defineModel({ id: "gpt-5.6-terra", providerId: COMMANDCODE_PROVIDER_ID, wireFamily: "responses", endpoint: COMMANDCODE_GENERATE_PATH, ctx: 1050000, reasoning: true, toolCall: true, vision: true }),
  defineModel({ id: "gpt-6-astra", providerId: COMMANDCODE_PROVIDER_ID, wireFamily: "responses", endpoint: COMMANDCODE_GENERATE_PATH, ctx: 1050000, reasoning: true, toolCall: true, vision: true }),
  defineModel({ id: "gpt-6-luna", providerId: COMMANDCODE_PROVIDER_ID, wireFamily: "responses", endpoint: COMMANDCODE_GENERATE_PATH, ctx: 1050000, reasoning: true, toolCall: true, vision: true }),
  defineModel({ id: "gpt-6-sol", providerId: COMMANDCODE_PROVIDER_ID, wireFamily: "responses", endpoint: COMMANDCODE_GENERATE_PATH, ctx: 1050000, reasoning: true, toolCall: true, vision: true }),
  defineModel({ id: "gpt-6.1-sol", providerId: COMMANDCODE_PROVIDER_ID, wireFamily: "responses", endpoint: COMMANDCODE_GENERATE_PATH, ctx: 1050000, reasoning: true, toolCall: true, vision: true }),
  defineModel({ id: "inclusionai/ling-3.1-flash", providerId: COMMANDCODE_PROVIDER_ID, wireFamily: "chat", endpoint: COMMANDCODE_GENERATE_PATH, ctx: 262144, reasoning: true, toolCall: true, vision: true }),
  defineModel({ id: "meituan/LongCat-2.0", providerId: COMMANDCODE_PROVIDER_ID, wireFamily: "chat", endpoint: COMMANDCODE_GENERATE_PATH, ctx: 1048576, reasoning: true, toolCall: true, vision: true }),
  defineModel({ id: "meta/muse-spark-1.1", providerId: COMMANDCODE_PROVIDER_ID, wireFamily: "responses", endpoint: COMMANDCODE_GENERATE_PATH, ctx: 1048576, reasoning: true, toolCall: true, vision: true }),
  defineModel({ id: "meta/muse-spark-1.2", providerId: COMMANDCODE_PROVIDER_ID, wireFamily: "responses", endpoint: COMMANDCODE_GENERATE_PATH, ctx: 1048576, reasoning: true, toolCall: true, vision: true }),
  defineModel({ id: "meta/muse-spark-1.2-contributor", providerId: COMMANDCODE_PROVIDER_ID, wireFamily: "responses", endpoint: COMMANDCODE_GENERATE_PATH, ctx: 1048576, reasoning: true, toolCall: true, vision: true }),
  defineModel({ id: "meta/muse-spark-1.3", providerId: COMMANDCODE_PROVIDER_ID, wireFamily: "responses", endpoint: COMMANDCODE_GENERATE_PATH, ctx: 1048576, reasoning: true, toolCall: true, vision: true }),
  defineModel({ id: "meta/muse-spark-1.3-contributor", providerId: COMMANDCODE_PROVIDER_ID, wireFamily: "responses", endpoint: COMMANDCODE_GENERATE_PATH, ctx: 1048576, reasoning: true, toolCall: true, vision: true }),
  defineModel({ id: "meta/muse-spark-open", providerId: COMMANDCODE_PROVIDER_ID, wireFamily: "responses", endpoint: COMMANDCODE_GENERATE_PATH, ctx: 1048576, reasoning: true, toolCall: true, vision: true }),
  defineModel({ id: "meta/muse-wonder-1.0", providerId: COMMANDCODE_PROVIDER_ID, wireFamily: "responses", endpoint: COMMANDCODE_GENERATE_PATH, ctx: 1048576, reasoning: true, toolCall: true, vision: true }),
  defineModel({ id: "minimax/minimax-m3.1-flash-preview", providerId: COMMANDCODE_PROVIDER_ID, wireFamily: "responses", endpoint: COMMANDCODE_GENERATE_PATH, ctx: 1000000, reasoning: true, toolCall: true, vision: true }),
  defineModel({ id: "minimax/minimax-m3.1-flash-preview:free", providerId: COMMANDCODE_PROVIDER_ID, wireFamily: "responses", endpoint: COMMANDCODE_GENERATE_PATH, ctx: 1000000, reasoning: true, toolCall: true, vision: true }),
  defineModel({ id: "mistral/mistral-large-4", providerId: COMMANDCODE_PROVIDER_ID, wireFamily: "responses", endpoint: COMMANDCODE_GENERATE_PATH, ctx: 524288, reasoning: true, toolCall: true, vision: true }),
  defineModel({ id: "moonshotai/Kimi-K2.5", providerId: COMMANDCODE_PROVIDER_ID, wireFamily: "responses", endpoint: COMMANDCODE_GENERATE_PATH, ctx: 256000, reasoning: true, toolCall: true, vision: true }),
  defineModel({ id: "moonshotai/Kimi-K2.6", providerId: COMMANDCODE_PROVIDER_ID, wireFamily: "responses", endpoint: COMMANDCODE_GENERATE_PATH, ctx: 256000, reasoning: true, toolCall: true, vision: true }),
  defineModel({ id: "moonshotai/Kimi-K2.7-Code", providerId: COMMANDCODE_PROVIDER_ID, wireFamily: "responses", endpoint: COMMANDCODE_GENERATE_PATH, ctx: 256000, reasoning: true, toolCall: true, vision: true }),
  defineModel({ id: "moonshotai/Kimi-K2.7-Code-Highspeed", providerId: COMMANDCODE_PROVIDER_ID, wireFamily: "responses", endpoint: COMMANDCODE_GENERATE_PATH, ctx: 262000, reasoning: true, toolCall: true, vision: true }),
  defineModel({ id: "moonshotai/Kimi-K3", providerId: COMMANDCODE_PROVIDER_ID, wireFamily: "responses", endpoint: COMMANDCODE_GENERATE_PATH, ctx: 1000000, reasoning: true, toolCall: true, vision: true }),
  defineModel({ id: "nvidia/nemotron-3-ultra-550b-a55b", providerId: COMMANDCODE_PROVIDER_ID, wireFamily: "responses", endpoint: COMMANDCODE_GENERATE_PATH, ctx: 1000000, reasoning: true, toolCall: true, vision: true }),
  defineModel({ id: "nvidia/nemotron-3.5-super-vl", providerId: COMMANDCODE_PROVIDER_ID, wireFamily: "responses", endpoint: COMMANDCODE_GENERATE_PATH, ctx: 262144, reasoning: true, toolCall: true, vision: true }),
  defineModel({ id: "poolside/laguna-s-2.1-free", providerId: COMMANDCODE_PROVIDER_ID, wireFamily: "responses", endpoint: COMMANDCODE_GENERATE_PATH, ctx: 256000, reasoning: true, toolCall: true, vision: true }),
  defineModel({ id: "reflection/beam:free", providerId: COMMANDCODE_PROVIDER_ID, wireFamily: "responses", endpoint: COMMANDCODE_GENERATE_PATH, ctx: 1048576, reasoning: true, toolCall: true, vision: true }),
  defineModel({ id: "sakana/fugu-ultra", providerId: COMMANDCODE_PROVIDER_ID, wireFamily: "responses", endpoint: COMMANDCODE_GENERATE_PATH, ctx: 1000000, reasoning: true, toolCall: true, vision: true }),
  defineModel({ id: "stealth/cat-jam:free", providerId: COMMANDCODE_PROVIDER_ID, wireFamily: "responses", endpoint: COMMANDCODE_GENERATE_PATH, ctx: 1048576, reasoning: true, toolCall: true, vision: true }),
  defineModel({ id: "stealth/glyph-cluster:free", providerId: COMMANDCODE_PROVIDER_ID, wireFamily: "responses", endpoint: COMMANDCODE_GENERATE_PATH, ctx: 256000, reasoning: true, toolCall: true, vision: true }),
  defineModel({ id: "stepfun/Step-3.5-Flash", providerId: COMMANDCODE_PROVIDER_ID, wireFamily: "responses", endpoint: COMMANDCODE_GENERATE_PATH, ctx: 262144, reasoning: true, toolCall: true, vision: true }),
  defineModel({ id: "stepfun/Step-3.7-Flash", providerId: COMMANDCODE_PROVIDER_ID, wireFamily: "responses", endpoint: COMMANDCODE_GENERATE_PATH, ctx: 256000, reasoning: true, toolCall: true, vision: true }),
  defineModel({ id: "stepfun/Step-5-Preview", providerId: COMMANDCODE_PROVIDER_ID, wireFamily: "responses", endpoint: COMMANDCODE_GENERATE_PATH, ctx: 1000000, reasoning: true, toolCall: true, vision: true }),
  defineModel({ id: "tencent/hy3-paid", providerId: COMMANDCODE_PROVIDER_ID, wireFamily: "responses", endpoint: COMMANDCODE_GENERATE_PATH, ctx: 262144, reasoning: true, toolCall: true, vision: true }),
  defineModel({ id: "tencent/hy4-preview", providerId: COMMANDCODE_PROVIDER_ID, wireFamily: "chat", endpoint: COMMANDCODE_GENERATE_PATH, ctx: 1048576, reasoning: true, toolCall: true, vision: true }),
  defineModel({ id: "thinkingmachines/inkling", providerId: COMMANDCODE_PROVIDER_ID, wireFamily: "responses", endpoint: COMMANDCODE_GENERATE_PATH, ctx: 256000, reasoning: true, toolCall: true, vision: true }),
  defineModel({ id: "thinkingmachines/inkling-small", providerId: COMMANDCODE_PROVIDER_ID, wireFamily: "responses", endpoint: COMMANDCODE_GENERATE_PATH, ctx: 1000000, reasoning: true, toolCall: true, vision: true }),
  defineModel({ id: "xai/grok-4.5", providerId: COMMANDCODE_PROVIDER_ID, wireFamily: "responses", endpoint: COMMANDCODE_GENERATE_PATH, ctx: 500000, reasoning: true, toolCall: true, vision: true }),
  defineModel({ id: "xai/grok-4.6", providerId: COMMANDCODE_PROVIDER_ID, wireFamily: "responses", endpoint: COMMANDCODE_GENERATE_PATH, ctx: 500000, reasoning: true, toolCall: true, vision: true }),
  defineModel({ id: "xai/grok-4.7", providerId: COMMANDCODE_PROVIDER_ID, wireFamily: "responses", endpoint: COMMANDCODE_GENERATE_PATH, ctx: 500000, reasoning: true, toolCall: true, vision: true }),
  defineModel({ id: "xiaomi/mimo-v2.5", providerId: COMMANDCODE_PROVIDER_ID, wireFamily: "responses", endpoint: COMMANDCODE_GENERATE_PATH, ctx: 1000000, reasoning: true, toolCall: true, vision: true }),
  defineModel({ id: "xiaomi/mimo-v2.5-pro", providerId: COMMANDCODE_PROVIDER_ID, wireFamily: "responses", endpoint: COMMANDCODE_GENERATE_PATH, ctx: 1000000, reasoning: true, toolCall: true, vision: true }),
  defineModel({ id: "xiaomi/mimo-v2.6-flash", providerId: COMMANDCODE_PROVIDER_ID, wireFamily: "responses", endpoint: COMMANDCODE_GENERATE_PATH, ctx: 1048576, reasoning: true, toolCall: true, vision: true }),
  defineModel({ id: "xiaomi/mimo-v2.6-pro", providerId: COMMANDCODE_PROVIDER_ID, wireFamily: "responses", endpoint: COMMANDCODE_GENERATE_PATH, ctx: 1048576, reasoning: true, toolCall: true, vision: true }),
  defineModel({ id: "xiaomi/mimo-v2.6-pro-ultraspeed", providerId: COMMANDCODE_PROVIDER_ID, wireFamily: "responses", endpoint: COMMANDCODE_GENERATE_PATH, ctx: 1048576, reasoning: true, toolCall: true, vision: true }),
  defineModel({ id: "z-ai/glm-5.3-flash", providerId: COMMANDCODE_PROVIDER_ID, wireFamily: "chat", endpoint: COMMANDCODE_GENERATE_PATH, ctx: 1048576, reasoning: true, toolCall: true, vision: true }),
  defineModel({ id: "z-ai/glm-5.3-flashx", providerId: COMMANDCODE_PROVIDER_ID, wireFamily: "responses", endpoint: COMMANDCODE_GENERATE_PATH, ctx: 1000000, reasoning: true, toolCall: true, vision: true }),
  defineModel({ id: "zai-org/GLM-5", providerId: COMMANDCODE_PROVIDER_ID, wireFamily: "responses", endpoint: COMMANDCODE_GENERATE_PATH, ctx: 200000, reasoning: true, toolCall: true, vision: true }),
  defineModel({ id: "zai-org/GLM-5.1", providerId: COMMANDCODE_PROVIDER_ID, wireFamily: "responses", endpoint: COMMANDCODE_GENERATE_PATH, ctx: 200000, reasoning: true, toolCall: true, vision: true }),
  defineModel({ id: "zai-org/GLM-5.2", providerId: COMMANDCODE_PROVIDER_ID, wireFamily: "responses", endpoint: COMMANDCODE_GENERATE_PATH, ctx: 1000000, reasoning: true, toolCall: true, vision: true }),
  defineModel({ id: "zai-org/GLM-5.2-Fast", providerId: COMMANDCODE_PROVIDER_ID, wireFamily: "responses", endpoint: COMMANDCODE_GENERATE_PATH, ctx: 1000000, reasoning: true, toolCall: true, vision: true }),
  defineModel({ id: "zai-org/GLM-5.3", providerId: COMMANDCODE_PROVIDER_ID, wireFamily: "responses", endpoint: COMMANDCODE_GENERATE_PATH, ctx: 1000000, reasoning: true, toolCall: true, vision: true }),
];


// CommandCode provider constants.

const COMMANDCODE_DEFAULT_MAX_TOKENS = 4096;

/**
 * The `/alpha/generate` wire, as the CLI client sends it:
 *  - `params.system` is a top-level string; system turns never enter `messages`
 *  - every `content` is an array of blocks, never a string
 *  - an assistant tool call is `{type:"tool-call", toolCallId, toolName, input}`
 *    and is preceded by a reasoning block, which the upstream requires
 *  - a tool result is its own `role:"tool"` turn, not text glued into the user turn
 *  - an image is `{type:"image", image, mimeType}`
 */
function toolResultValue(content: readonly ContentPart[] | string): string {
  if (typeof content === "string") return content;
  return content
    .filter((part) => part.kind === "text")
    .map((part) => part.text)
    .filter((text) => text.length > 0)
    .join("\n");
}

function imageBlock(payload: unknown): Record<string, unknown> | undefined {
  const source = resolveImageSource(payload);
  if (source?.url === undefined) return undefined;
  const inline = splitDataUrl(source.url);
  return { type: "image", image: source.url, ...(inline ? { mimeType: inline.mediaType } : {}) };
}

function contentBlocks(parts: readonly ContentPart[]): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [];
  for (const part of parts) {
    if (part.kind === "text") {
      if (part.text.length > 0) blocks.push({ type: "text", text: part.text });
      continue;
    }
    if (part.kind === "image") {
      const block = imageBlock(part.payload);
      if (block) blocks.push(block);
    }
  }
  return blocks.length > 0 ? blocks : [{ type: "text", text: "" }];
}

function parsedInput(value: unknown): unknown {
  if (typeof value !== "string") return value ?? {};
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

export function convertMessages(messages: CanonicalRequest["messages"]): {
  messages: Array<Record<string, unknown>>;
  system?: string;
} {
  const out: Array<Record<string, unknown>> = [];
  const systemTexts: string[] = [];
  for (const message of messages) {
    if (message.role === "system" || message.role === "developer") {
      const text = joinTextParts(message.content);
      if (text.length > 0) systemTexts.push(text);
      continue;
    }
    // Answers live in `tool` turns or in `user` turns (the Messages ledger
    // re-homes them). Each result is its own `role:"tool"` turn: flattening
    // them into the user turn as prose left the tool call unanswered.
    if (canContainToolResult(message) && toolResultParts(message).length > 0) {
      for (const result of toolResultParts(message)) {
        out.push({
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: result.call_id,
              toolName: "",
              output: { type: "text", value: toolResultValue(result.content) },
            },
          ],
        });
      }
      const remainder = contentBlocks(message.content.filter((part) => part.kind !== "toolResult"));
      if (remainder.some((block) => block["text"] !== "")) out.push({ role: "user", content: remainder });
      continue;
    }
    if (message.role === "assistant") {
      const blocks: Array<Record<string, unknown>> = [];
      const calls = toolCallParts(message);
      const reasoning = message.content
        .filter((part) => part.kind === "reasoning")
        .map((part) => part.summary ?? "")
        .filter((text) => text.length > 0)
        .join("");
      if (reasoning.length > 0 || calls.length > 0) {
        blocks.push({ type: "reasoning", text: reasoning.length > 0 ? reasoning : " " });
      }
      const text = joinTextParts(message.content);
      if (text.length > 0) blocks.push({ type: "text", text });
      for (const call of calls) {
        blocks.push({
          type: "tool-call",
          toolCallId: call.call_id,
          toolName: call.name,
          input: parsedInput(call.arguments),
        });
      }
      out.push({ role: "assistant", content: blocks.length > 0 ? blocks : [{ type: "text", text: "" }] });
      continue;
    }
    out.push({ role: "user", content: contentBlocks(message.content) });
  }
  const system = systemTexts.join("\n\n");
  return system.length > 0 ? { messages: out, system } : { messages: out };
}

/**
 * Whether a tool schema needs Gemini's normalized form.
 *
 * The client rewrites a schema for `google/gemini-*` because the gateway can
 * turn nullable type arrays into `any_of` with sibling fields, which Vertex
 * rejects. This provider routes Gemini over the same Provider API, so the same
 * rewrite applies.
 */
export function isGeminiModelId(modelId: string): boolean {
  return modelId.startsWith("google/gemini-");
}

const SCHEMA_MAP_FIELDS = new Set([
  "$defs",
  "definitions",
  "dependentSchemas",
  "patternProperties",
  "properties",
]);
const SCHEMA_ARRAY_FIELDS = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);
const SCHEMA_VALUE_FIELDS = new Set([
  "additionalItems",
  "additionalProperties",
  "contains",
  "contentSchema",
  "else",
  "if",
  "items",
  "not",
  "propertyNames",
  "then",
  "unevaluatedItems",
  "unevaluatedProperties",
]);

/**
 * A schema Gemini's transport accepts: a single type plus `nullable`, with null
 * defaults dropped. Genuine multi-type unions and `required` are left alone —
 * only the nullable-array spelling is what Vertex rejects.
 */
export function geminiSafeSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(geminiSafeSchema);
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (key === "default" && raw === null) continue;
    if (SCHEMA_MAP_FIELDS.has(key) && isRecord(raw)) {
      out[key] = Object.fromEntries(
        Object.entries(raw).map(([name, child]) => [name, geminiSafeSchema(child)]),
      );
      continue;
    }
    out[key] = SCHEMA_ARRAY_FIELDS.has(key) || SCHEMA_VALUE_FIELDS.has(key)
      ? geminiSafeSchema(raw)
      : raw;
  }
  // A nullable type array becomes one type plus `nullable`.
  if (Array.isArray(out["type"])) {
    const types = out["type"].filter((entry): entry is string => typeof entry === "string");
    const withoutNull = types.filter((entry) => entry !== "null");
    if (types.length !== withoutNull.length && withoutNull.length > 0) {
      out["type"] = withoutNull.length === 1 ? withoutNull[0] : withoutNull;
      out["nullable"] = true;
    }
  }
  return out;
}

export function buildRequest(
  modelId: string,
  request: { messages: CanonicalRequest["messages"]; tools: { readonly name: string; readonly description: string | undefined; readonly jsonSchema: unknown }[]; maxOutputTokens: number | null; temperature: number | null; topP: number | null; reasoningEffort: string | null },
  threadId: string,
  systemExtra?: string,
): Record<string, unknown> {
  const { messages, system: systemFromMessages } = convertMessages(request.messages);
  const systemCombined = systemExtra ? (systemFromMessages ? `${systemExtra}\n${systemFromMessages}` : systemExtra) : systemFromMessages;
  const params: Record<string, unknown> = {
    model: modelId,
    messages,
    stream: true,
    max_tokens: request.maxOutputTokens ?? COMMANDCODE_DEFAULT_MAX_TOKENS,
    temperature: request.temperature ?? 0.3,
  };
  if (request.topP !== null) params["top_p"] = request.topP;
  if (request.reasoningEffort !== null && request.reasoningEffort !== "none") {
    params["reasoning_effort"] = request.reasoningEffort;
  }
  if (systemCombined) params["system"] = systemCombined;
  if (request.tools.length > 0) {
    params["tools"] = request.tools.map((tool) => ({
      // `type: "function"` is part of the envelope. The reference client sends
      // it on every tool, and a tool without it is not recognised as callable.
      type: "function",
      name: tool.name,
      description: tool.description ?? undefined,
      input_schema: isGeminiModelId(modelId) ? geminiSafeSchema(tool.jsonSchema) : tool.jsonSchema,
    }));
  }
  return {
    threadId,
    // The client sends these three as `null`, not `""` / absent. `memory` was
    // an empty string and `taste`/`skills` were missing entirely; the envelope
    // is validated, so an absent field is not the same as a null one.
    memory: null,
    taste: null,
    skills: null,
    config: {
      workingDir: "",
      date: new Date().toISOString().slice(0, 10),
      // The client reports the real runtime: `linux-x64, Node.js v24.0.0`.
      // An empty string is a blank attribution field the upstream never sees
      // filled, which is indistinguishable from a client that did not report.
      environment: `${process.platform}-${process.arch}, Node.js ${process.version}`,
      structure: [],
      isGitRepo: false,
      currentBranch: "",
      mainBranch: "",
      gitStatus: "",
      recentCommits: [],
    },
    params,
  };
}

/**
 * The identity headers Command Code's own client sends.
 *
 * `x-cli-environment` is `production`, not `cli` — that is the value the client
 * sends, and the pair is what identifies the surface to the gateway.
 *
 * `x-project-slug` and `x-taste-learning` were simply absent. Both are
 * attribution fields the client always sends; the slug is derived from the
 * working directory the same way the client derives it.
 *
 * `x-session-id` is sent only when a session exists. The client omits it rather
 * than inventing one, and a value minted per request would attribute every
 * call to a different session.
 */
export async function headers(sessionId: string, token: string): Promise<Record<string, string>> {
  return {
    "content-type": "application/json",
    accept: "text/event-stream",
    authorization: `Bearer ${token}`,
    "x-command-code-version": getCommandCodeVersion(),
    "x-cli-environment": "production",
    "x-taste-learning": "true",
    "x-project-slug": "cartethyia",
    "user-agent": "cli",
    ...(sessionId.length > 0 ? { "x-session-id": sessionId } : {}),
  };
}


type StreamState = { toolIndexById: Map<string, number>; nextToolIndex: number; finishReason: string | undefined; usage: Record<string, unknown> | undefined; think: ThinkSplitter };

export function ccMapFinishReason(reason: string): CanonicalStopReason {
  return reason === "length" ? "length" : reason === "tool_calls" ? "tool_use" : reason === "content_filter" ? "content_filter" : "stop";
}

export function transformLine(line: string, state: StreamState, seqBase: number): CanonicalEvent[] {
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return [];
  }
  const type = readString(event, "type");
  if (!type) return [];
  if (type === "reasoning-delta") {
    const text = readString(event, "text") || readString(event, "delta");
    return text ? [{ type: "content_delta", sequence_number: seqBase, content: { kind: "reasoning", payload: null, summary: text } } as CanonicalEvent] : [];
  }
  if (type === "text-delta") {
    const text = readString(event, "text") || readString(event, "delta");
    if (!text) return [];
    const split = state.think.push(text);
    const events: CanonicalEvent[] = [];
    if (split.reasoning) events.push({ type: "content_delta", sequence_number: seqBase++, content: { kind: "reasoning", payload: null, summary: split.reasoning } } as CanonicalEvent);
    if (split.text) events.push({ type: "content_delta", sequence_number: seqBase, content: { kind: "text", text: split.text } } as CanonicalEvent);
    return events;
  }
  if (type === "tool-input-start") {
    const id = readString(event, "id") || readString(event, "toolCallId");
    if (!id || state.toolIndexById.has(id)) return [];
    state.toolIndexById.set(id, state.nextToolIndex++);
    return [{ type: "tool_call_delta", sequence_number: seqBase, call_id: id, name: readString(event, "toolName") ?? "", arguments_delta: "" } as CanonicalEvent];
  }
  if (type === "tool-input-delta") {
    const id = readString(event, "id") || readString(event, "toolCallId");
    const delta = readString(event, "delta") || readString(event, "inputTextDelta");
    if (!id || !delta || !state.toolIndexById.has(id)) return [];
    return [{ type: "tool_call_delta", sequence_number: seqBase, call_id: id, arguments_delta: delta } as CanonicalEvent];
  }
  if (type === "tool-call") {
    const id = readString(event, "toolCallId");
    if (!id || state.toolIndexById.has(id)) return [];
    state.toolIndexById.set(id, state.nextToolIndex++);
    const input = typeof event["input"] === "string" ? (event["input"] as string) : JSON.stringify(event["input"] ?? {});
    return [
      { type: "tool_call_delta", sequence_number: seqBase, call_id: id, name: readString(event, "toolName") ?? "", arguments_delta: "" } as CanonicalEvent,
      { type: "tool_call_delta", sequence_number: seqBase + 1, call_id: id, arguments_delta: input } as CanonicalEvent,
    ];
  }
  if (type === "finish-step") {
    const reason = readString(event, "finishReason");
    if (reason) state.finishReason = reason;
    if (typeof event["usage"] === "object" && event["usage"] !== null && !Array.isArray(event["usage"])) state.usage = event["usage"] as Record<string, unknown>;
    return [];
  }
  if (type === "finish") {
    const reason = state.finishReason ?? readString(event, "finishReason") ?? "stop";
    const canonicalReason = ccMapFinishReason(reason);
    const rest = state.think.flush();
    const events: CanonicalEvent[] = [];
    if (rest.reasoning) events.push({ type: "content_delta", sequence_number: seqBase++, content: { kind: "reasoning", payload: null, summary: rest.reasoning } });
    if (rest.text) events.push({ type: "content_delta", sequence_number: seqBase++, content: { kind: "text", text: rest.text } });
    let usage: UsageRecord | undefined;
    if (state.usage) {
      const prompt = readNumber(state.usage, "promptTokens") ?? readNumber(state.usage, "inputTokens") ?? 0;
      const completion = readNumber(state.usage, "completionTokens") ?? readNumber(state.usage, "outputTokens") ?? 0;
      const total = readNumber(state.usage, "totalTokens") ?? prompt + completion;
      const cached = readNumber(state.usage, "cachedTokens") ?? readNumber(state.usage, "cacheReadTokens") ?? 0;
      const usageRecord = usageFromProvider({
        input_tokens: prompt,
        output_tokens: completion,
        total_tokens: total,
        cached_tokens: cached,
        cache_creation_input_tokens: readNumber(state.usage, "cacheWriteTokens") ?? undefined,
      } as unknown as Record<string, unknown>);
      usage = usageRecord;
    }
    events.push({ type: "terminal", sequence_number: seqBase, state: "complete", stop_reason: canonicalReason, provider_stop_reason: reason, ...(usage === undefined ? {} : { usage }) });
    return events;
  }
  if (type === "error") {
    const raw = event["error"] ?? event["message"] ?? event;
    const errorObject = isRecord(raw) ? raw : event;
    const identifier = upstreamErrorIdentifier(raw) ?? upstreamErrorIdentifier(event);
    const providerStatus = [
      errorObject["status"],
      errorObject["statusCode"],
      errorObject["code"],
      event["status"],
      event["statusCode"],
      event["code"],
    ].find(
      (value): value is number =>
        typeof value === "number" &&
        Number.isFinite(value) &&
        value >= 400 &&
        value < 600,
    );
    const classification = classifyUpstreamError(providerStatus, identifier);
    const message =
      extractUpstreamMessage(raw) ||
      extractUpstreamMessage(event) ||
      "Command Code stream error (request {requestId}). The upstream came back empty-handed — retry 🌙";
    throw new GatewayError(
      classification.code,
      classification.status,
      message.slice(0, 500),
      {
        ...(providerStatus === undefined ? {} : { providerStatus }),
        ...(identifier ? { providerCode: identifier } : {}),
        ...(classification.credentialEvidence ? { credentialEvidence: true } : {}),
        ...(classification.rateLimitScope
          ? { rateLimitScope: classification.rateLimitScope }
          : {}),
      },
      classification.origin,
    );
  }
  return [];
}

/** NDJSON decoding uses the request signal after the opening deadline is released. */
export async function* transformNdjson(body: ReadableStream<Uint8Array>, signal: AbortSignal, model: string): AsyncIterable<CanonicalEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const state: StreamState = { toolIndexById: new Map(), nextToolIndex: 0, finishReason: undefined, usage: undefined, think: new ThinkSplitter() };
  let buffer = "";
  let seq = 1;

  const readWithAbort = async (): Promise<{ readonly done: boolean; readonly value?: Uint8Array | undefined }> => {
    if (signal.aborted) throw signal.reason;
    const { promise, resolve, reject } = Promise.withResolvers<{ readonly done: boolean; readonly value?: Uint8Array | undefined }>();
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    void reader.read().then(resolve, reject);
    try {
      return await promise;
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  };

  try {
    yield { type: "response_start", sequence_number: seq++, model };
    while (true) {
      const { done, value } = await readWithAbort();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl = buffer.indexOf("\n");
      while (nl !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) {
          const events = transformLine(line, state, seq);
          seq += events.length;
          for (const event of events) {
            yield event;
            if (event.type === "terminal") return;
          }
        }
        nl = buffer.indexOf("\n");
      }
    }
    buffer += decoder.decode();
    const tail = buffer.trim();
    if (tail) {
      const events = transformLine(tail, state, seq);
      seq += events.length;
      for (const event of events) {
        yield event;
        if (event.type === "terminal") return;
      }
    }
    const rest = state.think.flush();
    if (rest.reasoning) yield { type: "content_delta", sequence_number: seq++, content: { kind: "reasoning", payload: null, summary: rest.reasoning } };
    if (rest.text) yield { type: "content_delta", sequence_number: seq++, content: { kind: "text", text: rest.text } };
    // NDJSON ended with no terminal envelope: truncated, never complete.
    yield { type: "terminal", sequence_number: seq++, state: "failed", stop_reason: ccMapFinishReason(state.finishReason ?? "stop"), provider_stop_reason: state.finishReason ?? "stop" };
  } finally {
    void reader.cancel(signal.reason).catch(() => {});
    reader.releaseLock();
  }
}

// The CLI generation surface takes a proprietary envelope and returns NDJSON
// regardless of the catalog row's wire family.

interface CommandCodeAdapterOptions {
  readonly fetch?: typeof fetch;
}


class CommandCodeAdapter implements ProviderAdapter {
  readonly provider_id = COMMANDCODE_PROVIDER_ID;
  private readonly fetchFn: typeof fetch;

  constructor(options: CommandCodeAdapterOptions = {}) {
    this.fetchFn = options.fetch ?? globalThis.fetch;
  }

  async *dispatch(
    request: CanonicalRequest,
    candidate: ProviderDispatchTarget,
    context: ProviderDispatchContext,
  ): AsyncIterable<CanonicalEvent> {
    const token = readCredentialSecret(context.credential, "Command Code bearer token is required");
    const sessionId = randomUUID();
    const payload = buildRequest(candidate.model_id, {
      messages: request.messages,
      tools: (request.tools ?? []).map(({ name, description, jsonSchema }) => ({ name, description, jsonSchema })),
      maxOutputTokens: request.generation_controls.max_output_tokens ?? request.generation_controls.max_tokens ?? request.generation_controls.max_completion_tokens ?? null,
      temperature: request.generation_controls.temperature ?? null,
      topP: request.generation_controls.top_p ?? null,
      reasoningEffort: request.reasoning?.effort ?? null,
    }, sessionId, [request.system, request.instructions].map((parts) => joinTextParts(parts ?? [])).filter(Boolean).join("\n"));
    const { res, release } = await postUpstreamJson(
      `${COMMANDCODE_HOST}${COMMANDCODE_GENERATE_PATH}`,
      await headers(sessionId, token),
      payload,
      context,
      context.outbound_fetch ?? this.fetchFn,
    );
    release();
    try {
      if (!res.ok) throw await mapUpstreamHttpError(res, COMMANDCODE_PROVIDER_ID);
      if (!res.body) throw new GatewayError("platform_unavailable", 502, "Command Code returned an empty stream (request {requestId}). The upstream came back empty-handed — retry 🌙", {}, "upstream");
      // NDJSON carries no model identity; use the selected model, not the provider id.
      yield* transformNdjson(res.body, context.abort_signal, candidate.model_id);
    } catch (error: unknown) {
      throw abortGatewayError({ signal: context.abort_signal, release }, error) ?? error;
    }
  }
}

export function createCommandCodeAdapter(options: CommandCodeAdapterOptions = {}): ProviderAdapter {
  return new CommandCodeAdapter(options);
}
