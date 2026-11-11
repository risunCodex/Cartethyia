/**
 * The legacy COSY request follows `reasoningEffort`: some reasoning models
 * (Sonus, Cantus) stream no thinking unless an effort is sent. The roster
 * carries a default effort for those models; the request builder must apply it
 * when the caller did not ask for one, and must not override an explicit
 * caller intent. The legacy COSY body (`buildQoderRequest`) must carry the
 * same field.
 */
import { describe, expect, test } from "bun:test";
import { buildQoderRequest } from "../../../src/providers/integrations/qoder/qoder";
import type { QoderAuth } from "../../../src/providers/integrations/qoder/qoder";
import type { CanonicalRequest } from "../../../src/protocol/canonical-model";

const AUTH: QoderAuth = {
  userId: "u-test",
  userName: "",
  userType: "personal_standard",
  securityOauthToken: "dt-test",
  refreshToken: "",
  machineId: "m-test",
};

const SMODEL_CONFIG = {
  id: "smodel",
  display_name: "Sonus",
  max_input_tokens: 1_000_000,
  max_output_tokens: 128_000,
  is_vl: true,
  is_free: false,
  is_reasoning: true,
  default_reasoning_effort: "high",
};

const DEEPMODEL_CONFIG = {
  id: "dfmodel",
  display_name: "DeepSeek-Flash",
  max_input_tokens: 1_000_000,
  max_output_tokens: 384_000,
  is_vl: true,
  is_free: false,
  is_reasoning: true,
};

const LITE_CONFIG = {
  id: "lite",
  display_name: "Lite-Qwen-3.7-Plus",
  max_input_tokens: 1_000_000,
  max_output_tokens: 65_536,
  is_vl: true,
  is_free: true,
  is_reasoning: false,
};

function requestFor(overrides: Partial<CanonicalRequest> = {}): CanonicalRequest {
  return {
    model: "qoder/sonus",
    messages: [{ role: "user", content: [{ kind: "text", text: "hi" }] }],
    generation_controls: {},
    stream: true,
    source_surface: "chat",
    ...overrides,
  };
}

describe("Qoder default reasoning effort", () => {
  test("smodel sends the roster default when the caller sends no intent", () => {
    const req = buildQoderRequest("smodel", requestFor(), SMODEL_CONFIG, AUTH, "intl");
    expect(req.reasoningEffort).toBe("high");
  });

  test("smodel honors an explicit caller intent over the default", () => {
    const req = buildQoderRequest(
      "smodel",
      requestFor({ reasoning: { effort: "low" } }),
      SMODEL_CONFIG,
      AUTH,
      "intl",
    );
    expect(req.reasoningEffort).toBe("low");
  });

  test("smodel sends no effort when the caller explicitly disables reasoning", () => {
    const req = buildQoderRequest(
      "smodel",
      requestFor({ reasoning: { thinking_type: "disabled" } }),
      SMODEL_CONFIG,
      AUTH,
      "intl",
    );
    // Disabled maps to the explicit `"none"` effort, never the default.
    expect(req.reasoningEffort).toBe("none");
  });

  test("a model without a default effort stays as before", () => {
    const req = buildQoderRequest("dfmodel", requestFor(), DEEPMODEL_CONFIG, AUTH, "intl");
    expect(req.reasoningEffort).toBeUndefined();
  });

  test("a non-reasoning model never carries an effort, even when asked", () => {
    // `lite` rejects the request with 500 when `reasoningEffort` rides along
    // `model_config.is_reasoning: false` (measured live). The model cannot
    // think, so the effort must be dropped regardless of caller intent.
    const req = buildQoderRequest(
      "lite",
      requestFor({ reasoning: { effort: "low" } }),
      LITE_CONFIG,
      AUTH,
      "intl",
    );
    expect(req.reasoningEffort).toBeUndefined();
    expect((req.model_config as Record<string, unknown>).is_reasoning).toBe(false);
  });
});
