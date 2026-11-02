import { completeRequiredSchema } from "../../../protocol/codecs";
import type { ModelDefinition } from "../../provider-model-definition";
import type { CanonicalRequest, ToolDefinition } from "../../../protocol/canonical-model";
import { isRecord } from "../../../protocol/codecs";
import type { ProviderDispatchContext } from "../../provider-contracts";
import { PROVIDER_COMPATIBILITY_PROFILES } from "../../provider-metadata";
import { defineModel } from "../../provider-model-definition";
import type { ApiKeyProviderSpec } from "../../configured-provider";
import { resolveOpenCodeUnavailableFree } from "../../../config/providers";
import { buildOpenCodeHeaders } from "./fingerprint";
import { OPENCODE_TOOL_DEFINITIONS } from "./tool-definitions";
import { injectOpenCodePrompt } from "./prompt";
/**
 * OpenCode's three API-key tiers, all served from `opencode.ai`:
 *
 * - `opencode` (OpenCode Free): unauthenticated public route — no
 *   `Authorization` header is ever sent, even if a credential were somehow
 *   configured. Serves the free-tier model set.
 * - `opencode-zen` (OpenCode Zen): billed API-key route.
 * - `opencode-go` (OpenCode Go): billed API-key route on the separate
 *   `/zen/go/v1` base — a bundled, higher-tier model set.
 *
 * Free and Zen dispatch on the `/inference` origin using the 2.1 family
 * segment: `/inference/openai/v1/...` for chat/responses and
 * `/inference/anthropic/v1/messages?beta=true` for Anthropic. The catalog is
 * the other way round: `/zen/v1/models` publishes the listing while
 * `/inference/v1/models` answers 404. A replay that hit `/inference/v1` directly
 * returned 200 while the gateway kept failing, because every model row carried
 * an explicit `/zen/v1` endpoint — which outranks the per-provider wire-family
 * table at dispatch.
 *
 * Free and Zen use the OpenCode desktop-client header fingerprint
 * (`x-opencode-*` correlation IDs, `user-agent: opencode`). Go is
 * intentionally API-key-only.
 */
/**
 * The v2 upstream path for a wire family on the `/inference` origin, matching
 * the reference implementation's `v2EndpointPath`: the 2.1 client
 * groups `/inference` routes by provider family, so chat/responses sit under
 * `/openai/v1/...` and Anthropic under `/anthropic/v1/messages?beta=true`.
 * Go keeps the flat `/zen/go/v1/...` shape.
 */
function zenEndpoint(wireFamily: string): string {
  if (wireFamily === "messages") return "/inference/anthropic/v1/messages?beta=true";
  const protocol = wireFamily === "responses" ? "responses" : "chat/completions";
  return `/inference/openai/v1/${protocol}`;
}

/**
 * The System One decision endpoint on the `/inference` origin. Verified live:
 * System One does NOT take the v2 family segment — `/inference/openai/v1/systemone`
 * answers 404 while the flat `/inference/v1/systemone` answers 200 with a valid
 * `{state, questions}` body.
 */
function zenSystemoneEndpoint(): string {
  return "/inference/v1/systemone";
}
const GO_PATH_PREFIX = "/zen/go/v1";

/**
 * Free-tier ids that do not carry the `-free` suffix the rest of the tier uses.
 *
 * `/zen/v1/models` publishes the whole catalog — 81 ids, of which the billed
 * ones (`claude-opus-5`, `gpt-6-astra`, …) are not routable for this provider.
 * The tier marker is normally the suffix, but this one id has none, so a
 * suffix-only rule would drop a served model. Kept as an explicit list rather
 * than a guess from the listing, which states no tier field at all.
 *
 * One listing id is deliberately not served even though it carries the suffix:
 * `deepseek-v4-flash-free` is still advertised but answers 400 "Model is
 * unavailable" to a real free-tier dispatch (verified with this adapter's own
 * fingerprint headers, stream + agent tools), so it is not a free model this
 * provider can route to and is excluded by `isFreeTierZenModel`.
 */
const KNOWN_FREE_ZEN_IDS: readonly string[] = ["big-pickle"];

