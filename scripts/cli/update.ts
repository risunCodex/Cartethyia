/**
 * The update path — CLI-side wrapper over the shared detached-install flow in
 * `src/console/updates/apply-update.ts`.
 *
 * npm cannot replace this package's directory while a process is executing out
 * of it (EBUSY on Windows). So we spawn the installer as a detached process,
 * print a short notice, and exit — the installer runs after this process is gone.
 * After install, it attempts to restart the gateway (systemd if available, else
 * `cartethyia start`), so the new version comes up automatically.
 * Cross-OS: uses npm.cmd on Windows.
 */
import {
  spawnDetachedUpdate,
  UPDATE_INSTALL_COMMAND,
  type UpdateStatus,
} from "../../src/console/updates/apply-update";

export function updateCommand(): string {
  return UPDATE_INSTALL_COMMAND;
}

export function runDetachedUpdate(): void {
  // The shared module owns stopHoldingProcesses, the wrapper, the status file,
  // and the update.log redirection; the CLI only prints.
  spawnDetachedUpdate({});
}

export function printUpdateInstructions(from: string, to: string | null): void {
  console.log("");
  console.log(`Update available: ${from} \u2192 ${to ?? "latest"}`);
  console.log("");
  // Names the one thing that actually breaks this install: npm cannot rename
  // the package directory while any process still holds it, and on Windows the
  // hold survives the process that took it — so a detached install that starts
  // before this one has let go fails with EBUSY and the version never changes.
  // The operator cannot fix that from inside the running CLI; they have to stop
  // running out of the directory being replaced.
  console.log("Detached update started; it installs in the background.");
  console.log("");
  console.log("Close this terminal, then run `carte` again.");
  console.log("The install needs this window closed: npm cannot replace the");
  console.log("package directory while a process is still running from it.");
  console.log("");
  console.log("If `carte` still shows the old version afterwards, run:");
  console.log(`  ${updateCommand()}`);
  console.log("");
}

/** Status shape the shared module writes; re-exported for CLI readers. */
export type { UpdateStatus };
