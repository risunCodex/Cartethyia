import {
  decodeJwtPayload,
  expiryFromSeconds,
  nonEmptyTrimmedString,
  readJsonResponse,
  record,
} from "../../authentication/oauth-flow-store";
import type {
  OAuthDeviceFlowContext,
  OAuthDevicePollResult,
  OAuthDeviceStartResult,
  OAuthExchangeResult,
} from "../../authentication/oauth-flow-store";
import type { OAuthTokenRefreshResult } from "../../authentication/oauth-refresh-service";
import { OAuthDeviceFlow } from "../../authentication/oauth-device-flow";
import type { FetchLike } from "../../quota/quota-contracts";

// ── buddy-oauth-shared ──────────────────────────────────────────

export interface BuddyTokenData {
  readonly accessToken?: unknown;
  readonly refreshToken?: unknown;
  readonly tokenType?: unknown;
  readonly expiresIn?: unknown;
}

export function buddyResponseData(payload: unknown): Record<string, unknown> | undefined {
  return record(record(payload)?.data);
}

export function parseBuddyTokenData(payload: unknown): BuddyTokenData {
  const data = buddyResponseData(payload) ?? {};
  return {
    accessToken: data.accessToken,
    refreshToken: data.refreshToken,
    tokenType: data.tokenType,
    expiresIn: data.expiresIn,
  };
}

export function strictResponseCode(payload: unknown): number | undefined {
  const root = record(payload);
  if (typeof root?.code === "number" && Number.isFinite(root.code)) return root.code;
  if (typeof root?.code === "string" && Number.isFinite(Number(root.code))) return Number(root.code);
  return undefined;
}

export interface BuddyOAuthVariant {
  readonly providerId: string;
  /** Display name for error messages (`OAuthClient.providerLabel`). */
  readonly providerLabel: string;
  /** Stamped into the `x-domain` header of every auth request. */
  readonly domain: string;
  /** `platform` query parameter of the device-start request. */
  readonly platform: string;
  /** Resolves version metadata, then builds the `User-Agent` of one auth request. */
  readonly userAgent: () => Promise<string>;
  readonly deviceStartUrl: string;
  readonly devicePollUrl: string;
  readonly refreshUrl: string;
  /** Reads the envelope `code`; see `strictResponseCode`. */
  readonly responseCode: (payload: unknown) => number | undefined;
}

const DEVICE_EXPIRY_SECONDS = 900;

const BUDDY_PENDING_CODE = 11217;
export function buddyAccountUidFromClaims(
  claims: Record<string, unknown> | undefined,
): string | undefined {
  if (!claims) return undefined;
  return nonEmptyTrimmedString(claims.sub) ?? nonEmptyTrimmedString(claims.uid);
}

export function buddyAccountUid(accessToken: string): string | undefined {
  return buddyAccountUidFromClaims(decodeJwtPayload(accessToken));
}

function buddyAccountLabel(accessToken: string): string | undefined {
  const claims = decodeJwtPayload(accessToken);
  if (!claims) return undefined;
  const email = nonEmptyTrimmedString(claims.email) ?? nonEmptyTrimmedString(claims.preferred_username);
  const given = nonEmptyTrimmedString(claims.given_name);
  const family = nonEmptyTrimmedString(claims.family_name);
  const full =
    given && family ? `${given} ${family}` : nonEmptyTrimmedString(claims.name) ?? undefined;
  if (email && full) return `${full} <${email}>`;
  return email ?? full ?? nonEmptyTrimmedString(claims.sub);
}

function tokenResult(
  variant: BuddyOAuthVariant,
  payload: unknown,
  fallbackRefresh?: string,
): OAuthExchangeResult {
  const data = parseBuddyTokenData(payload);
  const access = nonEmptyTrimmedString(data.accessToken);
  if (!access) throw new Error(`${variant.providerId} token response omitted accessToken`);
  const refresh = nonEmptyTrimmedString(data.refreshToken) ?? fallbackRefresh ?? "";
  const accountLabel = buddyAccountLabel(access);
  return {
    access,
    refresh,
    expiresAt: expiryFromSeconds(data.expiresIn, 86_400),
    ...(accountLabel === undefined ? {} : { accountLabel }),
  };
}

async function authIdentityHeaders(variant: BuddyOAuthVariant): Promise<Record<string, string>> {
  return {
    accept: "application/json",
    "user-agent": await variant.userAgent(),
    "x-requested-with": "XMLHttpRequest",
    "x-domain": variant.domain,
    "x-product": "SaaS",
  };
}

async function deviceStartHeaders(variant: BuddyOAuthVariant): Promise<Record<string, string>> {
  return {
    "content-type": "application/json",
    ...(await authIdentityHeaders(variant)),
    "x-no-authorization": "true",
    "x-no-user-id": "true",
  };
}

async function devicePollHeaders(variant: BuddyOAuthVariant): Promise<Record<string, string>> {
  return {
    ...(await authIdentityHeaders(variant)),
    "x-no-authorization": "true",
    "x-no-user-id": "true",
    "x-no-enterprise-id": "true",
    "x-no-department-info": "true",
  };
}

async function refreshHeaders(
  variant: BuddyOAuthVariant,
  refreshToken: string,
): Promise<Record<string, string>> {
  return {
    "content-type": "application/json",
    ...(await authIdentityHeaders(variant)),
    "x-refresh-token": refreshToken,
    "x-auth-refresh-source": "plugin",
  };
}

export class BuddyOAuthClient extends OAuthDeviceFlow {
  override readonly supportsDeviceCode = true;
  override readonly supportsBrowserCode = false;

