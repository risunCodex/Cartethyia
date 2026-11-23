import { resolvePort } from "../../src/config/runtime";
import { ensureDrainToken } from "./instance";
import { clearInstanceLock, readInstanceLock, writeInstanceLock } from "./instance";
import { pidAlive } from "../../src/shared/process";
import { blockedPortMessage, listenPortErrorMessage, probeListenPort } from "./port";

/**
 * Runs the gateway in the foreground, in this process.
 *
 * A foreground run still needs a drain token on disk: the gateway registers
 * `/admin/drain` only when one is set, and "Hide to tray" hands this run to a
 * tray that drains it through that route.
 *
 * Unlike the menu and tray paths this one does not spawn a child, so the
 * port-busy check has to happen here too — otherwise a stale gateway makes a
 * plain `cartethyia start` fail from inside `src/main` with a message that says
 * nothing about what to do.
 */
export async function startForeground(): Promise<void> {
  const token = ensureDrainToken();
  process.env.CARTETHYIA_DRAIN_TOKEN ??= token;
  const port = resolvePort();
  const probe = await probeListenPort(port);
  if (probe.status === "blocked" && probe.code !== "EADDRINUSE") {
    throw new Error(listenPortErrorMessage(port, probe));
  }
  const blocker = await inspectPortHolder(port, token);
  if (blocker !== null) throw new Error(blocker);
  writeInstanceLock(port, process.pid, token);
  // dynamic-import: `src/main` boots the gateway as a side effect of module
  // evaluation. Importing it statically would start the server before the
  // port probe + instance-lock sequence above has a chance to refuse the run.
  await import("../../src/main");
}

/**
 * What to tell the operator when the port is already taken, or `null` when the
 * port is free (or was freed).
 *
 * Same rule as the spawned path: only ever stop a gateway that proves it is
 * this install's own. A drain request is token-gated, so a 401 means another
 * Cartethyia install and anything else is not a gateway at all — neither may be
 * touched, and both are reported instead.
 */
async function inspectPortHolder(port: number, token: string): Promise<string | null> {
  const up = await fetch(`http://127.0.0.1:${port}/health`, {
    signal: AbortSignal.timeout(1_000),
  }).catch(() => null);
  if (up === null) {
    // Port is free. Drop a stale marker from a crashed run so the next start
    // does not read a dead pid as a live gateway.
    const lock = readInstanceLock();
    if (lock !== null && lock.port === port && !pidAlive(lock.pid)) clearInstanceLock();
    return null;
  }
  const response = await fetch(`http://127.0.0.1:${port}/admin/drain`, {
    method: "POST",
    headers: { "x-drain-token": token },
    signal: AbortSignal.timeout(3_000),
  }).catch(() => null);
  if (response === null) {
    return blockedPortMessage(port);
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
  // Drain accepted; wait for the port to actually close.
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
