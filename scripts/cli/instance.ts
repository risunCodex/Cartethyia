import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pidAlive } from "../../src/shared/process";

const RUNTIME_STATE_FILE = "runtime.json";

interface RuntimeState {
  readonly drainToken: string;
}

function statePath(): string | null {
  const configDir = process.env.CARTETHYIA_CONFIG_DIR;
  return configDir ? join(configDir, RUNTIME_STATE_FILE) : null;
}

function readState(): RuntimeState | null {
  const path = statePath();
  if (path === null || !existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (parsed !== null && typeof parsed === "object" && "drainToken" in parsed &&
      typeof parsed.drainToken === "string" && parsed.drainToken.length > 0) {
      return { drainToken: parsed.drainToken };
    }
  } catch {
    // Corrupt state reads as no token and is replaced on next start.
  }
  return null;
}

/** Returns the install's persistent drain token, creating it on first use. */
export function ensureDrainToken(): string {
  const existing = readState();
  if (existing !== null) return existing.drainToken;
  const token = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
  const path = statePath();
  if (path !== null) {
    try {
      writeFileSync(path, JSON.stringify({ drainToken: token }), { encoding: "utf8", mode: 0o600 });
    } catch {
      // A read-only config directory only loses stop-from-another-process.
    }
  }
  return token;
}

export function readPersistedDrainToken(): string | null {
  return readState()?.drainToken ?? null;
}

/**
 * A marker that one gateway owns this install's port.
 *
 * The port probe alone cannot tell a healthy gateway from a stranger's process:
 * something answering on 12800 is not necessarily ours, so a start that found
 * the port busy either failed outright or — worse — would have to guess before
 * stopping anything. The lock names the PID and the token it was written with,
 * which is what makes "is this our gateway?" answerable without guessing.
 *
 * It is advisory, not an OS lock: a stale file from a crashed process is the
 * normal case this exists to recover from, so presence alone never blocks a
 * start. Liveness is decided by probing the port, and identity by the token.
 */
export interface InstanceLock {
  readonly pid: number;
  readonly port: number;
  /** Fingerprint of the drain token, never the token itself. */
  readonly tokenFingerprint: string;
  readonly startedAt: string;
  readonly executable: string;
}

const LOCK_FILE = "instance.json";

function lockPath(): string | null {
  const configDir = process.env.CARTETHYIA_CONFIG_DIR;
  return configDir ? join(configDir, LOCK_FILE) : null;
}

/** A short, non-reversible fingerprint so the token itself is never written. */
export function fingerprint(token: string): string {
  let hash = 0;
  for (let i = 0; i < token.length; i += 1) {
    hash = (hash * 31 + token.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function writeInstanceLock(port: number, pid: number, token: string, executable = ""): void {
  const path = lockPath();
  if (path === null) return;
  const lock: InstanceLock = {
    pid,
    port,
    tokenFingerprint: fingerprint(token),
    startedAt: new Date().toISOString(),
    executable,
  };
  try {
    writeFileSync(path, JSON.stringify(lock), { encoding: "utf8", mode: 0o600 });
  } catch {
    // A read-only config directory costs the marker, not the run.
  }
}

export function readInstanceLock(): InstanceLock | null {
  const path = lockPath();
  if (path === null || !existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      "pid" in parsed &&
      typeof parsed.pid === "number" &&
      "port" in parsed &&
      typeof parsed.port === "number" &&
      "tokenFingerprint" in parsed &&
      typeof parsed.tokenFingerprint === "string"
    ) {
      const startedAt = "startedAt" in parsed && typeof parsed.startedAt === "string" ? parsed.startedAt : "";
      return {
        pid: parsed.pid,
        port: parsed.port,
        tokenFingerprint: parsed.tokenFingerprint,
        startedAt,
        executable: "executable" in parsed && typeof parsed.executable === "string" ? parsed.executable : "",
      };
    }
  } catch {
    // A corrupt marker reads as none.
  }
  return null;
}

export function clearInstanceLock(): void {
  const path = lockPath();
  if (path === null) return;
  try {
    unlinkSync(path);
  } catch {
    // Already gone, or the directory is read-only.
  }
}

export interface RunningGateway { pid: number; port: number; executable: string; }

interface InstanceDependencies {
  alive: (pid: number) => boolean;
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  kill: (pid: number) => void;
  sleep: (ms: number) => Promise<void>;
}
const instanceDependencies: InstanceDependencies = {
  alive: pidAlive,
  fetch: (input, init) => fetch(input, init),
  kill: (pid) => process.kill(pid, "SIGTERM"),
  sleep: Bun.sleep,
};

export async function findRunningGateway(port: number, token: string): Promise<RunningGateway | null> {
  const lock = readInstanceLock();
  if (lock === null || lock.port !== port || lock.tokenFingerprint !== fingerprint(token)) return null;
  if (!instanceDependencies.alive(lock.pid)) {
    clearInstanceLock();
    return null;
  }
  try {
    const response = await instanceDependencies.fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1_000) });
    if (!response.ok) return null;
    return { pid: lock.pid, port, executable: lock.executable };
  } catch {
    return null;
  }
}

export async function attachGateway(port: number, token: string): Promise<RunningGateway | null> {
  return findRunningGateway(port, token);
}

export async function stopAttachedGateway(instance: RunningGateway, token: string): Promise<void> {
  const lock = readInstanceLock();
  if (lock === null || lock.pid !== instance.pid || lock.port !== instance.port || lock.tokenFingerprint !== fingerprint(token)) {
    throw new Error("The gateway is not owned by this installation; refusing to stop it.");
  }
  if (!instanceDependencies.alive(instance.pid)) {
    clearInstanceLock();
    return;
  }
  let accepted = false;
  try {
    const response = await instanceDependencies.fetch(`http://127.0.0.1:${instance.port}/admin/drain`, {
      method: "POST",
      headers: { "x-drain-token": token },
      signal: AbortSignal.timeout(2_000),
    });
    accepted = response.status === 202;
    if (!accepted) throw new Error(`Gateway drain was refused (HTTP ${response.status}); process left untouched.`);
  } catch (error) {
    if (error instanceof Error && error.message.includes("process left untouched")) throw error;
  }
  if (!accepted) instanceDependencies.kill(instance.pid);
  const deadline = Date.now() + 30_000;
  while (instanceDependencies.alive(instance.pid) && Date.now() < deadline) await instanceDependencies.sleep(200);
  if (instanceDependencies.alive(instance.pid)) {
    if (accepted) instanceDependencies.kill(instance.pid);
    throw new Error("Gateway did not stop within the drain timeout");
  }
  clearInstanceLock();
}

export const instanceTestInternals = {
  dependencies: instanceDependencies,
};
