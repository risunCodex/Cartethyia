/**
 * The tray control channel: the two files that let a CLI command ask a running
 * tray to change its icon and read back what it did.
 *
 * Everything here is filesystem state, so the tests point
 * `CARTETHYIA_CONFIG_DIR` at a temp directory and never touch the operator's
 * real config — the same isolation `test/cli/controller.test.ts` uses.
 */
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import type { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import { join } from "node:path";
import type { ClickEvent, MenuItem } from "systray2";
import {
  clearTrayRequest,
  clearTrayState,
  consumeTrayRequest,
  readTrayPreference,
  readTrayState,
  writeTrayRequest,
  writeTrayState,
} from "../../src/console/tray/control";
import {
  createTray,
  type Tray,
  type TrayHelper,
  type TrayItem,
  type UnixHelperFactory,
  type UnixHelperOptions,
  type WindowsHelperFactory,
} from "../../scripts/cli/tray/index";
import {
  applyTrayVisibility,
  requestTrayVisibility,
  respondToTrayRequest,
  runTrayCommand,
  showIconOnExistingTray,
} from "../../scripts/cli/tray/commands";
import { createShutdownPause } from "../../scripts/cli/tray/lifecycle";

let configDir: string;
let originalConfigDir: string | undefined;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "carte-tray-control-test-"));
  originalConfigDir = process.env.CARTETHYIA_CONFIG_DIR;
  process.env.CARTETHYIA_CONFIG_DIR = configDir;
});

afterEach(() => {
  if (originalConfigDir === undefined) delete process.env.CARTETHYIA_CONFIG_DIR;
  else process.env.CARTETHYIA_CONFIG_DIR = originalConfigDir;
  rmSync(configDir, { recursive: true, force: true });
});

const requestPath = (): string => join(configDir, "tray-request.json");
const statePath = (): string => join(configDir, "tray-state.json");

/** A pid that is certainly gone: a child that has already exited. */
async function deadPid(): Promise<number> {
  const child = Bun.spawn([process.execPath, "-e", ""], { stdout: "ignore", stderr: "ignore" });
  await child.exited;
  return child.pid;
}

test("a request is written with the documented shape and owner-only permissions", () => {
  writeTrayRequest("hide");

  const written = JSON.parse(readFileSync(requestPath(), "utf8")) as Record<string, unknown>;
  expect(written.request).toBe("hide");
  expect(typeof written.nonce).toBe("string");
  expect((written.nonce as string).length).toBeGreaterThan(0);
  expect(Number.isNaN(Date.parse(String(written.requestedAt)))).toBe(false);
  if (process.platform !== "win32") {
    expect(statSync(requestPath()).mode & 0o777).toBe(0o600);
  }
});

test("a request is consumed exactly once and then gone", () => {
  writeTrayRequest("show");

  expect(consumeTrayRequest()?.request).toBe("show");
  expect(existsSync(requestPath())).toBe(false);
  expect(consumeTrayRequest()).toBeNull();
});

test("a newer request replaces an older one rather than queueing behind it", () => {
  writeTrayRequest("hide");
  writeTrayRequest("show");

  expect(consumeTrayRequest()?.request).toBe("show");
  expect(existsSync(requestPath())).toBe(false);
});

test("a corrupt request file is ignored and removed, never thrown on", () => {
  writeFileSync(requestPath(), "{ this is not json", "utf8");

  expect(consumeTrayRequest()).toBeNull();
  expect(existsSync(requestPath())).toBe(false);
});

test("an unknown request value is ignored and removed", () => {
  writeFileSync(requestPath(), JSON.stringify({ request: "explode" }), "utf8");

  expect(consumeTrayRequest()).toBeNull();
  expect(existsSync(requestPath())).toBe(false);
});

test("visibility state round-trips for the live process", () => {
  writeTrayState({ pid: process.pid, hidden: true });

  const state = readTrayState();
  expect(state?.pid).toBe(process.pid);
  expect(state?.hidden).toBe(true);
  expect(Number.isNaN(Date.parse(String(state?.updatedAt)))).toBe(false);
});

test("state left behind by a dead tray reads as no tray and is removed", async () => {
  const pid = await deadPid();
  writeTrayState({ pid, hidden: true });

  expect(readTrayState()).toBeNull();
  expect(existsSync(statePath())).toBe(false);
});

