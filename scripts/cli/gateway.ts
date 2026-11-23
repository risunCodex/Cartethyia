import { openSync, statSync } from "node:fs";
import {
  clearInstanceLock,
  fingerprint,
  readInstanceLock,
  writeInstanceLock,
} from "./instance";
import { pidAlive } from "../../src/shared/process";
import { join } from "node:path";
import { PACKAGE_ROOT, compiledBinaryPath, resolvePackagePath } from "../../src/config/package-paths";
import { spawn as spawnDetached, type ChildProcess } from "node:child_process";
import {
  blockedPortMessage,
  gatewayLogPath,
  listenPortErrorMessage,
  probeListenPort,
  startupFailureMessage,
} from "./port";

/** Resolve a configured gateway without mistaking a Bun launcher for a compiled app. */
export async function gatewayExecutable(configured: string | undefined): Promise<readonly string[]> {
  const trimmed = configured?.trim();
  const binary = trimmed ? resolvePackagePath(trimmed) : resolvePackagePath(compiledBinaryPath());
  if (await Bun.file(binary).exists()) {
    return binary.endsWith(".ts") ? [process.execPath, "run", binary] : [binary];
  }
  if (trimmed) throw new Error(`Configured gateway binary does not exist: ${trimmed}`);
  return [process.execPath, "run", resolvePackagePath("src", "main.ts")];
}

function detachedSubprocess(executable: readonly string[], cwd: string, env: NodeJS.ProcessEnv, logFd: number | null): Bun.Subprocess {
  const child: ChildProcess = spawnDetached(executable[0]!, [...executable.slice(1)], {
    cwd,
    env,
    detached: true,
    windowsHide: true,
    stdio: ["ignore", logFd ?? "ignore", logFd ?? "ignore"],
  });
  child.unref();
  const exited = new Promise<number>((resolve) => {
    child.once("exit", (code) => resolve(code ?? 1));
  });
  return {
    pid: child.pid!,
    exited,
    exitCode: null,
    signalCode: null,
    kill: () => child.kill(),
    unref: () => child.unref(),
  } as unknown as Bun.Subprocess;
}

/**
 * Frees the port when what holds it is this install's own gateway.
 *
 * Returns `null` when the port is free (or was successfully taken), and a
 * message to fail with otherwise. It never kills a process it cannot identify:
 * a stranger's service on this port is reported, not drained.
 *
 * The probe is two-step on purpose. `/health` alone is answered by anything, so
 * it only says "something is there"; the drain request is what distinguishes
 * ours from someone else's, because it is token-gated — and a 401 means another
 * Cartethyia install, which this one must not stop.
 */
async function claimPort(port: number, drainToken: string): Promise<string | null> {
  // A lock naming this install's own gateway is the strongest evidence
  // available, so prefer it over the network probe when it is live.
  const lock = readInstanceLock();
  const ours = lock !== null && lock.port === port && lock.tokenFingerprint === fingerprint(drainToken);

  const response = await fetch(`http://127.0.0.1:${port}/admin/drain`, {
    method: "POST",
    headers: { "x-drain-token": drainToken },
    signal: AbortSignal.timeout(3_000),
  }).catch(() => null);

  if (response === null) {
    // Nothing answered a drain request. If our own lock names a dead pid, the
    // marker is stale and nothing is holding the port — clear it and continue.
    if (ours && !pidAlive(lock.pid)) {
      clearInstanceLock();
      return null;
    }
    return `Port ${port} is busy and nothing there answers a drain request. Stop whatever holds it, or set a different PORT.`;
  }
  if (response.status === 401) {
    return `Another Cartethyia gateway is already running on port ${port} under a different install. Stop it from its own terminal or tray — this install will not stop a gateway it does not own.`;
  }
  if (response.status === 403) {
    return `Port ${port} refused a drain from loopback. Stop what holds it, then start again.`;
  }
  if (response.status !== 202) {
    return `Port ${port} is busy and refused to drain (HTTP ${response.status}). Stop it manually, then start again.`;
  }
  // Drain accepted. Wait for the port to actually free: the gateway flushes its
  // 202 before closing sockets, so acceptance is not release.
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const stillUp = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(500),
    }).catch(() => null);
    if (stillUp === null) {
      clearInstanceLock();
      return null;
    }
    await Bun.sleep(200);
  }
  return `The gateway on port ${port} accepted a drain but did not release the port within 30 seconds. Stop it manually, then start again.`;
}

/**
 * Starts the gateway and resolves once it answers its own health probe.
 *
 * The child is attached by default. A detached child cannot be killed from an
 * `exit` handler on Windows (measured: `kill()` runs, the gateway keeps
 * serving), and a terminal's Ctrl-C only reaches children in the same process
 * group. Staying attached means Ctrl-C and the `exit` backstop both stop the
 * gateway. "Hide to tray" passes `detached: true` because that gateway must
 * outlive this process.
 */
