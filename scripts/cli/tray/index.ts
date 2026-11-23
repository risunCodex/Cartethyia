import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import SysTray, { type ClickEvent, type MenuItem } from "systray2";
import { resolvePackagePath } from "../../../src/config/package-paths";

/**
 * A row as systray2 holds it. The helper numbers the rows itself and reports
 * that number back on a click and on an update, but it is absent from the
 * package's typings.
 */
type IdentifiedItem = MenuItem & { readonly __id?: number };

/**
 * One tray row. `action` rows report their id on click; separators are drawn
 * but never fire.
 */
export type TrayItem =
  | { readonly kind: "action"; readonly id: string; readonly title: string; readonly enabled?: boolean }
  | { readonly kind: "separator" };

export interface TrayOptions {
  readonly iconPath: string;
  readonly tooltip: string;
  readonly items: readonly TrayItem[];
  readonly onSelect: (id: string) => void;
  readonly onExit: () => void;
}

export interface Tray {
  /** Resolves once the icon is on screen and clicks can arrive. */
  ready(): Promise<void>;
  /** Replaces the title and enabled state of an existing row. */
  update(id: string, title: string, enabled?: boolean): void;
  setTooltip(text: string): void;
  /**
   * Removes the icon. The process, the menu model and the gateway stay alive;
   * `show()` puts the same rows back.
   */
  hide(): Promise<void>;
  /** Restores an icon removed by `hide()`. No-op when already visible. */
  show(): Promise<void>;
  /** Whether the icon is on screen. Local state: neither helper reports it. */
  isVisible(): boolean;
  /** Removes the icon and ends the helper. Idempotent. */
  close(): Promise<void>;
}

/** The slice of the helper's process this module reads. */
export interface TrayHelperProcess {
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
}

/**
 * The slice of `systray2` this module depends on.
 *
 * Narrowed to what is actually called so a test can drive a fake helper: a real
 * one draws an icon in the menu bar of whoever runs the suite.
 */
export interface TrayHelper {
  ready(): Promise<void>;
  onClick(listener: (action: ClickEvent) => void): Promise<unknown>;
  onExit(listener: () => void): void;
  sendAction(action: { readonly type: "update-item"; readonly item: MenuItem }): Promise<unknown>;
  kill(exitNode?: boolean): Promise<void>;
  readonly process: TrayHelperProcess;
}

export interface UnixHelperOptions {
  readonly iconPath: string;
  readonly tooltip: string;
  readonly items: readonly MenuItem[];
}

/** Builds a macOS/Linux helper. Injected so tests never spawn the real one. */
export type UnixHelperFactory = (options: UnixHelperOptions) => TrayHelper;

/** Starts the Windows helper. Injected so tests never spawn PowerShell. */
export type WindowsHelperFactory = (options: { readonly iconPath: string; readonly tooltip: string }) => ChildProcess;

export interface TrayDependencies {
  /** Builds the macOS/Linux helper. Defaults to a real `systray2` instance. */
  readonly createUnixHelper?: UnixHelperFactory;
  /** Starts the Windows helper. Defaults to spawning `powershell.exe`. */
  readonly spawnWindowsHelper?: WindowsHelperFactory;
  /** Which tray to build. Defaults to the running platform. */
  readonly platform?: NodeJS.Platform;
}

/**
 * How long a Windows helper has to confirm a visibility change.
 *
 * The helper polls its own stdin every 100 ms and answers immediately, so this
 * is far longer than a healthy round trip. It exists so a helper that stopped
 * listening fails the command instead of leaving the CLI waiting forever.
 */
const WINDOWS_ACK_TIMEOUT_MS = 2_000;

