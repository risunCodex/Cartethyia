// Runcrate provider — TypeScript, Runcrate inference gateway, Bun gateway.
//
// Runcrate (runcrate.ai) is an inference marketplace + GPU platform whose
// Models API is OpenAI-compatible (`https://api.runcrate.ai/v1`) with an
// Anthropic-compatible Messages wire on the same base. Model ids are
// `author/Name` HuggingFace-style slugs; the catalog publishes rich rows
// (`context_length`, `max_output_length`, `input_modalities`,
// `supported_features`, `pricing`).
//
// Free tier: five open models serve a **weekly workspace allowance** that
// resets Monday (`runcrate.ai/inference/free`) — DeepSeek V4.1 Flash, GLM 5.3
// Flash, GLM 5.3, gpt-oss 120B, Qwen3.8 Flash. Free usage is billed at zero
// and never draws credit; when it runs out without credit the upstream
// answers `free_allowance_used`. Verified live 2026-11-18: chat 200 with
// `usage.cost: 0`, tool calling 200 (`finish_reason: tool_calls`), catalog
// 120 rows.
//
// The static roster carries those five rows (free + freeTier) so the Free
// Limited section is populated before any fetch; live discovery returns the
// full catalog so an operator can add a paid model by hand. Roster rows win
// on id so the free flags survive discovery.
import type { ApiKeyProviderSpec } from "../../configured-provider";
import { defineModel, type ModelDefinition } from "../../provider-model-definition";
import { isRecord } from "../../../protocol/codecs";
import { boundedUpstreamArray, boundedUpstreamNumber, sanitizeUpstreamLabel } from "../../provider-sanitize";

const RUNCRATE_PROVIDER_ID = "runcrate" as const;

/** Chat path below the `/v1` base root. */
const RUNCRATE_CHAT_PATH = "/chat/completions";
/** Anthropic-compatible Messages path on the same base (verified live). */
const RUNCRATE_MESSAGES_PATH = "/messages";

/**
 * Runcrate adapter spec: plain bearer, OpenAI-compatible chat, plus the
 * Anthropic Messages wire the same base serves.
 */
export const RUNCRATE_SPEC: ApiKeyProviderSpec = {
  provider_id: RUNCRATE_PROVIDER_ID,
  endpoint_paths_by_wire_family: {
    chat: RUNCRATE_CHAT_PATH,
    messages: RUNCRATE_MESSAGES_PATH,
  },
};

/**
 * The five free-tier rows (live-verified 2026-11-18): ids, windows, and
 * capabilities come from the key-visible `/v1/models` catalog; `free` +
 * `freeTier` from the free-inference page (weekly workspace allowance,
 * zero-cost).
 */
export const RUNCRATE_DEFAULT_MODELS: readonly ModelDefinition[] = [
  defineModel({
    id: "deepseek-ai/DeepSeek-V4.1-Flash",
    wireFamily: "chat",
    endpoint: RUNCRATE_CHAT_PATH,
    ctx: 1_048_576,
    out: 1_048_576,
    reasoning: true,
    reasoningEfforts: ["none", "low", "medium", "high", "max"],
    toolCall: true,
    vision: true,
    free: true,
    freeTier: true,
  }),
  defineModel({
    id: "zai-org/GLM-5.3-Flash",
    wireFamily: "chat",
    endpoint: RUNCRATE_CHAT_PATH,
    ctx: 1_048_576,
    out: 1_048_576,
    reasoning: true,
    reasoningEfforts: ["low", "high", "max"],
    toolCall: true,
    vision: true,
    free: true,
    freeTier: true,
  }),
  defineModel({
    id: "zai-org/GLM-5.3",
    wireFamily: "chat",
    endpoint: RUNCRATE_CHAT_PATH,
    ctx: 1_048_576,
    out: 1_048_576,
    reasoning: true,
    reasoningEfforts: ["low", "high", "max"],
    toolCall: true,
    free: true,
    freeTier: true,
  }),
  defineModel({
    id: "openai/gpt-oss-120b",
    wireFamily: "chat",
    endpoint: RUNCRATE_CHAT_PATH,
    ctx: 131_072,
    out: 117_964,
    reasoning: true,
    toolCall: true,
    free: true,
    freeTier: true,
  }),
  defineModel({
    id: "Qwen/Qwen3.8-Flash",
    wireFamily: "chat",
    endpoint: RUNCRATE_CHAT_PATH,
    ctx: 1_000_000,
    out: 1_000_000,
    reasoning: true,
    toolCall: true,
    free: true,
    freeTier: true,
  }),
];

function positive(value: unknown): number | null {
  return boundedUpstreamNumber(value, { min: 1, max: 1_000_000_000 }) ?? null;
}

/**
 * Live `/v1/models` listing (Bearer).
 *
 * Runcrate rows are flat and honest: `context_length`/`max_output_length`
 * for windows, `input_modalities` for vision, `supported_features` for
 * tools/reasoning. The generic OpenAI reader knows none of those spellings,
 * so the upstream shape is mapped directly; roster rows win on id so a free
 * row keeps its `free`/`freeTier` flags.
 */
export async function discoverRuncrateModels(options: {
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

    const known = new Map(RUNCRATE_DEFAULT_MODELS.map((model) => [model.modelId, model]));
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
      const inputModalities = boundedUpstreamArray(entry["input_modalities"]) ?? [];
      const hasImage = inputModalities.some(
        (modality) => typeof modality === "string" && modality.toLowerCase().includes("image"),
      );
      const features = boundedUpstreamArray(entry["supported_features"]) ?? [];
      const hasTools = features.some(
        (feature) => typeof feature === "string" && feature === "tools",
      );
      const hasReasoning = features.some(
        (feature) => typeof feature === "string" && feature === "reasoning",
      );
      const contextWindow = positive(entry["context_length"]) ?? 200_000;
      const outputTokens = Math.min(
        positive(entry["max_output_length"]) ?? 65_536,
        contextWindow,
      );
      // Free flags never come from the listing: Runcrate's free tier is a
      // workspace allowance on five fixed ids, not a suffix — the roster
      // rows above are what carries them.
      byId.set(
        id,
        defineModel({
          id,
          wireFamily: "chat",
          endpoint: RUNCRATE_CHAT_PATH,
          ctx: contextWindow,
          out: outputTokens,
          reasoning: hasReasoning,
          toolCall: hasTools,
          vision: hasImage,
        }),
      );
    }
    return [...byId.values()].sort((a, b) => a.modelId.localeCompare(b.modelId));
  } catch {
    return null;
  }
}
