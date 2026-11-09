/** xAI Grok Build device-code OAuth client. */
import { devicePollBackoff, nonEmptyTrimmedString, parseDeviceAuthStart, postFormTokenRequest, readJsonResponse, record } from "../../authentication/oauth-flow-store";
import type {
  OAuthDeviceFlowContext,
  OAuthDevicePollResult,
  OAuthDeviceStartResult,
  OAuthExchangeResult,
} from "../../authentication/oauth-flow-store";
import type { OAuthTokenRefreshResult } from "../../authentication/oauth-refresh-service";
import { OAuthDeviceFlow } from "../../authentication/oauth-device-flow";
import type { FetchLike, NormalizedTokenResponse } from "../../authentication/oauth-client";
import { XAI_AUTH_SERVER } from "../xai/xai-oauth";

/**
 * The Grok Build client registers against the same authorization server as
 * the xAI subscription client, so the client id and the device/token
 * endpoints are read from the one declaration rather than restated here.
 */
export const GROK_CLIENT_ID = XAI_AUTH_SERVER.clientId;
export const GROK_DEVICE_URL = XAI_AUTH_SERVER.deviceUrl;
export const GROK_TOKEN_URL = XAI_AUTH_SERVER.tokenUrl;
export const GROK_USER_URL = "https://cli-chat-proxy.grok.com/v1/user" as const;
export const GROK_SCOPE = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "grok-cli:access",
  "api:access",
  "conversations:read",
  "conversations:write",
  "workspaces:read",
  "workspaces:write",
].join(" ");
import {
  buildGrokAuthUserAgent,
  getGrokVersion,
} from "../../operations/client-versions";

interface TokenPayload {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  error?: unknown;
  error_description?: unknown;
  interval?: unknown;
}
interface UserPayload {
  email?: unknown;
  userId?: unknown;
  principalId?: unknown;
  firstName?: unknown;
  lastName?: unknown;
  hasGrokCodeAccess?: unknown;
  subscriptionTier?: unknown;
}

/**
 * Identity Grok's proxy reports, kept beyond the display label.
 *
 * `userId`/`principalId` are the account's upstream identity — the token does
 * not carry them and the gateway cannot derive them, so they are persisted in
 * `auth_state` rather than thrown away once the label is chosen.
 */
interface GrokIdentity {
  readonly label?: string | undefined;
  readonly userId?: string | undefined;
  readonly principalId?: string | undefined;
  readonly hasGrokCodeAccess?: boolean | undefined;
  readonly subscriptionTier?: string | undefined;
}

function grokAuthState(identity: GrokIdentity): Record<string, unknown> | undefined {
  const state: Record<string, unknown> = {};
  if (identity.userId !== undefined) state["userId"] = identity.userId;
  if (identity.principalId !== undefined) state["principalId"] = identity.principalId;
  if (identity.hasGrokCodeAccess !== undefined)
    state["hasGrokCodeAccess"] = identity.hasGrokCodeAccess;
  if (identity.subscriptionTier !== undefined)
    state["subscriptionTier"] = identity.subscriptionTier;
  return Object.keys(state).length > 0 ? state : undefined;
}

