import {
  devicePollBackoff,
  expiryFromSeconds,
  nonEmptyTrimmedString,
  parseDeviceAuthStart,
  postJsonTokenRequest,
  readJsonResponse,
  record,
} from "../../authentication/oauth-flow-store";
import type { OAuthDeviceFlowContext, OAuthDevicePollResult, OAuthDeviceStartResult, OAuthExchangeResult } from "../../authentication/oauth-flow-store";
import { oauthAccountIdentity } from "../../authentication/oauth-flow-store";
import type { OAuthTokenRefreshResult } from "../../authentication/oauth-refresh-service";
import { OAuthDeviceFlow } from "../../authentication/oauth-device-flow";

const WORKOS_API_BASE_URL = "https://api.workos.com";
const WORKOS_DEVICE_AUTHORIZATION_URL = `${WORKOS_API_BASE_URL}/user_management/authorize/device`;
const WORKOS_AUTHENTICATE_URL = `${WORKOS_API_BASE_URL}/user_management/authenticate`;
const CLINE_REGISTER_URL = "https://api.cline.bot/api/v1/auth/register";
const CLINE_REFRESH_URL = "https://api.cline.bot/api/v1/auth/refresh";
const WORKOS_DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const CLINE_WORKOS_CLIENT_ID = "client_01K3A541FN8TA3EPPHTD2325AR";
const DEVICE_EXPIRY_SECONDS = 300;
const DEVICE_INTERVAL_SECONDS = 5;

interface DeviceSession {
  readonly expiresAtMs: number;
}

function tokenPayload(value: unknown): Record<string, unknown> {
  const root = record(value) ?? {};
  return record(root.data) ?? root;
}

