/**
 * The detached update flow — the one implementation the console route and the
 * CLI (`carte update`, console menu) share.
 *
 * npm cannot replace this package's directory while a process is executing out
 * of it (EBUSY on Windows), and the deployment model has no process supervisor
 * that could restart after an in-process install. So the installer MUST be a
 * detached process that outlives the gateway that asked for it: the caller
 * writes an intent file, spawns the installer, and then exits (gracefully, via
 * the ShutdownCoordinator, on the console route).
 *
 * The status file is the contract between the two processes: the gateway writes
 * `{status:"installing"}` before spawning, and the detached installer
 * (spawnDetachedInstaller's wrapper) overwrites it with
 * `{status:"success"|"failed", exitCode, stderrTail}` when npm finishes.
 * `GET /updates/status` reads it back, so the dashboard knows whether the
 * install landed or died — instead of polling a release tag forever with no
 * answer when npm failed.
 */
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveUserConfigDir } from "../../config/package-paths";

/** Shape written before the installer spawns and overwritten by its wrapper. */
export interface UpdateStatus {
  readonly status: "installing" | "success" | "failed";
  readonly targetTag?: string;
  readonly startedAt: string;
  readonly exitCode?: number;
  /** Last bytes of the installer's stderr, so a failed install is diagnosable. */
  readonly stderrTail?: string;
}

/** Age under which a fresh `installing` status means "already running". */
export const INSTALLING_FRESH_MS = 10 * 60_000;

const UPDATE_STATUS_FILE = "update-status.json";
const UPDATE_LOG_FILE = "update.log";

/** How much of the installer's stderr is preserved in a failed status. */
const STDERR_TAIL_BYTES = 4_096;

export function updateStatusPath(configDir: string = resolveUserConfigDir()): string {
  return join(configDir, UPDATE_STATUS_FILE);
}

export function updateLogPath(configDir: string = resolveUserConfigDir()): string {
  return join(configDir, UPDATE_LOG_FILE);
}

/** Reads and parses the status file; any absence or corruption answers null. */
export function readUpdateStatus(configDir: string = resolveUserConfigDir()): UpdateStatus | null {
  try {
    const raw = readFileSync(updateStatusPath(configDir), "utf8");
    const parsed = JSON.parse(raw) as Partial<UpdateStatus> | null;
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      (parsed.status !== "installing" && parsed.status !== "success" && parsed.status !== "failed") ||
      typeof parsed.startedAt !== "string"
    ) {
      return null;
    }
    return parsed as UpdateStatus;
  } catch {
    return null;
  }
}

/** Writes a status atomically enough for this purpose: one rename via write. */
export function writeUpdateStatus(status: UpdateStatus, configDir: string = resolveUserConfigDir()): void {
  mkdirSync(configDir, { recursive: true });
  writeFileSync(updateStatusPath(configDir), JSON.stringify(status));
}

/** True when a still-`installing` status was written recently enough to trust. */
export function isFreshlyInstalling(status: UpdateStatus | null, now: number = Date.now()): boolean {
  if (status === null || status.status !== "installing") return false;
  const startedAt = Date.parse(status.startedAt);
  if (!Number.isFinite(startedAt)) return false;
  return now - startedAt < INSTALLING_FRESH_MS;
}

/**
 * Processes still running out of the package directory, so npm can rename it.
 *
 * The rename is the whole install on Windows, and it fails with EBUSY while
 * anything holds the directory — including a hold that outlives the process
 * that took it. `carte` itself runs from that directory, so the install has to
 * wait until this process is gone; these are the others.
 */
export function stopHoldingProcesses(): void {
  if (process.platform !== "win32") return;
  // `taskkill` filters on the window title and image name only, so it is asked
  // for the two processes this CLI can leave behind. /T takes the tree, so a
  // detached gateway started by a tray goes with it.
  for (const image of ["cartethyia.exe", "carte.exe"]) {
    try {
      spawn("taskkill", ["/F", "/T", "/IM", image], { stdio: "ignore" }).unref();
    } catch {
      // A missing taskkill is not the install's problem; npm will report the
      // hold if one is left.
    }
  }
}

export const UPDATE_INSTALL_COMMAND = "npm install -g cartethyia@latest --prefer-online";

/**
 * Spawns the detached installer and returns immediately.
 *
 * `stdio` is redirected to `update.log` (append) rather than ignored, so a
 * failed npm run leaves its output behind for the operator. The spawned
 * wrapper re-execs this module's finish step as a `bun -e` script that runs
 * `npm` to completion and then overwrites the status file — see
 * {@link finishDetachedUpdate}, the function the wrapper string mirrors. If the
 * wrapper itself cannot be spawned, the status is flipped to `failed` here so
 * the dashboard's poll loop is not left spinning on a silent `installing`.
 */