/** Free-tier ids that the listing still advertises but upstream refuses. */
const UNAVAILABLE_FREE_ZEN_IDS: readonly string[] = [
  "deepseek-v4-flash-free",
  // Advertised by `/zen/v1/models` and carrying the free-tier suffix, but a
  // real free-tier dispatch (this adapter's own fingerprint headers, agent
  // tools) answers 400 "Endpoint is unavailable". Keeping it would re-add a row
  // that can only fail a probe.
  "ling-3.1-flash-free",
  // Advertised by `/zen/v1/models` and carrying the free-tier suffix, but
  // upstream refuses it for this adapter's free-tier dispatch, so discovery
  // must not re-add the row.
  "mimo-v2.5-free",
  "space-bunny-free",
];

/**
 * The unavailable list, overridable without a code change.
 *
 * These ids are what upstream *currently* refuses, measured 2026-10-14 — and
 * the reference gateway takes the opposite approach entirely: it trusts
 * metadata (`pricing.go` marks a model free when its cost is 0 and it is not
 * deprecated) and hardcodes no ids at all. Ours is more precise while the
 * measurements hold, and worse the moment upstream changes, because a new
 * refusal needs a deploy.
 *
 * `CARTETHYIA_OPENCODE_UNAVAILABLE_FREE` lets an operator correct that
 * immediately: a comma-separated list that *replaces* the bundled one, or the
 * single token `none` to trust the listing completely. The bundled ids remain
 * the default so an unconfigured install keeps these refusals.
 */
function unavailableFreeZenIds(): readonly string[] {
  const override = resolveOpenCodeUnavailableFree();
  if (override === undefined) return UNAVAILABLE_FREE_ZEN_IDS;
  if (override === "none") return [];
  return override;
}

/**
 * Zen ids served by the native System One decision endpoint, not the chat wire.
 *
 * These are the `kind: "systemone"` models of the Zen catalog. They carry the
 * `-free` suffix convention (or the bare `jev-1.13`), so the free-tier filter
 * would otherwise admit them as chat models — and a decision body sent to
 * `/zen/v1/chat/completions` answers `500 Internal server error`, while a chat
 * body sent to `/zen/v1/systemone` is meaningless. Classifying them here keeps
 * them out of the chat surface and onto the native route.
 */
const SYSTEMONE_ZEN_IDS: readonly string[] = ["jev-1.13", "jev-1.13-free"];

/** Whether a Zen id is served by the System One decision endpoint. */
export function isSystemoneZenModel(modelId: string): boolean {
  return SYSTEMONE_ZEN_IDS.includes(modelId);
}

/**
 * Whether a `/zen/v1/models` id belongs to the free tier this provider serves.
 *
 * The listing states no tier field, so the tier is read from the id convention
 * the provider itself uses. Two failure directions are handled explicitly: an
 * id outside the convention that is still free (`KNOWN_FREE_ZEN_IDS`), and an
 * id inside it that upstream no longer serves (`UNAVAILABLE_FREE_ZEN_IDS`) —
 * without the latter, "Fetch models" would keep re-adding a row that can only
 * fail a probe.
 */
export function isFreeTierZenModel(modelId: string): boolean {
  // Dispatch ids arrive provider-prefixed (`opencode/big-pickle`) while the
  // catalog and `KNOWN_FREE_ZEN_IDS` hold the bare id, so match on the bare
  // id rather than the prefixed one.
  const bare = modelId.slice(modelId.indexOf("/") + 1);
  if (unavailableFreeZenIds().includes(bare)) return false;
  // The reference gateway's name rule admits any id containing "free" (any
  // case) in addition to the suffix convention; the explicit lists keep the
  // measured exclusions and the one free id that carries no marker.
  return bare.endsWith("-free") || KNOWN_FREE_ZEN_IDS.includes(bare) || bare.toLowerCase().includes("free");
}

/**
 * The `Accept` a free-tier dispatch advertises.
 *
 * What OpenCode 2.x's AI SDK puts on the wire, and what the reference gateway
 * sends (`upstream.go:1293`). The gate has only ever been seen accepting the
 * narrower `text/event-stream`, so nothing here fixes a live failure — this is
 * the value a real client produces, which is the only defensible choice when
 * the gate tightens.
 */
const FREE_TIER_ACCEPT = "application/json, text/event-stream";

