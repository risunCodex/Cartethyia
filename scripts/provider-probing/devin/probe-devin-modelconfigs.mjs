/**
 * Devin GetCliModelConfigs probe — uses the SHIPPED protobuf schema + unary
 * client (no hand-rolled protobuf). Prints the decoded model catalog and the
 * account default, so a seat key can be validated against the real upstream.
 * Language: JavaScript (Bun), file: scripts/provider-probing/devin/probe-devin-modelconfigs.mjs
 *
 * Usage:
 *   DEVIN_CRED=sk-ws-… bun scripts/provider-probing/devin/probe-devin-modelconfigs.mjs
 *   DEVIN_CRED=… bun scripts/provider-probing/devin/probe-devin-modelconfigs.mjs --limit=0 --json
 */

import {
  arg,
  hasFlag,
  redact,
  requireCred,
  dump,
  callDevinUnary,
  DevinMessageTypes,
  DEVIN_DEFAULT_BASE_URL,
  DEVIN_GET_CLI_MODEL_CONFIGS_PATH,
  devinDiscoveryMetadata,
} from "./_lib.mjs";

const cred = requireCred();
const baseUrl = arg("base-url", DEVIN_DEFAULT_BASE_URL);
const limit = Number(arg("limit", "60"));

console.log(`POST ${baseUrl}${DEVIN_GET_CLI_MODEL_CONFIGS_PATH}`);
console.log(`cred: ${redact(cred)}`);
console.log(`metadata identity: chisel / 0.0.0-dev / displays=[3,4,6,7,8]`);

try {
  const out = await callDevinUnary(
    DEVIN_GET_CLI_MODEL_CONFIGS_PATH,
    DevinMessageTypes.GetCliModelConfigsRequest,
    DevinMessageTypes.GetCliModelConfigsResponse,
    { metadata: devinDiscoveryMetadata(cred) },
    { baseUrl, signal: AbortSignal.timeout(Number(arg("timeout", "30000"))) },
  );
  const configs = out.clientModelConfigs ?? [];
  const visible = configs.filter((c) => !c.disabled);
  console.log(`\nstatus: 200 OK | ${configs.length} configs | ${visible.length} visible`);
  console.log(`account default: ${out.defaultOverrideModelConfig?.modelUid ?? "-"}`);
  for (const c of limit === 0 ? visible : visible.slice(0, limit)) {
    console.log(`  ${String(c.modelUid).padEnd(38)} | ${String(c.label ?? "").slice(0, 26).padEnd(26)} | ctx=${c.modelInfo?.maxTokens ?? c.maxTokens ?? 0} out=${c.modelInfo?.maxOutputTokens ?? 0} disp=${c.modelInfo?.displayOption ?? 0}`);
  }
  if (limit > 0 && visible.length > limit) console.log(`  … (${visible.length - limit} more; --limit=0 for all)`);
  if (hasFlag("json")) dump("raw configs (first 3)", configs.slice(0, 3));
} catch (error) {
  console.log(`\nFAILED: ${error instanceof Error ? error.message : String(error)}`);
  console.log("hint: an auth1_… webapp token is NOT a Cascade API key — use a sk-ws-… seat key or JWT session token.");
  process.exitCode = 1;
}
