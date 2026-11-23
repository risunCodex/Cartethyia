import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pidAlive } from "../../shared/process";

/**
 * The channel a CLI command or a console route uses to change a running tray's
 * icon.
 *
 * Two small files in the config directory instead of a socket: the process that
 * hides or shows the icon is usually not the tray's parent, and a file needs no
 * port, no handshake, and no dependency. The tray polls the request file and
 * answers through the state file, so a caller can wait for the change it asked
 * for instead of assuming it happened.
 *
 * Both files are advisory. A missing, truncated, or hand-edited file is read as
 * "nothing to do" and discarded — a tray must never die because the operator
 * edited a JSON file.
 *
 * Lives under `src/console/` because the console route and the CLI share it, and
 * `src/` must not import from `scripts/`. The tray itself imports it from here.
 */

/** What a caller can ask the tray to do. */
export type TrayVisibilityRequest = "hide" | "show" | "toggle";

/** A pending request, consumed once by the tray. */
export interface TrayRequest {
  readonly request: TrayVisibilityRequest;
  readonly nonce: string;
  readonly requestedAt: string;
}

/** What the tray last did, so a caller can confirm its request landed. */
export interface TrayState {
  readonly pid: number;
  readonly hidden: boolean;
  readonly updatedAt: string;
  /**
   * The request this record answers, when it answers one.
   *
   * Timestamps cannot carry this: a tray acting inside the same millisecond as
   * the request would look identical to the state that was already there. The
   * nonce is the only thing that says "this is the change you asked for".
   */
  readonly nonce?: string;
}

/**
 * Raised when the gateway has no config directory to write to.
 *
 * Its own type so a caller can report "tray control is unavailable here"
 * instead of a 500: a gateway started without `CARTETHYIA_CONFIG_DIR` is a
 * configuration state, not a crash.
 */
export class TrayControlUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TrayControlUnavailableError";
  }
}

const REQUEST_FILE = "tray-request.json";
const STATE_FILE = "tray-state.json";

/**
 * How long a caller waits for the tray to confirm it acted.
 *
 * The tray polls every second and the change itself is immediate, so this is
 * several polls' worth of slack. It exists so a tray that stopped polling —
 * wedged, or replaced by a stale pid — fails the caller instead of hanging it.
 */
export const TRAY_CHANGE_TIMEOUT_MS = 3_000;

/** How often a caller re-reads the state file while it waits. */
export const TRAY_CHANGE_POLL_MS = 100;

/** Raised when the tray did not confirm the change before the deadline. */
export class TrayChangeTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TrayChangeTimeoutError";
  }
}

/** Pacing for {@link awaitTrayChange}; injected so tests do not wait in real time. */
export interface TrayChangeOptions {
  readonly timeoutMs?: number;
  readonly pollMs?: number;
  /** Yields between polls. */
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * The installation's config directory.
 *
 * `scripts/cli/main.ts` resolves and exports this before any subcommand runs,
 * and a tray-started gateway inherits it, so an unset value means the caller
 * was reached from somewhere that never loaded the user's config — a bug worth
 * naming rather than writing control files into whatever directory the process
 * happens to have.
 */
function configDir(): string {
  const dir = process.env.CARTETHYIA_CONFIG_DIR;
  if (!dir) {
    throw new TrayControlUnavailableError(
      "The Cartethyia config directory is unavailable; start carte before using tray commands",
    );
  }
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Replaces a file in one step.
 *
 * The tray polls while a caller writes, so a plain write would let it read a
 * half-written document and discard a request that was actually valid. The
 * rename is atomic, so a reader sees either the previous file or the new one.
 */
function writeAtomic(path: string, value: unknown): void {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value), { encoding: "utf8", mode: 0o600 });
  try {
    renameSync(temporary, path);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // Keep the rename error: the temp file is the least interesting failure.
    }
    throw error;
  }
}

/** Reads a JSON file, treating "missing" and "unparseable" identically. */
function readJson(path: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Removes a file that cannot be acted on.
 *
 * Errors are swallowed on purpose: this runs on the tray's poll loop and on
 * `status`, where a permission problem must not turn into a crash over a file
 * the caller is already treating as absent.
 */
function discard(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Already gone, or not ours to remove.
  }
}

