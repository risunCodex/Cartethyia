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

export class FreebuffOAuthClient implements OAuthLoginClient {
  readonly supportsDeviceCode = true;
  readonly supportsBrowserCode = false;
  // No operator fields: the device flow issues a code and the account
  // identity (email/name) comes back in the poll response — asking for an
  // email up front is both unnecessary and wrong.
  readonly deviceLoginFields = [] as const;
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
    let res: Response;
    try {
      res = await this.fetchFn(`${FREEBUFF_API_HOST}${CODE_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fingerprintId }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      // Transient network/timeout failure — retry once on the same route. The
      // donor's login path does the same (freebuff-proxy: fetchLoginUpstream)
      // because a single jitter would otherwise bounce the whole login flow.
      const err = error as { name?: string; code?: string };
      const transient =
        err?.name === "AbortError" ||
        err?.name === "TypeError" ||
        err?.code === "ECONNRESET" ||
        err?.code === "ETIMEDOUT" ||
        err?.code === "ENOTFOUND" ||
        err?.code === "ECONNREFUSED" ||
        err?.code === "EPIPE";
      if (!transient) throw error;
      res = await this.fetchFn(`${FREEBUFF_API_HOST}${CODE_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fingerprintId }),
        signal: AbortSignal.timeout(15_000),
      });
    }
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
    // The server reports expiresAt as an epoch-millisecond number; keep it as
    // the raw value so the poll query matches what the donor sends (a string
    // coercion of a numeric field was silently dropping it, leaving the poll
    // URL incomplete — the upstream then answers 401 forever).
    const expiresAtRaw = body["expiresAt"];
    const expiresAt = typeof expiresAtRaw === "number" ? String(expiresAtRaw) : typeof expiresAtRaw === "string" ? expiresAtRaw : "";
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
    let res: Response;
    try {
      res = await this.fetchFn(`${FREEBUFF_API_HOST}${STATUS_PATH}?${params.toString()}`, {
        method: "GET",
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      // Transient poll failure — the donor keeps polling through these; a
      // dropped poll must not kill the flow.
      return { status: "pending", retryAfterSeconds: 3 };
    }
    if (res.status === 401 || res.status === 404) {
      // 401 is "not authorized yet" — the status endpoint refuses before the
      // browser sign-in completes. Treat it as pending, never as a failure
      // (mirrors freebuff-proxy: loginStatus -> 401 => { pending: true }).
      return { status: "pending", retryAfterSeconds: 3 };
    }
    if (!res.ok) {
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
