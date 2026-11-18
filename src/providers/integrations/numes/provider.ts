// Numes provider — TypeScript, Numes marketplace gateway, Bun gateway.
//
// Numes (numes.ai) is an inference marketplace: independent providers serve
// the models and the gateway speaks plain OpenAI Chat Completions
// (`POST /api/v1/chat/completions`, `GET /api/v1/models`) with a bearer
// `sk-numes-...` key. Model ids are `author/slug` and the free tier is
// marked by a literal `:free` suffix on the id — every such row reports
// zero pricing and answered `cost: 0` live (verified 2026-11-18).
//
// Wire facts (probed live 2026-11-18):
//   - GET /api/v1/models              → 200, 331 rows; 9 carry `:free`.
//   - POST /api/v1/chat/completions   → 200 JSON for `deepseek/...:free`.
//   - /api/v1/responses, /messages, /completions → 404: chat wire only.
//   - OpenAPI (numes.ai/docs/openapi.json) also lists embeddings, images,
//     and audio routes — none are chat-wire and none are catalogued here.
//
// The static roster carries only the nine live-verified `:free` rows so the
// Free Limited section is populated before any fetch. Live discovery returns
// the full key-visible catalog (paid rows included) so an operator can add a
// billed model manually; roster rows win on id so the free flags survive.

import type { ApiKeyProviderSpec } from "../../configured-provider";
import { defineModel, type ModelDefinition } from "../../provider-model-definition";
import { isRecord } from "../../../protocol/codecs";
import { boundedUpstreamArray, boundedUpstreamNumber, sanitizeUpstreamLabel } from "../../provider-sanitize";

const NUMES_PROVIDER_ID = "numes" as const;

/** Chat path below the `/api/v1` base root. */
const NUMES_CHAT_PATH = "/chat/completions";

/**
 * Numes adapter spec: plain bearer, OpenAI-compatible chat. No compression
 * or content-type override — the edge accepts ordinary JSON (verified live).
 */
export const NUMES_SPEC: ApiKeyProviderSpec = {
  provider_id: NUMES_PROVIDER_ID,
  endpoint_paths_by_wire_family: { chat: NUMES_CHAT_PATH },
};

/**
 * Default rows: the nine `:free` models from the live `/api/v1/models`
 * listing (2026-11-18). Context windows and output caps come from the
 * upstream's own `context_length` / `maximum_output_length`; effort ladders
 * from `reasoning.supported_efforts`; vision from
 * `architecture.input_modalities`. All bill zero (`free` + `freeTier`).
 */
export const NUMES_DEFAULT_MODELS: readonly ModelDefinition[] = [
  defineModel({
    id: "dealignai/deepseek-v4.1-flash-uncensored-fp8:free",
    wireFamily: "chat",
    endpoint: NUMES_CHAT_PATH,
    ctx: 1_048_576,
    out: 65_536,
    reasoning: true,
    reasoningEfforts: ["none", "low", "high", "max"],
    toolCall: true,
    vision: true,
    free: true,
    freeTier: true,
  }),
  defineModel({
    id: "dealignai/glm-5.3-flash-uncensored-fp8:free",
    wireFamily: "chat",
    endpoint: NUMES_CHAT_PATH,
    ctx: 1_048_576,
    out: 65_536,
    reasoning: true,
    reasoningEfforts: ["low", "high", "max"],
    toolCall: true,
    vision: true,
    free: true,
    freeTier: true,
  }),
  defineModel({
    id: "dealignai/glm-5.3-uncensored-fp8:free",
    wireFamily: "chat",
    endpoint: NUMES_CHAT_PATH,
    ctx: 1_048_576,
    out: 65_536,
    reasoning: true,
    reasoningEfforts: ["low", "high", "max"],
    toolCall: true,
    free: true,
    freeTier: true,
  }),
  defineModel({
    id: "deepseek/deepseek-v4.1-flash:free",
    wireFamily: "chat",
    endpoint: NUMES_CHAT_PATH,
    ctx: 1_048_576,
    out: 65_536,
    reasoning: true,
    reasoningEfforts: ["none", "low", "medium", "high", "max"],
    toolCall: true,
    free: true,
    freeTier: true,
  }),
  defineModel({
    id: "moonshotai/kimi-k3.1-pro:free",
    wireFamily: "chat",
    endpoint: NUMES_CHAT_PATH,
    ctx: 1_048_576,
    out: 65_536,
    reasoning: true,
    reasoningEfforts: ["none", "low", "medium", "high", "max"],
    toolCall: true,
    vision: true,
    free: true,
    freeTier: true,
  }),
  defineModel({
    id: "nvidia/nemotron-3-ultra-550b-a55b:free",
    wireFamily: "chat",
    endpoint: NUMES_CHAT_PATH,
    ctx: 1_048_576,
    out: 65_536,
    reasoning: true,
    reasoningEfforts: ["none", "medium", "high"],
    toolCall: true,
    free: true,
    freeTier: true,
  }),
  defineModel({
    id: "uniboshi/kimi-k3-abliterated-v1:free",
    wireFamily: "chat",
    endpoint: NUMES_CHAT_PATH,
    ctx: 1_048_576,
    out: 65_536,
    reasoning: true,
    reasoningEfforts: ["none", "low", "high", "max"],
    toolCall: true,
    vision: true,
    free: true,
    freeTier: true,
  }),
  defineModel({
    id: "z-ai/glm-5.3-flash:free",
    wireFamily: "chat",
    endpoint: NUMES_CHAT_PATH,
    ctx: 1_048_576,
    out: 65_536,
    reasoning: true,
    reasoningEfforts: ["low", "high", "max"],
    toolCall: true,
    vision: true,
    free: true,
    freeTier: true,
  }),
  defineModel({
    id: "z-ai/glm-5.3:free",
    wireFamily: "chat",
    endpoint: NUMES_CHAT_PATH,
    ctx: 262_144,
    out: 65_536,
    reasoning: true,
    reasoningEfforts: ["low", "high", "max"],
    toolCall: true,
    free: true,
    freeTier: true,
  }),
];

