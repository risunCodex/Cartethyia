// Regions are per-realm constants: `trae` (global / intl) and `traecn`
// (China) share the wire protocol — an `x-ide-token` credential, a
// `model_name` body, an SSE stream — but nothing else about the address:
// different core host, different account/oauth host, different UA, a
// *different authorization scheme*, and a different model roster. Treating
// them as one provider with a region flag is what would send a CN account to
// `*.traeapi.us` and get it refused.
//
// Everything per-realm lives here so the adapter, the auth builder, and the
// discovery fetcher cannot drift apart on host, UA, or version code.

/** One Trae deployment. */
export type TraeRealm = "intl" | "cn";

/** Per-realm upstream addresses, client identity, and auth scheme. */
export interface TraeRealmConfig {
  /** Data-plane host: chat + model list (`/api/ide/v1/*`). */
  readonly core: string;
  /** Fallback core hosts, tried in order after `core`. */
  readonly coreFallbacks: readonly string[];
  /** Business host: CloudIDE OAuth token exchange, entitlement. */
  readonly account: string;
  /** Fallback account hosts. */
  readonly accountFallbacks: readonly string[];
  /** Entitlement / payment host. */
  readonly pay: string;
  /** Growth host (daily check-in credits). CN-only in practice. */
  readonly ug: string;
  /** Upstream-facing User-Agent for the non-chat endpoints. */
  readonly userAgent: string;
  /** Version code sent as `x-ide-version-code`. */
  readonly versionCode: string;
  /** Region tag sent in the request body. */
  readonly region: string;
  /** True when this realm's `/api/ide/v1/model_list` answers. */
  readonly modelListSupported: boolean;
}

/**
 * Chat path, identical across realms.
 *
 * The list endpoint takes a body (`{"type":"chat"}`); upstream posts it, so
 * this is not a bare GET.
 */
export const TRAE_CHAT_PATH = "/api/ide/v1/llm_raw_chat";
export const TRAE_MODEL_LIST_PATH = "/api/ide/v1/model_list";

/**
 * Agent path, serving the IDE picker's roster.
 *
 * A different surface from {@link TRAE_CHAT_PATH}, not a version of it: this
 * one selects models by `config_name` + `config_source` and ignores
 * `model_name` entirely, so the two rosters cannot be merged into one call.
 */
export const TRAE_AGENT_CHAT_PATH = "/api/agent/v3/llm_utils_chat";

/**
 * Resolves which roster the agent surface serves for an account.
 *
 * `solo_agent` holds the picker's chat-capable configs. Other values are
 * either rejected (`solo_coder` is `4001 param is invalid`) or resolve to a
 * different, non-chat set.
 */
export const TRAE_AGENT_FUNCTION = "solo_agent";

/** OAuth / business paths, relative to the realm's `account` host. */
export const TRAE_EXCHANGE_TOKEN_PATH = "/cloudide/api/v3/trae/oauth/ExchangeToken";

/**
 * Endpoints that redeem a PKCE `AuthCode`, tried in order.
 *
 * Distinct from {@link TRAE_EXCHANGE_TOKEN_PATH}, which is the authenticated
 * refresh-token rotation and refuses an `AuthCode` with "Invalid param".
 *
 * The `/trae/api/v3` form is tried first because it is the one that answers:
 * the `/cloudide/api/v3/public` form returns 500 for every input, including a
 * garbage code, with an internal DNS failure (`cloudide.coreservice.apiserver`),
 * so it is kept only as a fallback in case that is repaired.
 *
 * Sourced from the login page's own client (`TraeExchangeTokenV2` and
 * `PublicExchangeToken` in `9839.*.js`).
 */
export const TRAE_AUTH_CODE_EXCHANGE_PATHS: readonly string[] = [
  "/trae/api/v3/oauth/ExchangeToken",
  "/cloudide/api/v3/public/oauth/ExchangeToken",
];
export const TRAE_GET_USER_INFO_PATH = "/cloudide/api/v3/trae/GetUserInfo";

/** Browser-login path on the host `GetLoginGuidance` names. */
export const TRAE_AUTHORIZATION_PATH = "/authorization";

/**
 * Path the login page will accept as `auth_callback_url`.
 *
 * Verified against the live page: it renders the login form only when the
 * callback path is `/authorize`. Any other path — `/callback`, `/auth/callback`,
 * `/`, a trailing slash — is answered with "Login Failed" before the operator
 * gets to sign in, so the gateway's own `/callback` default cannot be used.
 *
 * This gateway serves this on its own configured port and only the path is
 * fixed.
 */
export const TRAE_CALLBACK_PATH = "/authorize";

/**
 * Login-guidance endpoints, tried in order.
 *
 * This is the one Trae OAuth step that is not per-realm: the guidance call is
 * what *discovers* the login host, so asking a realm's own account host would
 * presuppose the answer. Verified live: all three answer 200 and return
 * `Result.LoginHost` (`www.trae.ai`).
 */
export const TRAE_LOGIN_GUIDANCE_URLS: readonly string[] = [
  "https://api.marscode.com/cloudide/api/v3/trae/GetLoginGuidance",
  "https://api.trae.ai/cloudide/api/v3/trae/GetLoginGuidance",
  "https://www.trae.ai/cloudide/api/v3/trae/GetLoginGuidance",
];

/** Usage / entitlement paths, relative to the realm's `pay` host. */
export const TRAE_SESSION_USAGE_PATH = "/api/v1/commercial/get_session_usage";
export const TRAE_ENT_USAGE_PATH = "/trae/api/v1/pay/ide_user_ent_usage";
/**
 * The v2 entitlement path, used by the CN realm.
 *
 * Verified live (2026-11-06): the CN realm answers v2 — v1 lacks the
 * `usage_summary` block there — while the intl realm answers v1 (v2 is a
 * 404 on the intl pay host).
 */