function opencodeDesktopHeaders(
  context: ProviderDispatchContext,
  request?: CanonicalRequest,
): Record<string, string> {
  const freeModel = request !== undefined && isFreeTierZenModel(request.model);
  return {
    ...buildOpenCodeHeaders(
      undefined,
      context.conversation_affinity,
      context.request_headers?.["x-opencode-project"],
      context.request_headers?.["x-opencode-session-id"],
    ),
    // The free-tier gate accepts dispatches with no `Authorization` at all
    // (verified live 2026-11-02: the same captured flow answers 200 both with
    // `Bearer public` and with no auth header, as long as the body/session
    // fingerprint is valid). No anonymous sentinel is sent.
    // The free-tier gate refuses non-streaming dispatches with 403
    // FreeTierError, so free models always advertise SSE regardless of the
    // client's own Accept; billed models keep the JSON default. The value is
    // what OpenCode 2.x's AI SDK sends — a broader Accept than the narrower
    // `text/event-stream` the gate is known to accept, so this is alignment
    // with the real client rather than a fix for a live failure. It costs
    // nothing: `stream: true` is forced on the body either way, so the upstream
    // answers SSE regardless.
    ...(freeModel ? { accept: FREE_TIER_ACCEPT } : {}),
  };
}
/**
 * Canonical agent-tool fingerprint the OpenCode free tier requires on every
 * dispatch, captured verbatim from a real 2.0.26 client dispatch.
 *
 * Upstream rejects tool-less or *partially* agent-shaped requests with
 * `FreeTierError` (upstream 403). Verified live 2026-10-14: the full set here
 * returns 200, and so does one with `execute` dropped, while a five-tool subset
 * (`bash, edit, glob, grep, read`) — and any smaller set — still returns 403.
 * The gate reads the tool set, not any single name, so backfilling "the core
 * tools" is not enough: backfill the whole set. They are plain
 * `ToolDefinition`s — every wire codec serializes them, no per-wire patching.
 */
/**
 * Every tool the free-tier gate recognises, in the order the real 2.2.0
 * client declares them on the wire (mitm capture 2026-11-02, flow 4), with
 * the client's own description and schema.
 *
 * The gate compares a recognised tool's definition, not just its name: a stub
 * carrying the right name is refused. These are therefore verbatim captures —
 * see `./tool-definitions` for provenance. A real dispatch carries exactly
 * these 11 tools (the binary's full `UPt` registry has 14, but the build
 * agent sends only these).
 */
const FREE_AGENT_TOOL_NAMES_ORDERED: readonly string[] = [
  "edit",
  "glob",
  "grep",
  "read",
  "shell",
  "skill",
  "subagent",
  "webfetch",
  "websearch",
  "write",
  "execute",
];

/**
 * The agent-tool names the free tier expects, exported so tests assert against
 * the same list the adapter sends instead of a copy that can drift.
 */
export const FREE_AGENT_TOOL_NAMES: readonly string[] = FREE_AGENT_TOOL_NAMES_ORDERED;
/**
 * Fallback schema for a tool name the capture does not carry.
 *
 * An empty `properties` object is refused: the gate reads the schema, and a
 * tool with no parameters at all is not agent-shaped — an otherwise-correct
 * dispatch carrying eleven such tools returned 403 `FreeTierError`, while the
 * same dispatch with one declared property returned 200 (verified live
 * 2026-10-15). Every name in `FREE_AGENT_TOOL_NAMES_ORDERED` has a captured
 * definition, so this is a safety net rather than the normal path.
 */
const FREE_AGENT_TOOL_SCHEMA = {
  type: "object",
  properties: {
    input: { type: "string", description: "Input for the tool." },
  },
  required: [] as string[],
} as const;

function ensureFreeAgentRequest(request: CanonicalRequest): CanonicalRequest {
  const present: Record<string, true> = {};
  for (const tool of request.tools ?? []) present[tool.name] = true;
  const missing: ToolDefinition[] = FREE_AGENT_TOOL_NAMES_ORDERED.filter(
    (name) => !present[name],
  ).map((name) => {
    const definition = OPENCODE_TOOL_DEFINITIONS[name];
    return {
      name,
      description: definition?.description ?? name,
      jsonSchema: (definition?.parameters ?? FREE_AGENT_TOOL_SCHEMA) as ToolDefinition["jsonSchema"],
      // The real client marks every declared tool strict:false on the wire.
      strict: false,
    };
  });
  if (missing.length === 0) return request;
  return {
    ...request,
    tools: [...(request.tools ?? []), ...missing],
  };
}

