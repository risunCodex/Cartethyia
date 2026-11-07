// Live Devin adapter dispatch probe.
// Language: JavaScript (Bun), file: scripts/provider-probing/devin/devin-live-dispatch.mjs
//
// Runs the SHIPPED `devinAdapter.dispatch` against the real upstream with the
// credential adopted from the Devin CLI. No mock transport: GetUserJwt,
// GetChatMessage and the Connect frame stream all hit server.codeium.com.
//
// Usage:
//   bun scripts/provider-probing/devin/devin-live-dispatch.mjs
//   DEVIN_MODEL=swe-1-6-slow DEVIN_PROMPT="..." bun scripts/.../devin-live-dispatch.mjs
//   DEVIN_CRED=sk-ws-… bun scripts/.../devin-live-dispatch.mjs   (skip CLI adopt)

import { loginDevinCliHook } from "../../../src/providers/integrations/devin/devin-auth.ts";
import { devinAdapter } from "../../../src/providers/integrations/devin/devin.ts";
import { devinCliMetadata, DEVIN_CHAT_MESSAGE_PATH } from "../../../src/providers/integrations/devin/devin-shared.ts";
import { arg, hasFlag, redact } from "./_lib.mjs";

const cred = process.env.DEVIN_CRED || (await loginDevinCliHook());
const model = arg("model", "swe-2-flash-medium");
const prompt = arg("prompt", "Reply with exactly: OK");
const withTools = hasFlag("tools");

console.log(`credential: ${redact(cred)}`);
console.log(`model:      ${model}`);
console.log(`prompt:     ${JSON.stringify(prompt)}`);
console.log(`tools:      ${withTools ? "enabled" : "disabled"}`);
console.log(`wire:       ${DEVIN_CHAT_MESSAGE_PATH}\n`);

const request = {
  model,
  system: [{ kind: "text", text: "You are a concise assistant." }],
  messages: [{ role: "user", content: [{ kind: "text", text: prompt }] }],
  generation_controls: { max_tokens: 256 },
  ...(withTools ? {
    tools: [{ name: "get_weather", description: "Get the weather for a city", jsonSchema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } }],
  } : {}),
  stream: true,
  source_surface: "chat",
};

const target = {
  provider_id: "devin",
  model_id: model,
  wire_family: "chat",
  endpoint_path: DEVIN_CHAT_MESSAGE_PATH,
  capabilities: {},
};

const context = {
  credential: {
    provider_id: "devin",
    credential_kind: "api_key",
    secret: new TextEncoder().encode(cred),
  },
  deadline: Date.now() + 60_000,
  abort_signal: new AbortController().signal,
  outbound_fetch: fetch,
};

let text = "";
let thinking = "";
const toolDeltas = [];
let usage = null;
let terminal = null;
const errors = [];

const started = Date.now();
for await (const event of devinAdapter.dispatch(request, target, context)) {
  switch (event.type) {
    case "response_start":
      console.log(`[response_start] model=${event.model}`);
      break;
    case "content_delta": {
      const part = event.content;
      if (part.kind === "text") { text += part.text; }
      else if (part.kind === "reasoning" && typeof part.payload === "string") { thinking += part.payload; }
      break;
    }
    case "tool_call_delta":
      toolDeltas.push({ id: event.call_id, name: event.name, delta: event.arguments_delta });
      break;
    case "usage":
      usage = event.usage;
      break;
    case "terminal":
      terminal = event;
      break;
    case "error":
      errors.push(event);
      break;
  }
}
const elapsed = Date.now() - started;

console.log(`\n=== result (${elapsed}ms) ===`);
console.log(`text:      ${JSON.stringify(text)}`);
console.log(`thinking:  ${thinking.length} chars`);
console.log(`toolCalls: ${toolDeltas.length} deltas${toolDeltas.length ? ` → ${JSON.stringify(toolDeltas)}` : ""}`);
console.log(`usage:     ${usage ? `in=${usage.input_tokens} out=${usage.output_tokens} cached=${usage.cached_input_tokens} credit=${usage.credit_used ?? "-"}` : "none"}`);
console.log(`terminal:  ${terminal ? `${terminal.state} / ${terminal.stop_reason} / ${terminal.provider_stop_reason}` : "MISSING"}`);
console.log(`errors:    ${errors.length ? errors.map((e) => `${e.category}: ${e.message}`).join(" | ") : "none"}`);

if (!terminal || errors.length > 0 || (text.length === 0 && toolDeltas.length === 0)) {
  console.log("\nverdict: ❌ dispatch did not complete cleanly");
  process.exitCode = 1;
} else {
  console.log(`\nverdict: ✅ live dispatch end-to-end OK (${terminal.stop_reason === "tool_use" ? "tool-use turn" : "text turn"})`);
}