export const TRAE_ENT_USAGE_PATH_V2 = "/trae/api/v2/pay/ide_user_ent_usage";

/**
 * Realm → deployment.
 *
 * `intl` carries two core fallbacks and an account fallback; `cn` has exactly
 * one host per role. That is upstream fact, not an oversight.
 *
 * `modelListSupported` is false for intl: upstream answers
 * `403 no schema found` there, so discovery must not pretend a live fetch
 * succeeded and must fall back to the static roster.
 */
export const TRAE_REALMS: Readonly<Record<TraeRealm, TraeRealmConfig>> = {
  cn: {
    // Resolved dynamically by the client. `api.trae.com.cn` only serves
    // CloudIDE/OAuth/pay — `/api/ide/v1/*` there is a 404.
    core: "https://trae-api-cn.mchost.guru",
    coreFallbacks: [],
    account: "https://api.trae.com.cn",
    accountFallbacks: [],
    pay: "https://api.trae.com.cn",
    // The check-in routes are registered on `api.trae.cn` only; the same path
    // on `api.trae.com.cn` is a 404.
    ug: "https://api.trae.cn",
    userAgent: "Trae CN/3.4.3",
    versionCode: "20260212",
    region: "CN",
    modelListSupported: true,
  },
  intl: {
    // SG is the primary, not a fallback. Region-routing is a property of the
    // account, not the deployment: an account provisioned into `sg` only
    // authenticates against the SG host, and sending it to the US core answers
    // `1001 "we are not able to authenticate you"`. Accounts with a captured
    // region still resolve to their own host through `TRAE_REGION_CORE_HOSTS`,
    // so moving the default only changes the answer for accounts whose region
    // was never recorded — and SG serves the wider international roster, which
    // makes it the better bet for those than US.
    // Inlined rather than read from `TRAE_REGION_CORE_HOSTS` below: that map is
    // declared after this one, and a `const` forward reference throws at module
    // init. The value must stay identical to `TRAE_REGION_CORE_HOSTS.sg`.
    core: "https://coresg-normal.trae.ai",
    // US stays reachable as a fallback: an account that really is US-provisioned
    // but has no stored region still has to have somewhere to land.
    coreFallbacks: ["https://core-normal.traeapi.us", "https://core-normal.trae.ai"],
    account: "https://grow-normal.trae.ai",
    accountFallbacks: ["https://grow-normal.traeapi.us"],
    // SG default, like the core: the pay surface is region-correlated too, and
    // the SG host answers an sg-provisioned (or region-unrecorded intl) account
    // that the US host refuses with 401 code 1001 (verified live 2026-11-06).
    pay: "https://grow-normal.trae.ai",
    ug: "https://grow-normal.traeapi.us",
    userAgent: "Trae/3.6.2",
    versionCode: "20260212",
    region: "US",
    // Verified against an SG account: the region host answers `model_list`.
    modelListSupported: true,
  },
};

/**
 * Data-plane host per account region, when the login reported one.
 *
 * An intl account is provisioned into a region and its token only authenticates
 * against that region's core host. Verified: a `userRegion=sg` account sent to
 * `core-normal.traeapi.us` answers `1001 "we are not able to authenticate you"`,
 * while `coresg-normal.trae.ai` accepts the same token and streams normally.
 * Without this, a correct login produced an account that could never dispatch.
 *
 * `store-country-code` follows the same value: the US host was rejecting the
 * token *and* the roster it serves is a different catalog.
 */
export const TRAE_REGION_CORE_HOSTS: Readonly<Record<string, string>> = {
  sg: "https://coresg-normal.trae.ai",
  us: "https://core-normal.traeapi.us",
};

/**
 * Pay host per account region, when the login reported one.
 *
 * Verified live (2026-11-06): an `sg` account's token is refused by the US
 * pay host with `401 code 1001` ("we are not able to authenticate you"), and
 * accepted by the SG pay host. Same region-routing rule as the core host —
 * the pay surface correlates the credential against its region, so a
 * provisioned region must pick its own pay host too.
 */
export const TRAE_REGION_PAY_HOSTS: Readonly<Record<string, string>> = {
  sg: "https://grow-normal.trae.ai",
  us: "https://grow-normal.traeapi.us",
};

/** The app id is constant across realms. */
export const TRAE_APP_ID = "6eefa01c-1036-4c7e-9ca5-d891f63bfcd8";

/** Plugin channel, constant across realms. */
export const TRAE_PLUGIN_CHANNEL = "icube-ai";

/**
 * Provider id → realm.
 *
 * CN is a separate provider id rather than a flag on `trae`, matching
 * `qodercn`/`cbcn`: the two deployments share no host, no OAuth client, and no
 * model roster, so a single provider could not describe either one.
 */
export function traeRealmForProvider(providerId: string): TraeRealm {
  return providerId === "traecn" ? "cn" : "intl";
}

/** Data-plane host candidates in failover order: primary first, then fallbacks. */
export function traeCoreCandidates(realm: TraeRealm): readonly string[] {
  const config = TRAE_REALMS[realm];
  return [config.core, ...config.coreFallbacks];
}

/** Business host candidates in failover order. */
export function traeAccountCandidates(realm: TraeRealm): readonly string[] {
  const config = TRAE_REALMS[realm];
  return [config.account, ...config.accountFallbacks];
}
