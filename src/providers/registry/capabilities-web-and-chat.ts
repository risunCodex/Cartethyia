// dynamic-import-ok: capability rows for the web-search adapters and the standalone chat providers that follow them.
// Each loader is an `async () => (await import("<integration module>"))` closure so a
// provider pays only when the first request routes to it; a static import here would
// drag the integration into memory at process start.
import { createApiKeyAdapter, discoveryCapability, GENERIC_API_KEY_SPECS } from "../configured-provider";
import { oauthCapability, quotaCapability } from "../provider-registry";
import { openAIModelDiscovery } from "./capability-helpers";

export const WEB_AND_CHAT_CAPABILITIES = {
  // Web-search providers: a `createSearchAdapter` over their spec, and a single
  // `serviceKind: "websearch"` catalog row served by the `/v1/search` route.
  exa: {
    loadAdapter: async () =>
      (await import("../search/search-provider")).createSearchAdapter(
        (await import("../search/search-providers")).SEARCH_PROVIDER_SPECS.exa,
      ),
    loadModels: async () => (await import("../search/search-catalog")).EXA_SEARCH_MODELS,
  },
  parallel: {
    loadAdapter: async () =>
      (await import("../search/search-provider")).createSearchAdapter(
        (await import("../search/search-providers")).SEARCH_PROVIDER_SPECS.parallel,
      ),
    loadModels: async () => (await import("../search/search-catalog")).PARALLEL_SEARCH_MODELS,
  },
  "github": {
    // Chat only. Copilot also serves some SKUs on `/responses`, but those arrive
    // through discovery, which carries its own endpoint path with the wire
    // family it read from `supported_endpoints` — this map is the static floor,
    // and the static catalog is all chat.
    endpointPathsByWireFamily: { chat: "/chat/completions" },
    loadAdapter: async () => (await import("../integrations/github/github")).githubAdapter,
    loadModels: async () => (await import("../integrations/github/github")).GITHUB_MODELS,
    // The Copilot token is short-lived and re-minted from the GitHub token the
    // device flow issued, so this provider registers a real refresher.
    loadAuthentication: oauthCapability(() => import("../integrations/github/github-oauth"), "githubOAuthClient", { withRefresher: true }),
    // The account's own `/models` is authoritative: it names the SKUs the
    // subscription may use and the surface each answers on.
    loadModelDiscovery: discoveryCapability(
      () => import("../integrations/github/github-discovery"),
      (module) => module.discoverGithubModels,
    ),
    loadQuotaCollector: quotaCapability(() => import("../integrations/github/github-quota"), "fetchGithubQuota"),
  },
  ollamacloud: {
    // Only the two families this provider's catalog actually serves. The
    // registry map is what discovery and probing read, so listing `messages`
    // here would resolve a probe onto a wire with no endpoint path and no
    // catalog row behind it.
    endpointPathsByWireFamily: {
      chat: "/chat/completions",
      responses: "/responses",
    },
    loadAdapter: async () => createApiKeyAdapter(GENERIC_API_KEY_SPECS.ollamacloud),
    loadModels: async () => (await import("../integrations/ollamacloud")).OLLAMACLOUD_MODELS,
    loadQuotaCollector: quotaCapability(() => import("../integrations/ollamacloud"), "fetchOllamaQuota"),
    loadModelDiscovery: openAIModelDiscovery("ollamacloud", { headers: (credential) => ({ authorization: `Bearer ${credential}` }) }),
  },
  zro: {
    endpointPathsByWireFamily: { messages: "/v1/messages" },
    loadAdapter: async () => (await import("../integrations/zro/zro")).createZroAdapter(),
    loadModels: async () => (await import("../integrations/zro/zro")).ZRO_MODELS,
    loadQuotaCollector: quotaCapability(() => import("../integrations/zro/zro"), "fetchZroQuota"),
    loadModelDiscovery: async () => (await import("../integrations/zro/zro")).zroModelDiscovery()(),
  },
};
