import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { isNewerRelease } from "../../src/console/updates/version-compare";
import { resolvePackagePath } from "../../src/config/package-paths";
import { resolvePort } from "../../src/config/runtime";
import { ensureDrainToken } from "./instance";
import { attachGateway, stopAttachedGateway, type RunningGateway } from "./instance";
import { startGateway } from "./gateway";
import { stopGateway } from "./gateway";
import { ENV_PATH, readEnvFile } from "./env";
import { readInstalledVersion, readLatestPublishedVersion } from "./version";
import { launchBackgroundWithStatus, openUrl } from "./background";
import { chooseFromMenu, confirmByTyping, confirmStep, type MenuRow } from "./prompt";
import { renderWordmark } from "./wordmark";
import { exportBackup, resetConsoleAccount } from "./admin";
import { printUpdateInstructions, runDetachedUpdate } from "./update";
import { acquireController } from "./controller";
import { restoreControllerAfterFailedHandoff } from "./controller";

/**
 * Seconds to keep the update notice on screen before returning to the shell.
 *
 * The notice tells the operator to close the window, so it has to stay long
 * enough to be read. Exiting immediately meant an install that silently did
 * nothing looked like it had succeeded.
 */
const UPDATE_NOTICE_SECONDS = 30;

/**
 * Seconds to hold the terminal open after a gateway startup failure. The
 * gateway's last log lines are the whole diagnosis; exiting the moment they
 * print meant a `carte` window closed before the operator could read why.
 * Same trade-off as the double-instance pause in `main.ts`.
 */
const STARTUP_FAILURE_EXIT_SECONDS = 30;

const FAILURE_PAINT =
  process.stdout.isTTY === true && process.env.NO_COLOR === undefined && process.env.TERM !== "dumb";

/** True only in a human's terminal; piped/scripted runs must exit at once. */
const INTERACTIVE_TERMINAL = process.stdout.isTTY === true;

/**
 * Amber guidance for a startup failure: the block has a documented fix path
 * (config, port, reinstall), so it should read as "needs attention", not as
 * a fatal crash. Detail lines stay uncolored so the log tail reads plainly.
 */
function failurePaint(code: string, value: string): string {
  return FAILURE_PAINT ? `\u001b[${code}m${value}\u001b[0m` : value;
}


/**
 * The default `carte` experience: start the gateway, then offer an arrow-key
 * menu. This needs no desktop environment, so it works over SSH, on a headless
 * box, and on Windows where the tray icon lands in the hidden-icons overflow
 * and is never seen. `carte --tray` opts into the icon instead.
 */
export async function startMenu(): Promise<void> {
  const controller = acquireController("menu");
  const releaseController = (): void => controller.release();
  process.once("exit", releaseController);
  try {
    await runMenu(controller.handoff);
  } finally {
    controller.release();
    process.removeListener("exit", releaseController);
  }
}

