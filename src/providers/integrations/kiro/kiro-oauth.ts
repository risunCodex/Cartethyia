/**
 * Kiro (AWS CodeWhisperer) authentication.
 *
 * Kiro has no single sign-in: the same subscription is reached through AWS
 * Builder ID, an Identity Center organization, Google/GitHub social sign-in, an
 * imported refresh token, an enterprise Microsoft identity provider, or a plain
 * API key. They differ in where the token comes from, how it is refreshed, and —
 * critically — which upstream host will accept it.
 *
 * What they share is the account-side configuration every later request needs
 * (the profile the account is bound to, the region it was minted in, and how it
 * authenticates). That travels in `auth_state` beside the tokens, because the
 * dispatched request and the refresh both need it and the credential string
 * cannot express it.
 *
 * Two rules are load-bearing and easy to get wrong:
 *
 *  * An account-bound credential (API key, Identity Center, enterprise) must
 *    never be sent the shared placeholder profile ARN. The placeholder belongs
 *    to the vendor's own account, and the upstream answers it with a 403.
 *  * AWS SSO OIDC answers camelCase JSON, not the snake_case form-urlencoded
 *    every other provider in this gateway speaks, so its responses are parsed
 *    separately rather than through the shared token parser.
 */
import {
  decodeJwtPayload,
  devicePollBackoff,
  generateOAuthState,
  generatePkcePair,
  nonEmptyString,
  nonEmptyTrimmedString,
  parseDeviceAuthStart,
  readJsonResponse,
  record,
} from "../../authentication/oauth-flow-store";
import type {
  OAuthAuthorizeRequest,
  OAuthCodeExchangeContext,
  OAuthDeviceFlowContext,
  OAuthDevicePollResult,
  OAuthDeviceStartResult,
  OAuthExchangeResult,
  OAuthImportInput,
  OAuthLoginField,
} from "../../authentication/oauth-flow-store";
import type {
  OAuthRefreshContext,
  OAuthTokenRefreshResult,
} from "../../authentication/oauth-refresh-service";
import { OAuthDeviceFlow } from "../../authentication/oauth-device-flow";
import {
  buildKiroAmzUserAgent,
  buildKiroSsoAmzUserAgent,
  buildKiroSsoUserAgent,
  buildKiroUserAgent,
  getKiroVersion,
} from "../../operations/client-versions";
import { deriveApiKeyMachineId, deriveOAuthMachineId, normalizeMachineId } from "./kiro-machine-id";
import { KIRO_MANAGEMENT_HOST_TEMPLATE } from "./kiro-catalog";
import { fetchKiroQuota } from "./kiro-quota";

/** Auth methods this integration supports, as stored on the account. */
export type KiroAuthMethod =
  | "builder-id"
  | "idc"
  | "google"
  | "github"
  | "imported"
  | "external_idp"
  | "api_key";

/** AWS region shape, checked before a region is interpolated into a URL. */
const AWS_REGION_PATTERN = /^[a-z]{2}-[a-z]+-\d{1,2}$/;

/** Default region when an account carries none. */
const DEFAULT_REGION = "us-east-1";

/** The vendor's own sign-in and refresh service for the social families. */
export const KIRO_AUTH_SERVICE = "https://prod.us-east-1.auth.desktop.kiro.dev" as const;

/** The web portal that offers the merged social/OIDC sign-in. */
export const KIRO_SOCIAL_PORTAL = "https://app.kiro.dev" as const;

/**
 * Redirect URI the vendor's identity provider allowlists. It is a custom
 * scheme, not a loopback address: the authorization code is shown to the
 * operator rather than delivered to a local listener. The 1.4.62 IDE uses
 * `kiro://kiro.oauth/callback` (observed in the agent bundle).
 */
export const KIRO_SOCIAL_REDIRECT_URI = "kiro://kiro.oauth/callback" as const;

/** Scopes the OIDC client registration requests (observed in the 1.4.62 IDE). */
const KIRO_SCOPES = [
  "codewhisperer:completions",
  "codewhisperer:analysis",
  "codewhisperer:conversations",
  "codewhisperer:transformations",
  "codewhisperer:taskassist",
] as const;

/** Grant types the OIDC client registration declares. */
const KIRO_GRANT_TYPES = [
  "authorization_code",
  "refresh_token",
] as const;

/** Loopback redirect the 1.4.62 IDE registers for the IdC/Builder-ID flow. */
const KIRO_LOOPBACK_REDIRECT_URI = "http://127.0.0.1/oauth/callback" as const;

/**
 * Client name the OIDC registration presents.
 *
 * The registration is the first request a new account makes, so it identifies as
 * the vendor's own IDE rather than as this gateway.
 */
const KIRO_OIDC_CLIENT_NAME = "Kiro IDE" as const;

/** Organization entry point the IdC/Builder-ID flow starts from by default. */
export const KIRO_DEFAULT_START_URL = "https://view.awsapps.com/start" as const;

/** Microsoft login hosts an enterprise token endpoint may point at. */
const MICROSOFT_TOKEN_HOSTS = new Set([
  "login.microsoftonline.com",
  "login.microsoft.com",
  "login.windows.net",
]);

/**
 * The account-side configuration carried in `auth_state`.
 *
 * `machineId` is part of it because it is derived once from the credential and
 * must not move afterwards: a refresh rotates the refresh token, and a device id
 * derived per request from the rotating material would make one account appear
 * to be a different machine on every refresh.
 */
export interface KiroAuthState {
  readonly authMethod: KiroAuthMethod;
  readonly region: string;
  readonly profileArn?: string;
  /** Identity Center organization URL, when the account came from one. */
  readonly startUrl?: string;
  /** OIDC client id from the IdC/Builder-ID client registration. */
  readonly clientId?: string;
  /** Enterprise identity-provider token endpoint. */
  readonly tokenEndpoint?: string;
  /** Enterprise identity-provider scopes. */
  readonly scope?: string;
  /** Frozen device identity presented in the User-Agent. */
  readonly machineId?: string;
}

/** Rejects a region that is not an AWS region before it reaches a URL. */
export function assertAwsRegion(region: string): string {
  if (!AWS_REGION_PATTERN.test(region)) {
    throw new Error("Kiro region must be a valid AWS region");
  }
  return region;
}

/** Normalizes a stored region, falling back to the default. */
export function normalizeRegion(value: unknown): string {
  const region = typeof value === "string" ? value.trim() : "";
  return AWS_REGION_PATTERN.test(region) ? region : DEFAULT_REGION;
}

