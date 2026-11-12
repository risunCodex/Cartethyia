/**
 * Devin authentication: OAuth login flows and credential import.
 *
 * Three paths are supported:
 *
 * 1. **Devin CLI** (`app.devin.ai`): PKCE S256 browser-code flow. Authorize
 *    at `https://app.devin.ai/auth/cli/continue`, exchange at
 *    `https://api.devin.ai/auth/cli/token` (body JSON, non-standard).
 * 2. **Windsurf Enterprise** (`windsurf.com`): PKCE S256 loopback flow on
 *    port 59654, exchanging via `ExchangePKCEAuthorizationCode` to a raw
 *    seat key (`sk-ws-…`, stripped from the `gsk-ws-…` wire form).
 * 3. **CLI adopt**: reads the official Devin CLI `credentials.toml`
 *    (`windsurf_api_key`) — no network, no prompts.
 *
 * All three store under the `devin` credential slot (`store-as "devin"`).
 *
 * Ported from oh-my-pi (`registry/oauth/devin-windsurf.ts` +
 * `devin-cli.ts`, MIT) and opencode-devin-provider (`oauth.ts`, MIT).
 */

import { createHash, randomBytes } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  base64url,
  decodeJwt,
} from "jose";
import type {
  OAuthAuthorizeRequest,
  OAuthCodeExchangeContext,
  OAuthExchangeResult,
  OAuthImportInput,
  OAuthLoginClient,
} from "../../authentication/oauth-flow-store";
import { callDevinUnary } from "./devin-http";
import { DevinMessageTypes } from "./protocol/devin-proto";
import {
  DEVIN_DEFAULT_BASE_URL,
  DEVIN_EXCHANGE_PATH,
  DEVIN_GET_USER_STATUS_PATH,
} from "./devin-shared";

// ── PKCE ──

