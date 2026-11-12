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
    loadAdapter: async () => (await import("./codebuddy/index")).createCodeBuddyAdapter(),
    loadModels: async () => (await import("./codebuddy/index")).CODEBUDDY_MODELS,
    loadModelDiscovery: async () => async ({ credential, fetcher }) =>
      (await import("./codebuddy/index")).discoverCodeBuddyModels({
        credential,
        ...(fetcher === undefined ? {} : { fetcher }),
      }),
    loadAuthentication: oauthCapability(
      () => import("./codebuddy/index"),
      "codeBuddyOAuthClient",
      { withRefresher: true },
    ),
    loadQuotaCollector: quotaCapability(
      () => import("./codebuddy/index"),
      "fetchCodeBuddyIntlQuota",
    ),
  },
  cbcn: {
    loadAdapter: async () => (await import("./codebuddy/index")).createCodeBuddyCnAdapter(),
    loadModels: async () => (await import("./codebuddy/index")).CODEBUDDY_CN_MODELS,
    loadModelDiscovery: async () => async ({ credential, fetcher }) =>
      (await import("./codebuddy/index")).discoverCodeBuddyCnModels({
        credential,
        ...(fetcher === undefined ? {} : { fetcher }),
      }),
    loadAuthentication: oauthCapability(
      () => import("./codebuddy/index"),
      "codeBuddyCnOAuthClient",
      { withRefresher: true },
    ),
    loadQuotaCollector: quotaCapability(
      () => import("./codebuddy/index"),
      "fetchCodeBuddyCnQuota",
    ),
  },
} satisfies Readonly<Record<BuddyProviderId, ProviderModuleCapabilities>>;
