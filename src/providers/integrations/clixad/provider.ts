// Clixad provider — TypeScript, Clixad gateway, Bun gateway.
//
// Clixad is an ad-funded terminal coding agent whose gateway
// (`https://clixad.onrender.com`) meters model calls and keeps the account
// balance, free-tier allowance, and ad-reward network server-side. The chat
// surface is OpenAI-compatible (`/v1/chat/completions`) with a bearer token
// (`adg_...`) minted by the GitHub device flow at login; model calls report
// credit accounting in an extra `clixad` envelope.
//
// Verified live 2026-11-11 (evidence ledger:
// `documentation/research/clixad/2026-11-11-clixad-wire.md`):
//   - GET /v1/models            → 200, 14 rows; the five `free: true` rows are
//     served on the daily free tier (120k credits/day) and are the ones seeded
//     below. The remaining rows are billed against the account balance.
//   - POST /v1/chat/completions → 200 stream for all five free models, with
//     `clixad.credits_waived` accounting the free-tier draw.
//   - GET /v1/wallet            → balance + free_tier (daily allowance, turns
//     left per model), the quota source.
//
// The static roster carries the five live-verified free rows so the Free
// Limited section is populated before any fetch. Live discovery keeps the list
// current; the roster rows are preserved when the upstream listing reports the
// same id (the shared reader would otherwise overwrite freeTier/reasoning/tool
// flags with its conservative defaults).

import type { ApiKeyProviderSpec } from "../../configured-provider";
import { fetchOpenAICompatibleModels } from "../../discovery/openai-model-discovery";
import {
  defineModel,
  type ModelDefinition,
} from "../../provider-model-definition";

const CLIXAD_PROVIDER_ID = "clixad" as const;

/** Chat path below the `/v1` base root. */
const CLIXAD_CHAT_PATH = "/chat/completions";

/**
 * Clixad adapter spec: plain bearer, OpenAI-compatible chat.
 *
 * The model call endpoint accepts standard OpenAI fields and streams normally,
 * so the generic API-key adapter serves it.
 *
 * Requests are always gzip-compressed and carry the
 * `application/vnd.clixad.chat+gzip` content type: the edge in front of the
 * gateway answers 403 HTML "Blocked" to large plain-JSON bodies (verified
 * live 2026-11-18 — a ~576KB long-session payload was blocked as plain JSON
 * and accepted gzipped, JSON and SSE alike), matching the CLI/probe encoding.
 */
export const CLIXAD_SPEC: ApiKeyProviderSpec = {
  provider_id: CLIXAD_PROVIDER_ID,
  endpoint_paths_by_wire_family: { chat: CLIXAD_CHAT_PATH },
  request_compression: "gzip",
  extra_headers: { "content-type": "application/vnd.clixad.chat+gzip" },
};

/**
 * Default rows for the Clixad provider (2026-11-11).
 *
 * Every row below was verified live on a fresh account: it streams a reply and
 * draws from the daily free tier (`credits_waived` per call). Context windows
 * and effort ladders come from the upstream's own `/v1/models` listing; token
 * prices are the credits-per-1M figures the upstream publishes, kept here as
 * `cost` for the operator (the tier itself bills zero — `FREE_TIER_COST`).
 */
export const CLIXAD_DEFAULT_MODELS: readonly ModelDefinition[] = [
  defineModel({
    id: "gpt-5-nano",
    wireFamily: "chat",
    endpoint: CLIXAD_CHAT_PATH,
    ctx: 400_000,
    out: 60_000,
    reasoning: true,
    toolCall: true,
    free: true,
    freeTier: true,
    reasoningEfforts: ["minimal", "low", "medium", "high"]
  }),
  defineModel({
    id: "gemini-2.5-flash-lite",
    wireFamily: "chat",
    endpoint: CLIXAD_CHAT_PATH,
    ctx: 1_048_576,
    out: 60_000,
    reasoning: true,
    toolCall: true,
    free: true,
    freeTier: true,
    reasoningEfforts: ["off", "low", "medium", "high"]
  }),
  defineModel({
    id: "claude-haiku-5.5",
    wireFamily: "chat",
    endpoint: CLIXAD_CHAT_PATH,
    ctx: 24_000,
    // The gateway publishes no output cap; clamp under the 24k context so a
    // request can never exceed the endpoint (input + output budget).
    out: 16_000,
    reasoning: true,
    toolCall: true,
    free: true,
    freeTier: true,
    reasoningEfforts: ["off", "low", "medium", "high", "xhigh", "max"]
  }),
  defineModel({
    id: "deepseek-v4.1-flash",
    wireFamily: "chat",
    endpoint: CLIXAD_CHAT_PATH,
    ctx: 1_048_576,
    out: 65_536,
    reasoning: true,
    toolCall: true,
    free: true,
    freeTier: true,
    reasoningEfforts: ["off", "low", "high", "max"]
  }),
  defineModel({
    id: "glm-5.3-flash",
    wireFamily: "chat",
    endpoint: CLIXAD_CHAT_PATH,
    ctx: 1_048_576,
    out: 65_536,
    reasoning: true,
    toolCall: true,
    free: true,
    freeTier: true,
    reasoningEfforts: ["low", "high", "max"]
  }),
  defineModel({
    id: "gemini-3.8-flash",
    wireFamily: "chat",
    endpoint: CLIXAD_CHAT_PATH,
    ctx: 1_048_576,
    out: 65_536,
    reasoning: true,
    toolCall: true,
    free: true,
    freeTier: true,
    reasoningEfforts: ["low", "medium", "high"]
  }),
  defineModel({
    id: "gemini-3.5-flash-lite",
    wireFamily: "chat",
    endpoint: CLIXAD_CHAT_PATH,
    ctx: 1_048_576,
    out: 375_000,
    reasoning: true,
    toolCall: true,
    free: true,
    freeTier: true,
    reasoningEfforts: ["off", "low", "medium", "high", "xhigh", "max"]
  }),
];

/**
 * Live `/v1/models` listing.
 *
 * The listing is unauthenticated (verified live). Every fetched row is kept
 * as the shared reader resolved it, except ids the static roster already knows
 * — those keep the roster row whole so the freeTier/reasoning/tool flags are
 * not overwritten by the listing's conservative defaults.
 */
export async function discoverClixadModels(options: {
  readonly baseUrl: string;
  readonly fetcher?: typeof fetch;
}): Promise<readonly ModelDefinition[] | null> {
  const listed = await fetchOpenAICompatibleModels({
    baseUrl: options.baseUrl,
    providerId: "clixad",
    ...(options.fetcher === undefined ? {} : { fetcher: options.fetcher }),
  });
  if (listed === null) return null;
  const known = new Map(CLIXAD_DEFAULT_MODELS.map((model) => [model.modelId, model]));
  return listed.map((model) => known.get(model.modelId) ?? model);
}
