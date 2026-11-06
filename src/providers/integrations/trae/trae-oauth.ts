// Trae credential login and refresh.
//
// Trae has a real browser authorization flow, just not a device-code one: an
// earlier probe of the device-authorization surface answered `unsupported`,
// which is what led to the earlier claim that Trae had no OAuth login at all.
// The browser path is `GetLoginGuidance` (discovers the login host) → the
// operator signs in at `/authorization` → the callback carries a refresh token
// → `ExchangeToken` redeems it → `GetUserInfo` names the account.
//
// A pasted credential (a PAT — which *is* a refresh token — or a desktop
// export) still enters through `importCredential`, so both doors are open.
//
// The exchange is `POST /cloudide/api/v3/trae/oauth/ExchangeToken` with a fixed
// client id. Upstream's client secret is the literal string `"-"`, which is
// upstream fact rather than a placeholder we failed to fill.
//
// Rotation is the rule that shapes the return value: every exchange returns a
// NEW refresh token and invalidates the one sent. A refresh that persisted only
// the access token would leave the account holding a dead refresh token and
// unrecoverable on its next expiry.

import { randomUUID } from "node:crypto";
import { firstNonEmptyString as firstString } from "../../../shared/coerce";
import { OAuthClient } from "../../authentication/oauth-client";
import type { OAuthExchangeResult, OAuthImportInput } from "../../authentication/oauth-flow-store";
import type { OAuthTokenRefreshResult } from "../../authentication/oauth-refresh-service";
import {
  TRAE_AUTHORIZATION_PATH,
  TRAE_CALLBACK_PATH,
  TRAE_EXCHANGE_TOKEN_PATH,
  TRAE_GET_USER_INFO_PATH,
  TRAE_LOGIN_GUIDANCE_URLS,
  TRAE_AUTH_CODE_EXCHANGE_PATHS,
  traeAccountCandidates,
  type TraeRealm,
} from "./trae-realm";
import { TRAE_DEVICE_BRAND, TRAE_OS_VERSION, traeDeviceIdentity } from "./trae-headers";
import { getTraeVersion } from "../../operations/client-versions";
import { browserAuthorizeRedirectUri } from "../../../config/providers";

/** Upstream client id. Constant across realms. */
const TRAE_CLIENT_ID = "ono9krqynydwx5";

/** UA for the login steps, distinct from the data-plane UA. */
const TRAE_OAUTH_USER_AGENT = "Trae/1.0.0 antigravity-cockpit-tools";

/**
 * Plugin version the desktop client reports.
 *
 * Observed in a real authorize URL as `2.3.93439`. The web build reports
 * `local`; the login page accepts it, but the value is part of the fingerprint
 * upstream correlates, so the desktop shape is used here.
 */
const TRAE_PLUGIN_VERSION = "2.3.93439";

/**
 * Device context for the login.
 *
 * Derived with the same function the data plane uses, so one account presents
 * one device across login and requests. A per-process random pair would make
 * every gateway restart look like a brand new device to the risk-control
 * surface that correlates them.
 *
 * The seed is the login trace id because no account identity exists yet: the
 * authorize step is what produces the account.
 */
function traeLoginDevice(traceId: string): { machineId: string; deviceId: string } {
  return traeDeviceIdentity(traceId);
}

/**
 * Upstream client secret.
 *
 * Literally `"-"` as the desktop client sends it. Not a missing value.
 */
const TRAE_CLIENT_SECRET = "-";

/**
 * Response envelope: the payload is nested under `Result`, and the error
 * carries `Code`/`Message` at the top level.
 */
interface TraeExchangeResult {
  readonly Token?: string;
  readonly RefreshToken?: string;
  /** Access-token expiry, epoch milliseconds. */
  readonly TokenExpireAt?: number;
  /** Refresh-token expiry, epoch milliseconds. */
  readonly RefreshExpireAt?: number;
  readonly TokenExpireDuration?: number;
  readonly UserJwt?: string;
}

interface TraeExchangeResponse extends TraeExchangeResult {
  readonly Result?: TraeExchangeResult;
  readonly Code?: string | number;
  readonly Message?: string;
}

