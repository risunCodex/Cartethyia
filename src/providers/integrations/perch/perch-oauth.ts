// Perch OAuth client — Supabase PKCE browser flow + refresh.
//
// Perch authentication is Supabase GoTrue (project
// zlfuvsfjtgsdtqcaykia.supabase.co) with Google/GitHub providers. The web
// client ships only the publishable key (`sb_publishable_...`), which is
// accepted as `apikey` for authorize/token. The authorization code exchange
// is GoTrue-specific: `grant_type=pkce` with `auth_code` as the field name
// (NOT `authorization_code`/`code` — both are rejected with
// `unsupported_grant_type` / `validation_failed`), plus `code_verifier`.
//
// The browser flow is a loopback redirect (`http://127.0.0.1:<port>/callback`)
// exactly like the desktop app's own sign-in controller.
//
// After exchange, the official CLI stamps `user_metadata.signup_source=cli`
// (used by the server for surface entitlement); we repeat that so the account
// is recognized as a CLI surface.

import { OAuthClient } from "../../authentication/oauth-client";
import type { OAuthAuthorizeRequest, OAuthExchangeResult } from "../../authentication/oauth-flow-store";
import { postJsonTokenRequest } from "../../authentication/oauth-flow-store";
import type { OAuthTokenRefreshResult } from "../../authentication/oauth-refresh-service";
import {
  PERCH_APP_URL,
  PERCH_SUPABASE_HOST,
  PERCH_SUPABASE_PUBLISHABLE_KEY,
} from "./perch-realm";

const PERCH_SUPABASE_URL = `https://${PERCH_SUPABASE_HOST}`;
const PERCH_AUTHORIZE_PATH = "/auth/v1/authorize";
const PERCH_TOKEN_PATH = "/auth/v1/token";
const PERCH_GRANT_PKCE = "pkce";
const PERCH_GRANT_REFRESH = "refresh_token";
const PERCH_APISEY_COOKIE = "apikey";

export class PerchOAuthClient extends OAuthClient {
  readonly supportsDeviceCode = false;
  override readonly supportsBrowserCode = true;
  protected readonly providerLabel = "Perch";
  protected readonly clientId = PERCH_SUPABASE_PUBLISHABLE_KEY;
  protected readonly tokenUrl = `${PERCH_SUPABASE_URL}${PERCH_TOKEN_PATH}`;
  protected override readonly authorizeUrl = `${PERCH_SUPABASE_URL}${PERCH_AUTHORIZE_PATH}`;
  // Google validates scopes for accounts that never approved this client; a
  // missing scope answers `Error 400: invalid_request / Missing required
  // parameter: scope` (flowName=GeneralOAuthFlow). These are the GoTrue
  // default Google scopes, sent explicitly.
  protected readonly scopes = "openid email profile";

  /** Loopback callback path (the desktop app uses the same shape). */
  override readonly browserRedirectUri = "http://127.0.0.1:1455/callback";

  /**
   * GoTrue token responses carry the signed-in user (`user.email`). Without
   * this the exchange falls back to the provider id as the account label and
   * every login of every Perch account collides on the same identity
   * fingerprint — the second login replaces the first instead of adding a new
   * row.
   */
  protected override extractAccountLabel(data: unknown): string | undefined {
    const body = data as { user?: { email?: unknown } } | null | undefined;
    const email = typeof body?.user?.email === "string" ? body.user.email.trim() : "";
    return email.length > 0 ? email : undefined;
  }

  protected override extraAuthorizeParams(): Record<string, string> | undefined {
    return {
      provider: "google",
    };
  }

  /**
   * Supabase's authorize endpoint speaks `redirect_to`, not the RFC-style
   * `redirect_uri` the shared PKCE helper emits — a call redirected to a
   * `redirect_uri` value lands on a Supabase error page.
   *
   * GoTrue does NOT echo the `state` parameter on the callback — the redirect
   * back to `redirect_to` carries only `?code=...` (verified live). The
   * console's callback listener correlates by `state` and fails closed when
   * state is absent, so the state is embedded in `redirect_to` itself:
   * `http://127.0.0.1:1455/callback?state=<state>`. Supabase preserves the
   * query it was given and appends `code`, so the callback carries both.
   */
  override buildAuthorizeUrl(request: OAuthAuthorizeRequest): string {
    const redirectTo = new URL(request.redirectUri);
    redirectTo.searchParams.set("state", request.state);
    const params = new URLSearchParams({
      provider: "google",
      client_id: this.clientId,
      response_type: "code",
      redirect_to: redirectTo.toString(),
      scope: this.scopes,
      state: request.state,
      code_challenge: request.codeChallenge,
      code_challenge_method: "S256",
    });
    return `${this.authorizeUrl}?${params.toString()}`;
  }

  /**
   * GoTrue exchange: `grant_type=pkce` (query) with `auth_code` (body) —
   * not the RFC-style `authorization_code`/`code` pair the generic base
   * class posts. GoTrue v2.197.0 accepts **only JSON** bodies here (a form
   * body answers `bad_json`), so this overrides the form-encoded generic
   * helper. The apikey goes in the header (not as `client_id`).
   *
   * The console's `exchangeCode` passes the flow state; it must be replayed
   * in `redirect_to` exactly as `buildAuthorizeUrl` embedded it, because
   * GoTrue compares the exchange redirect against the authorize one.
   */
  override async exchangeCode(
    code: string,
    codeVerifier: string,
    redirectUri: string,
    state?: string,
  ): Promise<OAuthExchangeResult> {
    const redirectTo = new URL(redirectUri);
    if (state) redirectTo.searchParams.set("state", state);
    const response = await postJsonTokenRequest({
      url: `${this.tokenUrl}?grant_type=${PERCH_GRANT_PKCE}`,
      fetchFn: this.fetchFn,
      body: {
        auth_code: code,
        redirect_to: redirectTo.toString(),
        code_verifier: codeVerifier,
      },
      headers: {
        accept: "application/json",
        [PERCH_APISEY_COOKIE]: PERCH_SUPABASE_PUBLISHABLE_KEY,
      },
      label: "Perch token exchange",
    });
    const result = this.toExchangeResult(this.parseTokenResponse(response));
    await this.#stampCliSignup(result.access).catch(() => undefined);
    return result;
  }

  override async refresh(refreshToken: string, signal?: AbortSignal): Promise<OAuthTokenRefreshResult> {
    const response = await postJsonTokenRequest({
      url: `${this.tokenUrl}?grant_type=${PERCH_GRANT_REFRESH}`,
      fetchFn: this.fetchFn,
      body: {
        refresh_token: refreshToken,
      },
      headers: {
        accept: "application/json",
        [PERCH_APISEY_COOKIE]: PERCH_SUPABASE_PUBLISHABLE_KEY,
      },
      ...(signal === undefined ? {} : { signal }),
      label: "Perch token refresh",
    });
    return this.toRefreshResult(this.parseTokenResponse(response));
  }

  /** The CLI stamps `signup_source=cli` after login; mirror it. */
  async #stampCliSignup(access: string): Promise<void> {
    await this.fetchFn(`${PERCH_SUPABASE_URL}/auth/v1/user`, {
      method: "PUT",
      headers: {
        apikey: PERCH_SUPABASE_PUBLISHABLE_KEY,
        Authorization: `Bearer ${access}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ data: { signup_source: "cli" } }),
    });
  }

  /** The app origin the CLI writes into its session file. */
  readonly appUrl = PERCH_APP_URL;
}

export const perchOAuthClient = new PerchOAuthClient();
