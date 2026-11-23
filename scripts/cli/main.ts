// dynamic-import-ok: subcommand dispatcher. Every branch lazy-loads only the
// module its command needs so `cartethyia --help` and `cartethyia stop` do
// not drag the gateway, dashboard, and database driver into memory.
import { mkdirSync } from "node:fs";
import { PACKAGE_ROOT, resolveUserConfigDir } from "../../src/config/package-paths";
import { readRequiredBunVersion, assertBunVersion } from "./version";
import { printUpdateInstructions, runDetachedUpdate } from "./update";

process.env.CARTETHYIA_CONFIG_DIR ??= resolveUserConfigDir();
// Covers every entry into the CLI that is not the npm launcher — the menu's
// "Hide to Tray" spawns this file directly, and the compiled gateway binary
// it then starts resolves its assets from the package root. A compiled Bun
// executable has a virtual `import.meta.dir` (`B:/~BUN/root/cartethyia`), so
// an unset root becomes `B:\` and startup dies with
// `ENOENT: scandir 'B:\migrations\lite-sqlite3'`.
process.env.CARTETHYIA_PACKAGE_ROOT ??= PACKAGE_ROOT;

/**
 * Seconds to hold the window open after reporting that another instance owns
 * this installation. Long enough to read, short enough not to feel like a hang.
 */
const DOUBLE_INSTANCE_EXIT_SECONDS = 30;

const HELP = (minimumBunVersion: string) => `Cartethyia ${minimumBunVersion}+ (Bun is required)

Usage:
  carte                  start, then show an arrow-key menu (no GUI needed)
  carte --tray           start with a system-tray icon instead
  carte tray hide        remove the tray icon, keep the gateway running
  carte tray show        put the tray icon back
  carte tray toggle      flip the icon's visibility
  carte tray status      report whether the tray is running and what it shows
  cartethyia setup [--non-interactive]
  cartethyia start
  cartethyia stop
  cartethyia menu
  cartethyia doctor
  cartethyia admin reset-lockout <username> <clientIp>
  cartethyia admin reset-lockout --all
  cartethyia telemetry reconcile --apply|--verify
  cartethyia update

carte starts the gateway in the background and leaves only the console menu on
your terminal — Open Console, Reset password, Backup, Update, Hide to tray,
Exit. Arrow keys and Enter; no desktop environment needed, so it works over SSH
and headless. A menu started by this command drains its child gateway on Exit;
leaving a menu attached to an existing gateway only detaches. Use stop for that.
carte --tray uses a system-tray icon instead, which needs a graphical session.
Hiding the icon is not stopping Cartethyia: the gateway keeps serving, and
carte tray show (or another carte --tray) brings the icon back.
Stop a detached gateway with cartethyia stop (or the install's ./carte stop).
Setup explains Lite (embedded SQLite) and Full (external PostgreSQL), then saves
configuration under the current user's Cartethyia config directory.
`;

/** Loads the user's `.env` into the environment without overriding it. */
async function loadUserConfig(): Promise<void> {
  const configDir = process.env.CARTETHYIA_CONFIG_DIR;
  if (!configDir) throw new Error("Cartethyia config directory could not be resolved");
  mkdirSync(configDir, { recursive: true });
  // Imported here rather than at module scope: `support/env` pulls in the
  // package-root resolver and `node:fs/promises`, and `carte --help` (which
  // never reads a .env) should not pay for either before it prints.
  const { ENV_PATH, readEnvFile } = await import("./env");
  // Bun injects PORT=12800 when no explicit port was supplied. It is a
  // runner default, not an operator override; without removing it, a saved
  // custom port is ignored by npm/carte and the gateway starts on 12800.
  // Preserve any non-default/custom shell value exactly as before.
  if (process.env.PORT === "12800") delete process.env.PORT;
  const values = await readEnvFile(ENV_PATH);
  for (const [key, value] of Object.entries(values)) {
    if (!process.env[key]) process.env[key] = value;
  }
}

/**
 * Reports tray readiness to the launcher waiting on a signal file.
 *
 * Deferred to a dynamic import for the same reason as `loadUserConfig`: only
 * the tray path writes this file, so the other commands should not load
 * `node:fs` machinery they never touch.
 */
async function reportTrayFailed(message: string): Promise<void> {
  const { reportTrayStartup } = await import("./startup-signal");
  reportTrayStartup({ status: "failed", message });
}

