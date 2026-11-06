/**
 * Area 05: Add Model is one modal with two modes.
 *
 * Default is the read-only upstream roster — fetched on open, searched
 * client-side, multi-select, "Registered" rows disabled. A failed fetch keeps
 * the manual form reachable. Commit posts only the chosen ids; manual submit
 * still uses `registerModels`. "Fetch models" (full sync) lives on the provider
 * page header and is deliberately untouched here.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createElement } from "react";
import {
  AddModelModal,
  ADD_MODEL_MAX_SELECTION,
  filterDiscoveredModels,
  normalizeManualModelId,
} from "../../src/features/provider-detail/sections/Models";
import { mount } from "../helpers/render";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

interface Call {
  readonly method: string;
  readonly url: string;
  readonly body: string;
}

function candidate(modelId: string, alreadyRegistered = false) {
  return {
    modelId,
    wireFamily: "chat",
    serviceKind: "llm",
    endpointPath: "/chat/completions",
    contextLimit: 128000,
    outputLimit: 8192,
    modalities: { input: ["text"], output: ["text"] },
    reasoning: false,
    toolCall: true,
    freeTier: false,
    proOnly: false,
    alreadyRegistered,
  };
}

function stubApi(options: { readonly discoverFails?: boolean; readonly supported?: boolean } = {}) {
  const calls: Call[] = [];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const url = String(input);
      const body = typeof init?.body === "string" ? init.body : "";
      calls.push({ method, url, body });
      if (url.includes("/models/discover/commit")) {
        const ids: string[] = JSON.parse(body || "{}").modelIds ?? [];
        return Response.json({ ok: true, committed: ids, skipped: [], synced: ids.length });
      }
      if (url.includes("/models/discover")) {
        if (options.discoverFails) {
          return Response.json({ message: "transport_unavailable" }, { status: 502 });
        }
        return Response.json({
          supported: options.supported ?? true,
          candidates: [
            candidate("alpha-model"),
            candidate("beta-model"),
            candidate("already-here", true),
          ],
          accountLabel: "Main OAuth",
        });
      }
      if (url.includes("/models")) return Response.json({ registered: 1 });
      return Response.json({ ok: true });
    },
    { preconnect: originalFetch.preconnect },
  ) as typeof globalThis.fetch;
  return calls;
}

function button(text: string): HTMLElement | null {
  return (
    ([...document.querySelectorAll("button")].find(
      (node) => node.textContent?.trim() === text,
    ) as HTMLElement | undefined) ?? null
  );
}

async function renderModal(
  options: { readonly discoverFails?: boolean; readonly supported?: boolean } = {},
  provider?: { readonly supportsModelDiscovery?: boolean },
) {
  const calls = stubApi(options);
  const view = await mount(
    createElement(AddModelModal, {
      providerId: "demo",
      provider,
      onClose: () => undefined,
    }),
  );
  await view.flush();
  await view.flush();
  return { view, calls };
}

describe("AddModelModal provider mode", () => {
  test("fetches the roster on open and shows the account label plus candidate rows", async () => {
    const { view, calls } = await renderModal();
    try {
      expect(calls.some((call) => call.url.includes("/models/discover") && call.method === "GET")).toBe(true);
      const body = document.body.textContent ?? "";
      expect(body).toContain("Using account Main OAuth");
      expect(body).toContain("alpha-model");
      expect(body).toContain("beta-model");
      // An already-registered row stays visible but cannot be picked.
      const registered = view.find('input[aria-label="Select already-here"]') as HTMLInputElement | null;
      expect(registered).not.toBeNull();
      expect(registered?.hasAttribute("disabled")).toBe(true);
      expect(body).toContain("Registered");
      // The manual form is not the default.
      expect(view.find("#add-model-wire-family")).toBeNull();
    } finally {
      view.unmount();
    }
  });

  test("search filters client-side over modelId", async () => {
    // happy-dom does not bridge React 19's synthetic onChange for a text
    // input, so the pure filter is pinned here and the input's presence is
    // pinned below in the roster test. Filtering never issues a second fetch.
    const { view, calls } = await renderModal();
    try {
      expect(view.find('input[aria-label="Search discovered models"]')).not.toBeNull();
      const roster = [candidate("alpha-model"), candidate("beta-model")];
      expect(filterDiscoveredModels(roster, "beta").map((item) => item.modelId)).toEqual(["beta-model"]);
      expect(filterDiscoveredModels(roster, "  ALPHA ").map((item) => item.modelId)).toEqual(["alpha-model"]);
      expect(filterDiscoveredModels(roster, "")).toHaveLength(2);
      expect(calls.filter((call) => call.url.includes("/models/discover") && call.method === "GET")).toHaveLength(1);
    } finally {
      view.unmount();
    }
  });

  test("multi-select commits only the chosen ids to the C3 commit route", async () => {
    const { view, calls } = await renderModal();
    try {
      const first = view.find('input[aria-label="Select alpha-model"]') as HTMLInputElement | null;
      const second = view.find('input[aria-label="Select beta-model"]') as HTMLInputElement | null;
      expect(first).not.toBeNull();
      expect(second).not.toBeNull();
      await view.act(() => first!.click());
      await view.flush();
      await view.act(() => second!.click());
      await view.flush();
      const submit = [...document.querySelectorAll("button")].find(
        (node) => node.textContent?.trim() === "Add selected (2)",
      );
      expect(submit).toBeDefined();
      await view.act(() => submit!.click());
      await view.flush();
      await view.flush();
      const commit = calls.find((call) => call.url.includes("/models/discover/commit"));
      expect(commit?.method).toBe("POST");
      expect(JSON.parse(commit?.body ?? "{}")).toEqual({ modelIds: ["alpha-model", "beta-model"] });
      // Manual registration is not part of a provider-mode submit.
      expect(calls.some((call) => call.method === "POST" && call.url.endsWith("/models"))).toBe(false);
    } finally {
      view.unmount();
    }
  });

  test("the cap is the C3 constant (100 per commit)", () => {
    expect(ADD_MODEL_MAX_SELECTION).toBe(100);
  });
});

describe("AddModelModal manual fallback", () => {
  test("a failed discovery shows an error banner and a working Tambah manual button", async () => {
    const { view } = await renderModal({ discoverFails: true });
    try {
      const body = document.body.textContent ?? "";
      expect(body).toContain("Could not fetch the provider's model list");
      const manual = button("Tambah manual");
      expect(manual).not.toBeNull();
      await view.act(() => manual!.click());
      await view.flush();
      expect(view.find("#add-model-wire-family")).not.toBeNull();
      expect(document.body.textContent).toContain("Model ID");
    } finally {
      view.unmount();
    }
  });

  test("supportsModelDiscovery=false opens straight into the untouched manual form", async () => {
    const { view, calls } = await renderModal({}, { supportsModelDiscovery: false });
    try {
      expect(calls.filter((call) => call.url.includes("/models/discover"))).toHaveLength(0);
      expect(view.find("#add-model-wire-family")).not.toBeNull();
      expect(view.find('input[aria-label="Search discovered models"]')).toBeNull();
    } finally {
      view.unmount();
    }
  });

  test("supported:false from the server offers the manual form", async () => {
    const { view } = await renderModal({ supported: false });
    try {
      const body = document.body.textContent ?? "";
      expect(body).toContain("No provider listing available.");
      expect(body).toContain("Tambah manual");
      const manual = button("Tambah manual");
      expect(manual).not.toBeNull();
      await view.act(() => manual!.click());
      await view.flush();
      expect(view.find("#add-model-wire-family")).not.toBeNull();
    } finally {
      view.unmount();
    }
  });

  test("manual submit keeps registerModels", async () => {
    // The registration POST is driven through the same hook the manual form
    // uses; the form's own id normalization is pinned separately (happy-dom
    // does not bridge React 19's text-input onChange).
    expect(normalizeManualModelId("demo", "  hand-typed-model ")).toBe("hand-typed-model");
    expect(normalizeManualModelId("demo", "demo/qualified-id")).toBe("qualified-id");
    expect(normalizeManualModelId("demo", "other/keep-prefix")).toBe("other/keep-prefix");

    const { view, calls } = await renderModal({}, { supportsModelDiscovery: false });
    const input = view.find('input[placeholder="e.g. gpt-4o, free-model-id"]') as HTMLInputElement | null;
    expect(input).not.toBeNull();
    // Unmount the modal before the second mount: `mount` clears document.body,
    // which would otherwise orphan the dialog's portal root.
    view.unmount();
    {
      const { useRegisterProviderModels } = await import("../../src/hooks/providers");
      const harness = () => {
        const register = useRegisterProviderModels();
        return createElement(
          "button",
          {
            id: "manual-submit",
            onClick: () =>
              register.mutate({
                providerId: "demo",
                modelIds: [normalizeManualModelId("demo", "hand-typed-model")],
                wireFamily: "chat",
              }),
          },
          "Submit manual",
        );
      };
      const hookView = await mount(createElement(harness));
      await hookView.click("#manual-submit");
      await hookView.flush();
      await hookView.flush();
      try {
        const register = calls.find(
          (call) => call.method === "POST" && call.url.endsWith("/providers/demo/models"),
        );
        expect(register).toBeDefined();
        expect(JSON.parse(register?.body ?? "{}").modelIds).toEqual(["hand-typed-model"]);
      } finally {
        hookView.unmount();
      }
    }
  });
});