/** Reads the account's `auth_state` back into a typed value. */
export function parseKiroAuthState(value: unknown): KiroAuthState | undefined {
  const raw = record(value);
  if (raw === undefined) return undefined;
  const authMethod = nonEmptyString(raw["authMethod"]);
  if (authMethod === undefined || !isKiroAuthMethod(authMethod)) return undefined;
  const profileArn = nonEmptyTrimmedString(raw["profileArn"]);
  const startUrl = nonEmptyTrimmedString(raw["startUrl"]);
  const clientId = nonEmptyTrimmedString(raw["clientId"]);
  const tokenEndpoint = nonEmptyTrimmedString(raw["tokenEndpoint"]);
  const scope = nonEmptyTrimmedString(raw["scope"]);
  const machineId = normalizeMachineId(raw["machineId"]);
  return {
    authMethod,
    region: normalizeRegion(raw["region"]),
    ...(profileArn === undefined ? {} : { profileArn }),
    ...(startUrl === undefined ? {} : { startUrl }),
    ...(clientId === undefined ? {} : { clientId }),
    ...(tokenEndpoint === undefined ? {} : { tokenEndpoint }),
    ...(scope === undefined ? {} : { scope }),
    ...(machineId === undefined ? {} : { machineId }),
  };
}

function isKiroAuthMethod(value: string): value is KiroAuthMethod {
  return (
    value === "builder-id" ||
    value === "idc" ||
    value === "google" ||
    value === "github" ||
    value === "imported" ||
    value === "external_idp" ||
    value === "api_key"
  );
}

/** The `auth_state` object to persist for one flow. */
function authStateOf(state: KiroAuthState): Readonly<Record<string, unknown>> {
  return { ...state };
}

/**
 * Headers every AWS SSO OIDC request carries.
 *
 * The login flow and the token refresh hit the same `oidc.{region}.amazonaws.com`
 * host, so they must look identical: registering bare and then refreshing with a
 * full SDK User-Agent describes two different clients holding one client id,
 * which is a stronger signal than either shape alone.
 */
function ssoOidcHeaders(): Record<string, string> {
  return {
    "content-type": "application/json",
    accept: "application/json",
    connection: "close",
    "amz-sdk-request": "attempt=1; max=4",
    "amz-sdk-invocation-id": crypto.randomUUID(),
    "user-agent": buildKiroSsoUserAgent(),
    "x-amz-user-agent": buildKiroSsoAmzUserAgent(),
  };
}

/**
 * Headers for the vendor's own sign-in and refresh service.
 *
 * A different host from the AWS SSO OIDC endpoints, with its own observed
 * client: that service is reached over plain HTTPS with no AWS SDK involved, so
 * the client identifies itself with the device marker alone and no
 * `aws-sdk-js/` segment. The device marker is included only when the credential
 * it belongs to is already known: the code exchange runs before an account
 * exists, and inventing an identity for that request would be worse than
 * sending none.
 */
function socialServiceHeaders(machineId?: string): Record<string, string> {
  const device = machineId === undefined ? "KiroIDE" : `KiroIDE-${getKiroVersion()}-${machineId}`;
  return {
    "content-type": "application/json",
    accept: "application/json",
    connection: "close",
    "user-agent": device,
    "x-amz-user-agent": device,
  };
}

/**
 * Validates an enterprise identity-provider token endpoint.
 *
 * The endpoint comes from imported JSON and receives the account's refresh
 * token, so it is restricted to the Microsoft login hosts rather than trusted
 * as given.
 */
export function validateMicrosoftTokenEndpoint(raw: unknown): string {
  const endpoint = typeof raw === "string" ? raw.trim() : "";
  if (endpoint.length === 0) throw new Error("token_endpoint is required");
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error("token_endpoint must be a valid URL");
  }
  if (parsed.protocol !== "https:") throw new Error("token_endpoint must use https");
  if (!MICROSOFT_TOKEN_HOSTS.has(parsed.hostname.toLowerCase())) {
    throw new Error("token_endpoint must be a Microsoft login endpoint");
  }
  return parsed.toString();
}

