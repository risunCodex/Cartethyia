/**
 * Generic OAuth 2.0 base class for provider-specific OAuth clients.
 *
 * Encapsulates common PKCE, device-code, token-exchange and refresh logic
 * while exposing protected hooks for provider-specific customizations.
 */
import {
  buildPkceAuthorizeUrl as buildPkceAuthorizeUrlShared,
  expiryFromSeconds,
  nonEmptyString,
  postFormTokenRequest,
  record,
} from "./oauth-flow-store";
import type {
  OAuthAccountIdentity,
  OAuthAuthorizeRequest,
  OAuthCodeExchangeContext,
  OAuthExchangeResult,
  OAuthLoginClient,
} from "./oauth-flow-store";
import { oauthAccountIdentity } from "./oauth-flow-store";
import type { OAuthTokenRefreshResult, OAuthTokenRefresher } from "./oauth-refresh-service";

/** Minimal fetch surface accepted by the generic OAuth client. */
export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** Normalized token shape returned by provider token endpoints. */
export interface NormalizedTokenResponse extends OAuthAccountIdentity {
  readonly access: string;
  readonly refresh: string;
  readonly expiresAt: Date;
  readonly accountLabel?: string | undefined;
  /**
   * Identity the flow learned beside the tokens — an upstream user id the
   * token itself does not carry. Threaded through both converters so a
   * provider that resolves it during login does not lose it on the way to
   * storage, and can refresh it later without a second round trip.
   */
  readonly auth_state?: Readonly<Record<string, unknown>> | undefined;
}

/** Options for building a PKCE authorize URL. */
interface PkceAuthorizeOptions {
  readonly clientId: string;
  readonly authorizeUrl: string;
  readonly redirectUri: string;
  readonly scope: string;
  readonly state: string;
  readonly codeChallenge: string;
  readonly extra?: Record<string, string> | undefined;
}

/** Options for a form-encoded token exchange or refresh. */
interface FormTokenOptions {
  readonly url: string;
  readonly params: Record<string, string>;
  readonly headers?: Record<string, string>;
  readonly signal?: AbortSignal;
  readonly label: string;
}


/** Base class for provider OAuth clients. */
export abstract class OAuthClient implements OAuthLoginClient, OAuthTokenRefresher {
  /** Provider display label used in error messages. */
  protected abstract readonly providerLabel: string;
  /** OAuth client id. */
  protected abstract readonly clientId: string;
  /** Token endpoint URL. */
  protected abstract readonly tokenUrl: string;
  /** Authorization endpoint URL (omit for device-only providers). */
  protected readonly authorizeUrl?: string;
  /** Space-separated OAuth scopes. */
  protected abstract readonly scopes: string;

  /** Whether the provider supports the device-code flow. */
  abstract readonly supportsDeviceCode: boolean;
  /** Whether the provider supports browser PKCE authorization. */
  abstract readonly supportsBrowserCode: boolean;
  /**
   * Loopback/native redirect URI this client's authorization server
   * allowlists, when it differs from the gateway-wide default. Declared here so
   * a client can state it without the console route reaching into provider
   * specifics; see `OAuthLoginClient.browserRedirectUri`.
   */
  readonly browserRedirectUri?: string;

  /**
   * Custom state generator; `undefined` keeps the shared base64url state.
   * A provider whose authorization server validates the format (e.g. DeepAI
   * requires 32 hex chars) overrides this.
   */
  generateState(): string | undefined {
    return undefined;
  }

  protected readonly fetchFn: FetchLike;

  constructor(fetchFn: FetchLike = globalThis.fetch) {
    this.fetchFn = fetchFn;
  }

  /**
   * Resolves the transport a flow should use. When the console injects a
   * `fetchFn` in the flow context (device-code OAuth routed through a network
   * pool, see `device_flow_proxy`), that override wins; otherwise the
   * client's own fetch is used. Every start/poll/exchange request that talks
   * to the provider MUST route through this so the override is honored.
   */
  protected fetchFor(context?: { readonly fetchFn?: FetchLike | undefined }): FetchLike {
    return context?.fetchFn ?? this.fetchFn;
  }

  // ---------------------------------------------------------------------------
  // Public OAuthLoginClient surface
  // ---------------------------------------------------------------------------

  buildAuthorizeUrl(request: OAuthAuthorizeRequest): string {
    if (!this.authorizeUrl) {
      throw new Error(`${this.providerLabel} does not support browser authorization`);
    }
    return this.buildPkceAuthorizeUrl({
      clientId: this.clientId,
      authorizeUrl: this.authorizeUrl,
      redirectUri: request.redirectUri,
      scope: this.scopes,
      state: request.state,
      codeChallenge: request.codeChallenge,
      extra: this.extraAuthorizeParams(),
    });
  }

  async exchangeCode(
    code: string,
    codeVerifier: string,
    redirectUri: string,
    _state?: string,
    _context?: OAuthCodeExchangeContext,
  ): Promise<OAuthExchangeResult> {
    if (!this.supportsBrowserCode) {
      throw new Error(`${this.providerLabel} does not support browser code exchange`);
    }
    return this.exchangeCodeVia(code, codeVerifier, redirectUri);
  }

