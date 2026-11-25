#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const { randomUUID } = require("node:crypto");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const packageRoot = path.resolve(__dirname, "..", "..", "..");
const cliPath = path.join(packageRoot, "scripts", "cli", "main.ts");
const configDir = process.env.CARTETHYIA_CONFIG_DIR || (
  process.platform === "win32"
    ? path.join(process.env.APPDATA || os.homedir(), "Cartethyia")
    : process.platform === "darwin"
      ? path.join(os.homedir(), "Library", "Application Support", "Cartethyia")
      : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "Cartethyia")
);
// `carte tray` starts a tray and waits for its startup signal.
// `carte tray hide|show|toggle|status` asks the tray that is already running for
// something and must run in the foreground, so the subcommand decides which of
// the two this is. Treating every `tray` argv as tray mode made those commands
// detach, print "Loading Cartethyia…", and fail after the CLI exited 0.
const TRAY_SUBCOMMANDS = new Set(["hide", "show", "toggle", "status"]);
const trayMode = process.argv[2] === "tray" && !TRAY_SUBCOMMANDS.has(process.argv[3]);
// The compiled gateway binary resolves its assets from this. A compiled Bun
// executable has a virtual `import.meta.dir` (`B:/~BUN/root/cartethyia`), so
// without it the package root falls back to `B:\` and startup dies with
// `ENOENT: scandir 'B:\migrations\lite-sqlite3'`. Only the local/VPS installers
// set it, so an npm install never had it — and the compiled binary is the
// default gateway executable whenever `dist/cartethyia` exists.
process.env.CARTETHYIA_PACKAGE_ROOT = packageRoot;
// The launcher itself runs under Node, so `process.execPath` is node.exe — not
// the Bun the child needs. Resolve bun from PATH instead; WScript.Shell does
// not inherit this process's environment, so the child needs an absolute path.
function resolveBunPath() {
  if (process.env.CARTETHYIA_BUN) return process.env.CARTETHYIA_BUN;
  const name = process.platform === "win32" ? "bun.exe" : "bun";
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {}
  }
  return name;
}

const startupSignalPath = trayMode
  ? path.join(os.tmpdir(), `cartethyia-tray-${process.pid}-${randomUUID()}.json`)
  : null;
let spawnError;
// On Windows the tray must start with no console at all, and neither
// `detached: true` nor `windowsHide: true` achieves that: a console-subsystem
// child of a window-less parent still allocates a console, and inside Windows
// Terminal the tab is already on screen before a flag can take effect
// (measured). `wscript.exe` is GUI-subsystem, so it never allocates one, and a
// child launched from it with window style 0 inherits that. Elsewhere
// `detached: true` is enough.
const useWindowsDetach = process.platform === "win32" && trayMode;
const hiddenLauncher = path.join(packageRoot, "scripts", "cli", "tray", "hidden-window.vbs");
const child = useWindowsDetach
  ? spawn(
      "wscript.exe",
      // Absolute path, not "bun": the VBS runs through WScript.Shell, which
      // does not inherit this process's PATH additions and resolves a bare
      // name against the system PATH only.
      // packageRoot is the first argument: the VBS sets it as the child's
      // working directory. `cwd` below does not reach the grandchild, and
      // wscript.exe otherwise passes on its own inherited directory.
      ["//nologo", hiddenLauncher, packageRoot, resolveBunPath(), "run", cliPath, ...process.argv.slice(2)],
      {
        cwd: packageRoot,
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        env: {
          ...process.env,
          CARTETHYIA_CONFIG_DIR: configDir,
          CARTETHYIA_TRAY_STARTUP_SIGNAL: startupSignalPath,
        },
      },
    )
  : spawn(resolveBunPath(), ["run", cliPath, ...process.argv.slice(2)], {
      cwd: packageRoot,
      detached: trayMode,
      stdio: trayMode ? "ignore" : "inherit",
      windowsHide: trayMode,
      env: {
        ...process.env,
        CARTETHYIA_CONFIG_DIR: configDir,
        ...(trayMode ? { CARTETHYIA_TRAY_STARTUP_SIGNAL: startupSignalPath } : {}),
      },
    });

child.once("error", (error) => {
  spawnError = error;
  if (error.code === "ENOENT") {
    console.error("Cartethyia requires Bun 1.4.0 or newer. Install Bun from https://bun.sh, then run this command again.");
  } else {
    console.error(`Could not start Cartethyia's Bun runtime: ${error.message}`);
  }
  process.exitCode = 1;
});

if (trayMode) {
  child.unref();
  console.log("Loading Cartethyia…");
  let settled = false;
  const deadline = Date.now() + 60_000;
  const finish = (error, readyMessage) => {
    if (settled) return;
    settled = true;
    try {
      fs.unlinkSync(startupSignalPath);
    } catch {}
    if (error) {
      // `error.message` can be an empty string when the failure came from a
      // signal rather than a thrown message, which printed as a bare
      // "Cartethyia failed to start:" with no cause. Fall back to the code and
      // name what usually causes it.
      const detail =
        error.message && error.message.trim() !== ""
          ? error.message
          : `the process exited without a message (code ${child.exitCode ?? "unknown"})`;
      console.error(`Cartethyia failed to start: ${detail}`);
      console.error(
        "If another Cartethyia is already running on this port, stop the terminal that started it first.",
      );
      process.exitCode = 1;
      if (child.exitCode === null) child.kill();
      return;
    }
    console.log(readyMessage);
    // The gateway child is already detached and unref'd; this Node process is
    // the only thing still holding the launching terminal open. Exit once the
    // URL has been shown so the shell prompt comes back.
    setTimeout(() => process.exit(0), 1_500);
  };
  const poll = () => {
    if (settled) return;
    if (fs.existsSync(startupSignalPath)) {
      try {
        const signal = JSON.parse(fs.readFileSync(startupSignalPath, "utf8"));
        if (signal.status === "ready" && typeof signal.url === "string") {
          // A start that needs explaining — a tray whose icon is deliberately
          // hidden — carries its line here, because the tray's own stdout goes
          // nowhere once it is detached.
          const note = typeof signal.note === "string" ? `\n${signal.note}` : "";
          finish(null, `Cartethyia is ready at ${signal.url}${note}`);
          return;
        }
        // A tray was already running and this command only asked it for its
        // icon: success with no URL, not a start that never finished.
        if (signal.status === "already-running") {
          finish(null, "Cartethyia is already running; tray icon shown.");
          return;
        }
        if (signal.status === "failed" && typeof signal.message === "string") {
          finish(new Error(signal.message));
          return;
        }
      } catch {}
    }
    if (spawnError) {
      finish(spawnError);
      return;
    }
    if (Date.now() >= deadline) {
      finish(new Error("startup did not complete within 60 seconds"));
      return;
    }
    setTimeout(poll, 150);
  };
  // On Windows the spawned process is `wscript.exe`, which hands off to the
  // tray and exits immediately — a successful handoff, not a failed start. Only
  // a direct spawn's exit says anything about the tray, so the deadline covers
  // the handoff case and this guard covers the direct one.
  if (!useWindowsDetach) {
    child.once("exit", (code, signal) => {
      if (!settled) setTimeout(() => finish(new Error(`the tray process exited before readiness (code ${code ?? signal ?? "unknown"})`)), 250);
    });
  }
  poll();
} else {
  child.once("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exitCode = code ?? 1;
  });
}
