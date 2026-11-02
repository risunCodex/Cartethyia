import type { ApiKeyProviderSpec } from "./configured-provider";
import type { ProviderId } from "./provider-contracts";

/**
 * The shared spec builder for every builtin bearer-AI provider: "bearer auth
 * against the provider's `BUNDLED_PROVIDER_METADATA` base URL, OpenAI-compatible
 * chat + responses, with the endpoint paths declared *below* the version root".
 *
 * `joinUrl` is plain concatenation and nothing rewrites a declared path, so a
 * base already rooted at a version (`/openai/v1`, `/v1/openai`, `/v3/openai`,
 * `/api/v1`, `/v2`, `/inference/v1`) plus a `/v1/…` path would double the
 * segment and 404 every request. These specs therefore declare the path below
 * the version root — the provider stating the truth about its own wire, not a
 * correction applied to it.
 */
function apiKeySpec(
  providerId: ProviderId,
  paths: Readonly<Partial<Record<"chat" | "responses", string>>>,
): ApiKeyProviderSpec {
  return {
    provider_id: providerId,
    endpoint_paths_by_wire_family: paths,
  };
}

const BEARER_PATHS = { chat: "/chat/completions", responses: "/responses" } as const;

/**
 * Builtin providers whose entire adapter contract is "bearer auth against the
 * provider's `BUNDLED_PROVIDER_METADATA` base URL, OpenAI-compatible chat +
 * responses, with endpoint paths declared below the base's version root". They
 * carry no catalog, no OAuth, and no provider-specific payload hook, so they
 * share one spec shape rather than one module each.
 *
 * `base_url` is resolved per provider by `providerBaseUrl(provider_id)`.
 *
 * These providers list their models through live `/v1/models` discovery rather
 * than a static catalog: every one of them republishes an aggregator's whole
 * roster, which changes faster than a committed array can. Each registry row
 * pairs this spec with `openAIModelDiscovery`.
 *
 * The id list is derived from the spec record so the two cannot drift apart.
 */
export const GENERIC_API_KEY_SPECS = {
  larprouter: apiKeySpec("larprouter", BEARER_PATHS),
  mistral: apiKeySpec("mistral", BEARER_PATHS),
  fireworks: apiKeySpec("fireworks", BEARER_PATHS),
  nvidia: apiKeySpec("nvidia", BEARER_PATHS),
  gmi: apiKeySpec("gmi", BEARER_PATHS),
  ollamacloud: apiKeySpec("ollamacloud", BEARER_PATHS),
  together: apiKeySpec("together", BEARER_PATHS),
  siliconflow: apiKeySpec("siliconflow", BEARER_PATHS),
  siliconflowcn: apiKeySpec("siliconflowcn", BEARER_PATHS),
  nanogpt: apiKeySpec("nanogpt", BEARER_PATHS),
  baseten: apiKeySpec("baseten", BEARER_PATHS),
  synthetic: apiKeySpec("synthetic", BEARER_PATHS),
  stepfun: apiKeySpec("stepfun", BEARER_PATHS),
  sakana: apiKeySpec("sakana", BEARER_PATHS),
  helmcode: apiKeySpec("helmcode", BEARER_PATHS),
  coralbricks: apiKeySpec("coralbricks", BEARER_PATHS),
  aiand: apiKeySpec("aiand", BEARER_PATHS),
  wafer: apiKeySpec("wafer", BEARER_PATHS),
  coreweave: apiKeySpec("coreweave", BEARER_PATHS),
  dashscope: apiKeySpec("dashscope", BEARER_PATHS),
  "qwen-portal": apiKeySpec("qwen-portal", BEARER_PATHS),
  // `deepseek` is intentionally absent: it dispatches on the Anthropic Messages
  // wire at its `/anthropic` root, not the OpenAI chat/responses wires, so it
  // carries a dedicated entry in `default-registry.ts` instead.
  //
  // The aggregators below are absent for a different reason: their base URL is
  // already rooted at a version segment that the `/v1`-prefixed path this shape
  // pins would duplicate (`/openai/v1`, `/v1/openai`, `/v3/openai`, `/api/v1`,
  // `/v2`, and `/inference/v1`), so `joinUrl` would produce
  // `…/v1/v1/chat/completions`. They use the versioned-root spec instead,
  // which pins the path below the version root — the same reason `cerebras`
  // declares `/chat/completions` explicitly.
} satisfies Readonly<Record<string, ApiKeyProviderSpec>>;

/**
 * One id that has both a generic spec and a registry row.
 *
 * Exported so the registry can be checked against the spec list rather than
 * repeating the id as a string: `discoveryBackedProvider` takes this type, so a
 * row naming a provider with no spec is a compile error instead of an
 * `undefined` adapter at first dispatch.
 */
export type GenericApiKeyProviderId = keyof typeof GENERIC_API_KEY_SPECS;

export const GENERIC_API_KEY_PROVIDER_IDS = Object.keys(
  GENERIC_API_KEY_SPECS,
) as readonly GenericApiKeyProviderId[];

/**
 * Ids whose base URL already ends at a version segment.
 *
 * `joinUrl` is plain concatenation and nothing rewrites a declared path, so a
 * base already rooted at a version plus a `/v1/…` path doubles the segment and
 * every request 404s. These specs therefore declare the path *below* the
 * version root. That is the provider stating the truth about its own wire, not
 * a correction applied to it: a wrong path now reaches the operator as the
 * wrong URL instead of being quietly rewritten into a different address.
 *
 * The id list is derived from the spec record so the two cannot drift apart.
 */
export const VERSIONED_ROOT_API_KEY_SPECS = {
  groq: apiKeySpec("groq", BEARER_PATHS),
  deepinfra: apiKeySpec("deepinfra", BEARER_PATHS),
  novita: apiKeySpec("novita", BEARER_PATHS),
  venice: apiKeySpec("venice", BEARER_PATHS),
  qianfan: apiKeySpec("qianfan", BEARER_PATHS),
  zhipucoding: apiKeySpec("zhipucoding", BEARER_PATHS),
  firepass: apiKeySpec("firepass", BEARER_PATHS),
} satisfies Readonly<Record<string, ApiKeyProviderSpec>>;

export type VersionedRootApiKeyProviderId =
  keyof typeof VERSIONED_ROOT_API_KEY_SPECS;

export const VERSIONED_ROOT_API_KEY_PROVIDER_IDS = Object.keys(
  VERSIONED_ROOT_API_KEY_SPECS,
) as readonly VersionedRootApiKeyProviderId[];
