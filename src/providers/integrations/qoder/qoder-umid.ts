/**
 * Qoder native machine identity (UMID) — the genuine SG bridge via umidpack.
 *
 * Research record (2026-10-30): same-account controls found that the daily
 * CREDITS campaign does not gate grants on machine identity. This module
 * prefers the vendor bridge for stable native identity and seed replay, with
 * a deterministic generated fallback when no bridge is available.
 *
 * Seed semantics (verified live): the Linux ELF resolves the user home via
 * the passwd entry — it ignores `$HOME`/`XDG_CONFIG_HOME`, so the seed file
 * is always `/home/<user>/.config/.locale_cfg`, one global file per Linux
 * user. Per-account isolation therefore lives in the DATABASE (each account
 * stores its own 350-byte seed) plus a flock-serialized bridge section:
 * mint = wipe → run → capture seed+token; replay = write stored seed → run.
 * Verified cycle (umidpack ELF under WSL): mint A, mint B (distinct),
 * replay A ✓, replay B ✓, replay A again ✓.
 *
 * Platform behavior:
 *   win32  — the exe is hardware-bound: one identity per machine, no seed.
 *   linux  — direct spawn of the umidpack ELF, serialized seed file.
 *   darwin — the Mach-O runs directly; seed path is the macOS user home.
 *   win32 + WSL (this repo's primary deployment) — the ELF runs via WSL with
 *            flock serialization; the bridge binary is staged into /tmp once.
 *
 * The generated path remains a fallback for hosts with no usable bridge. It
 * produces deterministic, well-shaped tokens but is not an SG identity. Live
 * controls showed that machine identity does not gate daily CREDITS grants.
 *
 * Bridge CLI (donor-verified):
 *   linux : runtime-info <env>
 *   darwin: printf '{"account":"<uid>"}\n' | runtime-info <env> --account-stdin
 *   win32 : runtime-info.exe <env> [--account-stdin]
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { log } from "../../../observability/logger";
import { qoderMachineHostname, qoderMachineOs } from "../../operations/cli-platform";

/** Environment code: an upstream "region/flavor", not a device identity. */
const ENV_CODE = "3";

/** One native identity sample (same shape the bridge prints). */
export interface QoderNativeIdentity {
  readonly machineToken: string;
  readonly machineType: string;
  readonly machineCode: string;
  readonly isVm: boolean;
  readonly source: "runtime-info" | "generated";
}

/** Length of the base64url payload after the `P1gA` prefix (token total 88). */
const TOKEN_PAYLOAD_LENGTH = 84;
/** Hex length of machineType / machineCode in the bridge's output. */
const MACHINE_TYPE_LENGTH = 18;
const MACHINE_CODE_LENGTH = 18;

/** Where the umidpack binaries live, relative to the repo root. */
export function umidpackDir(): string {
  return join(process.cwd(), "vendor", "qoder-umid", "umidpack");
}

/** The vendored mini-ELF tarball (static glibc bundle for containers). */
export function umidMiniTarball(): string {
  return join(process.cwd(), "vendor", "qoder-umid", "qoder-umid-mini.tar.gz");
}

/**
 * Staging directory for the extracted mini-ELF bundle. Uses a per-user cache
 * dir (respecting `XDG_CACHE_HOME` on Linux) so a container does not need to
 * carry the extracted tree, and the repo stays clean.
 */
export function umidMiniDir(): string {
  const base = process.env.XDG_CACHE_HOME?.trim() || join(process.env.HOME ?? tmpdir(), ".cache");
  return join(base, "cartethyia", "umid-mini");
}

let miniExtracted = false;