test("a corrupt state file reads as no tray instead of killing the caller", () => {
  writeFileSync(statePath(), "null", "utf8");

  expect(readTrayState()).toBeNull();
});

test("clearing is idempotent for both files", () => {
  writeTrayRequest("toggle");
  writeTrayState({ pid: process.pid, hidden: false });

  clearTrayRequest();
  clearTrayState();
  clearTrayRequest();
  clearTrayState();

  expect(existsSync(requestPath())).toBe(false);
  expect(existsSync(statePath())).toBe(false);
});

test("an unresolved config directory fails with a clear message, not a parse error", () => {
  delete process.env.CARTETHYIA_CONFIG_DIR;

  expect(() => writeTrayRequest("hide")).toThrow("config directory");
  expect(() => readTrayState()).toThrow("config directory");
});

// ---------------------------------------------------------------------------
// The preference: what the icon last showed, kept across restarts
//
// `tray-state.json` answers "is a tray alive" and dies with its process. The
// preference answers "where did the icon end up" and must outlive everything,
// which is why the two are separate files with separate lifetimes.
// ---------------------------------------------------------------------------

const preferencePath = (): string => join(configDir, "tray-preference.json");

test("no preference is recorded until an icon state is written", () => {
  expect(readTrayPreference()).toBeNull();
});

test("writing the icon state also records it as the preference, owner-only", () => {
  writeTrayState({ pid: process.pid, hidden: true });

  const preference = readTrayPreference();
  expect(preference?.hidden).toBe(true);
  expect(Number.isNaN(Date.parse(String(preference?.updatedAt)))).toBe(false);
  if (process.platform !== "win32") {
    expect(statSync(preferencePath()).mode & 0o777).toBe(0o600);
  }
});

test("the preference outlives the state record it was written with", () => {
  writeTrayState({ pid: process.pid, hidden: true });

  clearTrayState();

  expect(existsSync(statePath())).toBe(false);
  expect(readTrayPreference()?.hidden).toBe(true);
});

test("a preference written by a tray that has since exited is still the last icon state", async () => {
  const pid = await deadPid();
  writeTrayState({ pid, hidden: true });

  // Liveness decides the state record, not the preference: a dead pid says the
  // tray is gone, and says nothing about where its icon was left.
  expect(readTrayState()).toBeNull();
  expect(readTrayPreference()?.hidden).toBe(true);
});

test("a corrupt preference reads as nothing recorded instead of throwing", () => {
  writeFileSync(preferencePath(), "{ this is not json", "utf8");

  expect(readTrayPreference()).toBeNull();
});

test("a preference whose hidden flag is not a boolean is not trusted", () => {
  writeFileSync(
    preferencePath(),
    JSON.stringify({ hidden: "yes", updatedAt: new Date().toISOString() }),
    "utf8",
  );

  expect(readTrayPreference()).toBeNull();
});

// ---------------------------------------------------------------------------
// Tray visibility: macOS/Linux helper lifecycle
//
// The helper is faked here rather than spawned: a real `systray2` helper draws
// an icon in the menu bar of whoever runs the suite. The fake mirrors the one
// behaviour the production code depends on — `kill()` reports `exit` before it
// settles, exactly like a real helper going away.
// ---------------------------------------------------------------------------

interface FakeHelper {
  readonly helper: TrayHelper;
  readonly menu: readonly MenuItem[];
  /** Rows the tray asked the helper to update, in order. */
  readonly updates: MenuItem[];
  killCalls: number;
  /** Simulates the helper exiting on its own, e.g. a crash. */
  crash(): void;
  click(row: MenuItem): void;
}

interface UnixHarness {
  readonly factory: UnixHelperFactory;
  readonly created: FakeHelper[];
}

