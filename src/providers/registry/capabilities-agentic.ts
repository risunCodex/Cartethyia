// dynamic-import-ok: capability rows for the agent surfaces: Muse, Meta, Kiro, Kimi, Devin, Cursor.
// Each loader is an `async () => (await import("<integration module>"))` closure so a
// provider pays only when the first request routes to it; a static import here would
// drag the integration into memory at process start.
import { discoveryCapability } from "../configured-provider";
import { oauthCapability, quotaCapability } from "../provider-registry";

export const AGENTIC_CAPABILITIES = {
  muse: {
    loadAdapter: async () => (await import("../integrations/muse/muse")).museCodeAdapter,
    loadModels: async () => (await import("../integrations/muse/muse")).MUSE_CODE_MODELS,
    loadAuthentication: oauthCapability(() => import("../integrations/muse/muse-oauth"), "museCodeOAuthClient", { withRefresher: true }),
    loadQuotaCollector: quotaCapability(() => import("../integrations/muse/muse-quota"), "fetchMuseQuota"),
  },
  meta: {
    loadAdapter: async () => (await import("../integrations/meta")).metaAdapter,
    loadModels: async () => (await import("../integrations/meta")).META_MODELS,
    // No `loadAuthentication`: the Model API is a plain API key pasted from the
    // Meta developer dashboard, so the default key-only credential path applies
    // and `probeApiKeyConnectivity` is the account test.
  },
  kiro: {
    loadAdapter: async () => (await import("../integrations/kiro/kiro")).kiroAdapter,
    loadModels: async () => (await import("../integrations/kiro/kiro-catalog")).KIRO_MODELS,
    loadAuthentication: oauthCapability(() => import("../integrations/kiro/kiro-oauth"), "kiroOAuthClient", {
      withRefresher: true,
    }),
    loadQuotaCollector: quotaCapability(() => import("../integrations/kiro/kiro-quota"), "fetchKiroQuota"),
    // Kiro's model list is per-account: which models a credential reaches
    // depends on the plan it is bound to, so discovery needs the credential and
    // the account's region.
    loadModelDiscovery: discoveryCapability(
      () => import("../integrations/kiro/kiro-discovery"),
      (module) => module.fetchKiroModels,
    ),
  },
  kimi: {
    loadAdapter: async () => (await import("../integrations/kimi/kimi")).kimiCodeAdapter,
    loadModels: async () => (await import("../integrations/kimi/kimi")).KIMI_CODE_MODELS,
    loadAuthentication: oauthCapability(() => import("../integrations/kimi/kimi-oauth"), "kimiCodeOAuthClient", { withRefresher: true }),
    loadQuotaCollector: quotaCapability(() => import("../integrations/kimi/kimi-quota"), "fetchKimiQuota"),
  },
  devin: {
    // Devin's chat wire is a Connect-RPC protobuf stream; the path is pinned
    // here so a probe verifies dispatch actually calls it.
    endpointPathsByWireFamily: { chat: "/exa.api_server_pb.ApiServerService/GetChatMessage" },
    loadAdapter: async () => (await import("../integrations/devin/devin")).devinAdapter,
    loadModels: async () => (await import("../integrations/devin/devin-catalog")).DEVIN_MODELS,
    loadAuthentication: oauthCapability(() => import("../integrations/devin/devin-auth"), "devinOAuthClient"),
    loadQuotaCollector: quotaCapability(() => import("../integrations/devin/devin-quota"), "fetchDevinQuota"),
    loadModelDiscovery: discoveryCapability(
      () => import("../integrations/devin/devin-catalog"),
      (module) => module.discoverDevinModels,
    ),
  },
  cursor: {
    // The Run wire is a Connect-RPC bidirectional stream over HTTP/2 (RunSSE
    // plus BidiAppend on the HTTP/1 fallback); the path is pinned here so a
    // probe verifies dispatch actually calls it.
    endpointPathsByWireFamily: { chat: "/agent.v1.AgentService/Run" },
    loadAdapter: async () => (await import("../integrations/cursor/cursor")).cursorAdapter,
    loadModels: async () => (await import("../integrations/cursor/cursor-catalog")).CURSOR_MODELS,
    loadAuthentication: oauthCapability(() => import("../integrations/cursor/cursor-auth"), "cursorOAuthClient", {
      withRefresher: true,
    }),
    loadQuotaCollector: quotaCapability(() => import("../integrations/cursor/cursor-quota"), "fetchCursorQuota"),
    loadModelDiscovery: discoveryCapability(
      () => import("../integrations/cursor/cursor-catalog"),
      (module) => module.discoverCursorModels,
    ),
  },
};
