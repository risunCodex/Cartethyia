/**
 * Qoder legacy COSY chat reply probe — streams the full response so we can
 * see whether the legacy surface actually produces a model answer on a free
 * account (tests the 200 found by the transport probe end-to-end).
 *   bun run scripts/provider-probing/qoder/qoder-legacy-reply.ts \
 *     --creds D:\tmp\scratch\qoder-new.json [--model qfmodel]
 */
import { parseArgs } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import {
  pickAccount,
  readAccountsFile,
  requireAccountToken,
} from "../lib/accounts";
import { buildCosyHeaders, transformQoderBody } from "./cosy-signer";

const args = parseArgs({
  options: {
    creds: { type: "string", required: true },
    label: { type: "string" },
    model: { type: "string", default: "qfmodel" },
    timeout: { type: "string", default: "30000" },
  },
});

const j = readAccountsFile(args.values.creds!);
const account = pickAccount(j, {
  ...(args.values.label !== undefined ? { label: args.values.label } : {}),
});
const token = requireAccountToken(account);
const userId = account.authState?.userId ?? "";
const model = args.values.model!;
const VERSION = "1.1.80";
const LEGACY_URL = "https://api2.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1";

const auth = {
  userId,
  userName: account.label ?? "",
  userType: "personal_standard",
  securityOauthToken: token,
  refreshToken: "",
};

const rid = randomUUID();
const sessionId = createHash("sha256").update(`qoder-session:${userId}:${model}`).digest("hex").slice(0, 32);
const body = {
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
};

const rawBody = JSON.stringify(body);
const encoded = transformQoderBody(rawBody);
const headers = {
  ...buildCosyHeaders(LEGACY_URL, rawBody, auth, VERSION),
  Accept: "text/event-stream",
};

console.log(`account=${account.label ?? "?"} token=${requireAccountToken(account).slice(0, 6)}… model=${model}`);
console.log(`POST ${LEGACY_URL}`);
try {
  const res = await fetch(LEGACY_URL, {
    method: "POST",
    headers,
    body: encoded as unknown as BodyInit,
    signal: AbortSignal.timeout(Number(args.values.timeout)),
  });
  console.log(`status=${res.status} content-type=${res.headers.get("content-type") ?? ""}`);
  if (res.status >= 300 || !res.body) {
    console.log("body:", (await res.text()).slice(0, 600));
    process.exit(0);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let frames = 0;
  let text = "";
  let reasoning = "";
  let stopped = false;
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
          if (data === "[DONE]") {
            stopped = true;
            continue;
          }
          try {
            const json = JSON.parse(data) as {
              body?: string;
              choices?: Array<{ delta?: { content?: string; reasoning_content?: string }; finish_reason?: string | null }>;
              error?: unknown;
            };
            // Legacy surface wraps chunks: {headers, body: "<json>"} or {body: <json>}
            let inner = json;
            if (typeof json.body === "string") {
              try {
                inner = JSON.parse(json.body);
              } catch {
                /* keep outer */
              }
            }
            if (inner.error !== undefined) {
              console.log("  error:", JSON.stringify(inner.error).slice(0, 400));
              stopped = true;
              continue;
            }
            const d = inner.choices?.[0]?.delta;
            if (d) {
              if (typeof d.content === "string") text += d.content;
              if (typeof d.reasoning_content === "string") reasoning += d.reasoning_content;
            }
            const fr = inner.choices?.[0]?.finish_reason;
            if (fr) stopped = true;
          } catch {
            // non-JSON frame
          }
        }
        if (stopped && text.length > 0) break;
        idx = buf.indexOf("\n\n");
      }
      if (stopped && text.length > 0) break;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  console.log(`frames=${frames} stopped=${stopped}`);
  if (reasoning) console.log("reasoning:", reasoning.slice(0, 600));
  console.log("text:", JSON.stringify(text.slice(-800)));
} catch (e) {
  console.log("ERROR:", e instanceof Error ? e.message : String(e));
  process.exit(1);
}
