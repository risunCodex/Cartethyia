/**
 * Freebuff probe shared helpers.
 * Language: JavaScript (Bun), file: scripts/provider-probing/freebuff/_lib.mjs
 *
 * Wire facts extracted from the Freebuff Desktop 0.0.201 bundle
 * (`D:\tmp\unpacked\freebuff\app\resources\orchestrator\orchestrator.js`):
 *
 * - API host (prod): `https://www.codebuff.com` (also used as AUTH_HOST).
 * - Code login: `POST /api/auth/cli/code` with `{fingerprintId}` →
 *   `{ loginUrl, fingerprintHash, expiresAt, expiresInMs }`.
 * - Poll: `GET /api/auth/cli/status?fingerprintId=…&fingerprintHash=…&expiresAt=…`
 *   → `{ user: { authToken, id, email, name } }`.
 * - User info: `GET /api/v1/me?fields=…` with `Authorization: Bearer <token>`.
 * - Device keys: `POST /api/v1/freebuff/device-keys` with
 *   `{ publicKey, client: "desktop" }` → `{ keyId }`; requests may be signed
 *   with Ed25519 (`x-freebuff-device-key/ts/sig`).
 * - Catalog: `GET /api/v1/freebuff/models` with `x-freebuff-catalog-protocol: 1`,
 *   `x-freebuff-client: desktop`.
 * - Session admission: `POST /api/v1/freebuff/session/admission` with model /
 *   instance headers (see `admissionHeaders`).
 */

