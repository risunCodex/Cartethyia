/**
 * Cursor OAuth client and token refresher.
 *
 * Cursor's login is its own PKCE device flow, not RFC 8628: the verifier and a
 * UUID are generated locally, the operator opens a `loginDeepControl` URL in a
 * browser, and the gateway polls `/auth/poll` until the tokens land. There is no
 * user code — approval is bound to the browser session — so `userCode` is empty
 * and the private verifier rides in `providerState`, which the console persists
 * server-side and never returns to the browser.
 *
 * Two credential families reach dispatch:
 *
 * - **Browser session** (`/oauth/token` refresh grant, as Cursor's IDE performs
 *   it). A rejected token is not an HTTP error: Cursor answers 200 with
 *   `{"access_token":"","shouldLogout":true}`, so the body decides the outcome.
 * - **Raw API key** (`crsr_`, exchanged at `/auth/exchange_user_api_key`). The
 *   exchanged JWT is the dispatch secret; the raw key is kept in the encrypted
 *   refresh field so the refresher can re-exchange it, which is how Cursor CLI
 *   renews an API-key login.
 *
 * A raw key never reaches `auth_state` and is never logged: `auth_state` is
 * operator-visible in the console.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { OAuthDeviceFlow } from "../../authentication/oauth-device-flow";
import type {
  OAuthDeviceFlowContext,
  OAuthDevicePollResult,
  OAuthDeviceStartResult,
  OAuthExchangeResult,
  OAuthImportInput,
  OAuthLoginField,
} from "../../authentication/oauth-flow-store";
import { base64UrlEncode, nonEmptyTrimmedString, record } from "../../authentication/oauth-flow-store";
import type { FetchLike } from "../../authentication/oauth-client";
import type { OAuthRefreshContext, OAuthTokenRefreshResult } from "../../authentication/oauth-refresh-service";
import {
  AUTH_REQUEST_TIMEOUT_MS,
  CURSOR_API_BASE_URL,
  CURSOR_OAUTH_CLIENT_ID,
  CURSOR_WEBSITE_URL,
  SESSION_REFRESH_TIMEOUT_MS,
  SIGN_IN_POLICY_VIOLATION,
  isExchangeableApiKey,
} from "./cursor-shared";

/** Device authorizations live 5 minutes before the flow is abandoned. */
const DEVICE_EXPIRY_SECONDS = 300;
/** Dashboard poll cadence for the device authorization. */
const DEVICE_INTERVAL_SECONDS = 5;
/** Token lifetime assumed when the upstream omits every expiry hint. */
const EXPIRY_FALLBACK_MS = 30 * 24 * 60 * 60 * 1000;

/** Fields the import flow collects: one raw Cursor API key. */
const IMPORT_FIELDS: readonly OAuthLoginField[] = [
  {
    key: "credential",
    label: "Cursor API key",
    placeholder: "crsr_…",
    secret: true,
    required: true,
  },
];

function base64urlDecode(segment: string): string | undefined {
  try {
    return Buffer.from(segment, "base64url").toString("utf8");
  } catch {
    return undefined;
  }
}

/** Decodes a JWT payload without verifying; the trust boundary stays at TLS. */
export function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  const segment = token.split(".")[1];
  if (segment === undefined) return undefined;
  const json = base64urlDecode(segment);
  if (json === undefined) return undefined;
  try {
    return record(JSON.parse(json) as unknown);
  } catch {
    return undefined;
  }
}

/** JWT `exp` claim as epoch milliseconds, or `undefined` when absent/malformed. */
export function decodeJwtExpiryMs(token: string): number | undefined {
  const payload = decodeJwtPayload(token);
  const exp = payload?.["exp"];
  if (typeof exp !== "number" || !Number.isFinite(exp)) return undefined;
  return exp * 1000;
}

