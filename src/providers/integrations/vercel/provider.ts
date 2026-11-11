// Vercel AI Gateway provider — TypeScript, Vercel AI Gateway, Bun gateway.
//
// Vercel AI Gateway is an OpenAI-compatible routing front for 500+ models
// across providers. The API key (`vck_...`) is bearer-authenticated against
// `https://ai-gateway.vercel.sh/v1`.
//
// Verified live 2026-11-11 with a free-tier key:
//   - GET /v1/models            → 200, 506 rows (OpenRouter-shaped list)
//   - POST /v1/chat/completions → 200 for nvidia/nemotron-3.5-lightning-free
//   - POST /v1/chat/completions → 403 `no_providers_available` for the other
//     zero-priced rows (reflection/beam*, humansand/ampersand-v0.1,
//     stealth/glyph-cluster) — listed at $0 but gated behind a paid/Pro plan.
//   - GET /v1/credits           → { balance, token_pass, total_used }
//
// The static roster below carries the five $0-priced rows, so the free section
// is populated before any fetch. Four of them are marked `proOnly` because the
// upstream refuses them on a free plan (verified live); discovery still finds
// them and the badge tracks the upstream's own listing.

import type { ApiKeyProviderSpec } from "../../configured-provider";
import { fetchOpenAICompatibleModels } from "../../discovery/openai-model-discovery";
import { defineModel, type ModelDefinition } from "../../provider-model-definition";

const VERCEL_PROVIDER_ID = "vercel" as const;

/** Chat path below the `/v1` base root. */
const VERCEL_CHAT_PATH = "/chat/completions";

/**
 * Vercel AI Gateway adapter spec: plain bearer, OpenAI-compatible chat.
 *
 * The gateway accepts standard OpenAI fields (`max_tokens`, `temperature`,
 * `stop`, `tools`, `tool_choice`, `reasoning`, `response_format`, …) and
 * reports usage/cost in extended `provider_metadata`. No bespoke headers are
 * required beyond the bearer, so the generic API-key adapter serves it.
 */
export const VERCEL_SPEC: ApiKeyProviderSpec = {
  provider_id: VERCEL_PROVIDER_ID,
  endpoint_paths_by_wire_family: {},
};

/**
 * Default rows for the Vercel AI Gateway provider (2026-11-11).
 *
 * Verified live with a free-tier key: only
 * `nvidia/nemotron-3.5-lightning-free` is served on a free plan; the other
 * zero-priced listing rows are refused with 403 `no_providers_available`, so
 * they are not seeded. The two billed rows (`meituan/longcat-2.5`,
 * `inception/mercury-3`) are the operator's picks and carry the capabilities
 * the upstream itself declares — LongCat is the vision-capable coding row,
 * Mercury 3 is the diffusion row. Everything else comes from live discovery.
 */
export const VERCEL_DEFAULT_MODELS: readonly ModelDefinition[] = [
  defineModel({
    id: "nvidia/nemotron-3.5-lightning-free",
    wireFamily: "chat",
    endpoint: VERCEL_CHAT_PATH,
    ctx: 1_000_000,
    out: 65_000,
    reasoning: true,
    toolCall: true,
    free: true,
    freeTier: true,
  }),
  defineModel({
    id: "meituan/longcat-2.5",
    wireFamily: "chat",
    endpoint: VERCEL_CHAT_PATH,
    ctx: 1_048_576,
    out: 131_072,
    vision: true,
    reasoning: true,
    toolCall: true,
  }),
  defineModel({
    id: "inception/mercury-3",
    wireFamily: "chat",
    endpoint: VERCEL_CHAT_PATH,
    ctx: 1_000_000,
    out: 131_072,
    reasoning: true,
    toolCall: true,
  }),
];

/**
 * Live `/v1/models` listing.
 *
 * The listing requires the API key, so the credential is forwarded when
 * present; an unauthenticated fetch fails cleanly and the static roster stays
 * authoritative. Every fetched row is kept as the shared reader resolved it
 * (limits/modalities/reasoning/tool flags come from the upstream's own JSON).
 *
 * A fetched id the static roster already knows keeps the roster row whole, not
 * the listing's fields: the upstream does not publish `reasoning`/`tool_call`
 * keys or tier flags, so the shared reader would overwrite the roster's
 * reasoning/tool/freeTier/proOnly statements with its conservative defaults.
 * The roster is the canonical metadata for the models we know; the listing only
 * adds genuinely new ids.
 */
export async function discoverVercelModels(options: {
  readonly baseUrl: string;
  readonly credential?: string;
  readonly fetcher?: typeof fetch;
}): Promise<readonly ModelDefinition[] | null> {
  const listed = await fetchOpenAICompatibleModels({
    baseUrl: options.baseUrl,
    providerId: "vercel",
    ...(typeof options.credential === "string" && options.credential.trim().length > 0
      ? { headers: { authorization: `Bearer ${options.credential}` } }
      : {}),
    ...(options.fetcher === undefined ? {} : { fetcher: options.fetcher }),
  });
  if (listed === null) return null;
  const known = new Map(VERCEL_DEFAULT_MODELS.map((model) => [model.modelId, model]));
  return listed.map((model) => known.get(model.modelId) ?? model);
}
