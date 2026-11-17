/**
 * Qoder OS-derived machine identity — donor-style deterministic derivation.
 *
 * The vendor bridge (runtime-info / umidpack) is no longer vendored or
 * executed. This module derives the machine identity with the same *shape*
 * and *derivation pattern* as the donor hub's fingerprint module:
 *
 *   - `derive_id(uid, salt)` → a UUIDv4-shaped id (version nibble `4`,
 *     variant nibble `a`), stable per (uid, salt).
 *   - `derive_machine_token(uid)` → a base64url-looking 43-char token
 *     (sha512-derived).
 *   - `derive_machine_type(uid)` → 18 hex chars.
 *
 * The donor salted with the account uid alone. We salt with the **OS
 * fingerprint + account uid** instead: the fingerprint keeps the identity
 * host-stable (one machine = one base), and the uid keeps accounts
 * isolated on the same host — the same collision-avoidance property the
 * native bridge had (per-machine hardware identity, but per-account seeds).
 *
 * The result is deterministic, offline, and never touches the network. It is
 * not an Alibaba SG-signed token — it is a spoofed native-shaped identity.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import {
  arch as osArch,
  cpus,
  hostname,
  platform as osPlatform,
  release as osRelease,
  totalmem,
  userInfo,
} from "node:os";
import { resolveDataDir } from "../../../persistence/db-mode";
import { log } from "../../../observability/logger";
import { qoderMachineHostname, qoderMachineOs } from "../../operations/cli-platform";

/** One machine identity sample (same shape the bridge printed). */
export interface QoderNativeIdentity {
  readonly machineToken: string;
  readonly machineType: string;
  readonly machineCode: string;
  readonly isVm: boolean;
  readonly source: "runtime-info" | "generated" | "os";
}

/** Hex length of machineType / machineCode (donor `derive_id` output, dashes stripped). */
const MACHINE_TYPE_LENGTH = 18;
const MACHINE_CODE_LENGTH = 18;
/** base64url token length after the sha512 digest (donor `derive_machine_token`). */
const MACHINE_TOKEN_LENGTH = 43;

/** Reads a file if it exists, trimming whitespace; empty string otherwise. */
function readTrimmed(path: string): string {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return "";
  }
}

/** Best-effort machine id per platform (empty when unavailable without a spawn). */
function machineId(): string {
  if (process.platform === "linux") {
    return (
      readTrimmed("/etc/machine-id") ||
      readTrimmed("/var/lib/dbus/machine-id") ||
      readTrimmed("/sys/class/dmi/id/product_uuid")
    );
  }
  return "";
}

/** Collects a stable, host-unique fingerprint string (the salt base). */
export function collectOsFingerprint(): string {
  const parts: string[] = [
    hostname(),
    osPlatform(),
    osArch(),
    osRelease(),
    String(cpus().length),
    String(Math.floor(totalmem() / (1024 * 1024))),
    qoderMachineOs(),
    qoderMachineHostname(),
  ];
  const mid = machineId();
  if (mid) parts.push(mid);
  const user = userInfo().username;
  if (user) parts.push(user);
  return parts.join("\n");
}