function unixHarness(): UnixHarness {
  const created: FakeHelper[] = [];
  const factory: UnixHelperFactory = (options: UnixHelperOptions) => {
    let exitCode: number | null = null;
    const exitListeners: (() => void)[] = [];
    const clickListeners: ((action: ClickEvent) => void)[] = [];
    const record: FakeHelper = {
      menu: options.items,
      updates: [],
      killCalls: 0,
      crash: () => {
        exitCode = 1;
        for (const listener of exitListeners) listener();
      },
      click: (row) => {
        // The helper reports the clicked row's own number, which is what a
        // click on a row rebuilt by `show()` has to match.
        const id = (row as MenuItem & { __id?: number }).__id ?? 0;
        for (const listener of clickListeners) {
          listener({ type: "clicked", item: row, seq_id: 1, __id: id });
        }
      },
      helper: {
        // Numbering mirrors the helper: rows are numbered from 1 in menu order
        // once it reports ready, which is what `update()` needs to target one.
        ready: async () => {
          record.menu.forEach((item, index) => {
            (item as MenuItem & { __id?: number }).__id = index + 1;
          });
        },
        onClick: async (listener) => {
          clickListeners.push(listener);
        },
        onExit: (listener) => {
          exitListeners.push(listener);
        },
        sendAction: async (action) => {
          if (action.type === "update-item") record.updates.push(action.item);
        },
        kill: async () => {
          record.killCalls += 1;
          exitCode = 0;
          for (const listener of exitListeners) listener();
        },
        get process() {
          return { exitCode, signalCode: null };
        },
      },
    };
    created.push(record);
    return record.helper;
  };
  return { factory, created };
}

const VISIBILITY_ROWS: readonly TrayItem[] = [
  { kind: "action", id: "console", title: "Open Console" },
  { kind: "action", id: "hide", title: "Hide icon" },
  { kind: "action", id: "exit", title: "Exit" },
];

function unixTray(
  harness: UnixHarness,
  options: { readonly startHidden?: boolean } = {},
): { tray: Tray; selected: string[]; exits: () => number } {
  const selected: string[] = [];
  let exitCount = 0;
  const tray = createTray(
    {
      iconPath: "/tmp/cartethyia-test.png",
      tooltip: "Cartethyia test",
      items: VISIBILITY_ROWS,
      startHidden: options.startHidden,
      onSelect: (id) => selected.push(id),
      onExit: () => {
        exitCount += 1;
      },
    },
    { createUnixHelper: harness.factory, platform: "linux" },
  );
  return { tray, selected, exits: () => exitCount };
}

test("hide removes the icon without reporting a crashed helper", async () => {
  const harness = unixHarness();
  const { tray, exits } = unixTray(harness);
  await tray.ready();

  expect(tray.isVisible()).toBe(true);
  await tray.hide();

  expect(tray.isVisible()).toBe(false);
  expect(harness.created[0]?.killCalls).toBe(1);
  // The helper's exit during a hide is the hide itself, not a crash: reporting
  // it would close the gateway, which is the one thing hiding must not do.
  expect(exits()).toBe(0);
});

test("a helper that exits on its own is still reported as gone", async () => {
  const harness = unixHarness();
  const { tray, exits } = unixTray(harness);
  await tray.ready();

  harness.created[0]?.crash();

  expect(exits()).toBe(1);
});

test("show starts a new helper and the same rows still resolve to their ids", async () => {
  const harness = unixHarness();
  const { tray, selected } = unixTray(harness);
  await tray.ready();
  await tray.hide();
  await tray.show();

  expect(harness.created).toHaveLength(2);
  expect(tray.isVisible()).toBe(true);
  const hiddenRow = harness.created[1]?.menu[1];
  expect(hiddenRow?.title).toBe("Hide icon");
  harness.created[1]?.click(hiddenRow!);
  expect(selected).toEqual(["hide"]);
});

test("hiding twice kills one helper and showing twice starts one more", async () => {
  const harness = unixHarness();
  const { tray } = unixTray(harness);
  await tray.ready();

  await tray.hide();
  await tray.hide();
  expect(harness.created[0]?.killCalls).toBe(1);

  await tray.show();
  await tray.show();
  expect(harness.created).toHaveLength(2);
});

test("rows updated after a show target the new helper's numbering", async () => {
  const harness = unixHarness();
  const { tray } = unixTray(harness);
  await tray.ready();
  await tray.hide();
  await tray.show();

  tray.update("hide", "Hide icon \u00b7 again");

  expect(harness.created[1]?.updates.map((item) => item.title)).toEqual(["Hide icon \u00b7 again"]);
});

test("a tray told to start hidden draws no icon until one is asked for", async () => {
  const harness = unixHarness();
  const { tray } = unixTray(harness, { startHidden: true });
  await tray.ready();

  // No helper at all: the icon is a helper process on these platforms, so
  // "hidden at start" means never starting one rather than starting and hiding.
  expect(harness.created).toHaveLength(0);
  expect(tray.isVisible()).toBe(false);

  await tray.show();

  expect(harness.created).toHaveLength(1);
  expect(tray.isVisible()).toBe(true);
  expect(harness.created[0]?.menu[1]?.title).toBe("Hide icon");
});