export async function startGateway(
  port: number,
  drainToken: string,
  options: { readonly detached?: boolean } = {},
): Promise<Bun.Subprocess> {
  // A dead marker from the previous process must not turn its now-reused port
  // into an ownership claim. Only identity + drain authorization may stop one.
  const lock = readInstanceLock();
  if (lock && !pidAlive(lock.pid)) clearInstanceLock();
  const probe = await probeListenPort(port);
  if (probe.status === "blocked") {
    if (probe.code === "EADDRINUSE") {
      const claimed = await claimPort(port, drainToken);
      if (claimed !== null) {
        if (claimed.startsWith("Port") && claimed.includes("nothing there answers")) {
          throw new Error(blockedPortMessage(port));
        }
        throw new Error(claimed);
      }
      const released = await probeListenPort(port);
      if (released.status === "blocked") throw new Error(blockedPortMessage(port));
    } else {
      throw new Error(listenPortErrorMessage(port, probe));
    }
  }
  // The gateway logs a startup phase line per stage. In menu mode those lines
  // would scroll through the same terminal the menu is drawing on, so they go
  // to a file instead and the operator sees only the menu.
  const configDir = process.env.CARTETHYIA_CONFIG_DIR;
  let logFd: number | null = null;
  if (configDir) {
    try {
      logFd = openSync(join(configDir, "gateway.log"), "a");
    } catch {
      // A read-only config directory costs only the log, not startup.
    }
  }
  const logPath = gatewayLogPath(configDir);
  let logOffset = 0;
  if (logPath) {
    try { logOffset = statSync(logPath).size; } catch { logOffset = 0; }
  }
  const executable = [...await gatewayExecutable(process.env.CARTETHYIA_GATEWAY_BINARY)];
  const child = options.detached
    ? detachedSubprocess(executable, PACKAGE_ROOT, { ...process.env, CARTETHYIA_DRAIN_TOKEN: drainToken }, logFd)
    : Bun.spawn(executable, {
      cwd: PACKAGE_ROOT,
      env: { ...process.env, CARTETHYIA_DRAIN_TOKEN: drainToken },
      // "ignore", not "inherit": the gateway does not read stdin, and in menu
      // mode the menu is the only stdin consumer. With "inherit" the gateway
      // held the fd and swallowed every keypress after the first, so the menu
      // rendered but never received Enter.
      stdin: "ignore",
      stdout: logFd ?? "ignore",
      // stderr goes to the same file: "inherit" ties the gateway to the
      // terminal, so closing that terminal took the gateway down with it and
      // "Hide to tray" left nothing running.
      stderr: logFd ?? "ignore",
      detached: false,
    });
  const startupController = new AbortController();
  const ready = (async (): Promise<void> => {
    const deadline = Date.now() + 30_000;
    while (!startupController.signal.aborted && Date.now() < deadline) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/health`, {
          signal: AbortSignal.timeout(500),
        });
        if (response.ok) {
          const body: unknown = await response.json();
          if (body !== null && typeof body === "object" && "status" in body && body.status === "ok") return;
        }
      } catch {
        // The gateway is not accepting health requests yet.
      }
      await Bun.sleep(250);
    }
    if (startupController.signal.aborted) throw new Error("Cartethyia exited before becoming ready");
    throw new Error("Cartethyia did not open its configured port within 30 seconds");
  })();
  const exitedEarly = child.exited.then((code) => {
    startupController.abort();
    return { status: "exit" as const, code };
  });
  const readyResult = ready.then(
    () => ({ status: "ready" as const }),
    (error: unknown) => ({ status: "failure" as const, error }),
  );
  try {
    const result = await Promise.race([readyResult, exitedEarly]);
    if (result.status === "exit") {
      throw new Error(startupFailureMessage(port, result.code, logPath, logOffset));
    }
    if (result.status === "failure") throw result.error;
    // Recorded only once the child is actually serving: a marker written before
    // readiness would name a gateway that never came up, and the next start
    // would treat a live port as ours when it is not.
    writeInstanceLock(port, child.pid, drainToken, executable[0]!);
    if (options.detached) child.unref();
    return child;
  } catch (error) {
    child.kill();
    await child.exited;
    throw error;
  }
}

/** Stops a child gateway, draining in-flight responses before termination. */
export async function stopGateway(
  current: Bun.Subprocess,
  port: number,
  drainToken: string,
): Promise<void> {
  let drainAccepted = false;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/admin/drain`, {
      method: "POST",
      headers: { "x-drain-token": drainToken },
      signal: AbortSignal.timeout(2_000),
    });
    drainAccepted = response.status === 202;
  } catch {
    // The process may already be exiting.
  }
  if (!drainAccepted) {
    console.error("Could not request a graceful gateway drain; terminating the gateway process.");
    current.kill();
    await current.exited;
    return;
  }
  let timer: Timer | undefined;
  const drained = await Promise.race([
    current.exited,
    new Promise<null>((resolveExit) => {
      timer = setTimeout(() => resolveExit(null), 30_000);
    }),
  ]);
  clearTimeout(timer);
  if (drained === null) {
    console.error("Graceful drain timed out; terminating the gateway process.");
    current.kill();
    await current.exited;
  }
}
