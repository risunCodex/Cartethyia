/**
 * Shared constants/builders for Antigravity probes.
 *
 * Ground truth taken from the unpacked Antigravity IDE 2.6.0
 * (cloudCodeMainService.js) plus the Cartethyia adapter. The probe lets the
 * operator switch between the reference client's wire shape and the
 * adapter's current shape so a raw comparison can decide which one the
 * upstream accepts.
 */
import { createHash } from "node:crypto";

/** Reference control-plane base URLs (from `cloudCode.js` enum). */
export const ANTIGRAVITY_REF_BASE_URLS = [
  "https://daily-cloudcode-pa.googleapis.com",
  "https://cloudcode-pa.googleapis.com",
  "https://preprod-daily-cloudcode-pa.sandbox.googleapis.com",
  "https://autopush-cloudcode-pa.sandbox.googleapis.com",
] as const;

/** Adapter's production + sandbox failover pair. */
export const ANTIGRAVITY_ADAPTER_BASE_URLS = [
  "https://daily-cloudcode-pa.googleapis.com",
  "https://daily-cloudcode-pa.sandbox.googleapis.com",
] as const;

/** v1internal RPC paths (all fixed, no per-model URL). */
export const ANTIGRAVITY_PATH = {
  loadCodeAssist: "/v1internal:loadCodeAssist",
  onboardUser: "/v1internal:onboardUser",
  fetchAvailableModels: "/v1internal:fetchAvailableModels",
  retrieveUserQuotaSummary: "/v1internal:retrieveUserQuotaSummary",
  fetchUserInfo: "/v1internal:fetchUserInfo",
  generateContent: "/v1internal:generateContent",
  streamGenerateContent: "/v1internal:streamGenerateContent?alt=sse",
} as const;

/** Reference client metadata (from `cloudCodeMainService.js`). */
export interface AntigravityClientMetadata {
  readonly ideName: string;
  readonly ideType: string;
  readonly ideVersion: string;
}

export function referenceClientMetadata(ideVersion = "2.6.0"): AntigravityClientMetadata {
  return { ideName: "antigravity", ideType: "ANTIGRAVITY", ideVersion };
}

/** Adapter's current metadata (only ideType). */
export const adapterClientMetadata = { ideType: "ANTIGRAVITY" } as const;

/** Reference UA: `antigravity/<ideVersion> <os> <arch>`. */
export function referenceUserAgent(
  ideVersion = "2.6.0",
  os = "windows",
  arch = "amd64",
): string {
  return `antigravity/${ideVersion} ${os} ${arch}`;
}

/** Adapter UA: `antigravity/hub/<version> (aidev_client; ...)`. */
export function adapterUserAgent(
  hubVersion = "2.8.0",
  osType = "darwin",
  arch = "arm64",
  cl = "963137146",
): string {
  return `antigravity/hub/${hubVersion} (aidev_client; os_type=${osType}; arch=${arch}; cl=${cl})`;
}

/** Control-plane request headers for a raw probe. */
export function controlPlaneHeaders(
  accessToken: string,
  ua: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    "content-type": "application/json",
    "user-agent": ua,
    authorization: `Bearer ${accessToken}`,
    ...extra,
  };
}

/** Masks a token for display (prefix only). */
export function maskToken(token: string, keep = 4): string {
  return token.length <= keep ? "…" : `${token.slice(0, keep)}…`;
}

/** Short hash used for caches/keys; never stored raw. */
export function tokenKey(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 16);
}