function completeOpenCodeToolSchemas(payload: Record<string, unknown>): void {
  if (!Array.isArray(payload.tools)) return;
  payload.tools = payload.tools.map((tool) => {
    if (!isRecord(tool)) return tool;
    const functionValue = tool.function;
    if (isRecord(functionValue) && "parameters" in functionValue) {
      return {
        ...tool,
        function: { ...functionValue, parameters: completeRequiredSchema(functionValue.parameters) },
      };
    }
    if ("parameters" in tool) return { ...tool, parameters: completeRequiredSchema(tool.parameters) };
    return tool;
  });
}

/**
 * The most tool definitions one OpenCode dispatch accepts.
 *
 * A live dispatch carrying a whole agent catalog was refused with
 * `400 invalid_request_error`: `Invalid value for 'tools': maximum number of
 * items is 128`. The refusal names the array length, so the clamp counts
 * entries, not names.
 */
const OPENCODE_MAX_TOOLS = 128;

/** The function name a serialized tool declares, on either wire shape. */
function wireToolName(tool: unknown): string | undefined {
  if (!isRecord(tool)) return undefined;
  // Responses puts the name on the tool itself; chat nests it under function.
  if (typeof tool["name"] === "string") return tool["name"];
  const fn = tool["function"];
  if (isRecord(fn) && typeof fn["name"] === "string") return fn["name"];
  const custom = tool["custom"];
  if (isRecord(custom) && typeof custom["name"] === "string") return custom["name"];
  return undefined;
}

/**
 * Drops tool definitions past the upstream's limit.
 *
 * A definition the conversation already called is kept first: dropping it
 * leaves a tool result in the history with no matching definition, which the
 * upstream rejects on its own. Everything else keeps its original order and
 * fills whatever slots remain. A conversation that already called more than
 * the limit cannot be saved by dropping anything, so it is left untouched and
 * fails upstream with the real reason instead of a silently broken history.
 */
function clampOpenCodeTools(payload: Record<string, unknown>, request: CanonicalRequest): void {
  const tools = payload["tools"];
  if (!Array.isArray(tools) || tools.length <= OPENCODE_MAX_TOOLS) return;
  // Two sets must never be trimmed away, for different reasons:
  // - a tool the conversation already called, or its result stays in the
  //   history with no definition;
  // - the free-tier fingerprint tool set, which the gate reads on its own. A
  //   conversation that arrives carrying its own (larger) agent catalog fills
  //   the wire first, so a clamp that keeps only called tools drops the
  //   fingerprint tools and the dispatch is refused with 403 FreeTierError —
  //   reproduced live on 2026-10-16 from a 128-tool Claude Code session routed
  //   to a free model.
  const protectedNames = new Set<string>(FREE_AGENT_TOOL_NAMES);
  const called = new Set<string>();
  for (const message of request.messages) {
    for (const part of message.content) {
      if (part.kind === "toolCall") called.add(part.name);
    }
  }
  const kept: unknown[] = [];
  const rest: unknown[] = [];
  for (const tool of tools) {
    const name = wireToolName(tool);
    if (name !== undefined && (called.has(name) || protectedNames.has(name))) kept.push(tool);
    else rest.push(tool);
  }
  if (kept.length > OPENCODE_MAX_TOOLS) return;
  payload["tools"] = [...kept, ...rest.slice(0, OPENCODE_MAX_TOOLS - kept.length)];
}
/**
 * The completion ceiling a 2.x client puts on every v2 chat body, matching the
 * reference gateway's `v2CompletionLimit`. The upstream's free gate expects the
 * same ceiling; an explicit `max_tokens`/`max_completion_tokens` from the
 * caller always wins.
 */
const OPENCODE_V2_COMPLETION_LIMIT = 32_000;

/** The key order a 2.x client's JSON.stringify emits for a chat body. */
const V2_CHAT_KEY_ORDER = ["model", "messages", "tools", "stream", "stream_options", "max_completion_tokens"] as const;

/**
 * Reorders a chat payload's keys to the 2.x client's byte layout: the skeleton
 * keys first in the client's order, then every remaining key sorted. Values are
 * untouched; JSON.stringify preserves this insertion order, so the serialized
 * body matches the reference gateway's `marshalV2ChatBody`.
 */
