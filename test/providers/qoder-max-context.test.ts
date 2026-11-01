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
});
