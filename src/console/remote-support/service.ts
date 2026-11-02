/**
 * Remote-support tunnel service.
 *
 * Launches `cloudflared` or `tailscale` detached from the gateway process, so
 * a gateway restart, a hot reload, or a Ctrl-C in the owning terminal cannot
 * kill an operator's live remote-support session. Earlier revisions shelled
 * out to a `.cmd` + `.ps1` launcher pair; those were Windows-only, had to be
 * carried through the npm tarball, and failed with "Launcher not found" the
 * day the whitelist missed them. This module does the same work with
 * `child_process.spawn` directly and runs on every host Node runs on.
 *
 * This service never installs anything. A missing binary is reported as a
 * blocker with install guidance; downloading a third-party agent on the
 * operator's behalf is out of scope.
 */
import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveUserConfigDir } from "../../config/package-paths";
import {
  remoteSupportInstallHint,
  REMOTE_SUPPORT_TOOLS,
  type RemoteSupportBlocker,
  type RemoteSupportStatus,
  type RemoteSupportTool,
} from "./contracts";

/** How long to tail the publisher's log before giving up on a URL. */
const URL_WAIT_MS = 25_000;
/** How often to re-scan the log file while waiting for the URL. */
const URL_POLL_MS = 500;

/** Cached install detection so we don't spawn `where`/`which` on every poll. */
const installedCache = new Map<RemoteSupportTool, boolean>();

interface RemoteSupportServiceConfig {
  /** Defaults to the gateway's configured port. */
  readonly port: number;
  /** Overridable for tests. Defaults to a subdir of the user config dir. */
  readonly stateDir?: string;
}

function stateDirOf(config: RemoteSupportServiceConfig): string {
  return config.stateDir ?? join(resolveUserConfigDir(), "remote-support");
}

function ensureStateDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function pidPath(dir: string, tool: RemoteSupportTool): string {
  return join(dir, `${tool}.pid`);
}
function urlPath(dir: string, tool: RemoteSupportTool): string {
  return join(dir, `${tool}.url`);
}
function logPath(dir: string, tool: RemoteSupportTool): string {
  return join(dir, `${tool}.log`);
}
function errPath(dir: string, tool: RemoteSupportTool): string {
  return join(dir, `${tool}.err`);
}

/**
 * `where` / `which` lookup, cached per process. Shelled out rather than coded
 * because PATHEXT, Spotlight PATH injections, and nvm's shims make the
 * resolved location non-trivial — the OS's own resolver gets it right.
 */
function toolAvailable(tool: RemoteSupportTool): Promise<boolean> {
  const cached = installedCache.get(tool);
  if (cached !== undefined) return Promise.resolve(cached);
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const command = process.platform === "win32" ? "where" : "which";
  const child = spawn(command, [tool], { stdio: "ignore", windowsHide: true });
  child.on("error", () => {
    installedCache.set(tool, false);
    resolve(false);
  });
  child.on("close", (status) => {
    const ok = status === 0;
    installedCache.set(tool, ok);
    resolve(ok);
  });
  return promise;
}

/** Non-blocking check: is `pid` still alive on this host? Cross-OS. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reads the recorded PID file, returning `null` if the file is missing, empty,
 * malformed, or names a process that is no longer alive. Dead files are
 * cleaned up so a later start does not race against a stale record.
 */
function readLivePid(dir: string, tool: RemoteSupportTool): number | null {
  const file = pidPath(dir, tool);
  if (!existsSync(file)) return null;
  const raw = readFileSync(file, "utf8").trim();
  const pid = Number.parseInt(raw, 10);
  if (!Number.isFinite(pid) || pid <= 0) {
    rmSync(file, { force: true });
    return null;
  }
  if (!pidAlive(pid)) {
    rmSync(file, { force: true });
    return null;
  }
  return pid;
}

/**
 * Terminates `pid` and its descendants. On Windows the tree has to be killed
 * explicitly via `taskkill /T /F` — plain `process.kill` only signals the
 * top-level process, and cloudflared under Windows spawns a worker that keeps
 * the port open after the parent exits. On POSIX, SIGTERM to the group covers
 * descendants spawned with `detached: true`.
 */
