// Free-pi credential login (device flow) and refresh.
//
// The backend has no standard OAuth token endpoint; the device flow is:
//
//   1. POST /auth/github/device   -> { session_id, user_code, verification_uri, interval }
//   2. POST /auth/consent          -> { session_id, consent_version: "4" }
//   3. POST /auth/token (poll)     -> pending / { token }
//
// The issued token is a JWT used as `Authorization: Bearer` on every data-plane
// call. There is no refresh token: the JWT is long-lived (the CLI just re-runs
// the flow). Pasting a raw JWT is supported via `importCredential`.

import { OAuthClient } from "../../authentication/oauth-client";
import type {
  OAuthDeviceStartResult,
  OAuthDevicePollResult,
  OAuthDeviceFlowContext,
  OAuthExchangeResult,
  OAuthImportInput,
} from "../../authentication/oauth-flow-store";

const FREEPI_DEVICE_START_PATH = "/auth/github/device";
const FREEPI_TOKEN_PATH = "/auth/token";
const FREEPI_BASE_URL = "https://api.freepi.ai";

export class FreepiOAuthClient extends OAuthClient {
  readonly supportsDeviceCode = true;
  readonly supportsBrowserCode = false;
  protected readonly providerLabel = "free-pi";
  protected readonly clientId = "";
  protected readonly tokenUrl = "";
  protected readonly scopes = "";

  async startDeviceAuth(): Promise<OAuthDeviceStartResult> {
    const res = await this.fetchFn(new URL(FREEPI_DEVICE_START_PATH, FREEPI_BASE_URL), {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({}),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`free-pi device flow start failed: HTTP ${res.status} ${text.slice(0, 300)}`);
    }
    const body = (await res.json()) as Record<string, unknown>;
    return {
      verificationUri: String(body["verification_uri"] ?? ""),
      userCode: String(body["user_code"] ?? ""),
      deviceAuthId: String(body["session_id"] ?? ""),
      intervalSeconds: Number(body["interval"] ?? 5),
      expiresInSeconds: Number(body["expires_in"] ?? 900),
      providerState: JSON.stringify({ session_id: body["session_id"] }),
    };
  }

  async pollDeviceAuth(deviceAuthId: string, _context?: OAuthDeviceFlowContext): Promise<OAuthDevicePollResult> {
    let providerState: Record<string, unknown> = {};
    try {
      providerState = JSON.parse(_context?.providerState ?? "{}") as Record<string, unknown>;
    } catch {
      /* ignore */
    }
    const sessionId = String(providerState["session_id"] ?? deviceAuthId);
    const res = await this.fetchFn(new URL(FREEPI_TOKEN_PATH, FREEPI_BASE_URL), {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ session_id: sessionId }),
    });
    if (!res.ok) {
      return { status: "failed", reason: `token poll failed: HTTP ${res.status}` };
    }
    const body = (await res.json()) as Record<string, unknown>;
    if (typeof body["token"] === "string" && (body["token"] as string).length > 0) {
      return {
        status: "complete",
        result: {
          access: body["token"] as string,
          refresh: "",
          expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000),
          accountLabel: "freepi-device",
        },
      };
    }
    if (body["code"] === "consent_required") {
      return { status: "failed", reason: "consent_required" };
    }
    return { status: "pending" };
  }

  async importCredential(input: OAuthImportInput): Promise<OAuthExchangeResult> {
    const token = input.credential.trim();
    if (!token) throw new Error("free-pi: a JWT credential is required");
    return {
      access: token,
      refresh: "",
      expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000),
      accountLabel: input.accountLabel ?? "freepi-jwt",
    };
  }
}

export const freepiOAuthClient = new FreepiOAuthClient();
