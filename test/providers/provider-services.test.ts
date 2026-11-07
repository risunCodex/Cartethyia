import { describe, expect, test } from "bun:test";
import { BUNDLED_PROVIDER_METADATA, providerServiceKinds } from "../../src/providers/provider-metadata";
import { SERVICE_KINDS } from "../../src/protocol/canonical-model";
import { buildCapabilityProfile } from "../../src/transport/routing/route-catalog";
import { sanitizeProviderResponse } from "../../src/console/providers/catalog/provider-operations";

describe("provider service taxonomy", () => {
  test("declares real search surfaces and keeps bundled providers explicit", () => {
    expect(providerServiceKinds("openai")).toEqual(["llm"]);
    expect(providerServiceKinds("gemini")).toEqual(["llm", "websearch", "imageGeneration"]);
    expect(providerServiceKinds("codex")).toEqual(["llm", "websearch", "imageGeneration"]);
    expect(providerServiceKinds("antigravity")).toEqual(["llm", "websearch", "imageGeneration"]);
    expect(providerServiceKinds("exa")).toEqual(["websearch"]);
    expect(providerServiceKinds("parallel")).toEqual(["websearch"]);
    // A bundled provider without a declaration serves LLM only — the
    // declaration is authoritative, so `llm` is not read as "everything".
    expect(providerServiceKinds("cbcn")).toEqual(["llm"]);
    for (const provider of BUNDLED_PROVIDER_METADATA)
      expect(provider.serviceKinds).not.toContain("all");
  });

  test("a custom provider may serve every surface the gateway knows", () => {
    // A BYOK provider has no manifest row. It is read as able to serve the
    // whole taxonomy, because the operator chose its base URL and the upstream
    // — not the gateway — is what decides whether it can answer. A
    // bundled provider is still explicit: `llm` alone means LLM only.
    //
    // Asserted against the tuple, so adding a surface cannot silently leave
    // custom providers out of it.
    expect(providerServiceKinds("custom-provider")).toEqual([...SERVICE_KINDS]);
  });

  test("a chat model never advertises search", () => {
    expect(buildCapabilityProfile({
      modalities: undefined,
      reasoning: true,
      toolCall: true,
      providerId: "codex",
    }).webSearch).toBe(false);
  });

  test("sanitized custom provider responses never expose an all category", () => {
    const response = sanitizeProviderResponse({
      providerId: "custom-provider",
      enabled: true,
      isBuiltIn: false,
      requiresAccount: true,
    });
    // The kinds are derived from the taxonomy, so a custom provider reports the
    // media surfaces it may serve — never a literal "all", which would be an
    // undeclared capability.
    // Same widening as the taxonomy, so every surface is reported.
    expect(response.serviceKinds).toEqual([...SERVICE_KINDS]);
    expect(response.serviceKinds).not.toContain("all");
  });
});
