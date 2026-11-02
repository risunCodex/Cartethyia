/**
 * GitHub Copilot reasoning-wire probe.
 *
 * Fires a real `/chat/completions` request against the account's Copilot API
 * host and prints, for every SSE delta:
 *
 *   - every field it carries (`content`, `reasoning_content`, `reasoning`,
 *     `reasoning_summary`, `reasoning_text`, `summary`, …) together with its
 *     JSON shape (string vs object/array), so a wire shape that our parser
 *     does not read is visible immediately;
 *   - the result of the gateway's own `readReasoningText(delta)` on that
 *     delta, so we can see where the parser disagrees with the wire.
 *
 * The point is the thinking stream: Copilot models (gpt-6-luna and friends)
 * DO emit reasoning, and the gateway parser was dropping some shapes. Run with
 * a long prompt to actually trigger thinking.
 *
 * Usage:
 *   bun run scripts/provider-probing/github/github-copilot-reasoning-probe.ts \
 *     --creds "C:\Users\...\github-accounts-<ts>.json" \
 *     --model gpt-6-luna --effort xhigh --stream
 *   bun run scripts/provider-probing/github/github-copilot-reasoning-probe.ts \
 *     --creds <file> --model auto --effort high --stream
 *   bun run scripts/provider-probing/github/github-copilot-reasoning-probe.ts \
 *     --creds <file> --effect gpt-6-luna-high --effort auto
 *
 * `--effort auto` omits `reasoning_effort` (upstream default). The script
 * never prints full credentials.
 */
import { parseArgs } from "node:util";
import {
  maskSecret,
  maskUuid,
  pickAccount,
  readAccountsFile,
} from "../lib/accounts";
import { parseGithubCredential } from "../../../src/providers/integrations/github/github-oauth";
import { GITHUB_REQUEST_HEADERS } from "../../../src/providers/integrations/github/github-oauth";
import { readReasoningText } from "../../../src/providers/provider-usage";
import { decodeSseEvents } from "../../../src/protocol/sse-decoder";