export class TraeOAuthClient extends OAuthClient {
  /**
   * Trae has no device-code flow — an earlier probe of the device-authorization
   * surface answered `unsupported` for it — but it does have a browser
   * authorization flow: `GetLoginGuidance` discovers the login host, the
   * operator signs in there, and the callback carries a refresh token that
   * `ExchangeToken` redeems.
   *
   * Declaring only the browser half is what keeps the console from offering a
   * device login that cannot work.
   */
  override readonly supportsDeviceCode = false;
  override readonly supportsBrowserCode = true;

  /**
   * The login page only accepts `/authorize` as the callback path (see
   * `TRAE_CALLBACK_PATH`); the gateway-wide default is `/callback`, which it
   * answers with "Login Failed" before consent. The port still comes from the
   * gateway's own redirect setting so a deployment can move it.
   */
  override readonly browserRedirectUri: string = withTraeCallbackPath(browserAuthorizeRedirectUri());

  protected override readonly providerLabel = "Trae";
  protected override readonly clientId = TRAE_CLIENT_ID;
  /** The exchange is per-realm: CN and intl use different account hosts. */
  protected override readonly tokenUrl = "";
  protected override readonly scopes = "";
  /**
   * Resolved at authorize time by `GetLoginGuidance` rather than pinned: the
   * login host is an upstream discovery, and hard-coding the one observed today
   * would break the day upstream moves it.
   */
  protected override readonly authorizeUrl = "";

  private readonly realm: TraeRealm;

  constructor(fetchFn: typeof fetch = globalThis.fetch, realm: TraeRealm = "intl") {
    super(fetchFn);
    this.realm = realm;
  }

  /**
   * Resolves the login host before the authorize URL is built.
   *
   * The base `buildAuthorizeUrl` is synchronous and needs a static
   * `authorizeUrl`, neither of which fits a host that upstream hands out per
   * login. Resolving it here — the async step the console awaits before it
   * builds the URL — and passing it on in `parameters` keeps the URL builder
   * synchronous without pinning a host that can move.
   */
  async prepareAuthorize(request: {
    readonly state: string;
    readonly codeChallenge: string;
    readonly redirectUri: string;
    readonly parameters?: Readonly<Record<string, string>>;
  }): Promise<{ readonly state: string; readonly codeChallenge: string; readonly redirectUri: string; readonly parameters?: Readonly<Record<string, string>> }> {
    /**
     * `login_trace_id` is a UUID, not the flow state.
     *
     * Upstream's page validates it as one — a base64url state (what the console
     * generates) is not accepted. The flow state still has to reach the
     * callback to match it to a pending login, so it rides along in
     * `parameters` and is appended to the redirect as a query parameter.
     */
    const traceId = randomUUID();
    const host = await this.loginHost(traceId);
    return {
      ...request,
      parameters: { ...(request.parameters ?? {}), loginHost: host, loginTraceId: traceId },
    };
  }

  /**
   * Builds the URL the operator opens to sign in.
   *
   * `state` carries the login trace id, so the callback can be matched to the
   * browser session that produced it.
   */
  override buildAuthorizeUrl(request: {
    readonly state: string;
    readonly codeChallenge?: string;
    readonly redirectUri: string;
    readonly parameters?: Readonly<Record<string, string>>;
  }): string {
    const host = request.parameters?.["loginHost"];
    if (host === undefined) {
      throw new Error("Trae login host is not resolved — the authorize step must run first");
    }
    /**
     * The trace id is the flow `state`, not a fresh UUID: the login page echoes
     * it back on the callback, and that echo is what the loopback listener
     * matches the pending flow against. A separate random trace id would leave
     * the callback with no correlation key.
     */
    const traceId = request.parameters?.["loginTraceId"] ?? request.state;
    const device = traeLoginDevice(traceId);
    const url = new URL(host.startsWith("http") ? host : `https://${host.replace(/^\/+/, "")}`);
    url.pathname = TRAE_AUTHORIZATION_PATH;
    /**
     * Parameter set mirrored from a real client authorize URL. Three of these
     * were missing and are not decoration:
     *
     * - `channel_name`: selects the desktop distribution channel; without it
     *   the page falls back to a build that does not hand back a refresh token.
     *
     * `code_challenge`/`code_challenge_method` are deliberately ABSENT. The page
     * branches on them: with PKCE it mints an `AuthCode` via `GetPCAuthCode`,
     * and that code is an opaque ticket for another client — nothing redeems it
     * back into a token pair (verified: the PKCE pair matched, and every
     * exchange endpoint answered "Invalid param"). Without them it sends a
     * refresh token, which this gateway can rotate.
     * - the device fields: the login is correlated with the data-plane
     *   fingerprint, so an `unknown`/`0` set is a device upstream has never
     *   seen from this account.
     */
    const params = new URLSearchParams({
      login_version: "1",
      auth_from: "trae",
      login_channel: "native_ide",
      plugin_version: TRAE_PLUGIN_VERSION,
      auth_type: "local",
      client_id: TRAE_CLIENT_ID,
      redirect: "0",
      login_trace_id: traceId,
      auth_callback_url: request.redirectUri,
      machine_id: device.machineId,
      device_id: device.deviceId,
      x_device_id: device.deviceId,
      x_machine_id: device.machineId,
      x_device_brand: TRAE_DEVICE_BRAND,
      x_device_type: "windows",
      x_os_version: TRAE_OS_VERSION,
      x_env: "",
      x_app_version: getTraeVersion(),
      x_app_type: "stable",
      channel_name: "common",
    });
    url.search = params.toString();
    return url.toString();
  }

