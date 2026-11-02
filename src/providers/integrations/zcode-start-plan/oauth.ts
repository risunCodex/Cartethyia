/**
 * Zcode Start Plan sign-in.
 *
 * Not an RFC 6749 authorization-code flow: the plan endpoint uses the ZCode
 * login JWT, not a Coding Plan API key or the separate Z.AI OAuth access token.
 * It is minted by the CLI device flow:
 *
 *   1. `POST /api/v1/oauth/cli/init` (Bearer = a throwaway poll token) returns
 *      an authorize URL plus a flow id.
 *   2. The operator opens the URL and approves it in a browser. Nothing comes
 *      back to this process — the browser lands on ZCode's own callback.
 *   3. `GET /api/v1/oauth/cli/poll/{flow}` with the same poll token reports
 *      `status: "ready"` and hands over the JWT.
 *
 * There is no refresh grant. Store the credential as issued and discard the
 * private poll token after completion; revoked sessions require a new sign-in.
 */
import * as crypto from "node:crypto";

import type { FetchLike } from "../../authentication/oauth-client";
import { OAuthDeviceFlow } from "../../authentication/oauth-device-flow";
import { readJsonResponse } from "../../authentication/oauth-flow-store";
import type {
  OAuthDeviceFlowContext,
  OAuthDevicePollResult,
  OAuthDeviceStartResult,
  OAuthExchangeResult,
} from "../../authentication/oauth-flow-store";
import { asRecord } from "../../../shared/coerce";
import { parseJwt } from "../../authentication/jwt-validator";

const ZCODE_BASE = "https://zcode.z.ai" as const;
const INIT_URL = `${ZCODE_BASE}/api/v1/oauth/cli/init` as const;
const POLL_BASE = `${ZCODE_BASE}/api/v1/oauth/cli/poll` as const;
/** Public client id the ZCode CLI ships; not a secret. */
const ZCODE_CLIENT_ID = "client_P8X5CMWmlaRO9gyO-KSqtg" as const;
/** ZCode's flow id lives ~300 s; the console polls comfortably inside that. */
const SESSION_TTL_SECONDS = 900;
const POLL_INTERVAL_SECONDS = 3;
/**
 * Tokens without an exp claim need a storage horizon rather than a real expiry.
 * The credential resolver treats the resulting api_key account as static.
 */
const NO_EXPIRY_MS = 10 * 365 * 24 * 60 * 60 * 1000;

const JSON_HEADERS = {
  accept: "application/json",
  "content-type": "application/json",
} as const;

export class ZcodeStartPlanOAuthClient extends OAuthDeviceFlow {
  override readonly supportsDeviceCode = true;
  override readonly supportsBrowserCode = false;

  protected override readonly providerLabel = "Zcode";
  protected override readonly clientId = ZCODE_CLIENT_ID;
  protected override readonly tokenUrl = `${ZCODE_BASE}/api/v1/oauth/token`;
  protected override readonly scopes = "";

  constructor(fetchFn: FetchLike = globalThis.fetch) {
    super(fetchFn);
  }

  override async startDeviceAuth(
    _context?: OAuthDeviceFlowContext,
  ): Promise<OAuthDeviceStartResult & { providerState: string }> {
    const pollToken = crypto.randomBytes(32).toString("hex");
    const response = await this.fetchFn(INIT_URL, {
      method: "POST",
      headers: { ...JSON_HEADERS, authorization: `Bearer ${pollToken}` },
      body: JSON.stringify({ provider: "zai" }),
    });
    const payload = asRecord(await readJsonResponse(response, `${this.providerLabel} sign-in`));
    const data = asRecord(payload?.data);
    const authorizeUrl = typeof data?.authorize_url === "string" ? data.authorize_url : "";
    const flowId = typeof data?.flow_id === "string" ? data.flow_id : "";
    if (!authorizeUrl || !flowId) {
      throw new Error(`${this.providerLabel} sign-in returned no authorize URL`);
    }
    return {
      verificationUri: authorizeUrl,
      userCode: "",
      deviceAuthId: flowId,
      intervalSeconds: POLL_INTERVAL_SECONDS,
      expiresInSeconds: SESSION_TTL_SECONDS,
      providerState: pollToken,
    };
  }

  override async pollDeviceAuth(
    deviceAuthId: string,
    context?: OAuthDeviceFlowContext,
  ): Promise<OAuthDevicePollResult> {
    const pollToken = context?.providerState ?? "";
    if (!pollToken) {
      return { status: "failed", reason: "sign-in session lost its poll token" };
    }
    const response = await this.fetchFn(`${POLL_BASE}/${encodeURIComponent(deviceAuthId)}`, {
      headers: { ...JSON_HEADERS, authorization: `Bearer ${pollToken}` },
    });
    if (response.status === 404) {
      return { status: "failed", reason: "sign-in session expired — start again" };
    }
    if (response.status === 429) {
      const retryAfter = Number(response.headers.get("retry-after"));
      return {
        status: "slow_down",
        retryAfterSeconds: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : POLL_INTERVAL_SECONDS + 5,
      };
    }
    if (response.status >= 500) {
      return { status: "pending", retryAfterSeconds: POLL_INTERVAL_SECONDS + 5 };
    }
    if (!response.ok) {
      return { status: "failed", reason: `sign-in poll failed (${response.status})` };
    }
    const payload = asRecord(await readJsonResponse(response, `${this.providerLabel} sign-in poll`));
    const code = payload?.["code"];
    if (!payload || payload["success"] === false ||
      (code !== undefined && ![0, 200, "0", "200"].includes(code as string | number))) {
      return { status: "failed", reason: "ZCode sign-in poll was rejected" };
    }
    const ready = asRecord(payload?.data);
    const status = ready?.["status"];
    if (status !== "ready") {
      return status === "pending"
        ? { status: "pending", retryAfterSeconds: POLL_INTERVAL_SECONDS }
        : { status: "failed", reason: "ZCode sign-in was not authorized" };
    }
    const token = typeof ready?.token === "string" ? ready.token : "";
    if (!token) {
      return { status: "failed", reason: "ZCode authorized sign-in returned no token" };
    }
    const user = asRecord(ready?.user);
    const email = typeof user?.email === "string" ? user.email : "";
    const claims = parseJwt(token)?.payload;
    const userId = claims?.user_id;
    if (!email && (typeof userId !== "string" || !userId)) {
      return { status: "failed", reason: "sign-in token has no account identity" };
    }
    const result: OAuthExchangeResult = {
      access: token,
      // No refresh grant exists for this token; the account is stored as static.
      refresh: "",
      expiresAt: new Date(typeof claims?.exp === "number" && Number.isFinite(claims.exp)
        ? claims.exp * 1000 : Date.now() + NO_EXPIRY_MS),
      accountLabel: email || String(userId),
      auth_state: { credentialMode: "api_key", tokenKind: "zcode-plan-jwt" },
    };
    return { status: "complete", result };
  }
}

export const zcodeStartPlanOAuthClient = new ZcodeStartPlanOAuthClient();
