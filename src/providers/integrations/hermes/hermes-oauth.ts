// Hermes / Nous Portal OAuth client — RFC 8628 device flow + refresh.
//
// The Hermes Agent (Nous Research) offers a portal subscription via OAuth:
// `hermes setup --portal` runs a device-code flow against Nous Portal, and
// the resulting access token is an inference-scoped JWT spent on the
// OpenAI-compatible inference API. API keys still work for the free roster;
// this OAuth path is the subscription route (300+ models + paid tiers).
//
// Wire sourced from the official Hermes Agent source:
//   - start:  POST {portal}/api/oauth/device/code  (form: client_id, scope)
//   - poll:   POST {portal}/api/oauth/token        (form: grant_type=device_code,
//              client_id, device_code) → {access_token, refresh_token, …}
//   - refresh: POST {portal}/api/oauth/token        (form: grant_type=refresh_token,
//              client_id, refresh_token)

import { OAuthDeviceFlow } from "../../authentication/oauth-device-flow";
import type {
  OAuthDeviceFlowContext,
  OAuthDevicePollResult,
  OAuthDeviceStartResult,
} from "../../authentication/oauth-flow-store";
import type { OAuthTokenRefreshResult } from "../../authentication/oauth-refresh-service";
import { postFormTokenRequest } from "../../authentication/oauth-flow-store";

const NOUS_PORTAL_URL = "https://portal.nousresearch.com";
const NOUS_CLIENT_ID = "hermes-cli";
const NOUS_SCOPE = "inference:invoke";
const NOUS_DEVICE_CODE_PATH = "/api/oauth/device/code";
const NOUS_TOKEN_PATH = "/api/oauth/token";

const FORM_HEADERS = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };

export class HermesOAuthClient extends OAuthDeviceFlow {
  readonly supportsDeviceCode = true;
  readonly supportsBrowserCode = false;
  protected readonly providerLabel = "Hermes / Nous Portal";
  protected readonly clientId = NOUS_CLIENT_ID;
  protected readonly tokenUrl = `${NOUS_PORTAL_URL}${NOUS_TOKEN_PATH}`;
  protected readonly scopes = NOUS_SCOPE;

  override async startDeviceAuth(context?: OAuthDeviceFlowContext): Promise<OAuthDeviceStartResult> {
    const started = await this.startGenericDeviceAuth({
      tokenUrl: this.tokenUrl,
      deviceAuthUrl: `${NOUS_PORTAL_URL}${NOUS_DEVICE_CODE_PATH}`,
      clientId: NOUS_CLIENT_ID,
      scope: NOUS_SCOPE,
      formHeaders: FORM_HEADERS,
      startParams: context?.parameters ?? {},
    }, context);
    return { ...started, providerState: JSON.stringify({ device_code: started.deviceAuthId }) };
  }

  override async pollDeviceAuth(
    deviceAuthId: string,
    context?: OAuthDeviceFlowContext,
  ): Promise<OAuthDevicePollResult> {
    // The generic poll posts the device code and parses RFC 8628 error codes
    // (`authorization_pending`/`slow_down` → pending). Its `complete` result
    // is already a normalized OAuthExchangeResult.
    return this.pollGenericDeviceAuth(deviceAuthId, {
      tokenUrl: this.tokenUrl,
      deviceAuthUrl: `${NOUS_PORTAL_URL}${NOUS_DEVICE_CODE_PATH}`,
      clientId: NOUS_CLIENT_ID,
      scope: NOUS_SCOPE,
      formHeaders: FORM_HEADERS,
    }, context);
  }

  override async refresh(refreshToken: string, signal?: AbortSignal): Promise<OAuthTokenRefreshResult> {
    const payload = await postFormTokenRequest({
      url: this.tokenUrl,
      fetchFn: this.fetchFn,
      params: {
        grant_type: "refresh_token",
        client_id: NOUS_CLIENT_ID,
        refresh_token: refreshToken,
      },
      headers: FORM_HEADERS,
      signal,
      label: "Hermes / Nous Portal token refresh",
    });
    const record = payload as Record<string, unknown>;
    const access = typeof record["access_token"] === "string" ? record["access_token"] : "";
    if (!access) throw new Error("Hermes / Nous Portal refresh returned no access_token");
    const expiresIn = typeof record["expires_in"] === "number" ? record["expires_in"] : 3600;
    return {
      access,
      ...(typeof record["refresh_token"] === "string" ? { refresh: record["refresh_token"] as string } : {}),
      expiresAt: new Date(Date.now() + expiresIn * 1000),
    };
  }
}

export const hermesOAuthClient = new HermesOAuthClient();
