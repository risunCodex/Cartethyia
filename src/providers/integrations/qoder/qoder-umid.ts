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
import { readFileSync } from "node:fs";
import {
  arch as osArch,
  cpus,
  hostname,
  platform as osPlatform,
  release as osRelease,
  totalmem,
  userInfo,
} from "node:os";
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

/** No bridge exists anymore; the OS mint is the only path. */
export function mintQoderNativeIdentity(accountId = ""): QoderNativeIdentity {
  return mintQoderOsIdentity(accountId);
}

/** Replay is a no-op: the OS identity is deterministic and host-bound. */
export function replayQoderNativeIdentity(_seed: string, accountId = ""): QoderNativeIdentity | null {
  return mintQoderOsIdentity(accountId);
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