function reorderV2ChatKeys(payload: Record<string, unknown>): void {
  const keys = [
    ...V2_CHAT_KEY_ORDER.filter((key) => key in payload),
    ...Object.keys(payload).filter((key) => !(V2_CHAT_KEY_ORDER as readonly string[]).includes(key)).sort(),
  ];
  const next: Record<string, unknown> = {};
  for (const key of keys) next[key] = payload[key];
  for (const key of Object.keys(payload)) delete payload[key];
  Object.assign(payload, next);
}

function opencodeSpec(providerId: "opencode" | "opencode-zen" | "opencode-go"): ApiKeyProviderSpec {
  // Free-tier gate facts (verified live 2026-10-14 against opencode.ai/zen/v1):
  // a request for a free model with stream:false is ALWAYS refused with 403
  // FreeTierError — regardless of headers, tools, or session shape — while
  // the same body with stream:true passes. The gate keys on the model's free
  // status, not the provider row: every tier (free, Zen, Go) carries free
  // models, so the workarounds below apply per MODEL via isFreeTierZenModel,
  // never per provider id. The response layer aggregates the forced SSE back
  // to JSON for non-stream clients.
  return {
    provider_id: providerId,
    endpoint_paths_by_wire_family: {
      ...PROVIDER_COMPATIBILITY_PROFILES[providerId]?.endpoint_paths_by_wire_family,
    },
    chatTokenLimitField: "max_completion_tokens",
    // The OpenCode client identity fingerprint (x-opencode-* correlation ids,
    // user-agent, request id) is the provider's own request identity: it goes
    // on every dispatch of every tier, gated or not — billed traffic included.
    buildExtraHeaders: opencodeDesktopHeaders,
    prePayload: (payload, request, candidate) => {
      completeOpenCodeToolSchemas(payload);
      clampOpenCodeTools(payload, request);
      if (candidate.wire_family === "responses") {
        payload.store = false;
      }
      // Free model: match the reference gateway's free-tier shaping 1:1 —
      // the official CLI system prompt, the v2 completion ceiling, the
      // include_usage flag, and the forced upstream stream. The gate refuses
      // tool-less, non-streaming, or non-agent-shaped free dispatches with 403
      // FreeTierError; here it only patches the wire body, never the
      // client-visible stream contract.
      if (isFreeTierZenModel(candidate.model_id)) {
        if (candidate.wire_family === "chat") {
          // The wire encoder injects the v2 ceiling (32000) as the default
          // max_completion_tokens when the caller set no limit. Treat that
          // sentinel as "unset" so the model's own declared output ceiling can
          // take its place; an explicit user limit is never touched.
          const isV2Default =
            payload["max_completion_tokens"] === OPENCODE_V2_COMPLETION_LIMIT &&
            payload["max_tokens"] === undefined;
          if (isV2Default || (payload["max_completion_tokens"] === undefined && payload["max_tokens"] === undefined)) {
            const ceiling =
              typeof candidate.output_limit === "number" && candidate.output_limit > 0
                ? candidate.output_limit
                : OPENCODE_V2_COMPLETION_LIMIT;
            payload["max_completion_tokens"] = ceiling;
          }
          payload.stream_options = {
            ...(typeof payload.stream_options === "object" && payload.stream_options !== null
              ? (payload.stream_options as Record<string, unknown>)
              : {}),
            include_usage: true,
          };
        }
        const family = candidate.wire_family;
        if (family === "chat" || family === "responses" || family === "messages") {
          injectOpenCodePrompt(payload, family);
        }
        payload.stream = true;
        if (candidate.wire_family === "chat") reorderV2ChatKeys(payload);
      }
    },
    // OpenCode Free is a genuinely public, unauthenticated endpoint: no
    // credential is ever forwarded, whatever the account configuration says.
    ...(providerId === "opencode" ? { credential_forwarding: "never" as const } : {}),
    // Free models on any tier need the agent-tool fingerprint and the forced
    // upstream stream (the gate refuses tool-less or stream:false free
    // dispatches with 403 FreeTierError). Billed models dispatch untouched.
    prepareRequest: (request) =>
      isFreeTierZenModel(request.model) ? ensureFreeAgentRequest(request) : request,
  };
}
/** OpenCode Free — unauthenticated public route. No credential is ever forwarded. */
export const OPENCODE_FREE_SPEC: ApiKeyProviderSpec = opencodeSpec("opencode");
/** OpenCode Zen — billed API-key route on `/zen/v1`. */
export const OPENCODE_ZEN_SPEC: ApiKeyProviderSpec = opencodeSpec("opencode-zen");
/** OpenCode Go — billed API-key route on the separate `/zen/go/v1` base. */
export const OPENCODE_GO_SPEC: ApiKeyProviderSpec = opencodeSpec("opencode-go");

