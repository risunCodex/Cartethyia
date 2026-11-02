/**
 * Grok Build adapter.
 *
 * This is the subscription CLI product at cli-chat-proxy.grok.com, not the
 * paid xAI API at api.x.ai. The adapter accepts only xAI device-OAuth
 * credentials, force-streams the Responses request, and keeps the CLI-specific
 * session, reasoning, tool, and stored-item compatibility boundary in one
 * place. Transport timeout/abort and SSE decoding are delegated to the shared
 * OpenAI-compatible adapter.
 */
import { randomBytes, randomUUID } from "node:crypto";
import type { CanonicalEvent, CanonicalRequest } from "../../../protocol/canonical-model";
import {
  OpenAICompatibleAdapter,
  withBearerAuthentication,
} from "../../adapters/compatible-adapter";
import { assertCredentialKind } from "../../provider-contracts";
import type { ProviderAdapter, ProviderDispatchTarget, ProviderDispatchContext } from "../../provider-contracts";
import { providerBaseUrl } from "../../provider-metadata";
import { boundedUpstreamArray, boundedUpstreamNumber, sanitizeUpstreamLabel } from "../../provider-sanitize";
import { isRecord } from "../../../protocol/codecs";
import { modelsDevCatalog } from "../../discovery/models-dev-catalog";
import type { ReasoningEffortLevel } from "../../../protocol/translation/thinking";
import type { FetchLike } from "../../quota/quota-contracts";
import { resolveInboundSessionId, resolvePromptCacheKey } from "../../operations/session-resolution";
import {
  buildGrokUserAgent,
  getGrokVersion,
} from "../../operations/client-versions";
import { resolveGrokTurnIndex } from "./grok-turn-index";
import { getGrokInstallId } from "./grok-install-id";

export const GROK_PROVIDER_ID = "grok" as const;
export const GROK_BASE_URL = providerBaseUrl("grok");
export const GROK_CLIENT_IDENTIFIER = "grok-shell" as const;
export const GROK_TOKEN_AUTH = "xai-grok-cli" as const;

/**
 * Tool types the Grok Build proxy accepts verbatim (hosted tools). Verified
 * live 2026-11-02: a `web_search_preview` (OpenAI Responses spelling) was
 * rejected with `tools[0].type: unknown variant, expected one of function,
 * web_search, x_search, image_generation, collections_search, file_search,
 * code_execution, code_interpreter, mcp, shell, tool_search`. Anything not in
 * this set is normalized to a flat `function` tool instead.
 */
const GROK_HOSTED_TOOLS = new Set([
  "web_search",
  "x_search",
  "image_generation",
  "collections_search",
  "file_search",
  "code_execution",
  "code_interpreter",
  "mcp",
  "shell",
  "tool_search",
]);
const GROK_ALLOWED_FIELDS = new Set([
  "model",
  "input",
  "instructions",
  "tools",
  "tool_choice",
  "stream",
  "store",
  "reasoning",
  "include",
  "temperature",
  "top_p",
  "max_output_tokens",
  "parallel_tool_calls",
  "text",
  "metadata",
  "prompt_cache_key",
  // Session/response linkage fields — verified in the 1.0.70 binary's
  // `struct Response with 31 elements` / `struct Conversation with 1 element`
  // (OpenAI Responses shape). Without them a fresh request cannot reference
  // earlier turns, and the proxy treats each call as a brand-new session.
  "previous_response_id",
  "conversation",
  // Extra Responses fields the binary accepts; harmless and useful for parity.
  "background",
  "truncation",
  "max_tool_calls",
  "stream_options",
  "prompt_cache_retention",
  "top_logprobs",
  "moderation",
  "safety_identifier",
  "prompt",
  "context_management",
  "user",
]);
const GROK_SERVER_ID = /^(rs|fc|resp|msg)_/i;
const GROK_NATIVE_ID = /^(rs|msg|fc)_[0-9a-f-]{20,}$/i;
const GROK_EFFORTS = new Set<ReasoningEffortLevel>(["minimal", "low", "medium", "high", "xhigh", "max"]);
const GROK_MODELS_URL = `${GROK_BASE_URL}/v1/models`;

