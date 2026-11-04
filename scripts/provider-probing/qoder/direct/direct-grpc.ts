/**
 * gRPC direct hit — `model.chat.ChatService/ChatCompletionStream`.
 *
 * Uses the vendored `chat.proto` + the worker's metadata shape (`Qyl`):
 * authorization Bearer, x-request-id, x-session-id, cosy-version/clienttype/
 * machineos/machinehostname. OAuth `dt-...` is used directly (no PAT exchange).
 * gRPC does NOT go through an HTTP proxy (grpc.enable_http_proxy=0).
 *
 * Usage:
 *   bun run scripts/provider-probing/qoder/direct/direct-grpc.ts \
 *     --creds <qoder-accounts-*.json> --model dfmodel \
 *     [--prompt "..." | --prompt-file <path>] [--timeout-ms 300000]
 */
import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import * as grpc from "@grpc/grpc-js";
import { createChatService, type GrpcChatChunk } from "../lib/grpc";
import type { QoderRealm } from "../../../../src/providers/integrations/qoder/qoder-realm";
import { machineOs, machineHostname } from "../lib/shared";

const { values } = parseArgs({
  options: {
    creds: { type: "string" },
    model: { type: "string", default: "dfmodel" },
    prompt: { type: "string", default: "Halo, perkenalkan dirimu singkat." },
    "prompt-file": { type: "string" },
    realm: { type: "string", default: "intl" },
    "timeout-ms": { type: "string", default: "300000" },
  },
});

const creds = values.creds;
if (!creds) throw new Error("--creds <path> is required");
const timeoutMs = Number(values["timeout-ms"]);
if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("--timeout-ms must be a positive number");

const raw = JSON.parse(readFileSync(creds, "utf8"));
const account = (Array.isArray(raw) ? raw : raw.accounts ?? [])[0];
const token = account.accessToken ?? account.token ?? "";
if (typeof token !== "string" || token.length === 0) throw new Error("no accessToken");
const userId: string = account.authState?.userId ?? "";
const machineId: string = account.authState?.machineId ?? randomUUID();
console.log(`account=${account.label ?? "?"} token=${token.slice(0, 4)}…${token.slice(-4)} userId=${userId} machineId=${machineId.slice(0, 8)}…`);

const VERSION = "1.1.83";
const realm: QoderRealm = values.realm === "cn" ? "cn" : "intl";
const promptText = values["prompt-file"] !== undefined
  ? readFileSync(values["prompt-file"], "utf8")
  : values.prompt!;

function sessionIdFor(uid: string, model: string): string {
  return createHash("sha256").update(`qoder-session:${uid}:${model}`).digest("hex").slice(0, 32);
}

// --- Request (proto shape, worker mirror) ---
const sessionId = sessionIdFor(userId, values.model!);
const request = {
  model: values.model,
  messages: [{ role: "user", text_content: promptText }],
  stream: { value: true },
  stream_options: { include_usage: { value: true } },
  max_tokens: { value: 128 },
  tools: [],
  metadata: {
    context: {
      request_id: randomUUID(),
      session_id: sessionId,
      task_id: "common",
      request_set_id: randomUUID(),
      client_type: "5",
      source_session_id: "",
      context_length: "8000000",
    },
    business: { product: "cli", type: "agent", version: VERSION, scene: "assistant" },
  },
};

// --- Metadata (worker Qyl) ---
const metadata = new grpc.Metadata();
metadata.set("authorization", `Bearer ${token}`);
metadata.set("x-request-id", randomUUID());
metadata.set("x-session-id", sessionId);
metadata.set("cosy-version", VERSION);
metadata.set("cosy-clienttype", "5");
metadata.set("cosy-machineos", machineOs());
const hostname = machineHostname();
if (hostname.length > 0) metadata.set("cosy-machinehostname", hostname);

console.log(`grpc host=${realm === "cn" ? "gateway.qoder.com.cn" : "api2-v2.qoder.sh"}:443`);
console.log(`model=${values.model} promptChars=${promptText.length}`);

// --- Stream ---
const { service } = createChatService(realm);
const stream = service.ChatCompletionStream(request, metadata);

let answer = "";
let reasoning = "";
let firstModel: string | undefined;
let chunks = 0;
let usageStr = "";
let initialState = "";
let finalTrailers = "";

stream.on("metadata", (m: grpc.Metadata) => {
  initialState = JSON.stringify(Object.fromEntries(Object.entries(m.getMap()).map(([k, v]) => [k, Array.isArray(v) ? v : [String(v)]])));
});
stream.on("status", (s: grpc.StatusObject) => {
  finalTrailers = JSON.stringify(Object.fromEntries(Object.entries(s.metadata.getMap()).map(([k, v]) => [k, Array.isArray(v) ? v : [String(v)]])));
});
stream.on("data", (chunk: GrpcChatChunk) => {
  chunks += 1;
  if (chunk.model !== undefined && firstModel === undefined) firstModel = chunk.model;
  if (chunk.usage) usageStr = JSON.stringify(chunk.usage);
  for (const choice of chunk.choices ?? []) {
    const delta = choice.delta ?? {};
    if (typeof delta.content === "string") answer += delta.content;
    if (typeof delta.reasoning_content === "string") reasoning += delta.reasoning_content;
  }
});
stream.on("end", () => {
  service.close();
  printResult();
});
stream.on("error", (err) => {
  console.log(`STREAM_ERROR: ${err.message}`);
  service.close();
  printResult();
});

const timer = setTimeout(() => {
  console.log("TIMEOUT — cancelling");
  try {
    stream.cancel();
  } catch {
    // ignore
  }
}, timeoutMs);

function printResult(): void {
  clearTimeout(timer);
  console.log("\n=== gRPC result ===");
  console.log(`chunks=${chunks}`);
  console.log(`model_echo=${firstModel ?? "(none)"}`);
  if (reasoning) console.log(`reasoning(len=${reasoning.length}): ${reasoning.slice(0, 300)}`);
  console.log(`answer(len=${answer.length}): ${answer.slice(0, 500) || "(empty)"}`);
  if (usageStr) console.log(`usage=${usageStr}`);
  if (initialState) console.log(`initial_metadata=${initialState}`);
  if (finalTrailers) console.log(`trailers=${finalTrailers}`);
  process.exit(0);
}