export function spawnDetachedUpdate(options: {
  readonly targetTag?: string;
  readonly configDir?: string;
}): { started: boolean; error?: string } {
  const configDir = options.configDir ?? resolveUserConfigDir();
  const isWin = process.platform === "win32";
  const restart = isWin
    ? "cartethyia start"
    : "systemctl restart cartethyia 2>/dev/null || cartethyia start";
  const script = `${UPDATE_INSTALL_COMMAND} && ${restart}`;
  const wrapper = buildInstallerWrapperScript(script);
  try {
    stopHoldingProcesses();
    let logFd: number | undefined;
    try {
      mkdirSync(configDir, { recursive: true });
      logFd = openSync(updateLogPath(configDir), "a");
    } catch {
      // A log file that cannot be opened must not block the install; the
      // installer then runs with stdio ignored as before.
    }
    const child = spawn(
      process.execPath,
      ["-e", wrapper],
      { detached: true, stdio: logFd === undefined ? "ignore" : ["ignore", logFd, logFd] },
    );
    child.unref();
    if (logFd !== undefined) {
      try {
        // The parent's copy of the fd is not needed once the child inherits it.
        closeSync(logFd);
      } catch {
        // An unclosed fd in a process that is about to drain and exit is
        // harmless.
      }
    }
    return { started: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      writeUpdateStatus(
        { status: "failed", ...(options.targetTag === undefined ? {} : { targetTag: options.targetTag }), startedAt: new Date().toISOString(), stderrTail: message },
        configDir,
      );
    } catch {
      // Nothing more can be reported if even the status write fails.
    }
    return { started: false, error: message };
  }
}

/**
 * The script string handed to `bun -e` (or `node -e`, whatever `process.execPath`
 * is). It mirrors {@link finishDetachedUpdate} because a detached process cannot
 * import this module: it must be one self-contained expression that survives the
 * parent exiting. Kept in this file, next to the function, so the two are
 * reviewed together.
 */
function buildInstallerWrapperScript(script: string): string {
  const installer = JSON.stringify(script);
  const shell = JSON.stringify(process.platform === "win32" ? "cmd.exe" : "/bin/sh");
  const argsPrefix = process.platform === "win32" ? '"/c",' : '"-c",';
  const statusPath = JSON.stringify(updateStatusPath());
  return `
const { spawn } = require("node:child_process");
const { readFileSync, writeFileSync, openSync } = require("node:fs");
const startedAt = new Date().toISOString();
let logFd;
try { logFd = openSync(${JSON.stringify(updateLogPath())}, "a"); } catch {}
const child = spawn(${shell}, [${argsPrefix} ${installer}], { stdio: logFd === undefined ? "ignore" : ["ignore", logFd, logFd] });
let stderrTail = "";
child.on("exit", (exitCode) => {
  writeFileSync(${statusPath}, JSON.stringify({
    status: exitCode === 0 ? "success" : "failed",
    startedAt,
    exitCode: exitCode ?? -1,
    ...(stderrTail ? { stderrTail } : {}),
  }));
  process.exit(exitCode ?? -1);
});
child.on("error", (error) => {
  try {
    writeFileSync(${statusPath}, JSON.stringify({ status: "failed", startedAt, exitCode: -1, stderrTail: String(error) }));
  } catch {}
  process.exit(-1);
});
`.trim();
}

/**
 * Runs the install to completion and records the terminal status. Exported for
 * the test suite, which exercises the same code shape the wrapper string
 * executes; production reaches it only through the detached wrapper.
 */
export async function finishDetachedUpdate(
  runInstall: (onStderr: (chunk: string) => void) => Promise<number>,
  configDir: string = resolveUserConfigDir(),
): Promise<UpdateStatus> {
  const startedAt = new Date().toISOString();
  let stderrTail = "";
  let exitCode: number;
  try {
    exitCode = await runInstall((chunk) => {
      stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_BYTES);
    });
  } catch (error) {
    const status: UpdateStatus = {
      status: "failed",
      startedAt,
      exitCode: -1,
      stderrTail: (error instanceof Error ? error.message : String(error)).slice(-STDERR_TAIL_BYTES),
    };
    writeUpdateStatus(status, configDir);
    return status;
  }
  const status: UpdateStatus = {
    status: exitCode === 0 ? "success" : "failed",
    startedAt,
    exitCode,
    ...(stderrTail ? { stderrTail } : {}),
  };
  writeUpdateStatus(status, configDir);
  return status;
}
