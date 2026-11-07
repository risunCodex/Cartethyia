// Cursor constants shared by the adapter, auth client, catalog, transport, and
// session manager.
//
// Every literal below is a Cursor endpoint or client identity the donor
// protocol was verified against: they are declared once so the auth flow, the
// unary catalog calls, and the Run stream cannot drift apart on host, path, or
// client id.

/** Canonical bundled provider id. */
export const CURSOR_PROVIDER_ID = "cursor";

/** Cursor's API origin: auth, token, catalog and server-config calls. */
export const CURSOR_API_HOST = "api2.cursor.sh";
export const CURSOR_API_BASE_URL = `https://${CURSOR_API_HOST}`;
/** Cursor's website, where the browser login opens. */
export const CURSOR_WEBSITE_HOST = "cursor.com";
export const CURSOR_WEBSITE_URL = `https://${CURSOR_WEBSITE_HOST}`;

/**
 * Production OAuth client id Cursor's IDE sends on `POST /oauth/token`
 * (Cursor 3.17.19 `workbench.desktop.main.js`, `cursorCreds.authClientId` for
 * `backendUrl` `https://api2.cursor.sh`). The IDE's non-production id is not
 * used.
 */
export const CURSOR_OAUTH_CLIENT_ID = "KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB";

/**
 * Client version sent when no local or remote Cursor build version resolves.
 *
 * Kept equal to `VERSION_SOURCES.cursor.fallback`: two fallbacks for one
 * identity drifted apart (the header sent `cli-2026.07.09-a3815c0` while the
 * badge reported `cli-2026.10.19-6bbf2c4`), so what the console showed an
 * operator was not what the request carried. Discovery supersedes both on its
 * first successful fetch.
 */
export const FALLBACK_CLIENT_VERSION = "cli-3.29.9-306d153";

/** Connect-RPC paths. Run is served by the discovered agent origin, not the API host. */
export const RUN_PATH = "/agent.v1.AgentService/Run";
export const AVAILABLE_MODELS_PATH = "/aiserver.v1.AiService/AvailableModels";
export const SERVER_CONFIG_PATH = "/aiserver.v1.ServerConfigService/GetServerConfig";

/** Connect unary/bidi protocol headers. */
export const CONTENT_TYPE_CONNECT_PROTO = "application/connect+proto";
export const CONNECT_PROTOCOL_VERSION = "1";

/**
 * The client's timezone name, as the CLI sends on every request
 * (`Intl.DateTimeFormat().resolvedOptions().timeZone`). Computed once: the
 * value is stable for one process and the call is not cheap enough to repeat
 * per request.
 */
let cachedTimezone: string | undefined;
export function resolveCursorTimezone(): string {
  if (cachedTimezone !== undefined) return cachedTimezone;
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    cachedTimezone = typeof zone === "string" && zone.length > 0 ? zone : "";
  } catch {
    cachedTimezone = "";
  }
  return cachedTimezone;
}

/** A raw Cursor API key (as opposed to a JWT already exchanged from one). */
const CURSOR_API_KEY_PREFIX = "crsr_";

/** True for a raw Cursor API key, which must be exchanged before dispatch. */
export function isExchangeableApiKey(value: string): boolean {
  return value.startsWith(CURSOR_API_KEY_PREFIX);
}

/** Server error code Cursor surfaces as a sign-in policy block. */
export const SIGN_IN_POLICY_VIOLATION = "sign_in_policy_violation";

/** Seconds before a JWT is considered expiring and worth refreshing. */
export const TOKEN_EXPIRY_THRESHOLD_S = 300;

/** Individual auth/unary request timeout. */
export const AUTH_REQUEST_TIMEOUT_MS = 5_000;
/** Cursor IDE aborts its session refresh after 20 s (`_performAccessTokenRefresh`). */
export const SESSION_REFRESH_TIMEOUT_MS = 20_000;

/**
 * How long a live Cursor Run is held open waiting for the client's next
 * tool-result request. Matches the donor's continuation default: a tool round
 * the client never answers must not hold an HTTP/2 stream, an account lease, or
 * a pool slot for the life of the process.
 */
export const RUN_IDLE_TTL_MS = 10 * 60_000;

/**
 * Any HTTPS subdomain of `cursor.sh` is an acceptable Run host: the region
 * Cursor routes an account to varies (`agentn.*`, `agent.*`, `api5`, …).
 */
export function isAllowedAgentHost(hostname: string): boolean {
  return /^([a-z0-9-]+\.)+cursor\.sh$/i.test(hostname);
}

/**
 * Normalizes a GetServerConfig agent URL to an https origin.
 *
 * Returns `null` for missing, malformed, non-HTTPS, credential-bearing, or
 * non-`*.cursor.sh` hosts: the Run stream carries the account's credential, so
 * a host that is not a Cursor origin is a fail-closed refusal rather than
 * something to dial anyway.
 */
export function normalizeAgentRunOrigin(raw: string | undefined): string | null {
  if (raw === undefined || raw === null) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  try {
    const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    const parsed = new URL(withScheme);
    if (parsed.protocol !== "https:") return null;
    if (parsed.username || parsed.password) return null;
    if (!isAllowedAgentHost(parsed.hostname)) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}
