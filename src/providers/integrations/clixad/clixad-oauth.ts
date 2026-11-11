// Clixad credential login (GitHub device flow).
//
// Clixad's only production login is a GitHub device flow served by the
// gateway: `POST /v1/auth/device/start` returns a GitHub verification URL +
// user code; the gateway polls `POST /v1/auth/device/poll` with the session
// until the operator approves in the browser, then mints the CLI's bearer
// token (`adg_...`). There is no refresh token — the token is long-lived and
// the flow is re-run when needed. Pasting a raw token is supported via
// `importCredential`.

import { OAuthClient } from "../../authentication/oauth-client";
import type {
  OAuthDeviceStartResult,
  OAuthDevicePollResult,
  OAuthDeviceFlowContext,
} from "../../authentication/oauth-flow-store";

const CLIXAD_HANDOFF_PATH = "/v1/auth/device/start";
const CLIXAD_POLL_PATH = "/v1/auth/device/poll";
const CLIXAD_BASE_URL = "https://clixad.onrender.com";

export class ClixadOAuthClient extends OAuthClient {
  readonly supportsDeviceCode = true;
  readonly supportsBrowserCode = false;
  protected readonly providerLabel = "clixad";
  protected readonly clientId = "";
  protected readonly tokenUrl = "";
  protected readonly scopes = "";

  async startDeviceAuth(): Promise<OAuthDeviceStartResult> {
    const res = await this.fetchFn(new URL(CLIXAD_HANDOFF_PATH, CLIXAD_BASE_URL), {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`clixad device flow start failed: HTTP ${res.status} ${text.slice(0, 300)}`);
    }
    const body = (await res.json()) as Record<string, unknown>;
    return {
      verificationUri: String(body["verification_uri"] ?? ""),
      userCode: String(body["user_code"] ?? ""),
      deviceAuthId: String(body["session"] ?? ""),
      intervalSeconds: Number(body["interval"] ?? 5),
      expiresInSeconds: Number(body["expires_in"] ?? 900),
      providerState: JSON.stringify({ session: body["session"] }),
    };
  }

  async pollDeviceAuth(deviceAuthId: string, context?: OAuthDeviceFlowContext): Promise<OAuthDevicePollResult> {
    let providerState: Record<string, unknown> = {};
    try {
      providerState = JSON.parse(context?.providerState ?? "{}") as Record<string, unknown>;
    } catch {
      /* ignore */
    }
    const session = String(providerState["session"] ?? deviceAuthId);
    const res = await this.fetchFn(new URL(CLIXAD_POLL_PATH, CLIXAD_BASE_URL), {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ session }),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const status = String(body["status"] ?? "");
    if (status === "complete") {
      const token = String(body["token"] ?? "");
      return {
        status: "complete",
        result: {
          access: token,
          // Clixad issues no refresh token — the bearer is long-lived and the
          // flow is re-run when needed. Mirror the access token so the console
          // store always has a non-empty refresh field.
          refresh: token,
          expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
          accountLabel: String(body["email"] ?? body["login"] ?? ""),
          auth_state: {
            userId: body["userId"],
            email: body["email"],
            login: body["login"],
            defaultModel: body["default_model"],
          },
        },
      };
    }
    if (status === "closed") {
      return {
        status: "failed",
        reason: `signup closed: ${String(body["message"] ?? "")} (${String(body["waitlist_url"] ?? "")})`,
      };
    }
    if (status === "pending") return { status: "pending" };
    if (status === "unavailable") return { status: "failed", reason: `unavailable: ${String(body["error"] ?? "")}` };
    return { status: "failed", reason: `device poll failed: ${String(body["error"] ?? body["status"] ?? res.status)}` };
  }
}
