/**
 * Tool-calling probe across all Qoder surfaces: COSY, IDE/HTTP, gRPC.
 *
 * Builds a chat request carrying one `function` tool (get_weather) and a
 * prompt that forces the model to call it, then prints the tool-call deltas
 * (id / name / accumulated arguments) plus any text, per surface.
 *
 * Auth: OAuth device token (`dt-...`) used directly on all surfaces.
 *   - cosy: signed (COSY Bearer + scrambled body)
 *   - ide:  plain Bearer + JSON body  (`/model/v1`)
 *   - grpc: Bearer metadata + proto stream (`ChatService`)
 *
 * Usage:
 *   bun run scripts/provider-probing/qoder/direct/direct-toolcall.ts \
 *     --creds <accounts.json> --surface cosy|ide|grpc|all \
 *     --model cmodel [--prompt "…"] [--tool-name get_weather] \
 *     [--timeout-ms 120000]
 */
import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import * as grpc from "@grpc/grpc-js";
import { createChatService, type GrpcChatChunk } from "../lib/grpc";
import type { QoderRealm } from "../../../../src/providers/integrations/qoder/qoder-realm";
import { buildCosyHeaders, transformQoderBody } from "../cosy-signer";
import { machineOs, machineHostname } from "../lib/shared";

const { values } = parseArgs({
  options: {
    creds: { type: "string" },
    surface: { type: "string", default: "ide,grpc" },
    model: { type: "string", default: "cmodel" },
    prompt: { type: "string", default: "" },
    "tool-name": { type: "string", default: "get_weather" },
    "tool-desc": { type: "string", default: "Get current weather for a city" },
    realm: { type: "string", default: "intl" },
    "timeout-ms": { type: "string", default: "120000" },
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
const model = values.model!;
const prompt =
  values.prompt! || `Panggil tool ${values["tool-name"]} dengan parameter kota "Jakarta". Jawab singkat.`;

const toolName = values["tool-name"]!;
const toolDesc = values["tool-desc"]!;
const toolSchema = {
  type: "object",
  properties: {
    city: { type: "string", description: "City name" },
  },
  required: ["city"],
};

// ---------------------------------------------------------------- helpers ----
function sessionIdFor(uid: string, m: string): string {
  return createHash("sha256").update(`qoder-session:${uid}:${m}`).digest("hex").slice(0, 32);
}

// OpenAI-shaped tool declaration (shared by cosy + ide bodies)
function toolDecl(): Record<string, unknown> {
  return { type: "function", function: { name: toolName, description: toolDesc, parameters: toolSchema } };
}

function sessionId(): string {
  return sessionIdFor(userId, model);
}

// ---------------------------------------------------------------- COSY -------
const COSY_URL =
  "https://api1.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1";

function cosyBody(): Record<string, unknown> {
  const rid = randomUUID();
  return {
    request_id: rid,
    request_set_id: rid,
    chat_record_id: rid,
    session_id: sessionId(),
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
      extra: { context: [], modelConfig: { key: model, is_reasoning: true }, originalContent: { text: prompt } },
      features: [],
      text: { text: prompt },
    },
    model_config: {
      key: model,
      display_name: model,
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
    messages: [{ role: "user", content: prompt }],
    max_tokens: 256,
    tools: [toolDecl()],
    tool_choice: "auto",
    parallel_tool_calls: true,
  };
}

async function hitCosy(): Promise<void> {
  const body = cosyBody();
  const raw = JSON.stringify(body);
  const encoded = transformQoderBody(raw);
  const headers = buildCosyHeaders(
    COSY_URL,
    raw,
    { userId, userName: account.label ?? "", userType: "personal_standard", securityOauthToken: token, refreshToken: "" },
    VERSION,
    { id: machineId, token: machineId, type: "5" },
    { key: model, source: "system" },
  );
  const res = await fetch(COSY_URL, {
    method: "POST",
    headers: headers as unknown as HeadersInit,
    body: encoded as unknown as BodyInit,
    signal: AbortSignal.timeout(timeoutMs),
  });
  console.log(`\n=== COSY /algo status=${res.status} ===`);
  if (!res.ok) {
    console.log((await res.text()).slice(0, 400));
    return;
  }
  await readSseReport(res);
}

// ---------------------------------------------------------------- IDE/HTTP ----
const IDE_URL = "https://api2-v2.qoder.sh/model/v1/chat/completions";

function ideHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    "X-Request-ID": randomUUID(),
    "X-Session-ID": sessionId(),
    "Cosy-Version": VERSION,
    "Cosy-ClientType": "5",
    "Cosy-MachineOS": machineOs(),
    "Cosy-MachineHostname": machineHostname(),
    "Cosy-MachineId": machineId,
  };
}

function ideBody(): Record<string, unknown> {
  const rid = randomUUID();
  return {
    model,
    messages: [{ role: "user", content: prompt }],
    stream: true,
    stream_options: { include_usage: true },
    metadata: {
      context: {
        request_id: rid,
        request_set_id: randomUUID(),
        session_id: sessionId(),
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
    max_tokens: 256,
    tools: [toolDecl()],
    tool_choice: "auto",
    parallel_tool_calls: true,
  };
}

async function hitIde(): Promise<void> {
  const res = await fetch(IDE_URL, {
    method: "POST",
    headers: ideHeaders(),
    body: JSON.stringify(ideBody()),
    signal: AbortSignal.timeout(timeoutMs),
  });
  console.log(`\n=== IDE/HTTP /model/v1 status=${res.status} ===`);
  if (!res.ok) {
    console.log((await res.text()).slice(0, 400));
    return;
  }
  await readSseReport(res);
}

// ---------------------------------------------------------------- gRPC -------
// gRPC tool conversion — mirrors worker `byl`: StringValue description,
// Struct parameters (SBA/Lat), BoolValue strict.
function xG(s: string): unknown {
  return { value: s };
}
function UatBool(b: boolean): unknown {
  return { value: b };
}
function latValue(v: unknown): unknown {
  if (v === null || v === undefined) return { nullValue: 0 };
  if (typeof v === "number") return { numberValue: v };
  if (typeof v === "string") return { stringValue: v };
  if (typeof v === "boolean") return { boolValue: v };
  if (Array.isArray(v)) return { listValue: { values: v.map(latValue) } };
  if (typeof v === "object") return { structValue: structOf(v as Record<string, unknown>) };
  return { stringValue: String(v) };
}
function structOf(obj: Record<string, unknown>): unknown {
  const fields: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(obj)) fields[k] = latValue(val);
  return { fields };
}

function grpcTools(): unknown[] {
  const fn = (toolDecl()["function"] ?? {}) as Record<string, unknown>;
  return [
    {
      type: "function",
      function: {
        name: fn["name"] as string,
        description: xG((fn["description"] as string) ?? ""),
        parameters: structOf((fn["parameters"] as Record<string, unknown>) ?? {}),
        strict: UatBool(false),
      },
    },
  ];
}

async function hitGrpc(): Promise<void> {
  const { service } = createChatService(realm);
  const sd = sessionId();
  const request = {
    model,
    messages: [{ role: "user", text_content: prompt }],
    stream: { value: true },
    stream_options: { include_usage: { value: true } },
    max_tokens: { value: 256 },
    tools: grpcTools(),
    tool_choice: { stringValue: "auto" },
    parallel_tool_calls: { value: true },
    metadata: {
      context: {
        request_id: randomUUID(),
        session_id: sd,
        task_id: "common",
        request_set_id: randomUUID(),
        client_type: "5",
        source_session_id: "",
      },
      business: { product: "cli", type: "agent", version: VERSION, scene: "assistant" },
    },
  };
  const metadata = new grpc.Metadata();
  metadata.set("authorization", `Bearer ${token}`);
  metadata.set("x-request-id", randomUUID());
  metadata.set("x-session-id", sd);
  metadata.set("cosy-version", VERSION);
  metadata.set("cosy-clienttype", "5");
  metadata.set("cosy-machineos", machineOs());
  const hn = machineHostname();
  if (hn.length > 0) metadata.set("cosy-machinehostname", hn);

  console.log(`\n=== gRPC ChatService (${realm}) ===`);
  const collector = new CollectReport();
  const stream = service.ChatCompletionStream(request, metadata);
  stream.on("data", (chunk: GrpcChatChunk) => collector.feedChunk(chunk));
  stream.on("status", (s: grpc.StatusObject) => {
    console.log(`grpc-status=${s.code} message=${s.details}`);
  });
  stream.on("error", (err: Error) => console.log(`STREAM_ERROR: ${err.message}`));
  stream.on("end", () => {
    collector.print();
    service.close();
  });
  const t = setTimeout(() => {
    try {
      stream.cancel();
    } catch {
      // ignore
    }
  }, timeoutMs);
  stream.on("end", () => clearTimeout(t));
}

// ---------------------------------------------------------------- report ----
// Decodes a `google.protobuf.Struct`/`Value` wire shape back to plain JS.
function unwrapStruct(v: unknown): Record<string, unknown> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return {};
  const rec = v as Record<string, unknown>;
  if (rec["fields"] !== undefined && typeof rec["fields"] === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(rec["fields"] as Record<string, unknown>)) {
      out[k] = unwrapValue(val);
    }
    return out;
  }
  return rec;
}