/** Best-effort display label for a credential. */
export function kiroAccountLabel(accessToken: string | undefined): string | undefined {
  const payload = accessToken === undefined ? undefined : decodeJwtPayload(accessToken);
  if (payload === undefined) return undefined;
  for (const key of ["email", "preferred_username", "upn", "sub"]) {
    const value = nonEmptyTrimmedString(payload[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

/**
 * Falls back to an informative per-family label when the token carries no
 * readable identity (the social access token is opaque, not a JWT). The
 * console otherwise labels every Kiro account "kiro".
 */
export function kiroDefaultLabel(authMethod: KiroAuthMethod): string {
  switch (authMethod) {
    case "google":
      return "Google account";
    case "github":
      return "GitHub account";
    case "builder-id":
      return "AWS Builder ID";
    case "idc":
      return "IAM Identity Center";
    case "external_idp":
      return "Enterprise IdP";
    case "imported":
      return "Imported Kiro session";
    case "api_key":
      return "Kiro API key";
  }
}

/**
 * Every stock fallback label `kiroDefaultLabel` can produce. The quota refresh
 * sweep may adopt an upstream-reported identity (an email from `GetUsageLimits`)
 * over any label in this set — those are generated defaults, never an operator's
 * rename — but leaves anything else alone.
 */
export const KIRO_DEFAULT_LABELS: ReadonlySet<string> = new Set(
  (
    ["google", "github", "builder-id", "idc", "external_idp", "imported", "api_key"] as const
  ).map(kiroDefaultLabel),
);

/** Credentials the client registration minted and refresh must replay. */
interface DeviceFlowRegistration {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly region: string;
  readonly startUrl: string;
  readonly authMethod: "builder-id" | "idc";
  /**
   * Redirect URI sent on authorize + CreateToken. The registration body itself
   * always declares {@link KIRO_LOOPBACK_REDIRECT_URI} (no port); AWS SSO OIDC
   * accepts a loopback authorize URI that adds a port (RFC 8252).
   */
  readonly redirectUri: string;
}

/**
 * Kiro's authentication client.
 *
 * The 1.4.62 IDE migrated every AWS family to the OAuth 2.0 authorization-code
 * flow with PKCE: it registers a public client against AWS SSO OIDC, opens a
 * loopback listener on `http://127.0.0.1/oauth/callback`, and exchanges the code
  * with `CreateToken`. The social families (Google/GitHub) use the vendor's own
  * sign-in portal with a loopback redirect. The device-code flow (RFC 8628) is
  * offered against the same AWS SSO OIDC service for Builder-ID / Identity
  * Center. The import, enterprise, and API-key paths are unchanged.
 */
export class KiroOAuthClient extends OAuthDeviceFlow {
  override readonly supportsDeviceCode = true;
  override readonly supportsBrowserCode = true;

  /**
   * Loopback callback the portal and the IdC flow land on.
   *
   * Host must be `127.0.0.1`, not `localhost`: OIDC client registration uses
   * the portless `http://127.0.0.1/oauth/callback`, and AWS SSO OIDC allows
   * RFC 8252 port variation on the *same* host only — swapping in `localhost`
   * at authorize yields `Invalid redirectUri provided`. The 1.4.62 IDE binds
   * and authorizes on `127.0.0.1:<port>/oauth/callback` the same way. The
   * portal gets the origin only (`http://127.0.0.1:3128`); the callback lands
   * at `/oauth/callback?login_option=…` or `/signin/callback?…`.
   */
  override readonly browserRedirectUri = "http://127.0.0.1:3128/oauth/callback";

  protected override readonly providerLabel = "kiro";
  protected override readonly clientId = "";
  protected override readonly tokenUrl = `${KIRO_AUTH_SERVICE}/refreshToken`;
  protected override readonly scopes = "";

  /** IdC/Builder-ID registrations keyed by flow state, for the code exchange. */
  readonly #registrationByState = new Map<string, DeviceFlowRegistration>();

  /**
   * Fields the browser flow needs before it can start.
   *
   * None: the vendor's sign-in portal (`app.kiro.dev/signin`) is the single
   * entry point for every family — Google, GitHub, AWS Builder ID, "Your
   * organization" (IdC), and enterprise — and the callback's `login_option`
   * names which one approved. Asking for a family/region/start URL up front
   * both duplicated the portal's own choice and forced non-social families
   * onto a different (OIDC-direct) path the 1.4.62 client does not use.
   */
  readonly browserLoginFields: readonly OAuthLoginField[] = [];

  /**
   * Fields the device-flow (RFC 8628) needs before it can start.
   *
   * The device flow targets the AWS SSO OIDC service (Builder-ID / Identity
   * Center), so it asks the same region/organization questions the browser
   * flow does and defaults to the same families.
   */
  readonly deviceLoginFields: readonly OAuthLoginField[] = [
    {
      key: "authMethod",
      label: "Sign-in method",
      required: true,
      defaultValue: "builder-id",
      options: [
        { value: "builder-id", label: "AWS Builder ID (personal)" },
        { value: "idc", label: "IAM Identity Center (organization)" },
      ],
    },
    {
      key: "region",
      label: "AWS region",
      required: true,
      defaultValue: DEFAULT_REGION,
      placeholder: DEFAULT_REGION,
    },
    {
      key: "startUrl",
      label: "Organization start URL",
      defaultValue: KIRO_DEFAULT_START_URL,
      placeholder: KIRO_DEFAULT_START_URL,
    },
  ];

  /**
   * Fields the import flow needs.
   *
   * The same entry point accepts four credential families, so the operator
   * states which one the pasted material is; the region and — for Identity
   * Center — the client registration are the only other inputs the family
   * cannot carry by itself.
   */
  readonly importFields: readonly OAuthLoginField[] = [
    {
      key: "authMethod",
      label: "Credential type",
      required: true,
      defaultValue: "imported",
      options: [
        { value: "imported", label: "Refresh token (Kiro social session)" },
        { value: "idc", label: "Refresh token (IAM Identity Center)" },
        { value: "external_idp", label: "Enterprise IdP export (JSON)" },
        { value: "api_key", label: "API key" },
      ],
    },
    { key: "region", label: "AWS region", defaultValue: DEFAULT_REGION, placeholder: DEFAULT_REGION },
    { key: "clientId", label: "OIDC client id (Identity Center only)" },
    { key: "clientSecret", label: "OIDC client secret (Identity Center only)", secret: true },
    { key: "profileArn", label: "Profile ARN (optional)" },
  ];

  /**
   * Registers an OIDC client for the IdC/Builder-ID flow.
   *
   * The 1.4.62 IDE registers a public client per region/issuer, then opens a
   * browser authorization-code flow with PKCE. The registration is retained for
   * the code exchange and later refreshes via the flow `state`, which both the
   * authorize URL and the callback carry.
   */
  /**
   * Starts the AWS SSO OIDC device authorization.
   *
   * The same client registration the browser flow uses is reused: register a
   * public client for the chosen family/region, then ask the regional OIDC
   * service for a device code. The registration is carried in `providerState`
   * so `pollDeviceAuth` can replay it at the token endpoint.
   */
  override async startDeviceAuth(context?: OAuthDeviceFlowContext): Promise<OAuthDeviceStartResult> {
    const parameters = context?.parameters ?? {};
    const authMethod = parameters["authMethod"] === "idc" ? "idc" : "builder-id";
    const region = normalizeRegion(parameters["region"]);
    const startUrl = nonEmptyTrimmedString(parameters["startUrl"]) ?? KIRO_DEFAULT_START_URL;
    assertAwsRegion(region);
    const registration = await this.#registerClient(region, startUrl, authMethod);

    const response = await this.fetchFn(
      `https://oidc.${region}.amazonaws.com/device_authorization`,
      {
        method: "POST",
        headers: ssoOidcHeaders(),
        body: JSON.stringify({
          clientId: registration.clientId,
          clientSecret: registration.clientSecret,
          startUrl,
        }),
        signal: AbortSignal.timeout(15_000),
      },
    );
    const payload = record(await readJsonResponse(response, "kiro device authorization")) ?? {};
    const start = parseDeviceAuthStart(payload, { intervalSeconds: 5, expiresInSeconds: 600 });
    if (start === undefined) {
      throw new Error("Kiro device authorization returned an invalid response");
    }
    return {
      verificationUri: start.verificationUriComplete ?? start.verificationUri,
      userCode: start.userCode,
      deviceAuthId: start.deviceCode,
      intervalSeconds: start.intervalSeconds,
      expiresInSeconds: start.expiresInSeconds,
      providerState: JSON.stringify(registration),
    };
  }

  /** Polls the AWS SSO OIDC token endpoint for the device grant result. */
  override async pollDeviceAuth(
    deviceAuthId: string,
    context?: OAuthDeviceFlowContext,
  ): Promise<OAuthDevicePollResult> {
    let registration: DeviceFlowRegistration;
    try {
      registration = JSON.parse(context?.providerState ?? "") as DeviceFlowRegistration;
    } catch {
      return { status: "failed", reason: "unknown device authorization" };
    }
    if (!registration.clientId || !registration.clientSecret || !registration.region) {
      return { status: "failed", reason: "unknown device authorization" };
    }
    const region = assertAwsRegion(registration.region);
    let response: Response;
    try {
      response = await this.fetchFn(`https://oidc.${region}.amazonaws.com/token`, {
        method: "POST",
        headers: ssoOidcHeaders(),
        body: JSON.stringify({
          clientId: registration.clientId,
          clientSecret: registration.clientSecret,
          deviceCode: deviceAuthId,
          grantType: "urn:ietf:params:oauth:grant-type:device_code",
        }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      return { status: "failed", reason: error instanceof Error ? error.message : "Kiro device polling failed" };
    }
    const payload = record(await response.json().catch(() => undefined)) ?? {};
    if (response.status === 400 || response.status === 428) {
      const err = typeof payload.error === "string" ? payload.error : "";
      const verdict = devicePollBackoff(err, payload.interval);
      if (verdict !== undefined) return verdict;
      return { status: "failed", reason: err || `device polling failed (${response.status})` };
    }
    const access = nonEmptyString(payload["accessToken"]);
    if (!response.ok || access === undefined) {
      const detail = nonEmptyString(payload["error_description"]) ?? nonEmptyString(payload["error"]);
      return {
        status: "failed",
        reason: detail ?? `Kiro device polling failed (${response.status})`,
      };
    }
    const refresh = nonEmptyString(payload["refreshToken"]) ?? "";
    const profileArn = nonEmptyString(payload["profileArn"]);
    const authState: KiroAuthState = {
      authMethod: registration.authMethod,
      region,
      ...(profileArn === undefined ? {} : { profileArn }),
      startUrl: registration.startUrl,
      clientId: registration.clientId,
      machineId: deriveOAuthMachineId(refresh),
    };
    let label = kiroAccountLabel(access) ?? kiroDefaultLabel(registration.authMethod);
    // Same best-effort identity enrichment as the browser flows: the device
    // token is opaque, so ask the usage surface for the account email.
    if (label === kiroDefaultLabel(registration.authMethod)) {
      try {
        const quota = await fetchKiroQuota(access, this.fetchFn, { auth_state: authStateOf(authState) });
        if (quota.accountLabel !== undefined && quota.accountLabel.trim().length > 0) {
          label = quota.accountLabel;
        }
      } catch {
        // keep the family fallback
      }
    }
    return {
      status: "complete",
      result: {
        access,
        refresh,
        expiresAt: this.#expiry(payload["expiresIn"]),
        accountLabel: label,
        auth_state: authStateOf(authState),
        client_secret: registration.clientSecret,
      },
    };
  }

  async prepareAuthorize(request: OAuthAuthorizeRequest): Promise<OAuthAuthorizeRequest> {
    // The portal is the single entry point for every family; it chooses the
    // identity provider and reports it back in the callback's `login_option`.
    // No registration happens here.
    return request;
  }

  override buildAuthorizeUrl(request: OAuthAuthorizeRequest): string {
    // Every family goes through the portal. The 1.4.62 IDE has no per-family
    // OIDC-direct URL: its `buildPortalUrl` sends `state`, `code_challenge`,
    // `redirect_uri`, and `redirect_from` to `app.kiro.dev/signin`, and the
    // portal picks the identity provider. The callback's `login_option` then
    // tells the exchange which family approved.
    return this.#buildSocialAuthorizeUrl(request);
  }

  #buildSocialAuthorizeUrl(request: OAuthAuthorizeRequest): string {
    // The portal chooses the identity provider (Google/GitHub/OIDC) itself, so
    // the authorize URL carries no `idp`. The redirect URI is the origin only —
    // exactly what the bundle's `PortalAuthProvider.buildPortalUrl` sends; a
    // path-carrying redirect is rejected by Cognito with `redirect_mismatch`.
    const params = new URLSearchParams({
      state: request.state,
      code_challenge: request.codeChallenge,
      code_challenge_method: "S256",
      redirect_uri: "",
      redirect_from: "KiroIDE",
    });
    const redirectOrigin = new URL(this.browserRedirectUri);
    params.set("redirect_uri", redirectOrigin.origin);
    return `${KIRO_SOCIAL_PORTAL}/signin?${params.toString()}`;
  }

  /**
   * Exchanges the authorization code the operator pastes back.
   *
   * Social families exchange against the vendor's own sign-in service. The
   * OIDC families (Builder-ID / IdC) use a two-phase flow mirrored from the
   * 1.4.62 IDE: the portal's first callback carries no `code`, only
   * `login_option` + `issuer_url` + `idc_region`; this exchange then registers
   * an OIDC client, builds the real authorize URL, and starts the *second*
   * browser leg by throwing {@link KiroOidcPendingError}. When that second
   * callback arrives (with a `code`), `exchangeCode` runs again with the
   * registration now on file and exchanges it via AWS SSO OIDC `CreateToken`.
   */
  override async exchangeCode(
    code: string,
    codeVerifier: string,
    redirectUri: string,
    state?: string,
    context?: OAuthCodeExchangeContext,
  ): Promise<OAuthExchangeResult> {
    // Phase 2 (or a resumed device/browser OIDC exchange): registration may be
    // in the process Map or restored from the pending flow's providerState.
    const registration =
      (state === undefined ? undefined : this.#registrationByState.get(state)) ??
      parseRegistration(context?.providerState);
    if (registration !== undefined) {
      if (state !== undefined) this.#registrationByState.delete(state);
      return this.#exchangeIdcCode(code, codeVerifier, registration.redirectUri, registration);
    }
    const params = context?.parameters ?? {};
    const loginOption = params["login_option"];
    if (loginOption === "builderid" || loginOption === "awsidc") {
      // Phase 1: the portal callback for an OIDC family. `code` is absent and
      // the issuer/region tell us which regional OIDC service to use. Mirror the
      // 1.4.62 IDE's IdC-provider.authenticate: register with the portless
      // loopback URI, mint a *fresh* PKCE pair, authorize against the full
      // `127.0.0.1:<port>/oauth/callback` (port allowed under RFC 8252; host
      // must stay `127.0.0.1` — `localhost` is rejected as Invalid redirectUri),
      // scopes comma-joined.
      const issuerUrl = params["issuer_url"];
      const idcRegion = params["idc_region"] ?? params["idcRegion"];
      if (issuerUrl === undefined || idcRegion === undefined) {
        throw new Error(`Kiro ${loginOption} callback missing issuer_url or idc_region`);
      }
      const region = normalizeRegion(idcRegion);
      assertAwsRegion(region);
      const authMethod = loginOption === "awsidc" ? "idc" : "builder-id";
      const registered = await this.#registerClient(region, issuerUrl, authMethod);
      const authorizeRedirect = oidcAuthorizeRedirectUri(redirectUri);
      const phase2: DeviceFlowRegistration = { ...registered, redirectUri: authorizeRedirect };
      const pkce = generatePkcePair();
      // The second browser leg uses a *fresh* state, mirroring the 1.4.62
      // IDE (IdCAuthProvider mints a new UUID for the IdC authorize step). The
      // code exchange keys off that new state, not the portal's.
      const continueState = generateOAuthState();
      this.#registrationByState.set(continueState, phase2);
      const authorizeParams = new URLSearchParams({
        response_type: "code",
        client_id: phase2.clientId,
        redirect_uri: authorizeRedirect,
        scopes: KIRO_SCOPES.join(","),
        state: continueState,
        code_challenge: pkce.codeChallenge,
        code_challenge_method: "S256",
      });
      throw new KiroOidcPendingError(
        `https://oidc.${region}.amazonaws.com/authorize?${authorizeParams.toString()}`,
        pkce.codeVerifier,
        JSON.stringify(phase2),
        continueState,
      );
    }
    if (loginOption === "external_idp") {
      // Enterprise IdP is only reachable by import; the portal cannot complete
      // it for us because the refresh needs the operator's pasted JSON.
      throw new Error("Kiro enterprise sign-in must be imported — use Import credential");
    }
    return this.exchangeSocialCode(code, codeVerifier, redirectUri, loginOption);
  }

  /** Exchanges an IdC/Builder-ID authorization code via AWS SSO OIDC CreateToken. */
  async #exchangeIdcCode(
    code: string,
    codeVerifier: string,
    redirectUri: string,
    registration: DeviceFlowRegistration,
  ): Promise<OAuthExchangeResult> {
    const response = await this.fetchFn(`https://oidc.${registration.region}.amazonaws.com/token`, {
      method: "POST",
      headers: ssoOidcHeaders(),
      body: JSON.stringify({
        clientId: registration.clientId,
        clientSecret: registration.clientSecret,
        grantType: "authorization_code",
        code,
        redirectUri,
        codeVerifier,
      }),
    });
    const payload = record(await readJsonResponse(response, "kiro IdC token exchange")) ?? {};
    const access = nonEmptyString(payload["accessToken"]);
    if (access === undefined) {
      const detail = nonEmptyString(payload["error_description"]) ?? nonEmptyString(payload["error"]);
      throw new Error(`Kiro IdC token exchange omitted accessToken${detail === undefined ? "" : `: ${detail}`}`);
    }
    const refresh = nonEmptyString(payload["refreshToken"]) ?? "";
    const reported = nonEmptyString(payload["profileArn"]);
    const profileArn =
      reported ?? (await this.resolveProfileArn(access, registration.region, registration.authMethod));
    const authState: KiroAuthState = {
      authMethod: registration.authMethod,
      region: registration.region,
      ...(profileArn === undefined ? {} : { profileArn }),
      startUrl: registration.startUrl,
      clientId: registration.clientId,
      machineId: deriveOAuthMachineId(refresh),
    };
    let label = kiroAccountLabel(access) ?? kiroDefaultLabel(registration.authMethod);
    // Builder-ID / IdC access tokens are opaque (not JWTs), so the JWT
    // extraction above misses the identity; ask the usage surface for the
    // account email instead — the same best-effort enrichment social uses.
    if (label === kiroDefaultLabel(registration.authMethod)) {
      try {
        const quota = await fetchKiroQuota(access, this.fetchFn, { auth_state: authStateOf(authState) });
        if (quota.accountLabel !== undefined && quota.accountLabel.trim().length > 0) {
          label = quota.accountLabel;
        }
      } catch {
        // keep the family fallback
      }
    }
    return {
      access,
      refresh,
      expiresAt: this.#expiry(payload["expiresIn"]),
      accountLabel: label,
      auth_state: authStateOf(authState),
      client_secret: registration.clientSecret,
    };
  }

  /** Exchanges a social authorization code for tokens. */
  async exchangeSocialCode(
    code: string,
    codeVerifier: string,
    redirectUri?: string,
    loginOption?: string,
  ): Promise<OAuthExchangeResult> {
    // The portal callback lands as `?login_option=google&code=…`. The exchange
    // must replay the exact redirect URI the portal saw — the callback origin +
    // path + `?login_option=…` — otherwise the vendor service rejects it (the
    // bundle rebuilds it the same way). We do not have the full callback URL at
    // exchange time, so the caller passes the pieces: `redirectUri` is the
    // loopback callback URL the flow registered and `loginOption` is the query
    // value. Default to the original scheme when the pieces are absent.
    const redirectUriFinal =
      redirectUri !== undefined && loginOption !== undefined
        ? `${redirectUri}?login_option=${loginOption}`
        : redirectUri ?? KIRO_SOCIAL_REDIRECT_URI;
    const response = await this.fetchFn(`${KIRO_AUTH_SERVICE}/oauth/token`, {
      method: "POST",
      headers: socialServiceHeaders(),
      body: JSON.stringify({
        code,
        code_verifier: codeVerifier,
        redirect_uri: redirectUriFinal,
      }),
    });
    const payload = await readJsonResponse(response, "kiro social token exchange");
    const raw = record(payload) ?? {};
    const access = nonEmptyString(raw["accessToken"]);
    if (access === undefined) {
      const detail = nonEmptyString(raw["error_description"]) ?? nonEmptyString(raw["error"]);
      throw new Error(`Kiro token exchange omitted accessToken${detail === undefined ? "" : `: ${detail}`}`);
    }
    const refresh = nonEmptyString(raw["refreshToken"]) ?? "";
    const profileArn = nonEmptyString(raw["profileArn"]);
    const authMethod: KiroAuthMethod = loginOption === "github" ? "github" : "google";
    const authState: KiroAuthState = {
      authMethod,
      region: DEFAULT_REGION,
      ...(profileArn === undefined ? {} : { profileArn }),
      machineId: deriveOAuthMachineId(refresh),
    };
    let label = kiroAccountLabel(access) ?? kiroDefaultLabel(authMethod);
    // Social access tokens are opaque (not JWTs), so the JWT extraction above
    // misses them; ask the usage surface for the account's email instead. The
    // call is best-effort and guarded — a failure keeps the family fallback.
    if (label === kiroDefaultLabel(authMethod)) {
      try {
        const quota = await fetchKiroQuota(access, this.fetchFn, { auth_state: authStateOf(authState) });
        if (quota.accountLabel !== undefined && quota.accountLabel.trim().length > 0) {
          label = quota.accountLabel;
        }
      } catch {
        // keep the family fallback
      }
    }
    return {
      access,
      refresh,
      expiresAt: this.#expiry(raw["expiresIn"]),
      accountLabel: label,
      auth_state: authStateOf(authState),
    };
  }

  /**
   * Completes a login from pasted credential material.
   *
   * One entry point for the four families that cannot be reached by a redirect
   * or a browser flow, because the operator already holds the material:
   *
   *  * a Kiro social refresh token;
   *  * an Identity Center refresh token, which needs the client registration
   *    that issued it;
   *  * an enterprise IdP export, which carries its own endpoint and scopes;
   *  * a raw API key.
   *
   * Every family is validated against the upstream before it is returned, so an
   * import cannot persist material that never worked — a dead refresh token is
   * rejected by the refresh it triggers, and an API key by the catalog it reads.
   * The console then persists what this returns without further inspection.
   */
  async importCredential(input: OAuthImportInput): Promise<OAuthExchangeResult> {
    const authMethod = nonEmptyTrimmedString(input.fields["authMethod"]) ?? "imported";
    const credential = input.credential.trim();
    if (credential.length === 0) throw new Error("Kiro credential material is required");
    switch (authMethod) {
      case "api_key":
        return this.validateApiKey(credential, input.fields["region"] ?? DEFAULT_REGION);
      case "external_idp":
        return this.importExternalIdp(credential);
      case "idc":
        return this.importRefreshToken(credential, {
          clientId: nonEmptyTrimmedString(input.fields["clientId"]),
          clientSecret: nonEmptyTrimmedString(input.fields["clientSecret"]),
          region: input.fields["region"],
          profileArn: nonEmptyTrimmedString(input.fields["profileArn"]),
        });
      case "imported":
        return this.importRefreshToken(credential, {
          region: input.fields["region"],
          profileArn: nonEmptyTrimmedString(input.fields["profileArn"]),
        });
      default:
        throw new Error(`Unsupported Kiro credential type: ${authMethod}`);
    }
  }

  /**
   * Imports a refresh token pasted from an existing Kiro session.
   *
   * The token is validated by actually refreshing it, so an import cannot
   * persist a credential that was already dead. Identity Center tokens carry
   * client credentials that the refresh needs; the other families refresh
   * against the vendor service.
   */
  async importRefreshToken(
    refreshToken: string,
    options: {
      readonly clientId?: string | undefined;
      readonly clientSecret?: string | undefined;
      readonly region?: string | undefined;
      readonly profileArn?: string | undefined;
      readonly machineId?: string | undefined;
    },
  ): Promise<OAuthExchangeResult> {
    const trimmed = refreshToken.trim();
    if (trimmed.length === 0) throw new Error("refresh token is required");
    const isIdc = options.clientId !== undefined && options.clientSecret !== undefined;
    const region = normalizeRegion(options.region);
    const refreshed = isIdc
      ? await this.#refreshOidc(trimmed, {
          clientId: options.clientId ?? "",
          clientSecret: options.clientSecret ?? "",
          region,
          startUrl: KIRO_DEFAULT_START_URL,
          authMethod: "idc",
        })
      : await this.#refreshSocial(trimmed, undefined, normalizeMachineId(options.machineId));
    // An Identity Center refresh answers from the OIDC token endpoint, which does
    // not report a profile; the social service does. An operator-supplied ARN
    // wins over both, because it is the one value that was stated rather than
    // inferred.
    const reported =
      refreshed.profileArn ??
      (isIdc ? await this.resolveProfileArn(refreshed.access, region, "idc") : undefined);
    const profileArn = options.profileArn ?? reported;
    const authState: KiroAuthState = {
      authMethod: isIdc ? "idc" : "imported",
      region,
      ...(profileArn === undefined ? {} : { profileArn }),
      machineId: deriveOAuthMachineId(refreshed.refresh),
    };
    let label = kiroAccountLabel(refreshed.access) ?? kiroDefaultLabel(isIdc ? "idc" : "imported");
    // An imported refresh token's access token is opaque, so extract the identity
    // from the usage surface instead — the same call the quota sweep makes, and
    // the same best-effort guard.
    if (label === kiroDefaultLabel(isIdc ? "idc" : "imported")) {
      try {
        const quota = await fetchKiroQuota(refreshed.access, this.fetchFn, { auth_state: authStateOf(authState) });
        if (quota.accountLabel !== undefined && quota.accountLabel.trim().length > 0) {
          label = quota.accountLabel;
        }
      } catch {
        // keep the family fallback
      }
    }
    return {
      access: refreshed.access,
      refresh: refreshed.refresh,
      expiresAt: refreshed.expiresAt,
      ...(label === undefined ? {} : { accountLabel: label }),
      auth_state: authStateOf(authState),
      ...(isIdc ? { client_secret: options.clientSecret } : {}),
    };
  }

  /**
   * Imports an enterprise identity-provider credential from exported JSON.
   *
   * Every field is required and the token endpoint is restricted to the
   * Microsoft login hosts, because the refresh posts the account's refresh token
   * to whatever endpoint the JSON names.
   */
  importExternalIdp(rawAuth: unknown): OAuthExchangeResult {
    let input = rawAuth;
    if (typeof input === "string") {
      const parsed = safeJson(input);
      if (parsed === undefined) throw new Error("CLIProxyAPI auth JSON is invalid");
      input = parsed;
    }
    const raw = record(input);
    if (raw === undefined) throw new Error("CLIProxyAPI auth JSON is required");
    const authMethod = nonEmptyTrimmedString(raw["auth_method"] ?? raw["authMethod"]);
    if (authMethod !== undefined && authMethod !== "external_idp") {
      throw new Error("Only external_idp Kiro auth is supported by this importer");
    }
    const access = nonEmptyTrimmedString(raw["access_token"] ?? raw["accessToken"]);
    const refresh = nonEmptyTrimmedString(raw["refresh_token"] ?? raw["refreshToken"]);
    const clientId = nonEmptyTrimmedString(raw["client_id"] ?? raw["clientId"]);
    const tokenEndpoint = validateMicrosoftTokenEndpoint(raw["token_endpoint"] ?? raw["tokenEndpoint"]);
    const profileArn = nonEmptyTrimmedString(raw["profile_arn"] ?? raw["profileArn"]);
    const region = normalizeRegion(raw["region"]);
    const scope = normalizeScope(raw["scopes"] ?? raw["scope"]);
    if (access === undefined) throw new Error("access_token is required");
    if (refresh === undefined) throw new Error("refresh_token is required");
    if (clientId === undefined) throw new Error("client_id is required");
    if (scope.length === 0) throw new Error("scopes is required");
    if (profileArn === undefined) throw new Error("profile_arn is required");
    const authState: KiroAuthState = {
      authMethod: "external_idp",
      region,
      profileArn,
      clientId,
      tokenEndpoint,
      scope,
      machineId: deriveOAuthMachineId(refresh),
    };
    const expiresAt = readExpiry(raw) ?? this.#expiry(undefined);
    const label = kiroAccountLabel(access) ?? kiroDefaultLabel("external_idp");
    return {
      access,
      refresh,
      expiresAt,
      accountLabel: label,
      auth_state: authStateOf(authState),
    };
  }

  /**
   * Validates an API key against the surface it will actually be used on.
   *
   * A bearer-only profile lookup answers 200 with an empty list for an
   * arbitrary key, so it proves nothing; the model catalog is the surface that
   * inference uses and it answers with the models the key can reach.
   */
  async validateApiKey(apiKey: string, region = DEFAULT_REGION): Promise<OAuthExchangeResult> {
    const trimmed = apiKey.trim();
    if (trimmed.length === 0) throw new Error("API key is required");
    const safeRegion = assertAwsRegion(normalizeRegion(region));
    const version = getKiroVersion();
    const machineId = deriveApiKeyMachineId(trimmed);
    const host = KIRO_MANAGEMENT_HOST_TEMPLATE.replace("{region}", safeRegion);
    const response = await this.fetchFn(`${host}/List-Available-Models?origin=AI_EDITOR`, {
      headers: {
        authorization: `Bearer ${trimmed}`,
        TokenType: "API_KEY",
        accept: "application/json",
        connection: "close",
        "x-amz-target": "KiroControlPlaneBearerService.ListAvailableModels",
        "amz-sdk-request": "attempt=1; max=1",
        "amz-sdk-invocation-id": crypto.randomUUID(),
        "user-agent": buildKiroUserAgent(version, machineId),
        "x-amz-user-agent": buildKiroAmzUserAgent(version, machineId),
        "x-kiro-machineid": machineId,
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`API key validation failed (${response.status})`);
    const payload = record(await response.json().catch(() => undefined));
    const models = payload?.["models"];
    if (!Array.isArray(models) || models.length === 0) {
      throw new Error("API key returned no available models");
    }
    const authState: KiroAuthState = {
      authMethod: "api_key",
      region: safeRegion,
      machineId,
    };
    return {
      access: trimmed,
      refresh: "",
      // An API key has no expiry; a far-future value keeps the refresh path,
      // which needs a refresh token anyway, from ever selecting it.
      expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
      auth_state: authStateOf(authState),
    };
  }

  /**
   * Resolves the profile ARN an account is bound to.
   *
   * Profile-scoped surfaces refuse a request that omits the field (`400
   * profileArn is required for this request.`), and an Identity Center account
   * whose token response carried no profile needs its own resolved before it is
   * persisted. `GetProfile` on the Kiro control-plane service is that lookup: a
   * POST with an `x-amz-target` header on `https://management.{region}.kiro.dev`.
   *
   * A Builder ID account is skipped rather than asked: the operation refuses
   * that family outright (`403 AWS Builder ID is not supported for this
   * operation.`), and a login path is no place to spend a request that is known
   * to be refused. Such an account is served by its family's public default.
   *
   * Returns `undefined` rather than throwing. Resolution runs on the login path,
   * and an account whose profile cannot be read still has to be persisted — the
   * operator can supply the ARN by import, and a failure here must not block a
   * sign-in that otherwise succeeded.
   */
  async resolveProfileArn(
    accessToken: string,
    region = DEFAULT_REGION,
    authMethod?: KiroAuthMethod,
  ): Promise<string | undefined> {
    if (authMethod === "builder-id") return undefined;
    const safeRegion = assertAwsRegion(normalizeRegion(region));
    try {
      const host = KIRO_MANAGEMENT_HOST_TEMPLATE.replace("{region}", safeRegion);
      const response = await this.fetchFn(`${host}/Get-Profile`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/x-amz-json-1.0",
          "x-amz-target": "KiroControlPlaneBearerService.GetProfile",
          accept: "application/json",
          connection: "close",
          "amz-sdk-request": "attempt=1; max=1",
          "amz-sdk-invocation-id": crypto.randomUUID(),
        },
        body: JSON.stringify({}),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) return undefined;
      const payload = record(await response.json().catch(() => undefined));
      const profile = record(payload?.["profile"]);
      const arn = nonEmptyTrimmedString(profile?.["arn"] ?? profile?.["profileArn"]);
      if (arn !== undefined) return arn;
      const profiles = payload?.["profiles"];
      if (Array.isArray(profiles)) {
        let fallback: string | undefined;
        for (const entry of profiles) {
          const p = record(entry);
          const value = nonEmptyTrimmedString(p?.["arn"] ?? p?.["profileArn"]);
          if (value === undefined) continue;
          if (value.includes(`:${safeRegion}:`)) return value;
          fallback ??= value;
        }
        return fallback;
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Refreshes an account's access token.
   *
   * Four paths, chosen from the account's own configuration rather than the
   * refresh token's shape: an enterprise provider, an OIDC client registration,
   * the vendor's social service, and an imported social token (which refreshes
   * through the same service).
   */
  override async refresh(
    refreshToken: string,
    signal?: AbortSignal,
    context?: OAuthRefreshContext,
  ): Promise<OAuthTokenRefreshResult> {
    const authState = parseKiroAuthState(context?.auth_state);
    if (authState?.authMethod === "external_idp") {
      const tokenEndpoint = validateMicrosoftTokenEndpoint(authState.tokenEndpoint);
      const clientId = authState.clientId;
      const scope = authState.scope;
      if (clientId === undefined || scope === undefined) {
        throw new Error("Kiro enterprise refresh is missing its client configuration");
      }
      const body = new URLSearchParams({
        grant_type: "refresh_token",
        client_id: clientId,
        refresh_token: refreshToken,
        scope,
      });
      const response = await this.fetchFn(tokenEndpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body,
        ...(signal === undefined ? {} : { signal }),
      });
      const payload = record(await readJsonResponse(response, "kiro enterprise token refresh")) ?? {};
      const access = nonEmptyString(payload["access_token"]);
      if (access === undefined) throw new Error("Kiro enterprise refresh omitted access_token");
      return {
        access,
        ...(nonEmptyString(payload["refresh_token"]) === undefined
          ? {}
          : { refresh: String(payload["refresh_token"]) }),
        expiresAt: this.#expiry(payload["expires_in"]),
      };
    }

    if (authState?.authMethod === "idc" || authState?.authMethod === "builder-id") {
      const clientId = authState.clientId;
      const clientSecret = context?.client_secret;
      if (clientId === undefined || clientSecret === undefined) {
        throw new Error("Kiro IdC refresh is missing its client registration");
      }
      const refreshed = await this.#refreshOidc(
        refreshToken,
        {
          clientId,
          clientSecret,
          region: authState.region,
          startUrl: authState.startUrl ?? KIRO_DEFAULT_START_URL,
          authMethod: authState.authMethod,
        },
        signal,
      );
      const profileArn = refreshed.profileArn ?? authState.profileArn;
      return {
        access: refreshed.access,
        refresh: refreshed.refresh,
        expiresAt: refreshed.expiresAt,
        // The frozen device identity is carried forward, never re-derived: a
        // refresh rotates the refresh token, so deriving here would move the
        // account to a new device on every refresh.
        auth_state: authStateOf({
          ...authState,
          ...(profileArn === undefined ? {} : { profileArn }),
        }),
      };
    }

    const refreshed = await this.#refreshSocial(refreshToken, signal, authState?.machineId);
    const profileArn = refreshed.profileArn ?? authState?.profileArn;
    const nextState: KiroAuthState | undefined =
      authState === undefined
        ? undefined
        : { ...authState, ...(profileArn === undefined ? {} : { profileArn }) };
    return {
      access: refreshed.access,
      refresh: refreshed.refresh,
      expiresAt: refreshed.expiresAt,
      ...(nextState === undefined ? {} : { auth_state: authStateOf(nextState) }),
    };
  }

  /**
   * Registers an OIDC client for the IdC/Builder-ID authorization-code flow.
   *
   * `clientName` and `User-Agent` identify this as the vendor's own IDE client.
   * The registration is the first request a brand-new account ever makes, so it
   * is the one most likely to be looked at: a client name no shipped build uses,
   * or a missing User-Agent, is a shape the real client never produces.
   *
   * The 1.4.62 IDE registers a public client with `authorization_code` grant and
   * the loopback redirect, and declares the issuer (the start URL) so the
   * authorization server knows which organization/portal this client belongs to.
   */
  async #registerClient(
    region: string,
    startUrl: string,
    authMethod: "builder-id" | "idc",
    redirectUri = KIRO_LOOPBACK_REDIRECT_URI,
  ): Promise<DeviceFlowRegistration> {
    const response = await this.fetchFn(`https://oidc.${region}.amazonaws.com/client/register`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "user-agent": buildKiroSsoUserAgent(),
        "x-amz-user-agent": buildKiroSsoAmzUserAgent(),
        "amz-sdk-request": "attempt=1; max=4",
        "amz-sdk-invocation-id": crypto.randomUUID(),
      },
      body: JSON.stringify({
        clientName: KIRO_OIDC_CLIENT_NAME,
        clientType: "public",
        scopes: [...KIRO_SCOPES],
        grantTypes: [...KIRO_GRANT_TYPES],
        redirectUris: [redirectUri],
        issuerUrl: startUrl,
      }),
    });
    const payload = record(await readJsonResponse(response, "kiro client registration")) ?? {};
    const clientId = nonEmptyString(payload["clientId"]);
    const clientSecret = nonEmptyString(payload["clientSecret"]);
    if (clientId === undefined || clientSecret === undefined) {
      throw new Error("Kiro client registration omitted credentials");
    }
    return { clientId, clientSecret, region, startUrl, authMethod, redirectUri };
  }

  /** Refreshes through the regional AWS SSO OIDC token endpoint. */
  async #refreshOidc(
    refreshToken: string,
    registration: Omit<DeviceFlowRegistration, "redirectUri">,
    signal?: AbortSignal,
  ): Promise<{ readonly access: string; readonly refresh: string; readonly expiresAt: Date; readonly profileArn?: string }> {
    const region = assertAwsRegion(registration.region);
    const response = await this.fetchFn(`https://oidc.${region}.amazonaws.com/token`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "user-agent": buildKiroSsoUserAgent(),
        "x-amz-user-agent": buildKiroSsoAmzUserAgent(),
        "amz-sdk-request": "attempt=1; max=4",
        "amz-sdk-invocation-id": crypto.randomUUID(),
      },
      body: JSON.stringify({
        clientId: registration.clientId,
        clientSecret: registration.clientSecret,
        refreshToken,
        grantType: "refresh_token",
      }),
      ...(signal === undefined ? {} : { signal }),
    });
    const payload = record(await readJsonResponse(response, "kiro token refresh")) ?? {};
    const access = nonEmptyString(payload["accessToken"]);
    if (access === undefined) throw new Error("Kiro token refresh omitted accessToken");
    const profileArn = nonEmptyString(payload["profileArn"]);
    return {
      access,
      refresh: nonEmptyString(payload["refreshToken"]) ?? refreshToken,
      expiresAt: this.#expiry(payload["expiresIn"]),
      ...(profileArn === undefined ? {} : { profileArn }),
    };
  }

  /** Refreshes through the vendor's social token service. */
  async #refreshSocial(
    refreshToken: string,
    signal?: AbortSignal,
    machineId?: string,
  ): Promise<{ readonly access: string; readonly refresh: string; readonly expiresAt: Date; readonly profileArn?: string }> {
    const response = await this.fetchFn(`${KIRO_AUTH_SERVICE}/refreshToken`, {
      method: "POST",
      headers: socialServiceHeaders(machineId),
      body: JSON.stringify({ refreshToken }),
      ...(signal === undefined ? {} : { signal }),
    });
    const payload = record(await readJsonResponse(response, "kiro token refresh")) ?? {};
    const access = nonEmptyString(payload["accessToken"]);
    if (access === undefined) throw new Error("Kiro token refresh omitted accessToken");
    const profileArn = nonEmptyString(payload["profileArn"]);
    return {
      access,
      refresh: nonEmptyString(payload["refreshToken"]) ?? refreshToken,
      expiresAt: this.#expiry(payload["expiresIn"]),
      ...(profileArn === undefined ? {} : { profileArn }),
    };
  }

  #expiry(expiresIn: unknown): Date {
    return this.calculateExpiry(expiresIn);
  }
}