  refresh(_refreshToken: string, _signal?: AbortSignal): Promise<OAuthTokenRefreshResult> {
    throw new Error(`${this.providerLabel} does not support token refresh`);
  }

  // ---------------------------------------------------------------------------
  // Protected hooks
  // ---------------------------------------------------------------------------

  /** Extra query parameters appended to the PKCE authorize URL. */
  protected extraAuthorizeParams(): Record<string, string> | undefined {
    return undefined;
  }

  /** Extracts an account label from a token exchange/refresh response. */
  protected extractAccountLabel(data: unknown): string | undefined {
    const identity = oauthAccountIdentity(data);
    return identity.accountEmail ?? identity.accountName;
  }

  /** Calculates an expiry Date from an `expires_in` value. */
  protected calculateExpiry(expiresIn: unknown, fallbackSeconds = 3600): Date {
    const seconds =
      typeof expiresIn === "number" && Number.isFinite(expiresIn) && expiresIn >= 0
        ? expiresIn
        : fallbackSeconds;
    return expiryFromSeconds(seconds);
  }

  /**
   * Parses a standard token response object into a normalized result.
   *
   * Fails when the response carries no `access_token`. Returning an empty
   * access value instead let a poll report `complete` with an unusable
   * credential: the account was persisted and the browser saw success, while
   * the gateway then dispatched with an empty bearer. A token endpoint that
   * answers 2xx without a token is a failure, whatever the status code says —
   * an `error` field in a 200 body is exactly that case. An empty refresh
   * token is still allowed, because several providers legitimately issue an
   * access-only credential.
   */
  protected parseTokenResponse(data: unknown, fallbackRefresh?: string): NormalizedTokenResponse {
    const body = record(data) ?? {};
    const access = nonEmptyString(body.access_token);
    if (access === undefined) {
      const detail = nonEmptyString(body.error_description) ?? nonEmptyString(body.error);
      throw new Error(
        `${this.providerLabel} token response omitted access_token${detail === undefined ? "" : `: ${detail}`}`,
      );
    }
    const refresh = nonEmptyString(body.refresh_token) ?? fallbackRefresh ?? "";
    const expiresAt = this.calculateExpiry(body.expires_in);
    const accountLabel = this.extractAccountLabel(data);
    const identity = oauthAccountIdentity(data);
    return {
      access,
      refresh,
      expiresAt,
      ...identity,
      ...(accountLabel ? { accountLabel } : {}),
    };
  }

  /** Builds a PKCE authorization URL using the shared helper. */
  protected buildPkceAuthorizeUrl(options: PkceAuthorizeOptions): string {
    return buildPkceAuthorizeUrlShared({
      clientId: options.clientId,
      authorizeUrl: options.authorizeUrl,
      redirectUri: options.redirectUri,
      scope: options.scope,
      state: options.state,
      codeChallenge: options.codeChallenge,
      ...(options.extra === undefined ? {} : { extra: options.extra }),
    });
  }

  // ---------------------------------------------------------------------------
  // Shared token request helpers
  // ---------------------------------------------------------------------------

  protected async postFormToken(options: FormTokenOptions): Promise<unknown> {
    return postFormTokenRequest({
      url: options.url,
      fetchFn: this.fetchFn,
      params: options.params,
      ...(options.headers === undefined ? {} : { headers: options.headers }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      label: options.label,
    });
  }

  /** Exchanges a browser authorization code using an explicit callback redirect. */
  protected async exchangeCodeVia(
    code: string,
    codeVerifier: string,
    redirectUri: string,
    extraParams: Record<string, string> = {},
  ): Promise<OAuthExchangeResult> {
    const response = await this.postFormToken({
      url: this.tokenUrl,
      params: {
        client_id: this.clientId,
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        code_verifier: codeVerifier,
        ...extraParams,
      },
      label: `${this.providerLabel} token exchange`,
    });
    return this.toExchangeResult(this.parseTokenResponse(response));
  }


  // ---------------------------------------------------------------------------
  // Converters
  // ---------------------------------------------------------------------------

  protected toExchangeResult(normalized: NormalizedTokenResponse): OAuthExchangeResult {
    const { access, refresh, expiresAt, accountLabel, accountEmail, accountName, auth_state } = normalized;
    return {
      access,
      refresh,
      expiresAt,
      ...(accountEmail === undefined ? {} : { accountEmail }),
      ...(accountName === undefined ? {} : { accountName }),
      ...(accountLabel ? { accountLabel } : {}),
      ...(auth_state === undefined ? {} : { auth_state }),
    };
  }

  protected toRefreshResult(normalized: NormalizedTokenResponse): OAuthTokenRefreshResult {
    const { access, refresh, expiresAt, accountLabel, accountEmail, accountName, auth_state } = normalized;
    return {
      access,
      ...(refresh ? { refresh } : {}),
      expiresAt,
      ...(accountEmail === undefined ? {} : { accountEmail }),
      ...(accountName === undefined ? {} : { accountName }),
      ...(accountLabel ? { accountLabel } : {}),
      ...(auth_state === undefined ? {} : { auth_state }),
    };
  }
}
