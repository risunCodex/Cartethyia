// Trae intl Auto-selection live probe — scratch, not shipped.
//
// Question: on the agent surface, how does the official client ask the server
// to choose the model, and which model does the server actually pick?
//
// Bundle facts (ai-modules-chat/dist/index.mjs, 3.6.13):
//   * createModelAutoSelection(): mode Auto -> { model_auto_selection: { strategy: "auto" } }
//     (spread into the legacy chat request at @7170337).
//   * getModelRequestSelection(): Auto -> { modelName: "", modelSelectionStrategy: "auto" }
//   * buildSendMessageRequest(): Auto -> model_name: "", model_selection_strategy: "auto",
//     custom_model omitted (@11752673).
//   * Stream event `model_config` carries { config_name, display_model_name, ... }
//     and is merged into modelSmartSelectionMeta (solo-lite 5806.*.mjs @6676651).
//   * `metadata` carries model_smart_selection_meta; `timing_cost` can carry
//     provider_model_name.
//
// This probe reproduces probe-trae-chat.ts's known-good official wire exactly
// (same headers, same body generator), requires the control to pass, then
// varies ONLY the selection fields. A failing control makes the run invalid.
//
// Usage:
//   bun run scripts/provider-probing/trae/trae-auto-selection-probe.ts \
//     --creds C:/Users/Aria/Desktop/trae-accounts-<ts>.json
//
// Tokens are never printed.

import { parseArgs } from "node:util";
import {
  maskSecret,
  pickAccount,
  readAccountsFile,
  requireAccountToken,
} from "../lib/accounts";
import { buildTraeHeaders } from "../../../src/providers/integrations/trae/trae-headers";
import {
  TRAE_AGENT_CHAT_PATH,
  TRAE_REALMS,
} from "../../../src/providers/integrations/trae/trae-realm";
import {
  parseTraeSse,
  toTraeAgentBody,
  type TraeChatBody,
} from "../../../src/providers/integrations/trae/trae-protocol";

const args = parseArgs({
  options: {
    creds: { type: "string", required: true },
    host: { type: "string" },
    message: { type: "string", default: "How are you?" },
  },
});
const v = args.values;
const CORE = v.host ?? TRAE_REALMS.intl.core;

const account = pickAccount(readAccountsFile(v.creds!), { providerId: "trae" });
const token = requireAccountToken(account);
// The official probe reads authState.userId; this export has none, so the
// device fingerprint is the same "anonymous" derivation it used. Keeping the
// uid identical matters: a different X-Device-Id got 4015 in the first run.
const uid = String(account.authState?.userId ?? "").trim();
console.log(`account: ${account.label ?? "?"} uid: ${uid || "(none)"} token: ${maskSecret(token)}`);
console.log(`host: ${CORE}`);

// Byte-for-byte the header set probe-trae-chat.ts --agent uses, including the
// harness semver headers and traffic class `agent` (NOT `chat`).
const headers = buildTraeHeaders({
  realm: "intl",
  token,
  uid,
  stream: true,
  extra: {
    "x-ide-token": null,
    "store-country-code": null,
    "X-App-Version": "3.6.13",
    "X-App-Version-Code": "3.6.13",
    "x-ide-version": "3.6.13",
    "request-traffic-type": "agent",
  },
});

const officialChatBody = {
  messages: [{ role: "user", content: [{ type: "text", text: v.message! }] }],
  stream: true,
  region: TRAE_REALMS.intl.region,
  ai_region: TRAE_REALMS.intl.region,
  temperature: 0.7,
  top_p: 0.95,
  model_name: "gpt-5.4",
  Request: {},
} as unknown as TraeChatBody;
const control: Record<string, unknown> = toTraeAgentBody(officialChatBody);

/** Removes the explicit model identity from the agent body. */
function withoutIdentity(): Record<string, unknown> {
  const draft = { ...control };
  delete draft["config_name"];
  delete draft["config_source"];
  delete draft["model_name"];
  return draft;
}