/**
 * Signals that an OIDC portal callback needs a second browser leg: the portal
 * returns `login_option=builderid|awsidc` without a code, and the real
 * authorize URL for the regional AWS SSO OIDC service is attached so the route
 * can redirect the operator to it. Carries the fresh PKCE verifier and the
 * serialized registration so `completeLogin` can rewrite the pending flow
 * before sending the browser on — memory alone is not enough across gateways.
 */
export class KiroOidcPendingError extends Error {
  readonly authorizeUrl: string;
  readonly codeVerifier: string;
  readonly providerState: string;
  readonly continueState: string;
  constructor(
    authorizeUrl: string,
    codeVerifier: string,
    providerState: string,
    continueState: string,
  ) {
    super(`Kiro OIDC requires a second authorization step: ${authorizeUrl}`);
    this.name = "KiroOidcPendingError";
    this.authorizeUrl = authorizeUrl;
    this.codeVerifier = codeVerifier;
    this.providerState = providerState;
    this.continueState = continueState;
  }
}

/**
 * Authorize/token redirect for AWS SSO OIDC after a portless registration.
 *
 * Registration always declares `http://127.0.0.1/oauth/callback`. RFC 8252 lets
 * the authorize step add a port on that same host; swapping the host to
 * `localhost` (or any other name) is answered `Invalid redirectUri provided`.
 * Port is taken from the console's loopback callback when present.
 */
