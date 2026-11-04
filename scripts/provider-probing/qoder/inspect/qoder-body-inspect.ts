/**
 * Inspects the exact legacy request body buildQoderRequest produces for qfmodel
 * with 1M context + xhigh reasoning + max_tokens, printing only non-secret
 * fields. This shows what actually goes on the wire.
 *   bun run scripts/provider-probing/qoder/inspect/qoder-body-inspect.ts
 */
import {
  buildQoderRequest,
} from "../../../../src/providers/integrations/qoder/qoder";
import type {
  CanonicalRequest,
  ContentPart,
} from "../../../../src/protocol/canonical-model";

const modelId = "qfmodel";
const AUTH = {
  userId: "user-test-123",
  userName: "test",
  userType: "personal_standard",
  securityOauthToken: "dt-test-token", // placeholder; never printed
  refreshToken: "",
  machineId: "00000000-0000-0000-0000-000000000000",
};

const modelConfig = {
  id: modelId,
  display_name: "Qwen3.8-Flash",
  max_input_tokens: 1_000_000,
  max_output_tokens: 65_536,
  is_vl: true,
  is_reasoning: true,
};

const request: CanonicalRequest = {
  model: modelId,
  messages: [
    {
      role: "user",
      content: [{ kind: "text", text: "ping" } satisfies ContentPart],
    },
  ],
  generation_controls: {
    max_tokens: 2048,
  },
  reasoning: { effort: "xhigh" },
  stream: true,
  source_surface: "chat",
};

const body = buildQoderRequest(modelId, request, modelConfig, AUTH, "intl") as Record<string, unknown>;

console.log("=== legacy body (secrets redacted) ===");
// redact any token-ish values
const redact = (v: unknown): unknown => {
  if (typeof v === "string") {
    return v.replace(/(drt-|dt-|jt-|pt-|Bearer )[A-Za-z0-9._~-]{6,}/g, "$1…<redacted>");
  }
  if (Array.isArray(v)) return v.map(redact);
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, val]) => [k, redact(val)]));
  }
  return v;
};

console.log(JSON.stringify(redact(body), null, 2));

// Assertions
const mc = body["model_config"] as Record<string, unknown>;
console.log("\n=== checks ===");
console.log(`top-level model: ${JSON.stringify(body["model"])}`);
console.log(`model_config.key: ${JSON.stringify(mc?.["key"])}`);
console.log(`model_config.max_input_tokens: ${mc?.["max_input_tokens"]} (expect 1000000 for 1M)`);
console.log(`max_tokens: ${JSON.stringify(body["max_tokens"])}`);
console.log(`reasoning_effort anywhere: ${JSON.stringify(body["reasoning_effort"])}`);
const chatCtx = body["chat_context"] as Record<string, unknown> | undefined;
console.log(`chat_context.extra.modelConfig: ${JSON.stringify((chatCtx?.["extra"] as Record<string, unknown> | undefined)?.["modelConfig"])}`);
console.log(`session_type: ${JSON.stringify(body["session_type"])}`);
console.log(`agent_id: ${JSON.stringify(body["agent_id"])}`);
console.log(`provider id: qoder`);