/**
 * Windows tray: a PowerShell NotifyIcon driven over JSON lines.
 *
 * `systray2` on Windows leaves the spawning process attached to a console, so
 * Windows Terminal keeps an empty tab open for the tray's whole lifetime — the
 * window cannot be hidden from inside the process because it is owned by the
 * terminal, and `MainWindowHandle` reads 0 so it cannot be found and closed
 * either. A PowerShell NotifyIcon started with `-WindowStyle Hidden` owns no
 * console at all, which is the only arrangement that shows an icon and no
 * window.
 */
class WindowsTray implements Tray {
  readonly #process: ChildProcess;
  readonly #onSelect: (id: string) => void;
  readonly #onExit: () => void;
  readonly #index = new Map<string, number>();
  /** Acks a visibility change is waiting for, keyed by the event that settles it. */
  readonly #acks = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();
  #ready: Promise<void>;
  #closed = false;
  #visible = true;

  constructor(options: TrayOptions, spawnHelper: WindowsHelperFactory) {
    this.#onSelect = options.onSelect;
    this.#onExit = options.onExit;

    this.#process = spawnHelper({ iconPath: options.iconPath, tooltip: options.tooltip });

    const { promise, resolve, reject } = Promise.withResolvers<void>();
    this.#ready = promise;

    const lines = createInterface({ input: this.#process.stdout! });
    lines.on("line", (line) => {
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      if (event === null || typeof event !== "object" || !("type" in event)) return;
      if (event.type === "ready") {
        resolve();
        return;
      }
      if (event.type === "hidden" || event.type === "shown") {
        const ack = this.#acks.get(event.type);
        this.#acks.delete(event.type);
        ack?.resolve();
        return;
      }
      if (event.type === "click" && "index" in event && typeof event.index === "number") {
        for (const [id, index] of this.#index) {
          if (index === event.index) {
            this.#onSelect(id);
            return;
          }
        }
      }
    });

    this.#process.once("error", reject);
    this.#process.once("exit", () => {
      // A helper that goes away can never confirm a pending change, so the
      // command waiting on it has to be told rather than left hanging.
      this.#rejectAcks(new Error("the tray helper exited before confirming the change"));
      if (!this.#closed) this.#onExit();
      reject(new Error("the tray process exited before it was ready"));
    });

    // Rows are added after "started": the script creates its NotifyIcon first
    // and would drop commands that arrive before it is listening.
    let index = 0;
    for (const item of options.items) {
      if (item.kind === "separator") {
        this.#send({ action: "add-separator", index });
        index += 1;
        continue;
      }
      this.#index.set(item.id, index);
      this.#send({ action: "add-item", index, title: item.title, enabled: item.enabled ?? true });
      index += 1;
    }
    this.#send({ action: "ready" });
  }

  #send(command: Record<string, unknown>): void {
    if (this.#closed || !this.#process.stdin?.writable) return;
    this.#process.stdin.write(`${JSON.stringify(command)}\n`, "utf8");
  }

  #rejectAcks(error: Error): void {
    for (const ack of this.#acks.values()) ack.reject(error);
    this.#acks.clear();
  }

  /**
   * Waits for the helper to confirm one visibility change.
   *
   * Registered before the command is sent, so a fast helper cannot answer
   * before anything is listening for the answer.
   */
  #awaitAck(type: "hidden" | "shown"): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#acks.delete(type);
        reject(new Error(`the tray helper did not confirm "${type}" within ${WINDOWS_ACK_TIMEOUT_MS} ms`));
      }, WINDOWS_ACK_TIMEOUT_MS);
      this.#acks.set(type, {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });
  }

  ready(): Promise<void> {
    return this.#ready;
  }

  update(id: string, title: string, enabled = true): void {
    const index = this.#index.get(id);
    if (index === undefined) return;
    this.#send({ action: "update-item", index, title, enabled });
  }

  setTooltip(text: string): void {
    this.#send({ action: "set-tooltip", text });
  }

  async hide(): Promise<void> {
    if (!this.#visible || this.#closed) return;
    const ack = this.#awaitAck("hidden");
    this.#send({ action: "hide" });
    await ack;
    this.#visible = false;
  }

  async show(): Promise<void> {
    if (this.#visible || this.#closed) return;
    const ack = this.#awaitAck("shown");
    this.#send({ action: "show" });
    await ack;
    this.#visible = true;
  }

  isVisible(): boolean {
    return this.#visible;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#visible = false;
    this.#rejectAcks(new Error("the tray is closing"));
    // Sent before `#closed` is set: `#send` refuses once the tray is closing,
    // so setting the flag first meant the helper was never told to exit and
    // only the timeout below removed it. It then disposed its icon on a kill
    // instead of on its own terms.
    this.#send({ action: "kill" });
    this.#closed = true;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.#process.kill();
        resolve();
      }, 1_500);
      this.#process.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

/**
 * macOS and Linux tray: `systray2` runs its own helper, and neither platform
 * attaches a console window to it, so the bundled tray is used as-is.
 *
 * Clicks arrive only through `onClick`; a menu built without a listener shows
 * every row and reports none of them, which is why the callbacks are wired
 * here rather than left to the default.
 *
 * `systray2` has no visibility control, so hiding ends the helper and showing
 * starts a new one. The gateway is a separate, detached process: neither
 * direction touches it.
 */
class UnixTray implements Tray {
  readonly #options: TrayOptions;
  readonly #createHelper: UnixHelperFactory;
  readonly #onSelect: (id: string) => void;
  readonly #onExit: () => void;
  #helper: TrayHelper;
  /** Row objects kept by reference: a click hands back the object, not the id. */
  #items: Map<string, IdentifiedItem>;
  #ready: Promise<void>;
  #closed = false;
  #visible = true;
  /**
   * Set while a hide is ending the helper.
   *
   * The helper's `exit` event is how a crash is detected, so it is reported as
   * a tray failure — which closes the gateway. A hide ends the same process on
   * purpose, and without this flag hiding would look like a crash and stop the
   * very gateway the operator asked to keep running.
   */
  #hiding = false;

  constructor(options: TrayOptions, createHelper: UnixHelperFactory) {
    this.#options = options;
    this.#createHelper = createHelper;
    this.#onSelect = options.onSelect;
    this.#onExit = options.onExit;
    const started = this.#build();
    this.#helper = started.helper;
    this.#items = started.items;
    this.#ready = this.#attach(started.helper);
  }

  /**
   * Starts one helper and the rows that belong to it.
   *
   * Rows are rebuilt rather than reused because the helper numbers them on
   * `ready()`: a fresh helper gives every row a new number, and an update sent
   * with the old one would rewrite the wrong row.
   */
  #build(): { helper: TrayHelper; items: Map<string, IdentifiedItem> } {
    const items = new Map<string, IdentifiedItem>();
    const menu: MenuItem[] = [];
    for (const item of this.#options.items) {
      if (item.kind === "separator") {
        menu.push(SysTray.separator);
        continue;
      }
      const menuItem: IdentifiedItem = {
        title: item.title,
        tooltip: item.title,
        enabled: item.enabled ?? true,
      };
      items.set(item.id, menuItem);
      menu.push(menuItem);
    }
    const helper = this.#createHelper({
      iconPath: this.#options.iconPath,
      tooltip: this.#options.tooltip,
      items: menu,
    });
    return { helper, items };
  }

  /** Waits for a helper to be on screen, then wires its events. */
  async #attach(helper: TrayHelper): Promise<void> {
    await helper.ready();
    // Registered after `ready()`: the helper process does not exist before
    // that, and `onExit` attaches to it directly.
    helper.onExit(() => {
      if (this.#closed || this.#hiding) return;
      this.#onExit();
    });
    await helper.onClick((action) => {
      // The live map, not the one this helper started with: after a show the
      // rows belong to a newer helper, and a click must still resolve by id.
      for (const [id, item] of this.#items) {
        // Identity first: `onClick` merges the clicked row into the object this
        // class built, so a match needs no assumptions about the numbering.
        if (item === action.item || item.__id === action.__id) {
          this.#onSelect(id);
          return;
        }
      }
    });
  }

  ready(): Promise<void> {
    return this.#ready;
  }

  update(id: string, title: string, enabled = true): void {
    const item = this.#items.get(id);
    // An update sent before the helper reports ready carries no row number, and
    // systray2 then rewrites the first row instead of this one.
    if (item?.__id === undefined) return;
    const next: IdentifiedItem = { title, tooltip: title, enabled, __id: item.__id };
    void this.#helper.sendAction({ type: "update-item", item: next });
  }

  setTooltip(text: string): void {
    // systray2 has no tooltip-only action; the tooltip travels with the title,
    // which `update()` already sends.
    void text;
  }

  async hide(): Promise<void> {
    if (!this.#visible || this.#closed) return;
    this.#hiding = true;
    try {
      await this.#end(this.#helper);
    } finally {
      // Only this awaited kill is a hide. A helper that dies later is a crash
      // and must still be reported.
      this.#hiding = false;
    }
    this.#visible = false;
  }

  async show(): Promise<void> {
    if (this.#visible || this.#closed) return;
    const started = this.#build();
    // Committed only after the new helper is on screen: a helper that fails to
    // start must leave the tray reporting itself hidden, not visible.
    await this.#attach(started.helper);
    this.#helper = started.helper;
    this.#items = started.items;
    this.#visible = true;
  }

  isVisible(): boolean {
    return this.#visible;
  }

  /**
   * Ends one helper, treating "already gone" as done.
   *
   * A failure to end it is reported, not swallowed: `hide()` must not claim the
   * icon is gone while the helper that draws it is still running. `close()`
   * tolerates the same error, because shutdown has nothing left to prove.
   */
  async #end(helper: TrayHelper): Promise<void> {
    const helperProcess = helper.process;
    // `kill()` settles on the helper's `exit` event, so a helper that already
    // exited would leave it pending forever and hang the shutdown after it.
    if (helperProcess.exitCode !== null || helperProcess.signalCode !== null) return;
    // `false`: systray2 otherwise calls `process.exit(0)` when the helper
    // exits, which discards the exit code this close was given.
    await helper.kill(false);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#visible = false;
    try {
      await this.#end(this.#helper);
    } catch {
      // The helper may already be gone; this process is exiting either way.
    }
  }
}

