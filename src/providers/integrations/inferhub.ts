// Hybrid: the Messages-wire leg (`InferhubMessagesAdapter`, Claude Messages
// envelope + Bearer auth + breakpoint cache stamping) is a non-OpenAI wire and
// stays bespoke; the chat leg is a declarative spec row.
import { assertCredentialKind, assertWireFamily } from "../provider-contracts";
import type { ProviderDispatchTarget, ProviderAdapter, ProviderDispatchContext } from "../provider-contracts";
import type { ModelDefinition } from "../provider-model-definition";
import type { ProviderModelDiscovery } from "../discovery/discovery-types";
import { providerBaseUrl } from "../provider-metadata";
import { defineModel, isResponsesNativeModelId } from "../provider-model-definition";
import { createApiKeyAdapter, type ApiKeyProviderSpec } from "../configured-provider";
import type { FetchLike, ProviderQuotaResult } from "../quota/quota-contracts";
import { probeApiKeyConnectivity } from "../quota/quota-support";
import type { CanonicalEvent, CanonicalRequest, ContentPart } from "../../protocol/canonical-model";
import { GatewayError } from "../../protocol/gateway-error";
import { applyParamQuirks } from "../../protocol/translation/quirks";
import { buildClaudeMessagesRequest, filterClaudeCustomHeaders } from "./shared/claude-messages";
import { resolveInboundSessionId } from "../operations/session-resolution";
import { isRecord } from "../../protocol/codecs";
import { sendClaudeMessagesRequest } from "../../protocol/upstream/send-claude-messages";

const INFERHUB_CACHE_CONTROL = { type: "ephemeral", ttl: "1h" } as const;

/**
 * Inferhub's streaming bridge ignores `cache_control` on `system` and on
 * non-text message blocks (`tool_result`, `tool_use`, thinking). A `text`
 * block in `messages` is required for a stream cache hit. Agent turns
 * often end on `tool_result`, so the shared Claude encoder's "last cacheable
 * block" stamp never lands on text and only the last-tool breakpoint
 * (~100 tokens) survives. Stamp the first and last text blocks so the
 * stable prefix (tools + system + first user) stays addressable as the
 * transcript grows.
 */
export function ensureInferhubMessagesTextBreakpoints(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  const textLocs: Array<{ messageIndex: number; blockIndex: number }> = [];
  for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
    const message = messages[messageIndex];
    if (!isRecord(message) || !Array.isArray(message.content)) continue;
    const content = message.content;
    for (let blockIndex = 0; blockIndex < content.length; blockIndex += 1) {
      const block = content[blockIndex];
      if (isRecord(block) && block.type === "text") {
        textLocs.push({ messageIndex, blockIndex });
      }
    }
  }

  const stampAt = (loc: { messageIndex: number; blockIndex: number }): void => {
    const message = messages[loc.messageIndex];
    if (!isRecord(message) || !Array.isArray(message.content)) return;
    const block = message.content[loc.blockIndex];
    if (!isRecord(block)) return;
    message.content[loc.blockIndex] = {
      ...block,
      cache_control: { ...INFERHUB_CACHE_CONTROL },
    };
  };

  if (textLocs.length > 0) {
    const first = textLocs[0];
    const last = textLocs[textLocs.length - 1];
    if (first !== undefined) stampAt(first);
    if (
      last !== undefined &&
      (first === undefined ||
        last.messageIndex !== first.messageIndex ||
        last.blockIndex !== first.blockIndex)
    ) {
      stampAt(last);
    }
    return payload;
  }

  const marker = {
    type: "text",
    text: " ",
    cache_control: { ...INFERHUB_CACHE_CONTROL },
  };
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!isRecord(message) || message.role !== "user") continue;
    const content = Array.isArray(message.content) ? [...message.content, marker] : [marker];
    messages[index] = { ...message, content };
    payload.messages = messages;
    return payload;
  }
  messages.push({ role: "user", content: [marker] });
  payload.messages = messages;
  return payload;
}

export const INFERHUB_BASE_URL = providerBaseUrl("inferhub");
export const INFERHUB_PROVIDER_ID = "inferhub" as const;

/**
 * Live `/v1/models` discovery for InferHub.
 *
 * The generic OpenAI discovery loader classifies a model as `responses` only
 * when `isResponsesNativeModelId` matches and otherwise says `chat`, so every
 * Claude-backed InferHub id came back `chat` — and the chat wire strips
 * thinking and native tool_use server-side. The wire family is therefore
 * re-derived here from the id, the same way the offline catalog does it, with
 * Claude ids forced onto Messages.
 */