  /**
   * Asks upstream where to sign in.
   *
   * Tried in order across the known guidance hosts: the call is what discovers
   * the login host, so it cannot be scoped to one realm's account host.
   */
  private async loginHost(loginTraceId: string): Promise<string> {
    const body = JSON.stringify({ loginTraceID: loginTraceId, login_trace_id: loginTraceId });
    let lastError = "no successful response";
    for (const url of TRAE_LOGIN_GUIDANCE_URLS) {
      try {
        const response = await this.fetchFn(url, {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            "User-Agent": TRAE_OAUTH_USER_AGENT,
          },
          body,
        });
        if (!response.ok) {
          lastError = `${url} HTTP ${response.status}`;
          continue;
        }
        const data = (await response.json()) as { Result?: { LoginHost?: unknown } };
        const host = data.Result?.LoginHost;
        if (typeof host === "string" && host.length > 0) return host;
        lastError = `${url} missing LoginHost`;
      } catch (err: unknown) {
        lastError = `${url} ${err instanceof Error ? err.message : "request failed"}`;
      }
    }
    throw new Error(`Trae GetLoginGuidance failed: ${lastError}`);
  }

  /**
   * Completes the login from the callback the operator pastes back.
   *
   * Trae's callback is not an authorization code — it carries the refresh token
   * directly, so `code` is the callback URL (or its query string) and the
   * exchange is what turns it into an access token.
   */
  override async exchangeCode(
    code: string,
    codeVerifier: string,
    _redirectUri: string,
  ): Promise<OAuthExchangeResult> {
    const callback = parseTraeCallback(code);
    // Two shapes, two exchanges. The PKCE code is redeemed against the
    // verifier; a refresh token is rotated. Sending one where the other is
    // expected is answered "refresh token is invalid" or "Invalid param", so
    // the branch is not an optimisation.
    const exchanged =
      callback.authCode === undefined
        ? await this.refreshWithUser(callback.refreshToken ?? "", "")
        : await this.exchangeAuthCode(callback.authCode, codeVerifier, callback.host);
    const identity = await this.userInfo(exchanged.access);
    const state: Record<string, unknown> = {};
    if (identity.userId !== undefined) state["userId"] = identity.userId;
    if (callback.region !== undefined) state["region"] = callback.region;
    return {
      access: exchanged.access,
      // A refresh-token rotation may not return a new refresh token; the one
      // that was sent stays valid in that case, so it is the fallback.
      refresh: exchanged.refresh ?? callback.refreshToken ?? "",
      expiresAt: new Date(exchanged.expiresAt),
      ...(identity.email === undefined ? {} : { accountLabel: identity.email }),
      ...(Object.keys(state).length === 0 ? {} : { auth_state: state }),
    };
  }

  /**
   * Redeems the PKCE code the login page redirects with.
   *
   * `public/oauth/ExchangeToken` is the endpoint that accepts `AuthCode` — the
   * authenticated `oauth/ExchangeToken` only takes `RefreshToken` and answers
   * any code with "Invalid param". The body is taken verbatim from the page's
   * own client, which also sends an empty `RefreshToken`: upstream's binding
   * requires the field to exist, not to be set.
   */
  private async exchangeAuthCode(
    authCode: string,
    codeVerifier: string,
    host: string | undefined,
  ): Promise<{ access: string; refresh: string; expiresAt: number }> {
    const base = (host ?? traeAccountCandidates(this.realm)[0] ?? "").replace(/\/+$/, "");
    /**
     * `DeviceInfo` and `DeviceProof` must be maps, not strings — the gateway
     * rejects the string form with an explicit binding error. Empty maps pass,
     * and `RefreshToken` has to be present (the binding requires the field, not
     * a value) even though an AuthCode exchange does not use it.
     */
    const body = JSON.stringify({
      ClientID: TRAE_CLIENT_ID,
      ClientSecret: TRAE_CLIENT_SECRET,
      RefreshToken: "-",
      UserID: "",
      AuthCode: authCode,
      CodeVerifier: codeVerifier,
      DeviceInfo: {},
      DeviceProof: {},
    });
    let lastError = "no endpoint answered";
    const errors: string[] = [];
    for (const path of TRAE_AUTH_CODE_EXCHANGE_PATHS) {
      let response: Response;
      try {
        response = await this.fetchFn(`${base}${path}`, {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            "User-Agent": TRAE_OAUTH_USER_AGENT,
          },
          body,
        });
      } catch (failure) {
        lastError = `${path} ${failure instanceof Error ? failure.message : "request failed"}`;
        continue;
      }
      const text = await response.text();
      if (!response.ok) {
        lastError = `${path} HTTP ${response.status} ${text.slice(0, 200)}`;
        // Both paths are kept in the message: the first one's rejection is what
        // says whether the verifier or the endpoint is wrong, and only the last
        // was surviving before.
        errors.push(lastError);
        continue;
      }
      const parsed = JSON.parse(text) as TraeExchangeResponse;
      const result = (parsed.Result ?? parsed) as unknown as Record<string, unknown>;
      const access = firstString(result, ["Token", "token"]);
      const refresh = firstString(result, ["RefreshToken", "refreshToken"]);
      if (access === undefined || refresh === undefined) {
        lastError = `${path} returned no token pair`;
        continue;
      }
      const expiresAt =
        firstNumber(result, ["TokenExpireAt", "expireAt"]) ?? Date.now() + 3_600_000;
      return { access, refresh, expiresAt };
    }
    throw new Error(`Trae AuthCode exchange failed: ${errors.length > 0 ? errors.join(" | ") : lastError}`);
  }

  /** Reads the account identity the fresh access token names. */
  private async userInfo(accessToken: string): Promise<{ email?: string; userId?: string }> {
    for (const host of traeAccountCandidates(this.realm)) {
      try {
        const response = await this.fetchFn(`${host}${TRAE_GET_USER_INFO_PATH}`, {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            "User-Agent": TRAE_OAUTH_USER_AGENT,
            "x-cloudide-token": accessToken,
          },
          body: JSON.stringify({}),
        });
        if (!response.ok) continue;
        const data = (await response.json()) as { Result?: Record<string, unknown> };
        const result = data.Result ?? {};
        const email = firstString(result, ["NonPlainTextEmail", "Email", "email"]);
        const userId = firstString(result, ["UserID", "userId"]);
        return {
          ...(email === undefined ? {} : { email }),
          ...(userId === undefined ? {} : { userId }),
        };
      } catch {
        // Identity is optional: the account is usable without it.
      }
    }
    return {};
  }

  /**
   * Validates a pasted Trae export and stores it as a refreshable account.
   *
   * Trae has no authorize endpoint to click through, so the operator pastes
   * the credential the desktop client already minted. Importing it through this
   * path rather than the API-key path is what puts the refresh token in
   * `refresh_ciphertext` — an account imported as a plain key has no refresh
   * token stored and dies at expiry with nothing to exchange.
   *
   * `importFields` is left empty: the export carries everything needed, and
   * asking the operator for a field the blob already contains invites a
   * mismatch with the account the token belongs to.
   */
  async importCredential(input: OAuthImportInput): Promise<OAuthExchangeResult> {
    const parsed = parseExport(input.credential);
    if (parsed === undefined) {
      // A Trae PAT *is* a refresh token, so the one-token form is accepted
      // here and exchanged below rather than being stored as a dead access
      // token.
      throw new Error(
        "Paste a Trae account export (JSON with accessToken + refreshToken), a PAT, or a refresh token",
      );
    }

    // A full export already carries a usable access token; storing it directly
    // avoids spending the refresh rotation on a credential that is still valid.
    if (parsed.refresh === undefined && parsed.expiresAtMs !== undefined) {
      return parsedResult(parsed, parsed.access, parsed.access, true);
    }
    if (parsed.refresh !== undefined && parsed.expiresAtMs !== undefined) {
      return parsedResult(parsed, parsed.access, parsed.refresh, false);
    }

    // Only a refresh token (a PAT, or a bare token with no expiry): exchange it
    // now. Upstream is the only source of the access token and of the account
    // identity, and the exchange also proves the credential is live before it
    // is stored — an import that failed here would otherwise surface as a
    // dispatch failure much later.
    const exchanged = await this.refreshWithUser(parsed.refresh ?? parsed.access, parsed.userId ?? "");
    return {
      access: exchanged.access,
      refresh: exchanged.refresh ?? (parsed.refresh ?? parsed.access),
      expiresAt: exchanged.expiresAt,
      ...(parsed.email === undefined ? {} : { accountLabel: parsed.email }),
      ...(parsed.userId === undefined
        ? {}
        : { auth_state: { userId: parsed.userId } }),
    };
  }

  /**
   * Exchanges a refresh token for a fresh access token.
   *
   * `userId` is part of the payload upstream: the exchange is addressed per
   * account, not per client.
   */
  async refreshWithUser(
    refreshToken: string,
    userId: string,
    signal?: AbortSignal,
  ): Promise<OAuthTokenRefreshResult> {
    const hosts = traeAccountCandidates(this.realm);
    let lastError: unknown;
    for (const host of hosts) {
      const url = `${host}${TRAE_EXCHANGE_TOKEN_PATH}`;
      try {
        return await this.#exchange(url, refreshToken, userId, signal);
      } catch (err: unknown) {
        lastError = err;
        // A business error (an invalidated refresh token, say) is not a host
        // problem: replaying it on the fallback host just burns the token
        // rotation again. Only a transport failure moves on.
        if (isBusinessError(err)) throw err;
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error("Trae token exchange failed: no host answered");
  }

  /**
   * The {@link OAuthTokenRefresher} entry point.
   *
   * The user id the exchange needs is the account's own id, which the refresh
   * context already carries; requiring the caller to pass it separately would
   * invite a mismatch between the account being refreshed and the one the
   * exchange is addressed to.
   */
  override async refresh(
    refreshToken: string,
    signal?: AbortSignal,
    context?: { readonly account_id?: string; readonly auth_state?: Readonly<Record<string, unknown>> },
  ): Promise<OAuthTokenRefreshResult> {
    // The exchange is addressed per Trae account, not per gateway account row:
    // `UserID` must be the upstream user id. The login flow stores it in
    // `auth_state.userId`, and re-imports carry it the same way — preferring it
    // over `account_id` keeps refresh working for accounts whose row id is not
    // the upstream user id (any account created before the id was persisted).
    const upstreamUserId = firstString(context?.auth_state ?? {}, ["userId", "user_id", "uid"]);
    return this.refreshWithUser(refreshToken, upstreamUserId ?? context?.account_id ?? "", signal);
  }

  async #exchange(
    url: string,
    refreshToken: string,
    userId: string,
    signal?: AbortSignal,
  ): Promise<OAuthTokenRefreshResult> {
    const response = await this.fetchFn(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        ClientID: TRAE_CLIENT_ID,
        RefreshToken: refreshToken,
        ClientSecret: TRAE_CLIENT_SECRET,
        UserID: userId,
      }),
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) {
      throw new Error(`Trae token exchange failed with HTTP ${response.status}`);
    }
    const parsed = (await response.json()) as TraeExchangeResponse;
    const result = parsed.Result ?? parsed;
    const access = result.Token;
    if (typeof access !== "string" || access.length === 0) {
      // Upstream reports the reason beside the missing token, so surface it
      // rather than a generic failure — an invalidated refresh token is an
      // operator-actionable message.
      const code = parsed.Code ?? "refresh_failed";
      const detail = typeof parsed.Message === "string" ? `: ${parsed.Message}` : "";
      throw new Error(`Trae token exchange rejected (${code})${detail}`);
    }
    const refresh = result.RefreshToken;
    const expiryMs = result.TokenExpireAt;
    return {
      access,
      // Upstream rotates the refresh token, so the new one must be stored or
      // the account cannot be refreshed a second time.
      ...(typeof refresh === "string" && refresh.length > 0 ? { refresh } : {}),
      expiresAt:
        typeof expiryMs === "number" && Number.isFinite(expiryMs)
          ? new Date(expiryMs)
          : new Date(Date.now() + 3600_000),
      ...(typeof result.UserJwt === "string" && result.UserJwt.length > 0
        ? { auth_state: { userJwt: result.UserJwt } }
        : {}),
    };
  }
}