/** Extracts `qoder-umid-mini.tar.gz` once into {@link umidMiniDir}. */
export function ensureUmidMiniExtracted(): boolean {
  const tar = umidMiniTarball();
  const out = umidMiniDir();
  if (!existsSync(tar)) return false;
  if (existsSync(join(out, "opt", "umid", "runtime-info")) && miniExtracted) return true;
  try {
    mkdirSync(out, { recursive: true });
    // Re-extract on empty/missing target only; leave existing tree in place.
    if (!existsSync(join(out, "opt", "umid", "runtime-info"))) {
      const r = spawnSync("tar", ["-xzf", tar, "-C", out], { encoding: "utf8", timeout: 30_000 });
      if (r.status !== 0) {
        log.warn(`[qoder] umid mini extract failed: ${String(r.stderr ?? "").slice(0, 300)}`);
        return false;
      }
    }
    const bin = join(out, "opt", "umid", "runtime-info");
    if (existsSync(bin)) chmodSync(bin, 0o755);
    miniExtracted = true;
    return true;
  } catch (error) {
    log.warn("[qoder] umid mini extract error", error as Error);
    return false;
  }
}

/** WSL-side staging/seed paths for the Linux bridge on a Windows host. */
const WSL_BIN = "/tmp/umidpack/runtime-info";
const WSL_SEED = "/home/risun/.config/.locale_cfg";
const WSL_LOCK = "/tmp/umidpack/bridge.lock";

type Bridge = { kind: "elf" | "macho" | "pe" | "wsl-elf" | "mini-elf" };

/** True when this process runs inside a container (Docker/Podman). */
function isContainerized(): boolean {
  if (existsSync(join("/", ".dockerenv")) || existsSync(join("/", ".containerenv"))) return true;
  try {
    const cgroup = readFileSync("/proc/1/cgroup", "utf8");
    return /(?:docker|containerd|podman|kubepods)/i.test(cgroup);
  } catch {
    return false;
  }
}

/** Picks the bridge for this host; `null` when nothing genuine can run. */
function pickBridge(): Bridge | null {
  if (process.platform === "win32") {
    // Prefer the WSL ELF (seed-capable → per-account identities); fall back
    // to the Windows exe pair (hardware-bound, one identity per machine).
    const elf = join(umidpackDir(), "elf-x86_64", "runtime-info");
    if (existsSync(elf)) return { kind: "wsl-elf" };
    const exe = join(umidpackDir(), "runtime-info.exe");
    const dll = join(umidpackDir(), "sgsdk.dll");
    if (existsSync(exe) && existsSync(dll)) return { kind: "pe" };
    // Windows has no native mini-ELF runner; WSL may still be present.
    return ensureUmidMiniExtracted() ? { kind: "wsl-elf" } : null;
  }
  if (process.platform === "darwin") {
    const arch = process.arch === "arm64" ? "macho-arm64" : "macho-x86_64";
    // Prefer the re-signed adhoc `.clean` binary (DYLD-spoofable); the stock
    // vendored binary is Hardened Runtime and ignores DYLD_INSERT_LIBRARIES.
    const clean = join(umidpackDir(), arch, "runtime-info.clean");
    if (existsSync(clean)) return { kind: "macho" };
    return existsSync(join(umidpackDir(), arch, "runtime-info")) ? { kind: "macho" } : null;
  }
  // Linux. Containers (Docker/K8s/Podman) prefer the mini-ELF bundle: it ships
  // a static glibc tree and mints tokens with `isVm:false`, so a containerized
  // deployment is not flagged as a VM. Set CARTETHYIA_QODER_UMID_MINI=1 to
  // force it on any Linux host, or =0 to disable container detection.
  const miniForced = process.env.CARTETHYIA_QODER_UMID_MINI;
  const wantMini =
    miniForced === "1" || (miniForced !== "0" && isContainerized());
  if (wantMini && process.arch === "x64" && ensureUmidMiniExtracted()) {
    return { kind: "mini-elf" };
  }
  const arch = process.arch === "arm64" ? "elf-aarch64" : "elf-x86_64";
  if (existsSync(join(umidpackDir(), arch, "runtime-info"))) return { kind: "elf" };
  if (existsSync(join(umidpackDir(), "elf-x86_64", "runtime-info"))) return { kind: "elf" };
  // Linux without a native vendored ELF (e.g. a slim container with no mini):
  // fall back to the mini-ELF bundle when it extracts.
  if (ensureUmidMiniExtracted() && process.arch === "x64") return { kind: "mini-elf" };
  return null;
}