export function inferhubModelDiscovery(): () => Promise<ProviderModelDiscovery> {
  return async () => async (input) => {
    // dynamic-import: the OpenAI `/models` fetcher is the same module every
    // discovery-backed provider loads lazily, and a static import here would
    // pull it into every process that touches InferHub metadata.
    const { fetchOpenAICompatibleModels } = await import("../discovery/openai-model-discovery");
    const models = await fetchOpenAICompatibleModels({
      baseUrl: input.baseUrl,
      providerId: INFERHUB_PROVIDER_ID,
      headers: { authorization: `Bearer ${input.credential}` },
      ...(input.fetcher ? { fetcher: input.fetcher } : {}),
    });
    // A `config_read` key is rejected by the inference host with 403, and any
    // other failure leaves `models` null. Neither means "InferHub has no
    // models" — the committed list is a valid answer, so probing keeps working
    // instead of failing the whole refresh with "no usable models".
    const source: readonly ModelDefinition[] =
      models === null || models.length === 0 ? INFERHUB_MODELS : models;
    return source.map((model) =>
      isInferhubClaudeModel(model.modelId)
        ? {
            ...model,
            wireFamily: "messages" as const,
            endpointPath: "/v1/messages",
          }
        : model,
    );
  };
}

/**
 * Chat + Responses legs of InferHub. Claude-backed models are routed to
 * `InferhubMessagesAdapter` by wire family instead (see
 * `createInferhubAdapter`), so this spec declares chat + responses.
 * Responses serves the GPT-5/6 + o-series rows: verified live against
 * `POST /v1/responses` (native reasoning + tool_use survive; the chat wire
 * answers too but strips reasoning server-side).
 */
/**
 * InferHub pins a conversation to one upstream provider for as long as
 * `X-Session-Id` stays the same, which is what keeps the prompt cache warm
 * across turns (the pin lapses after roughly ten minutes idle). The id is the
 * client's own session when it sends one and a stable affinity key derived from
 * the opening turn otherwise — never a per-request random value, which would
 * re-pin on every turn and defeat the header.
 */
function inferhubSessionHeaders(
  context: ProviderDispatchContext,
  request?: CanonicalRequest,
): Record<string, string> {
  const sessionId = resolveInboundSessionId(context, request);
  return sessionId === undefined ? {} : { "X-Session-Id": sessionId };
}

const INFERHUB_CHAT_SPEC: ApiKeyProviderSpec = {
  provider_id: INFERHUB_PROVIDER_ID,
  endpoint_paths_by_wire_family: { responses: "/responses" },
  buildExtraHeaders: (context, request) => inferhubSessionHeaders(context, request),
};

/**
 * Offline fallback, used only when a live `/v1/models` read fails or returns
 * nothing — a `config_read` key is rejected by the inference host with 403, so
 * a failed discovery is common and is not "InferHub has no models".
 *
 * Every context, output, modality and reasoning scale below is copied from the
 * upstream's own `/api/catalog` row rather than guessed, because a wrong limit
 * is worse than a missing one: an overstated context window is rejected by the
 * provider at request time, and an understated one truncates silently.
 *
 * Only `ag/` and `cc/` are listed. The marketplace republishes its whole roster
 * (270 rows across 21 upstreams) and moves faster than a committed array can,
 * so a wider hand-kept list would be stale the moment it was written.
 */
