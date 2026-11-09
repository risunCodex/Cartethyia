import type { ProviderDispatchTarget, ProviderId, ProviderAdapter, ProviderDispatchContext } from "./provider-contracts";
import type { CanonicalRequest, WireFamily } from "../protocol/canonical-model";
import { GatewayError } from "../protocol/gateway-error";
import { OpenAICompatibleAdapter, withBearerAuthentication } from "./adapters/compatible-adapter";
import { providerBaseUrl } from "./provider-metadata";
import type { ProviderModule } from "./provider-registry";

export function ensurePayloadModel(
  payload: Record<string, unknown>,
  candidate: ProviderDispatchTarget,
  providerName: string,
): string {
  const value = payload["model"];
  const model = typeof value === "string" && value.trim() ? value.trim() : candidate.model_id.trim();
  if (!model) throw new GatewayError("invalid_request", 400, `${providerName} model is required (request {requestId}). Check the shape of what you sent — then resend 🪞`);
  payload["model"] = model;
  return model;
}

/**
 * Declarative description of one bearer-authenticated OpenAI-compatible provider.
 *
 * A spec carries data only: identity, wire contract, endpoint paths, and the
 * per-provider hooks the shared factory already supports. `base_url` is
 * resolved from `BUNDLED_PROVIDER_METADATA` via `providerBaseUrl(provider_id)` so a
 * provider's upstream origin has exactly one declaration.
 */
export interface ApiKeyProviderSpec {
  readonly provider_id: ProviderId;
  /**
   * Upstream origin. Defaults to `providerBaseUrl(provider_id)` so a provider's
   * base URL has exactly one declaration; only adapters whose origin differs
   * from the bundled metadata (Cline, Grok Build, …) set it explicitly.
   */
  readonly base_url?: string;
  /** Endpoint path per wire family; families absent here fall back to `BUILTIN_DEFAULT_ENDPOINTS`. */
  readonly endpoint_paths_by_wire_family?: Partial<Record<WireFamily, string>>;
  /** Static headers applied to every dispatch, before `buildExtraHeaders`. */
  readonly extra_headers?: Readonly<Record<string, string>>;
  /**
   * Credential-derived origin override for upstreams that carry per-account
   * state in the path prefix (a plan region, a residency host). Defaults to
   * `base_url`; the resolved value replaces it at transport time only.
   */
  readonly resolveBaseUrl?: (context: ProviderDispatchContext) => string | undefined;
  /** Per-dispatch header hook for providers needing fresh values (correlation IDs, credential-derived auth). */
  readonly buildExtraHeaders?: (
    context: ProviderDispatchContext,
    request?: CanonicalRequest,
    candidate?: ProviderDispatchTarget,
  ) => Record<string, string> | Promise<Record<string, string>>;
  /** `"never"` withholds `Authorization` for genuinely public endpoints (OpenCode Free). */
  readonly credential_forwarding?: "account" | "never";
  /**
   * Opts this provider into the gateway identity (`Cartethyia/<version>` as
   * the upstream `user-agent`). Explicit only: providers with their own
   * first-party identity (Codex, Claude Code) and unprovisioned BYOK rows
   * never get it.
   */
  readonly gatewayUserAgent?: boolean;
  /** `false` drops OpenAI prompt-cache controls from the payload. */
  readonly promptCache?: boolean;
  /** Chat wire field used for the maximum completion token limit. */
  readonly chatTokenLimitField?: "max_tokens" | "max_completion_tokens";
  /** Canonical request hook, applied before wire translation. Use for
   * provider-side request contracts (e.g. OpenCode Free's agent tool
   * fingerprint) so every wire codec serializes the same canonical input.
   * Raw post-serialization fixes belong in `prePayload`, not here. */
  readonly prepareRequest?: (request: CanonicalRequest) => CanonicalRequest;
  /** Final payload mutation, after canonical translation. */
  readonly prePayload?: (
    payload: Record<string, unknown>,
    request: CanonicalRequest,
    candidate: ProviderDispatchTarget,
  ) => void;
}

/** Builds the adapter for one spec; `fetchImpl` is the transport seam. */
export function createApiKeyAdapter(
  spec: ApiKeyProviderSpec,
  fetchImpl?: typeof fetch,
): ProviderAdapter {
  return new OpenAICompatibleAdapter(
    withBearerAuthentication({
      provider_id: spec.provider_id,
      base_url: spec.base_url ?? providerBaseUrl(spec.provider_id),
      endpoint_paths_by_wire_family: spec.endpoint_paths_by_wire_family ?? {},
      ...(spec.extra_headers ? { extra_headers: spec.extra_headers } : {}),
      ...(spec.resolveBaseUrl ? { resolveBaseUrl: spec.resolveBaseUrl } : {}),
      ...(spec.buildExtraHeaders ? { buildExtraHeaders: spec.buildExtraHeaders } : {}),
      ...(spec.credential_forwarding ? { credential_forwarding: spec.credential_forwarding } : {}),
      ...(spec.promptCache === false ? { supports_prompt_caching: false } : {}),
      ...(spec.chatTokenLimitField === undefined
        ? {}
        : { chat_token_limit_field: spec.chatTokenLimitField }),
      ...(spec.prepareRequest ? { prepareRequest: spec.prepareRequest } : {}),
      ...(spec.prePayload ? { prePayload: spec.prePayload } : {}),
      ...(fetchImpl ? { fetchImpl } : {}),
      ...(spec.gatewayUserAgent === true ? { gateway_user_agent: true } : {}),
    }),
  );
}

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
 * responses, with endpoint paths declared below the base's version root".
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
} satisfies Readonly<Record<string, ApiKeyProviderSpec>>;

