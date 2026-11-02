/**
 * Qoder transport probe — legacy COSY /algo, modern /model/v1, and gRPC
 * (best-effort). Tests the same account across every surface the IDE supports.
 *   bun run scripts/provider-probing/qoder/qoder-transport-probe.ts \
 *     --creds D:\tmp\scratch\qoder-new.json [--model qfmodel]
 */
import { parseArgs } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { hostname as osHostname } from "node:os";
import {
  pickAccount,
  readAccountsFile,
  requireAccountToken,
} from "../lib/accounts";
import { buildCosyHeaders, transformQoderBody } from "./cosy-signer";

const args = parseArgs({
  options: {
    creds: { type: "string", required: true },
    model: { type: "string", default: "qfmodel" },
  },
});

const j = readAccountsFile(args.values.creds!);
const account = pickAccount(j);
const token = requireAccountToken(account);
const userId = account.authState?.userId ?? "";
const model = args.values.model!;
const VERSION = "1.1.80";

const auth = {
  userId,
  userName: account.label ?? "",
  userType: "personal_standard",
  securityOauthToken: token,
  refreshToken: "",
};

function machineOs(): string {
  const arch = process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : process.arch;
  return `${arch}_${process.platform}`;
}

function machineHostname(): string {
  const raw = (osHostname() ?? "").trim().toLowerCase();
  const safe = raw
    .replace(/[^\x21-\x7e]+/gu, "-")
    .replace(/-{2,}/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return safe.length <= 96 ? safe : `${safe.slice(0, 87)}-${createHash("sha256").update(safe).digest("hex").slice(0, 8)}`;
}

const LEGACY_URL = "https://api2.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1";
const IDE_URL = "https://api2-v2.qoder.sh/model/v1/chat/completions";

function legacyBody() {
  const rid = randomUUID();
  const sessionId = createHash("sha256").update(`qoder-session:${userId}:${model}`).digest("hex").slice(0, 32);
  return {
    body: {
      request_id: rid,
      request_set_id: rid,
      chat_record_id: rid,
      session_id: sessionId,
      stream: true,
      chat_task: "FREE_INPUT",
      is_reply: true,
      is_retry: false,
      source: 1,
      version: "3",
      session_type: "qodercli",
      agent_id: "agent_common",
      task_id: "common",
      code_language: "",
      chat_prompt: "",
      image_urls: null,
      chat_context: {
        chatPrompt: "",
        imageUrls: null,
        extra: { context: [], modelConfig: { key: model, is_reasoning: true }, originalContent: { text: "ping" } },
        features: [],
        text: { text: "ping" },
      },
      model_config: {
        key: model,
        display_name: "Qwen3.8-Flash",
        format: "openai",
        model: "",
        api_key: "",
        url: "",
        is_vl: true,
        is_reasoning: true,
        max_input_tokens: 180000,
        max_output_tokens: 65536,
        source: "system",
      },
      messages: [{ role: "user", content: "ping" }],
      max_tokens: 256,
      tools: [],
      parallel_tool_calls: true,
    },
    rid,
  };
}

function ideBody() {
  const rid = randomUUID();
  const sid = randomUUID();
  return {
    body: {
      model,
      messages: [{ role: "user", content: "ping" }],
      stream: true,
      stream_options: { include_usage: true },
      metadata: {
        context: {
          request_id: rid,
          request_set_id: randomUUID(),
          session_id: sid,
          source_session_id: "",
          task_id: "common",
          client_type: "5",
        },
        business: {
          business_product: "cli",
          business_type: "agent",
          business_version: VERSION,
          scene: "assistant",
        },
      },
    },
    rid,
    sid,
  };
}

function ideHeaders(rid: string, sid: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    "X-Request-ID": rid,
    "X-Session-ID": sid,
    "Cosy-Version": VERSION,
    "Cosy-ClientType": "5",
    "Cosy-MachineOS": machineOs(),
    "Cosy-MachineHostname": machineHostname(),
  };
}

async function run(label: string, url: string, headers: Record<string, string>, rawBody: string) {
  try {
    const res = await fetch(url, { method: "POST", headers, body: rawBody, signal: AbortSignal.timeout(25000) });
    const text = await res.text();
    console.log(`\n=== ${label} ===`);
    console.log(`status=${res.status} content-type=${res.headers.get("content-type") ?? ""}`);
    if (text.includes("data:")) {
      console.log("head:", JSON.stringify(text.slice(0, 200)));
    } else {
      console.log("body:", text.slice(0, 400));
    }
  } catch (e) {
    console.log(`\n=== ${label} === ERROR: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// 1. Legacy COSY surface (signed body like the native client)
{
  const b = legacyBody();
  const encoded = transformQoderBody(JSON.stringify(b.body));
  const headers = buildCosyHeaders(LEGACY_URL, JSON.stringify(b.body), auth, VERSION);
  await run("legacy/cosy (signed body)", LEGACY_URL, { ...headers, Accept: "text/event-stream" }, Buffer.from(encoded).toString("utf8"));
}

// 2. Modern IDE surface
{
  const b = ideBody();
  await run("http/ide /model/v1 (plain bearer)", IDE_URL, ideHeaders(b.rid, b.sid), JSON.stringify(b.body));
}

// 3. Legacy surface with plain bearer (no COSY signature) for comparison
{
  const b = legacyBody();
  const rid = b.rid;
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    "X-Request-ID": rid,
    "X-Session-ID": rid,
    "Cosy-Version": VERSION,
    "Cosy-ClientType": "5",
    "Cosy-MachineOS": machineOs(),
    "Cosy-MachineHostname": machineHostname(),
  };
  await run("legacy/plain-bearer (no sig)", LEGACY_URL, headers, JSON.stringify(b.body));
}