function unwrapValue(v: unknown): unknown {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return v;
  const rec = v as Record<string, unknown>;
  if ("stringValue" in rec) return rec.stringValue;
  if ("numberValue" in rec) return rec.numberValue;
  if ("boolValue" in rec) return rec.boolValue;
  if ("nullValue" in rec) return null;
  if ("structValue" in rec) return unwrapStruct(rec.structValue);
  if ("listValue" in rec) {
    const inner = rec.listValue as Record<string, unknown> | undefined;
    const values = inner?.values;
    return Array.isArray(values) ? values.map(unwrapValue) : [];
  }
  return rec;
}

class CollectReport {
  text = "";
  reasoning = "";
  tools = new Map<string, { name: string; args: string }>();
  seq = 0;
  finishReason = "";

  feedChunk(chunk: GrpcChatChunk): void {
    for (const choice of chunk.choices ?? []) {
      const delta = (choice.delta ?? {}) as Record<string, unknown>;
      if (typeof delta.content === "string") this.text += delta.content;
      if (typeof delta.reasoning_content === "string") this.reasoning += delta.reasoning_content;
      const calls = delta.tool_calls;
      if (Array.isArray(calls)) {
        if (process.env.QODER_RAW_TOOLCALL === "1") {
          for (const call of calls) {
            const rec = call as Record<string, unknown>;
            const uw = unwrapStruct(rec);
            const inner = (uw["function"] ?? {}) as Record<string, unknown>;
            console.log(`RAW_TOOLCALL index=${uw["index"] ?? "∅"} id=${JSON.stringify(uw["id"] ?? null)} name=${JSON.stringify(typeof inner["name"] === "string" ? inner["name"] : null)} args=${JSON.stringify(inner["arguments"] ?? null)} raw=${JSON.stringify(rec)}`);
          }
        }
        for (const call of calls) {
          const rec = call as Record<string, unknown>;
          // gRPC sends each tool_calls element as a Struct wrapper
          // ({fields: {k: {stringValue/numberValue/...}}}) — unwrap it.
          const unwrapped = unwrapStruct(rec);
          const index = typeof unwrapped["index"] === "number" ? unwrapped["index"] : this.seq++;
          const fn = (unwrapped["function"] ?? {}) as Record<string, unknown>;
          const id = typeof unwrapped["id"] === "string" ? unwrapped["id"] : `call_${index}`;
          const name = typeof fn["name"] === "string" ? fn["name"] : undefined;
          const args = typeof fn["arguments"] === "string" ? fn["arguments"] : JSON.stringify(fn["arguments"] ?? "");
          let entry = this.tools.get(id);
          if (!entry) {
            entry = { name: name ?? `tool_${index}`, args: "" };
            this.tools.set(id, entry);
          }
          if (name !== undefined) entry.name = name;
          if (args !== "{}") entry.args += args;
        }
      }
      const fr = choice.finish_reason;
      if (typeof fr === "string" && fr && !this.finishReason) {
        this.finishReason = fr;
      }
    }
  }