function oidcAuthorizeRedirectUri(loopbackCallback: string): string {
  let port = "3128";
  if (loopbackCallback.length > 0) {
    try {
      const parsed = new URL(loopbackCallback);
      if (parsed.port.length > 0) port = parsed.port;
    } catch {
      // keep the Kiro browser default port
    }
  }
  return `http://127.0.0.1:${port}/oauth/callback`;
}

/** Restores a {@link DeviceFlowRegistration} from pending-flow providerState. */
function parseRegistration(providerState: string | undefined): DeviceFlowRegistration | undefined {
  if (providerState === undefined || providerState.length === 0) return undefined;
  const parsed = safeJson(providerState);
  const root = record(parsed);
  if (root === undefined) return undefined;
  const clientId = nonEmptyString(root["clientId"]);
  const clientSecret = nonEmptyString(root["clientSecret"]);
  const region = nonEmptyString(root["region"]);
  const startUrl = nonEmptyString(root["startUrl"]);
  const authMethod = root["authMethod"] === "idc" || root["authMethod"] === "builder-id"
    ? root["authMethod"]
    : undefined;
  const redirectUri = nonEmptyString(root["redirectUri"]) ?? KIRO_LOOPBACK_REDIRECT_URI;
  if (
    clientId === undefined ||
    clientSecret === undefined ||
    region === undefined ||
    startUrl === undefined ||
    authMethod === undefined
  ) {
    return undefined;
  }
  return { clientId, clientSecret, region, startUrl, authMethod, redirectUri };
}

/** Parses JSON without throwing. */
function safeJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

/** Normalizes a scope list or space-delimited string. */
function normalizeScope(value: unknown): string {
  if (Array.isArray(value)) {
    return value
      .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
      .filter((entry) => entry.length > 0)
      .join(" ");
  }
  return typeof value === "string" ? value.trim() : "";
}

/** Reads an absolute or relative expiry out of imported JSON. */
function readExpiry(raw: Record<string, unknown>): Date | undefined {
  const explicit = raw["expired"] ?? raw["expires_at"] ?? raw["expiresAt"];
  if (typeof explicit === "string" && explicit.trim().length > 0) {
    const ms = new Date(explicit).getTime();
    if (Number.isFinite(ms)) return new Date(ms);
  }
  const expiresIn = Number(raw["expires_in"] ?? raw["expiresIn"] ?? 0);
  if (Number.isFinite(expiresIn) && expiresIn > 0) return new Date(Date.now() + expiresIn * 1000);
  return undefined;
}

export const kiroOAuthClient = new KiroOAuthClient();
