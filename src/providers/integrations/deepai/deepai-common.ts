// DeepAI shared wire helpers.
//
// Wire facts reconstructed from the DeepAI Code 0.3.35 bundle and verified
// live 2026-11-11 (see `documentation/research/deepai/`):
//
//   - Model base is `https://api.deepai.org/deepai_code`; the sign-in flow
//     (`/deepai_code/desktop_auth/`) returns an opaque `api_key`.
//   - Every model call carries:
//       `X-DeepAI-Code-Theos: 4`   (lane version)
//       `X-DeepAI-Code-Instance`     (16 random bytes hex, per process)
//       `X-DeepAI-Code-Machine`      (sha256hex of the machine id)
//       `Api-Key: <api_key>`         (the credential; NOT a Bearer)
//   - The machine header is a digest of a platform identifier (SMBIOS UUID /
//     MachineGuid / `/etc/machine-id`); the raw identifier never leaves the
//     machine. The grant is bound to the account, not the machine, so a
//     missing/mangled machine header is tolerated (verified live).
import { randomBytes } from "node:crypto";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";

export const DEEPAI_PROVIDER_ID = "deepai" as const;
export const DEEPAI_API_ORIGIN = "https://api.deepai.org";
export const DEEPAI_MODEL_BASE = `${DEEPAI_API_ORIGIN}/deepai_code`;

export const DEEPAI_LANE_VERSION = "4";
export const DEEPAI_HEADER_THEOS = "X-DeepAI-Code-Theos";
export const DEEPAI_HEADER_INSTANCE = "X-DeepAI-Code-Instance";
export const DEEPAI_HEADER_MACHINE = "X-DeepAI-Code-Machine";
export const DEEPAI_HEADER_API_KEY = "Api-Key";

export const DEEPAI_CHAT_PATH = "/deepai_code/chat/completions";
export const DEEPAI_RESPONSES_PATH = "/deepai_code/responses";
export const DEEPAI_MODELS_PATH = "/deepai_code/models";
export const DEEPAI_THEOS_PATH = "/deepai_code/theos";
export const DEEPAI_USAGE_SUMMARY_PATH = "/get_usage_summary";
export const DEEPAI_SIGNIN_PATH = "/deepai_code/desktop_auth/";
export const DEEPAI_EXCHANGE_PATH = "/deepai_code/desktop_auth/exchange/";

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const SMBIOS_PLACEHOLDERS = new Set([
  "00000000-0000-0000-0000-000000000000",
  "ffffffff-ffff-ffff-ffff-ffffffffffff",
  "03000200-0400-0500-0006-000700080009",
]);

function run(file: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      file,
      [...args],
      { encoding: "utf8", timeout: 10_000, windowsHide: true },
      (error, stdout) => resolve(error ? "" : stdout),
    );
  });
}

function parseSmbiosUUID(output: string): string | null {
  const uuid = UUID_RE.exec(output)?.[0]?.toLowerCase() ?? null;
  return uuid && !SMBIOS_PLACEHOLDERS.has(uuid) ? uuid : null;
}

function parseMachineGuid(regQuery: string): string | null {
  const match = /MachineGuid\s+REG_SZ\s+(\S+)/.exec(regQuery);
  return match?.[1] && UUID_RE.test(match[1]) ? match[1].toLowerCase() : null;
}

function parseLinuxMachineId(file: string): string | null {
  const id = file.trim().toLowerCase();
  return /^[0-9a-f]{32}$/.test(id) && !/^0+$/.test(id) ? id : null;
}

function detectMachineId(): Promise<string | null> {
  try {
    if (process.platform === "win32") {
      return (async () => {
        const smbios = await run("powershell", [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "(Get-CimInstance Win32_ComputerSystemProduct).UUID",
        ]);
        const uuid = parseSmbiosUUID(smbios);
        if (uuid) return uuid;
        const guid = await run("reg", [
          "query",
          "HKLM\\SOFTWARE\\Microsoft\\Cryptography",
          "/v",
          "MachineGuid",
        ]);
        return parseMachineGuid(guid);
      })();
    }
    if (process.platform === "darwin") {
      return (async () => {
        const ioreg = await run("ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"]);
        const match = /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(ioreg);
        return match?.[1] && UUID_RE.test(match[1]) ? match[1].toLowerCase() : null;
      })();
    }
    for (const path of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
      try {
        const id = parseLinuxMachineId(readFileSync(path, "utf8"));
        if (id) return Promise.resolve(id);
      } catch {
        // try the next path
      }
    }
    return Promise.resolve(null);
  } catch {
    return Promise.resolve(null);
  }
}

let machineDigestPromise: Promise<string | null> | undefined;

/** sha256hex(machineId), computed once per process; null when unreadable. */
export function deepAIMachineDigest(): Promise<string | null> {
  machineDigestPromise ??= detectMachineId().then(
    (raw) => (raw === null ? null : createHash("sha256").update(raw).digest("hex")),
  );
  return machineDigestPromise;
}

/** Fresh per-process instance id (16 random bytes hex). */
export function deepAIInstanceId(): string {
  return randomBytes(16).toString("hex");
}

/**
 * Baseline DeepAI headers shared by every model API call. `apiKey` is the
 * account credential (the sign-in `api_key`); omit it for unauthenticated
 * reads (model catalog).
 */
export async function deepAIBaseHeaders(apiKey?: string): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    [DEEPAI_HEADER_THEOS]: DEEPAI_LANE_VERSION,
    [DEEPAI_HEADER_INSTANCE]: deepAIInstanceId(),
  };
  const machine = await deepAIMachineDigest();
  if (machine !== null) headers[DEEPAI_HEADER_MACHINE] = machine;
  if (apiKey !== undefined && apiKey.length > 0) headers[DEEPAI_HEADER_API_KEY] = apiKey;
  return headers;
}