const INFERHUB_MODELS_RAW: readonly {
  id: string;
  /** Null when the upstream states no window; `defineModel` marks it estimated. */
  contextLimit: number | null;
  outputLimit: number | null;
  /** Upstream `modalities`. A row without `image` must not advertise vision. */
  readonly modalities?: readonly ("text" | "image" | "video")[];
  /** Upstream `reasoningLevels`; absent means the model exposes no scale. */
  readonly reasoningLevels?: readonly string[];
}[] = [
  // ag/ — Antigravity. Every row: 1M context, text+image input, text output.
  { id: "ag/claude-opus-4-6-thinking", contextLimit: 1000000, outputLimit: 128000, modalities: ["text", "image"] },
  { id: "ag/claude-opus-5-5", contextLimit: 1000000, outputLimit: 128000, modalities: ["text", "image"], reasoningLevels: ["low", "medium", "high"] },
  { id: "ag/claude-sonnet-4-6", contextLimit: 1000000, outputLimit: 64000, modalities: ["text", "image"] },
  { id: "ag/claude-sonnet-5-5", contextLimit: 1000000, outputLimit: 128000, modalities: ["text", "image"], reasoningLevels: ["low", "medium", "high"] },
  { id: "ag/gemini-3.8-flash-high", contextLimit: 1000000, outputLimit: 65536, modalities: ["text", "image"], reasoningLevels: ["low", "medium", "high"] },
  { id: "ag/gemini-4-argon", contextLimit: 1000000, outputLimit: 65536, modalities: ["text", "image"], reasoningLevels: ["low", "medium", "high"] },
  // cc/ — Claude Code. Haiku 4-5 and Opus 4-5 are the 200k-context rows.
  { id: "cc/claude-fable-5", contextLimit: 1000000, outputLimit: 128000, modalities: ["text", "image"] },
  { id: "cc/claude-fable-5-1", contextLimit: 1000000, outputLimit: 128000, modalities: ["text", "image"] },
  { id: "cc/claude-haiku-4-5", contextLimit: 200000, outputLimit: 64000, modalities: ["text", "image"], reasoningLevels: ["none", "low", "medium", "high"] },
  { id: "cc/claude-haiku-5-5", contextLimit: 1000000, outputLimit: 128000, modalities: ["text", "image"], reasoningLevels: ["none", "low", "medium", "high"] },
  { id: "cc/claude-opus-4-5", contextLimit: 200000, outputLimit: 64000, modalities: ["text", "image"], reasoningLevels: ["none", "low", "medium", "high"] },
  { id: "cc/claude-opus-4-6", contextLimit: 1000000, outputLimit: 128000, modalities: ["text", "image"], reasoningLevels: ["none", "low", "medium", "high"] },
  { id: "cc/claude-opus-4-7", contextLimit: 1000000, outputLimit: 128000, modalities: ["text", "image"], reasoningLevels: ["none", "low", "medium", "high"] },
  { id: "cc/claude-opus-4-8", contextLimit: 1000000, outputLimit: 128000, modalities: ["text", "image"], reasoningLevels: ["none", "low", "medium", "high"] },
  { id: "cc/claude-opus-5", contextLimit: 1000000, outputLimit: 128000, modalities: ["text", "image"], reasoningLevels: ["none", "low", "medium", "high"] },
  { id: "cc/claude-opus-5-5", contextLimit: 1000000, outputLimit: 128000, modalities: ["text", "image"], reasoningLevels: ["low", "medium", "high"] },
  { id: "cc/claude-sonnet-4-6", contextLimit: 1000000, outputLimit: 128000, modalities: ["text", "image"], reasoningLevels: ["none", "low", "medium", "high"] },
  { id: "cc/claude-sonnet-5", contextLimit: 1000000, outputLimit: 128000, modalities: ["text", "image"], reasoningLevels: ["none", "low", "medium", "high"] },
  { id: "cc/claude-sonnet-5-5", contextLimit: 1000000, outputLimit: 128000, modalities: ["text", "image"], reasoningLevels: ["low", "medium", "high"] },
  // cb/
  { id: "cb/claude-opus-4.6", contextLimit: 1000000, outputLimit: 128000, modalities: ["text","image"] },
  { id: "cb/claude-opus-4.7-1m", contextLimit: 1000000, outputLimit: 128000, modalities: ["text","image"] },
  { id: "cb/deepseek-v4.1-flash", contextLimit: 1000000, outputLimit: 393216, modalities: ["text","image"] },
  { id: "cb/gemini-2.5-flash-image", contextLimit: null, outputLimit: null, modalities: ["text","image"] },
  { id: "cb/gemini-3.1-pro", contextLimit: 1000000, outputLimit: 65536, modalities: ["text","image","video"], reasoningLevels: ["low","high"] },
  { id: "cb/glm-5.3", contextLimit: 1000000, outputLimit: 48000, modalities: ["text"], reasoningLevels: ["low","high","max"] },
  { id: "cb/glm-5.3-flash", contextLimit: 1000000, outputLimit: 48000, modalities: ["text"], reasoningLevels: ["low","high","max"] },
  { id: "cb/gpt-5.3-codex", contextLimit: 272000, outputLimit: 128000, modalities: ["text","image"], reasoningLevels: ["low","medium","high"] },
  { id: "cb/kimi-k3.1-pro", contextLimit: 1000000, outputLimit: 32000, modalities: ["text","image"], reasoningLevels: ["low","high","max"] },
  { id: "cb/minimax-m3.1-flash", contextLimit: 1000000, outputLimit: 128000, modalities: ["text","image"], reasoningLevels: ["low","medium","high","xhigh","max"] },
  // cbcn/
  { id: "cbcn/deepseek-v4-pro", contextLimit: 1000000, outputLimit: 393216, modalities: ["text","image"] },
  { id: "cbcn/deepseek-v4.1-flash", contextLimit: 1000000, outputLimit: 128000, modalities: ["text","image"] },
  { id: "cbcn/glm-5.3", contextLimit: 1000000, outputLimit: 48000, modalities: ["text","image"], reasoningLevels: ["low","high","max"] },
  { id: "cbcn/glm-5.3-flash", contextLimit: 1000000, outputLimit: 48000, modalities: ["text","image"], reasoningLevels: ["low","high","max"] },
  { id: "cbcn/hy4-preview", contextLimit: 1000000, outputLimit: 64000, modalities: ["text","image"] },
  { id: "cbcn/kimi-k2.8-preview", contextLimit: 1000000, outputLimit: 32000, modalities: ["text","image"], reasoningLevels: ["none","low","high","max"] },
  { id: "cbcn/kimi-k3.1-pro", contextLimit: 1000000, outputLimit: 32000, modalities: ["text","image"], reasoningLevels: ["low","high","max"] },
  { id: "cbcn/minimax-m3.1-flash", contextLimit: 1000000, outputLimit: 128000, modalities: ["text","image"], reasoningLevels: ["low","medium","high","xhigh","max"] },
  // cmc/
  { id: "cmc/MiniMaxAI/MiniMax-M3", contextLimit: 1000000, outputLimit: 262144, modalities: ["text"] },
  { id: "cmc/Qwen/Qwen3.7-Max", contextLimit: 1000000, outputLimit: null, modalities: ["text"] },
  { id: "cmc/Qwen/Qwen3.7-Plus", contextLimit: 1000000, outputLimit: null, modalities: ["text"] },
  { id: "cmc/Qwen/Qwen3.8-Flash", contextLimit: 1000000, outputLimit: 131072, modalities: ["text"] },
  { id: "cmc/Qwen/Qwen3.8-Max", contextLimit: 1000000, outputLimit: 131072, modalities: ["text"] },
  { id: "cmc/deepseek/deepseek-v4-flash", contextLimit: 1000000, outputLimit: 393216, modalities: ["text"], reasoningLevels: ["none","low","high","max"] },
  { id: "cmc/deepseek/deepseek-v4-pro", contextLimit: 1000000, outputLimit: 393216, modalities: ["text"], reasoningLevels: ["none","low","high","max"] },
  { id: "cmc/deepseek/deepseek-v4.1-flash", contextLimit: 1000000, outputLimit: 393216, modalities: ["text"], reasoningLevels: ["none","low","high","max"] },
  { id: "cmc/deepseek/deepseek-v4.1-flash-fast", contextLimit: 1000000, outputLimit: 393216, modalities: ["text"], reasoningLevels: ["none","low","high","max"] },
  { id: "cmc/gpt-5.6-luna", contextLimit: 1050000, outputLimit: null, modalities: ["text"] },
  { id: "cmc/gpt-6-luna", contextLimit: 1050000, outputLimit: null, modalities: ["text"] },
  { id: "cmc/meituan/LongCat-2.0", contextLimit: 1048576, outputLimit: null, modalities: ["text"] },
  { id: "cmc/meta/muse-spark-1.2", contextLimit: 1000000, outputLimit: null, modalities: ["text"] },
  { id: "cmc/meta/muse-spark-1.2-contributor", contextLimit: 1000000, outputLimit: null, modalities: ["text"] },
  { id: "cmc/meta/muse-spark-1.3", contextLimit: 1000000, outputLimit: null, modalities: ["text"] },
  { id: "cmc/meta/muse-spark-1.3-contributor", contextLimit: 1000000, outputLimit: null, modalities: ["text"] },
  { id: "cmc/mistral/mistral-large-4", contextLimit: 524288, outputLimit: 262144, modalities: ["text"] },
  { id: "cmc/moonshotai/Kimi-K2.6", contextLimit: 262144, outputLimit: null, modalities: ["text"] },
  { id: "cmc/moonshotai/Kimi-K2.7-Code", contextLimit: 262144, outputLimit: null, modalities: ["text"] },
  { id: "cmc/moonshotai/Kimi-K2.7-Code-Highspeed", contextLimit: 262144, outputLimit: null, modalities: ["text"] },
  { id: "cmc/moonshotai/Kimi-K3", contextLimit: 1000000, outputLimit: null, modalities: ["text"], reasoningLevels: ["low","high","max"] },
  { id: "cmc/moonshotai/Kimi-K3.1-Pro", contextLimit: 1000000, outputLimit: null, modalities: ["text"], reasoningLevels: ["low","high","max"] },
  { id: "cmc/tencent/hy4-preview", contextLimit: 1048576, outputLimit: 64000, modalities: ["text"] },
  { id: "cmc/xai/grok-4.5", contextLimit: 500000, outputLimit: null, modalities: ["text"] },
  { id: "cmc/xai/grok-4.6", contextLimit: 500000, outputLimit: null, modalities: ["text"] },
  { id: "cmc/xai/grok-4.7", contextLimit: 500000, outputLimit: null, modalities: ["text"] },
  { id: "cmc/xiaomi/mimo-v2.6-flash", contextLimit: 1000000, outputLimit: 131072, modalities: ["text"] },
  { id: "cmc/xiaomi/mimo-v2.6-pro", contextLimit: 1000000, outputLimit: 131072, modalities: ["text"] },
  { id: "cmc/z-ai/glm-5.3-flashx", contextLimit: 1000000, outputLimit: 128000, modalities: ["text"], reasoningLevels: ["low","high","max"] },
  { id: "cmc/zai-org/GLM-5.2", contextLimit: 1000000, outputLimit: 128000, modalities: ["text"], reasoningLevels: ["high","max"] },
  { id: "cmc/zai-org/GLM-5.3", contextLimit: 1000000, outputLimit: 128000, modalities: ["text"], reasoningLevels: ["low","high","max"] },
  // grok/
  { id: "grok/grok-4.5", contextLimit: 500000, outputLimit: null, modalities: ["text","image"], reasoningLevels: ["low","medium","high"] },
  { id: "grok/grok-4.6", contextLimit: 500000, outputLimit: null, modalities: ["text"] },
  { id: "grok/grok-4.7", contextLimit: 500000, outputLimit: null, modalities: ["text"] },
  { id: "grok/grok-4.7-build-fast", contextLimit: 500000, outputLimit: null, modalities: ["text"], reasoningLevels: ["low","medium","high","xhigh"] },
  // mm/
  { id: "mm/MiniMax-M3.1-Flash", contextLimit: 1000000, outputLimit: 524288, modalities: ["text","image"], reasoningLevels: ["low","medium","high","xhigh","max"] },
  // mmcn/
  { id: "mmcn/MiniMax-M3.1-Flash", contextLimit: 1000000, outputLimit: 524288, modalities: ["text","image"], reasoningLevels: ["low","medium","high","xhigh","max"] },
  // cx/
  { id: "cx/gpt-5.6-luna", contextLimit: 272000, outputLimit: 128000, modalities: ["text","image"], reasoningLevels: ["none","low","medium","high","xhigh","max"] },
  { id: "cx/gpt-5.6-sol", contextLimit: 272000, outputLimit: 128000, modalities: ["text","image"], reasoningLevels: ["none","low","medium","high","xhigh","max"] },
  { id: "cx/gpt-5.6-terra", contextLimit: 272000, outputLimit: 128000, modalities: ["text","image"], reasoningLevels: ["none","low","medium","high","xhigh","max"] },
  { id: "cx/gpt-6-astra", contextLimit: 272000, outputLimit: 128000, modalities: ["text","image"], reasoningLevels: ["low","medium","high","xhigh","max"] },
  { id: "cx/gpt-6-luna", contextLimit: 272000, outputLimit: 128000, modalities: ["text","image"], reasoningLevels: ["none","low","medium","high","xhigh","max"] },
  { id: "cx/gpt-6-sol", contextLimit: 272000, outputLimit: 128000, modalities: ["text","image"], reasoningLevels: ["none","low","medium","high","xhigh","max"] },
  { id: "cx/gpt-6.1-sol", contextLimit: 500000, outputLimit: 128000, modalities: ["text","image"], reasoningLevels: ["low","medium","high","xhigh","max"] },
  { id: "cx/gpt-image-2-codex", contextLimit: null, outputLimit: null, modalities: ["text"] },
  // ocg/
  { id: "ocg/deepseek-v4.1-flash", contextLimit: 1000000, outputLimit: 393216, modalities: ["text","image"] },
  // ali/
  { id: "ali/deepseek-v4-flash-0731", contextLimit: 1000000, outputLimit: 393216, modalities: ["text"] },
  { id: "ali/deepseek-v4-pro-0813", contextLimit: 1000000, outputLimit: 393216, modalities: ["text"] },
  { id: "ali/deepseek-v4.1-flash", contextLimit: 1000000, outputLimit: 393216, modalities: ["text","image"] },
  { id: "ali/deepseek-v4.1-flash-1017", contextLimit: 1000000, outputLimit: 393216, modalities: ["text","image"] },
  { id: "ali/glm-5.3", contextLimit: 1000000, outputLimit: 128000, modalities: ["text"], reasoningLevels: ["low","high","max"] },
  { id: "ali/kimi-k2.7-code", contextLimit: 262144, outputLimit: null, modalities: ["text","image"] },
  // alicn/
  { id: "alicn/deepseek-v4-flash-0731", contextLimit: 1000000, outputLimit: 393216, modalities: ["text"] },
  { id: "alicn/deepseek-v4-pro-0813", contextLimit: 1000000, outputLimit: 393216, modalities: ["text"] },
  { id: "alicn/deepseek-v4.1-flash", contextLimit: 1000000, outputLimit: 393216, modalities: ["text","image"] },
  { id: "alicn/deepseek-v4.1-flash-1017", contextLimit: 1000000, outputLimit: 393216, modalities: ["text","image"] },
  { id: "alicn/glm-5.3", contextLimit: 1000000, outputLimit: 128000, modalities: ["text"], reasoningLevels: ["low","high","max"] },
  { id: "alicn/kimi-k2.7-code", contextLimit: 262144, outputLimit: null, modalities: ["text","image"] },
] as const;
/**
 * Claude-backed inferhub models (`*claude-*` across `ag/`/`cb/`/`cc/`) speak
 * native Anthropic Messages on `/v1/messages` — including `thinking_delta`
 * blocks when the canonical request carries reasoning intent. The chat wire
 * strips thinking server-side, so these models must never go through chat.
 */
