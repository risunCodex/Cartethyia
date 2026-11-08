// dynamic-import-ok: lazy per-realm capability map. Each buddy regional
// product (cb/cbcn) imports its adapter + oauth + discovery on first use so a
// deployment that only serves one realm never drags the others into memory.
import type { ProviderModuleCapabilities } from "../../provider-registry";
import { oauthCapability, quotaCapability } from "../../provider-registry";

type BuddyProviderId = "cb" | "cbcn";

/**
 * Lazy capability declarations for Buddy's two independently identified
 * regional products.
 */
export const BUDDY_PROVIDER_CAPABILITIES = {
  cb: {
    loadAdapter: async () => (await import("./codebuddy/provider")).createCodeBuddyAdapter(),
    loadModels: async () => (await import("./codebuddy/provider")).CODEBUDDY_MODELS,
    loadModelDiscovery: async () => async ({ credential, fetcher }) =>
      (await import("./codebuddy/provider")).discoverCodeBuddyModels({
        credential,
        ...(fetcher === undefined ? {} : { fetcher }),
      }),
    loadAuthentication: oauthCapability(
      () => import("./codebuddy/oauth"),
      "codeBuddyOAuthClient",
      { withRefresher: true },
    ),
    loadQuotaCollector: quotaCapability(
      () => import("./codebuddy/quota"),
      "fetchCodeBuddyIntlQuota",
    ),
  },
  cbcn: {
    loadAdapter: async () => (await import("./codebuddy/cn-provider")).createCodeBuddyCnAdapter(),
    loadModels: async () => (await import("./codebuddy/cn-provider")).CODEBUDDY_CN_MODELS,
    loadModelDiscovery: async () => async ({ credential, fetcher }) =>
      (await import("./codebuddy/cn-provider")).discoverCodeBuddyCnModels({
        credential,
        ...(fetcher === undefined ? {} : { fetcher }),
      }),
    loadAuthentication: oauthCapability(
      () => import("./codebuddy/oauth"),
      "codeBuddyCnOAuthClient",
      { withRefresher: true },
    ),
    loadQuotaCollector: quotaCapability(
      () => import("./codebuddy/quota"),
      "fetchCodeBuddyCnQuota",
    ),
  },
} satisfies Readonly<Record<BuddyProviderId, ProviderModuleCapabilities>>;