/**
 * True when an error came from upstream rather than the transport.
 *
 * `#exchange` throws a plain `Error` for both, so the distinction has to be
 * made on the message; a business rejection must not be retried on another
 * host, because each attempt rotates the refresh token again.
 */
function isBusinessError(err: unknown): boolean {
  return err instanceof Error && (err.message.includes("rejected") || err.message.includes("HTTP 4"));
}

/** Assembles an import result for an already-complete export. */
function parsedResult(
  parsed: TraeExport,
  access: string,
  refresh: string,
  isStatic: boolean,
): OAuthExchangeResult {
  const state: Record<string, unknown> = {};
  if (isStatic) state["staticToken"] = true;
  if (parsed.userId !== undefined) state["userId"] = parsed.userId;
  return {
    access,
    refresh,
    expiresAt:
      parsed.expiresAtMs === undefined ? new Date(Date.now() + 3600_000) : new Date(parsed.expiresAtMs),
    ...(Object.keys(state).length === 0 ? {} : { auth_state: state }),
    ...(parsed.email === undefined ? {} : { accountLabel: parsed.email }),
  };
}

/** The parts of a Trae export this flow needs. */
interface TraeExport {
  readonly access: string;
  readonly refresh?: string;
  readonly expiresAtMs?: number;
  readonly email?: string;
  readonly userId?: string;
}