export type GenericApiKeyProviderId = keyof typeof GENERIC_API_KEY_SPECS;

export const GENERIC_API_KEY_PROVIDER_IDS = Object.keys(
  GENERIC_API_KEY_SPECS,
) as readonly GenericApiKeyProviderId[];

/**
 * Ids whose base URL already ends at a version segment.
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

type DiscoveryBackedCapabilities = Pick<
  ProviderModule,
  "endpointPathsByWireFamily" | "loadAdapter" | "loadModelDiscovery"
>;

type ModelDiscoveryFactory = NonNullable<ProviderModule["loadModelDiscovery"]>;
export type OpenAIModelDiscoveryFactory = (
  providerId: string,
  options?: {
    readonly headers?: (credential: string) => Readonly<Record<string, string>>;
  },
) => ModelDiscoveryFactory;

const DISCOVERY_BACKED_PROVIDER_SPECS = {
  groq: VERSIONED_ROOT_API_KEY_SPECS.groq,
  larprouter: GENERIC_API_KEY_SPECS.larprouter,
  together: GENERIC_API_KEY_SPECS.together,
  deepinfra: VERSIONED_ROOT_API_KEY_SPECS.deepinfra,
  siliconflow: GENERIC_API_KEY_SPECS.siliconflow,
  siliconflowcn: GENERIC_API_KEY_SPECS.siliconflowcn,
  novita: VERSIONED_ROOT_API_KEY_SPECS.novita,
  venice: VERSIONED_ROOT_API_KEY_SPECS.venice,
  nanogpt: GENERIC_API_KEY_SPECS.nanogpt,
  baseten: GENERIC_API_KEY_SPECS.baseten,
  synthetic: GENERIC_API_KEY_SPECS.synthetic,
  stepfun: GENERIC_API_KEY_SPECS.stepfun,
  sakana: GENERIC_API_KEY_SPECS.sakana,
  helmcode: GENERIC_API_KEY_SPECS.helmcode,
  coralbricks: GENERIC_API_KEY_SPECS.coralbricks,
  aiand: GENERIC_API_KEY_SPECS.aiand,
  wafer: GENERIC_API_KEY_SPECS.wafer,
  firepass: VERSIONED_ROOT_API_KEY_SPECS.firepass,
  zhipucoding: VERSIONED_ROOT_API_KEY_SPECS.zhipucoding,
  dashscope: GENERIC_API_KEY_SPECS.dashscope,
  qianfan: VERSIONED_ROOT_API_KEY_SPECS.qianfan,
} satisfies Readonly<Record<string, ApiKeyProviderSpec>>;

type DiscoveryBackedProviderId = keyof typeof DISCOVERY_BACKED_PROVIDER_SPECS;

/** Canonical discovery-backed provider ids, in declaration order. */
export const DISCOVERY_BACKED_PROVIDER_IDS = Object.keys(
  DISCOVERY_BACKED_PROVIDER_SPECS,
) as readonly DiscoveryBackedProviderId[];

export function discoveryBackedCapabilities(
  providerId: string,
  spec: ApiKeyProviderSpec,
  openAIModelDiscovery: OpenAIModelDiscoveryFactory,
): DiscoveryBackedCapabilities {
  return {
    ...(spec.endpoint_paths_by_wire_family === undefined
      ? {}
      : { endpointPathsByWireFamily: spec.endpoint_paths_by_wire_family }),
    loadAdapter: async () => createApiKeyAdapter(spec),
    loadModelDiscovery: openAIModelDiscovery(providerId, {
      headers: (credential) => ({ authorization: `Bearer ${credential}` }),
    }),
  };
}

/**
 * Creates the standard provider capability table using the registry's shared
 * discovery loader, keeping its lazy import and authentication behavior intact.
 */
export function createDiscoveryBackedProviderCapabilities(
  openAIModelDiscovery: OpenAIModelDiscoveryFactory,
): Readonly<Record<DiscoveryBackedProviderId, DiscoveryBackedCapabilities>> {
  const capabilities = {} as Record<DiscoveryBackedProviderId, DiscoveryBackedCapabilities>;
  for (const providerId of DISCOVERY_BACKED_PROVIDER_IDS) {
    capabilities[providerId] = discoveryBackedCapabilities(
      providerId,
      DISCOVERY_BACKED_PROVIDER_SPECS[providerId],
      openAIModelDiscovery,
    );
  }
  return capabilities;
}