interface Variant {
  readonly label: string;
  readonly body: Record<string, unknown>;
}
const variants: readonly Variant[] = [
  { label: "control (official gpt-5.4)", body: control },
  {
    label: "legacy auto: model_auto_selection.strategy=auto + config identity",
    body: { ...control, model_auto_selection: { strategy: "auto" } },
  },
  {
    label: "legacy auto: model_auto_selection.strategy=auto, no config identity",
    body: { ...withoutIdentity(), model_auto_selection: { strategy: "auto" } },
  },
  {
    label: "legacy auto: strategy=auto + config_name empty",
    body: { ...control, config_name: "", model_auto_selection: { strategy: "auto" } },
  },
  {
    label: "legacy max sanity: model_auto_selection.strategy=max + config identity",
    body: { ...control, model_auto_selection: { strategy: "max" } },
  },
  {
    label: "legacy manual sanity: model_auto_selection.strategy=manual",
    body: { ...control, model_auto_selection: { strategy: "manual" } },
  },
  {
    label: "new ChatSessionService shape: model_selection_strategy=auto, model_name empty, no custom_model",
    body: {
      ...withoutIdentity(),
      model_name: "",
      model_selection_strategy: "auto",
      agent_type: "solo_agent",
    },
  },
  {
    label: "hybrid: both strategy fields + no config identity",
    body: {
      ...withoutIdentity(),
      model_name: "",
      model_selection_strategy: "auto",
      model_auto_selection: { strategy: "auto" },
    },
  },
  {
    label: "bare: no config identity, no strategy field",
    body: withoutIdentity(),
  },
  {
    label: "negative: config_name=auto + strategy=auto",
    body: { ...control, config_name: "auto", model_auto_selection: { strategy: "auto" } },
  },
];

interface Outcome {
  readonly ok: boolean;
  readonly events: readonly string[];
  readonly error: string;
  readonly resolved: string;
  readonly raw: string;
}

async function postAgent(body: Record<string, unknown>): Promise<Outcome> {
  const response = await fetch(CORE + TRAE_AGENT_CHAT_PATH, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(45_000),
  });
  const text = await response.text();
  const sse = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
  const events: string[] = [];
  const resolved: string[] = [];
  let error = "";
  for await (const frame of parseTraeSse(sse)) {
    events.push(frame.event);
    const data = frame.data;
    if (typeof data !== "object" || data === null) continue;
    const record = data as Record<string, unknown>;
    if (frame.event === "error") {
      error = `code=${String(record["code"] ?? "?")} ${String(record["message"] ?? "")}`.trim();
    }
    if (frame.event === "metadata") {
      const meta = record["model_smart_selection_meta"];
      if (typeof meta === "object" && meta !== null) {
        const m = meta as Record<string, unknown>;
        resolved.push(`metadata.mode=${String(m["mode"] ?? "")} config=${String(m["config_name"] ?? "")}`);
        console.log(`    metadata.model_smart_selection_meta: ${JSON.stringify(m).slice(0, 600)}`);
      }
    }
    if (frame.event === "model_config") {
      resolved.push(`model_config=${JSON.stringify(record).slice(0, 400)}`);
      console.log(`    model_config: ${JSON.stringify(record).slice(0, 600)}`);
    }
    if (frame.event === "timing_cost" && typeof record["provider_model_name"] === "string") {
      resolved.push(`timing_cost.provider_model_name=${record["provider_model_name"]}`);
    }
    if (typeof record["config_name"] === "string" && frame.event !== "model_config") {
      resolved.push(`${frame.event}.config_name=${record["config_name"]}`);
    }
  }
  const uniq = [...new Set(events)];
  const ok =
    !error &&
    uniq.some((event) => event === "metadata" || event === "output" || event === "timing_cost" || event === "token_usage" || event === "done");
  return { ok, events: uniq, error, resolved: [...new Set(resolved)].join(" | "), raw: text };
}

console.log(`\n=== POST ${TRAE_AGENT_CHAT_PATH} (official wire + Auto variants) ===`);
let controlPassed = false;
for (const variant of variants) {
  console.log(`\n[${variant.label}]`);
  console.log(`  body selection fields: ${JSON.stringify(Object.fromEntries(Object.entries(variant.body).filter(([key]) => /model|config|strategy|agent_type/.test(key))))}`);
  try {
    const outcome = await postAgent(variant.body);
    console.log(`  http events: ${outcome.events.join(", ") || "(none)"}`);
    if (outcome.error) console.log(`  error: ${outcome.error}`);
    if (outcome.resolved) console.log(`  resolved: ${outcome.resolved}`);
    console.log(`  verdict: ${outcome.ok ? "PASS" : "FAIL"}`);
    if (!outcome.ok) console.log(`  raw head: ${outcome.raw.slice(0, 400).replace(/\n/g, " | ")}`);
    if (variant.label.startsWith("control")) {
      controlPassed = outcome.ok;
      if (!controlPassed) {
        console.log("\nCONTROL FAILED — the run is invalid; stopping before interpreting Auto variants.");
        break;
      }
    }
  } catch (error) {
    console.log(`  ERROR: ${error instanceof Error ? error.message : String(error)}`);
    if (variant.label.startsWith("control")) {
      console.log("\nCONTROL FAILED — stopping.");
      break;
    }
  }
}
console.log(`\ncontrol passed: ${controlPassed}`);