/**
 * Reads a pasted credential as a Trae export.
 *
 * Accepts the exporter's own shape (`accessToken`/`refreshToken`) and the bare
 * access token an operator may have copied out of it. Returns `undefined` when
 * neither reading yields a token, so the caller reports a usable message rather
 * than storing an empty credential.
 */
function parseExport(credential: string): TraeExport | undefined {
  const trimmed = credential.trim();
  if (trimmed.length === 0) return undefined;
  if (!trimmed.startsWith("{")) return { access: trimmed };
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const access = firstString(parsed, ["accessToken", "access_token", "token"]);
  if (access === undefined) return undefined;
  const refresh = firstString(parsed, ["refreshToken", "refresh_token", "refresh"]);
  const expiresAtMs = firstNumber(parsed, ["expiredAt", "expiresAt", "TokenExpireAt", "tokenExpireAt"]);
  const email = firstString(parsed, ["email", "userEmail", "accountLabel"]);
  // The exporter nests the user id under `authState`; a hand-built export may
  // carry it at the top level instead.
  const authState = firstRecord(parsed, ["authState", "auth_state"]);
  const userId =
    firstString(authState ?? {}, ["userId", "user_id", "uid", "UserID"]) ??
    firstString(parsed, ["userId", "user_id", "uid", "UserID"]);
  return {
    access,
    ...(refresh === undefined ? {} : { refresh }),
    ...(expiresAtMs === undefined ? {} : { expiresAtMs }),
    ...(email === undefined ? {} : { email }),
    ...(userId === undefined ? {} : { userId }),
  };
}

