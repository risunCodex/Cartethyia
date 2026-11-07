/**
 * Area 07: probe mode, fast gateway test, and the provider-wide run.
 *
 * D41 is pinned explicitly: fast mode keeps the signed `/v1/chat/completions`
 * gateway path — it only changes the token budget and abort deadline. The
 * Qoder branch sends `mode` to the console probe; "Test all models" sends the
 * same mode to `POST /models/test-models` and renders per-model verdicts.
 */
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createElement } from "react";
import {
  ModelGrid,
  TestAllModelsPanel,
} from "../../src/features/provider-detail/sections/Models";
import {
  FAST_TEST_MAX_TOKENS,
  FAST_TEST_SAMPLE_CHARS,
  FAST_TEST_TIMEOUT_MS,
  useGatewaySignedModelTest,
} from "../../src/features/provider-detail/sections/gateway-model-test";
import Settings, { modelProbeModePatch, fastProbeTimeoutPatch } from "../../src/features/settings/SettingsPage";
import { mount, renderMarkup } from "../helpers/render";
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
      // Already available to Radix.
    }
  }
});

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  window.localStorage.clear();
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

function stubSettings() {
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/settings/runtime")) return Response.json(SETTINGS);
      if (url.includes("/data-management/usage")) {
        return Response.json({ totalBytes: 0, healthEventCount: 0, buckets: [] });
      }
      return Response.json({ ok: true });
    },
    { preconnect: originalFetch.preconnect },
  ) as typeof globalThis.fetch;
}

describe("settings model-testing section", () => {
  test("the section and both rows render", async () => {
    stubSettings();
    const view = await mount(createElement(Settings));
    await view.flush();
    await view.flush();
    try {
      const section = view.find("#model-testing");
      expect(section).not.toBeNull();
      expect(section?.textContent).toContain("Model testing");
      expect(view.find("#default-probe-mode")).not.toBeNull();
      expect(view.find("#fast-probe-timeout")).not.toBeNull();
      expect(section?.textContent).toContain("Ask detail — default");
      expect(section?.textContent).toContain("Deployment default (10 seconds)");
    } finally {
      view.unmount();
    }
  });

  test("patch helpers persist the two rows with the documented defaults", () => {
    expect(modelProbeModePatch("fast")).toEqual({ modelProbeMode: "fast" });
    expect(modelProbeModePatch("detail")).toEqual({ modelProbeMode: "detail" });
    expect(modelProbeModePatch("unknown")).toEqual({ modelProbeMode: "detail" });
    expect(fastProbeTimeoutPatch("5")).toEqual({ modelProbeFastTimeoutSeconds: 5 });
    expect(fastProbeTimeoutPatch("15")).toEqual({ modelProbeFastTimeoutSeconds: 15 });
    expect(fastProbeTimeoutPatch("")).toEqual({ modelProbeFastTimeoutSeconds: null });
  });
});

describe("fast gateway test", () => {
  test("fast keeps the gateway path, trims tokens, and caps the sample", async () => {
    const bodies: Record<string, unknown>[] = [];
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/v1/chat/completions")) {
          bodies.push(JSON.parse(String(init?.body ?? "{}")));
          return Response.json({
            model: "demo/fast-model",
            choices: [{ message: { content: "x".repeat(120) } }],
          });
        }
        if (url.includes("/api-keys")) {
          return Response.json([
            {
              id: "default-key",
              enabled: true,
              revokedAt: undefined,
              isDefault: true,
              scopes: ["*"],
              createdAt: "2026-01-01T00:00:00.000Z",
            },
          ]);
        }
        if (url.includes("/reveal")) return Response.json({ secret: "sk-test" });
        return Response.json({ ok: true });
      },
      { preconnect: originalFetch.preconnect },
    ) as typeof globalThis.fetch;

    const harness = () => {
      const gateway = useGatewaySignedModelTest();
      return createElement(
        "button",
        {
          id: "run-fast",
          onClick: () => {
            void gateway.test("demo/fast-model", 4096, { fast: true }).then((result) => {
              (globalThis as Record<string, unknown>).__fastResult = result;
            });
          },
        },
        "Run",
      );
    };
    const view = await mount(createElement(harness));
    // Let `useApiKeys` settle before the test reads the default key.
    await view.flush();
    await view.flush();
    await view.click("#run-fast");
    await view.flush();
    await view.flush();
    await view.flush();
    try {
      expect(bodies).toHaveLength(1);
      expect(bodies[0]?.model).toBe("demo/fast-model");
      expect(bodies[0]?.max_tokens).toBe(FAST_TEST_MAX_TOKENS);
      const result = (globalThis as Record<string, unknown>).__fastResult as { ok: boolean; sample?: string };
      expect(result.ok).toBe(true);
      expect(result.sample?.length).toBe(FAST_TEST_SAMPLE_CHARS);
      expect(FAST_TEST_TIMEOUT_MS).toBe(10_000);
    } finally {
      view.unmount();
    }
  });
});

interface Call {
  readonly method: string;
  readonly url: string;
  readonly body: string;
}

describe("Test all models", () => {
  test("the hook posts mode to test-models and the panel shows ok/fail + latency", async () => {
    const calls: Call[] = [];
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push({
          method: init?.method ?? "GET",
          url,
          body: typeof init?.body === "string" ? init.body : "",
        });
        if (url.includes("/models/test-models")) {
          return Response.json({
            providerId: "demo",
            results: [
              { modelId: "alpha", ok: true, latencyMs: 120 },
              { modelId: "beta", ok: false, latencyMs: 340, error: "upstream refused" },
            ],
          });
        }
        return Response.json({ ok: true });
      },
      { preconnect: originalFetch.preconnect },
    ) as typeof globalThis.fetch;

    const { useProbeAllModels } = await import("../../src/hooks/providers");
    const harness = () => {
      const run = useProbeAllModels();
      const results = run.data?.results ?? null;
      return createElement(
        "div",
        null,
        createElement(
          "button",
          { id: "test-all", onClick: () => run.mutate({ providerId: "demo", mode: "fast" }) },
          "Test all models",
        ),
        results ? createElement(TestAllModelsPanel, { results }) : null,
      );
    };
    const view = await mount(createElement(harness));
    await view.click("#test-all");
    await view.flush();
    await view.flush();
    try {
      const call = calls.find((entry) => entry.url.includes("/models/test-models"));
      expect(call?.method).toBe("POST");
      expect(JSON.parse(call?.body ?? "{}")).toEqual({ mode: "fast" });
      expect(document.body.textContent).toContain("1/2 passed");
      const panel = view.find('[data-testid="test-all-models-results"]');
      expect(panel).not.toBeNull();
      expect(panel?.textContent).toContain("alpha");
      expect(panel?.textContent).toContain("beta");
      expect(panel?.textContent).toContain("upstream refused");
    } finally {
      view.unmount();
    }
  });

  test("ModelGrid renders the results panel below the grid when supplied", () => {
    const markup = renderMarkup(
      createElement(ModelGrid, {
        providerId: "demo",
        models: [],
        thinkingEffort: "auto",
        probeMode: "fast",
        testAll: {
          pending: false,
          onRun: () => undefined,
          results: [{ modelId: "alpha", ok: true, latencyMs: 12 }],
        },
      }),
    );
    expect(markup).toContain("Test all models · 1/1 passed");
    expect(markup).toContain("alpha");
  });
});