export function isInferhubClaudeModel(modelId: string): boolean {
  return modelId.toLowerCase().includes("claude-");
}

/**
 * Messages-wire leg for Claude-backed inferhub models. Same Claude pipeline
 * as the plain Anthropic adapter, but inferhub authenticates with a Bearer
 * key (verified against `/v1/messages` directly) instead of `x-api-key`.
 */
export class InferhubMessagesAdapter implements ProviderAdapter {
  readonly provider_id = INFERHUB_PROVIDER_ID;
  private readonly fetchFn: typeof fetch;
  private readonly baseUrl: string;

  constructor(fetchImpl?: typeof fetch, baseUrl?: string) {
    this.fetchFn = fetchImpl ?? globalThis.fetch;
    this.baseUrl = (baseUrl ?? INFERHUB_BASE_URL ?? "").replace(/\/+$/, "");
  }

  async *dispatch(
    request: CanonicalRequest,
    candidate: ProviderDispatchTarget,
    context: ProviderDispatchContext,
  ): AsyncIterable<CanonicalEvent> {
    if (candidate.wire_family !== "messages") {
      assertWireFamily(candidate, "messages", "inferhub messages leg");
    }
    if (context.credential.credential_kind !== "api_key") {
      assertCredentialKind(context.credential, "api_key", "inferhub");
    }
    if (context.credential.secret === undefined || context.credential.secret.length === 0) {
      throw new GatewayError("invalid_request", 400, "inferhub: API key is missing a secret value (request {requestId}). Wrong key, right door — check the key 🔑");
    }
    const apiKey = new TextDecoder().decode(context.credential.secret);
    const customHeaders = filterClaudeCustomHeaders({
      ...context.credential.custom_headers,
    });
    const outbound = buildClaudeMessagesRequest({
      request: applyParamQuirks(request, candidate.provider_id),
      authHeader: "bearer",
      credential: { secret: apiKey, customHeaders },
      baseUrl: this.baseUrl,
      endpointPath: candidate.endpoint_path,
      mutatePayload: ensureInferhubMessagesTextBreakpoints,
    });
    // Same conversation pin as the chat leg, applied after the shared Claude
    // header builder rather than through `customHeaders`: that field is
    // credential-derived (it is filtered and round-trips per account), and a
    // per-conversation value does not belong in it.
    Object.assign(outbound.headers, inferhubSessionHeaders(context, request));
    yield* sendClaudeMessagesRequest(
      outbound.url,
      outbound.headers,
      outbound.body,
      context,
      request,
      this.fetchFn,
    );
  }
}

