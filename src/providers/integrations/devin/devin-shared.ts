/**
 * Devin (Codeium Cascade) shared wire constants and metadata identity.
 *
 * Two identity tuples exist upstream, sourced from oh-my-pi
 * (`packages/catalog/src/wire/devin.ts`, MIT) and cross-checked against the
 * other donors: the released CLI identity (`devin-cli`/`chisel`/
 * `3000.11.205`) for chat/auth/usage, and the dev-channel discovery identity
 * (`chisel`/`0.0.0-dev`) for `GetCliModelConfigs` — the latter is what
 * unlocks the full native catalog.
 */

/** `Metadata.os` vocabulary; `process.platform` is fixed for the process lifetime. */
export const DEVIN_OS =
  process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "windows" : "linux";

export const DEVIN_DEFAULT_BASE_URL = "https://server.codeium.com";

export const DEVIN_SESSION_TOKEN_PREFIX = "devin-session-token$";

/** Paths. */
export const DEVIN_CHAT_MESSAGE_PATH = "/exa.api_server_pb.ApiServerService/GetChatMessage";
export const DEVIN_ASSIGN_MODEL_PATH = "/exa.api_server_pb.ApiServerService/AssignModel";
export const DEVIN_GET_CLI_MODEL_CONFIGS_PATH = "/exa.api_server_pb.ApiServerService/GetCliModelConfigs";
export const DEVIN_GET_USER_JWT_PATH = "/exa.auth_pb.AuthService/GetUserJwt";
export const DEVIN_GET_USER_STATUS_PATH = "/exa.seat_management_pb.SeatManagementService/GetUserStatus";
export const DEVIN_EXCHANGE_PATH = "/exa.seat_management_pb.SeatManagementService/ExchangePKCEAuthorizationCode";

/** User-Agent used for the chat stream (connect-go spoof). */
export const DEVIN_CONNECT_UA = "connect-go/1.18.1 (go1.26.3)";

/** Released CLI identity (chat, auth, usage). */
export const DEVIN_CLI_METADATA = {
  ideName: "devin-cli",
  ideType: "chisel",
  ideVersion: "3000.11.205",
  extensionName: "chisel",
  extensionVersion: "3000.11.205",
  locale: "en",
  os: DEVIN_OS,
} as const;

/** Dev-channel discovery identity (GetCliModelConfigs). */
export const DEVIN_DISCOVERY_METADATA = {
  ideName: "chisel",
  ideVersion: "0.0.0-dev",
  extensionName: "chisel",
  extensionVersion: "0.0.0-dev",
  locale: "en",
  os: DEVIN_OS,
} as const;

/**
 * Display slots requested in `Metadata.supportedModelDisplays` (field 30).
 * Requests slots 6 (internal default) / 7 (unclassified) / 8 (normal) beyond
 * the generated enum's 0-4 so the server sends the full native catalog.
 */
export const DEVIN_SUPPORTED_MODEL_DISPLAYS = [3, 4, 6, 7, 8];

/** Display slots filtered out client-side (not surfaced to users). */
export const DEVIN_INTERNAL_MODEL_DISPLAYS = new Set([4, 6]);

/** Models that advertise image support but silently drop images (live-verified). */
export const DEVIN_IMAGE_BLIND_UIDS = new Set(["swe-1-6-fast", "swe-1-6-slow"]);

/** Default limits when the catalog reports none. */
export const DEFAULT_CONTEXT_WINDOW = 200_000;
export const DEFAULT_MAX_TOKENS = 64_000;

/** Stop patterns the CLI sends by default. */
export const DEVIN_DEFAULT_STOP_PATTERNS = [
  "\u0004",
  "<|bot|>",
  "<|context_request|>",
  "\u0019",
  "<|end_of_turn|>",
];

/**
 * Encodes a credential for `Metadata.apiKey` (field 3). A bare JWT (3
 * dot-separated segments) gets the `devin-session-token$` prefix; every other
 * key — including legacy `sk-ws-…` — goes out verbatim.
 */
export function encodeDevinCredential(apiKey: string | undefined): string {
  const key = apiKey?.trim();
  if (!key) return "";
  if (key.startsWith(DEVIN_SESSION_TOKEN_PREFIX)) return key;
  return key.split(".").length === 3 ? `${DEVIN_SESSION_TOKEN_PREFIX}${key}` : key;
}

/** Builds the Metadata message object for a chat/usage call. */
export function devinCliMetadata(
  apiKey: string,
  userJwt?: string,
  sessionId?: string,
): Record<string, unknown> {
  return {
    ...DEVIN_CLI_METADATA,
    apiKey: encodeDevinCredential(apiKey),
    ...(userJwt ? { userJwt } : {}),
    ...(sessionId ? { sessionId } : {}),
  };
}

/** Builds the Metadata message object for discovery. */
export function devinDiscoveryMetadata(apiKey: string): Record<string, unknown> {
  return {
    ...DEVIN_DISCOVERY_METADATA,
    apiKey: encodeDevinCredential(apiKey),
    supportedModelDisplays: DEVIN_SUPPORTED_MODEL_DISPLAYS,
  };
}