  feedFrame(json: Record<string, unknown>): void {
    const choices = (json["choices"] as Array<Record<string, unknown>> | undefined) ?? [];
    for (const choice of choices) {
      const delta = (choice["delta"] as Record<string, unknown> | undefined) ?? {};
      if (typeof delta["content"] === "string") this.text += delta["content"] as string;
      if (typeof delta["reasoning_content"] === "string") this.reasoning += delta["reasoning_content"] as string;
      const calls = delta["tool_calls"];
      if (Array.isArray(calls)) {
        for (const call of calls) {
          const rec = call as Record<string, unknown>;
          const index = typeof rec["index"] === "number" ? rec["index"] : this.seq++;
          const fn = (rec["function"] ?? {}) as Record<string, unknown>;
          const id = typeof rec["id"] === "string" ? rec["id"] : `call_${index}`;
          const name = typeof fn["name"] === "string" ? fn["name"] : undefined;
          const args = typeof fn["arguments"] === "string" ? fn["arguments"] : "";
          let entry = this.tools.get(id);
          if (!entry) {
            entry = { name: name ?? `tool_${index}`, args: "" };
            this.tools.set(id, entry);
          }
          if (name !== undefined) entry.name = name;
          if (args !== "{}") entry.args += args;
        }
      }
      const fr = choice["finish_reason"];
      if (typeof fr === "string" && fr && !this.finishReason) this.finishReason = fr;
    }
  }