const DEFAULT_MODEL = "gpt-6-luna";
const EFFORTS = ["auto", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** A long prompt that forces multi-step reasoning (triggers thinking). */
const LONG_TRIGGER_PROMPT = [
  "You are a senior compiler engineer. Work through the following problem step by step,",
  "showing every intermediate deduction before the final answer.",
  "",
  "Problem: a custom allocator uses a segregated free list with 64 size classes,",
  "each class doubling in size from 16 bytes. It tracks a 64-bit bitmap per class of",
  "which blocks are free. Write the exact bit-twiddling routine that, given a request",
  "size, finds the smallest class index, extracts a free block, and updates the bitmap",
  "using only integer operations — and prove the worst-case number of instructions for",
  "the bitmap update is constant regardless of class occupancy.",
  "",
  "Then explain what changes when the allocator is moved to a 32-bit target and the",
  "bitmap must be split across two words, including the carry propagation across the",
  "word boundary and a correctness argument for the split case.",
  "",
  "Finally, derive a memory-safety invariant (heap pointer + size) that holds at",
  "every allocation and free, and show which invariant is violated if the size-class",
  "doubling table is computed lazily instead of eagerly.",
].join("\n");

function shape(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `array[${value.length}]`;
  if (typeof value === "object") return `object{${Object.keys(value as Record<string, unknown>).join(",")}}`;
  return typeof value;
}

function summarize(value: unknown, max = 120): string {
  if (value === null || value === undefined) return "<none>";
  let text: string;
  if (typeof value === "string") {
    text = value;
  } else if (Array.isArray(value)) {
    text = JSON.stringify(value);
  } else {
    text = JSON.stringify(value);
  }
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

const { values } = parseArgs({
  options: {
    creds: { type: "string" },
    model: { type: "string", default: DEFAULT_MODEL },
    effort: { type: "string", default: "high" },
    label: { type: "string" },
    index: { type: "string" },
    timeout: { type: "string", default: "60000" },
    stream: { type: "string", default: "true" },
    prompt: { type: "string" },
    wire: { type: "string", default: "auto" },
    auto: { type: "string", default: "true" },
    summary: { type: "string" },
  },
});

const credsPath = values.creds;
if (credsPath === undefined) throw new Error("--creds <path> is required");

const effort = values.effort as string;
if (!EFFORTS.includes(effort as (typeof EFFORTS)[number])) {
  throw new Error(`--effort must be one of: ${EFFORTS.join(", ")}`);
}

const accounts = readAccountsFile(credsPath);
const account = pickAccount(accounts, {
  providerId: "github",
  ...(values.label !== undefined ? { label: values.label } : {}),
  ...(values.index !== undefined ? { index: Number(values.index) } : {}),
});

if (!account.accessToken) throw new Error(`Account "${account.label ?? account.id}" has no accessToken`);
let credential: ReturnType<typeof parseGithubCredential>;
try {
  credential = parseGithubCredential(account.accessToken);
} catch (error) {
  throw new Error(`Account "${account.label}" has an unparsable Copilot credential: ${error instanceof Error ? error.message : String(error)}`);
}

const model = values.model as string;
const timeoutMs = Number(values.timeout);
const useStream = values.stream !== "false";
const prompt = values.prompt ?? LONG_TRIGGER_PROMPT;

const controller = new AbortController();

// `gpt-6-luna` / `gpt-5.6-luna` are Auto models: the gateway first asks
// `POST /auto` with `{prompt, tier}`, receives a `selected_model` and a
// `session_token`, then dispatches to the selected model's endpoint with a
// `Copilot-Session-Token` header. Probing the selected model directly without
// that session token is refused with `model_not_supported`. So the probe:
//   1. POSTs /auto (when `--auto` or the model id is one of the Auto ids);
//   2. uses the returned session token + model for the real request.
const AUTO_TIERS: ReadonlyMap<string, "efficiency" | "balance" | "intelligence"> = new Map([
  ["auto", "balance"],
  ["gpt-6-luna", "efficiency"],
  ["gpt-5.6-luna", "efficiency"],
]);

let sessionToken: string | undefined;
let effectiveModel = model;
if (values.auto !== "false" && AUTO_TIERS.has(model.toLowerCase())) {
  const tier = AUTO_TIERS.get(model.toLowerCase())!;
  const autoPayload: Record<string, unknown> = { prompt, tier };
  const autoRes = await fetch(`https://${credential.apiHost}/auto`, {
    method: "POST",
    headers: {
      ...GITHUB_REQUEST_HEADERS,
      authorization: `Bearer ${credential.access}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(autoPayload),
    signal: controller.signal,
  });
  const autoText = await autoRes.text().catch(() => "");
  console.log(`  [auto] POST /auto -> HTTP ${autoRes.status}`);
  if (!autoRes.ok) {
    console.log(`  [auto] error: ${summarize(autoText, 500)}`);
    process.exit(1);
  }
  let autoJson: Record<string, unknown>;
  try {
    autoJson = JSON.parse(autoText) as Record<string, unknown>;
  } catch {
    console.log(`  [auto] non-JSON response: ${summarize(autoText, 300)}`);
    process.exit(1);
  }
  const selected = autoJson["selected_model"] as Record<string, unknown> | undefined;
  effectiveModel = typeof selected?.["id"] === "string" ? selected["id"] : model;
  sessionToken = typeof autoJson["session_token"] === "string" ? autoJson["session_token"] : undefined;
  console.log(`  [auto] selected_model=${effectiveModel} session_token=${sessionToken ? maskSecret(sessionToken, 6) : "<none>"}`);
}

const wire = (values.wire as "auto" | "chat" | "responses" | undefined) ?? "auto";
const useResponses =
  wire === "responses" ||
  (wire === "auto" && (effectiveModel.includes("luna") || effectiveModel.includes("mai-code")));

const path = useResponses ? "/responses" : "/chat/completions";
const url = `https://${credential.apiHost}${path}`;
const headers: Record<string, string> = {
  ...GITHUB_REQUEST_HEADERS,
  authorization: `Bearer ${credential.access}`,
  "content-type": "application/json",
  ...(sessionToken === undefined ? {} : { "Copilot-Session-Token": sessionToken }),
};

const body: Record<string, unknown> = useResponses
  ? {
      model: effectiveModel,
      input: [{ role: "user", content: [{ type: "input_text", text: prompt }] }],
      stream: useStream,
    }
  : {
      model: effectiveModel,
      messages: [{ role: "user", content: prompt }],
      stream: useStream,
    };
if (effort !== "auto") {
  if (useResponses) body["reasoning"] = { effort, summary: (values.summary as string) ?? "detailed" };
  else body["reasoning_effort"] = effort;
}

console.log(`\n[github] ${model} / effort=${effort} / stream=${useStream} / wire=${useResponses ? "responses" : "chat"}`);
console.log(`  url: ${url}`);
console.log(`  account: ${account.label ?? "?"} (${maskUuid(account.id ?? "")})`);
console.log(`  apiHost: ${credential.apiHost}`);
console.log(`  token: ${maskSecret(credential.access, 6)}`);
console.log(`  prompt chars: ${prompt.length}`);
console.log(`  body: ${JSON.stringify({ ...body, messages: [{ role: "user", content: `<${prompt.length} chars>` }] })}`);

const timer = setTimeout(() => controller.abort(), timeoutMs);
const response = await fetch(url, {
  method: "POST",
  headers,
  body: JSON.stringify(body),
  signal: controller.signal,
}).finally(() => clearTimeout(timer));

console.log(`\n  HTTP ${response.status} ${response.statusText}`);
console.log(`  content-type: ${response.headers.get("content-type") ?? ""}`);

if (!response.ok) {
  const text = await response.text().catch(() => "");
  console.log(`  error body (capped): ${summarize(text, 600)}`);
  process.exit(1);
}

if (!useStream) {
  const text = await response.text();
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (useResponses) {
      const output = parsed["output"] as Array<Record<string, unknown>> | undefined;
      console.log("\n  [responses output items]");
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for (const item of output ?? []) {
        if (typeof item !== "object" || item === null) continue;
        const type = item["type"];
        const content = item["content"] as Array<Record<string, unknown>> | undefined;
        console.log(`  - type=${type}`);
        for (const block of content ?? []) {
          const bt = block["type"];
          const textValue = block["text"] ?? block["summary"] ?? block["content"];
          console.log(`      block type=${bt} (${shape(block)}): ${summarize(textValue)}`);
        }
        if (item["summary"] !== undefined) {
          console.log(`      summary (${shape(item["summary"])}): ${summarize(item["summary"])}`);
        }
      }
    } else {
      const choice = (parsed["choices"] as Array<Record<string, unknown>> | undefined)?.[0];
      const msg = choice?.["message"] as Record<string, unknown> | undefined;
      console.log("\n  [non-stream message]");
      for (const [key, value] of Object.entries(msg ?? {})) {
        console.log(`    ${key} (${shape(value)}): ${summarize(value)}`);
      }
      const read = readReasoningText(msg ?? {});
      console.log(`\n  readReasoningText(message) => ${read === undefined ? "<none>" : `"${summarize(read, 200)}"`}`);
    }
  } catch {
    console.log(`  raw (capped): ${summarize(text, 600)}`);
  }
  process.exit(0);
}

let seq = 0;
let reasoningEvents = 0;
let textEvents = 0;
console.log("\n  [stream events]");
for await (const sse of decodeSseEvents(response.body, { signal: controller.signal })) {
  const data = sse.data.trim();
  if (data === "[DONE]") break;
  if (!data) continue;
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(data) as Record<string, unknown>;
  } catch {
    console.log(`  <unparsable frame> ${summarize(data, 120)}`);
    continue;
  }

  if (useResponses) {
    const type = json["type"];
    if (type === undefined) {
      console.log(`  frame keys=[${Object.keys(json).join(",")}]`);
      continue;
    }
    const event = json["event"] as string | undefined;
    const label = event ?? String(type);
    seq += 1;
    // Always print the raw event type and a compact view of its payload so no
    // event shape (summary deltas included) can slip past silently.
    const delta = json["delta"] as unknown;
    const item = json["item"] as Record<string, unknown> | undefined;
    const summary = json["summary"];
    const hasDeltaObject = typeof delta === "object" && delta !== null && !Array.isArray(delta);
    console.log(`  #${seq} ${label} type=${String(type)} delta=${shape(delta)} item=${item !== undefined ? shape(item) : "-"} summary=${shape(summary)}`);
    if (hasDeltaObject) {
      const deltaRecord = delta as Record<string, unknown>;
      for (const [key, value] of Object.entries(deltaRecord)) {
        const isReasoning = /reasoning|summary|think/i.test(key);
        if (isReasoning) reasoningEvents += 1;
        if (key === "text" || key === "content") textEvents += 1;
        console.log(`      ${isReasoning ? `REASONING>>${key}` : key} (${shape(value)}): ${summarize(value)}`);
      }
      const read = readReasoningText(deltaRecord);
      if (read !== undefined) {
        console.log(`      parse(readReasoningText) => "${summarize(read, 200)}"`);
      }
    } else if (typeof delta === "string" && delta.length > 0) {
      console.log(`      delta (string): ${summarize(delta)}`);
    }
    if (summary !== undefined) {
      console.log(`      top summary (${shape(summary)}): ${summarize(summary, 400)}`);
    }
    if (item !== undefined && typeof item === "object") {
      const itype = item["type"];
      const content = item["content"] as Array<Record<string, unknown>> | undefined;
      const itemKeys = Object.keys(item);
      console.log(`      item type=${itype} keys=[${itemKeys.join(",")}] (${shape(content)})`);
      if (item["summary"] !== undefined) {
        console.log(`        item.summary (${shape(item["summary"])}): ${summarize(item["summary"], 400)}`);
      }
      for (const block of content ?? []) {
        const bt = block["type"];
        const textValue = block["text"] ?? block["summary"] ?? block["content"];
        const isReasoning = /reasoning|summary|think/i.test(String(bt));
        if (isReasoning) reasoningEvents += 1;
        if (bt === "output_text") textEvents += 1;
        console.log(`        block ${bt} (${shape(block)}): ${summarize(textValue)}`);
      }
    }
    if (json["usage"] !== undefined) {
      console.log(`  usage: ${summarize(json["usage"], 300)}`);
    }
    continue;
  }

  const choices = (json["choices"] as Array<Record<string, unknown>> | undefined) ?? [];
  for (const choice of choices) {
    const delta = choice["delta"] as Record<string, unknown> | undefined;
    if (!delta) continue;
    seq += 1;
    const keys = Object.keys(delta);
    if (keys.length === 0) continue;
    const read = readReasoningText(delta);
    console.log(`  #${seq} keys=[${keys.join(",")}]`);
    for (const [key, value] of Object.entries(delta)) {
      let label = key;
      if (key === "content") label = "CONTENT";
      else if (/reasoning|summary|think/i.test(key)) {
        label = `REASONING>>${key}`;
        reasoningEvents += 1;
      }
      console.log(`      ${label} (${shape(value)}): ${summarize(value)}`);
    }
    if (read !== undefined) {
      console.log(`      parse(readReasoningText) => "${summarize(read, 200)}"`);
    }
    if (delta["content"] && String(delta["content"]).length > 0) textEvents += 1;
  }
  if (json["usage"] !== undefined) {
    console.log(`  usage: ${summarize(json["usage"], 300)}`);
  }
}

console.log(`\n  done: ${seq} deltas, ${reasoningEvents} reasoning-carrying, ${textEvents} content-carrying`);
