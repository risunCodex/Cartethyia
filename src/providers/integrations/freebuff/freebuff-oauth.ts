// Freebuff OAuth client — TypeScript, Freebuff provider.
//
// Freebuff's login is a code flow, not standard OAuth2:
//   1. `POST /api/auth/cli/code` with `{fingerprintId}` → `{loginUrl,
//      fingerprintHash, expiresAt, expiresInMs}`.
//   2. The operator opens `loginUrl` in a browser and signs in.
//   3. `GET /api/auth/cli/status?fingerprintId=...&fingerprintHash=...&expiresAt=...`
//      → `{user:{authToken, id, email, name}}` once signed in.
//
// This maps onto the gateway's device-flow shape: `startDeviceAuth` issues the
// code (verificationUri = loginUrl), and `pollDeviceAuth` polls the status.
// On success we mint the Ed25519 device key (`POST /api/v1/freebuff/device-keys`)
// and persist `{accountId, device}` in `auth_state` so dispatch can sign.

import type {
  OAuthDeviceFlowContext,
  OAuthDevicePollResult,
  OAuthDeviceStartResult,
  OAuthExchangeResult,
  OAuthImportInput,
  OAuthLoginClient,
} from "../../authentication/oauth-flow-store";
import { isRecord } from "../../../protocol/codecs";
import { GatewayError } from "../../../protocol/gateway-error";
import {
  FREEBUFF_API_HOST,
  FREEBUFF_CLIENT_HEADER_VALUE,
  FREEBUFF_MODEL_CATALOG_PATH,
  FREEBUFF_CATALOG_PROTOCOL_HEADER,
  FREEBUFF_CATALOG_PROTOCOL_VERSION,
  FREEBUFF_CLIENT_HEADER,
  freebuffMintDeviceKey,
} from "./freebuff";

const CODE_PATH = "/api/auth/cli/code";
const STATUS_PATH = "/api/auth/cli/status";

interface CodeIssued {
  readonly loginUrl: string;
  readonly fingerprintId: string;
  readonly fingerprintHash: string;
  readonly expiresAt: string;
}

class FreebuffOAuthClient implements OAuthLoginClient {
  readonly supportsDeviceCode = true;
  readonly supportsBrowserCode = false;
  readonly deviceLoginFields = [
    {
      key: "email",
      label: "Freebuff account email (optional, for the account label)",
      placeholder: "you@example.com",
      required: false,
    },
  ] as const;
  readonly importFields = [
    {
      key: "token",
      label: "Freebuff access token (from the Desktop/CLI login)",
      placeholder: "Paste the bearer token…",
      secret: true,
      required: true,
    },
  ] as const;

  private readonly fetchFn: typeof fetch;

  constructor(fetchFn: typeof fetch = globalThis.fetch) {
    this.fetchFn = fetchFn;
  }

