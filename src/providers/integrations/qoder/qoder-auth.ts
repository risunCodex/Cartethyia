/**
 * Qoder credential resolution & PAT→jobToken exchange.
 *
 * Device tokens (`dt-…`) from OAuth login are used directly; a PAT
 * (`pt-…`) must be exchanged for a short-lived job token (`jt-…`) on the
 * realm's job-token endpoint before it can authenticate any surface.
 *
 * The exchange is the modern v1 endpoint (`/api/v1/jobToken/exchange`) with
 * a plain JSON body — verified live (2026-11-05): `POST
 * center.qoder.sh/api/v1/jobToken/exchange` with `{personal_token, machine_id}`
 * returns `{token: jt-…, refresh_token: jrt-…, expires_at}`. The old v3
 * scrambled-COSY endpoint is retired. `X-Request-ID` is sent uppercase and
 * the User-Agent is `qoder/<version>` — both mirror the real client.
 *
 * The v1 response does not include the account's user id, so `userId`
 * falls back to the machine id (decision 2026-11-05). That is sufficient
 * for Bearer surfaces (gRPC / IDE); COSY signing (free/lite PAT) uses it
 * as the identity placeholder until the user id is sourced another way.
 */
import { createHash, randomUUID } from "node:crypto";
import { GatewayError } from "../../../protocol/gateway-error";
import { mapUpstreamHttpError } from "../../../transport/failure-policy";
import { getQoderVersion } from "../../operations/client-versions";
import { qoderMachineOs } from "../../operations/cli-platform";
import { parseQoderOAuthState } from "./qoder-oauth";
import { QODER_REALMS, type QoderRealm } from "./qoder-realm";
import type { QoderAuth } from "./qoder-types";

/** A PAT (`pt-…`) must be exchanged for a job token before use. */
export function isQoderPat(secret: string): boolean {
  return secret.startsWith("pt-");
}

/**
 * Stable per-account machine id for OAuth dispatches. Derived from the
 * account id (not minted per request) so pooled accounts keep one device
 * fingerprint across restarts instead of looking like a new device every
 * time, while staying distinct per account.
 */