test("updating a row while the icon is hidden at start is a no-op, not a crash", async () => {
  const harness = unixHarness();
  const { tray } = unixTray(harness, { startHidden: true });
  await tray.ready();

  tray.update("hide", "Hide icon \u00b7 again");
  tray.setTooltip("Cartethyia test");

  expect(harness.created).toHaveLength(0);
});

test("closing a tray that started hidden and never showed ends without a helper", async () => {
  const harness = unixHarness();
  const { tray } = unixTray(harness, { startHidden: true });
  await tray.ready();

  await tray.close();

  expect(harness.created).toHaveLength(0);
});

test("a click still resolves the right id after two hide/show cycles", async () => {
  const harness = unixHarness();
  const { tray, selected } = unixTray(harness);
  await tray.ready();

  await tray.hide();
  await tray.show();
  await tray.hide();
  await tray.show();

  expect(harness.created).toHaveLength(3);
  harness.created[2]?.click(harness.created[2]?.menu[2]!);
  expect(selected).toEqual(["exit"]);
});

test("closing while hidden does not kill a second time and stays invisible", async () => {
  const harness = unixHarness();
  const { tray } = unixTray(harness);
  await tray.ready();

  await tray.hide();
  await tray.close();

  expect(harness.created[0]?.killCalls).toBe(1);
  expect(tray.isVisible()).toBe(false);
});

// ---------------------------------------------------------------------------
// Applying a request, and the CLI command that asks for one
// ---------------------------------------------------------------------------

test("a hide request ends with the icon hidden and the gateway untouched", async () => {
  const harness = unixHarness();
  const { tray, exits } = unixTray(harness);
  await tray.ready();

  expect(await applyTrayVisibility(tray, "hide")).toBe(true);
  expect(tray.isVisible()).toBe(false);
  expect(exits()).toBe(0);
});

test("toggle flips the current visibility in both directions", async () => {
  const harness = unixHarness();
  const { tray } = unixTray(harness);
  await tray.ready();

  expect(await applyTrayVisibility(tray, "toggle")).toBe(true);
  expect(await applyTrayVisibility(tray, "toggle")).toBe(false);
  expect(tray.isVisible()).toBe(true);
});

test("a request with no tray running fails instead of queueing", async () => {
  await expect(requestTrayVisibility("hide")).rejects.toThrow("No Cartethyia tray is running");
});

/**
 * Answers the pending request the way the tray does: read the nonce, act, write
 * the state that quotes it back.
 */
function answerPendingRequest(hidden: boolean): void {
  const request = JSON.parse(readFileSync(requestPath(), "utf8")) as { nonce: string };
  writeTrayState({ pid: process.pid, hidden, nonce: request.nonce });
}

test("hide waits for the tray to record the change", async () => {
  writeTrayState({ pid: process.pid, hidden: false });

  const state = await requestTrayVisibility("hide", {
    // The tray answers on the first poll, like the 1 s loop does in practice.
    sleep: async () => answerPendingRequest(true),
  });

  expect(state.hidden).toBe(true);
});

test("show waits for the tray to record the change", async () => {
  writeTrayState({ pid: process.pid, hidden: true });

  const state = await requestTrayVisibility("show", {
    sleep: async () => answerPendingRequest(false),
  });

  expect(state.hidden).toBe(false);
});

test("toggle waits for the tray to answer this request, not just any state", async () => {
  writeTrayState({ pid: process.pid, hidden: false });

  const state = await requestTrayVisibility("toggle", {
    sleep: async () => {
      // A state written without the request's nonce is the tray's own earlier
      // record, not an answer: acting on it would report success for a request
      // the tray may never have read.
      writeTrayState({ pid: process.pid, hidden: true });
      answerPendingRequest(true);
    },
  });

  expect(state.hidden).toBe(true);
});

test("a tray that never answers fails and leaves no request behind", async () => {
  writeTrayState({ pid: process.pid, hidden: false });

  await expect(requestTrayVisibility("hide", { timeoutMs: 0 })).rejects.toThrow("did not");
  // A request left in the directory would act on the tray minutes later, long
  // after the operator saw the failure.
  expect(existsSync(requestPath())).toBe(false);
});

