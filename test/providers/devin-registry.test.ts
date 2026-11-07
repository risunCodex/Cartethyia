// Devin registry wiring test — loads every capability through the real
// registry loaders and asserts the exported values have the promised shape.
// Mirrors registry-integration-parity.test.ts but scoped to devin so a broken
// named export is reported with the provider name.

import { expect, test } from "bun:test";
import { PROVIDER_CAPABILITIES } from "../../src/providers/default-registry";

test("devin registry entry loads every capability", async () => {
  const entry = PROVIDER_CAPABILITIES.devin;
  expect(entry).toBeDefined();

  const adapter = await entry!.loadAdapter();
  expect(adapter.provider_id).toBe("devin");
  expect(typeof adapter.dispatch).toBe("function");

  const models = await entry!.loadModels!();
  expect(Array.isArray(models)).toBe(true);
  expect(models.length).toBe(3);
  const byId = new Map(models.map((m) => [m.modelId, m]));
  expect(byId.get("swe-1-6")).toBeUndefined();
  expect(byId.get("swe-1-6-slow")!.contextLimit).toBe(200_000);
  expect(byId.get("swe-2-flash-medium")!.contextLimit).toBe(262_144);
  expect(byId.get("swe-2-flash-medium")!.outputLimit).toBe(131_072);
  for (const model of models) {
    expect(model.modalities.input).not.toContain("image");
    expect(model.reasoning).toBe(true);
    expect(model.toolCall).toBe(true);
  }

  const auth = await entry!.loadAuthentication!();
  expect(auth.client).toBeDefined();
  expect(auth.client!.supportsBrowserCode).toBe(true);
  expect(typeof auth.client!.buildAuthorizeUrl).toBe("function");
  expect(typeof auth.client!.exchangeCode).toBe("function");
  expect(typeof auth.client!.importCredential).toBe("function");

  const quota = await entry!.loadQuotaCollector!();
  expect(typeof quota).toBe("function");

  const discovery = await entry!.loadModelDiscovery!();
  expect(typeof discovery).toBe("function");
});

test("devin OAuth authorize URL carries PKCE parameters", () => {
  const entry = PROVIDER_CAPABILITIES.devin!;
  return entry.loadAuthentication!().then((auth) => {
    const url = auth.client!.buildAuthorizeUrl!({
      state: "state-1",
      codeChallenge: "challenge-1",
      redirectUri: "http://127.0.0.1:59653/callback",
    });
    expect(url).toContain("https://app.devin.ai/auth/cli/continue");
    expect(url).toContain("code_challenge=challenge-1");
    expect(url).toContain("code_challenge_method=S256");
    expect(url).toContain("state=state-1");
    expect(url).toContain("prompt=select_account");
  });
});