/** Generated (software) identity — deterministic per account id, NOT SG-signed. */
export function mintQoderGeneratedIdentity(accountId: string): QoderNativeIdentity {
  const first = createHash("sha256").update(accountId).digest("base64url");
  const second = createHash("sha256").update(`${accountId}:${first}`).digest("base64url");
  const token = `P1gA${`${first}${second}`.slice(0, TOKEN_PAYLOAD_LENGTH)}`;
  return {
    machineToken: token,
    machineType: createHash("sha256").update(`${accountId}:type`).digest("hex").slice(0, MACHINE_TYPE_LENGTH),
    machineCode: createHash("sha256").update(`${accountId}:code`).digest("hex").slice(0, MACHINE_CODE_LENGTH),
    isVm: false,
    source: "generated",
  };
}

/** Parse one bridge JSON line into an identity; null on any mismatch. */
function parseBridgeLine(stdout: string): QoderNativeIdentity | null {
  const line = stdout.split(/\r?\n/).find((l) => l.startsWith("{"));
  if (!line) return null;
  try {
    const rec = JSON.parse(line) as Record<string, unknown>;
    const machineToken = String(rec.machineToken ?? "").trim();
    const machineType = String(rec.machineType ?? "").trim();
    const machineCode = String(rec.machineCode ?? "").trim();
    if (!machineToken || !machineType || !machineCode) return null;
    const vmInfo = rec.vmInfo;
    const isVm = typeof vmInfo === "object" && vmInfo !== null && (vmInfo as Record<string, unknown>).isVm === true;
    return { machineToken, machineType, machineCode, isVm, source: "runtime-info" };
  } catch {
    return null;
  }
}

/** Stage the ELF into the WSL filesystem once (idempotent, fast after first). */
function ensureWslStaged(): void {
  const src = join(umidpackDir(), "elf-x86_64", "runtime-info").replace(/\\/g, "/");
  const drive = /^([A-Za-z]):/.exec(src);
  const wslSrc = drive ? `/mnt/${drive[1]!.toLowerCase()}${src.slice(2)}` : src;
  wsl(
    `mkdir -p /tmp/umidpack && cp "${wslSrc}" ${WSL_BIN} && chmod +x ${WSL_BIN} && ` +
    `mkdir -p $(dirname ${WSL_SEED})`,
  );
}

function wsl(script: string, timeout = 120_000): string {
  const r = spawnSync("wsl", ["-e", "bash", "-lc", script], { encoding: "utf8", timeout, windowsHide: true });
  return String(r.stdout ?? "");
}

/**
 * Best-effort make a POSIX bridge binary executable before spawning it. The
 * umidpack binaries are committed without the exec bit (git mode 100644) and
 * nothing else in the delivery path sets it — a Docker image or a fresh clone
 * on Linux/macOS would otherwise fail to spawn them (EACCES -> "[qoder] elf
 * mint failed"). Idempotent; if it cannot set the bit, `spawnSync` reports
 * the real failure as before.
 */
export function ensurePosixExecutable(file: string): void {
  try {
    chmodSync(file, 0o755);
  } catch {
    /* spawn will report the actual error */
  }
}

/** Run the bridge inside WSL under flock; returns the identity or null. */

function seedPath(): string {
  if (process.platform === "win32") return WSL_SEED;
  const home = process.env.HOME ?? "";
  return join(home, ".config", ".locale_cfg");
}