/**
 * The one InferHub dispatch definition: branches by wire family (Claude-backed
 * models → `InferhubMessagesAdapter`, everything else → the OpenAI-compatible
 * chat leg), defaults `cache_hint` to a stable-prefix breakpoint when the client
 * did not opt in, and translates inferhub's text-based `<tool_call>` convention
 * (see `toInferhubTextModeRequest` / `extractInferhubTextToolCalls`).
 */
class InferhubAdapter implements ProviderAdapter {
  readonly provider_id = INFERHUB_PROVIDER_ID;
  private readonly chat: ProviderAdapter;
  private readonly messages: ProviderAdapter;

  constructor(chat: ProviderAdapter, messages: ProviderAdapter) {
    this.chat = chat;
    this.messages = messages;
  }

  async *dispatch(
    request: CanonicalRequest,
    candidate: ProviderDispatchTarget,
    context: ProviderDispatchContext,
  ): AsyncIterable<CanonicalEvent> {
    // ag/* agent models emit text tool calls instead of wire tool calls once
    // history carries tool parts; translate the request first, then let the
    // chosen leg apply the cache default.
    const textMode = toInferhubTextModeRequest(request);
    const translated = textMode ?? request;
    // Agent harnesses reuse long session prefixes turn after turn without
    // sending a cache opt-in; inferhub bills cache reads far below fresh
    // input, so default to a stable-prefix breakpoint when the client did
    // not say otherwise. Explicit hints (including per-block breakpoints)
    // always win. Other providers are untouched by this default.
    const effective =
      translated.cache_hint === undefined ? { ...translated, cache_hint: "stable_prefix" as const } : translated;
    const leg = candidate.wire_family === "messages" ? this.messages : this.chat;
    yield* extractInferhubTextToolCalls(
      request,
      leg.dispatch(effective, candidate, context),
      textMode !== undefined,
    );
  }
}

