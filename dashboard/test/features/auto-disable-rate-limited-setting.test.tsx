/**
 * Area 01: the auto-disable toggle in the Operations panel.
 *
 * Two properties are pinned: the row is off by default with a hint that names
 * its real scope (429 / quota-exhausted / transient rate limits), and picking
 * "On" sends exactly `{ autoDisableRateLimited: true }` to the runtime-settings
 * PATCH. Radix's portal cannot be driven reliably in happy-dom, so the mutation
 * is asserted at the fetch boundary the component actually uses.
 */
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createElement } from "react";
import Settings, { autoDisableRateLimitedPatch } from "../../src/features/settings/SettingsPage";
import { mount } from "../helpers/render";
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
      // A read-only accessor is already available to the component.
    }
  }
});

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const SETTINGS = {
  telemetryPayloads: "none",
  telemetryPayloadDepth: "minimum",
  privacyMode: "masked",
  forceDisableCooldown: false,
  autoDisableRateLimited: false,
  modelProbeMode: "detail",
  modelProbeFastTimeoutSeconds: null,
  tenantConcurrencyLimit: null,
  concurrencyTolerance: null,
  thinkingNormalizationEnabled: false,
  responsesReasoningSummary: "detailed",
  upstreamTimeoutSeconds: null,
  telemetryWindowMinutes: null,
  imageClampMaxBytes: null,
  defaults: {
    upstreamTimeoutSeconds: 75,
    telemetryWindowMinutes: 15,
    imageClampMaxBytes: 10 * 1024 * 1024,
    telemetryRetentionDays: 30,
  },
};

interface FetchCall {
  readonly method: string;
  readonly url: string;
  readonly body: string;
}

function stubSettings(overrides: Record<string, unknown> = {}) {
  const calls: FetchCall[] = [];
  let runtime = { ...SETTINGS, ...overrides };
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? init.body : "";
      calls.push({ method, url, body });
      if (url.includes("/settings/runtime") && method === "PATCH") {
        runtime = { ...runtime, ...(body ? JSON.parse(body) : {}) };
        return Response.json(runtime);
      }
      if (url.includes("/settings/runtime")) return Response.json(runtime);
      if (url.includes("/data-management/usage")) {
        return Response.json({
          totalBytes: 0,
          healthEventCount: 0,
          buckets: [],
        });
      }
      return Response.json({ ok: true });
    },
    { preconnect: originalFetch.preconnect },
  ) as typeof globalThis.fetch;
  return calls;
}

async function mountPanel(overrides: Record<string, unknown> = {}) {
  const calls = stubSettings(overrides);
  const view = await mount(createElement(Settings));
  await view.flush();
  await view.flush();
  return { view, calls };
}

describe("auto-disable rate-limited accounts", () => {
  test("the row is mounted, off by default, and explains scope and recovery", async () => {
    const { view } = await mountPanel();
    try {
      const control = view.find("#auto-disable-rate-limited");
      expect(control).not.toBeNull();
      const operations = view.find("#operations");
      expect(operations?.textContent).toContain("Auto-disable rate-limited accounts");
      expect(operations?.textContent).toContain("429");
      expect(operations?.textContent).toContain("quota-exhausted");
      expect(operations?.textContent).toContain("Off — default");
      expect(operations?.textContent).toContain("Recovery");
      // No warning banner until the operator opts in.
      expect(operations?.textContent).not.toContain("Rate-limited accounts leave the rotation.");
    } finally {
      view.unmount();
    }
  });

  test("an on-setting shows the warning banner and a 429 hint", async () => {
    const { view } = await mountPanel({ autoDisableRateLimited: true });
    try {
      const operations = view.find("#operations");
      expect(operations?.textContent).toContain("Rate-limited accounts leave the rotation.");
      expect(operations?.textContent).toContain("429");
    } finally {
      view.unmount();
    }
  });

  test("picking On writes exactly the auto-disable flag; Off is the safe fallback", () => {
    expect(autoDisableRateLimitedPatch("on")).toEqual({ autoDisableRateLimited: true });
    expect(autoDisableRateLimitedPatch("off")).toEqual({ autoDisableRateLimited: false });
    expect(autoDisableRateLimitedPatch("garbage")).toEqual({ autoDisableRateLimited: false });
  });

  test("the runtime-settings PATCH endpoint carries the flag through the hook", async () => {
    // The Radix Select portal cannot be driven in happy-dom, so the mutation is
    // exercised through the same `useUpdateRuntimeSettings` hook the panel uses.
    const { useUpdateRuntimeSettings } = await import("../../src/hooks/settings");
    const calls = stubSettings();
    const harness = () => {
      const mutation = useUpdateRuntimeSettings();
      return createElement(
        "button",
        {
          id: "save-auto-disable",
          onClick: () => mutation.mutate(autoDisableRateLimitedPatch("on")),
        },
        "Save",
      );
    };
    const view = await mount(createElement(harness));
    await view.click("#save-auto-disable");
    await view.flush();
    await view.flush();
    try {
      const patch = calls.find((call) => call.method === "PATCH");
      expect(patch?.url).toContain("/settings/runtime");
      expect(JSON.parse(patch?.body ?? "{}")).toEqual({ autoDisableRateLimited: true });
    } finally {
      view.unmount();
    }
  });

  test("the settings page still loads both new panels from one runtime query", async () => {
    const { view, calls } = await mountPanel();
    try {
      const get = calls.filter((call) => call.method === "GET" && call.url.includes("/settings/runtime"));
      expect(get.length).toBeGreaterThan(0);
      expect(view.find("#auto-disable-rate-limited")).not.toBeNull();
      expect(view.find("#default-probe-mode")).not.toBeNull();
    } finally {
      view.unmount();
    }
  });
});