async function main(): Promise<void> {
  await assertBunVersion();
  const [command] = process.argv.slice(2);
  if (command === "setup" || command === "start" || command === "stop" || command === "tray" || command === "menu" || command === "doctor" || command === "admin" || command === "telemetry") {
    await loadUserConfig();
  }

  switch (command) {
    case "setup": {
      const { setup } = await import("./setup");
      await setup();
      return;
    }
    case "start": {
      const { startForeground } = await import("./start");
      await startForeground();
      return;
    }
    case "stop": {
      const { resolvePort } = await import("../../src/config/runtime");
      const { ensureDrainToken, attachGateway, stopAttachedGateway } = await import("./instance");
      const port = resolvePort();
      const token = ensureDrainToken();
      const gateway = await attachGateway(port, token);
      if (!gateway) {
        console.log("No running Cartethyia gateway is owned by this installation.");
        return;
      }
      await stopAttachedGateway(gateway, token);
      console.log("Cartethyia stopped.");
      return;
    }
    case "menu": {
      const { startMenu } = await import("./console-menu");
      await startMenu();
      return;
    }
    case "tray": {
      // A subcommand asks the running tray for something; a bare `tray` starts
      // one. Checked before the import so `carte tray hide` never drags the
      // gateway, the dashboard and the database driver into memory.
      const subcommand = process.argv[3]?.trim();
      if (subcommand === "hide" || subcommand === "show" || subcommand === "toggle" || subcommand === "status") {
        const { runTrayCommand } = await import("./tray/commands");
        await runTrayCommand(subcommand);
        return;
      }
      // A tray that already runs owns this install, and the usual way back to
      // a hidden icon is to retype the command that started it. So a second
      // `carte --tray` shows the icon instead of failing; a menu owner still
      // falls through to the error, because two interactive UIs cannot share
      // one gateway.
      const { inheritedControllerHandoff } = await import("./controller");
      if (inheritedControllerHandoff() === undefined) {
        const { showIconOnExistingTray } = await import("./tray/commands");
        const { reportTrayStartup } = await import("./startup-signal");
        try {
          if (await showIconOnExistingTray()) {
            // The launcher spawned this process detached and is waiting for a
            // signal; without one it reports a failed start for a command that
            // succeeded, because this process never had a URL to hand back.
            reportTrayStartup({ status: "already-running" });
            console.log("Cartethyia tray is already running; icon shown.");
            return;
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : "unknown error";
          reportTrayStartup({ status: "failed", message });
          console.error(`Cartethyia tray is already running, but the icon could not be shown: ${message}`);
          process.exitCode = 1;
          return;
        }
      }
      const { startTray } = await import("./tray");
      await startTray();
      return;
    }
    case "autostart": {
      const { enableAutostart, disableAutostart, autostartStatus } = await import("./autostart");
      const arg = Bun.argv[3]?.trim();
      if (arg === "off" || arg === "disable") {
        const state = await disableAutostart();
        console.log(`Autostart disabled (${state.location || state.platform}).`);
        return;
      }
      if (arg === "status") {
        const state = autostartStatus();
        console.log(
          `Autostart: ${state.enabled ? "enabled" : "not enabled"} — ${state.location || state.platform}` +
            (state.reason ? ` (${state.reason})` : ""),
        );
        return;
      }
      // The tray is what autostart launches: a gateway alone has no session to
      // attach to and no icon to show.
      const state = await enableAutostart(process.execPath, [Bun.argv[1] ?? "carte", "tray"]);
      console.log(
        state.enabled
          ? `Autostart enabled — ${state.location}`
          : `Autostart not enabled: ${state.reason ?? "unknown reason"}`,
      );
      return;
    }
    case "doctor": {
      const { doctor } = await import("./doctor");
      await doctor();
      return;
    }
    case "admin": {
      if (process.argv[3] !== "reset-lockout") throw new Error("Usage: cartethyia admin reset-lockout <username> <clientIp> | --all");
      const { resetLockout } = await import("./admin");
      await resetLockout(process.argv.slice(4));
      return;
    }
    case "telemetry": {
      if (process.argv[3] !== "reconcile") {
        console.error("Usage: cartethyia telemetry reconcile --apply|--verify");
        process.exitCode = 2;
        return;
      }
      const { telemetry } = await import("./telemetry");
      await telemetry(process.argv.slice(4));
      return;
    }
    case "update":
      runDetachedUpdate();
      printUpdateInstructions("this install", null);
      return;
    case "--help":
    case "-h":
    case undefined:
      console.log(HELP(await readRequiredBunVersion()));
      return;
    default:
      console.error(`Unknown command: ${command}\n\n${HELP(await readRequiredBunVersion())}`);
      process.exitCode = 2;
  }
}

main().catch(async (error: unknown) => {
  const message = error instanceof Error ? error.message : "unknown error";
  // Only the tray launched for this exact handoff may answer its parent's
  // signal file. An independent `carte --tray` must never fail an unrelated
  // menu that happens to be transferring ownership at the same time.
  if (process.argv[2] === "tray" && process.env.CARTETHYIA_CONTROLLER_PARENT_PID) {
    await reportTrayFailed(message);
  }
  if (message.includes("not starting another instance")) {
    // Exits on its own after a short pause rather than vanishing instantly.
    // Double-clicking a shortcut or re-running a command in a terminal that is
    // already serving used to print nothing visible — the window closed before
    // the operator could read why. The delay is also long enough to notice in
    // a console that stays open, and short enough not to feel like a hang.
    console.error(`Cartethyia is already running.\n${message}`);
    console.error(`\nThis window will close in ${DOUBLE_INSTANCE_EXIT_SECONDS} seconds.`);
    process.exitCode = 1;
    await Bun.sleep(DOUBLE_INSTANCE_EXIT_SECONDS * 1_000);
    return;
  }
  console.error(`Cartethyia failed: ${message}`);
  process.exitCode = 1;
});