/**
 * The free-tier subset of `/zen/v1/models`, as this provider's own discovery.
 *
 * The listing is the shared Zen catalog and states no tier: it returns all 81
 * ids, most of which are billed and not routable without a credential. This
 * provider serves the free tier only, so the listing is filtered to that tier
 * and every surviving row is marked `freeTier`, which is what the model list
 * groups as "Free models (auto)".
 *
 * The rows are the fetcher's own definitions, spread rather than rebuilt: it has
 * already resolved limits, pricing, and the wire family from the id (a
 * Responses-native id lands on `responses`, not pinned to chat), and
 * re-deriving that here would discard the resolution and let the two drift.
 */
export async function discoverOpenCodeFreeModels(options: {
  readonly baseUrl: string;
  readonly fetcher?: typeof fetch;
}): Promise<readonly ModelDefinition[] | null> {
  // dynamic-import: cycle break -- the discovery helper imports this file's
  // OPENCODE_FREE_SPEC to decide its request shape.
  const { fetchOpenAICompatibleModels } = await import("../../discovery/openai-model-discovery");
  const listed = await fetchOpenAICompatibleModels({
    baseUrl: options.baseUrl,
    providerId: "opencode",
    ...(options.fetcher === undefined ? {} : { fetcher: options.fetcher }),
  });
  if (listed === null) return null;
  return listed
    .filter((model) => isFreeTierZenModel(model.modelId))
    .map((model) => {
      if (!isSystemoneZenModel(model.modelId)) return { ...model, freeTier: true } as const;
      // A System One id survives the free-tier filter (it carries the `-free`
      // suffix) but is not a chat model: reclassify it onto the native decision
      // endpoint so the chat surface never sees it, and carry the endpoint's
      // own limits — the Zen listing publishes none, so this row otherwise
      // advertised the invented chat window for a decision endpoint.
      return {
        ...model,
        ...systemoneLimits(),
        freeTier: true,
        serviceKind: "systemone" as const,
        endpointPath: zenSystemoneEndpoint(),
      };
    });
}

// Limits and pricing resolve from the committed packed catalog
// (`discovery/catalog/`) via `providerId`; the catalog is keyed per provider,
// so passing it is what makes the lookup answer with OpenCode's own entry
// instead of a same-named model from another reseller. The catalog's shared
// OpenCode row understates this model's 1M context limit, so keep the corrected
// limit explicit for both tiers that serve it.
const sharedZenChat: readonly ModelDefinition[] = [
  defineModel({ id: "big-pickle", providerId: "opencode", wireFamily: "chat", endpoint: zenEndpoint("chat"), vision: true, reasoning: true }),
  defineModel({
    id: "mimo-v2.6-flash-free",
    providerId: "opencode",
    wireFamily: "chat",
    endpoint: zenEndpoint("chat"),
    ctx: 1_000_000,
    out: 32_000,
    vision: true,
    document: true,
    audio: true,
    reasoning: true,
    free: true,
  }),
];

const MUSE_SPARK_REASONING_EFFORTS = ["minimal", "low", "medium", "high", "xhigh"] as const;

/**
 * Limits for a System One decision model, as a `(context, output)` pair.
 *
 * Not a chat window: the native route posts the caller's `{state, questions}`
 * body untouched. Kept in one place because the discovery path reclassifies a
 * fetched System One id onto this endpoint, and the Zen dispatch listing
 * publishes no limits at all — without this it inherited the invented chat
 * default instead of the row's own values.
 */
const SYSTEMONE_LIMITS = { context: 200_000, output: 8_192 } as const;

/**
 * System One decision models served from the Zen `/systemone` endpoint.
 *
 * Not chat models: a `serviceKind: "systemone"` row is dispatched by the native
 * System One route. Both the free and billed Zen tiers front the same endpoint;
 * `jev-1.13-free` is the free-tier spelling.
 */
const systemoneZen = (id: string, free: boolean): ModelDefinition =>
  defineModel({
    id,
    providerId: "opencode",
    serviceKind: "systemone",
    wireFamily: "chat",
    endpoint: zenSystemoneEndpoint(),
    ctx: SYSTEMONE_LIMITS.context,
    out: SYSTEMONE_LIMITS.output,
    toolCall: false,
    ...(free ? { free: true } : {}),
  });

