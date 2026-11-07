/**
 * Devin `/models` surface probe — AI Gateway vs Cascade catalog.
 * Language: JavaScript (Bun), file: scripts/provider-probing/devin/probe-devin-v1-models.mjs
 *
 * The desktop's AI Gateway (`server.codeium.com/api/v1/models`,
 * AI_GATEWAY_API_KEY) is a separate OpenAI-compatible surface. The shipped
 * adapter does NOT use it — it reads the credential-scoped model catalog via
 * `GetCliModelConfigs`. This probe shows both with the same credential so a
 * gateway key and a seat key are never confused.
 *
 * Usage:
 *   DEVIN_CRED=sk-ws-… bun scripts/provider-probing/devin/probe-devin-v1-models.mjs
 *   DEVIN_CRED=… bun scripts/provider-probing/devin/probe-devin-v1-models.mjs --legacy-hosts
 */

import {
  hasFlag,
  redact,
  requireCred,
  callDevinUnary,
  DevinMessageTypes,
  DEVIN_DEFAULT_BASE_URL,
  DEVIN_GET_CLI_MODEL_CONFIGS_PATH,
  devinDiscoveryMetadata,
} from "./_lib.mjs";

const cred = requireCred();
console.log(`credential: ${redact(cred)}`);

console.log(`\n=== AI Gateway GET /api/v1/models (${DEVIN_DEFAULT_BASE_URL}) ===`);
try {
  const res = await fetch(`${DEVIN_DEFAULT_BASE_URL}/api/v1/models`, {
    headers: { authorization: `Bearer ${cred}`, accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  const text = await res.text();
  console.log(`[${res.status}] ${text.slice(0, 600).replace(/\s+/g, " ")}`);
  console.log("note: this surface needs AI_GATEWAY_API_KEY, not a seat token.");
} catch (error) {
  console.log(`[ERR] ${error instanceof Error ? error.message : String(error)}`);
}

console.log(`\n=== Cascade GetCliModelConfigs (shipped adapter wire) ===`);
try {
  const out = await callDevinUnary(
    DEVIN_GET_CLI_MODEL_CONFIGS_PATH,
    DevinMessageTypes.GetCliModelConfigsRequest,
    DevinMessageTypes.GetCliModelConfigsResponse,
    { metadata: devinDiscoveryMetadata(cred) },
    { baseUrl: DEVIN_DEFAULT_BASE_URL, signal: AbortSignal.timeout(20_000) },
  );
  const configs = out.clientModelConfigs ?? [];
  console.log(`[200] ${configs.length} configs | visible=${configs.filter((c) => !c.disabled).length} | default=${out.defaultOverrideModelConfig?.modelUid ?? "-"}`);
  for (const c of configs.filter((x) => !x.disabled).slice(0, 15)) {
    console.log(`  ${c.modelUid} | ${c.label ?? ""}`);
  }
} catch (error) {
  console.log(`[401/invalid] ${error instanceof Error ? error.message : String(error)}`);
}

if (hasFlag("legacy-hosts")) {
  console.log("\n=== legacy REST host grid (expected 401/404) ===");
  for (const host of ["https://api.devin.ai", "https://app.devin.ai", "https://backend.webapp.devin.ai"]) {
    for (const path of ["/v1/models", "/api/v1/models", "/models"]) {
      try {
        const res = await fetch(host + path, {
          headers: { authorization: `Bearer ${cred}`, accept: "application/json" },
          signal: AbortSignal.timeout(8000),
        });
        console.log(`[${res.status}] ${host}${path} → ${(await res.text()).slice(0, 100).replace(/\s+/g, " ")}`);
      } catch (error) {
        console.log(`[ERR] ${host}${path}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}