function killTree(pid: number): void {
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* already dead */
    }
  }
}

/** Arguments for the detached publisher launch. Shape mirrors the old script. */
function launchArgsFor(tool: RemoteSupportTool, port: number): readonly string[] {
  if (tool === "cloudflared") {
    // `--url` prints the fresh *.trycloudflare.com hostname (to stderr).
    return ["tunnel", "--url", `http://127.0.0.1:${port}`, "--no-autoupdate"];
  }
  // `serve --bg` returns immediately; the funnel listens on 443.
  return ["serve", "--bg", "--https=443", `http://127.0.0.1:${port}`];
}

/** The pattern anchors to the tunnel's own hostname so Cloudflare's startup
 * banner (which references `cloudflare.com`) is not mistaken for the URL. */
function urlPatternFor(tool: RemoteSupportTool): RegExp {
  return tool === "cloudflared"
    ? /https:\/\/[A-Za-z0-9-]+\.trycloudflare\.com/
    : /https:\/\/[A-Za-z0-9.-]+\.ts\.net/;
}

/**
 * Tails the publisher's stdout + stderr log files for the URL regex. Resolves
 * with the first match or `null` after the overall deadline.
 */
async function waitForUrl(dir: string, tool: RemoteSupportTool): Promise<string | null> {
  const pattern = urlPatternFor(tool);
  const deadline = Date.now() + URL_WAIT_MS;
  const log = logPath(dir, tool);
  const err = errPath(dir, tool);
  while (Date.now() < deadline) {
    for (const path of [log, err]) {
      if (!existsSync(path)) continue;
      const text = readFileSync(path, "utf8");
      const match = pattern.exec(text);
      if (match) return match[0];
    }
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, URL_POLL_MS);
    await promise;
  }
  return null;
}

/**
 * Last-resort hostname lookup for Tailscale.
 *
 * `tailscale serve --bg` prints nothing useful once it has backgrounded; the
 * live hostname comes from the daemon's own status. The JSON shape has drifted
 * across releases (`DNSName` at the root in some, nested under `Self` in
 * others), so both locations are probed and the first hit wins.
 *
 * `status` is probed as well as `serve status`: the latter answers `{}` until
 * the node has actually joined the tailnet, which is exactly when the operator
 * is staring at a "started" publisher with no link. `status` carries
 * `Self.DNSName` and `BackendState` throughout, so it names the node while
 * serve is still coming up.
 */
function tailscaleUrlFromDaemon(): string | null {
  const name = tailscaleDnsName();
  return name === null ? null : `https://${name}`;
}

/**
 * Why a publisher that started has not published an address.
 *
 * For Tailscale the answer is almost always that the node is not on the
 * tailnet yet — still starting, or never logged in — and both are the
 * operator's move, not the gateway's. Naming which one turns a dead end into
 * something to do.
 */
function notReadyReason(tool: RemoteSupportTool): string {
  if (tool !== "tailscale") return `${tool} started but has not published an address yet.`;
  const state = spawnSync("tailscale", ["status", "--json"], { encoding: "utf8", windowsHide: true });
  let backend: string | null = null;
  let authUrl: string | null = null;
  try {
    const bag = JSON.parse(state.stdout) as Record<string, unknown>;
    backend = typeof bag["BackendState"] === "string" ? (bag["BackendState"] as string) : null;
    authUrl = typeof bag["AuthURL"] === "string" && (bag["AuthURL"] as string).length > 0 ? (bag["AuthURL"] as string) : null;
  } catch {
    // An unreadable status still leaves the generic message below.
  }
  if (authUrl !== null) return `Tailscale needs to be logged in. Open ${authUrl} once, then start the tunnel again.`;
  if (backend !== null && backend !== "Running") {
    return `Tailscale is not connected yet (state: ${backend}). Wait for it to finish starting, then start the tunnel again.`;
  }
  return "Tailscale has no tailnet address yet. Run `tailscale up` once, then start the tunnel again.";
}