/** First object value present under any of `keys`, or undefined. */
function firstRecord(record: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  }
  return undefined;
}

function firstNumber(record: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
      // An ISO expiry is what a re-export carries; epoch ms is what the
      // exchange returns, and both appear in the wild.
      const asMs = Date.parse(value);
      if (Number.isFinite(asMs)) return asMs;
    }
  }
  return undefined;
}

/** What a Trae callback can carry. Exactly one of the two is present. */
interface TraeCallbackPayload {
  /** Present on the refresh-token flow. */
  readonly refreshToken?: string;
  /** Present on the PKCE flow: the code the login page minted. */
  readonly authCode?: string;
  /** Host the exchange must go to, echoed back by the page. */
  readonly host?: string;
  /**
   * Provisioned region (`sg`, `us`, …).
   *
   * The token only authenticates against its own region's core host, so this is
   * persisted with the account rather than inferred from the realm.
   */
  readonly region?: string;
}

/**
 * Reads the Trae callback the operator pastes back.
 *
 * Upstream has two shapes and the page picks by how the login started:
 *
 * - `?isRedirect=true&refreshToken=…&refreshExpireAt=…` — the refresh-token
 *   flow.
 * - `?isRedirect=true&scope=trae&authCodeInfo={"AuthCode":…}&host=…` — the PKCE
 *   flow, which is what the live page actually produces here. The code inside
 *   `authCodeInfo` is what `public/oauth/ExchangeToken` redeems against the
 *   verifier, so it is not interchangeable with a refresh token.
 *
 * The pasted value may be the whole URL, just its query, or a fragment, so all
 * three are accepted.
 */
