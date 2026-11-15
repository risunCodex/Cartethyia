// dynamic-import-ok: capability rows for the long-tail integrations, from DeepAI through Perplexity.
// Each loader is an `async () => (await import("<integration module>"))` closure so a
// provider pays only when the first request routes to it; a static import here would
// drag the integration into memory at process start.
import { createApiKeyAdapter, discoveryCapability, withStaticRosterFallback, type ModelDiscoveryRequest } from "../configured-provider";
import { oauthCapability, quotaCapability } from "../provider-registry";

export const LONGTAIL_CAPABILITIES = {
  deepai: {
    loadAdapter: async () => createApiKeyAdapter((await import("../integrations/deepai/provider")).DEEPAI_SPEC),
    loadModels: async () => (await import("../integrations/deepai/deepai-catalog")).DEEPAI_DEFAULT_MODELS,
    // DeepAI login is a browser loopback flow; the exchange returns an opaque
    // api_key (the credential). Pasting an api_key is supported via
    // importCredential.
    loadAuthentication: oauthCapability(() => import("../integrations/deepai/deepai-oauth"), "deepAIOAuthClient"),
    loadQuotaCollector: quotaCapability(() => import("../integrations/deepai/deepai-quota"), "fetchDeepAIQuota"),
    // `/deepai_code/models` is unauthenticated; the static roster carries the
    // live-verified free tier and discovery keeps the list current.
    loadModelDiscovery: async () => withStaticRosterFallback(
      async ({ baseUrl, fetcher }) => {
        if (fetcher === undefined) return null;
        const { discoverDeepAIModels } = await import("../integrations/deepai/deepai-catalog");
        return discoverDeepAIModels({ baseUrl, fetcher });
      },
      async () => (await import("../integrations/deepai/deepai-catalog")).DEEPAI_DEFAULT_MODELS,
    ),
  },
  inferhub: {
    loadAdapter: async () => (await import("../integrations/inferhub")).createInferhubAdapter(),
    // Live `/v1/models` is the primary source: the marketplace republishes its
    // whole roster and it moves faster than a committed array can. The static
    // list stays as the offline fallback when the fetch fails.
    loadModels: async () => (await import("../integrations/inferhub")).INFERHUB_MODELS,
    loadModelDiscovery: async () =>
      (await import("../integrations/inferhub")).inferhubModelDiscovery()(),
    loadQuotaCollector: quotaCapability(() => import("../integrations/inferhub"), "fetchInferhubQuota"),
  },
  hermes: {
    loadAdapter: async () => createApiKeyAdapter((await import("../integrations/hermes")).HERMES_SPEC),
    loadModels: async () => (await import("../integrations/hermes")).HERMES_MODELS,
    // Hermes accepts both API keys and the Nous Portal device-code OAuth flow
    // (subscription route). The OAuth client is refreshable.
    loadAuthentication: oauthCapability(() => import("../integrations/hermes/hermes-oauth"), "hermesOAuthClient", { withRefresher: true }),
    // `/v1/models` is open and states each row's real limits, so the free
    // allowance tracks upstream instead of a hand-kept list. The static list
    // above stays as the offline fallback for a fetch that fails.
    loadModelDiscovery: discoveryCapability(
      () => import("../integrations/hermes"),
      (module) => module.discoverHermesFreeModels,
    ),
  },
  inception: {
    // Chat only: Mercury 3 / 2.5 / 2 answer the OpenAI-compatible chat wire.
    // The base is version-rooted (`/v1`), so the path is declared below it.
    endpointPathsByWireFamily: { chat: "/chat/completions" },
    loadAdapter: async () => createApiKeyAdapter((await import("../integrations/inception/provider")).INCEPTION_SPEC),
    loadModels: async () => (await import("../integrations/inception/provider")).INCEPTION_MODELS,
    // The listing is bearer-authenticated and the whole provider is pinned to
    // its free allowance, so every fetched row is stamped free-tier.
    loadModelDiscovery: discoveryCapability(
      () => import("../integrations/inception/provider"),
      (module) => module.discoverInceptionFreeModels,
      ({ baseUrl, credential, fetcher }: ModelDiscoveryRequest) => ({
        baseUrl,
        ...(typeof credential === "string" && credential.trim().length > 0
          ? { credential }
          : {}),
        ...(fetcher === undefined ? {} : { fetcher }),
      }),
    ),
  },
  sensecn: {
    loadAdapter: async () => createApiKeyAdapter((await import("../integrations/sensenova/provider")).SENSENOVA_SPEC),
    loadModels: async () => (await import("../integrations/sensenova/provider")).SENSENOVA_MODELS,
    loadModelDiscovery: discoveryCapability(
      () => import("../integrations/sensenova/provider"),
      (module) => module.discoverSensenovaModels,
      ({ baseUrl, credential, fetcher }: ModelDiscoveryRequest) => ({
        baseUrl,
        providerId: "sensecn",
        ...(typeof credential === "string" && credential.trim().length > 0
          ? { credential }
          : {}),
        ...(fetcher === undefined ? {} : { fetcher }),
      }),
    ),
  },
  senseintl: {
    loadAdapter: async () => createApiKeyAdapter((await import("../integrations/sensenova/provider")).SENSENOVA_INTL_SPEC),
    loadModels: async () => (await import("../integrations/sensenova/provider")).SENSENOVA_INTL_MODELS,
    loadModelDiscovery: discoveryCapability(
      () => import("../integrations/sensenova/provider"),
      (module) => module.discoverSensenovaModels,
      ({ baseUrl, credential, fetcher }: ModelDiscoveryRequest) => ({
        baseUrl,
        providerId: "senseintl",
        ...(typeof credential === "string" && credential.trim().length > 0
          ? { credential }
          : {}),
        ...(fetcher === undefined ? {} : { fetcher }),
      }),
    ),
  },
  openrouter: {
    loadAdapter: async () => createApiKeyAdapter((await import("../integrations/openrouter/provider")).OPENROUTER_SPEC),
    // One dynamic import for both halves: this registry lazy-loads every
    // provider module on first use, so importing the same spec twice would
    // load it twice and hand back two module records for one file.
    loadModels: async () => {
      const spec = await import("../integrations/openrouter/provider");
      return [...spec.OPENROUTER_MODELS, ...spec.OPENROUTER_FREE_MODELS];
    },
    loadModelDiscovery: async () => async (input: ModelDiscoveryRequest) => {
      const spec = await import("../integrations/openrouter/provider");
      // The free tier and the billed catalog are separate registrations: the
      // free fetch is what the model list groups as "Free models (auto)", and
      // discovery merges it with the provider's ordinary listing.
      const [billed, free] = await Promise.all([
        spec.discoverOpenrouterModels(input),
        spec.discoverOpenrouterFreeModels(input),
      ]);
      if (billed === null) return null;
      return [...billed, ...(free ?? [])];
    },
    // No `withRefresher`: the PKCE exchange returns a durable API key rather
    // than an access token, so there is no refresh grant to register. The key
    // is stored as an ordinary credential and forwarded as the bearer, which is
    // why the same adapter serves the pasted-key and signed-in cases.
    loadAuthentication: oauthCapability(() => import("../integrations/openrouter/oauth"), "openrouterOAuthClient"),
  },
  vercel: {
    loadAdapter: async () => createApiKeyAdapter((await import("../integrations/vercel/provider")).VERCEL_SPEC),
    loadModels: async () => (await import("../integrations/vercel/provider")).VERCEL_DEFAULT_MODELS,
    loadModelDiscovery: discoveryCapability(
      () => import("../integrations/vercel/provider"),
      (module) => module.discoverVercelModels,
      ({ baseUrl, credential, fetcher }: ModelDiscoveryRequest) => ({
        baseUrl,
        ...(typeof credential === "string" && credential.trim().length > 0
          ? { credential }
          : {}),
        ...(fetcher === undefined ? {} : { fetcher }),
      }),
    ),
    loadQuotaCollector: quotaCapability(() => import("../integrations/vercel/vercel-quota"), "fetchVercelQuota"),
  },
  xiaomipg: {
    loadAdapter: async () => createApiKeyAdapter((await import("../integrations/xiaomi-mimo/xiaomi")).XIAOMIPG_SPEC),
    loadModels: async () => (await import("../integrations/xiaomi-mimo/xiaomi")).XIAOMI_MODELS,
  },
  xiaomitp: {
    loadAdapter: async () => createApiKeyAdapter((await import("../integrations/xiaomi-mimo/xiaomi")).XIAOMITP_SPEC),
    loadModels: async () => (await import("../integrations/xiaomi-mimo/xiaomi")).XIAOMI_MODELS,
  },
  zcode: {
    loadAdapter: async () => createApiKeyAdapter((await import("../integrations/zcode/provider")).ZCODE_SPEC),
    loadModels: async () => (await import("../integrations/zcode/provider")).ZCODE_MODELS,
    loadModelDiscovery: discoveryCapability(
      () => import("../integrations/zcode/provider"),
      (module) => module.discoverZcodeModels,
    ),
    // No `withRefresher`: the sign-in flow ends by minting a durable API key,
    // and Z.AI publishes no refresh grant for it (`refresh "none"` upstream).
    loadAuthentication: oauthCapability(() => import("../integrations/zcode/oauth"), "zcodeOAuthClient"),
  },
  "zcode-start": {
    // Free plan surface: an Anthropic-Messages endpoint that only accepts the
    // dressed ZCode client request (see the integration). The credential is a
    // ZCode login JWT — pasted, or minted by the sign-in flow below.
    loadAdapter: async () =>
      (await import("../integrations/zcode-start-plan/provider")).createZcodeStartPlanAdapter(),
    loadModels: async () =>
      (await import("../integrations/zcode-start-plan/provider")).ZCODE_START_PLAN_MODELS,
    // The device flow stores the issued ZCode login JWT, not a Coding Plan key.
    loadAuthentication: oauthCapability(
      () => import("../integrations/zcode-start-plan/oauth"),
      "zcodeStartPlanOAuthClient",
    ),
    // Keep each reported entitlement and activation/reset window separate.
    loadQuotaCollector: quotaCapability(
      () => import("../integrations/zcode-start-plan/quota"),
      "fetchZcodeStartPlanQuota",
    ),
  },
  "factory": {
    loadAdapter: async () => (await import("../integrations/factory/factory")).factoryAdapter,
    // Factory publishes no model-listing endpoint — the roster is a client-side
    // registry narrowed per account by feature flags and org policy — so the
    // static catalog is the only list this provider has.
    loadModels: async () => (await import("../integrations/factory/factory-models")).FACTORY_MODELS,
    // WorkOS re-authenticates against the same token endpoint the device flow
    // used, so a real refresh grant exists. Registering no refresher here would
    // make an expired access token a dead account instead of a recoverable one.
    loadAuthentication: oauthCapability(
      () => import("../integrations/factory/factory-oauth"),
      "factoryOAuthClient",
      { withRefresher: true },
    ),
  },
  "cloudflareai": {
    loadAdapter: async () =>
      (await import("../integrations/cloudflareai/cloudflareai")).cloudflareaiAdapter,
    // No `withRefresher`: a gateway token is durable and Cloudflare publishes no
    // refresh grant for it. The client mirrors `access` into the `refresh` slot
    // because `refresh_ciphertext` is NOT NULL, and never presents it anywhere.
    loadAuthentication: oauthCapability(
      () => import("../integrations/cloudflareai/cloudflareai-oauth"),
      "cloudflareaiOAuthClient",
    ),
    // No discovery: the model list lives behind the per-account path segments
    // the credential carries, so a resolver built from the registry base URL
    // would ask the origin for a list no gateway serves. The static roster is
    // the Anthropic route; see `cloudflareai-models.ts`.
    loadModels: async () =>
      (await import("../integrations/cloudflareai/cloudflareai-models")).CLOUDFLAREAI_MODELS,
  },
  "alibabacp": {
    loadAdapter: async () =>
      (await import("../integrations/alibabacp/alibabacp")).alibabacpAdapter,
    // No `withRefresher`, same reason as the gateway token: the plan key is
    // durable and there is no grant to present.
    loadAuthentication: oauthCapability(
      () => import("../integrations/alibabacp/alibabacp-oauth"),
      "alibabacpOAuthClient",
    ),
    // Both plans publish the same model ids on their own hosts, so one static
    // catalog serves either region; which host a key reaches is per-account
    // state in the credential, resolved at dispatch.
    loadModels: async () =>
      (await import("../integrations/alibabacp/alibabacp-models")).ALIBABACP_MODELS,
  },
  perplexity: {
    loadAdapter: async () => (await import("../integrations/perplexity")).createPerplexityAdapter(),
    loadModels: async () => (await import("../integrations/perplexity")).PERPLEXITY_MODELS,
  },
};
