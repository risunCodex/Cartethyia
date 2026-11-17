// dynamic-import-ok: capability rows for the OAuth-backed coding agents and adjacent providers.
// Each loader is an `async () => (await import("<integration module>"))` closure so a
// provider pays only when the first request routes to it; a static import here would
// drag the integration into memory at process start.
import { createApiKeyAdapter, discoveryCapability, withStaticRosterFallback, type ModelDiscoveryRequest } from "../configured-provider";
import { oauthCapability, quotaCapability } from "../provider-registry";
import { extractJsonCredentialToken, traeDiscovery } from "./capability-helpers";

export const OAUTH_INTEGRATION_CAPABILITIES = {
  cline: {
    loadAdapter: async () => (await import("../integrations/cline/cline")).createClineAdapter(),
    loadModels: async () => (await import("../integrations/cline/cline")).CLINE_MODELS,
    loadAuthentication: oauthCapability(() => import("../integrations/cline/cline-oauth"), "clineOAuthClient", { withRefresher: true }),
    loadQuotaCollector: quotaCapability(() => import("../integrations/cline/cline-quota"), "fetchClineQuota"),
    loadModelDiscovery: discoveryCapability(
      () => import("../integrations/cline/cline"),
      (module) => async ({ credential, fetcher }: ModelDiscoveryRequest) => {
        const transport = fetcher ?? globalThis.fetch;
        // A pass account may use every bucket the roster publishes, including
        // `clinePass` and `clineCloud`; a free account must not have those rows
        // persisted, because dispatching one can only 401. The plan endpoint is
        // the same one the quota collector already reads.
        const pass = credential.length > 0 && (await module.clineAccountHasPass(credential, transport));
        return module.fetchClineRecommendedModels(undefined, pass, transport);
      },
    ),
  },
  kilo: {
    loadAdapter: async () => (await import("../integrations/kilo/kilo")).kiloAdapter,
    loadModels: async () => {
      const spec = await import("../integrations/kilo/kilo");
      return [...spec.KILO_MODELS, ...spec.KILO_FREE_MODELS];
    },
    // No `withRefresher`: Kilo Code has no refresh grant, so this client
    // declares no refresher and the stored token is used exactly as issued.
    // Registering one would make the 401 retry path call a method that always
    // throws, turning a recoverable auth failure into a permanent one.
    loadAuthentication: oauthCapability(() => import("../integrations/kilo/kilo-oauth"), "kiloOAuthClient"),
    loadModelDiscovery: discoveryCapability(
      () => import("../integrations/kilo/kilo-discovery"),
      (module) => module.discoverKiloModels,
    ),
  },
  commandcode: {
    loadAdapter: async () => (await import("../integrations/commandcode/commandcode")).createCommandCodeAdapter(),
    loadModels: async () => (await import("../integrations/commandcode/commandcode")).COMMANDCODE_MODELS,
    // The Provider API publishes the real roster with each model's wire, so the
    // static seed above is the offline floor rather than the catalog.
    loadModelDiscovery: discoveryCapability(
      () => import("../integrations/commandcode/discovery"),
      (module) => module.discoverCommandCodeModels,
    ),
    loadQuotaCollector: quotaCapability(
      () => import("../integrations/commandcode/quota"),
      "fetchCommandCodeQuota",
    ),
  },

  trae: {
    loadAdapter: async () => (await import("../integrations/trae/trae")).createTraeAdapter(),
    loadModels: async () => (await import("../integrations/trae/trae-catalog")).TRAE_INTL_MODELS,
    // A Trae credential is an access/refresh pair and the refresh token is what
    // keeps it alive, so the refresher is registered rather than optional:
    // without it the account dies at first expiry.
    loadAuthentication: oauthCapability(() => import("../integrations/trae/trae-oauth"), "traeOAuthClient", { withRefresher: true }),
    loadQuotaCollector: quotaCapability(() => import("../integrations/trae/trae-quota"), "fetchTraeQuota"),
    // Live model list is intl-unsupported: upstream answers `403 no schema
    // found`, so discovery returning nothing is the truthful result and the
    // static roster above stays authoritative.
    loadModelDiscovery: traeDiscovery("intl", "trae"),
  },
  traecn: {
    loadAdapter: async () => (await import("../integrations/trae/trae")).createTraeCnAdapter(),
    loadModels: async () => (await import("../integrations/trae/trae-catalog")).TRAE_CN_MODELS,
    // The CN client, not the intl one: the exchange runs on the CN account
    // host, and a refresh posted to the intl host is refused.
    loadAuthentication: oauthCapability(() => import("../integrations/trae/trae-oauth"), "traeCnOAuthClient", { withRefresher: true }),
    loadQuotaCollector: quotaCapability(() => import("../integrations/trae/trae-quota"), "fetchTraeCnQuota"),
    loadModelDiscovery: traeDiscovery("cn", "traecn"),
  },
  freepi: {
    loadAdapter: async () => (await import("../integrations/freepi/freepi")).createFreepiAdapter(),
    loadModels: async () => (await import("../integrations/freepi/freepi-catalog")).FREEPI_MODELS,
    // Free-pi login is a GitHub device flow; the issued JWT is the credential.
    loadAuthentication: oauthCapability(() => import("../integrations/freepi/freepi-oauth"), "freepiOAuthClient"),
    loadQuotaCollector: quotaCapability(() => import("../integrations/freepi/freepi-quota"), "fetchFreepiQuota"),
    // Live `/client-version` (Bearer) is the catalog source; the static roster
    // is the offline fallback.
    loadModelDiscovery: async () => withStaticRosterFallback(
      async ({ credential, fetcher }) => {
        if (credential.trim().length === 0 || fetcher === undefined) return null;
        const { discoverFreepiModels } = await import("../integrations/freepi/freepi-discovery");
        return discoverFreepiModels({
          token: extractJsonCredentialToken(credential),
          fetcher,
        });
      },
      async () => (await import("../integrations/freepi/freepi-catalog")).FREEPI_MODELS,
    ),
  },
  perch: {
    loadAdapter: async () => (await import("../integrations/perch/perch")).createPerchAdapter(),
    loadModels: async () => (await import("../integrations/perch/perch-catalog")).PERCH_MODELS,
    // Perch login is Supabase PKCE (Google/GitHub); the session blob
    // (access/refresh token) is the credential, and the CLI refreshes it.
    loadAuthentication: oauthCapability(() => import("../integrations/perch/perch-oauth"), "perchOAuthClient", { withRefresher: true }),
    loadQuotaCollector: quotaCapability(() => import("../integrations/perch/perch-quota"), "fetchPerchQuota"),
    // The hosted API exposes no public model list — Roost tiers are the only
    // surface the CLI accepts, so discovery returns the static roster.
    loadModelDiscovery: async () => async () => {
      const { PERCH_MODELS } = await import("../integrations/perch/perch-catalog");
      return PERCH_MODELS;
    },
  },
  clixad: {
    loadAdapter: async () => createApiKeyAdapter((await import("../integrations/clixad/provider")).CLIXAD_SPEC),
    loadModels: async () => (await import("../integrations/clixad/provider")).CLIXAD_DEFAULT_MODELS,
    // Clixad login is a GitHub device flow; the issued token (adg_...) is the
    // credential. The device flow is the only supported login path.
    loadAuthentication: oauthCapability(() => import("../integrations/clixad/clixad-oauth"), "clixadOAuthClient"),
    loadQuotaCollector: quotaCapability(() => import("../integrations/clixad/clixad-quota"), "fetchClixadQuota"),
    // `/v1/models` is unauthenticated and lists all rows; the static roster
    // carries the live-verified free tier and discovery keeps the list current.
    loadModelDiscovery: async () => withStaticRosterFallback(
      async ({ baseUrl, fetcher }) => {
        if (fetcher === undefined) return null;
        const { discoverClixadModels } = await import("../integrations/clixad/provider");
        return discoverClixadModels({ baseUrl, fetcher });
      },
      async () => (await import("../integrations/clixad/provider")).CLIXAD_DEFAULT_MODELS,
    ),
  },
};