export function createInferhubAdapter(fetchImpl?: typeof fetch): ProviderAdapter {
  const chat = createApiKeyAdapter(INFERHUB_CHAT_SPEC, fetchImpl);
  const messages = new InferhubMessagesAdapter(fetchImpl);
  return new InferhubAdapter(chat, messages);
}

/** InferHub exposes no quota surface; the account test is key validity. */
export async function fetchInferhubQuota(
  credential: string,
  fetcher: FetchLike,
): Promise<ProviderQuotaResult> {
  return probeApiKeyConnectivity(INFERHUB_PROVIDER_ID, credential, fetcher);
}
export const INFERHUB_MODELS: readonly ModelDefinition[] = INFERHUB_MODELS_RAW.map((e) =>
  defineModel({
    id: e.id,
    ctx: e.contextLimit,
    out: e.outputLimit,
    // Vision follows the upstream's own `modalities` rather than a blanket
    // true: a row that does not accept images must not advertise that it does.
    vision: e.modalities?.includes("image") ?? false,
    // Reasoning is driven by the scale the upstream publishes. A model with no
    // `reasoningLevels` at all exposes no effort control, so claiming it would
    // let the console offer an effort the provider ignores.
    ...(e.reasoningLevels !== undefined && e.reasoningLevels.length > 0
      ? { reasoning: true, reasoningEfforts: e.reasoningLevels }
      : { reasoning: false }),
    // Claude-backed models resolve to messages rows so thinking blocks and
    // native tool_use survive; the chat wire strips both server-side.
    // GPT-5/6 + o-series resolve to responses rows for the same reason.
    ...(isInferhubClaudeModel(e.id)
      ? { wireFamily: "messages" as const }
      : isResponsesNativeModelId(e.id)
        ? { wireFamily: "responses" as const }
        : {}),
  }),
);

