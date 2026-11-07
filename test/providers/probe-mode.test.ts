/**
 * Modelprobe modes (area 07).
 *
 * `detail` (also the absent-mode default) is the full diagnostic probe; `fast`
 * is the cheap liveness check over the same identity prompt. The preferences
 * phase owns the budget so both the single-model route and "Test all models"
 * see identical behaviour.
 */
import { describe, expect, test } from "bun:test";
import type { CartethyiaDatabase } from "../../src/persistence/db-handle";
import {
  buildProbeCanonicalRequest,
  loadProbePreferences,
  PROBE_FAST_DEFAULT_TIMEOUT_SECONDS,
  PROBE_FAST_MAX_OUTPUT_TOKENS,
  PROBE_FAST_SAMPLE_MAX_CHARS,
} from "../../src/providers/discovery/probe-phases";
import type { ProbeModelRequest } from "../../src/providers/discovery/discovery-types";

/**
 * One console-settings row, injectable so the default and the override are
 * both exercised without a real database.
 */
function dbWithPreferences(preferences: Record<string, unknown> | undefined): CartethyiaDatabase {
  const chain: Record<string, unknown> = {};
  for (const method of ["from", "where", "limit", "orderBy", "innerJoin", "leftJoin"]) {
    chain[method] = () => chain;
  }
  const rows = preferences === undefined ? [] : [{ preferences }];
  chain.then = (resolve: (value: unknown) => unknown) => resolve(rows);
  return { select: () => chain } as unknown as CartethyiaDatabase;
}

const base: ProbeModelRequest = { modelId: "a-model" };

describe("loadProbePreferences", () => {
  test("defaults to detail with a 10s fast timeout and no token override", async () => {
    const prefs = await loadProbePreferences({
      db: dbWithPreferences(undefined),
      tenantId: "tenant-1",
      wireFamily: "chat",
      request: base,
    });
    expect(prefs.mode).toBe("detail");
    expect(prefs.timeoutMs).toBeUndefined();
    expect(prefs.maxOutputTokens).toBeUndefined();
    expect(prefs.compactTelemetry).toBe(false);
    expect(PROBE_FAST_DEFAULT_TIMEOUT_SECONDS).toBe(10);
  });

  test("an explicit request mode overrides the tenant's default", async () => {
    const prefs = await loadProbePreferences({
      db: dbWithPreferences({ modelProbeMode: "fast", modelProbeFastTimeoutSeconds: 7 }),
      tenantId: "tenant-1",
      wireFamily: "chat",
      request: { ...base, mode: "detail" },
    });
    expect(prefs.mode).toBe("detail");
    expect(prefs.timeoutMs).toBeUndefined();
  });

  test("fast applies its 32-token budget, timeout, and telemetry suppression", async () => {
    const prefs = await loadProbePreferences({
      db: dbWithPreferences({ modelProbeMode: "fast", modelProbeFastTimeoutSeconds: 7, telemetryPayloads: "full" }),
      tenantId: "tenant-1",
      wireFamily: "chat",
      request: base,
    });
    expect(prefs.mode).toBe("fast");
    expect(prefs.timeoutMs).toBe(7_000);
    expect(prefs.maxOutputTokens).toBe(PROBE_FAST_MAX_OUTPUT_TOKENS);
    expect(PROBE_FAST_MAX_OUTPUT_TOKENS).toBe(64);
    expect(prefs.compactTelemetry).toBe(true);
    expect(prefs.payloadCapture.enabled).toBe(false);
    expect(prefs.payloadCapture.mode).toBe("none");
  });

  test("an unset timeout falls back to 10 seconds", async () => {
    const prefs = await loadProbePreferences({
      db: dbWithPreferences({ modelProbeMode: "fast" }),
      tenantId: "tenant-1",
      wireFamily: "chat",
      request: base,
    });
    expect(prefs.timeoutMs).toBe(10_000);
  });
});

describe("fast canonical probe request", () => {
  test("keeps the identity prompt in detail mode; fast uses a neutral greeting and a smaller token budget", () => {
    const detail = buildProbeCanonicalRequest({
      modelId: "a-model",
      request: base,
      probeReasoning: undefined,
      sourceSurface: "chat",
    });
    const fast = buildProbeCanonicalRequest({
      modelId: "a-model",
      request: base,
      probeReasoning: undefined,
      sourceSurface: "chat",
      maxOutputTokens: PROBE_FAST_MAX_OUTPUT_TOKENS,
    });
    expect(detail.messages[0]?.content).toEqual([
      { kind: "text", text: "What model are you, and what is your knowledge cutoff date? Answer in one sentence." },
    ]);
    expect(fast.messages[0]?.content).toEqual([{ kind: "text", text: "How are you?" }]);
    expect(fast.generation_controls.max_tokens).toBe(64);
    expect(fast.generation_controls.max_output_tokens).toBe(64);
    expect(detail.generation_controls.max_tokens).toBe(256);
  });

  test("the fast sample bound is 80 characters", () => {
    expect(PROBE_FAST_SAMPLE_MAX_CHARS).toBe(80);
    expect("x".repeat(200).slice(0, PROBE_FAST_SAMPLE_MAX_CHARS)).toHaveLength(80);
  });
});
