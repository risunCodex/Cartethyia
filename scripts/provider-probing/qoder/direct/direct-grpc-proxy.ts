/**
 * gRPC direct hit THROUGH mitmproxy (capture mode).
 *
 * grpc-js reads `HTTPS_PROXY` when `grpc.enable_http_proxy` is left at its
 * default (1). The worker/adapter sets it to 0; this probe deliberately does
 * NOT set it, so the gRPC stream is tunneled through mitmproxy and captured.
 *
 * Usage (run with proxy env):
 *   HTTPS_PROXY=http://127.0.0.1:18443 HTTP_PROXY=http://127.0.0.1:18443 \
 *   SSL_CERT_FILE=D:/tmp/scratch/mitmproxy/mitmproxy-ca-cert.pem \
 *   bun run scripts/provider-probing/qoder/direct/direct-grpc-proxy.ts \
 *     --creds <accounts.json> --model dfmodel --prompt "Halo" [--prompt-file f]
 */
import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHAT_PROTO_SOURCE } from "../../../../src/providers/integrations/qoder/chat-proto";
import { qoderGrpcHost, type QoderRealm } from "../../../../src/providers/integrations/qoder/qoder-realm";
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
console.log(`account=${account.label ?? "?"} token=${token.slice(0, 4)}…${token.slice(-4)} userId=${userId}`);

const VERSION = "1.1.83";
const realm: QoderRealm = values.realm === "cn" ? "cn" : "intl";
const promptText = values["prompt-file"] !== undefined
  ? readFileSync(values["prompt-file"], "utf8")
  : values.prompt!;

function sessionIdFor(uid: string, model: string): string {
  return createHash("sha256").update(`qoder-session:${uid}:${model}`).digest("hex").slice(0, 32);
}

// --- proto materialization (copy of lib/grpc.ts, proxy-enabled) ---
let protoPathCache: string | undefined;
function materializeChatProto(): string {
  if (protoPathCache !== undefined) return protoPathCache;
  const dir = mkdtempSync(join(tmpdir(), "cartethyia-qoder-grpc-proxy-"));
  const path = join(dir, "chat.proto");
  writeFileSync(path, CHAT_PROTO_SOURCE);
  process.on("exit", () => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });
  protoPathCache = path;
  return path;
}

const packageDefinition = protoLoader.loadSync(materializeChatProto(), {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: false,
  oneofs: true,
});
const proto = grpc.loadPackageDefinition(packageDefinition) as unknown as {
  model: { chat: { ChatService: new (address: string, credentials: grpc.ChannelCredentials, options?: Partial<grpc.ChannelOptions>) => { ChatCompletionStream(req: unknown, md?: grpc.Metadata): grpc.ClientDuplexStream<unknown, any>; close(): void } } };
};

const host = qoderGrpcHost(realm);
// NOTE: deliberately NO `grpc.enable_http_proxy: 0` — default (1) lets
// grpc-js pick up HTTPS_PROXY and tunnel through mitmproxy.
const channelOptions: Record<string, number | string> = {
  "grpc.default_authority": host,
  "grpc.ssl_target_name_override": host,
  "grpc.max_receive_message_length": 32 * 1024 * 1024,
  "grpc.max_send_message_length": 32 * 1024 * 1024,
};
const service = new proto.model.chat.ChatService(`${host}:443`, grpc.credentials.createSsl(), channelOptions);

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
      context_length: String(promptText.length),
    },
    business: { product: "cli", type: "agent", version: VERSION, scene: "assistant" },
  },
};

const metadata = new grpc.Metadata();
metadata.set("authorization", `Bearer ${token}`);
metadata.set("x-request-id", randomUUID());
metadata.set("x-session-id", sessionId);
metadata.set("cosy-version", VERSION);
metadata.set("cosy-clienttype", "5");
metadata.set("cosy-machineos", machineOs());
const hostname = machineHostname();
if (hostname.length > 0) metadata.set("cosy-machinehostname", hostname);

console.log(`grpc host=${host}:443 (via proxy, enable_http_proxy=default)`);
console.log(`model=${values.model} promptChars=${promptText.length}`);

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
stream.on("data", (chunk: any) => {
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
  console.log("\n=== gRPC result (proxy capture) ===");
  console.log(`chunks=${chunks}`);
  console.log(`model_echo=${firstModel ?? "(none)"}`);
  if (reasoning) console.log(`reasoning(len=${reasoning.length}): ${reasoning.slice(0, 200)}`);
  console.log(`answer(len=${answer.length}): ${answer.slice(0, 300) || "(empty)"}`);
  if (usageStr) console.log(`usage=${usageStr}`);
  if (initialState) console.log(`initial_metadata=${initialState}`);
  if (finalTrailers) console.log(`trailers=${finalTrailers}`);
  process.exit(0);
}