  print(): void {
    if (this.reasoning) console.log(`  reasoning(len=${this.reasoning.length}): ${this.reasoning.slice(0, 200)}`);
    console.log(`  text(len=${this.text.length}): ${this.text.slice(0, 400) || "(none)"}`);
    console.log(`  finish_reason=${this.finishReason || "(none)"}`);
    if (this.tools.size === 0) {
      console.log("  TOOL_CALLS: (none)");
    } else {
      console.log(`  TOOL_CALLS: ${this.tools.size}`);
      for (const [id, t] of this.tools) {
        console.log(`    - id=${id} name=${t.name}`);
        console.log(`      args=${t.args.slice(0, 600)}`);
      }
    }
  }
}

async function readSseReport(res: Response): Promise<void> {
  const collector = new CollectReport();
  const reader = res.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let buf = "";
  let frames = 0;
  while (frames < 300) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx = buf.indexOf("\n\n");
    while (idx >= 0) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      frames += 1;
      for (const line of chunk.split(/\r?\n/)) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") {
          collector.print();
          return;
        }
        try {
          const json = JSON.parse(data) as Record<string, unknown>;
          if (json["error"] !== undefined) {
            console.log(`  error frame: ${JSON.stringify(json["error"]).slice(0, 300)}`);
            collector.print();
            return;
          }
          collector.feedFrame(json);
        } catch {
          // ignore
        }
      }
      idx = buf.indexOf("\n\n");
    }
  }
  collector.print();
}

// ---------------------------------------------------------------- dispatch ----
const surfaces =
  values.surface === "all"
    ? ["cosy", "ide", "grpc"]
    : values.surface.split(",").map((s) => s.trim()).filter((s) => s.length > 0);

(async () => {
  for (const s of surfaces) {
    if (s === "cosy") await hitCosy();
    else if (s === "ide") await hitIde();
    else if (s === "grpc") await hitGrpc();
    else throw new Error("--surface must be cosy|ide|grpc|all");
  }
})();
