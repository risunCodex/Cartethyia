/**
 * Cursor wire constants: hosts, RPC paths, client identity, and header policy.
 *
 * Shared by auth, discovery, quota, and the Run transport so no surface
 * announces a different client build or host than another. The client version
 * must track a real released `cursor-agent` CLI build (date + short sha, e.g.
 * `cli-2026.11.05-86047df`): the service gates protocol features on it. The
 * download-API mirror in `operations/client-versions.ts` monitors releases;
 * `CARTETHYIA_CURSOR_CLIENT_VERSION` pins an override for experiments.
 *
 * Wire behaviour follows the oh-my-pi reference implementation (MIT), which
 * speaks Cursor's `agent.v1.AgentService` natively and pins the same shapes.
 */

/** Default host for Cursor's Connect RPCs and account API. */
export const CURSOR_API_BASE_URL = "https://api2.cursor.sh";

/** Website host: login pages and the cookie-authenticated usage summary. */
export const CURSOR_WEBSITE_BASE_URL = "https://cursor.com";

/** Released Cursor agent CLI build whose protocol surface this client mirrors. */
export const CURSOR_CLIENT_VERSION = "cli-2026.11.05-86047df";

/** OAuth client id of Cursor's own CLI (public, PKCE device flow). */
export const CURSOR_OAUTH_CLIENT_ID = "KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB";

/** Raw API keys carry this prefix; only they are exchangeable at the API. */
export const CURSOR_API_KEY_PREFIX = "crsr_";

/** A raw `crsr_` key is exchanged for a dispatch JWT; anything else is not one. */
export function isExchangeableApiKey(value: string): boolean {
  return value.startsWith(CURSOR_API_KEY_PREFIX);
}

/** Upstream error code that makes a session unrecoverable (account blocked). */
export const SIGN_IN_POLICY_VIOLATION = "sign_in_policy_violation";

/** Bound on auth/identity requests (device poll, token, key exchange). */
export const AUTH_REQUEST_TIMEOUT_MS = 5_000;

/** Bound on session refresh — slower than auth but still finite. */
export const SESSION_REFRESH_TIMEOUT_MS = 20_000;

// ── RPC paths (unary Connect unless noted) ──

/** Server-streaming Run: one request frame, then server frames + heartbeats. */
export const CURSOR_RUN_PATH = "/agent.v1.AgentService/Run";
/** HTTP/1.1 fallback for Run: server frames as SSE. */
export const CURSOR_RUN_SSE_PATH = "/agent.v1.AgentService/RunSSE";
/** HTTP/1.1 fallback upstream: unary append of one client frame to a RunSSE. */
export const CURSOR_BIDI_APPEND_PATH = "/aiserver.v1.BidiService/BidiAppend";
/** Live model roster for the account. */
export const CURSOR_GET_USABLE_MODELS_PATH = "/agent.v1.AgentService/GetUsableModels";
/** The account's default model (used to map `auto`/`default`). */
export const CURSOR_GET_DEFAULT_MODEL_PATH = "/agent.v1.AgentService/GetDefaultModelForCli";
/** Rich model catalog: variant parameter tuples (effort/thinking/fast/context). */
export const CURSOR_AVAILABLE_MODELS_PATH = "/aiserver.v1.AiService/AvailableModels";
/** Plan info: included-usage reset timestamps (weekly/monthly pools). */
export const CURSOR_GET_PLAN_INFO_PATH = "/aiserver.v1.DashboardService/GetPlanInfo";

// ── Auth / usage endpoints (plain JSON HTTP) ──

/** Legacy request-count usage buckets (Bearer auth). */
export const CURSOR_AUTH_USAGE_PATH = "/auth/usage";
/** Cookie-authenticated usage summary in USD cents (authoritative). */
export const CURSOR_USAGE_SUMMARY_PATH = "/api/usage-summary";

// ── header policy ──

/**
 * Header the Cursor backend reads to limit a run's built-in toolset to the
 * listed agent proto tool names: `ToolCall` oneof field names, comma-joined,
 * as Cursor's own SDK sends them for its `tools` option.
 */
export const CURSOR_ALLOWED_TOOLS_HEADER = "x-cursor-agent-allowed-tools";

/**
 * The toolset of a run whose tools an external executor owns: MCP calls, and
 * the MCP catalog lookup Cursor serves itself. A native tool's exec frame can
 * only be answered by running the tool where the files are, which a gateway
 * cannot do. An MCP call reaches the client under the client's own tool name
 * and schema, is handed off, and its result comes back with the next request.
 * The MCP resource and auth tools stay out: no MCP server stands behind the
 * gateway.
 */
export const CURSOR_EXTERNAL_EXECUTOR_ALLOWED_TOOLS = "mcp_tool_call,get_mcp_tools_tool_call";

/** Headers shared by Cursor's authenticated CLI RPCs. */
export function cursorClientHeaders(
  apiKey: string,
  options: {
    clientVersion?: string | undefined;
    contentType?: "application/proto" | "application/connect+proto" | undefined;
  } = {},
): Record<string, string> {
  return {
    "content-type": options.contentType ?? "application/proto",
    authorization: `Bearer ${apiKey}`,
    "x-cursor-client-type": "cli",
    "x-cursor-client-version": options.clientVersion ?? CURSOR_CLIENT_VERSION,
    "x-ghost-mode": "true",
  };
}

const HTTP2_FORBIDDEN_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "upgrade",
  "http2-settings",
]);

/**
 * Header names the Cursor request sets for itself. A caller copy in ANY casing
 * has to go: the request adds the fixed lower-case name regardless, and two
 * spellings of one field are a duplicate rather than an override.
 */
const CURSOR_RESERVED_HEADERS = new Set([
  "content-type",
  "connect-protocol-version",
  "te",
  "authorization",
  "x-ghost-mode",
  "x-cursor-client-version",
  "x-cursor-client-type",
  "x-cursor-agent-allowed-tools",
  "x-cursor-streaming",
  "x-request-id",
  // Transport-owned even though this request never sets it: node's http2
  // client suppresses the `:authority` it derives from the URL when a plain
  // `host` header is present, so a caller value here silently retargets the
  // request at a different virtual host.
  "host",
  // The Connect body is streamed after the headers (initial frame, heartbeats,
  // tool responses), so no caller-supplied length can describe it and an
  // HTTP/2 peer resets the stream once the body diverges.
  "content-length",
]);

/**
 * Reduce caller-supplied headers to what this HTTP/2 request can legally carry.
 *
 * Everything is lower-cased, because HTTP/2 field names are lower-case and
 * node compares them that way. A caller `Authorization` next to the fixed
 * `authorization` does not lose to it, it DUPLICATES it, and node throws
 * `ERR_HTTP2_HEADER_SINGLE_VALUE` before the request goes out. Same for a
 * `TE` that is not `trailers`. Node throws on all three classes here rather
 * than ignoring them, so a miss turns a harmless header into a dead request.
 */
export function sanitizeCursorCallerHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> {
  const sanitized: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    const field = name.toLowerCase();
    if (field.startsWith(":")) continue;
    if (HTTP2_FORBIDDEN_HEADERS.has(field)) continue;
    if (CURSOR_RESERVED_HEADERS.has(field)) continue;
    sanitized[field] = value;
  }
  return sanitized;
}