test("answering a request records the nonce the asker is waiting for", async () => {
  const harness = unixHarness();
  const { tray } = unixTray(harness);
  await tray.ready();
  const request = writeTrayRequest("hide");

  const hidden = await respondToTrayRequest(tray, request);

  expect(hidden).toBe(true);
  // Without the nonce the CLI cannot tell this record from the state that was
  // already there, and reports a failure for a change that did happen.
  expect(readTrayState()?.nonce).toBe(request.nonce);
  expect(readTrayState()?.hidden).toBe(true);
});

test("answering a request the tray could not apply leaves the old state alone", async () => {
  writeTrayState({ pid: process.pid, hidden: false });
  const harness = unixHarness();
  const { tray } = unixTray(harness);
  await tray.ready();
  const request = writeTrayRequest("hide");
  // A helper that refuses to die must not be reported as hidden.
  harness.created[0]!.helper.kill = async () => {
    throw new Error("helper refused to exit");
  };

  await expect(respondToTrayRequest(tray, request)).rejects.toThrow("refused");
  expect(readTrayState()?.hidden).toBe(false);
  expect(readTrayState()?.nonce).toBeUndefined();
});

// ---------------------------------------------------------------------------
// `carte tray status` with no live tray
//
// The icon can now be hidden across restarts, so "no tray is running" alone
// would leave the operator staring at a menu bar with no icon and no reason.
// ---------------------------------------------------------------------------

/** Runs a command and returns what it printed, without touching the real console. */
async function capturedOutput(run: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const spy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
  try {
    await run();
  } finally {
    spy.mockRestore();
  }
  return lines.join("\n");
}

test("status names the last icon state when no tray is running", async () => {
  // Exactly what a tray that exited leaves behind: the state record is gone,
  // the recorded choice is not.
  writeTrayState({ pid: process.pid, hidden: true });
  clearTrayState();
  const recorded = readTrayPreference()!;

  const output = await capturedOutput(() => runTrayCommand("status"));

  expect(output).toContain("No Cartethyia tray is running.");
  expect(output).toContain("Last icon state: hidden");
  expect(output).toContain(recorded.updatedAt);
});

test("status keeps its old line when nothing was ever recorded", async () => {
  const output = await capturedOutput(() => runTrayCommand("status"));

  expect(output).toBe("No Cartethyia tray is running.");
});

// ---------------------------------------------------------------------------
// Shutdown: the pause a closing tray stops waiting on
//
// The two poll loops are the only thing holding this process open while the
// icon is hidden. A plain sleep also keeps it open after it stopped being
// useful, which is how a tray that had already deleted its state record went on
// reading as a live icon for up to one poll interval.
// ---------------------------------------------------------------------------

test("a pause that is never interrupted resolves on its own", async () => {
  const gate = createShutdownPause();
  const startedAt = Date.now();

  await gate.pause(20);

  expect(Date.now() - startedAt).toBeGreaterThanOrEqual(15);
});

test("interrupting a pause releases it at once instead of waiting out the interval", async () => {
  const gate = createShutdownPause();
  const startedAt = Date.now();
  const paused = gate.pause(30_000);

  gate.interrupt();
  await paused;

  expect(Date.now() - startedAt).toBeLessThan(1_000);
});

test("a pause taken after the interrupt does not wait at all", async () => {
  const gate = createShutdownPause();
  gate.interrupt();
  const startedAt = Date.now();

  await gate.pause(30_000);

  expect(Date.now() - startedAt).toBeLessThan(1_000);
});

// ---------------------------------------------------------------------------
// `carte --tray` when a tray already runs
// ---------------------------------------------------------------------------

/** Writes the controller record a running tray or menu leaves behind. */
function writeControllerRecord(kind: "menu" | "tray", pid: number): void {
  writeFileSync(
    join(configDir, "controller.json"),
    JSON.stringify({
      pid,
      parentPid: pid,
      token: "test-token",
      kind,
      startedAt: new Date().toISOString(),
    }),
    "utf8",
  );
}

test("a second carte --tray shows the icon of the tray that already runs", async () => {
  writeControllerRecord("tray", process.pid);
  writeTrayState({ pid: process.pid, hidden: true });

  const shown = await showIconOnExistingTray({
    sleep: async () => answerPendingRequest(false),
  });

  expect(shown).toBe(true);
  expect(readTrayState()?.hidden).toBe(false);
});