/** Donor `derive_id`: md5(salt:uid) → UUIDv4-shaped id (version 4, variant a). */
function deriveId(uid: string, salt: string): string {
  const seed = `${salt}:${uid || "anonymous"}`;
  let h = createHash("md5").update(seed).digest("hex");
  // Force the UUIDv4 version (13th nibble) and variant (17th nibble).
  h = h.slice(0, 12) + "4" + h.slice(13, 16) + "a" + h.slice(17);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** Donor `derive_machine_token`: sha512 → base64url, 43 chars. */
function deriveMachineToken(uid: string, salt: string): string {
  const raw = createHash("sha512").update(`machinetoken:${salt}:${uid}`).digest();
  return raw.toString("base64url").slice(0, MACHINE_TOKEN_LENGTH);
}

/** Donor `derive_machine_type`: derive_id without dashes, 18 chars. */
function deriveMachineType(uid: string, salt: string): string {
  return deriveId(uid, `machinetype:${salt}`).replaceAll("-", "").slice(0, MACHINE_TYPE_LENGTH);
}

/**
 * Derives a machine identity for one account from the host OS fingerprint +
 * account uid. Deterministic: same host + same account → same identity.
 */
export function mintQoderOsIdentity(accountId: string): QoderNativeIdentity {
  const salt = collectOsFingerprint();
  const uid = accountId || "anonymous";
  return {
    machineToken: deriveMachineToken(uid, salt),
    machineType: deriveMachineType(uid, salt),
    machineCode: deriveId(uid, `machinecode:${salt}`).replaceAll("-", "").slice(0, MACHINE_CODE_LENGTH),
    isVm: false,
    source: "os",
  };
}

/** Legacy alias retained for callers that still import the generated mint. */
export function mintQoderGeneratedIdentity(accountId: string): QoderNativeIdentity {
  return mintQoderOsIdentity(accountId);
}

// ── Native bridge (runtime-info) ───────────────────────────────────────────
//
// The vendor bridge is the machine-identity component the official client
// ships (`resources/umid/runtime-info[.exe]` + the Windows `sgsdk.dll`). The
// hub's wire audits proved the server scores this identity: a real bridge
// output is a first-party device, an OS-derived one is a shaped spoof, and a
// full set of *derived* headers is actively filtered (donor issue #10) or
// pinned into the low-priority queue (donor issue #158: sustained
// `queueType: "p4"` on every account/realm/model while quota reads healthy —
// the score is machine-level, and `runtime-info` output is byte-identical
// across accounts on one host).
//
// Extraction lives in `scripts/tools/qoder-umid-extract.mjs` (downloads the
// npm `@qoder-ai/qodercli` tarball, carves the per-platform components by
// magic bytes — the same recipe the hub proved). This module only locates and
// executes the bridge; it never vendors binaries in-tree.

/** Windows needs the sibling SG SDK next to the bridge executable. */
export function runtimeInfoExePath(env: NodeJS.ProcessEnv = process.env): string | null {
  const override = env["QD_UMID_DIR"];
  const dir =
    override !== undefined && override.trim().length > 0
      ? override.trim()
      : join(resolveDataDir(env), "qoder-umid", `${osPlatform()}-${osArch()}`);
  const exe = process.platform === "win32" ? "runtime-info.exe" : "runtime-info";
  const path = join(dir, exe);
  if (!existsSync(path)) return null;
  if (process.platform === "win32" && !existsSync(join(dir, "sgsdk.dll"))) return null;
  return path;
}

/** The bridge's deployment selector: `0` = CN online, `3` = intl desktop. */
export function runtimeInfoEnvCode(realm: string): string {
  return realm === "cn" ? "0" : "3";
}

interface RuntimeInfoOutput {
  readonly machineToken?: unknown;
  readonly machineType?: unknown;
  readonly machineCode?: unknown;
  readonly vmInfo?: { readonly isVm?: unknown };
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * One bridge invocation. Contract (desktop 0.4.8 / CLI 1.1.75): the component
 * prints one JSON object — `{machineToken, machineType, machineCode, vmInfo}`,
 * where darwin/win32 take the account on stdin (`--account-stdin`) and accept
 * any/absent account (the output is machine-scoped).
 */
export function runQoderRuntimeInfo(
  realm: string,
  accountId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<QoderNativeIdentity | null> {
  return new Promise((resolve) => {
    const exe = runtimeInfoExePath(env);
    if (exe === null) return resolve(null);
    const args = [runtimeInfoEnvCode(realm)];
    const darwinOrWin = process.platform === "darwin" || process.platform === "win32";
    if (darwinOrWin) args.push("--account-stdin");
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(exe, args, { cwd: join(exe, ".."), stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    } catch {
      return resolve(null);
    }
    const timer = setTimeout(() => child.kill(), 25_000);
    let stdout = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    const finish = (value: QoderNativeIdentity | null) => {
      clearTimeout(timer);
      resolve(value);
    };
    child.on("error", () => finish(null));
    child.on("close", () => {
      try {
        const parsed = JSON.parse(stdout.trim()) as RuntimeInfoOutput;
        const machineToken = nonEmpty(parsed.machineToken);
        const machineType = nonEmpty(parsed.machineType);
        const machineCode = nonEmpty(parsed.machineCode);
        if (machineToken === undefined || machineType === undefined || machineCode === undefined) {
          return finish(null);
        }
        finish({
          machineToken,
          machineType,
          machineCode,
          isVm: parsed.vmInfo?.isVm === true,
          source: "runtime-info",
        });
      } catch {
        finish(null);
      }
    });
    if (darwinOrWin) child.stdin?.end(`${JSON.stringify({ account: accountId })}\n`);
    else child.stdin?.end();
  });
}

const IDENTITY_VOTE_ROUNDS = 3;

/**
 * Majority-voted bridge identity for one realm.
 *
 * The component's VM verdict can flap between runs (KVM/13 ↔ Docker/50 on the
 * same host, the hub's live observation), so three rounds vote on the
 * identity-bearing fields (token/type/code/isVm) and the majority wins. Any
 * instability means we keep the round that matches the winning token — the
 * token is the identity, the verdict fields ride along.
 */
export async function sampleQoderNativeIdentity(
  realm: string,
  accountId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<QoderNativeIdentity | null> {
  if (env["CARTETHYIA_QODER_NATIVE_IDENTITY"] === "0") return null;
  const exe = runtimeInfoExePath(env);
  if (exe === null) return null;
  const rounds = await Promise.all(
    Array.from({ length: IDENTITY_VOTE_ROUNDS }, () => runQoderRuntimeInfo(realm, accountId, env)),
  );
  const valid = rounds.filter((r): r is QoderNativeIdentity => r !== null);
  if (valid.length === 0) return null;
  const counts = new Map<string, number>();
  for (const round of valid) {
    const key = `${round.machineToken}|${round.machineType}|${round.machineCode}|${round.isVm ? 1 : 0}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let bestKey = "";
  let bestCount = 0;
  for (const [key, count] of counts) {
    if (count > bestCount) {
      bestKey = key;
      bestCount = count;
    }
  }
  const winner = valid.find(
    (r) => `${r.machineToken}|${r.machineType}|${r.machineCode}|${r.isVm ? 1 : 0}` === bestKey,
  );
  if (winner === undefined) return null;
  if (bestCount < IDENTITY_VOTE_ROUNDS) {
    log.warn(`[qoder] runtime-info identity flapped (${bestCount}/${IDENTITY_VOTE_ROUNDS} rounds agree); using the majority sample`);
  }
  return winner;
}

/**
 * The six native machine headers for one identity.
 *
 * The upstream treats `cosy-machineid` as a stable UUID-shaped machine id.
 * OS-derived identities (source "os") keep the full header set — they are
 * host-stable, per-account isolated, and shaped like the bridge output.
 * Generated identities (source "generated") do NOT send the full set: the
 * upstream filters the daily CREDITS campaign when a full set of derived
 * headers appears (donor issue #10).
 */
export function qoderMachineHeaders(identity: QoderNativeIdentity, machineId?: string): Record<string, string> {
  const mid = machineId && machineId.length > 0 ? machineId : identity.machineToken;
  const headers: Record<string, string> = {
    "cosy-machineid": mid,
    "cosy-machineos": qoderMachineOs(),
    "cosy-machinehostname": qoderMachineHostname(),
  };
  if (identity.source !== "generated") {
    headers["cosy-machinetoken"] = identity.machineToken;
    headers["cosy-machinetype"] = identity.machineType;
    headers["cosy-machinecode"] = identity.machineCode;
  }
  return headers;
}
