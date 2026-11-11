import { describe, expect, test } from "bun:test";
import { isModelAllowed, modelRejectionReason } from "../../src/security/model-access-rule";

const whitelist = (list: string[]) => ({ model_access_mode: "whitelist" as const, model_list: list });
const blacklist = (list: string[]) => ({ model_access_mode: "blacklist" as const, model_list: list });

describe("model access rule with slash-containing provider model ids", () => {
  test("a fully qualified allowlist entry authorizes a multi-segment model id", () => {
    const policy = whitelist(["aether/UNCENCORED/ALT/GLM-5.3"]);
    expect(isModelAllowed(policy, "UNCENCORED/ALT/GLM-5.3", "aether")).toBe(true);
  });

  test("a sibling route sharing only the last segment stays unauthorized", () => {
    const policy = whitelist(["aether/UNCENCORED/ALT/GLM-5.3"]);
    expect(isModelAllowed(policy, "UNCENCORED/ALTv/GLM-5.3", "aether")).toBe(false);
    expect(isModelAllowed(policy, "UNCENCORED/ALT/GLM-5.3", "other")).toBe(false);
  });

  test("an already-qualified target is not double-prefixed", () => {
    const policy = whitelist(["aether/UNCENCORED/glm-5.3"]);
    expect(isModelAllowed(policy, "aether/UNCENCORED/glm-5.3", "aether")).toBe(true);
  });

  test("single-segment ids keep their existing behavior", () => {
    const policy = whitelist(["opencode/glm-5.3-flash-free"]);
    expect(isModelAllowed(policy, "glm-5.3-flash-free", "opencode")).toBe(true);
    expect(isModelAllowed(policy, "glm-5.3", "opencode")).toBe(false);
  });

  test("a blacklist entry denies the fully qualified multi-segment route", () => {
    const policy = blacklist(["aether/UNCENCORED/ALT/GLM-5.3"]);
    expect(modelRejectionReason(policy, "UNCENCORED/ALT/GLM-5.3", "aether")).toBe("model-denied");
    expect(modelRejectionReason(policy, "UNCENCORED/ALTv/GLM-5.3", "aether")).toBeNull();
  });
});
