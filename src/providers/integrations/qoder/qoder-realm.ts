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

/** The bundled provider id for the intl deployment. */
export const QODER_PROVIDER_ID = "qoder" as const;

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
  /**
   * Upstream-facing User-Agent for the openapi/business surface. Verified
   * live: the /sash campaign surface accepts plain `Qoder` / `QoderWork`
   * (no version token).
   */
  readonly userAgent: string;
  /**
   * Job-token exchange endpoint for PAT → jt (v1, plain JSON body).
   * Verified live: `POST center.qoder.sh/api/v1/jobToken/exchange` with
   * `{personal_token, machine_id}` returns `{token: jt-…, …}`.
   */
  readonly jobTokenUrl: string;
}

/**
 * User agents on the worker-core wire (capture 2026-11-17, 1.1.86-hotfix.5):
 * every signed call the core sends — chat, poll, region, userinfo — carries
 * `User-Agent: undici` (Electron-hosted Node fetch), except the
 * userinfo/exchange family which sends `qoder/<version>`. The `Bun/1.4.2`
 * UA observed on 2026-11-05 belongs to the separate bun-compiled `qodercli`
 * binary, not to this wire.
 */
export const QODER_UA_APP = "undici";

/** Chat + model-list paths, identical across realms. `Encode=*` per the
 * worker-core capture (2026-11-17): the `*` encoding sends the scramble
 * transform only, without the zstd layer `Encode=1` used on 0.5.7. */
export const QODER_CHAT_PATH =
  "/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=*";
export const QODER_MODELS_PATH = "/algo/api/v2/model/list?Encode=*";

/** The model-server host for one realm (intl: `api1`, cn: gateway). */
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
    userAgent: "Qoder",
    jobTokenUrl: "https://center.qoder.sh/api/v1/jobToken/exchange",
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
    userAgent: "QoderWork",
    jobTokenUrl: "https://openapi.qoder.com.cn/api/v1/jobToken/exchange",
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
 * `qoderInferenceBase` (donor hub): job tokens (`jt-...`) are served by `api2`
 * and get rejected by `api3` with "Login expired" (403), while device tokens
 * (`dt-...`) and everything else use the ordinary gateway set. The job-token
 * set therefore excludes `api3` entirely; CN has a single gateway and serves
 * every token kind.
 */
export function qoderInferenceCandidates(
  realm: QoderRealm,
  token: string | undefined,
): readonly string[] {
  const config = QODER_REALMS[realm];
  if (realm === "cn") return [config.gateway];
  if (token !== undefined && token.startsWith("jt-")) {
    // api3 rejects job tokens (Login expired, 403); only api2 and api1 can
    // serve them.
    return ["https://api2.qoder.sh", config.gateway];
  }
  return [config.gateway, ...config.gatewayFallbacks];
}