export function qoderMachineIdForAccount(accountId: string): string {
  const hex = createHash("sha256").update(`qoder-machine-v1:${accountId}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Builds dispatch auth from an OAuth device token. The token is used
 * directly as the COSY identity's oauth token; the user id and machine id
 * come from the `auth_state` the login persisted. Fails closed with a
 * reconnect prompt when the identity is absent (e.g. an account created
 * before `auth_state` existed, or an import that dropped the field) instead
 * of signing with a guessed id. The message names the missing field so an
 * operator can fix the export instead of re-logging blind.
 */
export function qoderOAuthAuth(
  secret: string,
  authState: unknown,
  accountId: string | undefined,
): QoderAuth {
  const state = parseQoderOAuthState(authState);
  if (state === undefined) {
    throw new GatewayError(
      "authentication_failed",
      401,
      "Qoder OAuth account is missing its user identity (request {requestId}) (auth_state.userId/machineId absent or empty — re-login, or re-export with authState included); sign in again. Wrong key, right door — check the credential 🔑",
    );
  }
  return {
    userId: state.userId,
    userName: "",
    userType: "personal_standard",
    securityOauthToken: secret,
    refreshToken: "",
    machineId: state.machineId || (accountId ? qoderMachineIdForAccount(accountId) : randomUUID()),
  };
}

const QODER_MACHINE_ID_TTL_MS = 60 * 60 * 1000;
const QODER_MAX_MACHINE_IDS = 1_024;
const qoderMachineIds = new Map<string, { id: string; expiresAt: number }>();

/**
 * Stable pseudo-device id per PAT for the whole hour (pool-friendly): a PAT
 * keeps one machine id across requests within the TTL instead of minting a
 * fresh device each time.
 */
function qoderMachineIdFromPat(pat: string): string {
  const key = createHash("sha256").update(pat).digest("hex");
  const now = Date.now();
  const existing = qoderMachineIds.get(key);
  if (existing && existing.expiresAt > now) return existing.id;
  const id = randomUUID();
  qoderMachineIds.delete(key);
  qoderMachineIds.set(key, { id, expiresAt: now + QODER_MACHINE_ID_TTL_MS });
  for (const [candidate, value] of qoderMachineIds) {
    if (value.expiresAt <= now) qoderMachineIds.delete(candidate);
  }
  while (qoderMachineIds.size > QODER_MAX_MACHINE_IDS) {
    const oldest = qoderMachineIds.keys().next();
    if (oldest.done) break;
    qoderMachineIds.delete(oldest.value);
  }
  return id;
}

/**
 * Stable 32-hex session id for one user+model conversation. Mirrors the
 * live IDE surface (`X-Session-ID` = sha256(userId:model), 32 hex) and is
 * shared by the HTTP and gRPC transports so body `session_id` matches the
 * transport-level session header.
 */
export function qoderSessionId(userId: string, modelId: string): string {
  return createHash("sha256").update(`qoder-session:${userId}:${modelId}`).digest("hex").slice(0, 32);
}

type QoderFetcher = (url: string, init: RequestInit) => Promise<Response>;

/** The fields a PAT→job-token exchange response carries. */
export interface ExchangeQoderPatResult {
  readonly token: string;
  readonly name?: string;
  readonly userType?: string;
  readonly refreshToken?: string;
  readonly expiresAt?: string;
}

/**
 * One PAT→job-token exchange against an explicit endpoint URL. Shared by
 * `exchangeQoderPat` (auth) and the claim flow: both POST the same v1 body
 * (`{personal_token, machine_id?, machine_token?}`) with the client identity
 * headers and parse the same response token. Parameterized by URL so each call
 * site keeps its own verified host (`center.qoder.sh` vs the openapi host);
 * the header set is the one verified live against both (2026-11-05/05).
 * Returns the raw `Response` plus the parsed result (or `null` when the body
 * carried no usable token); `null` itself means the request failed to reach
 * upstream. Callers decide how to surface each case (throw vs null).
 */
export async function exchangeQoderPatForHost(args: {
  readonly pat: string;
  readonly url: string;
  readonly machine?: { readonly id?: string; readonly token?: string };
  readonly fetcher: QoderFetcher;
  readonly signal: AbortSignal;
  readonly version?: string;
  /** Response keys to read the job token from, tried in order. Defaults to `["token"]`. */
  readonly tokenKeys?: readonly string[];
}): Promise<{ readonly response: Response; readonly result: ExchangeQoderPatResult | null } | null> {
  const body: Record<string, unknown> = { personal_token: args.pat };
  if (args.machine?.id) body.machine_id = args.machine.id;
  if (args.machine?.token) body.machine_token = args.machine.token;
  const version = args.version ?? getQoderVersion();
  const tokenKeys = args.tokenKeys ?? ["token"];
  let response: Response;
  try {
    response = await args.fetcher(args.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": `qoder/${version}`,
        "X-Request-ID": randomUUID().toUpperCase(),
        "Cosy-ClientType": "5",
        "Cosy-Version": version,
        "Cosy-MachineOS": qoderMachineOs(),
      },
      body: JSON.stringify(body),
      signal: args.signal,
    });
  } catch {
    return null;
  }
  if (!response.ok) return { response, result: null };
  let responseBody: unknown;
  try {
    responseBody = await response.json();
  } catch {
    return { response, result: null };
  }
  if (typeof responseBody !== "object" || responseBody === null || Array.isArray(responseBody)) {
    return { response, result: null };
  }
  const rec = responseBody as Record<string, unknown>;
  let token = "";
  for (const key of tokenKeys) {
    if (typeof rec[key] === "string" && (rec[key] as string).length > 0) {
      token = rec[key] as string;
      break;
    }
  }
  if (token.length === 0) return { response, result: null };
  return {
    response,
    result: {
      token,
      ...(typeof rec["name"] === "string" ? { name: rec["name"] as string } : {}),
      ...(typeof rec["userType"] === "string" ? { userType: rec["userType"] as string } : {}),
      ...(typeof rec["refresh_token"] === "string" ? { refreshToken: rec["refresh_token"] as string } : {}),
      ...(typeof rec["expires_at"] === "string" ? { expiresAt: rec["expires_at"] as string } : {}),
    },
  };
}

/**
 * Exchanges a PAT (`pt-…`) for a short-lived job token (`jt-…`) using the
 * modern v1 endpoint. Verified live (2026-11-05): `POST
 * center.qoder.sh/api/v1/jobToken/exchange` with a plain JSON body returns
 * `{token: jt-…, refresh_token: jrt-…, expires_at}`. `X-Request-ID` is
 * sent uppercase and the User-Agent is `qoder/<version>` — both mirror the
 * real client.
 *
 * The v1 response does not include the account's user id, so `userId`
 * falls back to the machine id (decision 2026-11-05). That is sufficient
 * for Bearer surfaces (gRPC / IDE); COSY signing (free/lite PAT) uses it
 * as the identity placeholder until the user id is sourced another way.
 */
async function exchangeQoderPat(
  pat: string,
  signal: AbortSignal,
  fetcher: QoderFetcher,
  version = getQoderVersion(),
  realm: QoderRealm = "intl",
): Promise<QoderAuth> {
  const machineId = qoderMachineIdFromPat(pat);
  const exchanged = await exchangeQoderPatForHost({
    pat,
    url: QODER_REALMS[realm].jobTokenUrl,
    machine: { id: machineId },
    fetcher,
    signal,
    version,
  });
  if (exchanged === null) {
    throw new GatewayError("platform_unavailable", 502, "Qoder PAT exchange failed to reach upstream (request {requestId}). The upstream came back empty-handed — retry 🌙", {}, "upstream");
  }
  if (!exchanged.response.ok) throw await mapUpstreamHttpError(exchanged.response, "qoder");
  const result = exchanged.result;
  if (result === null) {
    throw new GatewayError("platform_unavailable", 502, "Qoder PAT exchange returned no usable token (request {requestId}). The upstream came back empty-handed — retry 🌙", {}, "upstream");
  }
  return {
    userId: machineId,
    userName: result.name ?? "",
    userType: result.userType ?? "personal_standard",
    securityOauthToken: result.token,
    refreshToken: result.refreshToken ?? "",
    machineId,
  };
}

/**
 * Resolves the dispatch identity for one Qoder credential.
 *
 * Shared by the adapter and by discovery: both need the same `QoderAuth` the
 * COSY signature is built from, and duplicating the PAT-vs-OAuth branch would
 * let the two drift.
 */
export async function resolveQoderAuth(input: {
  readonly secret: string;
  readonly authState: unknown;
  readonly signal: AbortSignal;
  readonly fetcher: (url: string, init: RequestInit) => Promise<Response>;
  /** Which deployment mints the job token; a PAT is realm-bound. */
  readonly realm?: QoderRealm;
}): Promise<QoderAuth> {
  const realm = input.realm ?? "intl";
  if (isQoderPat(input.secret)) {
    return await exchangeQoderPat(input.secret, input.signal, input.fetcher, getQoderVersion(), realm);
  }
  // Discovery is handed only the secret and the persisted state, so the
  // account id is read from that state — the same place `qoderOAuthAuth` reads
  // it — rather than being a separate field callers can pass wrongly.
  const state = parseQoderOAuthState(input.authState);
  return qoderOAuthAuth(input.secret, input.authState, state?.userId);
}