/** Unterminated blocks beyond this revert to prose so one stray tag cannot buffer a whole stream. */
const MAX_BLOCK_CHARS = 256 * 1024;

interface ExtractedCall {
  id: string;
  name: string;
  args: string;
}

function parseBlock(block: string): Omit<ExtractedCall, "id"> & { id?: string } | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(block);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const record = parsed as Record<string, unknown>;
  if (typeof record["name"] !== "string" || record["name"].length === 0) return undefined;
  const args = record["arguments"] ?? {};
  return {
    ...(typeof record["id"] === "string" && record["id"].length > 0 ? { id: record["id"] } : {}),
    name: record["name"],
    args: typeof args === "string" ? args : JSON.stringify(args),
  };
}

/**
 * Streaming-safe extractor for inferhub's text-based tool convention.
 *
 * Some inferhub agent models (`ag/*`) emit tool calls as raw text blocks
 * (`<tool_call>{"name": ..., "arguments": {...}}</tool_call>`) instead of
 * structured wire tool calls. Feed text deltas through {@link push} in order;
 * released text never contains a complete or partial block, so downstream
 * encoders see clean prose while each closed block surfaces via `calls`.
 * {@link flush} restores any unterminated remainder as plain text — an
 * unterminated block is model chatter, never an invented call.
 *
 * With `dropResultBlocks`, `<tool_result>` blocks are swallowed instead of
 * released. Use it only in text mode (no structured tools sent): there the
 * model fabricates results itself, so the blocks are roleplay, never data.
 */
type BlockKind = "call" | "result";
const TAGS: Record<BlockKind, { open: string; close: string }> = {
  call: { open: "<tool_call>", close: "</tool_call>" },
  result: { open: "<tool_result>", close: "</tool_result>" },
};
export class ToolCallTextExtractor {
  private state: "text" | "tag" | BlockKind = "text";
  private pending = "";
  private blockBuf = "";
  private callCount = 0;
  constructor(private readonly dropResultBlocks = false) {}

  push(chunk: string): { text: string; calls: ExtractedCall[] } {
    let buf = this.pending + chunk;
    this.pending = "";
    let out = "";
    const calls: ExtractedCall[] = [];
    let cursor = 0;
    const tracked: BlockKind[] = this.dropResultBlocks ? ["call", "result"] : ["call"];
    for (;;) {
      if (this.state === "text") {
        const tagAt = buf.indexOf("<", cursor);
        if (tagAt === -1) {
          out += buf.slice(cursor);
          cursor = buf.length;
          break;
        }
        out += buf.slice(cursor, tagAt);
        cursor = tagAt;
        this.state = "tag";
      }
      if (this.state === "tag") {
        const rest = buf.slice(cursor);
        const full = tracked.find((kind) => rest.startsWith(TAGS[kind].open));
        if (full !== undefined) {
          cursor += TAGS[full].open.length;
          this.state = full;
          this.blockBuf = "";
          continue;
        }
        const partial = tracked.some(
          (kind) => rest.length < TAGS[kind].open.length && TAGS[kind].open.startsWith(rest),
        );
        if (partial) {
          this.pending = rest;
          cursor = buf.length;
          break;
        }
        out += "<";
        cursor += 1;
        this.state = "text";
        continue;
      }
      const kind: BlockKind = this.state === "result" ? "result" : "call";
      const combined = this.blockBuf + buf.slice(cursor);
      const end = combined.indexOf(TAGS[kind].close);
      if (end === -1) {
        if (combined.length > MAX_BLOCK_CHARS) {
          out += `${TAGS[kind].open}${combined}`;
          this.blockBuf = "";
          this.state = "text";
        } else {
          this.blockBuf = combined;
        }
        cursor = buf.length;
        break;
      }
      const inner = combined.slice(0, end);
      cursor += end + TAGS[kind].close.length - this.blockBuf.length;
      this.blockBuf = "";
      this.state = "text";
      if (kind === "result") continue;
      const parsed = parseBlock(inner);
      if (parsed) {
        this.callCount += 1;
        calls.push({ id: parsed.id ?? `call_${this.callCount}`, name: parsed.name, args: parsed.args });
      } else {
        out += `${TAGS.call.open}${inner}${TAGS.call.close}`;
      }
    }
    return { text: out, calls };
  }
  flush(): { text: string; calls: ExtractedCall[] } {
    const held = this.pending;
    this.pending = "";
    let text = held;
    if (this.state === "call" || this.state === "result") text += `${TAGS[this.state].open}${this.blockBuf}`;
    this.state = "text";
    this.blockBuf = "";
    return { text, calls: [] };
  }
}

