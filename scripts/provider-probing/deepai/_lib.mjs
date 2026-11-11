/**
 * DeepAI probe shared helpers.
 * Language: JavaScript (Bun), file: scripts/provider-probing/deepai/_lib.mjs
 *
 * Wire facts extracted from the DeepAI Code 0.3.35 bundle
 * (`D:\tmp\unpacked\deepai\app\resources\server\apps\server\dist\binCli-QUOCZvq0.mjs`):
 *
 * - API origin (prod): `https://api.deepai.org`; model base is
 *   `${origin}/deepai_code`.
 * - Sign-in: `GET /deepai_code/desktop_auth/?state=<state>&port=<port>` →
 *   loopback `http://127.0.0.1:<port>/callback?code=…` →
 *   `POST /deepai_code/desktop_auth/exchange/` `{"code"}` → `{api_key,
 *   username, is_pro}`.
 * - Headers on every model API call: `Content-Type: application/json`,
 *   `X-DeepAI-Code-Theos: 4` (lane), `X-DeepAI-Code-Instance: <16B hex>`,
 *   `X-DeepAI-Code-Machine: <sha256hex(machineId)>` (when readable),
 *   `Api-Key: <api_key>` (when account-bound).
 * - `/theos` additionally sends `X-DeepAI-Code-Check-In: <nonce>` and
 *   `X-DeepAI-Code-Beacon: v=<ver>;up=<sec>;pi=0|1;focus=0|1`.
 * - Model catalog: `GET /deepai_code/models` (unauthenticated).
 * - Quota: `GET /deepai_code/theos`, `GET /get_usage_summary` (authed).
 * - Chat: `POST /deepai_code/chat/completions` (OpenAI-compatible).
 * - Machine ID (Windows): `(Get-CimInstance Win32_ComputerSystemProduct).UUID`
 *   else `reg query HKLM\SOFTWARE\Microsoft\Cryptography /v MachineGuid`; the
 *   header value is `sha256hex(raw)`.
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const DEEPAI_API_ORIGIN = "https://api.deepai.org";
export const DEEPAI_MODEL_BASE = `${DEEPAI_API_ORIGIN}/deepai_code`;
export const DEEPAI_LANE_VERSION = "4";

export const HEADER_THEOS = "X-DeepAI-Code-Theos";
export const HEADER_INSTANCE = "X-DeepAI-Code-Instance";
export const HEADER_MACHINE = "X-DeepAI-Code-Machine";
export const HEADER_API_KEY = "Api-Key";
export const HEADER_CHECK_IN = "X-DeepAI-Code-Check-In";
export const HEADER_BEACON = "X-DeepAI-Code-Beacon";

export const PATH_MODELS = `${DEEPAI_MODEL_BASE}/models`;
export const PATH_CHAT = `${DEEPAI_MODEL_BASE}/chat/completions`;
export const PATH_THEOS = `${DEEPAI_MODEL_BASE}/theos`;
export const PATH_USAGE_SUMMARY = `${DEEPAI_API_ORIGIN}/get_usage_summary`;
export const PATH_SIGNIN = `${DEEPAI_API_ORIGIN}/deepai_code/desktop_auth/`;
export const PATH_EXCHANGE = `${DEEPAI_MODEL_BASE}/desktop_auth/exchange/`;

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

/** `fetch` wrapper with timeout and JSON error shaping. */
export async function deepaiFetch(url, { method = "GET", headers = {}, body, timeoutMs = 30000, allowNonOk = false } = {}) {
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

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const SMBIOS_PLACEHOLDERS = new Set([
  "00000000-0000-0000-0000-000000000000",
  "ffffffff-ffff-ffff-ffff-ffffffffffff",
  "03000200-0400-0500-0006-000700080009",
]);

function run(file, args) {
  return new Promise((resolve) => {
    execFile(file, args, { encoding: "utf8", timeout: 10000, windowsHide: true }, (error, stdout) =>
      resolve(error ? "" : stdout),
    );
  });
}

function parseSmbiosUUID(output) {
  const uuid = UUID_RE.exec(output)?.[0]?.toLowerCase() ?? null;
  return uuid && !SMBIOS_PLACEHOLDERS.has(uuid) ? uuid : null;
}

function parseMachineGuid(regQuery) {
  const match = /MachineGuid\s+REG_SZ\s+(\S+)/.exec(regQuery);
  return match?.[1] && UUID_RE.test(match[1]) ? match[1].toLowerCase() : null;
}

function parseLinuxMachineId(file) {
  const id = file.trim().toLowerCase();
  return /^[0-9a-f]{32}$/.test(id) && !/^0+$/.test(id) ? id : null;
}

/** Detects a machine identifier (Windows/macOS/Linux), like the bundle. */
export async function detectMachineId() {
  try {
    if (process.platform === "win32") {
      const smbios = await run("powershell", [
        "-NoProfile", "-NonInteractive", "-Command",
        "(Get-CimInstance Win32_ComputerSystemProduct).UUID",
      ]);
      const uuid = parseSmbiosUUID(smbios);
      if (uuid) return uuid;
      const guid = await run("reg", ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"]);
      return parseMachineGuid(guid);
    }
    if (process.platform === "darwin") {
      const ioreg = await run("ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"]);
      const match = /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(ioreg);
      return match?.[1] && UUID_RE.test(match[1]) ? match[1].toLowerCase() : null;
    }
    for (const p of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
      try {
        const id = parseLinuxMachineId(readFileSync(p, "utf8"));
        if (id) return id;
      } catch {
        // try next path
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** `X-DeepAI-Code-Machine` header value: sha256hex(machineId). */
export async function machineHeader() {
  const raw = await detectMachineId();
  if (!raw) return {};
  return { [HEADER_MACHINE]: createHash("sha256").update(raw).digest("hex") };
}

/** Instance header value: 16 random bytes hex. */
export function instanceId() {
  return randomBytes(16).toString("hex");
}

/** Baseline lane headers shared by every DeepAI model API call. */
export async function deepaiBaseHeaders(apiKey, opts = {}) {
  const headers = {
    "Content-Type": "application/json",
    [HEADER_THEOS]: DEEPAI_LANE_VERSION,
    [HEADER_INSTANCE]: instanceId(),
    ...(await machineHeader()),
    ...(apiKey ? { [HEADER_API_KEY]: apiKey } : {}),
  };
  if (opts.checkIn) headers[HEADER_CHECK_IN] = opts.checkIn;
  if (opts.beacon) headers[HEADER_BEACON] = opts.beacon;
  return headers;
}

/** Reads a probe account file (same shape as `lib/accounts.ts`). */
export function readAccountsFile(path) {
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === "object") {
    if (Array.isArray(parsed.accounts)) return parsed.accounts;
    if (typeof parsed.accessToken === "string" || typeof parsed.apiKey === "string") return [parsed];
  }
  throw new Error(`No account list found in ${path}`);
}

/** Picks an account by label/index/provider. */
export function pickAccount(accounts, opts = {}) {
  const label = opts.label?.trim();
  if (label) {
    const found = accounts.find((a) => a.label === label);
    if (!found) throw new Error(`No account labeled "${label}"`);
    return found;
  }
  if (opts.index !== undefined) {
    const account = accounts[opts.index];
    if (!account) throw new Error(`No account at index ${opts.index}`);
    return account;
  }
  return accounts[0];
}

/** Returns the DeepAI API key from an ExportedAccount, failing loudly. */
export function requireDeepAIApiKey(account) {
  const key = account.accessToken?.trim() ?? account.apiKey?.trim();
  if (!key) throw new Error(`Account "${account.label ?? account.id ?? "?"}" has no accessToken`);
  return key;
}

/** Serializes an account object to a JSON file (ExportedAccount shape). */
export function persistAccount(account, outFile) {
  mkdirSync(dirname(outFile), { recursive: true });
  const payload = {
    exportedAt: new Date().toISOString(),
    accounts: [account],
  };
  writeFileSync(outFile, JSON.stringify(payload, null, 2) + "\n", "utf8");
  console.log(`\n[credential] written to ${outFile}`);
}

/** Fresh random state token. */
export function makeState() {
  return randomUUID().replace(/-/g, "");
}
