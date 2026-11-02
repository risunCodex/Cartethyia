/**
 * Qoder response-shape probe — prints the `model` field (and envelope shape)
 * returned by each HTTP transport for the same account: legacy /algo COSY and
 * modern /model/v1. The gRPC surface comparison lives in the standalone probe
 * at D:\tmp\grpc-probe\ (it needs @grpc deps not present in this repo).
 *   bun run scripts/provider-probing/qoder/qoder-response-shape.ts \
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
    timeout: { type: "string", default: "25000" },
  },
});

const j = readAccountsFile(args.values.creds!);
const account = pickAccount(j);
const token = requireAccountToken(account);
const userId = account.authState?.userId ?? "";
const model = args.values.model!;
const VERSION = "1.1.80";
const LEGACY_URL = "https://api2.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1";
const IDE_URL = "https://api2-v2.qoder.sh/model/v1/chat/completions";

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
      },
    },
    rid,
    sid,
  };
}

// ---------- 1. legacy COSY ----------
console.log("\n========== 1) LEGACY COSY /algo ==========");
{
  const b = legacyBody();
  const rawBody = JSON.stringify(b.body);
  const encoded = transformQoderBody(rawBody);
  const headers = { ...buildCosyHeaders(LEGACY_URL, rawBody, auth, VERSION), Accept: "text/event-stream" };
  try {
    const res = await fetch(LEGACY_URL, { method: "POST", headers, body: encoded as unknown as BodyInit, signal: AbortSignal.timeout(Number(args.values.timeout)) });
    console.log(`HTTP ${res.status} content-type=${res.headers.get("content-type") ?? ""}`);
    if (res.status >= 300 || !res.body) {
      console.log("body:", (await res.text()).slice(0, 400));
    } else {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let frames = 0;
      const seenModels = new Set<string>();
      let text = "";
      try {
        while (frames < 200) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let idx = buf.indexOf("\n\n");
          while (idx >= 0) {
            const chunk = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            frames++;
            for (const line of chunk.split(/\r?\n/)) {
              if (!line.startsWith("data:")) continue;
              const data = line.slice(5).trim();
              try {
                const outer = JSON.parse(data) as any;
                let inner = outer;
                if (typeof outer.body === "string") {
                  try { inner = JSON.parse(outer.body); } catch {}
                }
                if (inner?.model) seenModels.add(String(inner.model));
                if (inner?.object) {
                  // only log object type first time per frame is fine
                }
                const d = inner?.choices?.[0]?.delta;
                if (d && typeof d.content === "string") text += d.content;
              } catch {}
            }
            idx = buf.indexOf("\n\n");
          }
        }
      } finally {
        await reader.cancel().catch(() => undefined);
      }
      console.log(`frames=${frames} streaming=true`);
      console.log(`model fields seen: ${seenModels.size ? [...seenModels].join(", ") : "(none)"}`);
      console.log(`text=${JSON.stringify(text.slice(0, 120))}`);
    }
  } catch (e) {
    console.log("ERROR:", e instanceof Error ? e.message : String(e));
  }
}

// ---------- 2. http /model/v1 ----------
console.log("\n========== 2) HTTP /model/v1 ==========");
{
  const b = ideBody();
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    "X-Request-ID": b.rid,
    "X-Session-ID": b.sid,
    "Cosy-Version": VERSION,
    "Cosy-ClientType": "5",
    "Cosy-MachineOS": machineOs(),
    "Cosy-MachineHostname": machineHostname(),
  };
  try {
    const res = await fetch(IDE_URL, { method: "POST", headers, body: JSON.stringify(b.body), signal: AbortSignal.timeout(Number(args.values.timeout)) });
    console.log(`HTTP ${res.status} content-type=${res.headers.get("content-type") ?? ""}`);
    console.log("raw body:", (await res.text()).slice(0, 400));
  } catch (e) {
    console.log("ERROR:", e instanceof Error ? e.message : String(e));
  }
}

// gRPC ChatCompletionStream comparison lives in the standalone probe at
// D:\tmp\grpc-probe\ (needs @grpc/grpc-js + @grpc/proto-loader).