function isTextDelta(event: CanonicalEvent): event is Extract<CanonicalEvent, { type: "content_delta" }> & {
  content: { kind: "text"; text: string };
} {
  return (
    event.type === "content_delta" &&
    event.content.kind === "text" &&
    typeof (event.content as { text?: unknown }).text === "string"
  );
}

/**
 * Inferhub `ag/*` agent models speak a text tool convention natively, but
 * their OpenAI→Claude bridge drops structured tool results (`tool_use_id:
 * Field required`). From the second turn on (history carries tool parts),
 * continue the loop in the model's own tongue: history tool calls/results
 * become `<tool_call>`/`<tool_result>` text blocks and structured `tools`
 * are withheld. Returns undefined when the request should pass through
 * untouched (other models, or no tool history yet).
 */
const AGENT_MODEL_PATTERN = /(^|\/)ag\//;
function resultBlockText(content: readonly ContentPart[] | string): string {
  if (typeof content === "string") return content;
  return content
    .map((part) => {
      if (part.kind === "text") return part.text;
      return JSON.stringify(part);
    })
    .join("\n");
}
export function toInferhubTextModeRequest(request: CanonicalRequest): CanonicalRequest | undefined {
  if (!AGENT_MODEL_PATTERN.test(request.model)) return undefined;
  if (
    !request.messages.some((message) =>
      message.content.some((part) => part.kind === "toolCall" || part.kind === "toolResult"),
    )
  ) {
    return undefined;
  }
  const messages = request.messages.map((message) => {
    const texts: string[] = [];
    const keeps: ContentPart[] = [];
    let converted = false;
    for (const part of message.content) {
      if (part.kind === "text") texts.push(part.text);
      else if (part.kind === "toolCall") {
        converted = true;
        texts.push(
          `\n<tool_call>\n${JSON.stringify({ id: part.call_id, name: part.name, arguments: part.arguments })}\n</tool_call>`,
        );
      } else if (part.kind === "toolResult") {
        converted = true;
        texts.push(`\n<tool_result>\n${resultBlockText(part.content)}\n</tool_result>`);
      } else keeps.push(part);
    }
    if (!converted) return message;
    const text = texts.join("").trim();
    return {
      ...message,
      role: message.role === "tool" ? ("user" as const) : message.role,
      content: [{ kind: "text", text: text.length > 0 ? `${text}\n` : "" } as ContentPart, ...keeps],
    };
  });
  const { tools: _tools, tool_choice: _choice, ...rest } = request;
  return { ...rest, messages };
}
/**
 * Wrap an inferhub adapter dispatch so raw `<tool_call>` text blocks become
 * canonical `tool_call_delta` events. Skips extraction entirely when the
 * request declares no tools (or forbids them): without declared tools the
 * block is prose, and inventing calls would break the client.
 */
export async function* extractInferhubTextToolCalls(
  request: CanonicalRequest,
  source: AsyncIterable<CanonicalEvent>,
  dropResultBlocks = false,
): AsyncIterable<CanonicalEvent> {
  const enabled =
    (((request.tools?.length ?? 0) > 0 || dropResultBlocks) && request.tool_choice !== "none");
  if (!enabled) {
    yield* source;
    return;
  }
  const extractor = new ToolCallTextExtractor(dropResultBlocks);
  let lastSeq = 0;
  let extractedAny = false;
  for await (const event of source) {
    lastSeq = event.sequence_number;
    if (isTextDelta(event)) {
      const { text, calls } = extractor.push(event.content.text);
      if (text.length > 0) yield { ...event, content: { kind: "text", text } };
      for (const call of calls) {
        extractedAny = true;
        lastSeq += 1;
        yield {
          type: "tool_call_delta",
          sequence_number: lastSeq,
          call_id: call.id,
          name: call.name,
          arguments_delta: call.args,
        };
      }
      continue;
    }
    if (event.type === "terminal") {
      const { text } = extractor.flush();
      if (text.length > 0) {
        lastSeq += 1;
        yield { type: "content_delta", sequence_number: lastSeq, content: { kind: "text", text } };
      }
      if (
        extractedAny &&
        event.state === "complete" &&
        (event.stop_reason === "stop" || event.stop_reason === undefined)
      ) {
        yield { ...event, stop_reason: "tool_use" as const };
        continue;
      }
      yield event;
      continue;
    }
    yield event;
  }
}