interface GrokModelDiscoveryOptions {
  readonly credential: string;
  readonly signal?: AbortSignal;
  readonly fetcher?: FetchLike;
}

import type { ModelDefinition } from "../../provider-model-definition";

const grokModel = (
  modelId: string,
  contextLimit: number,
  outputLimit: number,
  reasoning: boolean,
  reasoningEfforts?: readonly ReasoningEffortLevel[],
): ModelDefinition => ({
  modelId,
  wireFamily: "responses",
  endpointPath: "/v1/responses",
  contextLimit,
  outputLimit,
  modalities: { input: ["text", "image"], output: ["text"] },
  reasoning,
  ...(reasoningEfforts === undefined ? {} : { reasoningEfforts }),
  toolCall: true,
  cost: modelsDevCatalog.costFor(GROK_PROVIDER_ID, modelId),
});

/** Static fallback catalog used before (or when) the per-account live catalog is available. */
export const GROK_MODELS: readonly ModelDefinition[] = [
  // Upstream /v1/models advertises a 500k context and 1M max-completion
  // budget separately; keep the output ceiling independent from context.
  grokModel("grok-4.7", 500_000, 1_000_000, true, ["low", "medium", "high", "xhigh"]),
  grokModel("grok-4.5", 500_000, 64_000, true, ["low", "medium", "high", "xhigh"]),
  grokModel("grok-4.6", 500_000, 64_000, true, ["low", "medium", "high", "xhigh"]),
];

interface GrokModelCatalogEntry extends Record<string, unknown> {
  readonly id?: unknown;
  readonly model?: unknown;
  readonly modelId?: unknown;
  readonly name?: unknown;
  readonly hidden?: unknown;
  readonly _meta?: unknown;
  readonly context_window?: unknown;
  readonly contextWindow?: unknown;
  readonly max_completion_tokens?: unknown;
  readonly maxCompletionTokens?: unknown;
  readonly reasoning_effort?: unknown;
  readonly reasoningEffort?: unknown;
  readonly supports_reasoning_effort?: unknown;
  readonly supportsReasoningEffort?: unknown;
  readonly reasoning_efforts?: unknown;
  readonly reasoningEfforts?: unknown;
  readonly supports_backend_search?: unknown;
  readonly supportsBackendSearch?: unknown;
}

function modelEntries(payload: unknown): readonly Record<string, unknown>[] | null {
  if (Array.isArray(payload)) return payload.filter(isRecord);
  if (!isRecord(payload)) return null;
  for (const key of ["data", "models", "results"] as const) {
    const entries = boundedUpstreamArray(payload[key]);
    if (entries !== undefined) return entries.filter(isRecord);
  }
  return null;
}

function parseGrokReasoningMenu(value: unknown): {
  readonly efforts: readonly ReasoningEffortLevel[];
  readonly defaultEffort?: ReasoningEffortLevel;
} {
  if (!Array.isArray(value)) return { efforts: [] };
  const efforts: ReasoningEffortLevel[] = [];
  let defaultEffort: ReasoningEffortLevel | undefined;
  for (const entry of value) {
    const option = typeof entry === "string" ? { value: entry } : isRecord(entry) ? entry : undefined;
    const effort = typeof option?.value === "string" ? option.value.trim() : "";
    if (!GROK_EFFORTS.has(effort as ReasoningEffortLevel) || efforts.includes(effort as ReasoningEffortLevel)) continue;
    efforts.push(effort as ReasoningEffortLevel);
    if (option?.default === true && defaultEffort === undefined) defaultEffort = effort as ReasoningEffortLevel;
  }
  return { efforts, ...(defaultEffort === undefined ? {} : { defaultEffort }) };
}

/**
 * Discovers the Grok Build Responses catalog with Grok-specific completion,
 * reasoning and backend-search metadata preserved.
 */
