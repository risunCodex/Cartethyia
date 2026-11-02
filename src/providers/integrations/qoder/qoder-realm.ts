// Qoder realms: one vendor, two unrelated deployments.
//
// `qoder` (global / intl) and `qodercn` (China) share the wire protocol — COSY
// signing, the scrambled body, the enveloped SSE stream — but nothing else
// about the address: different gateway host, different openapi host, different
// OAuth client id, different website, different UA, and a *different model
// roster*. Treating them as one provider with a region flag is what made a CN
// account dispatch to `*.qoder.sh` and be refused.
//
// Everything per-realm lives here so the adapter, the OAuth client, and the
// discovery fetcher cannot drift apart on host, client id, or roster.
//
// Sourced from the donor hub `Public/qoder2api-hub` (`REALM_CONFIGS` in
// `qoder_accounts.py`), which builds every upstream URL from this table.

/** One Qoder deployment. */
export type QoderRealm = "intl" | "cn";

/** Per-realm upstream addresses and client identity. */
export interface QoderRealmConfig {
  /** Inference + model-list gateway host. */
  readonly gateway: string;
  /** Fallback gateway hosts, tried in order after `gateway`. */
  readonly gatewayFallbacks: readonly string[];
  /** Business API host (device token, userinfo, quota). */
  readonly openapi: string;
  /** Where the operator signs in. */
  readonly website: string;
  /** OAuth client id sent on the device-token exchange. */
  readonly clientId: string;
  /** Native redirect the desktop client registers. */
  readonly redirectUri: string;
  /** Upstream-facing User-Agent. */
  readonly userAgent: string;
}

/** Chat + model-list paths, identical across realms. */
export const QODER_CHAT_PATH =
  "/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1";
export const QODER_MODELS_PATH = "/algo/api/v2/model/list?Encode=1";

/**
 * The modern model-server surface used by the IDE / QoderWake (OpenAI-shaped
 * chunks, plain bearer auth). This surface streams immediately and echoes the
 * real model key — the legacy `/algo` chat endpoint answers
 * `10605 isQueued` (parking requests in a server-side queue) and echoes a
 * fixed `"auto"` model. Dispatch tries this surface first, and falls back to
 * legacy COSY only when it refuses the account on entitlement grounds (HTTP
 * 402 / `{"code":116}`) AND the dispatched model is a free-tier row — for a
 * billed model the same code is genuine quota exhaustion and must surface.
 */
export const QODER_IDE_CHAT_PATH = "/model/v1/chat/completions";

/** The model-server host for one realm (intl: `api2-v2`, cn: gateway). */
export function qoderIdeChatUrl(realm: QoderRealm): string {
  return realm === "cn"
    ? `https://gateway.qoder.com.cn${QODER_IDE_CHAT_PATH}`
    : `https://api2-v2.qoder.sh${QODER_IDE_CHAT_PATH}`;
}

/**
 * Realm → deployment.
 *
 * `intl` carries two gateway fallbacks (`api2`, `api3`); `cn` has exactly one
 * host and no resilience, which is upstream fact, not an oversight — the donor
 * loops `gateway + gatewayFallbacks` and gets one candidate for CN.
 */
export const QODER_REALMS: Readonly<Record<QoderRealm, QoderRealmConfig>> = {
  intl: {
    gateway: "https://api1.qoder.sh",
    gatewayFallbacks: ["https://api2.qoder.sh", "https://api3.qoder.sh"],
    openapi: "https://openapi.qoder.sh",
    website: "https://qoder.com",
    clientId: "e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb",
    redirectUri: "qoder://aicoding.aicoding-agent/login-success",
    userAgent: "Qoder/1.1.64",
  },
  cn: {
    gateway: "https://gateway.qoder.com.cn",
    gatewayFallbacks: [],
    openapi: "https://openapi.qoder.com.cn",
    website: "https://qoder.com.cn",
    // 1:1 with the desktop IDE's device flow (`Hfl` in the unpacked worker):
    // the client id the IDE registers for the CN deployment.
    clientId: "e93fe488-5778-4c35-a6fc-0f54ed7b3139",
    redirectUri: "qoder-work-cn://",
    userAgent: "QoderWork/1.1.64",
  },
};

/** The realm one bundled provider id belongs to. */
export function qoderRealmForProvider(providerId: string): QoderRealm {
  return providerId === "qodercn" ? "cn" : "intl";
}

/** Gateway hosts for one realm, primary first. */
export function qoderGatewayCandidates(realm: QoderRealm): readonly string[] {
  const config = QODER_REALMS[realm];
  return [config.gateway, ...config.gatewayFallbacks];
}

/**
 * Inference hosts for one realm, ordered by token kind — mirrors the donor's
 * `qoderInferenceBase` (9router): job tokens (`jt-...`) are served by `api2`
 * and get rejected by `api3` with "Login expired" (403), while device tokens
 * (`dt-...`) and everything else use the ordinary gateway set. CN has a
 * single gateway and serves every token kind.
 */
export function qoderInferenceCandidates(
  realm: QoderRealm,
  token: string | undefined,
): readonly string[] {
  const config = QODER_REALMS[realm];
  if (realm === "cn") return [config.gateway];
  if (token !== undefined && token.startsWith("jt-")) {
    const fallbacks = config.gatewayFallbacks.filter((h) => h !== "https://api2.qoder.sh");
    return ["https://api2.qoder.sh", config.gateway, ...fallbacks];
  }
  return [config.gateway, ...config.gatewayFallbacks];
}

/**
 * Model keys that exist in exactly one realm.
 *
 * From the donor's `INTL_EXCLUSIVE` / `CN_EXCLUSIVE` tables. A request for one
 * of these on the wrong realm does not degrade — it is refused — so the roster
 * each realm publishes is the authority, not a union.
 */
export const QODER_INTL_EXCLUSIVE: ReadonlySet<string> = new Set([
  "fast",
  "efficient",
  "cmodel",
  "smodel",
  "ultimate",
  "performance",
]);

export const QODER_CN_EXCLUSIVE: ReadonlySet<string> = new Set([
  "q37fmodel",
  "gm51model",
]);

/** True when this model key is served only by the other realm. */
export function isForeignQoderModel(realm: QoderRealm, modelId: string): boolean {
  const foreign = realm === "cn" ? QODER_INTL_EXCLUSIVE : QODER_CN_EXCLUSIVE;
  return foreign.has(modelId.trim().toLowerCase());
}
