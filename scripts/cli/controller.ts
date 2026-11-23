import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pidAlive } from "../../src/shared/process";

/** A menu or tray that exclusively owns this installation's interactive UI. */
export type ControllerKind = "menu" | "tray";

/** Proof passed to the tray during Hide to Tray. Never printed or persisted in logs. */
export interface ControllerHandoff {
  readonly token: string;
  readonly parentPid: number;
}

export interface ControllerLease {
  readonly handoff: ControllerHandoff;
  readonly release: () => void;
}

interface ControllerRecord extends ControllerHandoff {
  readonly pid: number;
  readonly kind: ControllerKind;
  readonly startedAt: string;
}

const CONTROLLER_FILE = "controller.json";

function controllerPath(): string {
  const configDir = process.env.CARTETHYIA_CONFIG_DIR;
  if (!configDir) throw new Error("Cartethyia config directory is unavailable");
  mkdirSync(configDir, { recursive: true });
  return join(configDir, CONTROLLER_FILE);
}

function readController(path: string): ControllerRecord | null {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<ControllerRecord>;
    if (typeof value.pid !== "number" || typeof value.parentPid !== "number" ||
      typeof value.token !== "string" || value.token.length === 0 ||
      (value.kind !== "menu" && value.kind !== "tray") || typeof value.startedAt !== "string") return null;
    return value as ControllerRecord;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    // A partially rewritten or corrupt file must not be treated as permission
    // to start a second gateway. It is only safe to reclaim a record whose old
    // owner can be identified and is definitely dead.
    throw new Error("The Cartethyia controller lock is unreadable; close carte/tray before retrying");
  }
}

function writeController(path: string, record: ControllerRecord, exclusive: boolean): void {
  writeFileSync(path, JSON.stringify(record), {
    encoding: "utf8",
    mode: 0o600,
    ...(exclusive ? { flag: "wx" } : {}),
  });
}

/**
 * Acquire the one interactive controller for an installation.
 *
 * Hide to Tray passes the existing token to its child. The child replaces the
 * pid in the same file without unlinking it, so a second menu cannot sneak into
 * the handoff gap and drain the gateway while the first tray is taking over.
 */
export function acquireController(kind: ControllerKind, handoff?: ControllerHandoff): ControllerLease {
  const path = controllerPath();
  if (handoff !== undefined) {
    const current = readController(path);
    if (current === null || current.token !== handoff.token || current.parentPid !== handoff.parentPid ||
      current.kind !== "menu") {
      throw new Error("The menu-to-tray handoff is no longer owned by its original menu");
    }
    writeController(path, { ...current, pid: process.pid, kind: "tray" }, false);
  } else {
    const current = readController(path);
    if (current !== null && pidAlive(current.pid)) {
      throw new Error(`Cartethyia is already controlled by a ${current.kind} (PID ${current.pid}); not starting another instance`);
    }
    const token = crypto.randomUUID();
    // Writing the replacement atomically avoids a corruption window in which
    // another carte cannot tell whether the old owner was alive. A concurrent
    // claimant reads either the complete old record or this complete new one.
    const next: ControllerRecord = {
      pid: process.pid,
      parentPid: process.pid,
      token,
      kind,
      startedAt: new Date().toISOString(),
    };
    try {
      if (current !== null) {
        const temporary = `${path}.${process.pid}.tmp`;
        writeFileSync(temporary, JSON.stringify(next), { encoding: "utf8", mode: 0o600 });
        try { renameSync(temporary, path); } catch (error) {
          try { unlinkSync(temporary); } catch { /* Preserve the rename error. */ }
          throw error;
        }
      } else writeController(path, next, true);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error("Another Cartethyia menu or tray acquired the controller; not starting another instance");
      }
      throw error;
    }
  }

  const token = handoff?.token ?? readController(path)?.token;
  if (!token) throw new Error("Could not establish the Cartethyia controller lock");
  const pid = process.pid;
  let released = false;
  return {
    handoff: { token, parentPid: pid },
    release: () => {
      if (released) return;
      released = true;
      const current = readController(path);
      // During a successful handoff the file already belongs to the tray. The
      // parent must not delete its child's lease while returning to the shell.
      if (current?.token === token && current.pid === pid) {
        try { unlinkSync(path); } catch { /* A dead owner is reclaimed next start. */ }
      }
    },
  };
}

/**
 * The interactive UI that currently owns this installation, if any.
 *
 * Read-only and liveness-checked: `carte --tray` uses it to tell "a tray is
 * already running, so show its icon" from "a menu owns this install", which is
 * an error the operator has to resolve by hand.
 */
export function readControllerOwner(): { readonly kind: ControllerKind; readonly pid: number } | null {
  const current = readController(controllerPath());
  if (current === null || !pidAlive(current.pid)) return null;
  return { kind: current.kind, pid: current.pid };
}

/** Hand a failed tray startup back to the still-running menu. */
export function restoreControllerAfterFailedHandoff(handoff: ControllerHandoff): void {
  const path = controllerPath();
  const current = readController(path);
  if (current?.token === handoff.token && current.parentPid === handoff.parentPid && current.kind === "tray") {
    writeController(path, { ...current, pid: handoff.parentPid, kind: "menu" }, false);
  }
}

/** Read the one-shot handoff proof without exposing it to normal process logs. */
export function inheritedControllerHandoff(env: NodeJS.ProcessEnv = process.env): ControllerHandoff | undefined {
  const token = env.CARTETHYIA_CONTROLLER_TOKEN;
  const parentPid = Number(env.CARTETHYIA_CONTROLLER_PARENT_PID);
  if (!token || !Number.isInteger(parentPid) || parentPid <= 0) {
    delete env.CARTETHYIA_CONTROLLER_TOKEN;
    delete env.CARTETHYIA_CONTROLLER_PARENT_PID;
    return undefined;
  }
  return { token, parentPid };
}
