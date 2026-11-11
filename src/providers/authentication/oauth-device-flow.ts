import {
  devicePollBackoff,
  parseDeviceAuthStart,
  readJsonResponse,
  record,
} from "./oauth-flow-store";
import type {
  OAuthDeviceFlowContext,
  OAuthDevicePollResult,
  OAuthDeviceStartResult,
  OAuthExchangeResult,
} from "./oauth-flow-store";
import { OAuthClient, type NormalizedTokenResponse } from "./oauth-client";

/** Configuration for standard device-code start and poll requests. */
export interface DeviceFlowConfig {
  readonly tokenUrl: string;
  readonly deviceAuthUrl: string;
  readonly clientId: string;
  readonly scope?: string;
  readonly formHeaders?: Record<string, string>;
  /** Body parameters for the device-authorization start request. */
  readonly startParams?: Record<string, string>;
}

/** Base OAuth client for providers that expose an RFC 8628 device flow. */
export abstract class OAuthDeviceFlow extends OAuthClient {
  async startDeviceAuth(_context?: OAuthDeviceFlowContext): Promise<OAuthDeviceStartResult> {
    throw new Error(`${this.providerLabel} does not support device authorization`);
  }

  async pollDeviceAuth(
    _deviceAuthId: string,
    _context?: OAuthDeviceFlowContext,
  ): Promise<OAuthDevicePollResult> {
    return { status: "failed", reason: `${this.providerLabel} does not support device authorization` };
  }

  /** Standard device-authorization start. Override the body builder for custom providers. */
  protected async startGenericDeviceAuth(
    config: DeviceFlowConfig,
    context?: OAuthDeviceFlowContext,
  ): Promise<OAuthDeviceStartResult> {
    const body = this.buildDeviceStartBody(config);
    const response = await this.fetchFor(context)(config.deviceAuthUrl, {
      method: "POST",
      ...(config.formHeaders === undefined ? {} : { headers: config.formHeaders }),
      body,
    });
    const payload = await readJsonResponse(response, `${this.providerLabel} device authorization`);
    const start = parseDeviceAuthStart(payload, {
      intervalSeconds: 5,
      expiresInSeconds: 900,
    });
    if (!start) {
      throw new Error(`${this.providerLabel} device authorization returned an invalid response`);
    }
    return {
      verificationUri: start.verificationUriComplete ?? start.verificationUri,
      userCode: start.userCode,
      deviceAuthId: start.deviceCode,
      intervalSeconds: start.intervalSeconds,
      expiresInSeconds: start.expiresInSeconds,
    };
  }

  protected buildDeviceStartBody(config: DeviceFlowConfig): URLSearchParams {
    const params: Record<string, string> = { client_id: config.clientId };
    if (config.scope) params.scope = config.scope;
    if (config.startParams) Object.assign(params, config.startParams);
    return new URLSearchParams(params);
  }

  /**
   * Optional verdict computed from the parsed token body before the status
   * code is considered. Defaults to undefined (continue with standard
   * handling). A provider whose authoritative endpoint states the poll state
   * in the body on any status can return a backoff verdict here — e.g. Grok,
   * which votes on `error` before the HTTP status.
   */
  protected preVerdict?(_payload: unknown): OAuthDevicePollResult | undefined;

  /**
   * Post-success hook for the standard device-token poll.
   *
   * Receives the raw token response payload and the normalized parsed token.
   * Returns the exchange result to complete with, or a verdict (typically
   * `failed`) instead. The default reproduces the generic behavior exactly.
   * Errors thrown by a hook are converted to a `failed` verdict by
   * `pollGenericDeviceAuth`, keeping the poll contract (verdicts, never
   * throws).
   */
  protected afterDeviceTokenExchange?(
    _payload: unknown,
    _normalized: NormalizedTokenResponse,
  ): OAuthExchangeResult | OAuthDevicePollResult | Promise<OAuthExchangeResult | OAuthDevicePollResult>;

  /**
   * Failure reason for a non-JSON token body. Defaults to the generic
   * phrasing; providers whose wire carries a distinct message override it.
   */
  protected unparsablePollReason(status: number): string {
    return `device polling failed (${status})`;
  }

  /**
   * Failure reason for a non-OK token response. The default preserves the
   * generic behavior: the response's `error` field names the reason on the
   * RFC 8628 400/428 statuses, and every other non-OK status gets the generic
   * phrasing (the body is not trusted there).
   */
  protected pollFailureReason(
    status: number,
    errorKey: string | undefined,
    _errorDescription: string | undefined,
  ): string {
    if (status === 400 || status === 428) return errorKey || `device polling failed (${status})`;
    return `device polling failed (${status})`;
  }

  /** Failure reason when a token response omits `access_token`. */
  protected missingTokenReason(_errorKey: string | undefined, _errorDescription: string | undefined): string {
    return `${this.providerLabel} token response omitted access_token`;
  }

  /** Standard device-token poll. Returns pending while authorization is incomplete. */
  protected async pollGenericDeviceAuth(
    deviceAuthId: string,
    config: DeviceFlowConfig,
    context?: OAuthDeviceFlowContext,
  ): Promise<OAuthDevicePollResult> {
    const response = await this.fetchFor(context)(config.tokenUrl, {
      method: "POST",
      ...(config.formHeaders === undefined ? {} : { headers: config.formHeaders }),
      body: new URLSearchParams({
        client_id: config.clientId,
        device_code: deviceAuthId,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    });
    const text = await response.text();
    let payload: unknown;
    try {
      payload = JSON.parse(text) as unknown;
    } catch {
      payload = undefined;
    }
    // A body that is not JSON is a failed poll regardless of status: verdicts
    // must never throw, and the reason below lets providers keep their own
    // phrasing (e.g. Grok's "returned invalid JSON").
    if (payload === undefined) {
      return { status: "failed", reason: this.unparsablePollReason(response.status) };
    }
    const root = record(payload) ?? {};
    if (this.preVerdict) {
      const verdict = this.preVerdict(payload);
      if (verdict !== undefined) return verdict;
    }
    const errorKey = typeof root.error === "string" ? root.error : undefined;
    const errorDescription = typeof root.error_description === "string" ? root.error_description : undefined;
    if (response.status === 400 || response.status === 428) {
      const verdict = devicePollBackoff(errorKey, root.interval);
      if (verdict !== undefined) return verdict;
      return {
        status: "failed",
        reason: this.pollFailureReason(response.status, errorKey, errorDescription),
      };
    }
    if (!response.ok) {
      return { status: "failed", reason: this.pollFailureReason(response.status, errorKey, errorDescription) };
    }
    if (typeof root.access_token !== "string" || !root.access_token) {
      return {
        status: "failed",
        reason: this.missingTokenReason(errorKey, errorDescription),
      };
    }
    let normalized: NormalizedTokenResponse;
    try {
      normalized = this.parseTokenResponse(payload);
    } catch (error) {
      return {
        status: "failed",
        reason: error instanceof Error ? error.message : `${this.providerLabel} token response omitted access_token`,
      };
    }
    if (this.afterDeviceTokenExchange) {
      try {
        const hooked = await this.afterDeviceTokenExchange(payload, normalized);
        if ("status" in hooked) return hooked;
        return { status: "complete", result: hooked };
      } catch (error) {
        return {
          status: "failed",
          reason: error instanceof Error ? error.message : `${this.providerLabel} authentication failed`,
        };
      }
    }
    return { status: "complete", result: this.toExchangeResult(normalized) };
  }
}
