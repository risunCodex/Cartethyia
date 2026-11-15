/**
 * F-19: a forced `tool_choice` is a routing requirement.
 *
 * A dialect policy that drops `tool_choice` (DeepSeek) used to silently
 * downgrade a forced selection: the router never looked at the field, so the
 * candidate won the route and the payload builder dropped the constraint —
 * the model chose freely while the client believed its choice was enforced.
 */
import { describe, expect, test } from "bun:test";
import type { CanonicalRequest } from "../../../src/protocol/canonical-model";
import { GatewayError } from "../../../src/protocol/gateway-error";
import {
  deriveRequiredCapabilities,
  projectForRoute,
  routeCapabilitiesFor,
} from "../../../src/protocol/translation/capabilities";

function request(patch: Partial<CanonicalRequest>): CanonicalRequest {
  return {
    model: "deepseek-chat",
    messages: [{ role: "user", content: [{ kind: "text", text: "hi" }] }],
    generation_controls: {},
    stream: false,
    source_surface: "chat",
    ...patch,
  };
}

/** A deepseek-dialect candidate: the heuristic rule matches on provider id. */
const deepseekCandidate = {
  capability_profile: { tools: true } as Readonly<Record<string, boolean>>,
  wire_family: "chat" as const,
  model_id: "deepseek-chat",
  provider_id: "deepseek",
};

const openaiCandidate = {
  capability_profile: { tools: true } as Readonly<Record<string, boolean>>,
  wire_family: "chat" as const,
  model_id: "gpt-5",
  provider_id: "openai",
};

describe("F-19: forced tool_choice is derived as a RequiredCapability", () => {
  test("a named selection derives the requirement", () => {
    const required = deriveRequiredCapabilities(
      request({
        tools: [{ name: "get", jsonSchema: { type: "object", properties: {} } }],
        tool_choice: { type: "tool", name: "get" },
      }),
    );
    expect(required).toContain("tool_choice");
  });

  test("`required` and `none` derive the requirement; `auto` does not", () => {
    expect(deriveRequiredCapabilities(request({ tool_choice: "required" }))).toContain(
      "tool_choice",
    );
    expect(deriveRequiredCapabilities(request({ tool_choice: "none" }))).toContain("tool_choice");
    expect(deriveRequiredCapabilities(request({ tool_choice: "auto" }))).not.toContain(
      "tool_choice",
    );
  });

  test("a deepseek-dialect candidate cannot serve a forced selection", () => {
    expect(routeCapabilitiesFor(deepseekCandidate).toolChoice).toBe(false);
    expect(() =>
      projectForRoute(
        request({
          tools: [{ name: "get", jsonSchema: { type: "object", properties: {} } }],
          tool_choice: { type: "tool", name: "get" },
        }),
        routeCapabilitiesFor(deepseekCandidate),
      ),
    ).toThrow(GatewayError);
    try {
      projectForRoute(
        request({
          tools: [{ name: "get", jsonSchema: { type: "object", properties: {} } }],
          tool_choice: { type: "tool", name: "get" },
        }),
        routeCapabilitiesFor(deepseekCandidate),
      );
    } catch (error) {
      expect((error as GatewayError).code).toBe("capability_unsupported");
      expect((error as GatewayError).details).toMatchObject({ capability: "tool_choice" });
    }
  });

  test("the same candidate still serves tool_choice auto and no tool_choice", () => {
    expect(() =>
      projectForRoute(request({ tool_choice: "auto" }), routeCapabilitiesFor(deepseekCandidate)),
    ).not.toThrow();
    expect(() => projectForRoute(request({}), routeCapabilitiesFor(deepseekCandidate))).not.toThrow();
  });

  test("an openai-dialect candidate serves the forced selection", () => {
    expect(routeCapabilitiesFor(openaiCandidate).toolChoice).toBe(true);
    expect(() =>
      projectForRoute(
        request({
          tools: [{ name: "get", jsonSchema: { type: "object", properties: {} } }],
          tool_choice: { type: "tool", name: "get" },
        }),
        routeCapabilitiesFor(openaiCandidate),
      ),
    ).not.toThrow();
  });
});
