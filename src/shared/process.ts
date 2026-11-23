/**
 * Process liveness, shared by the CLI (instance/controller/gateway locks, the
 * tray control channel) and the console (tray status).
 *
 * One implementation rather than one per caller: whether a pid is alive decides
 * whether a stale lock, controller record, or tray state file is believed, and
 * two copies answering differently on Windows is exactly how a dead record
 * stays authoritative.
 */

/** Whether a process id is alive. `0` is never a real pid. */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (process.platform === "win32") {
    // Bun's process.kill(pid, 0) reports dead Windows PIDs as alive. That
    // leaves controller.json pinning a closed carte forever. tasklist is the
    // OS authority and needs no process handle or elevated privilege.
    const result = Bun.spawnSync(["tasklist.exe", "/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    return result.exitCode === 0 && result.stdout.toString().startsWith('"');
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