/** This node's MagicDNS name, or `null` when the daemon has none yet. */
function tailscaleDnsName(): string | null {
  for (const args of [
    ["serve", "status", "--json"],
    ["status", "--json"],
  ] as const) {
    const name = dnsNameFromStatus(args);
    if (name !== null) return name;
  }
  return null;
}

/**
 * Whether `tailscale serve` is actually publishing anything.
 *
 * `serve status --json` is `{}` when nothing is served and gains `Web`
 * (handlers) or `TCP` entries when something is. The node being online says
 * nothing about this: stopping the tunnel leaves the node up and empties the
 * status, which is why an online node alone was read as "still active".
 */
function tailscaleServing(): boolean {
  const result = spawnSync("tailscale", ["serve", "status", "--json"], { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return false;
  }
  return serveStatusHasHandler(parsed);
}

/**
 * Whether a parsed `serve status` body publishes anything.
 *
 * Split from the spawn so the shape rules are testable without a daemon: `{}`
 * is the empty answer, and any entry under `Web` or `TCP` is a live one.
 */
export function serveStatusHasHandler(parsed: unknown): boolean {
  const bag: Record<string, unknown> =
    typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  for (const key of ["Web", "TCP"]) {
    const entries = bag[key];
    if (typeof entries === "object" && entries !== null && Object.keys(entries).length > 0) return true;
  }
  return false;
}

function dnsNameFromStatus(args: readonly string[]): string | null {
  const result = spawnSync("tailscale", [...args], { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return null;
  }
  const bag: Record<string, unknown> =
    typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  // Only `status` can prove the node is up — `serve status` carries no node
  // state. A stopped node still reports its last DNS name, and publishing that
  // as a live link is worse than publishing nothing: the operator opens an
  // address that cannot resolve.
  if (args[0] === "status") {
    const self = selfOf(bag);
    const online = self === null ? null : self["Online"];
    if (online === false) return null;
  }
  const direct = typeof bag["DNSName"] === "string" ? (bag["DNSName"] as string) : null;
  const self = selfOf(bag);
  const nested = self && typeof self["DNSName"] === "string" ? (self["DNSName"] as string) : null;
  const hostname = (direct ?? nested)?.trim().replace(/\/+$/, "").replace(/\.$/, "");
  return hostname && hostname.length > 0 ? hostname : null;
}

function selfOf(bag: Record<string, unknown>): Record<string, unknown> | null {
  return typeof bag["Self"] === "object" && bag["Self"] !== null ? (bag["Self"] as Record<string, unknown>) : null;
}

/**
 * Starts `tool` detached, writes its logs to the state dir, records the pid,
 * and waits briefly for the URL. The caller never becomes the publisher's
 * parent — `detached` + `unref` + `ignore`-stdin cuts the inheritance chain.
 */
async function launchDetached(
  dir: string,
  tool: RemoteSupportTool,
  port: number,
): Promise<{ pid: number; url: string | null; error: string | null }> {
  const resolved = spawnSync(process.platform === "win32" ? "where" : "which", [tool], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (resolved.status !== 0) {
    return { pid: 0, url: null, error: `${tool} is not on PATH` };
  }
  const binary = resolved.stdout.split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0);
  if (!binary) {
    return { pid: 0, url: null, error: `${tool} is not on PATH` };
  }
  ensureStateDir(dir);
  rmSync(urlPath(dir, tool), { force: true });
  rmSync(logPath(dir, tool), { force: true });
  rmSync(errPath(dir, tool), { force: true });
  const outFd = openSync(logPath(dir, tool), "a");
  const errFd = openSync(errPath(dir, tool), "a");
  try {
    const child = spawn(binary, launchArgsFor(tool, port), {
      detached: true,
      windowsHide: true,
      stdio: ["ignore", outFd, errFd],
    });
    const pid = child.pid;
    if (pid === undefined) {
      return { pid: 0, url: null, error: `failed to launch ${tool}` };
    }
    writeFileSync(pidPath(dir, tool), String(pid), "utf8");
    child.unref();
    let url = await waitForUrl(dir, tool);
    if (!url && tool === "tailscale") {
      url = tailscaleUrlFromDaemon();
    }
    if (url) writeFileSync(urlPath(dir, tool), url, "utf8");
    return { pid, url, error: null };
  } finally {
    closeSync(outFd);
    closeSync(errFd);
  }
}

export interface RemoteSupportService {
  status(): Promise<RemoteSupportStatus>;
  start(tool: RemoteSupportTool, port?: number): Promise<RemoteSupportStatus>;
  stop(tool?: RemoteSupportTool): Promise<RemoteSupportStatus>;
}

export function createRemoteSupportService(config: RemoteSupportServiceConfig): RemoteSupportService {
  const port = config.port;
  const dir = stateDirOf(config);

  async function detectInstalled(): Promise<Readonly<Record<RemoteSupportTool, boolean>>> {
    const [cloudflared, tailscale] = await Promise.all([
      toolAvailable("cloudflared"),
      toolAvailable("tailscale"),
    ]);
    return { cloudflared, tailscale } as const;
  }

  /** Which publisher, if any, is currently alive on this host. */
  function detectActive(): { tool: RemoteSupportTool | null; url: string | null } {
    for (const tool of REMOTE_SUPPORT_TOOLS) {
      // Tailscale runs as a system service — its serve daemon owns its own
      // lifecycle, so a pid file is not reliable. Ask the daemon.
      if (tool === "tailscale") {
        // Both halves are required. A node that is up but serving nothing is
        // not publishing an address, and reporting it as active left the
        // toggle on and a stale link in place after the operator stopped it —
        // `serve status` goes back to `{}` but the node stays `Online`.
        const url = tailscaleServing() ? tailscaleUrlFromDaemon() : null;
        if (url) return { tool: "tailscale", url };
        continue;
      }
      const pid = readLivePid(dir, tool);
      if (pid === null) continue;
      const recorded = existsSync(urlPath(dir, tool)) ? readFileSync(urlPath(dir, tool), "utf8").trim() : "";
      return { tool, url: recorded.length > 0 ? recorded : null };
    }
    return { tool: null, url: null };
  }

  async function readStatus(
    blocker: RemoteSupportBlocker | null = null,
    message: string | null = null,
  ): Promise<RemoteSupportStatus> {
    const { tool, url } = detectActive();
    const installed = await detectInstalled();
    return { active: tool, url, blocker, message, port, installed };
  }

  async function stopTool(tool: RemoteSupportTool): Promise<void> {
    if (tool === "tailscale") {
      // The daemon owns the serve lifecycle; `serve reset` is the sanctioned
      // teardown and leaves no orphan process behind.
      spawnSync("tailscale", ["serve", "reset"], { stdio: "ignore", windowsHide: true });
      rmSync(urlPath(dir, tool), { force: true });
      rmSync(pidPath(dir, tool), { force: true });
      return;
    }
    const pid = readLivePid(dir, tool);
    if (pid !== null) killTree(pid);
    rmSync(pidPath(dir, tool), { force: true });
    rmSync(urlPath(dir, tool), { force: true });
  }

  return {
    async status() {
      return await readStatus();
    },

    async start(tool, requestedPort) {
      if (!(await toolAvailable(tool))) {
        return {
          active: null,
          url: null,
          blocker: "not_installed",
          message: remoteSupportInstallHint(tool),
          port,
          installed: await detectInstalled(),
        };
      }
      // Replace any stale run of the same tool before launching a new one, so
      // two instances never fight for the same local port.
      await stopTool(tool);
      const target = requestedPort ?? port;
      const result = await launchDetached(dir, tool, target);
      if (result.error) {
        return {
          active: null,
          url: null,
          blocker: "launch_failed",
          message: result.error,
          port,
          installed: await detectInstalled(),
        };
      }
      const status = await readStatus();
      // A publisher that started but published no address is the state that
      // used to look like a silent success: the UI showed the tool as active
      // with no link and no reason. Say what is missing instead.
      if (status.active !== null && status.url === null) {
        return { ...status, blocker: "not_ready", message: notReadyReason(status.active) };
      }
      return status;
    },

    async stop(tool) {
      if (tool === undefined) {
        for (const name of REMOTE_SUPPORT_TOOLS) await stopTool(name);
      } else {
        await stopTool(tool);
      }
      return await readStatus();
    },
  };
}