export async function fetchGrokModels(
  options: GrokModelDiscoveryOptions,
): Promise<readonly ModelDefinition[] | null> {
  const fetcher = options.fetcher ?? globalThis.fetch;
  try {
    const response = await fetcher(GROK_MODELS_URL, {
      headers: {
        authorization: `Bearer ${options.credential}`,
        "x-xai-token-auth": GROK_TOKEN_AUTH,
        "x-grok-client-identifier": GROK_CLIENT_IDENTIFIER,
        "x-grok-client-mode": "Desktop",
        "x-grok-client-version": getGrokVersion(),
        "user-agent": buildGrokUserAgent(),
        accept: "application/json",
      },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (!response.ok) return null;
    const entries = modelEntries(await response.json());
    if (entries === null) return null;
    const models = new Map<string, ModelDefinition>();
    for (const raw of entries) {
      const entry = raw as GrokModelCatalogEntry;
      const metadata = isRecord(entry._meta) ? entry._meta : undefined;
      if (entry.hidden === true || metadata?.hidden === true) continue;
      const id = sanitizeUpstreamLabel(
        entry.id ?? entry.model ?? entry.modelId ?? metadata?.model ?? metadata?.modelId,
      );
      if (!id) continue;
      const reference = GROK_MODELS.find((model) => model.modelId.toLowerCase() === id.toLowerCase());
      const contextLimit =
        boundedUpstreamNumber(entry.context_window ?? entry.contextWindow, { min: 1, max: 10_000_000 }) ??
        reference?.contextLimit ?? 500_000;
      const outputLimit =
        boundedUpstreamNumber(entry.max_completion_tokens ?? entry.maxCompletionTokens, {
          min: 1,
          max: 10_000_000,
        }) ?? reference?.outputLimit ?? 64_000;
      const menu = parseGrokReasoningMenu(entry.reasoning_efforts ?? entry.reasoningEfforts);
      const supportsReasoning =
        entry.supports_reasoning_effort ?? entry.supportsReasoningEffort;
      const reasoning =
        supportsReasoning === true ||
        (supportsReasoning === undefined && menu.efforts.length > 0) ||
        (supportsReasoning === undefined && menu.efforts.length === 0 && reference?.reasoning === true);
      const model: ModelDefinition = {
        modelId: id,
        wireFamily: "responses",
        endpointPath: "/v1/responses",
        contextLimit,
        outputLimit,
        modalities: reference?.modalities ?? { input: ["text"], output: ["text"] },
        reasoning,
        ...(menu.efforts.length === 0 ? {} : { reasoningEfforts: menu.efforts }),
        toolCall: true,
        cost: modelsDevCatalog.costFor(GROK_PROVIDER_ID, id),
      };
      models.set(id, model);
    }
    if (models.size === 0) return null;
    // Deliberately no module-global cache here. Discovery results are persisted
    // to the DB (source=discovered) by the probing service; a process-global
    // `discoveredModels` map was clobbered by whichever account synced last —
    // the per-account catalog can differ by plan, so account B's sync replaced
    // account A's limits/reasoning menus for the whole process. Dispatch reads
    // the static `GROK_MODELS` fallback (which is verified accurate against the
    // live `/v1/models`), and the DB rows feed routing.
    return [...models.values()].sort((a, b) => a.modelId.localeCompare(b.modelId));
  } catch {
    return null;
  }
}

/**
 * Whether the wire accepts a `reasoning.effort` for this model.
 *
 * Derived from the catalog rather than restated as a model-name regex. Three
 * separate hand-maintained lists of "which grok models are current" had already
 * drifted apart once (`grok-4.7` was in the catalog and the request builder but
 * missing from the discovery allowlist), so the catalog is the single source:
 * a model is effort-capable exactly when it is a served model that the catalog
 * declares as reasoning-capable. Suffixed variants of a served model (e.g.
 * `grok-4.6-high`) inherit that capability, matching the previous prefix rule.
 *
 * There is intentionally no discovered/cached map here: the static catalog is
 * the single source for dispatch-time limits and reasoning, so a per-account
 * catalog can never clobber another account's model behavior (see
 * `fetchGrokModels`).
 */
function grokModelDefinition(modelId: string): ModelDefinition | undefined {
  const normalized = modelId.toLowerCase();
  return GROK_MODELS.find((model) => model.modelId.toLowerCase() === normalized);
}

const GROK_STATIC_DEFAULT_EFFORTS: Readonly<Record<string, ReasoningEffortLevel>> = {
  "grok-4.7": "high",
  "grok-4.5": "high",
  "grok-4.6": "high",
};

function grokDefaultEffort(modelId: string): ReasoningEffortLevel | undefined {
  const exact = modelId.toLowerCase();
  const exactDefault = GROK_STATIC_DEFAULT_EFFORTS[exact];
  if (exactDefault !== undefined) return exactDefault;
  for (const [id, effort] of Object.entries(GROK_STATIC_DEFAULT_EFFORTS)) {
    if (exact.startsWith(`${id}-`)) return effort;
  }
  return undefined;
}

function supportsReasoningEffort(modelId: string): boolean {
  const normalized = modelId.toLowerCase();
  const exact = grokModelDefinition(normalized);
  if (exact?.reasoningEfforts !== undefined) return exact.reasoningEfforts.length > 0;
  return GROK_MODELS.some(
    (model) =>
      model.reasoning &&
      (normalized === model.modelId.toLowerCase() ||
        normalized.startsWith(`${model.modelId.toLowerCase()}-`)),
  );
}

async function grokHeaders(
  context: ProviderDispatchContext,
  request?: CanonicalRequest,
  candidate?: ProviderDispatchTarget,
): Promise<Record<string, string>> {
  const stableSession =
    (typeof request?.conversation?.conversation_id === "string" && request.conversation.conversation_id.trim()
      ? request.conversation.conversation_id.trim()
      : undefined) ?? resolveInboundSessionId(context, request);
  const version = getGrokVersion();
  const agentId = await getGrokInstallId();
  const headers: Record<string, string> = {
    accept: "text/event-stream",
    "accept-encoding": "identity",
    "x-xai-token-auth": GROK_TOKEN_AUTH,
    "x-grok-client-identifier": GROK_CLIENT_IDENTIFIER,
    "x-grok-client-version": version,
    // Client-mode enum recovered from the 1.0.70 binary: Generic, GrokTUI,
    // GrokWeb, NebulaExtension, GrokPager, Desktop. We present as `Desktop`
    // (the desktop-app surface) — all values are accepted by the proxy, and
    // `Desktop` is the closest 1:1 match to a hosted/BYOK runtime.
    "x-grok-client-mode": "Desktop",
    "x-authenticateresponse": "authenticate-response",
    "user-agent": buildGrokUserAgent(version),
    "x-grok-agent-id": agentId,
    "x-grok-req-id": randomUUID(),
  };
  // The real CLI's sampler header builder stamps the upstream user id on every
  // request when it is known (xai-grok-sampler client.rs). The OAuth flow
  // already persisted it as `auth_state.userId` from `/v1/user`; sending it
  // makes our wire match the first-party client 1:1. It is an upstream
  // identity, not a local account/tenant id — never substitute those.
  const authState = isRecord(context.credential.auth_state) ? context.credential.auth_state : undefined;
  const userId = typeof authState?.userId === "string" ? authState.userId.trim() : "";
  if (userId.length > 0) headers["x-grok-user-id"] = userId;
  if (candidate?.model_id) {
    headers["x-grok-model-override"] = candidate.model_id;
  }
  const session = stableSession;
  if (session) {
    headers["x-grok-session-id"] = session;
    headers["x-grok-conv-id"] = session;
    const turn = context.request_headers?.["x-grok-turn-idx"]?.trim();
    if (turn && /^\d+$/.test(turn)) {
      // A real `grok` CLI client tracks its own prompt index; never override it.
      headers["x-grok-turn-idx"] = turn;
    } else {
      headers["x-grok-turn-idx"] = String(
        resolveGrokTurnIndex(session, request, context.request_identity),
      );
    }
  }
  const traceId = randomBytes(16).toString("hex");
  const spanId = randomBytes(8).toString("hex");
  headers.traceparent = `00-${traceId}-${spanId}-01`;
  return headers;
}

function normalizeEffort(value: unknown): ReasoningEffortLevel | undefined {
  if (typeof value !== "string") return undefined;
  const effort = value.trim().toLowerCase();
  const normalized = effort === "minimal" ? "low" : effort === "max" ? "xhigh" : effort;
  return GROK_EFFORTS.has(normalized as ReasoningEffortLevel)
    ? (normalized as ReasoningEffortLevel)
    : undefined;
}

function normalizeInput(input: unknown): unknown {
  if (!Array.isArray(input)) return input;
  // Provider-specific id hygiene only. Tool call/output pairing is owned by
  // the shared canonical repair (`repairRequestToolCalls` in the
  // request/preparer, which runs for every route including grok) plus the
  // factory Responses payload path — wire-side pairing filters duplicated
  // that logic and are deleted.
  //
  // The proxy is stateless: the model sees ONLY what is in `input`, so the
  // full conversation history must survive to it (verified live 2026-11-02 —
  // a turn 2 with the same session id but no history loses the turn 1
  // context). We therefore never drop message items; only server-scoped id
  // hygiene is applied.
  return input.filter((item) => {
    if (typeof item === "string") return !GROK_SERVER_ID.test(item);
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const value = item as Record<string, unknown>;
    if (value.type === "item_reference") return false;
    if (typeof value.id === "string" && GROK_SERVER_ID.test(value.id) && !GROK_NATIVE_ID.test(value.id))
      delete value.id;
    return true;
  });
}

function normalizeTools(payload: Record<string, unknown>): void {
  const tools = payload.tools;
  if (!Array.isArray(tools)) return;
  const validNames = new Set<string>();
  const hostedTypes = new Set<string>();
  const normalized: Record<string, unknown>[] = [];
  for (const raw of tools) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const tool = raw as Record<string, unknown>;
    const type = typeof tool.type === "string" ? tool.type : "";
    if (GROK_HOSTED_TOOLS.has(type)) {
      hostedTypes.add(type);
      normalized.push(tool);
      continue;
    }
    // Tools arrive factory-normalized (flat `{type:"function",name,parameters}`
    // — canonical tools are flat, so there is no nested `function.*` payload to
    // resolve). Only grok wire strictness stays here: trimmed names,
    // empty-name drop, parameters fallback, custom-tool synthesis.
    const name = typeof tool.name === "string" ? tool.name : "";
    if (!name.trim()) continue;
    const parameters =
      type === "custom"
        ? {
            type: "object",
            properties: { input: { type: "string" } },
            required: ["input"],
          }
        : tool.parameters !== null && typeof tool.parameters === "object" && !Array.isArray(tool.parameters)
          ? tool.parameters
          : { type: "object", properties: {} };
    const flat: Record<string, unknown> = {
      type: "function",
      name: name.trim().slice(0, 128),
      parameters,
    };
    const description = tool.description;
    if (typeof description === "string" && description.length > 0) flat.description = description;
    validNames.add(flat.name as string);
    normalized.push(flat);
  }
  if (normalized.length === 0) {
    delete payload.tools;
    delete payload.tool_choice;
    return;
  }
  payload.tools = normalized;
  const choice = payload.tool_choice;
  if (choice && typeof choice === "object" && !Array.isArray(choice)) {
    const value = choice as Record<string, unknown>;
    const type = typeof value.type === "string" ? value.type : "";
    if (type === "function" || type === "custom") {
      // Unlike `tools`, `tool_choice` genuinely arrives nested: the chat
      // encoder writes `{type:"function", function:{name}}` and
      // `{type:"custom", custom:{name}}`, so these nested reads are required
      // even though the tools loop above has no nested path.
      const fn = value.function;
      const nested = fn && typeof fn === "object" && !Array.isArray(fn) ? fn as Record<string, unknown> : undefined;
      const custom = value.custom;
      const nestedCustom = custom && typeof custom === "object" && !Array.isArray(custom) ? custom as Record<string, unknown> : undefined;
      const name = typeof value.name === "string"
        ? value.name
        : typeof nested?.name === "string"
          ? nested.name
          : typeof nestedCustom?.name === "string"
            ? nestedCustom.name
            : "";
      if (validNames.has(name)) payload.tool_choice = { type: "function", name };
      else delete payload.tool_choice;
    } else if (!hostedTypes.has(type)) {
      delete payload.tool_choice;
    }
  }
}

function normalizeGrokPayload(
  payload: Record<string, unknown>,
  request: CanonicalRequest,
  candidate: ProviderDispatchTarget,
  context: ProviderDispatchContext,
): void {
  payload.stream = true;
  if (payload.store === undefined || payload.store === null) payload.store = false;
  payload.input = normalizeInput(payload.input);
  normalizeTools(payload);

  const requestedModel = typeof payload.model === "string" && payload.model.length > 0
    ? payload.model
    : candidate.model_id;
  payload.model = requestedModel;
  const requestedEffort = normalizeEffort(
    (payload.reasoning as Record<string, unknown> | undefined)?.effort ??
      payload.reasoning_effort,
  );
  const reasoning =
    payload.reasoning && typeof payload.reasoning === "object" && !Array.isArray(payload.reasoning)
      ? { ...(payload.reasoning as Record<string, unknown>) }
      : {};
  reasoning.summary ??= "concise";
  const modelDefinition = grokModelDefinition(requestedModel);
  const supportsEffort = supportsReasoningEffort(requestedModel);
  const normalizedEffort = requestedEffort ?? grokDefaultEffort(requestedModel);
  if (
    supportsEffort &&
    normalizedEffort &&
    (modelDefinition?.reasoningEfforts === undefined ||
      modelDefinition.reasoningEfforts.includes(normalizedEffort as ReasoningEffortLevel))
  ) {
    reasoning.effort = normalizedEffort;
  } else {
    delete reasoning.effort;
  }
  delete payload.reasoning_effort;
  payload.reasoning = reasoning;

  const modelOutputLimit = modelDefinition?.outputLimit;
  if (modelOutputLimit !== null && modelOutputLimit !== undefined) {
    const requestedOutput = boundedUpstreamNumber(payload.max_output_tokens, {
      min: 1,
      max: 10_000_000,
    });
    payload.max_output_tokens =
      requestedOutput === undefined
        ? modelOutputLimit
        : Math.min(requestedOutput, modelOutputLimit);
  }

  const include = Array.isArray(payload.include) ? [...payload.include] : [];
  if (!include.includes("reasoning.encrypted_content")) include.push("reasoning.encrypted_content");
  payload.include = include;

  const cacheKey = resolvePromptCacheKey(request, context);
  if (cacheKey !== undefined && typeof payload.prompt_cache_key !== "string")
    payload.prompt_cache_key = cacheKey.slice(0, 512);

  // The Grok Build proxy does NOT persist responses: a `previous_response_id`
  // (even from a real `response.id` of an earlier turn, with `store:true`)
  // returns 404 "Previous response cannot be found" — verified live
  // 2026-11-02. The proxy is stateless; continuity comes only from the full
  // `input` history, so referencing a previous response id can never succeed
  // and would fail the whole request. Drop it here.
  delete payload.previous_response_id;

  for (const key of Object.keys(payload)) {
    if (!GROK_ALLOWED_FIELDS.has(key)) delete payload[key];
  }
}


export const GrokConfig = withBearerAuthentication({
  provider_id: GROK_PROVIDER_ID,
  base_url: GROK_BASE_URL,
  endpoint_paths_by_wire_family: { responses: "/v1/responses" },
  extra_headers: { accept: "text/event-stream", "accept-encoding": "identity" },
  buildExtraHeaders: grokHeaders,
  prePayload: normalizeGrokPayload,
  // The real CLI compresses the request body with zstd (sampler
  // `request_compression`); stamp the matching Content-Encoding and compress.
  request_compression: "zstd",
});

/**
 * Dedicated Grok Build provider adapter.
 *
 * The only deviation from the shared OpenAI-compatible factory is the OAuth
 * credential-kind guard; everything else (transport, SSE decoding, headers,
 * payload normalization) is the declarative config below.
 */
class GrokAdapter extends OpenAICompatibleAdapter {
  constructor() {
    super(GrokConfig);
  }

  public override async *dispatch(
    request: CanonicalRequest,
    candidate: ProviderDispatchTarget,
    context: ProviderDispatchContext,
  ): AsyncIterable<CanonicalEvent> {
    if (context.credential.credential_kind !== "oauth") {
      assertCredentialKind(context.credential, "oauth", "grok");
    }
    yield* super.dispatch(request, candidate, context);
  }
}

/** Dedicated Grok Build provider adapter. */
export const grokAdapter: ProviderAdapter = new GrokAdapter();