/**
 * Mints a fresh native identity: wipe the seed (under the lock), run the
 * bridge, capture the identity AND the seed it wrote. The seed is required
 * for later replay of this same native identity. Returns `null` when the
 * bridge fails; falls back to the generated identity only when no bridge
 * exists.
 */
export function mintQoderNativeIdentity(accountId: string): { identity: QoderNativeIdentity; seed: string } | null {
  const bridge = pickBridge();
  if (!bridge) {
    log.warn("[qoder] no native bridge for this host — using generated identity fallback");
    return { identity: mintQoderGeneratedIdentity(accountId), seed: "" };
  }

  if (bridge.kind === "wsl-elf") {
    ensureWslStaged();
    const out = wsl(
      `exec 9>${WSL_LOCK}; flock 9; rm -f ${WSL_SEED}; ${WSL_BIN} ${ENV_CODE}`,
    );
    const identity = parseBridgeLine(out);
    if (!identity) { log.warn("[qoder] wsl mint failed"); return null; }
    const seed = wsl(`cat ${WSL_SEED}`);
    return { identity, seed };
  }

  if (bridge.kind === "elf") {
    const exe = join(umidpackDir(), process.arch === "arm64" ? "elf-aarch64" : "elf-x86_64", "runtime-info");
    ensurePosixExecutable(exe);
    const seed = seedPath();
    const dir = seed.slice(0, seed.lastIndexOf("/"));
    mkdirSync(dir, { recursive: true });
    try { spawnSync("rm", ["-f", seed]); } catch { /* ignore */ }
    const r = spawnSync(exe, [ENV_CODE], { encoding: "utf8", timeout: 25_000 });
    const identity = parseBridgeLine(String(r.stdout ?? ""));
    if (!identity) { log.warn("[qoder] elf mint failed"); return null; }
    return { identity, seed: existsSync(seed) ? readFileSync(seed, "utf8") : "" };
  }

  if (bridge.kind === "macho") {
    const arch = process.arch === "arm64" ? "macho-arm64" : "macho-x86_64";
    const exe = join(umidpackDir(), arch, "runtime-info");
    ensurePosixExecutable(exe);
    const seed = seedPath();
    const dir = seed.slice(0, seed.lastIndexOf("/"));
    mkdirSync(dir, { recursive: true });
    try { spawnSync("rm", ["-f", seed]); } catch { /* ignore */ }
    const r = spawnSync(exe, [ENV_CODE, "--account-stdin"], {
      input: `${JSON.stringify({ account: accountId })}\n`,
      encoding: "utf8",
      timeout: 25_000,
    });
    const identity = parseBridgeLine(String(r.stdout ?? ""));
    if (!identity) { log.warn("[qoder] macho mint failed"); return null; }
    return { identity, seed: existsSync(seed) ? readFileSync(seed, "utf8") : "" };
  }

  if (bridge.kind === "mini-elf") {
    const exe = join(umidMiniDir(), "opt", "umid", "runtime-info");
    ensurePosixExecutable(exe);
    const seed = seedPath();
    const dir = seed.slice(0, seed.lastIndexOf("/"));
    mkdirSync(dir, { recursive: true });
    try { spawnSync("rm", ["-f", seed]); } catch { /* ignore */ }
    const r = spawnSync(exe, [ENV_CODE], {
      encoding: "utf8",
      timeout: 25_000,
      env: { ...process.env, LD_LIBRARY_PATH: join(umidMiniDir(), "lib", "x86_64-linux-gnu") },
    });
    const identity = parseBridgeLine(String(r.stdout ?? ""));
    if (!identity) { log.warn("[qoder] mini-elf mint failed"); return null; }
    return { identity, seed: existsSync(seed) ? readFileSync(seed, "utf8") : "" };
  }

  // pe — hardware-bound; no seed concept on Windows.
  const exe = join(umidpackDir(), "runtime-info.exe");
  const r = spawnSync(exe, [ENV_CODE], { encoding: "utf8", timeout: 30_000, windowsHide: true, cwd: umidpackDir() });
  const identity = parseBridgeLine(String(r.stdout ?? ""));
  if (!identity) { log.warn("[qoder] pe mint failed"); return null; }
  return { identity, seed: "" };
}

