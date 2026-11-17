/**
 * Qoder max-context dispatch.
 *
 * The request body's `model_config.max_input_tokens` must be the widest
 * selectable window from the live list's `context_config` (e.g. 1M), not the
 * static roster's *currently active* window (often 180k). This test seeds the
 * discovery state via the same relative-import module graph production uses and
 * asserts the built request carries the max window.
 */
import { describe, expect, test } from "bun:test";
import { discoverQoderModels, resetQoderDiscoveryCache, qoderDiscoveredMaxContexts } from "../../src/providers/integrations/qoder/qoder-catalog";
import { buildQoderRequest } from "../../src/providers/integrations/qoder/qoder";
import type { QoderAuth } from "../../src/providers/integrations/qoder/qoder";
import type { CanonicalRequest } from "../../src/protocol/canonical-model";

const AUTH: QoderAuth = {
  userId: "u-test",
  userName: "",
  userType: "personal_standard",
  securityOauthToken: "dt-test",
  refreshToken: "",
  machineId: "m-test",
};

const ROSTER = JSON.stringify({
  chat: [
    {
      key: "qfmodel",
      display_name: "Qwen3.8-Flash",
      is_vl: true,
      is_reasoning: true,
      enable: true,
      max_input_tokens: 180000,
      context_config: {
        "1M": { token_count: 1000000 },
        "400K": { token_count: 400000 },
        "200K": { token_count: 200000, is_default: true },
      },
    },
    {
      key: "efficient",
      display_name: "Efficient",
      is_vl: true,
      is_reasoning: false,
      enable: true,
      max_input_tokens: 200000,
      context_config: {
        "200K": { token_count: 200000, is_default: true },
      },
    },
  ],
});

const fetcher: typeof fetch = (async () =>
  new Response(ROSTER, { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

function requestFor(model: string): CanonicalRequest {
  return {
    model,
    messages: [{ role: "user", content: [{ kind: "text", text: "hi" }] }],
    generation_controls: {},
    stream: true,
    source_surface: "chat",
  };
}

describe("Qoder max-context dispatch", () => {
  test("seeds discovery max contexts from context_config", async () => {
    resetQoderDiscoveryCache("intl");
    await discoverQoderModels({
      realm: "intl",
      providerId: "qoder",
      credential: "pt-test",
      headers: () => Promise.resolve({ authorization: "Bearer COSY.test" }),
      fetcher,
      encode: (bytes: Uint8Array) => Buffer.from(bytes).toString("latin1"),
    });
    const ctx = qoderDiscoveredMaxContexts("intl");
    expect(ctx.get("qfmodel")).toBe(1_000_000);
    expect(ctx.get("efficient")).toBe(200_000);
  });

  test("builds the request with the max window from discovery", async () => {
    resetQoderDiscoveryCache("intl");
    await discoverQoderModels({
      realm: "intl",
      providerId: "qoder",
      credential: "pt-test",
      headers: () => Promise.resolve({ authorization: "Bearer COSY.test" }),
      fetcher,
      encode: (bytes: Uint8Array) => Buffer.from(bytes).toString("latin1"),
    });
    // Static fallback says 180k; discovery must override to 1M.
    const req = buildQoderRequest(
      "qfmodel",
      requestFor("qfmodel"),
      { id: "qfmodel", display_name: "Qwen3.8-Flash", max_input_tokens: 180000, max_output_tokens: 131072, is_vl: true, is_reasoning: true },
      AUTH,
      "intl",
    );
    const modelConfig = req.model_config as Record<string, unknown>;
    expect(modelConfig.key).toBe("qfmodel");
    expect(modelConfig.max_input_tokens).toBe(1_000_000);
  });

  test("falls back to the static window when discovery has no entry", async () => {
    resetQoderDiscoveryCache("intl");
    const req = buildQoderRequest(
      "qfmodel",
      requestFor("qfmodel"),
      { id: "qfmodel", display_name: "Qwen3.8-Flash", max_input_tokens: 180000, max_output_tokens: 131072, is_vl: true, is_reasoning: true },
      AUTH,
      "intl",
    );
    const modelConfig = req.model_config as Record<string, unknown>;
    expect(modelConfig.max_input_tokens).toBe(180_000);
  });

  test("does not shrink a discovered model to 65536 when the roster states a higher ceiling", async () => {
    // A live-discovered model's config carries no `max_output_tokens` (upstream
    // reports none). The roster states 384k for `dmodel`, so a caller asking for
    // more than 65536 must be clamped to the roster's ceiling — not to the
    // 65536 fallback.
    const req = requestFor("dmodel");
    (req.generation_controls as Record<string, unknown>)["max_tokens"] = 200_000;
    const built = buildQoderRequest(
      "dmodel",
      req,
      { id: "dmodel", display_name: "DeepSeek-V4-Pro", max_input_tokens: 1000000, is_vl: true, is_reasoning: true },
      AUTH,
      "intl",
    );
    expect(built.max_tokens).toBe(200_000);
    const modelConfig = built.model_config as Record<string, unknown>;
    expect(modelConfig.max_output_tokens).toBe(384_000);
  });

  test("keeps the 65536 fallback when neither caller nor roster states a limit", async () => {
    // A discovered model with no roster entry (unknown key) carries no ceiling,
    // so the 65536 fallback is the only bound.
    const req = requestFor("xmodel");
    (req.generation_controls as Record<string, unknown>)["max_tokens"] = 200_000;
    const built = buildQoderRequest(
      "xmodel",
      req,
      { id: "xmodel", display_name: "Unknown Model", max_input_tokens: 180000, is_vl: true, is_reasoning: false },
      AUTH,
      "intl",
    );
    expect(built.max_tokens).toBe(65_536);
  });
});
