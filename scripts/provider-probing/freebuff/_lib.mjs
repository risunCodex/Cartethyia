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

export const FREEBUFF_DEVICE_KEY_HEADER = "x-freebuff-device-key";
export const FREEBUFF_DEVICE_TIMESTAMP_HEADER = "x-freebuff-device-ts";
export const FREEBUFF_DEVICE_SIGNATURE_HEADER = "x-freebuff-device-sig";

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
 */
export class FreebuffDeviceSigner {
  constructor({ fetchFn = fetch } = {}) {
    this.fetchFn = fetchFn;
    this.stored = null;
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
    return this.stored;
  }

  async register(token, { apiHost = API_HOST, client = CLIENT } = {}) {
    const key = await this.ensureKey();
    const scope = `${apiHost} token:${createHash("sha256").update(token).digest("hex").slice(0, 32)}`;
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
    return body.keyId;
  }

  async sign(token, { method = "GET", path = "", body = null, fetchId = "", timestampMs = Date.now() } = {}) {
    const key = await this.ensureKey();
    if (!key.registrations) throw new Error("device key not registered");
    const scope = `${API_HOST} token:${createHash("sha256").update(token).digest("hex").slice(0, 32)}`;
    const keyId = key.registrations[scope];
    if (!keyId) throw new Error("device key not registered for this token");
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