/** Starts a real `systray2` helper. */
function startSystray(options: UnixHelperOptions): TrayHelper {
  return new SysTray({
    menu: {
      icon: options.iconPath,
      title: "Cartethyia",
      tooltip: options.tooltip,
      items: [...options.items],
    },
    copyDir: true,
  });
}

/**
 * Starts the Windows helper with no console of its own.
 *
 * `-WindowStyle Hidden` plus `windowsHide` is what keeps Windows Terminal from
 * keeping an empty tab open for the tray's whole lifetime.
 */
function startWindowsHelper(options: { readonly iconPath: string; readonly tooltip: string }): ChildProcess {
  return spawn(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-WindowStyle",
      "Hidden",
      "-InputFormat",
      "Text",
      "-OutputFormat",
      "Text",
      "-File",
      resolvePackagePath("scripts", "cli", "tray", "windows.ps1"),
      "-IconPath",
      options.iconPath,
      "-Tooltip",
      options.tooltip,
    ],
    { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
  );
}

/** Creates the tray for this platform. */
export function createTray(options: TrayOptions, dependencies: TrayDependencies = {}): Tray {
  const platform = dependencies.platform ?? process.platform;
  if (platform === "win32") {
    return new WindowsTray(options, dependencies.spawnWindowsHelper ?? startWindowsHelper);
  }
  return new UnixTray(options, dependencies.createUnixHelper ?? startSystray);
}