async function fetchGrokIdentity(
  accessToken: string,
  fetcher: FetchLike,
): Promise<GrokIdentity> {
  try {
    const version = getGrokVersion();
    const response = await fetcher(GROK_USER_URL, {
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: "application/json",
        "user-agent": buildGrokAuthUserAgent(version),
        "x-xai-token-auth": "xai-grok-cli",
        "x-grok-client-version": version,
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return {};
    const payload = (await response.json()) as UserPayload;
    const displayName =
      [nonEmptyTrimmedString(payload.firstName), nonEmptyTrimmedString(payload.lastName)]
        .filter((part): part is string => part !== undefined)
        .join(" ")
        .trim() || undefined;
    return {
      label:
        displayName ??
        nonEmptyTrimmedString(payload.email) ??
        nonEmptyTrimmedString(payload.userId) ??
        nonEmptyTrimmedString(payload.principalId),
      ...(nonEmptyTrimmedString(payload.userId) === undefined
        ? {}
        : { userId: nonEmptyTrimmedString(payload.userId)! }),
      ...(nonEmptyTrimmedString(payload.principalId) === undefined
        ? {}
        : { principalId: nonEmptyTrimmedString(payload.principalId)! }),
      ...(typeof payload.hasGrokCodeAccess === "boolean"
        ? { hasGrokCodeAccess: payload.hasGrokCodeAccess }
        : {}),
      ...(nonEmptyTrimmedString(payload.subscriptionTier) === undefined
        ? {}
        : { subscriptionTier: nonEmptyTrimmedString(payload.subscriptionTier)! }),
    };
  } catch {
    return {};
  }
}

function authHeaders(): Record<string, string> {
  const version = getGrokVersion();
  return {
    "content-type": "application/x-www-form-urlencoded",
    accept: "application/json",
    "user-agent": buildGrokAuthUserAgent(version),
    "x-grok-client-version": version,
    "x-grok-client-surface": "ui",
  };
}

/** Device-code OAuth client for Grok Build CLI subscriptions. */
export class GrokOAuthClient extends OAuthDeviceFlow {
  override readonly supportsDeviceCode = true;
  override readonly supportsBrowserCode = false;

  protected override readonly providerLabel = "grok";
  protected override readonly clientId = GROK_CLIENT_ID;
  protected override readonly tokenUrl = GROK_TOKEN_URL;
  protected override readonly scopes = GROK_SCOPE;

  override async startDeviceAuth(_context?: OAuthDeviceFlowContext): Promise<OAuthDeviceStartResult> {
    const body = new URLSearchParams({
      client_id: GROK_CLIENT_ID,
      scope: GROK_SCOPE,
      referrer: "grok-build",
    });
    const response = await this.fetchFn(GROK_DEVICE_URL, {
      method: "POST",
      headers: authHeaders(),
      body,
    });
    const payload = await readJsonResponse(response, "grok device authorization");
    // The device correlation lives in Redis with the store's 900 s TTL: a
    // longer advertised lifetime would outlive the correlation and force a
    // restart at 900 s even when the provider code is still valid.
    const start = parseDeviceAuthStart(payload, {
      intervalSeconds: 5,
      expiresInSeconds: 900,
    });
    if (!start) throw new Error("grok device response omitted required fields");
    return {
      verificationUri: start.verificationUriComplete ?? start.verificationUri,
      userCode: start.userCode,
      deviceAuthId: start.deviceCode,
      intervalSeconds: start.intervalSeconds,
      expiresInSeconds: start.expiresInSeconds,
    };
  }

  override async pollDeviceAuth(deviceAuthId: string, _context?: OAuthDeviceFlowContext): Promise<OAuthDevicePollResult> {
    return this.pollGenericDeviceAuth(deviceAuthId, {
      tokenUrl: GROK_TOKEN_URL,
      deviceAuthUrl: GROK_DEVICE_URL,
      clientId: GROK_CLIENT_ID,
      formHeaders: authHeaders(),
    });
  }

  protected override unparsablePollReason(_status: number): string {
    return "grok token endpoint returned invalid JSON";
  }

  protected override preVerdict(payload: unknown): OAuthDevicePollResult | undefined {
    const root = record(payload) ?? {};
    // Grok votes on the `error` field before the status: a 200 body can still
    // state the poll state, and a pending/slow_down answer is honored wherever
    // it appears on the wire.
    return devicePollBackoff(nonEmptyTrimmedString(root.error), root.interval);
  }

  protected override pollFailureReason(
    status: number,
    errorKey: string | undefined,
    errorDescription: string | undefined,
  ): string {
    // Grok's wire prefers the human-readable description over the error code,
    // and falls back to the generic phrasing only when both are absent.
    return nonEmptyTrimmedString(errorDescription) ?? nonEmptyTrimmedString(errorKey) ?? `token polling failed (${status})`;
  }

  protected override missingTokenReason(errorKey: string | undefined, errorDescription: string | undefined): string {
    // A 2xx is not by itself a completed authorization: the endpoint can answer
    // 200 with an `error` field and no token. Returning `failed` rather than
    // letting the shared parser throw keeps the verdict inside the poll
    // contract — the dashboard's poll error path stops polling but shows no
    // reason, so a throw would look like a spinner that never ends.
    return nonEmptyTrimmedString(errorDescription) ?? nonEmptyTrimmedString(errorKey) ?? "grok token response omitted access_token";
  }

  protected override async afterDeviceTokenExchange(
    _payload: unknown,
    normalized: NormalizedTokenResponse,
  ): Promise<OAuthExchangeResult> {
    const identity = await fetchGrokIdentity(normalized.access, this.fetchFn);
    const authState = grokAuthState(identity);
    return this.toExchangeResult({
      ...normalized,
      ...(identity.label === undefined ? {} : { accountLabel: identity.label }),
      // Omitted when the proxy reported nothing, which leaves any stored
      // state alone rather than blanking it.
      ...(authState === undefined ? {} : { auth_state: authState }),
    });
  }

  override async refresh(refreshToken: string, signal?: AbortSignal): Promise<OAuthTokenRefreshResult> {
    const payload = (await postFormTokenRequest({
      url: GROK_TOKEN_URL,
      fetchFn: this.fetchFn,
      params: {
        grant_type: "refresh_token",
        client_id: GROK_CLIENT_ID,
        refresh_token: refreshToken,
      },
      headers: authHeaders(),
      signal,
      timeoutMs: 15_000,
      label: "grok token refresh",
    })) as TokenPayload;
    const result = this.parseTokenResponse(payload, refreshToken);
    // Re-read the identity on refresh: a persisted id that went stale is
    // otherwise never corrected, and the call is best-effort — a failure
    // returns nothing, which the store reads as "keep what we have".
    const identity = await fetchGrokIdentity(result.access, this.fetchFn);
    const authState = grokAuthState(identity);
    return this.toRefreshResult({
      ...result,
      ...(identity.label === undefined ? {} : { accountLabel: identity.label }),
      ...(authState === undefined ? {} : { auth_state: authState }),
    });
  }
}

export const grokOAuthClient = new GrokOAuthClient();