/**
 * The account identity Cursor itself asserts, from the access token's `sub`.
 *
 * Cursor publishes no email on this grant, so falling back to the provider id
 * makes every account of the provider look identical — adding a second one
 * replaces the first. `sub` (`auth0|user_01…`) is stable across every login of
 * one account and differs between accounts, which is exactly what an account
 * identity has to do.
 */
export function cursorAccountIdentity(token: string): string | undefined {
  const payload = decodeJwtPayload(token);
  const subject = payload?.["sub"];
  return typeof subject === "string" && subject.trim().length > 0 ? subject.trim() : undefined;
}

/** Private device-flow state. Never returned to the browser. */
interface CursorDeviceState {
  readonly verifier: string;
}

function parseDeviceState(value: string | undefined): CursorDeviceState | undefined {
  if (value === undefined || value.length === 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
  const root = record(parsed);
  const verifier = root === undefined ? undefined : nonEmptyTrimmedString(root["verifier"]);
  return verifier === undefined ? undefined : { verifier };
}

/** Minimal fetch surface accepted by the token request helpers. */
type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** The base OAuth client's fetch surface; widened to `FetchFn` at each call. */
function asFetchFn(fetchFn: FetchLike): FetchFn {
  // Structural identity: the base class's `FetchLike` is the same signature as
  // `FetchFn`, so this only reconciles the two declarations.
  return fetchFn as FetchFn;
}

type JsonOutcome =
  | { ok: true; body: Record<string, unknown>; status: number }
  | { ok: false; status?: number; message: string };

async function fetchJson(
  fetchFn: FetchFn,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  label: string,
): Promise<JsonOutcome> {
  let response: Response;
  try {
    response = await fetchFn(url, {
      ...init,
      signal: signalOrTimeout(init.signal, timeoutMs),
    });
  } catch (error) {
    return {
      ok: false,
      message: `${label} request failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const text = await response.text().catch(() => "");
  let body: Record<string, unknown> | undefined;
  try {
    body = record(JSON.parse(text) as unknown) ?? undefined;
  } catch {
    body = undefined;
  }
  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      message: `${label} failed (${response.status}): ${text.slice(0, 200)}`,
    };
  }
  if (body === undefined) {
    return { ok: false, status: response.status, message: `${label} returned malformed JSON` };
  }
  return { ok: true, body, status: response.status };
}

/** Composes an outer signal with a bounded timeout; absent signal → timeout alone. */
function signalOrTimeout(signal: AbortSignal | null | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal === null || signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}

/**
 * Exchanges a raw `crsr_` key for a short-lived JWT.
 *
 * Also how an API-key login is renewed: Cursor CLI re-runs the exchange and
 * never uses the refresh token the response carries.
 */
async function exchangeApiKey(
  fetchFn: FetchFn,
  apiKey: string,
): Promise<{ accessToken: string; refreshToken: string; expiresAt: Date }> {
  const outcome = await fetchJson(
    fetchFn,
    `${CURSOR_API_BASE_URL}/auth/exchange_user_api_key`,
    {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: "{}",
    },
    AUTH_REQUEST_TIMEOUT_MS,
    "Cursor API key exchange",
  );
  if (!outcome.ok) throw new Error(outcome.message);
  const accessToken = nonEmptyTrimmedString(outcome.body["accessToken"]);
  if (accessToken === undefined) throw new Error("Cursor API key exchange returned no access token");
  const refreshToken = nonEmptyTrimmedString(outcome.body["refreshToken"]) ?? apiKey;
  const expiry = decodeJwtExpiryMs(accessToken);
  return {
    accessToken,
    refreshToken,
    expiresAt: new Date(expiry ?? Date.now() + EXPIRY_FALLBACK_MS),
  };
}

export class CursorOAuthClient extends OAuthDeviceFlow {
  override readonly supportsDeviceCode = true;
  override readonly supportsBrowserCode = false;
  readonly importFields = IMPORT_FIELDS;

  protected override readonly providerLabel = "Cursor";
  // Cursor's poll endpoint takes no client id; the abstract field stays empty
  // rather than inventing one, and the poll request omits it.
  protected override readonly clientId = "";
  protected override readonly tokenUrl = `${CURSOR_API_BASE_URL}/oauth/token`;
  protected override readonly scopes = "";

  /**
   * Starts the browser login.
   *
   * The PKCE verifier is the flow's private half and is returned only as
   * `providerState` — the console persists it in Redis, and the browser sees the
   * URL and the UUID alone. Publishing it would let anyone who can read the
   * start response mint the tokens the operator is about to authorize.
   */
  override async startDeviceAuth(
    _context?: OAuthDeviceFlowContext,
  ): Promise<OAuthDeviceStartResult> {
    const verifier = base64UrlEncode(randomBytes(32));
    const challenge = base64UrlEncode(createHash("sha256").update(verifier).digest());
    const uuid = randomUUID();
    const params = new URLSearchParams({
      challenge,
      uuid,
      mode: "login",
      redirectTarget: "cli",
    });
    return {
      verificationUri: `${CURSOR_WEBSITE_URL}/loginDeepControl?${params.toString()}`,
      // No user code: approval happens against the browser session.
      userCode: "",
      deviceAuthId: uuid,
      intervalSeconds: DEVICE_INTERVAL_SECONDS,
      expiresInSeconds: DEVICE_EXPIRY_SECONDS,
      providerState: JSON.stringify({ verifier } satisfies CursorDeviceState),
    };
  }

  /**
   * Polls `/auth/poll` with the private verifier.
   *
   * 404 is Cursor's "not approved yet" answer, not a failure. A 429 is a
   * backoff request rather than a dead credential, so the dashboard widens its
   * cadence and keeps waiting. A 200 without tokens is still pending: the
   * operator may not have finished approving, and ending the flow there would
   * abandon a login in progress (a genuinely changed shape surfaces as the
   * flow's own expiry).
   */
  override async pollDeviceAuth(
    deviceAuthId: string,
    context?: OAuthDeviceFlowContext,
  ): Promise<OAuthDevicePollResult> {
    const state = parseDeviceState(context?.providerState);
    if (state === undefined) return { status: "failed", reason: "unknown Cursor device authorization" };
    const url =
      `${CURSOR_API_BASE_URL}/auth/poll?uuid=${encodeURIComponent(deviceAuthId)}` +
      `&verifier=${encodeURIComponent(state.verifier)}`;
    const outcome = await fetchJson(
      asFetchFn(this.fetchFor(context)),
      url,
      { method: "GET", headers: { accept: "application/json" } },
      AUTH_REQUEST_TIMEOUT_MS,
      "Cursor device polling",
    );
    if (!outcome.ok) {
      if (outcome.status === 404) return { status: "pending" };
      if (outcome.status === 429) {
        return { status: "slow_down", retryAfterSeconds: DEVICE_INTERVAL_SECONDS * 2 };
      }
      return { status: "failed", reason: outcome.message };
    }
    const accessToken = nonEmptyTrimmedString(outcome.body["accessToken"]);
    if (accessToken === undefined) return { status: "pending" };
    const refreshToken = nonEmptyTrimmedString(outcome.body["refreshToken"]) ?? accessToken;
    const expiry = decodeJwtExpiryMs(accessToken);
    const identity = cursorAccountIdentity(accessToken);
    return {
      status: "complete",
      result: {
        access: accessToken,
        refresh: refreshToken,
        expiresAt: new Date(expiry ?? Date.now() + EXPIRY_FALLBACK_MS),
        ...(identity === undefined ? {} : { accountLabel: identity }),
        // `method` distinguishes a browser session (renewed by grant) from an
        // imported key (renewed by re-exchange). It carries no secret.
        auth_state: { method: "login", ...(identity === undefined ? {} : { subject: identity }) },
      },
    };
  }

  /**
   * Imports a raw Cursor API key.
   *
   * The key is exchanged before it is returned, so an import cannot persist
   * material that never worked. The exchanged JWT becomes the account secret and
   * the raw key rides in the encrypted refresh field: the refresher needs it to
   * renew the login, and that field is the only place it is stored.
   */
  async importCredential(input: OAuthImportInput): Promise<OAuthExchangeResult> {
    const credential = input.credential.trim();
    if (credential.length === 0) throw new Error("Cursor credential material is required");
    if (!isExchangeableApiKey(credential)) {
      throw new Error(
        "Cursor API keys start with 'crsr_'; sign in with Cursor for a browser session instead.",
      );
    }
    const exchanged = await exchangeApiKey(asFetchFn(this.fetchFn), credential);
    const identity = cursorAccountIdentity(exchanged.accessToken);
    return {
      access: exchanged.accessToken,
      refresh: credential,
      expiresAt: exchanged.expiresAt,
      ...(identity === undefined ? {} : { accountLabel: identity }),
      auth_state: { method: "api_key", ...(identity === undefined ? {} : { subject: identity }) },
    };
  }

  /**
   * Renews one Cursor account credential.
   *
   * An API-key account re-exchanges its raw key (the refresh field holds it); a
   * browser session posts the IDE's refresh grant. A sign-in policy block and a
   * `shouldLogout` answer are terminal for this credential, while a network or
   * 5xx failure is transient and worth retrying.
   */
  override async refresh(
    refreshToken: string,
    signal?: AbortSignal,
    context?: OAuthRefreshContext,
  ): Promise<OAuthTokenRefreshResult> {
    const method = nonEmptyTrimmedString(context?.auth_state?.["method"]);
    if (isExchangeableApiKey(refreshToken)) {
      const exchanged = await exchangeApiKey(asFetchFn(this.fetchFn), refreshToken);
      return {
        access: exchanged.accessToken,
        refresh: refreshToken,
        expiresAt: exchanged.expiresAt,
        auth_state: { method: method ?? "api_key" },
      };
    }
    if (refreshToken.length === 0) throw new Error("Cursor refresh token is missing");
    const outcome = await fetchJson(
      asFetchFn(this.fetchFn),
      `${CURSOR_API_BASE_URL}/oauth/token`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-cursor-client-type": "cli" },
        body: JSON.stringify({
          grant_type: "refresh_token",
          client_id: CURSOR_OAUTH_CLIENT_ID,
          refresh_token: refreshToken,
        }),
        ...(signal === undefined ? {} : { signal }),
      },
      SESSION_REFRESH_TIMEOUT_MS,
      "Cursor session refresh",
    );
    if (!outcome.ok) {
      // A bare transport failure is transient; a refusal is not.
      if (outcome.status === 401 || outcome.status === 403) {
        throw new Error(`Cursor session refresh was rejected (${outcome.status})`);
      }
      throw new Error(outcome.message);
    }
    if (outcome.body["shouldLogout"] === true) {
      const code = outcome.body["error"];
      throw new Error(
        code === SIGN_IN_POLICY_VIOLATION
          ? `Cursor session blocked by sign-in policy (${SIGN_IN_POLICY_VIOLATION})`
          : "Cursor ended the session (shouldLogout) — sign in again",
      );
    }
    const access = nonEmptyTrimmedString(outcome.body["access_token"]);
    if (access === undefined) throw new Error("Cursor session refresh returned no access token");
    const expiry = decodeJwtExpiryMs(access);
    return {
      access,
      // The grant issues no new refresh token: the IDE stores the access token
      // as both, and so does this refresher.
      refresh: refreshToken,
      expiresAt: new Date(expiry ?? Date.now() + EXPIRY_FALLBACK_MS),
      auth_state: { method: method ?? "login" },
    };
  }
}

export const cursorOAuthClient = new CursorOAuthClient();