export function generatePKCE(): { verifier: string; challenge: string } {
  const verifier = base64url.encode(randomBytes(96));
  const challenge = base64url.encode(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

// ── Identity resolution ──

/** JWT claim keys tried in order when deriving an email/identity label. */
const IDENTITY_CLAIM_KEYS = [
  "email",
  "preferred_username",
  "name",
  "sub",
  "user_id",
  "userId",
  "session_id",
] as const;

/**
 * Derives a display label from a session token without any network: decode
 * the JWT payload and read the first present identity claim. A token that is
 * not a JWT (raw `sk-ws-…` seat key) yields nothing.
 */
export function identityLabelFromDevinCredential(credential: string): string | undefined {
  const key = credential.trim();
  if (!key) return undefined;
  const jwt = key.startsWith("devin-session-token$")
    ? key.slice("devin-session-token$".length)
    : key;
  if (jwt.split(".").length !== 3) return undefined;
  let payload: Record<string, unknown>;
  try {
    payload = decodeJwt(jwt) as Record<string, unknown>;
  } catch {
    // The token is opaque — no claims to read. Callers fall back to the
    // network identity below.
    return undefined;
  }
  for (const claim of IDENTITY_CLAIM_KEYS) {
    const value = payload[claim];
    if (typeof value === "string" && value.length > 0 && value !== "unauthenticated") {
      return value;
    }
  }
  return undefined;
}

/** A single identity string from `GetUserStatus`, if the upstream reports one. */
export function identityFromDevinUserStatus(planInfo: unknown): string | undefined {
  if (typeof planInfo !== "object" || planInfo === null) return undefined;
  const info = planInfo as {
    userStatus?: { email?: string; teamId?: string };
    planInfo?: { devinInfo?: { accountDisplayName?: string; orgId?: string } };
  };
  const email = info.userStatus?.email?.trim();
  if (email) return email;
  const displayName = info.planInfo?.devinInfo?.accountDisplayName?.trim();
  if (displayName) return displayName;
  const orgId = info.planInfo?.devinInfo?.orgId?.trim();
  if (orgId) return orgId;
  const teamId = info.userStatus?.teamId?.trim();
  if (teamId) return teamId;
  return undefined;
}

/**
 * Resolves the human-friendly label for a Devin credential: JWT claims first
 * (free), then `GetUserStatus` (network). Never throws — a failed lookup
 * returns `undefined`, leaving the caller's default label in place.
 */
export async function resolveDevinAccountLabel(
  credential: string,
  fetcher: typeof fetch = fetch,
): Promise<string | undefined> {
  const jwtLabel = identityLabelFromDevinCredential(credential);
  if (jwtLabel) return jwtLabel;
  try {
    const response = await callDevinUnary<Record<string, unknown>>(
      DEVIN_GET_USER_STATUS_PATH,
      DevinMessageTypes.GetUserStatusRequest,
      DevinMessageTypes.GetUserStatusResponse,
      { metadata: { apiKey: credential } },
      { baseUrl: DEVIN_DEFAULT_BASE_URL, fetchImpl: fetcher, signal: AbortSignal.timeout(10_000) },
    );
    return identityFromDevinUserStatus(response);
  } catch {
    return undefined;
  }
}

// ── Devin CLI flow (app.devin.ai) ──

const DEVIN_AUTHORIZE_URL = "https://app.devin.ai/auth/cli/continue";
const DEVIN_TOKEN_URL = "https://api.devin.ai/auth/cli/token";
// Devin's authorization server only accepts this exact loopback redirect; a
// public-origin redirect is refused with "Invalid redirect URI". The browser
// opens it on the operator's own machine (the loopback listener belongs to the
// desktop flow), so the gateway cannot intercept it — the operator pastes the
// resulting URL back into the modal. On a server, the browser will show
// "can't be reached" for 127.0.0.1: that is expected; the address bar still
// carries the `code` to paste.
const DEVIN_BROWSER_REDIRECT_URI = "http://127.0.0.1:59653/callback";

export const devinOAuthClient: OAuthLoginClient = {
  supportsDeviceCode: false,
  supportsBrowserCode: true,
  browserRedirectUri: DEVIN_BROWSER_REDIRECT_URI,

  buildAuthorizeUrl(request: OAuthAuthorizeRequest): string {
    const params = new URLSearchParams({
      redirect_uri: DEVIN_BROWSER_REDIRECT_URI,
      state: request.state,
      prompt: "select_account",
      code_challenge: request.codeChallenge,
      code_challenge_method: "S256",
    });
    return `${DEVIN_AUTHORIZE_URL}?${params.toString()}`;
  },

  async exchangeCode(
    code: string,
    codeVerifier: string,
    _redirectUri: string,
    _state?: string,
    _context?: OAuthCodeExchangeContext,
  ): Promise<OAuthExchangeResult> {
    const response = await fetch(DEVIN_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ code, code_verifier: codeVerifier }),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Devin token exchange failed: HTTP ${response.status} ${text}`);
    }
    const body = (await response.json()) as { token?: string };
    const token = body.token;
    if (!token) throw new Error("Devin token exchange returned no token");

    // Parse JWT exp, fallback to 1 year.
    let expiresAt: Date;
    try {
      const claims = decodeJwt(token);
      expiresAt = claims.exp ? new Date(claims.exp * 1000) : new Date(Date.now() + 365 * 24 * 3600 * 1000);
    } catch {
      expiresAt = new Date(Date.now() + 365 * 24 * 3600 * 1000);
    }

    // The exchange only returns a token; the label comes from the token's
    // own claims (when present) or `GetUserStatus`. Never fail the login on
    // a label lookup.
    const accountLabel = await resolveDevinAccountLabel(token).catch(() => undefined);

    return {
      access: token,
      refresh: "",
      expiresAt,
      ...(accountLabel ? { accountLabel } : {}),
    };
  },

  async importCredential(input: OAuthImportInput): Promise<OAuthExchangeResult> {
    const credential = input.credential.trim();
    if (!credential) throw new Error("Devin credential is empty");
    // The key itself is the identity; resolve a label when the material can
    // provide one (JWT claims or `GetUserStatus`), never failing on it.
    const accountLabel = await resolveDevinAccountLabel(credential).catch(() => undefined);
    return {
      access: credential,
      refresh: "",
      expiresAt: new Date(8640000000000000),
      ...(accountLabel ? { accountLabel } : {}),
      ...(input.accountLabel ? { accountLabel: input.accountLabel } : {}),
    };
  },
};

// ── Windsurf Enterprise flow (windsurf.com/editor/signin) ──

const WINDSURF_AUTHORIZE_URL = "https://windsurf.com/editor/signin";

/** Loopback port the official Devin CLI uses for the Windsurf flow. */
export const WINDSURF_CALLBACK_PORT = 59654;
/** Loopback hostname for the Windsurf flow. */
export const WINDSURF_PREFERRED_HOSTNAME = "127.0.0.1";

export const devinWindsurfOAuthClient: OAuthLoginClient = {
  supportsDeviceCode: false,
  supportsBrowserCode: true,

  buildAuthorizeUrl(request: OAuthAuthorizeRequest): string {
    const params = new URLSearchParams({
      response_type: "code",
      redirect_uri: request.redirectUri,
      state: request.state,
      code_challenge: request.codeChallenge,
      code_challenge_method: "S256",
      prompt: "login",
      redirect_parameters_type: "query",
    });
    return `${WINDSURF_AUTHORIZE_URL}?${params.toString()}`;
  },

  async exchangeCode(
    code: string,
    codeVerifier: string,
    _redirectUri: string,
    _state?: string,
    _context?: OAuthCodeExchangeContext,
  ): Promise<OAuthExchangeResult> {
    const response = await callDevinUnary<{
      apiKey?: string;
      name?: string;
      apiServerUrl?: string;
      devinWebappHost?: string;
      devinApiUrl?: string;
    }>(
      DEVIN_EXCHANGE_PATH,
      DevinMessageTypes.ExchangePKCEAuthorizationCodeRequest,
      DevinMessageTypes.ExchangePKCEAuthorizationCodeResponse,
      { authorizationCode: code, codeVerifier },
      { baseUrl: DEVIN_DEFAULT_BASE_URL },
    );
    const apiKey = response.apiKey;
    if (!apiKey) throw new Error("Windsurf code exchange returned no API key");
    // The exchange returns the `g`-prefixed wire form (`gsk-ws-…`); RPCs
    // authenticate with the raw key.
    const key = apiKey.startsWith("gsk-") ? apiKey.slice(1) : apiKey;
    // Prefer the upstream-reported name; fall back to the seat key's identity
    // claims or `GetUserStatus` — never fail the login on a label lookup.
    const accountLabel =
      response.name?.trim() || (await resolveDevinAccountLabel(key).catch(() => undefined));
    return {
      access: key,
      refresh: "",
      expiresAt: new Date(8640000000000000), // seat key: never expires
      ...(accountLabel ? { accountLabel } : {}),
    };
  },
};

// ── CLI adopt (credentials.toml) ──

const KNOWN_API_HOSTS = new Set(["server.codeium.com", "server.enterprise.windsurf.com"]);

/** Candidate `credentials.toml` paths per platform. */
export function devinCliCredentialPaths(): string[] {
  const paths: string[] = [];
  if (process.platform === "win32") {
    const appData = process.env.APPDATA;
    if (appData) paths.push(join(appData, "devin", "credentials.toml"));
    paths.push(join(process.env.HOME ?? "", ".local", "share", "devin", "credentials.toml"));
  } else {
    const xdg = process.env.XDG_DATA_HOME;
    if (xdg) paths.push(join(xdg, "devin", "credentials.toml"));
    paths.push(join(process.env.HOME ?? "", ".local", "share", "devin", "credentials.toml"));
    if (process.platform === "darwin") {
      paths.push(join(process.env.HOME ?? "", "Library", "Application Support", "devin", "credentials.toml"));
    }
  }
  return [...new Set(paths)];
}

/** Parses a Devin CLI `credentials.toml` and returns the Windsurf seat key. */
export function readDevinCliCredentials(file: string): string {
  const text = readFileSync(file, "utf8");
  // Minimal TOML parse: key = "value" lines.
  const record: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    record[key] = value;
  }
  const key = record["windsurf_api_key"]?.trim() ?? "";
  if (!key) throw new Error(`Devin CLI credentials at ${file} have no windsurf_api_key`);
  const serverUrl = record["api_server_url"]?.trim();
  if (serverUrl) {
    let host: string | undefined;
    try {
      host = new URL(serverUrl).host;
    } catch {
      host = undefined;
    }
    if (!host || !KNOWN_API_HOSTS.has(host)) {
      throw new Error(`Devin CLI credentials at ${file} point at unsupported API server`);
    }
  }
  return key;
}

/** Reads the first existing credentials file and returns its seat key. */
export function loginDevinCliHook(): Promise<string> {
  for (const file of devinCliCredentialPaths()) {
    if (!existsSync(file)) continue;
    try {
      return Promise.resolve(readDevinCliCredentials(file));
    } catch (error) {
      // First existing file that fails validation wins; no fallback probing.
      return Promise.reject(error);
    }
  }
  return Promise.reject(
    new Error(
      `No Devin CLI credentials found (probed: ${devinCliCredentialPaths().join(", ")}). Run \`devin auth login\`, then retry.`,
    ),
  );
}

// ── Import credential (raw API key / session token) ──
// `devinOAuthClient.importCredential` handles pasted keys; no separate client.