/**
 * The System One limits in `ModelDefinition`'s field names, so the discovery
 * path can reclassify a fetched id with this row's own values instead of the
 * chat default. `defineModel` renames them; a `ModelDefinition` does not.
 */
export function systemoneLimits(): Pick<ModelDefinition, "contextLimit" | "outputLimit"> {
  return { contextLimit: SYSTEMONE_LIMITS.context, outputLimit: SYSTEMONE_LIMITS.output };
}

export const OPENCODE_FREE_MODELS: readonly ModelDefinition[] = [
  ...sharedZenChat,
  // `nemotron-3-ultra-free`, `nemotron-3.5-lightning-free` and
  // `longcat-2.5-preview-free` are excluded: the live Zen roster does not list
  // them. A row the provider's own roster dropped can disappear from the wire
  // without notice, which makes it a stale row — one that routes to a 404 at
  // dispatch time rather than failing at catalog load. `big-pickle` and the
  // rest of the shared Zen listing remain.
  systemoneZen("jev-1.13-free", true),
];

export const OPENCODE_ZEN_MODELS: readonly ModelDefinition[] = [
  ...sharedZenChat,
  defineModel({ id: "muse-spark-1.2", providerId: "opencode", wireFamily: "responses", endpoint: zenEndpoint("responses"), vision: true, reasoning: true, reasoningEfforts: MUSE_SPARK_REASONING_EFFORTS }),
  defineModel({ id: "muse-spark-1.3", providerId: "opencode", wireFamily: "responses", endpoint: zenEndpoint("responses"), vision: true, reasoning: true, reasoningEfforts: MUSE_SPARK_REASONING_EFFORTS }),
  systemoneZen("jev-1.13", false),
];

export const OPENCODE_GO_MODELS: readonly ModelDefinition[] = [
  // `muse-spark-1.2` is not served upstream; the catalog files
  // `muse-spark-1.2-contributor` at 1048576/131072, which is what this row
  // serves.
  defineModel({ id: "muse-spark-1.2-contributor", providerId: "opencode-go", wireFamily: "responses", endpoint: `${GO_PATH_PREFIX}/responses`, ctx: 1048576, out: 131072, vision: true, reasoning: true }),
  defineModel({ id: "grok-4.7", providerId: "opencode-go", wireFamily: "chat", endpoint: `${GO_PATH_PREFIX}/chat/completions`, ctx: 500000, out: 500000, reasoning: true }),
  defineModel({ id: "glm-5.2", providerId: "opencode-go", wireFamily: "chat", endpoint: `${GO_PATH_PREFIX}/chat/completions`, reasoning: true }),
  defineModel({ id: "kimi-k3", providerId: "opencode-go", wireFamily: "chat", endpoint: `${GO_PATH_PREFIX}/chat/completions`, vision: true, reasoning: true }),
  defineModel({ id: "kimi-k2.7-code", providerId: "opencode-go", wireFamily: "chat", endpoint: `${GO_PATH_PREFIX}/chat/completions`, reasoning: true }),
  defineModel({ id: "mimo-v2.5-pro", providerId: "opencode-go", wireFamily: "chat", endpoint: `${GO_PATH_PREFIX}/chat/completions`, reasoning: true }),
  defineModel({ id: "qwen3.8-max", providerId: "opencode-go", wireFamily: "chat", endpoint: `${GO_PATH_PREFIX}/chat/completions`, ctx: 1000000, out: 131072, reasoning: true }),
  defineModel({ id: "minimax-m3", providerId: "opencode-go", wireFamily: "chat", endpoint: `${GO_PATH_PREFIX}/chat/completions`, reasoning: true }),
  defineModel({ id: "deepseek-v4-pro", providerId: "opencode-go", wireFamily: "chat", endpoint: `${GO_PATH_PREFIX}/chat/completions`, reasoning: true }),
  defineModel({ id: "deepseek-v4.1-flash", providerId: "opencode-go", wireFamily: "chat", endpoint: `${GO_PATH_PREFIX}/chat/completions`, ctx: 1000000, out: 384000, reasoning: true, vision: true }),
  defineModel({ id: "hy3", providerId: "opencode-go", wireFamily: "chat", endpoint: `${GO_PATH_PREFIX}/chat/completions`, reasoning: true }),
];
