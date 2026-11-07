/**
 * Enumerates ALL GetCliModelConfigs: visible vs disabled, and which disabled
 * rows look like real chat models (vs internal routers). Proves the "2 models
 * on Free" is an account-tier lock, not an absent catalog.
 * Usage: DEVIN_CRED=… bun scripts/provider-probing/devin/probe-devin-modelconfigs-all.mjs
 */
import {
  arg,
  redact,
  requireCred,
  callDevinUnary,
  DevinMessageTypes,
  DEVIN_DEFAULT_BASE_URL,
  DEVIN_GET_CLI_MODEL_CONFIGS_PATH,
  devinDiscoveryMetadata,
} from "./_lib.mjs";

const cred = requireCred();
const out = await callDevinUnary(
  DEVIN_GET_CLI_MODEL_CONFIGS_PATH,
  DevinMessageTypes.GetCliModelConfigsRequest,
  DevinMessageTypes.GetCliModelConfigsResponse,
  { metadata: devinDiscoveryMetadata(cred) },
  { baseUrl: DEVIN_DEFAULT_BASE_URL, signal: AbortSignal.timeout(30000) },
);
const configs = out.clientModelConfigs ?? [];
const visible = configs.filter((c) => !c.disabled);
const disabled = configs.filter((c) => c.disabled);

console.log(`total configs: ${configs.length} | visible: ${visible.length} | disabled: ${disabled.length}`);
console.log(`account default: ${out.defaultOverrideModelConfig?.modelUid ?? "-"}`);

console.log("\n=== ALL non-disabled (visible) ===");
for (const c of visible) {
  console.log(`  ${String(c.modelUid).padEnd(40)} | ${String(c.label ?? "").slice(0, 28).padEnd(28)} | ctx=${c.modelInfo?.maxTokens ?? c.maxTokens ?? 0} out=${c.modelInfo?.maxOutputTokens ?? 0} disp=${c.modelInfo?.displayOption ?? 0} images=${c.supportsImages ?? false}`);
}

console.log("\n=== Disabled rows whose label looks like a chat model (sample) ===");
// A disabled row is still a first-class model definition; the tier just hides it.
const chatLike = disabled.filter((c) => {
  const label = String(c.label ?? "").toLowerCase();
  return /swe|flash|opus|sonnet|haiku|gpt|claude|gemini|deepseek|llama|qwen|glm|kimi|moonshot|o1|o3|o4|mini|pro|max|thinking|dream|atlas|v[0-9]|agent|task|code/.test(label);
});
for (const c of chatLike.slice(0, 40)) {
  console.log(`  ${String(c.modelUid).padEnd(40)} | ${String(c.label ?? "").slice(0, 28).padEnd(28)} | ctx=${c.modelInfo?.maxTokens ?? c.maxTokens ?? 0} out=${c.modelInfo?.maxOutputTokens ?? 0} disp=${c.modelInfo?.displayOption ?? 0} images=${c.supportsImages ?? false}`);
}
console.log(`… (${chatLike.length} chat-like disabled total inside ${disabled.length} disabled)`);
