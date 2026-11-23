import { writeFileSync } from "node:fs";

/**
 * Reports tray readiness to the launcher that is waiting on a signal file.
 *
 * The tray is spawned detached with no stdio, so the launcher cannot read its
 * output; a one-shot file is the only channel that survives the parent exiting.
 * `flag: "wx"` makes the write fail rather than overwrite, which keeps a late
 * report from replacing the failure the launcher already acted on.
 */
export type TrayStartupSignal =
  | { readonly status: "ready"; readonly url: string }
  /**
   * A tray was already running and its icon was shown. There is no URL to
   * report: the gateway was started by the tray that is already up, and this
   * process only asked it for its icon.
   */
  | { readonly status: "already-running" }
  | { readonly status: "failed"; readonly message: string };

export function reportTrayStartup(signal: TrayStartupSignal): void {
  const signalPath = process.env.CARTETHYIA_TRAY_STARTUP_SIGNAL;
  if (!signalPath) return;
  try {
    writeFileSync(signalPath, JSON.stringify(signal), { encoding: "utf8", flag: "wx" });
  } catch {
    // The launcher may have timed out and removed the one-shot signal file.
  }
}