async function runMenu(handoff: { readonly token: string; readonly parentPid: number }): Promise<void> {
  // A fresh install has no config file yet, and the gateway refuses to boot
  // without CARTETHYIA_DB_MODE — which surfaced as a stack trace about a
  // missing database mode rather than "you have not set this up". Run setup
  // first, the way `carte` is expected to behave on a new install.
  const configured = existsSync(ENV_PATH) && (await readEnvFile(ENV_PATH)).CARTETHYIA_DB_MODE;
  if (!configured) {
    console.log(
      existsSync(ENV_PATH)
        ? "Cartethyia is missing its database mode. Starting setup.\n"
        : "Cartethyia is not set up yet. Starting setup.\n",
    );
    // dynamic-import: `setup` pulls in the whole wizard and the database mode
    // resolver, and it is only reachable on a first run. A static import
    // would pay that cost on every `carte`, which is the one path that has
    // to stay fast.
    const { setup } = await import("./setup");
    await setup();
    const after = existsSync(ENV_PATH) ? (await readEnvFile(ENV_PATH)).CARTETHYIA_DB_MODE : undefined;
    if (!after) {
      console.error(
        `Setup did not record CARTETHYIA_DB_MODE in ${ENV_PATH}; run \`cartethyia setup\` and try again.`,
      );
      process.exitCode = 1;
      return;
    }
    process.env.CARTETHYIA_DB_MODE = after;
  }

  const port = resolvePort();
  const drainToken = ensureDrainToken();
  const dashboardUrl = `http://127.0.0.1:${port}/console`;
  const currentVersion = await readInstalledVersion();

  // Reattach without draining a healthy instance. A new child must either be
  // ready or produce its actionable failure before the menu is shown; otherwise
  // the UI offers gateway actions for a process that already exited.
  const attached = await attachGateway(port, drainToken);
  let startupError: unknown = null;
  const ready: Promise<Bun.Subprocess | null> = attached
    ? Promise.resolve(null)
    : startGateway(port, drainToken).catch((error: unknown) => {
      startupError = error;
      return null;
    });
  let gateway: Bun.Subprocess | null = null;
  const runningAttached: RunningGateway | null = attached;
  void ready.then((child) => {
    if (child === null) return;
    gateway = child;
    child.unref();
  }).catch((error: unknown) => {
    console.error(`The gateway did not start: ${error instanceof Error ? error.message : "unknown error"}`);
  });

  if (!attached) {
    await ready;
    if (startupError !== null) {
      const detail = startupError instanceof Error ? startupError.message : "unknown startup error";
      // The actionable text goes to stderr — scripts and tests read the
      // failure from the error stream; an interactive window shows both.
      console.error(detail);
      console.error(failurePaint("1;33", `The gateway did not start on port ${port}.`));
      console.error(
        failurePaint(
          "33",
          "Fix the reported issue, then run `carte` again. Use `cartethyia doctor` to check configuration.",
        ),
      );
      console.error(
        failurePaint(
          "33",
          "If this install is broken or too old, reinstall it:\n" +
            "  npm uninstall -g cartethyia\n" +
            "  npm install -g cartethyia",
        ),
      );
      process.exitCode = 1;
      // Hold only a human's window so the diagnosis stays readable; a piped
      // or scripted run exits the moment the guidance is printed.
      if (INTERACTIVE_TERMINAL) {
        console.error(`\nThis window closes in ${STARTUP_FAILURE_EXIT_SECONDS} seconds.`);
        await Bun.sleep(STARTUP_FAILURE_EXIT_SECONDS * 1_000);
      }
      return;
    }
  }

  let stopping = false;
  let handedOff = false;
  const shutDown = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    const child = gateway ?? (await ready.catch(() => null));
    if (child) await stopGateway(child, port, drainToken);
    else if (runningAttached) await stopAttachedGateway(runningAttached, drainToken);
  };
  const detachAttached = (): void => {
    if (runningAttached !== null) stopping = true;
  };
  // Ctrl-C has to stop the gateway, and the drain endpoint cannot be called
  // from an exit path: it is async, and enquirer's own Ctrl-C handler calls
  // process.exit(130) while a prompt is live. So the gateway is a child in this
  // process group — a terminal's Ctrl-C signals the whole group, and the
  // gateway drains through the SIGINT handler it already has in src/main.ts —
  // and `process.on("exit")` is the synchronous backstop for every other way
  // this process can end (a closed terminal, a crash, a signal Bun cannot
  // deliver on Windows). That handler can only call synchronous APIs, which is
  // why it signals the child rather than awaiting the drain endpoint.
  // `handedOff` is set by "Hide to tray": the gateway is being given to a tray
  // that will own it, so this process must not kill it on the way out.
  process.on("exit", () => {
    if (stopping || handedOff || gateway === null || runningAttached !== null) return;
    try {
      gateway.kill();
    } catch {
      // Already gone; nothing to stop.
    }
  });
  const interrupt = async (): Promise<void> => {
    if (runningAttached !== null) {
      detachAttached();
      process.exit(0);
    }
    process.stdout.write("\u001b[2J\u001b[H");
    console.log("Stopping Cartethyia…");
    await shutDown();
    process.exit(0);
  };
  process.on("SIGTERM", () => void interrupt());
  process.on("SIGINT", () => void interrupt());

  let latestVersion = await readLatestPublishedVersion();
  let running = true;
  let backupStatus: { readonly tone: "success" | "error"; readonly text: string } | undefined;

  while (running) {
    const upToDate = latestVersion === null || !isNewerRelease(currentVersion, latestVersion);
    // Header-line version checker. When something newer is published the line
    // calls it out and the menu adds an `Update to X.Y.Z` row that the arrow
    // keys land on by default — the operator still has to press Enter, so a
    // reflex Enter cannot run an update by accident, but attention is on the
    // action that matters.
    const versionCheckerLine =
      latestVersion === null
        ? `${currentVersion} \u00b7 registry unavailable`
        : upToDate
          ? `${currentVersion} \u00b7 up to date`
          : `${currentVersion} \u2192 ${latestVersion} available`;
    const header = [
      ...renderWordmark(),
      `Console  ${dashboardUrl}`,
      `Version  ${versionCheckerLine}`,
      "",
    ];

    // Anything that talks to the gateway waits for it to be listening; the menu
    // itself does not.
    const whenReady = async (): Promise<void> => {
      await ready.catch(() => undefined);
    };

    const actions: readonly (() => Promise<void>)[] = [
      async () => openUrl(dashboardUrl),
      async () => {
        // Transfer the live gateway rather than draining it first. The tray
        // adopts this instance through the ownership marker and reports ready
        // before the menu returns to the shell.
        running = false;
        stopping = true;
        handedOff = true;
        console.log("Starting the tray in the background…");
        const signalPath = join(tmpdir(), `cartethyia-tray-menu-${process.pid}-${randomUUID()}.json`);
        try {
          const url = await launchBackgroundWithStatus(
            ["run", resolvePackagePath("scripts", "cli", "main.ts"), "tray"],
            { signalPath, controllerHandoff: handoff },
          );
          console.log(`Cartethyia is running in the background at ${url || dashboardUrl}.`);
          console.log("The tray icon owns it; use Exit there to stop it.");
          // Hide to Tray is the one action that ends with the menu gone and no
          // console in front of the operator, so it opens the dashboard itself.
          // Every other action either stays in the menu or is an explicit "Open
          // Console" press. Only after the handoff reports ready — opening on
          // failure would point the browser at a gateway that is not running.
          await openUrl(url || dashboardUrl);
        } catch (error) {
          restoreControllerAfterFailedHandoff(handoff);
          handedOff = false;
          console.error(
            `Could not hand off to the tray: ${error instanceof Error ? error.message : "unknown error"}`,
          );
          console.error("Cartethyia is stopped. Start it again from this menu.");
        }
      },
      async () => {
        // Export straight to the download directory. The console page asks for
        // the operator password, which is exactly the thing a locked-out
        // operator does not have; the CLI already runs as the OS user who owns
        // the database, so the loopback token is the whole gate.
        await whenReady();
        const result = await exportBackup(port, drainToken);
        backupStatus = "error" in result
          ? { tone: "error", text: `Backup failed: ${result.error}` }
          : {
              tone: "success",
              text: `Backup saved at: ${result.path} (${(result.bytes / 1024).toFixed(1)} KiB)`,
            };
      },
      async () => {
        // Deleting the console account is the only real password recovery:
        // /change-password needs the current password, and first-boot setup
        // only runs when no user exists. Removing the user puts the wizard
        // back. Providers, keys, and routing are untouched.
        console.log("");
        console.log("This deletes every console account and its sessions.");
        console.log("The next visit to /console asks you to create a new one.");
        console.log("Providers, API keys, and routing are not touched.");
        console.log("");
        if (!(await confirmStep("Continue with the reset?"))) {
          console.log("Cancelled.");
          return;
        }
        if (!(await confirmByTyping("RESET", "Confirm deleting the console account"))) {
          console.log("Cancelled.");
          return;
        }
        await whenReady();
        const status = await resetConsoleAccount(port, drainToken);
        console.log(
          status === 0
            ? `Console account removed. Open ${dashboardUrl} to create a new one.`
            : "Reset failed; see the gateway log.",
        );
      },
      async () => {
        running = false;
      },
    ];
    // The Update action is only wired in when there is something newer to go
    // to; otherwise the menu's up-to-date state is already told by the header
    // line and an extra row would be noise.
    const updateAction = async (): Promise<void> => {
      if (upToDate || latestVersion === null) return;
      // npm cannot replace this package's directory while this process is
      // running out of it: on Windows the rename fails with EBUSY and npm
      // exits 14. Even with the gateway stopped, the CLI itself is executing
      // from that directory, so an in-process install can never succeed.
      await shutDown();
      runDetachedUpdate();
      printUpdateInstructions(currentVersion, latestVersion);
      // Held open, not exited instantly: the message tells the operator to
      // close this window, and an EXIT-key press after it returns them to the
      // shell. Exiting immediately closed the terminal before the notice
      // could be read, which is why an update that silently did nothing looked
      // like it had succeeded.
      console.log(`This window closes in ${UPDATE_NOTICE_SECONDS} seconds, or close it now.`);
      await Bun.sleep(UPDATE_NOTICE_SECONDS * 1_000);
      running = false;
    };
    const extendedActions: readonly (() => Promise<void>)[] = upToDate
      ? actions
      : [...actions.slice(0, actions.length - 1), updateAction, actions[actions.length - 1] ?? (async () => undefined)];

    const rows: MenuRow[] = [
      { kind: "action", label: "Open Console", hint: "Open dashboard in browser" },
      { kind: "action", label: "Hide to Tray", hint: "Keep the gateway running" },
      { kind: "action", label: "Backup", hint: "Export config to Downloads" },
      { kind: "action", label: "Reset", hint: "Delete console account" },
    ];
    if (!upToDate && latestVersion !== null) {
      rows.push({ kind: "action", label: `Update to ${latestVersion}`, hint: "installs now and exits" });
    }
    rows.push({ kind: "rule" });
    rows.push({ kind: "action", label: "Exit", hint: "Stop the gateway" });

    // Focus the Update row by default when it exists, so the operator who
    // launched `carte` *because* they saw the version checker gets a one-key
    // path to the fix.
    const updateIndex = upToDate || latestVersion === null ? -1 : 4;
    const initialActionIndex = updateIndex >= 0 ? updateIndex : 0;
    const choice = await chooseFromMenu(header, rows, { initialIndex: initialActionIndex, ...(backupStatus ? { status: backupStatus } : {}) });
    if (choice === -1) break;
    const action = extendedActions[choice];
    if (action) await action();
  }
  // "Hide to tray" has already given the gateway to the tray. Draining here
  // would stop the very process the tray just adopted, which is why the menu
  // appeared to hand over a gateway that was not listening.
  if (handedOff) return;
  // An attached (externally owned) gateway is left running for its owner; our
  // own child is drained before the menu returns to the shell. `attachGateway`
  // is deliberately NOT probed again here: it would always see our own child's
  // lock and turn a clean drain into a rough kill on the exit backstop.
  if (runningAttached !== null) {
    detachAttached();
    return;
  }
  await shutDown();
}