  async startDeviceAuth(_context?: OAuthDeviceFlowContext): Promise<OAuthDeviceStartResult> {
    const fingerprintId = crypto.randomUUID();
    const res = await this.fetchFn(`${FREEBUFF_API_HOST}${CODE_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fingerprintId }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new GatewayError("platform_unavailable", 502, `Freebuff code issue failed (HTTP ${res.status}): ${text.slice(0, 200)} (request {requestId}).`, {}, "upstream");
    }
    const body: unknown = await res.json().catch(() => null);
    if (!isRecord(body)) {
      throw new GatewayError("platform_unavailable", 502, "Freebuff code issue returned an invalid body (request {requestId}).", {}, "upstream");
    }
    const loginUrl = typeof body["loginUrl"] === "string" ? body["loginUrl"] : "";
    const fingerprintHash = typeof body["fingerprintHash"] === "string" ? body["fingerprintHash"] : "";
    const expiresAt = typeof body["expiresAt"] === "string" ? body["expiresAt"] : "";
    if (!loginUrl || !fingerprintHash) {
      throw new GatewayError("platform_unavailable", 502, "Freebuff code issue returned no login URL (request {requestId}).", {}, "upstream");
    }
    const state: CodeIssued = { loginUrl, fingerprintId, fingerprintHash, expiresAt };
    return {
      verificationUri: loginUrl,
      userCode: fingerprintId.slice(0, 8),
      deviceAuthId: fingerprintId,
      intervalSeconds: 3,
      expiresInSeconds: 3600,
      providerState: JSON.stringify(state),
    };
  }

  async pollDeviceAuth(deviceAuthId: string, context?: OAuthDeviceFlowContext): Promise<OAuthDevicePollResult> {
    let state: CodeIssued;
    try {
      state = JSON.parse(context?.providerState ?? "") as CodeIssued;
    } catch {
      state = { loginUrl: "", fingerprintId: deviceAuthId, fingerprintHash: "", expiresAt: "" };
    }
    const params = new URLSearchParams({
      fingerprintId: state.fingerprintId || deviceAuthId,
    });
    if (state.fingerprintHash) params.set("fingerprintHash", state.fingerprintHash);
    if (state.expiresAt) params.set("expiresAt", state.expiresAt);
    const res = await this.fetchFn(`${FREEBUFF_API_HOST}${STATUS_PATH}?${params.toString()}`, {
      method: "GET",
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      if (res.status === 404) {
        return { status: "pending", retryAfterSeconds: 3 };
      }
      return { status: "pending", retryAfterSeconds: 3 };
    }
    const body: unknown = await res.json().catch(() => null);
    if (!isRecord(body)) return { status: "pending", retryAfterSeconds: 3 };
    const user = body["user"];
    if (!isRecord(user)) return { status: "pending", retryAfterSeconds: 3 };
    const authToken = typeof user["authToken"] === "string" ? user["authToken"] : "";
    if (!authToken) return { status: "pending", retryAfterSeconds: 3 };
    const accountId = typeof user["id"] === "string" ? user["id"] : undefined;
    const email = typeof user["email"] === "string" ? user["email"] : undefined;
    const name = typeof user["name"] === "string" ? user["name"] : undefined;
    const device = await freebuffMintDeviceKey(authToken, {
      fetchFn: this.fetchFn,
      ...(accountId !== undefined ? { accountId } : {}),
    });
    const label = name ?? email;
    return {
      status: "complete",
      result: {
        access: authToken,
        refresh: "",
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        ...(label ? { accountLabel: label } : {}),
        auth_state: { ...(accountId !== undefined ? { accountId } : {}), device },
      },
    };
  }

  async importCredential(input: OAuthImportInput): Promise<OAuthExchangeResult> {
    const token = input.fields["token"]?.trim();
    if (!token) {
      throw new GatewayError("invalid_request", 400, "Freebuff token is required (request {requestId}).", { providerId: "freebuff" });
    }
    // Validate by fetching /me.
    const res = await this.fetchFn(`${FREEBUFF_API_HOST}/api/v1/me?fields=id,email,name`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      throw new GatewayError("authentication_failed", 401, "Freebuff token is invalid (request {requestId}).", {}, "upstream");
    }
    const body: unknown = await res.json().catch(() => null);
    const accountId = isRecord(body) && typeof body["id"] === "string" ? body["id"] : undefined;
    const email = isRecord(body) && typeof body["email"] === "string" ? body["email"] : undefined;
    const name = isRecord(body) && typeof body["name"] === "string" ? body["name"] : undefined;
    const device = await freebuffMintDeviceKey(token, {
      fetchFn: this.fetchFn,
      ...(accountId !== undefined ? { accountId } : {}),
    });
    const label = name ?? email ?? input.accountLabel;
    return {
      access: token,
      refresh: "",
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      ...(label ? { accountLabel: label } : {}),
      auth_state: { ...(accountId !== undefined ? { accountId } : {}), device },
    };
  }
}

const client = new FreebuffOAuthClient();

/** Config imported by the registry; device key lives in auth_state. */
export const freebuffOAuthClient: OAuthLoginClient = client;

// Re-export a helper so the catalog probe and other modules can validate a
// pasted token without constructing the client.
export async function freebuffValidateToken(token: string, fetchFn: typeof fetch = globalThis.fetch): Promise<string | undefined> {
  const res = await fetchFn(`${FREEBUFF_API_HOST}${FREEBUFF_MODEL_CATALOG_PATH}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      [FREEBUFF_CATALOG_PROTOCOL_HEADER]: FREEBUFF_CATALOG_PROTOCOL_VERSION,
      [FREEBUFF_CLIENT_HEADER]: FREEBUFF_CLIENT_HEADER_VALUE,
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return undefined;
  const body: unknown = await res.json().catch(() => null);
  return isRecord(body) && typeof body["fetchId"] === "string" ? body["fetchId"] : undefined;
}
