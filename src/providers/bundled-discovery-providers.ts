import type { ProviderModule } from "./provider-registry";
import {
  GENERIC_API_KEY_SPECS,
  VERSIONED_ROOT_API_KEY_SPECS,
} from "./configured-openai-providers";
import { createApiKeyAdapter, type ApiKeyProviderSpec } from "./configured-provider";

/**
 * Providers whose adapter and catalog discovery are the same bearer-auth
 * OpenAI-compatible contract. Providers with static catalogs or additional
 * upstream behavior remain declared beside their special handling.
 */
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
  return {
    groq: discoveryBackedCapabilities("groq", DISCOVERY_BACKED_PROVIDER_SPECS.groq, openAIModelDiscovery),
    together: discoveryBackedCapabilities("together", DISCOVERY_BACKED_PROVIDER_SPECS.together, openAIModelDiscovery),
    deepinfra: discoveryBackedCapabilities("deepinfra", DISCOVERY_BACKED_PROVIDER_SPECS.deepinfra, openAIModelDiscovery),
    siliconflow: discoveryBackedCapabilities("siliconflow", DISCOVERY_BACKED_PROVIDER_SPECS.siliconflow, openAIModelDiscovery),
    siliconflowcn: discoveryBackedCapabilities("siliconflowcn", DISCOVERY_BACKED_PROVIDER_SPECS.siliconflowcn, openAIModelDiscovery),
    novita: discoveryBackedCapabilities("novita", DISCOVERY_BACKED_PROVIDER_SPECS.novita, openAIModelDiscovery),
    larprouter: discoveryBackedCapabilities("larprouter", DISCOVERY_BACKED_PROVIDER_SPECS.larprouter, openAIModelDiscovery),
    venice: discoveryBackedCapabilities("venice", DISCOVERY_BACKED_PROVIDER_SPECS.venice, openAIModelDiscovery),
    nanogpt: discoveryBackedCapabilities("nanogpt", DISCOVERY_BACKED_PROVIDER_SPECS.nanogpt, openAIModelDiscovery),
    baseten: discoveryBackedCapabilities("baseten", DISCOVERY_BACKED_PROVIDER_SPECS.baseten, openAIModelDiscovery),
    synthetic: discoveryBackedCapabilities("synthetic", DISCOVERY_BACKED_PROVIDER_SPECS.synthetic, openAIModelDiscovery),
    stepfun: discoveryBackedCapabilities("stepfun", DISCOVERY_BACKED_PROVIDER_SPECS.stepfun, openAIModelDiscovery),
    sakana: discoveryBackedCapabilities("sakana", DISCOVERY_BACKED_PROVIDER_SPECS.sakana, openAIModelDiscovery),
    helmcode: discoveryBackedCapabilities("helmcode", DISCOVERY_BACKED_PROVIDER_SPECS.helmcode, openAIModelDiscovery),
    coralbricks: discoveryBackedCapabilities("coralbricks", DISCOVERY_BACKED_PROVIDER_SPECS.coralbricks, openAIModelDiscovery),
    aiand: discoveryBackedCapabilities("aiand", DISCOVERY_BACKED_PROVIDER_SPECS.aiand, openAIModelDiscovery),
    wafer: discoveryBackedCapabilities("wafer", DISCOVERY_BACKED_PROVIDER_SPECS.wafer, openAIModelDiscovery),
    firepass: discoveryBackedCapabilities("firepass", DISCOVERY_BACKED_PROVIDER_SPECS.firepass, openAIModelDiscovery),
    zhipucoding: discoveryBackedCapabilities("zhipucoding", DISCOVERY_BACKED_PROVIDER_SPECS.zhipucoding, openAIModelDiscovery),
    dashscope: discoveryBackedCapabilities("dashscope", DISCOVERY_BACKED_PROVIDER_SPECS.dashscope, openAIModelDiscovery),
    qianfan: discoveryBackedCapabilities("qianfan", DISCOVERY_BACKED_PROVIDER_SPECS.qianfan, openAIModelDiscovery),
  };
}
