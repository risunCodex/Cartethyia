import {
  awaitTrayChange,
  readTrayState,
  writeTrayRequest,
  writeTrayState,
  type TrayChangeOptions,
  type TrayRequest,
  type TrayState,
  type TrayVisibilityRequest,
} from "../../../src/console/tray/control";
import { readControllerOwner } from "../controller";
import type { Tray } from "./index";

/**
 * The two halves of "hide the icon": applying a request inside the tray, and
 * asking for one from another process.
 *
 * Both live here so the tray's poll loop and the CLI share one definition of
 * what a request means, and so the mapping from request to icon state can be
 * tested without a gateway, a helper, or a menu bar.
 */

export type TrayCommandOptions = TrayChangeOptions;

/**
 * Applies one request to a live tray and reports the resulting visibility.
 *
 * `toggle` is resolved here rather than in the caller so the tray and the CLI
 * cannot disagree about what "toggle" meant at the moment it was read.
 */
export async function applyTrayVisibility(tray: Tray, request: TrayVisibilityRequest): Promise<boolean> {
  if (request === "hide") await tray.hide();
  else if (request === "show") await tray.show();
  else if (tray.isVisible()) await tray.hide();
  else await tray.show();
  return !tray.isVisible();
}

/**
 * Applies a consumed request and records the answer.
 *
 * Both halves belong together: a change without its state record leaves the
 * command that asked waiting, and a state record without the request's nonce
 * leaves it unable to tell the answer from the state that was already there.
 * A change that throws writes nothing, so a failed hide is never reported as a
 * hidden icon.
 */
export async function respondToTrayRequest(tray: Tray, request: TrayRequest): Promise<boolean> {
  const hidden = await applyTrayVisibility(tray, request.request);
  writeTrayState({ pid: process.pid, hidden, nonce: request.nonce });
  return hidden;
}

/**
 * Asks the running tray to change its icon and waits for it to say it did.
 *
 * The state file is the acknowledgement: without it a command would print
 * success for a request the tray never read. The wait itself lives in the
 * control channel, so the console route that asks the same question cannot end
 * up with a different idea of what "confirmed" means.
 */
export async function requestTrayVisibility(
  request: TrayVisibilityRequest,
  options: TrayCommandOptions = {},
): Promise<TrayState> {
  if (readTrayState() === null) {
    throw new Error("No Cartethyia tray is running; start one with carte --tray");
  }
  const sent = writeTrayRequest(request);
  return awaitTrayChange(request, sent, options);
}

/**
 * Turns a second `carte --tray` into "show the icon" when a tray already runs.
 *
 * The operator who hid the icon and wants it back is far more likely to retype
 * the command they used to start it than to guess `carte tray show`. Reusing
 * the already-running detection keeps the old error for the case that really is
 * an error — a menu owning the install — and returns `false` so the caller's
 * normal start path can report it.
 */
export async function showIconOnExistingTray(options: TrayCommandOptions = {}): Promise<boolean> {
  const owner = readControllerOwner();
  if (owner === null || owner.kind !== "tray") return false;
  await requestTrayVisibility("show", options);
  return true;
}

/**
 * Runs one `carte tray` subcommand.
 *
 * Failures are reported as a one-line message and a non-zero exit code rather
 * than a stack trace: this is an operator command, and "no tray is running" is
 * an answer, not a crash.
 */
export async function runTrayCommand(command: TrayVisibilityRequest | "status"): Promise<void> {
  if (command === "status") {
    const state = readTrayState();
    if (state === null) {
      console.log("No Cartethyia tray is running.");
      return;
    }
    console.log(`Cartethyia tray is running (PID ${state.pid}); icon ${state.hidden ? "hidden" : "visible"}.`);
    return;
  }
  try {
    const state = await requestTrayVisibility(command);
    console.log(`Tray icon ${state.hidden ? "hidden" : "visible"}.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "the tray command failed");
    process.exitCode = 1;
  }
}