/** Reads a nested record field without trusting its shape. */
function recordField(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function positive(value: unknown): number | null {
  return boundedUpstreamNumber(value, { min: 1, max: 1_000_000_000 }) ?? null;
}

/**
 * Live `/api/v1/models` listing.
 *
 * Numes rows nest their capabilities under `architecture` (modalities,
 * `modality` string) and declare limits as `context_length`,
 * `max_input_tokens`, `maximum_output_length` (falling back to
 * `top_provider.max_completion_tokens`). The generic OpenAI reader knows
 * none of those spellings, so this maps the upstream shape directly —
 * including the `:free` suffix that marks zero-price rows and the
 * `reasoning.supported_efforts` ladder.
 *
 * Roster rows win on id so a `:free` row keeps its `free`/`freeTier` flags
 * even though the listing could be read either way.
 */
export async function discoverNumesModels(options: {
  readonly baseUrl: string;
  readonly credential?: string;
  readonly fetcher?: typeof fetch;
}): Promise<readonly ModelDefinition[] | null> {
  const fetcher = options.fetcher ?? fetch;
  const url = `${options.baseUrl.replace(/\/+$/, "")}/models`;
  try {
    const response = await fetcher(url, {
      headers: {
        accept: "application/json",
        ...(options.credential ? { authorization: `Bearer ${options.credential}` } : {}),
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as unknown;
    const entries = boundedUpstreamArray(
      isRecord(payload) ? payload["data"] : Array.isArray(payload) ? payload : null,
    );
    if (!entries) return null;

    const known = new Map(NUMES_DEFAULT_MODELS.map((model) => [model.modelId, model]));
    const byId = new Map<string, ModelDefinition>();
    for (const entry of entries) {
      if (!isRecord(entry)) continue;
      const id = sanitizeUpstreamLabel(entry["id"]);
      if (id === undefined || byId.has(id)) continue;
      const roster = known.get(id);
      if (roster !== undefined) {
        byId.set(id, roster);
        continue;
      }

      const architecture = recordField(entry["architecture"]);
      const inputModalities = boundedUpstreamArray(architecture?.["input_modalities"]) ?? [];
      const hasImage = inputModalities.some(
        (modality) => typeof modality === "string" && modality.toLowerCase().includes("image"),
      );
      const contextWindow =
        positive(entry["context_length"]) ??
        positive(entry["max_input_tokens"]) ??
        200_000;
      const topProvider = recordField(entry["top_provider"]);
      const outputTokens = Math.min(
        positive(entry["maximum_output_length"]) ??
          positive(topProvider?.["max_completion_tokens"]) ??
          65_536,
        contextWindow,
      );
      const reasoningInfo = recordField(entry["reasoning"]);
      const efforts = boundedUpstreamArray(reasoningInfo?.["supported_efforts"])
        ?.map((effort) => sanitizeUpstreamLabel(effort))
        .filter((effort): effort is string => effort !== undefined) ?? [];
      const supportedParameters = boundedUpstreamArray(entry["supported_parameters"]) ?? [];
      const hasTools = supportedParameters.some(
        (parameter) => typeof parameter === "string" && parameter === "tools",
      );
      const isFree = id.endsWith(":free");

      byId.set(
        id,
        defineModel({
          id,
          wireFamily: "chat",
          endpoint: NUMES_CHAT_PATH,
          ctx: contextWindow,
          out: outputTokens,
          reasoning: efforts.length > 0,
          ...(efforts.length > 0 ? { reasoningEfforts: efforts } : {}),
          toolCall: hasTools,
          vision: hasImage,
          free: isFree,
          freeTier: isFree,
        }),
      );
    }
    return [...byId.values()].sort((a, b) => a.modelId.localeCompare(b.modelId));
  } catch {
    return null;
  }
}