function parseTraeCallback(raw: string): TraeCallbackPayload {
  const text = raw.trim();
  let query = text;
  if (text.includes("?")) query = text.slice(text.indexOf("?") + 1);
  if (text.startsWith("#")) query = text.slice(1);
  const params = Object.fromEntries(new URLSearchParams(query));
  const pick = (keys: readonly string[]): string | undefined => firstString(params, keys);
  const error = pick(["error", "error_code", "errorCode"]);
  if (error !== undefined) {
    const detail = pick(["error_description", "error_desc", "message"]);
    throw new Error(detail === undefined ? `Trae auth failed: ${error}` : `Trae auth failed: ${error} (${detail})`);
  }
  const host = pick(["loginHost", "login_host", "LoginHost", "host", "consoleHost"]);
  const region = pick(["userRegion", "user_region", "UserRegion"]) ?? regionFromUserInfo(params["userInfo"]);
  const extra = {
    ...(host === undefined ? {} : { host }),
    ...(region === undefined ? {} : { region }),
  };
  const refreshToken = pick(["refreshToken", "refresh_token", "RefreshToken"]);
  if (refreshToken !== undefined) return { refreshToken, ...extra };
  // The PKCE flow nests the code in `authCodeInfo`, a JSON string.
  const authCode = pick(["AuthCode"]) ?? authCodeFromInfo(params["authCodeInfo"]);
  if (authCode !== undefined) return { authCode, ...extra };
  throw new Error(
    "Trae callback carries neither a refreshToken nor an AuthCode — paste the full callback URL",
  );
}

/** Client bound to the intl deployment. */
export const traeOAuthClient = new TraeOAuthClient();

/** Client bound to the China deployment. */
export const traeCnOAuthClient = new TraeOAuthClient(globalThis.fetch, "cn");

/**
 * Swaps the gateway redirect's path for the one Trae accepts.
 *
 * Parsed rather than string-replaced so a custom redirect (a different port,
 * a host) keeps everything except the path.
 */
function withTraeCallbackPath(redirectUri: string): string {
  try {
    const url = new URL(redirectUri);
    url.pathname = TRAE_CALLBACK_PATH;
    return url.toString();
  } catch {
    return `http://127.0.0.1:59653${TRAE_CALLBACK_PATH}`;
  }
}

/** Extracts `AuthCode` from the `authCodeInfo` JSON string the page sends. */
function authCodeFromInfo(raw: string | undefined): string | undefined {
  if (raw === undefined || raw.trim().length === 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    return firstString(parsed as Record<string, unknown>, ["AuthCode", "authCode"]);
  } catch {
    return undefined;
  }
}

/** Reads the provisioned region out of the `userInfo` JSON the page sends. */
function regionFromUserInfo(raw: string | undefined): string | undefined {
  if (raw === undefined || raw.trim().length === 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const record = parsed as Record<string, unknown>;
    return firstString(record, ["AIRegion", "aiRegion", "Region"]);
  } catch {
    return undefined;
  }
}