test("a tray that is already visible is reported as shown, not restarted", async () => {
  writeControllerRecord("tray", process.pid);
  writeTrayState({ pid: process.pid, hidden: false });

  const shown = await showIconOnExistingTray({
    sleep: async () => answerPendingRequest(false),
  });

  expect(shown).toBe(true);
});

test("a menu owning the controller is left to the normal start path", async () => {
  writeControllerRecord("menu", process.pid);
  writeTrayState({ pid: process.pid, hidden: false });

  expect(await showIconOnExistingTray()).toBe(false);
  expect(existsSync(requestPath())).toBe(false);
});

test("no controller at all is left to the normal start path", async () => {
  expect(await showIconOnExistingTray()).toBe(false);
});

test("a stale controller record does not count as a running tray", async () => {
  writeControllerRecord("tray", await deadPid());

  expect(await showIconOnExistingTray()).toBe(false);
});

test("a tray that is still shutting down is not asked for its icon", async () => {
  // The lease outlives the state record for the last moments of a shutdown, so
  // this pair is exactly what a `carte --tray` typed into that window sees. It
  // used to be answered with "no tray is running; start one", which is the
  // command the operator had just run.
  writeControllerRecord("tray", process.pid);

  await expect(showIconOnExistingTray()).rejects.toThrow("still shutting down");
  // Nothing may be left behind for a tray that will never read it.
  expect(existsSync(requestPath())).toBe(false);
});

// ---------------------------------------------------------------------------
// Windows helper protocol
//
// The PowerShell helper is faked: this machine has no powershell.exe, and the
// contract being tested is the JSON lines the two sides exchange.
// ---------------------------------------------------------------------------

interface FakeWindowsHelper {
  readonly process: ChildProcess;
  readonly sent: Record<string, unknown>[];
  /** Emits one JSON line, as the helper would. */
  emit(event: Record<string, unknown>): void;
}

function windowsHarness(): {
  spawn: WindowsHelperFactory;
  created: FakeWindowsHelper[];
  spawned: { readonly startHidden: boolean }[];
} {
  const created: FakeWindowsHelper[] = [];
  const spawned: { readonly startHidden: boolean }[] = [];
  const spawn: WindowsHelperFactory = (options) => {
    spawned.push({ startHidden: options.startHidden });
    const stdout = new PassThrough();
    const stdinChunks: string[] = [];
    const stdin = new PassThrough();
    stdin.on("data", (chunk: Buffer) => stdinChunks.push(chunk.toString("utf8")));
    const listeners = new Map<string, ((...args: unknown[]) => void)[]>();
    const record: FakeWindowsHelper = {
      sent: [],
      emit: (event) => stdout.write(`${JSON.stringify(event)}\n`),
      process: {
        stdout,
        stdin,
        once: (name: string, listener: (...args: unknown[]) => void) => {
          listeners.set(name, [...(listeners.get(name) ?? []), listener]);
          return record.process;
        },
        kill: () => true,
      } as unknown as ChildProcess,
    };
    // Every complete line the tray writes is parsed back so tests can assert on
    // actions. A chunk can end mid-line, so only newline-terminated lines count.
    stdin.on("data", () => {
      const lines = stdinChunks.join("").split("\n");
      stdinChunks.length = 0;
      stdinChunks.push(lines.pop() ?? "");
      record.sent.length = 0;
      for (const line of lines) {
        if (line.trim() === "") continue;
        record.sent.push(JSON.parse(line) as Record<string, unknown>);
      }
    });
    created.push(record);
    return record.process;
  };
  return { spawn, created, spawned };
}

async function windowsTray(
  harness: ReturnType<typeof windowsHarness>,
  options: { readonly startHidden?: boolean } = {},
): Promise<{
  tray: Tray;
  exits: () => number;
  selected: string[];
}> {
  const selected: string[] = [];
  let exitCount = 0;
  const tray = createTray(
    {
      iconPath: "C:\\cartethyia.ico",
      tooltip: "Cartethyia test",
      items: VISIBILITY_ROWS,
      startHidden: options.startHidden,
      onSelect: (id) => selected.push(id),
      onExit: () => {
        exitCount += 1;
      },
    },
    { spawnWindowsHelper: harness.spawn, platform: "win32" },
  );
  const helper = harness.created[0]!;
  // The helper reports "started" and then "ready" once its icon exists.
  helper.emit({ type: "started" });
  helper.emit({ type: "ready" });
  await tray.ready();
  return { tray, exits: () => exitCount, selected };
}