import { randomUUID, createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export const API_HOST = "https://www.codebuff.com";
export const AUTH_HOST = API_HOST;
export const CLIENT = "desktop";

export const CATALOG_PROTOCOL_HEADER = "x-freebuff-catalog-protocol";
export const CATALOG_PROTOCOL_VERSION = "1";
export const MODEL_CATALOG_PATH = "/api/v1/freebuff/models";
export const SESSION_ADMISSION_PATH = "/api/v1/freebuff/session/admission";
export const SESSION_EPOINT = "/api/v1/freebuff/session";
export const DEVICE_KEYS_PATH = "/api/v1/freebuff/device-keys";
export const ME_PATH = "/api/v1/me";

export const FREEBUFF_CLIENT_HEADER = "x-freebuff-client";
export const FREEBUFF_CLIENT_VERSION_HEADER = "x-freebuff-client-version";
export const FREEBUFF_INSTALL_ID_HEADER = "x-freebuff-install-id";
export const FREEBUFF_MODEL_HEADER = "x-freebuff-model";
export const FREEBUFF_WALLET_SPEND_LIMIT_HEADER = "x-freebuff-wallet-spend-limit";
export const FREEBUFF_INSTANCE_HEADER = "x-freebuff-instance-id";
export const FREEBUFF_MULTI_SESSION_HEADER = "x-freebuff-multi-session";
export const FREEBUFF_PURCHASE_CONTINUITY_HEADER = "x-freebuff-purchase-continuity";
export const FREEBUFF_DESKTOP_ATTEMPT_HEADER = "x-freebuff-desktop-attempt-id";
export const FREEBUFF_SESSION_RENEWAL_HEADER = "x-freebuff-session-renewal-id";
export const FREEBUFF_TAKEOVER_INSTANCE_HEADER = "x-freebuff-takeover-instance-id";
export const FREEBUFF_HEARTBEAT_HEADER = "x-freebuff-heartbeat";
export const FREEBUFF_INCLUDE_UNUSED_RATE_LIMITS_HEADER = "x-freebuff-include-unused-rate-limits";
export const FREEBUFF_DESKTOP_ADMITTED_AT_HEADER = "x-freebuff-desktop-admitted-at";
export const FREEBUFF_CATALOG_FETCH_HEADER = "x-freebuff-catalog-fetch";
export const FREEBUFF_FIRST_TAB_DISCOUNT_HEADER = "x-freebuff-first-tab-discount";
export const FREEBUFF_TIMEZONE_HEADER = "x-fb-timezone";
export const FREEBUFF_SSE_GZIP_RECOVERY_HEADER = "x-freebuff-sse-gzip-recovery";

// Official chat/agent-runs surface (validated live from freebuff-proxy audit).
export const AGENT_RUNS_PATH = "/api/v1/agent-runs";
export const CHAT_COMPLETIONS_PATH = "/api/v1/chat/completions";
export const MODEL_HANDLE_PREFIX = "fbm1.";
export const KNOWN_DESKTOP_VERSION = "0.0.201"; // aligned to the unpacked bundle
export const OFFICIAL_CHAT_USER_AGENT =
  "ai-sdk/openai-compatible/0.0.0-test/codebuff ai-sdk/provider-utils/3.0.25 runtime/bun/1.4.2";
// Official admission/agent-runs/delete transport runs on the Bun runtime UA.
export const OFFICIAL_ADMISSION_USER_AGENT = "Bun/1.4.2";

export const FREEBUFF_DEVICE_KEY_HEADER = "x-freebuff-device-key";
export const FREEBUFF_DEVICE_TIMESTAMP_HEADER = "x-freebuff-device-ts";
export const FREEBUFF_DEVICE_SIGNATURE_HEADER = "x-freebuff-device-sig";

// Cloud chat / history surface (desktop client).
export const CLOUD_HISTORY_BASE = "/api/v1/cloud/history";
export const CLOUD_HISTORY_DEVICE_CHATS_HEADER = "x-freebuff-device-chats";
export const CLOUD_RUNS_PATH = "/api/v1/cloud/runs";
export const FREEBUFF_CLOUD_QUESTIONS_HEADER = "x-freebuff-cloud-questions";
export const FREEBUFF_DEVICE_TOKEN_HEADER = "x-freebuff-device-token";
export const FREEBUFF_ATTENTION_HEADER = "x-freebuff-attention";
export const FREEBUFF_ACTING_USER_HEADER = "x-freebuff-acting-user-id";

// Ads surface (desktop client wires).
export const AD_POLICY_PATH = "/api/v1/ads/policy";
export const AD_AGENTIC_OFFER_PATH = "/api/v1/ads/agentic/offer";
export const AD_IMPRESSION_PATH = "/api/v1/ads/impression";
export const AD_CLICK_PATH = "/api/v1/ads/click";
export const AD_CLICK_RETURN_PATH = "/api/v1/ads/click-return";
export const AD_ENGAGEMENT_PATH = "/api/v1/ads/engagement";
export const AD_PREFS_PATH = "/api/v1/ads/prefs";
export const AD_SPONSORED_SKILLS_PATH = "/api/v1/ads/sponsored-skills";
export const AD_INVITATION_CLICK_PATH = "/api/v1/ads/invitation/click";
export const AD_INVITATION_EVENT_PATH = "/api/v1/ads/invitation/event";

// Ad wire constants (extracted from the Desktop 0.0.201 bundle).
export const AGENTIC_OFFER_ROUTE_VERSION = "1";
export const FREEBUFF_EVENT_ID_HEADER = "X-Freebuff-Event-Id";
export const FREEBUFF_RENDER_DELAY_HEADER = "X-Freebuff-Render-Delay-Ms";
export const FREEBUFF_DWELL_HEADER = "X-Freebuff-Dwell-Ms";
export const DESKTOP_CLIENT_VERSION = process.env.FREEBUFF_APP_VERSION?.trim() || "dev";
export const DESKTOP_AD_REQUEST_USER_AGENT = `Freebuff-Desktop/${DESKTOP_CLIENT_VERSION}`;
export const AD_USER_AGENTS = {
  darwin: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36",
  win32: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36",
  linux: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36",
};
export function getAdUserAgent(platform = process.platform) {
  return AD_USER_AGENTS[platform === "macos" ? "darwin" : platform === "windows" ? "win32" : platform] ?? AD_USER_AGENTS.linux;
}
export function adDeviceInfo() {
  const resolved = Intl.DateTimeFormat().resolvedOptions();
  return {
    os: process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "linux",
    timezone: resolved.timeZone,
    locale: resolved.locale,
  };
}

/** Freebuff reward model (unlocked after watching/earning). */
export const FREEBUFF_REWARD_MODEL_ID = "z-ai/glm-5.3-flash";

/** Sponsored-offer wire versions (extracted from the bundle). */
export const SPONSORED_IN_PLACE_VERSION = 1;
export const SPONSORED_RUN_SPEC_VERSION = 1;
export const SPONSORED_CONVERSION_TOOLS_VERSION = 2;
export const GENERIC_INVITATION_READY_DISCOVERY_VERSION = 1;

/** Web host (offer/click-return land here). */
export const FREEBUFF_WEB_HOST = "https://freebuff.com";

/** Model ids observed in the bundle (wire form `provider/model`). */
export const FREE_BUFF_MODELS = [
  "deepseek/deepseek-v4-flash",
  "deepseek/deepseek-v4-flash-fast",
  "deepseek/deepseek-v4-pro",
  "deepseek/deepseek-v4.1-flash",
  "openai/gpt-5.6-luna",
  "openai/gpt-5.6-luna-es",
  "openai/gpt-5.6-luna-pro",
  "openai/gpt-5.6-sol",
  "openai/gpt-5.6-sol-pro",
  "openai/gpt-5.6-terra",
  "openai/gpt-5.6-terra-pro",
  "openai/gpt-6-astra",
  "openai/gpt-6-astra-pro",
  "openai/gpt-6-luna",
  "openai/gpt-6-luna-pro",
  "openai/gpt-6-sol",
  "openai/gpt-6-sol-pro",
  "openai/gpt-6.1-sol",
  "openai/gpt-6.1-terra",
  "openai/gpt-5.4-pro",
  "openai/gpt-5.5",
  "openai/gpt-5.5-pro",
  "google/gemini-3.1-pro-preview",
  "google/gemini-3.5-flash",
  "google/gemini-3.6-flash",
  "google/gemini-3.7-flash",
  "google/gemini-3.8-flash",
  "google/gemini-4-argon",
  "z-ai/glm-5.2",
  "z-ai/glm-5.3",
  "z-ai/glm-5.3-flash",
  "z-ai/glm-5.3-flashx",
  "z-ai/glm-5.3-prime",
  "z-ai/glm-5-turbo",
  "anthropic/claude-fable-5.1",
  "anthropic/claude-opus-4.8",
  "anthropic/claude-opus-5",
  "anthropic/claude-opus-5.5",
  "anthropic/claude-sonnet-4.6",
  "anthropic/claude-sonnet-5",
  "fbc/claude-haiku-5.5",
  "mistralai/codestral-2508",
  "crof/kimi-k3-eco",
  "meta/muse-spark-1.3-contributor",
  "stealth/space-bunny-alpha",
].sort();

/** Short, redacted rendering of a credential (never the full value). */
export function redact(value) {
  if (!value) return "(empty)";
  const s = String(value);
  return s.length <= 12 ? s[0] + "…" : `${s.slice(0, 6)}…${s.slice(-4)}`;
}

/** Read a token (+ optional account id) from a capture credential file. */
export function readCredentialFile(filePath) {
  const content = readFileSync(filePath, "utf8");
  const token = content.match(/FREEBUFF_TOKEN=(.+)/)?.[1]?.trim();
  if (!token) throw new Error(`no FREEBUFF_TOKEN in ${filePath}`);
  const userId = content.match(/FREEBUFF_USER_ID=(.+)/)?.[1]?.trim() ?? null;
  const email = content.match(/FREEBUFF_USER_EMAIL=(.+)/)?.[1]?.trim() ?? null;
  return { token, userId, email };
}

/**
 * Standard session-admission headers (desktop wires), aligned 1:1 with the
 * official desktop capture (2026-10-03, docs/reverse/21-client-request-reference.md):
 * - wallet-spend-limit is "0" in the desktop capture ("session" is the CLI
 *   form). Refunds come from the gateway flagging the egress IP
 *   (`ipPrivacySignals: ["res_proxy","hosting","anonymous"]`), not from this
 *   header value — an IP-flagged account sees `desktopRefunds` either way.
 * - `x-freebuff-catalog-protocol: 1` is required; the official client sends it.
 * - admission runs on the Bun runtime UA (Bun/1.4.2), not the AI-SDK chat UA.
 * - `x-freebuff-client-version` is omitted (official admission does not send it).
 */
export function admissionHeaders(token, model, instanceId, attemptId, opts = {}) {
  const { fetchId, installId, clientVersion = "0.2.36" } = opts;
  return {
    Authorization: `Bearer ${token}`,
    ...(fetchId ? { [FREEBUFF_CATALOG_FETCH_HEADER]: fetchId } : {}),
    [CATALOG_PROTOCOL_HEADER]: CATALOG_PROTOCOL_VERSION,
    [FREEBUFF_CLIENT_HEADER]: CLIENT,
    ...(clientVersion ? { [FREEBUFF_CLIENT_VERSION_HEADER]: clientVersion } : {}),
    ...(installId ? { [FREEBUFF_INSTALL_ID_HEADER]: installId } : {}),
    [FREEBUFF_TIMEZONE_HEADER]: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    [FREEBUFF_FIRST_TAB_DISCOUNT_HEADER]: "0",
    [FREEBUFF_MODEL_HEADER]: model,
    [FREEBUFF_WALLET_SPEND_LIMIT_HEADER]: "0",
    [FREEBUFF_INSTANCE_HEADER]: instanceId,
    [FREEBUFF_MULTI_SESSION_HEADER]: "1",
    [FREEBUFF_PURCHASE_CONTINUITY_HEADER]: "1",
    [FREEBUFF_DESKTOP_ATTEMPT_HEADER]: attemptId,
    "user-agent": OFFICIAL_ADMISSION_USER_AGENT,
  };
}

/**
 * Resolve a stable per-install id (mirrors the desktop's installIdHeaders()).
 * Env override first; else a persisted id in the scratch key dir; else a fresh
 * UUID. The value is NOT a credential; it anchors the desktop identity group.
 */
export function resolveInstallId() {
  const fromEnv = process.env.FREEBUFF_INSTALL_ID?.trim();
  if (fromEnv) return fromEnv;
  try {
    const { readFileSync, existsSync, mkdirSync, writeFileSync } = require("node:fs");
    const path = require("node:path").join(require("node:os").tmpdir(), "freebuff-probe", "install-id.txt");
    if (existsSync(path)) {
      const v = readFileSync(path, "utf8").trim();
      if (v) return v;
    }
    const fresh = crypto.randomUUID();
    mkdirSync(require("node:path").dirname(path), { recursive: true });
    writeFileSync(path, fresh, "utf8");
    return fresh;
  } catch {
    return crypto.randomUUID();
  }
}

/** True when a value is a catalog model handle (`fbm1.*`). */
export function isModelHandle(value) {
  return typeof value === "string" && value.startsWith(MODEL_HANDLE_PREFIX);
}

/** Desktop client version (env override, else aligned known version). */
export function desktopClientVersion() {
  return process.env.FREEBUFF_APP_VERSION?.trim() || KNOWN_DESKTOP_VERSION;
}

/**
 * Slugify a model-ish string into meaningful word tokens (lowercase, alnum,
 * length ≥ 2). For wire ids (`provider/model`), the provider segment is
 * dropped; display names are used verbatim (they may contain their own `/`,
 * e.g. "10/17").
 */
function slugTokens(value, { isDisplay = false } = {}) {
  const raw = String(value).toLowerCase();
  const tail = !isDisplay
    ? raw.split("/").slice(1).join(" ")
    : raw;
  return tail
    .split(/[^a-z0-9]+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 2);
}

/** Strong variant tokens that bias a row's identity (slow/fast/pro/…). */
const STRONG_VARIANT_TOKENS = new Set([
  "slow", "fast", "pro", "mini", "max", "prime", "turbo", "preview", "alpha",
  "eco", "maverick", "contributor", "100k", "es", "sol", "terra", "luna",
  "astra", "argon", "x", "2x", "3x", "ef", "brief", "mini4",
]);

/**
 * Resolve a catalog row handle for a requested model (key `m-*`, wire id, or
 * readable display-name fragment). Returns `{ handle, row }`; `handle` stays
 * null when nothing matches. The handle is single-fetch ephemeral — it must be
 * re-resolved from a fresh catalog, never cached across fetches.
 *
 * Matching: a row wins when its slugified displayName contains every required
 * token of the requested id (provider segment ignored); a row carrying a strong
 * variant token (e.g. Slow/Fast) the request did NOT ask for is excluded; among
 * remaining candidates pick the one with the fewest extra tokens.
 */
/**
 * FNV-1a digest of a legacy (pre-catalog) model id, identical to the server's
 * `freebuffLegacyModelDigest` (common/src/types/freebuff-model-catalog.ts).
 * Each catalog row carries `legacyDigests[]` keyed by this digest, which is the
 * canonical "which wire id does this row replace" map.
 */
export function freebuffLegacyModelDigest(modelId) {
  const input = `freebuff-legacy-model:${modelId}`;
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}

export function resolveCatalogHandle(catalog, requested) {
  const rows = Array.isArray(catalog?.rows) ? catalog.rows : [];
  if (!requested) return { handle: null, row: null };
  if (isModelHandle(requested)) {
    return { handle: requested, row: rows.find((r) => r.handle === requested) ?? null };
  }
  const byKey = rows.find((r) => r.key === requested);
  if (byKey) return { handle: byKey.handle ?? null, row: byKey };

  // Canonical match: legacy wire-id digest → row's legacyDigests.
  const digest = freebuffLegacyModelDigest(requested);
  const byDigest = rows.find((r) => Array.isArray(r.legacyDigests) && r.legacyDigests.includes(digest));
  if (byDigest) return { handle: byDigest.handle ?? null, row: byDigest };

  // Request tokens: full set, plus a relaxed set with the provider-segment
  // tokens dropped (e.g. `deepseek/deepseek-v4-flash` → `["deepseek","v4",
  // "flash"]`; display names omit the provider prefix, so also try
  // `["v4","flash"]`).
  const required = slugTokens(requested);
  const providerSeg = String(requested).toLowerCase().split("/")[0];
  const relaxed = required.filter((w) => w !== providerSeg);
  const candidateSets = [required, relaxed].filter((s) => s.length > 0);
  if (!candidateSets.length) return { handle: null, row: null };
  let best = null;
  let bestExtra = Infinity;
  for (const r of rows) {
    const display = typeof r.displayName === "string" ? r.displayName : "";
    if (!display) continue;
    const toks = slugTokens(display, { isDisplay: true });
    const requiredSet = candidateSets.find((s) => s.every((w) => toks.includes(w)));
    if (!requiredSet) continue;
    // Exclude rows whose strong variant token is not requested (e.g. "DeepSeek
    // V4.1 Flash Slow" must not win for `deepseek/deepseek-v4-flash`).
    const unaskedVariant = toks.some((t) => STRONG_VARIANT_TOKENS.has(t) && !requiredSet.includes(t));
    if (unaskedVariant) continue;
    const extra = toks.length - required.length;
    if (extra < bestExtra) {
      bestExtra = extra;
      best = r;
    }
  }
  return { handle: best?.handle ?? null, row: best ?? null };
}

/** Arg helper: `arg("mode", "probe")` reads `--mode=x`. */
export function arg(name, fallback = "") {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
}

/** Boolean flag helper. */
export function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

/** `fetch` wrapper with timeout and JSON error shaping. */
export async function fbFetch(url, { method = "GET", headers = {}, body, timeoutMs = 30000, allowNonOk = false } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: { ...headers },
      ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
      signal: controller.signal,
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!res.ok && !allowNonOk) {
      const detail = json?.error ?? text.slice(0, 300);
      throw new Error(`HTTP ${res.status} ${res.statusText}: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
    }
    return { status: res.status, ok: res.ok, json, text, headers: res.headers };
  } finally {
    clearTimeout(timer);
  }
}

/** Hex sha256 of bytes (empty input => hash of empty array). */
export async function sha256Hex(bytes) {
  const data = bytes ? new Uint8Array(bytes) : new Uint8Array(0);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function base64UrlEncode(bytes) {
  return Buffer.from(bytes).toString("base64url");
}

export function base64UrlDecode(s) {
  return new Uint8Array(Buffer.from(s, "base64url"));
}

/**
 * Ed25519 device signer. Freebuff registers a per-account device public key
 * and signs requests with a canonical payload:
 *   freebuff-device-v1\n<METHOD>\n<path>\n<timestampMs>\n<bodySha256>\n<fetchId>
 *
 * The key pair and per-account `keyId` registrations are PERSISTED to a JSON
 * file (`keyFile`), so the same device identity survives across runs — this
 * mirrors the desktop behavior (the desktop stores the key in its profile and
 * reuses it). Scope is `host user:<accountId>` when the account id is known,
 * else `host token:<sha256(token).slice(0,32)>`.
 */
export class FreebuffDeviceSigner {
  constructor({ fetchFn = fetch, keyFile = null } = {}) {
    this.fetchFn = fetchFn;
    this.keyFile = keyFile;
    this.stored = null;
    this.loading = null;
  }

  async loadStored() {
    if (this.stored) return this.stored;
    if (!this.keyFile) {
      this.stored = await this.ensureKey();
      return this.stored;
    }
    if (!this.loading) {
      this.loading = (async () => {
        try {
          const { readFileSync } = await import("node:fs");
          const raw = readFileSync(this.keyFile, "utf8");
          const parsed = JSON.parse(raw);
          if (parsed?.version === 1 && parsed.publicKey && parsed.privateKey) {
            parsed.registrations ??= {};
            this.stored = parsed;
            return parsed;
          }
        } catch {
          // no existing key file → generate
        }
        this.stored = await this.ensureKey();
        return this.stored;
      })();
    }
    return this.loading;
  }

  async persist() {
    if (!this.keyFile || !this.stored) return;
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const { dirname } = await import("node:path");
    mkdirSync(dirname(this.keyFile), { recursive: true });
    writeFileSync(this.keyFile, JSON.stringify(this.stored, null, 2), "utf8");
  }

  async ensureKey() {
    if (this.stored) return this.stored;
    const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
    const privateKey = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
    this.stored = {
      version: 1,
      publicKey: base64UrlEncode(publicKey),
      privateKey: base64UrlEncode(privateKey),
      registrations: {},
    };
    await this.persist();
    return this.stored;
  }

  /** Per-account scope key for a token. */
  scopeFor(token, { apiHost = API_HOST, accountId = null } = {}) {
    const host = apiHost.replace(/\/$/, "");
    if (accountId) return `${host} user:${accountId}`;
    return `${host} token:${createHash("sha256").update(token).digest("hex").slice(0, 32)}`;
  }

  async register(token, { apiHost = API_HOST, client = CLIENT, accountId = null } = {}) {
    const key = await this.loadStored();
    const scope = this.scopeFor(token, { apiHost, accountId });
    if (key.registrations[scope]) return key.registrations[scope];
    const res = await this.fetchFn(`${apiHost}${DEVICE_KEYS_PATH}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ publicKey: key.publicKey, client }),
    });
    if (!res.ok) throw new Error(`device-keys register HTTP ${res.status}`);
    const body = await res.json().catch(() => ({}));
    if (typeof body?.keyId !== "string" || !body.keyId) throw new Error("device-keys: no keyId in answer");
    key.registrations[scope] = body.keyId;
    await this.persist();
    return body.keyId;
  }

  async sign(token, { method = "GET", path = "", body = null, fetchId = "", timestampMs = Date.now(), accountId = null } = {}) {
    const key = await this.loadStored();
    const scope = this.scopeFor(token, { accountId });
    const keyId = key.registrations[scope];
    if (!keyId) throw new Error("device key not registered for this token/account");
    const payload = [
      "freebuff-device-v1",
      method.toUpperCase(),
      path,
      String(timestampMs),
      await sha256Hex(body),
      fetchId,
    ].join("\n");
    const privateKey = await crypto.subtle.importKey(
      "pkcs8",
      base64UrlDecode(key.privateKey),
      { name: "Ed25519" },
      false,
      ["sign"],
    );
    const signature = new Uint8Array(await crypto.subtle.sign(
      { name: "Ed25519" },
      privateKey,
      new TextEncoder().encode(payload),
    ));
    return {
      [FREEBUFF_DEVICE_KEY_HEADER]: keyId,
      [FREEBUFF_DEVICE_TIMESTAMP_HEADER]: String(timestampMs),
      [FREEBUFF_DEVICE_SIGNATURE_HEADER]: base64UrlEncode(signature),
    };
  }
}

/** Common browser-open helper (Windows/macOS/Linux). */
export function openBrowser(url) {
  const { spawn } = require("node:child_process");
  const platform = process.platform;
  const cmd = platform === "win32"
    ? ["cmd", ["/c", "start", "", url]]
    : platform === "darwin"
      ? ["open", [url]]
      : ["xdg-open", [url]];
  try {
    spawn(cmd[0], cmd[1], { detached: true, stdio: "ignore" }).unref();
  } catch {
    console.log("[browser] could not auto-open; open the URL manually.");
  }
}