function parseRequest(value: unknown): TrayRequest | null {
  if (value === null || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const request = record.request;
  if (request !== "hide" && request !== "show" && request !== "toggle") return null;
  return {
    request,
    nonce: typeof record.nonce === "string" ? record.nonce : "",
    requestedAt: typeof record.requestedAt === "string" ? record.requestedAt : "",
  };
}

function parseState(value: unknown): TrayState | null {
  if (value === null || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const { pid, hidden, updatedAt, nonce } = record;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return null;
  if (typeof hidden !== "boolean") return null;
  if (typeof updatedAt !== "string") return null;
  if (nonce !== undefined && typeof nonce !== "string") return null;
  return { pid, hidden, updatedAt, ...(nonce === undefined ? {} : { nonce }) };
}

/** Asks the running tray to change its icon. Overwrites any pending request. */
export function writeTrayRequest(request: TrayVisibilityRequest): TrayRequest {
  const next: TrayRequest = {
    request,
    nonce: crypto.randomUUID(),
    requestedAt: new Date().toISOString(),
  };
  writeAtomic(join(configDir(), REQUEST_FILE), next);
  return next;
}

/**
 * Takes the pending request, if any.
 *
 * The file is removed whether or not it parsed: a request nobody can act on
 * would otherwise be re-read on every poll and reported as a fresh failure each
 * time.
 */
export function consumeTrayRequest(): TrayRequest | null {
  const path = join(configDir(), REQUEST_FILE);
  const request = parseRequest(readJson(path));
  discard(path);
  return request;
}

/** Drops a pending request without acting on it. */
export function clearTrayRequest(): void {
  discard(join(configDir(), REQUEST_FILE));
}

/** Records what the tray is showing, for `carte tray status` and any caller's wait. */
export function writeTrayState(state: {
  readonly pid: number;
  readonly hidden: boolean;
  readonly nonce?: string;
}): void {
  const next: TrayState = {
    pid: state.pid,
    hidden: state.hidden,
    updatedAt: new Date().toISOString(),
    ...(state.nonce === undefined ? {} : { nonce: state.nonce }),
  };
  writeAtomic(join(configDir(), STATE_FILE), next);
}

/**
 * Reads the tray's last known visibility.
 *
 * A record owned by a process that is no longer alive is a leftover from a tray
 * that exited without cleaning up — it reads as "no tray running" and is
 * removed, so no caller can report an icon that is not there.
 */
export function readTrayState(): TrayState | null {
  const path = join(configDir(), STATE_FILE);
  const state = parseState(readJson(path));
  if (state === null || !pidAlive(state.pid)) {
    discard(path);
    return null;
  }
  return state;
}

/** Removes the state record, so no later caller reads a dead tray's icon. */
export function clearTrayState(): void {
  discard(join(configDir(), STATE_FILE));
}

function describe(request: TrayVisibilityRequest): string {
  if (request === "hide") return "hide the icon";
  if (request === "show") return "show the icon";
  return "change the icon";
}

/**
 * Waits until the tray confirms the request it was given.
 *
 * Owned here, next to the two files it reads, because three surfaces ask for the
 * change — the CLI, `carte --tray` when a tray already runs, and the console —
 * and a second copy of this loop is how one of them ends up trusting the state
 * that was already there.
 *
 * A caller that gives up removes its own request: a request left behind would
 * act on the tray minutes later, long after the operator was told it failed.
 */
export async function awaitTrayChange(
  request: TrayVisibilityRequest,
  sent: TrayRequest,
  options: TrayChangeOptions = {},
): Promise<TrayState> {
  const desired = request === "hide" ? true : request === "show" ? false : null;
  const timeoutMs = options.timeoutMs ?? TRAY_CHANGE_TIMEOUT_MS;
  const pollMs = options.pollMs ?? TRAY_CHANGE_POLL_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const state = readTrayState();
      // The nonce is what ties this record to this request. A toggle has no
      // fixed target, so its nonce alone settles it; hide and show also check
      // that the tray ended up in the state that was asked for.
      if (state?.nonce === sent.nonce && (desired === null || state.hidden === desired)) {
        return state;
      }
      await sleep(pollMs);
    }
    throw new TrayChangeTimeoutError(
      `The tray did not ${describe(request)} within ${timeoutMs} ms`,
    );
  } catch (error) {
    clearTrayRequest();
    throw error;
  }
}