test("windows hide sends the hide action and waits for the hidden ack", async () => {
  const harness = windowsHarness();
  const { tray } = await windowsTray(harness);

  const hidden = tray.hide();
  expect(harness.created[0]?.sent.at(-1)).toEqual({ action: "hide" });
  expect(tray.isVisible()).toBe(true);

  harness.created[0]?.emit({ type: "hidden" });
  await hidden;

  expect(tray.isVisible()).toBe(false);
});

test("windows show sends the show action and waits for the shown ack", async () => {
  const harness = windowsHarness();
  const { tray } = await windowsTray(harness);
  const hidden = tray.hide();
  harness.created[0]?.emit({ type: "hidden" });
  await hidden;

  const shown = tray.show();
  expect(harness.created[0]?.sent.at(-1)).toEqual({ action: "show" });
  harness.created[0]?.emit({ type: "shown" });
  await shown;

  expect(tray.isVisible()).toBe(true);
});

test("windows hide fails when the helper never acknowledges", async () => {
  const harness = windowsHarness();
  const { tray } = await windowsTray(harness);

  await expect(tray.hide()).rejects.toThrow('did not confirm "hidden"');
  // A failed change must not leave the tray claiming the icon is gone.
  expect(tray.isVisible()).toBe(true);
});

test("windows hide and show are no-ops when the icon is already in that state", async () => {
  const harness = windowsHarness();
  const { tray } = await windowsTray(harness);

  await tray.show();
  expect(harness.created[0]?.sent.some((command) => command.action === "show")).toBe(false);
});

test("windows kill still disposes the icon", async () => {
  const harness = windowsHarness();
  const { tray } = await windowsTray(harness);

  const closed = tray.close();
  expect(harness.created[0]?.sent.at(-1)).toEqual({ action: "kill" });
  harness.created[0]?.emit({ type: "exited" });
  (harness.created[0]!.process as unknown as { emit?: (name: string) => void }).emit?.("exit");
  await closed;
});

test("the windows script understands hide and show and answers with an ack", () => {
  const script = readFileSync(join(import.meta.dir, "../../scripts/cli/tray/windows.ps1"), "utf8");

  expect(script).toContain('"hide"');
  expect(script).toContain('"show"');
  expect(script).toContain('type = "hidden"');
  expect(script).toContain('type = "shown"');
  // Hiding must not dispose the icon: the helper keeps running so show works.
  // The action handlers, not the protocol comment block at the top.
  const hideBlock = script.slice(script.indexOf('"hide"        {'), script.indexOf('"show"        {'));
  expect(hideBlock).toContain("$script:notifyIcon.Visible = $false");
  expect(hideBlock).not.toContain("Dispose");
});

// ---------------------------------------------------------------------------
// Windows: starting hidden
//
// The helper keeps running either way — it owns the message loop — so the only
// difference is whether the NotifyIcon is ever made visible. Creating it hidden
// is what keeps a rebooted machine from flashing an icon it was told to hide.
// ---------------------------------------------------------------------------

test("windows asks the helper for a hidden icon when starting hidden", async () => {
  const harness = windowsHarness();
  const { tray } = await windowsTray(harness, { startHidden: true });

  expect(harness.spawned[0]?.startHidden).toBe(true);
  expect(tray.isVisible()).toBe(false);
});

test("windows still starts visible when nothing was recorded", async () => {
  const harness = windowsHarness();
  const { tray } = await windowsTray(harness);

  expect(harness.spawned[0]?.startHidden).toBe(false);
  expect(tray.isVisible()).toBe(true);
});

test("windows show after a hidden start sends the show action and waits for its ack", async () => {
  const harness = windowsHarness();
  const { tray } = await windowsTray(harness, { startHidden: true });

  const shown = tray.show();
  expect(harness.created[0]?.sent.at(-1)).toEqual({ action: "show" });
  // Not visible until the helper says the icon is on screen.
  expect(tray.isVisible()).toBe(false);

  harness.created[0]?.emit({ type: "shown" });
  await shown;

  expect(tray.isVisible()).toBe(true);
});

test("the windows script creates its icon hidden when asked, and visible otherwise", () => {
  const script = readFileSync(join(import.meta.dir, "../../scripts/cli/tray/windows.ps1"), "utf8");

  expect(script).toContain("[switch]$StartHidden");
  expect(script).toContain("$script:notifyIcon.Visible = -not $StartHidden");
});