  protected override readonly providerLabel: string;
  protected override readonly clientId = "";
  protected override readonly tokenUrl = "";
  protected override readonly scopes = "";

  readonly #variant: BuddyOAuthVariant;

  constructor(variant: BuddyOAuthVariant, fetchFn: FetchLike = globalThis.fetch) {
    super(fetchFn);
    this.#variant = variant;
    this.providerLabel = variant.providerLabel;
  }

  override async startDeviceAuth(context?: OAuthDeviceFlowContext): Promise<OAuthDeviceStartResult> {
    const url = `${this.#variant.deviceStartUrl}?platform=${encodeURIComponent(this.#variant.platform)}`;
    const response = await this.fetchFor(context)(url, {
      method: "POST",
      headers: await deviceStartHeaders(this.#variant),
      body: "{}",
    });
    const payload = await readJsonResponse(response, `${this.#variant.providerId} device authorization`);
    if (this.#variant.responseCode(payload) !== 0) {
      throw new Error(
        `${this.#variant.providerId} state error: ${nonEmptyTrimmedString(record(payload)?.msg) ?? "missing state/authUrl"}`,
      );
    }
    const data = buddyResponseData(payload);
    const deviceAuthId = nonEmptyTrimmedString(data?.state);
    const verificationUri = nonEmptyTrimmedString(data?.authUrl);
    if (!deviceAuthId || !verificationUri) {
      throw new Error(`${this.#variant.providerId} device authorization returned an invalid response`);
    }
    return {
      verificationUri,
      userCode: "",
      deviceAuthId,
      intervalSeconds: 5,
      expiresInSeconds: DEVICE_EXPIRY_SECONDS,
    };
  }

  override async pollDeviceAuth(
    deviceAuthId: string,
    context?: OAuthDeviceFlowContext,
  ): Promise<OAuthDevicePollResult> {
    const url = `${this.#variant.devicePollUrl}?state=${encodeURIComponent(deviceAuthId)}`;
    const response = await this.fetchFor(context)(url, {
      method: "GET",
      headers: await devicePollHeaders(this.#variant),
    });
    const textBody = await response.text();
    let payload: unknown;
    try {
      payload = JSON.parse(textBody) as unknown;
    } catch {
      return {
        status: "failed",
        reason: `${this.#variant.providerId} token endpoint returned invalid JSON`,
      };
    }
    if (!response.ok) {
      return {
        status: "failed",
        reason: `${this.#variant.providerId} token polling failed (${response.status})`,
      };
    }
    const code = this.#variant.responseCode(payload);
    if (code === BUDDY_PENDING_CODE) return { status: "pending" };
    if (code !== 0) {
      return {
        status: "failed",
        reason:
          nonEmptyTrimmedString(record(payload)?.msg) ?? `${this.#variant.providerId} token polling failed`,
      };
    }
    const data = buddyResponseData(payload);
    const access = nonEmptyTrimmedString(data?.accessToken);
    if (!access) {
      return {
        status: "failed",
        reason: `${this.#variant.providerId} token response omitted accessToken`,
      };
    }
    // The profile nickname is a second, authorized request the reference makes
    // once the token lands — the JWT carries the email but not always a
    // display name. Best-effort by design: a login must not fail because the
    // profile endpoint was unreachable, so every miss falls back to the label
    // the token itself yields.
    const nickname = await this.fetchAccountNickname(deviceAuthId, access);
    if (nickname === undefined) return { status: "complete", result: tokenResult(this.#variant, payload) };
    const result = tokenResult(this.#variant, payload);
    return {
      status: "complete",
      result: { ...result, accountLabel: result.accountLabel ?? nickname },
    };
  }

  /** Reads the account profile nickname, or `undefined` on any miss. */
  private async fetchAccountNickname(
    deviceAuthId: string,
    accessToken: string,
  ): Promise<string | undefined> {
    try {
      // Both references call `/v2/plugin/login/account` with the token after
      // the poll succeeds; the poll URL is the same versioned plugin root, so
      // the profile path is derived from it rather than declared per variant.
      const url = `${this.#variant.devicePollUrl.replace("/plugin/auth/token", "/plugin/login/account")}?state=${encodeURIComponent(deviceAuthId)}`;
      const response = await this.fetchFn(url, {
        method: "GET",
        headers: {
          ...(await devicePollHeaders(this.#variant)),
          authorization: `Bearer ${accessToken}`,
        },
      });
      if (!response.ok) return undefined;
      const profile = buddyResponseData((await response.json()) as unknown);
      return nonEmptyTrimmedString(profile?.nickname);
    } catch {
      return undefined;
    }
  }

  override async refresh(refreshToken: string, signal?: AbortSignal): Promise<OAuthTokenRefreshResult> {
    const response = await this.fetchFn(this.#variant.refreshUrl, {
      method: "POST",
      headers: await refreshHeaders(this.#variant, refreshToken),
      body: "{}",
      ...(signal === undefined ? {} : { signal }),
    });
    const payload = await readJsonResponse(response, `${this.#variant.providerId} token refresh`);
    if (this.#variant.responseCode(payload) !== 0) {
      const detail = nonEmptyTrimmedString(record(payload)?.msg);
      throw new Error(`${this.#variant.providerId} token refresh failed${detail ? `: ${detail}` : ""}`);
    }
    const result = tokenResult(this.#variant, payload, refreshToken);
    return {
      access: result.access,
      ...(result.refresh ? { refresh: result.refresh } : {}),
      expiresAt: result.expiresAt,
    };
  }
}
