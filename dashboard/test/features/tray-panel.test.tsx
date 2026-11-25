/**
 * Contract tests for the Settings → Tray panel.
 *
 * The panel is the dashboard's half of a feature whose other half is a menu bar
 * item that stops existing the moment it hides. So the properties worth pinning
 * are the ones that keep the operator from losing the icon:
 *
 * - the state the tray reports decides which button is live, and a missing tray
 *   offers neither;
 * - only the action the route accepts is ever sent;
 * - a refusal from a browser that is not on the gateway's machine is explained
 *   on screen, not left as a failed click with no reason;
 * - a confirmed change toasts, because the route only answers after the tray
 *   said it acted.
 */
import { afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { createElement } from "react";
import { TrayPanel } from "../../src/features/settings/TrayPanel";
import { toast } from "../../src/lib/toast";
import { mount, stubFetch, type Mounted } from "../helpers/render";
import { registerDom } from "../helpers/dom";

beforeAll(() => {
  registerDom();
  const source = globalThis.window as unknown as Record<string, unknown>;
  const target = globalThis as unknown as Record<string, unknown>;
  for (const [name, value] of Object.entries(source)) {
    if (target[name] !== undefined) continue;
    try {
      Object.defineProperty(target, name, { value, writable: true, configurable: true });
    } catch {
      // Not aliasing this one is fine.
    }
  }
});

const RUNNING_VISIBLE = { running: true, hidden: false, pid: 4242, lastHidden: false, lastChangedAt: null };
const RUNNING_HIDDEN = { running: true, hidden: true, pid: 4242, lastHidden: true, lastChangedAt: null };
const NOT_RUNNING = { running: false, hidden: false, pid: null, lastHidden: null, lastChangedAt: null };
/** A tray that exited after the operator hid its icon. */
const STOPPED_AFTER_HIDING = {
  running: false,
  hidden: false,
  pid: null,
  lastHidden: true,
  lastChangedAt: "2026-11-20T09:00:00.000Z",
};

let mounted: Mounted | undefined;
let restore: (() => void) | undefined;

afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
  restore?.();
  restore = undefined;
});

async function mountPanel(routes: Parameters<typeof stubFetch>[0]) {
  const stub = stubFetch(routes);
  restore = stub.restore;
  mounted = await mount(createElement(TrayPanel));
  await mounted.flush();
  return { panel: mounted, calls: stub.calls };
}

/** The two action buttons, by the label the operator reads. */
function button(panel: Mounted, label: string): HTMLButtonElement | null {
  return (
    panel.findAll("button").find((element) => element.textContent?.trim() === label) as
      | HTMLButtonElement
      | null
  );
}

describe("Tray panel", () => {
  test("a running, visible tray offers Hide and disables Show", async () => {
    const { panel } = await mountPanel([
      { match: "GET /console/api/tray/status", json: RUNNING_VISIBLE },
    ]);

    expect(panel.text()).toContain("icon visible");
    expect(button(panel, "Hide icon")?.disabled).toBe(false);
    expect(button(panel, "Show icon")?.disabled).toBe(true);
  });

  test("a hidden icon offers Show and disables Hide", async () => {
    const { panel } = await mountPanel([
      { match: "GET /console/api/tray/status", json: RUNNING_HIDDEN },
    ]);

    expect(panel.text()).toContain("icon hidden");
    expect(button(panel, "Hide icon")?.disabled).toBe(true);
    expect(button(panel, "Show icon")?.disabled).toBe(false);
  });

  test("no running tray disables both buttons and names how to start one", async () => {
    const { panel } = await mountPanel([
      { match: "GET /console/api/tray/status", json: NOT_RUNNING },
    ]);

    expect(panel.text()).toContain("No tray is running");
    expect(panel.text()).toContain("carte tray");
    expect(button(panel, "Hide icon")?.disabled).toBe(true);
    expect(button(panel, "Show icon")?.disabled).toBe(true);
  });

  test("a stopped tray that was left hidden says the next start will be hidden", async () => {
    // Without this line the panel reads as "nothing is wrong, start one", and
    // the operator is surprised by a start with no icon.
    const { panel } = await mountPanel([
      { match: "GET /console/api/tray/status", json: STOPPED_AFTER_HIDING },
    ]);

    expect(panel.text()).toContain("will start with the icon hidden");
    // The state is a memory, not a live icon: neither button may be offered.
    expect(button(panel, "Hide icon")?.disabled).toBe(true);
    expect(button(panel, "Show icon")?.disabled).toBe(true);
  });

  test("a stopped tray with nothing recorded says nothing about a last state", async () => {
    const { panel } = await mountPanel([
      { match: "GET /console/api/tray/status", json: NOT_RUNNING },
    ]);

    expect(panel.text()).not.toContain("will start with the icon");
  });

  test("hiding posts the hide action and toasts the confirmed result", async () => {
    const success = spyOn(toast, "success").mockImplementation(() => "toast-id");
    const { panel, calls } = await mountPanel([
      { match: "GET /console/api/tray/status", json: RUNNING_VISIBLE },
      { match: "POST /console/api/tray/visibility", json: RUNNING_HIDDEN },
      // The refetch after the mutation: the panel must show what the tray
      // reports, not assume the answer.
      { match: "GET /console/api/tray/status", json: RUNNING_HIDDEN },
    ]);

    // The first of the two buttons is `Hide icon`, the only live action while
    // the icon is visible.
    await panel.click("button");
    await panel.flush();

    expect(calls).toContain("POST /console/api/tray/visibility");
    expect(success).toHaveBeenCalled();
    success.mockRestore();
  });

  test("a refusing browser is told the control is local-only", async () => {
    const failure = spyOn(toast, "error").mockImplementation(() => "toast-id");
    const { panel } = await mountPanel([
      { match: "GET /console/api/tray/status", json: RUNNING_VISIBLE },
      {
        match: "POST /console/api/tray/visibility",
        status: 403,
        json: {
          error: "Tray control is only available from the machine running the gateway",
          code: "tray_control_local_only",
        },
      },
    ]);

    // Same as above: `Hide icon` is the live button for a visible icon.
    await panel.click("button");
    await panel.flush();

    expect(failure).toHaveBeenCalled();
    expect(panel.text()).toContain("only works from the machine running the gateway");
    failure.mockRestore();
  });

  test("a failed status read offers a retry instead of an empty panel", async () => {
    const { panel } = await mountPanel([
      {
        match: "GET /console/api/tray/status",
        status: 500,
        json: { error: "Tray operation failed", code: "internal_error" },
      },
    ]);

    // The route's own sentence wins over the panel's fallback, and a retry is
    // the only thing a failed read can offer.
    expect(panel.text()).toContain("Tray operation failed");
    expect(panel.text()).toContain("Retry");
  });
});