/**
 * Replays an identity from a stored seed: materialize the seed at the bridge's
 * fixed path (under the lock) and re-run — the caller verifies the token
 * matches the stored record. Returns `null` when no seed is available, the
 * host cannot replay (Windows exe), or the bridge failed.
 */
export function replayQoderNativeIdentity(seed: string, accountId: string): QoderNativeIdentity | null {
  if (!seed) return null;
  const bridge = pickBridge();
  if (!bridge) return null;

  if (bridge.kind === "wsl-elf") {
    ensureWslStaged();
    const quoted = seed.replace(/'/g, `'\\''`);
    const out = wsl(
      `exec 9>${WSL_LOCK}; flock 9; printf '%s' '${quoted}' > ${WSL_SEED}; ${WSL_BIN} ${ENV_CODE}`,
    );
    return parseBridgeLine(out);
  }

  if (bridge.kind === "elf") {
    const exe = join(umidpackDir(), process.arch === "arm64" ? "elf-aarch64" : "elf-x86_64", "runtime-info");
    ensurePosixExecutable(exe);
    const seed = seedPath();
    writeFileSync(seed, seed, "utf8");
    const r = spawnSync(exe, [ENV_CODE], { encoding: "utf8", timeout: 25_000 });
    return parseBridgeLine(String(r.stdout ?? ""));
  }

  if (bridge.kind === "macho") {
    const arch = process.arch === "arm64" ? "macho-arm64" : "macho-x86_64";
    const exe = join(umidpackDir(), arch, "runtime-info");
    ensurePosixExecutable(exe);
    const seedPathStr = seedPath();
    writeFileSync(seedPathStr, seed, "utf8");
    const r = spawnSync(exe, [ENV_CODE, "--account-stdin"], {
      input: `${JSON.stringify({ account: accountId })}\n`,
      encoding: "utf8",
      timeout: 25_000,
    });
    return parseBridgeLine(String(r.stdout ?? ""));
  }

  if (bridge.kind === "mini-elf") {
    const exe = join(umidMiniDir(), "opt", "umid", "runtime-info");
    ensurePosixExecutable(exe);
    const seedPathStr = seedPath();
    writeFileSync(seedPathStr, seed, "utf8");
    const r = spawnSync(exe, [ENV_CODE], {
      encoding: "utf8",
      timeout: 25_000,
      env: { ...process.env, LD_LIBRARY_PATH: join(umidMiniDir(), "lib", "x86_64-linux-gnu") },
    });
    return parseBridgeLine(String(r.stdout ?? ""));
  }

  return null; // pe: cannot replay a seed on a hardware-bound identity
}

/**
 * The six native machine headers for one identity.
 *
 * The upstream treats `cosy-machineid` as a stable UUID-shaped machine id
 * (the desktop client caches it; the donor hub derives a UUIDv4 from the
 * account uid). The native machineToken/Type/Code come from the UMID bridge.
 * The OS and hostname are derived from the real runtime (`qoderMachineOs` /
 * `qoderMachineHostname`), not hardcoded — the campaign surface fingerprint
 * must match the actual client (verified live 2026-11-04).
 */
export function qoderMachineHeaders(identity: QoderNativeIdentity, machineId?: string): Record<string, string> {
  const mid = machineId && machineId.length > 0 ? machineId : identity.machineToken;
  return {
    "cosy-machineid": mid,
    "cosy-machinetoken": identity.machineToken,
    "cosy-machinetype": identity.machineType,
    "cosy-machinecode": identity.machineCode,
    "cosy-machineos": qoderMachineOs(),
    "cosy-machinehostname": qoderMachineHostname(),
  };
}
