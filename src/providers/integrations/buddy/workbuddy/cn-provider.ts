// WorkBuddy CN uses the WorkBuddy contract on its China domain.
import { BuddyMediaAdapter } from "../buddy-media";
import type { ProviderAdapter } from "../../../provider-contracts";
import type { DiscoveryInput } from "../../../discovery/discovery-types";
import type { ModelDefinition } from "../../../provider-model-definition";
import { providerBaseUrl } from "../../../provider-metadata";
import { getWorkBuddyCnClientVersion } from "../../../operations/client-versions";
import { BUDDY_CN_MODELS_PATH, fetchBuddyDirectoryModels } from "../buddy-discovery-shared";
import { CODEBUDDY_CN_MODELS } from "../codebuddy/cn-provider";
import { workbuddyPrePayload, WORKBUDDY_SYSTEM_PROMPT } from "./provider";
import { workbuddyAdapterConfig, workbuddyHeaders, WORKBUDDY_CHAT_PATH } from "./shared";

export const WORKBUDDY_CN_PROVIDER_ID = "workbuddycn" as const;
export const WORKBUDDY_CN_DOMAIN = "www.workbuddy.cn" as const;
export const WORKBUDDY_CN_BASE_URL = providerBaseUrl(WORKBUDDY_CN_PROVIDER_ID);

export const WORKBUDDY_CN_MODELS: readonly ModelDefinition[] = [
  ...CODEBUDDY_CN_MODELS
    .filter((model) => model.serviceKind !== "videoGeneration")
    .map((model) => ({
      ...model,
      endpointPath: WORKBUDDY_CHAT_PATH,
    })),
  // Video rows reach the native video route on WorkBuddy's own `/v2` base;
  // leaving the CodeBuddy CN `/videos/generations` path would post to the
  // wrong host segment.
  ...CODEBUDDY_CN_MODELS.filter((model) => model.serviceKind === "videoGeneration").map((model) => ({
    ...model,
    endpointPath: "/v2/videos/generations",
  })),
];

export async function discoverWorkBuddyCnModels(
  input: DiscoveryInput,
): Promise<readonly ModelDefinition[] | null> {
  return fetchBuddyDirectoryModels({
    siteUrl: WORKBUDDY_CN_BASE_URL,
    providerId: WORKBUDDY_CN_PROVIDER_ID,
    credential: input.credential,
    // The CN host answers the `/console/…` directory, exactly like the CodeBuddy
    // CN host does; the international path was inherited from the intl provider
    // and the CN edge answers it with a 500 rather than a 404.
    modelsPath: BUDDY_CN_MODELS_PATH,
    endpoint: WORKBUDDY_CHAT_PATH,
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.fetcher ? { fetcher: input.fetcher } : {}),
  });
}

export function createWorkBuddyCnAdapter(fetchImpl?: typeof fetch): ProviderAdapter {
  return new BuddyMediaAdapter(
    workbuddyAdapterConfig({
      providerId: WORKBUDDY_CN_PROVIDER_ID,
      baseUrl: WORKBUDDY_CN_BASE_URL,
      domain: WORKBUDDY_CN_DOMAIN,
      prePayload: workbuddyPrePayload,
      ...(fetchImpl ? { fetchImpl } : {}),
    }),
    {
      variant: "IDE",
      systemPrompt: WORKBUDDY_SYSTEM_PROMPT,
      baseUrl: WORKBUDDY_CN_BASE_URL,
      buildHeaders: (context) =>
        workbuddyHeaders(context, undefined, WORKBUDDY_CN_DOMAIN, getWorkBuddyCnClientVersion()),
    },
  );
}