function tokenExpiry(payload: Record<string, unknown>): Date {
  const absolute = nonEmptyTrimmedString(payload.expiresAt) ?? nonEmptyTrimmedString(payload.expires_at);
  if (absolute !== undefined) {
    const parsed = new Date(absolute);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return expiryFromSeconds(payload.expires_in ?? payload.expiresIn, 3600);
}

function tokenResult(value: unknown, fallbackRefresh?: string): OAuthExchangeResult {
  const payload = tokenPayload(value);
  const access = nonEmptyTrimmedString(payload.access_token) ?? nonEmptyTrimmedString(payload.accessToken) ?? nonEmptyTrimmedString(payload.token);
  const refresh =
    nonEmptyTrimmedString(payload.refresh_token) ?? nonEmptyTrimmedString(payload.refreshToken) ?? fallbackRefresh;
  if (!access || !refresh) throw new Error("Cline OAuth response omitted access or refresh token");
  const identity = oauthAccountIdentity(value);
  const accountLabel =
    nonEmptyTrimmedString(payload.email) ??
    nonEmptyTrimmedString(record(payload.userInfo)?.email) ??
    nonEmptyTrimmedString(record(payload.user)?.email) ??
    identity.accountEmail ??
    identity.accountName;
  return {
    access,
    refresh,
    expiresAt: tokenExpiry(payload),
    ...identity,
    ...(accountLabel === undefined ? {} : { accountLabel }),
  };
}

async function parseJson(response: Response, label: string): Promise<Record<string, unknown>> {
  return (await readJsonResponse(response, label).then(tokenPayload)) as Record<string, unknown>;
}

async function parseJsonAllowingError(response: Response, label: string): Promise<Record<string, unknown>> {
  const body = await response.text();
  try {
    const parsed = JSON.parse(body) as unknown;
    return tokenPayload(parsed);
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
}

function sessionFromProviderState(value: string | undefined): DeviceSession | undefined {
  if (value === undefined) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    const state = record(parsed);
    const expiresAtMs = state === undefined ? undefined : Number(state.expiresAtMs);
    return expiresAtMs !== undefined && Number.isFinite(expiresAtMs) && expiresAtMs > 0
      ? { expiresAtMs }
      : undefined;
  } catch {
    return undefined;
  }
}

/** Cline WorkOS device-code OAuth client under the canonical `cline` provider. */
export class ClineOAuthClient extends OAuthDeviceFlow {
  override readonly supportsDeviceCode = true;
  override readonly supportsBrowserCode = false;

  protected override readonly providerLabel = "Cline";
  protected override readonly clientId = CLINE_WORKOS_CLIENT_ID;
  protected override readonly tokenUrl = WORKOS_AUTHENTICATE_URL;
  protected override readonly scopes = "";

  readonly #sessions = new Map<string, DeviceSession>();

  static readonly #MAX_SESSIONS = 1024;

  #boundSessions(): void {
    while (this.#sessions.size > ClineOAuthClient.#MAX_SESSIONS) {
      const oldest = this.#sessions.keys().next().value;
      if (oldest === undefined) break;
      this.#sessions.delete(oldest);
    }
  }

  override async startDeviceAuth(context?: OAuthDeviceFlowContext): Promise<OAuthDeviceStartResult> {
    const response = await this.fetchFor(context)(WORKOS_DEVICE_AUTHORIZATION_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ client_id: CLINE_WORKOS_CLIENT_ID }),
    });
    const payload = await parseJson(response, "Cline WorkOS device authorization");
    const start = parseDeviceAuthStart(payload, {
      intervalSeconds: DEVICE_INTERVAL_SECONDS,
      expiresInSeconds: DEVICE_EXPIRY_SECONDS,
    });
    if (!start) {
      throw new Error("Cline WorkOS device authorization returned missing device credentials");
    }
    const expiresAtMs = Date.now() + start.expiresInSeconds * 1000;
    this.#sessions.set(start.deviceCode, { expiresAtMs });
    this.#boundSessions();
    // WorkOS returns `verification_uri_complete`, which already carries the
    // user code in its query string. Preferring it is what makes the flow
    // one click: the operator opens the page and the code is entered for them.
    // Publishing only `verification_uri` forced them to read the code here and
    // type it into the form by hand.
    return {
      verificationUri: start.verificationUriComplete ?? start.verificationUri,
      userCode: start.userCode,
      deviceAuthId: start.deviceCode,
      intervalSeconds: start.intervalSeconds,
      expiresInSeconds: start.expiresInSeconds,
      providerState: JSON.stringify({ expiresAtMs }),
    };
  }

  override async pollDeviceAuth(deviceAuthId: string, context?: OAuthDeviceFlowContext): Promise<OAuthDevicePollResult> {
    const session = this.#sessions.get(deviceAuthId) ?? sessionFromProviderState(context?.providerState);
    if (!session || session.expiresAtMs <= Date.now()) {
      this.#sessions.delete(deviceAuthId);
      return { status: "failed", reason: "Cline device authorization expired" };
    }
    const response = await this.fetchFor(context)(WORKOS_AUTHENTICATE_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        grant_type: WORKOS_DEVICE_GRANT,
        device_code: deviceAuthId,
        client_id: CLINE_WORKOS_CLIENT_ID,
      }),
    });
    // An unparseable poll body is a failed verdict, not an exception: throwing
    // here kills the dashboard's poll request instead of returning a reason.
    let payload: Record<string, unknown>;
    try {
      payload = await parseJsonAllowingError(response, "Cline WorkOS device polling");
    } catch (error) {
      return { status: "failed", reason: error instanceof Error ? error.message : "Cline WorkOS device polling returned invalid JSON" };
    }
    const error = nonEmptyTrimmedString(payload.error);
    if (!response.ok) {
      const verdict = devicePollBackoff(error, payload.interval);
      if (verdict !== undefined) return verdict;
    }
    if (!response.ok) {
      this.#sessions.delete(deviceAuthId);
      return {
        status: "failed",
        reason: nonEmptyTrimmedString(payload.error_description) ?? `Cline device polling failed (${response.status})`,
      };
    }
    const accessToken = nonEmptyTrimmedString(payload.access_token);
    const refreshToken = nonEmptyTrimmedString(payload.refresh_token);
    if (!accessToken || !refreshToken) {
      this.#sessions.delete(deviceAuthId);
      return { status: "failed", reason: "Cline WorkOS token response omitted access or refresh token" };
    }
    // Registration runs after the user approved: a transient outage here must
    // surface as a failed verdict (retryable by restarting) rather than an
    // exception that escapes the poll.
    let registered: Record<string, unknown>;
    try {
      const registerResponse = await this.fetchFor(context)(CLINE_REGISTER_URL, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ accessToken, refreshToken }),
      });
      registered = await parseJson(registerResponse, "Cline token registration");
    } catch (error) {
      this.#sessions.delete(deviceAuthId);
      return { status: "failed", reason: error instanceof Error ? error.message : "Cline token registration failed" };
    }
    this.#sessions.delete(deviceAuthId);
    try {
      return { status: "complete", result: tokenResult(registered, refreshToken) };
    } catch (error) {
      return { status: "failed", reason: error instanceof Error ? error.message : "Cline OAuth response omitted access or refresh token" };
    }
  }

  override async refresh(refreshToken: string, signal?: AbortSignal): Promise<OAuthTokenRefreshResult> {
    const payload = await postJsonTokenRequest({
      url: CLINE_REFRESH_URL,
      fetchFn: this.fetchFn,
      body: { refreshToken, grantType: "refresh_token" },
      signal,
      timeoutMs: 15_000,
      label: "Cline OAuth refresh",
    });
    return tokenResult(payload, refreshToken);
  }
}

export const clineOAuthClient = new ClineOAuthClient();
