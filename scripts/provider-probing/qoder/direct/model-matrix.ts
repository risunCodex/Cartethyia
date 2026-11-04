/**
 * Qoder model × surface matrix runner (sandbox).
 *
 * Tests every model on the roster against IDE/HTTP and gRPC surfaces across a
 * set of cases (plain, tools, tool_choice none/required, parallel tools).
 * Non-blocking: bounded concurrency; strict per-request timeout; results
 * written as JSONL to `D:\tmp\qoder-sandbox\results\`.
 *
 * Usage:
 *   bun run scripts/provider-probing/qoder/direct/model-matrix.ts \
 *     --creds <accounts.json> \
 *     [--surface ide,grpc] [--models cmodel,dfmodel,...|all]
 *     [--cases plain,tools,tools_none,tools_required,parallel]
 *     [--concurrency 4] [--timeout-ms 60000]
 */
import { parseArgs } from "node:util";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { join } from "node:path";
import * as grpc from "@grpc/grpc-js";
import { createChatService, type GrpcChatChunk } from "../lib/grpc";
import type { QoderRealm } from "../../../../src/providers/integrations/qoder/qoder-realm";
import { machineOs, machineHostname } from "../lib/shared";

const SB = "D:/tmp/qoder-sandbox";
const OUT = join(SB, "results");

const { values } = parseArgs({
  options: {
    creds: { type: "string" },
    surface: { type: "string", default: "ide,grpc" },
    models: { type: "string", default: "all" },
    cases: { type: "string", default: "plain,tools,tools_none,tools_required,parallel" },
    concurrency: { type: "string", default: "4" },
    "timeout-ms": { type: "string", default: "60000" },
    tag: { type: "string", default: "run1" },
  },
});

const creds = values.creds;
if (!creds) throw new Error("--creds <path> is required");
const concurrency = Number(values.concurrency);
const timeoutMs = Number(values["timeout-ms"]);

const raw = JSON.parse(readFileSync(creds, "utf8"));
const account = (Array.isArray(raw) ? raw : raw.accounts ?? [])[0];
const token = account.accessToken ?? account.token ?? "";
const userId: string = account.authState?.userId ?? "";
const machineId: string = account.authState?.machineId ?? randomUUID();
const VERSION = "1.1.83";
const realm: QoderRealm = "intl";

// All roster models (from the 1.1.83 model list capture)
const ALL_MODELS = [
  "auto", "ultimate", "fast", "efficient",
  "smodel", "cmodel", "qmodel_38max", "qfmodel",
  "kmodel_latest", "kmodel", "gmodel", "gfmodel",
  "dmodel", "dfmodel", "mmodel",
];

const models = values.models === "all" ? ALL_MODELS : values.models.split(",").map(s => s.trim()).filter(Boolean);
const surfaces = values.surface.split(",").map(s => s.trim()).filter(Boolean);
const caseNames = values.cases.split(",").map(s => s.trim()).filter(Boolean);

mkdirSync(OUT, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outFile = join(OUT, `matrix-${values.tag}-${stamp}.jsonl`);
console.log(`sandbox=${SB}`);
console.log(`out=${outFile}`);
console.log(`models=${models.length} surfaces=[${surfaces}] cases=[${caseNames}] concurrency=${concurrency} timeout=${timeoutMs}ms`);
console.log(`account=${account.label ?? "?"} token=${token.slice(0, 4)}…${token.slice(-4)}`);

// --------------------------------------------------------------- helpers ----
function sessionIdFor(uid: string, m: string): string {
  return createHash("sha256").update(`qoder-session:${uid}:${m}`).digest("hex").slice(0, 32);
}
function sid(m: string): string {
  return sessionIdFor(userId, m);
}

const toolWeather = {
  type: "function",
  function: {
    name: "get_weather",
    description: "Get current weather for a city",
    parameters: {
      type: "object",
      properties: { city: { type: "string", description: "City name" } },
      required: ["city"],
    },
  },
};

const toolTime = {
  type: "function",
  function: {
    name: "get_time",
    description: "Get current time in a city",
    parameters: {
      type: "object",
      properties: { city: { type: "string", description: "City name" } },
      required: ["city"],
    },
  },
};

function promptFor(caseName: string): string {
  switch (caseName) {
    case "plain":
      return "Halo, jawab dalam satu kalimat: apa ibu kota Indonesia?";
    case "tools":
      return 'Panggil tool get_weather dengan parameter kota "Jakarta". Jawab singkat.';
    case "tools_none":
      return 'Panggil tool get_weather dengan parameter kota "Jakarta" jika perlu, tapi jawab langsung.';
    case "tools_required":
      return 'Kamu punya tool get_weather. Tolong gunakan tool get_weather dengan parameter kota "Jakarta" untuk menjawab.';
    case "parallel":
      return 'Panggil KEDUA tool secara paralel: get_weather dan get_time untuk kota "Jakarta".';
    default:
      return `Halo, jawab singkat: ${caseName}`;
  }
}

function toolChoiceFor(caseName: string): unknown {
  switch (caseName) {
    case "tools_none":
      return "none";
    case "tools_required":
      return "required";
    case "tools":
    case "parallel":
      return "auto";
    default:
      return undefined;
  }
}

function toolsFor(caseName: string): unknown[] {
  if (caseName === "plain") return [];
  if (caseName === "parallel") return [toolWeather, toolTime];
  return [toolWeather];
}

// ---------------------------------------------------------------- IDE -------
const IDE_URL = "https://api2-v2.qoder.sh/model/v1/chat/completions";

interface MatrixResult {
  model: string;
  surface: string;
  case: string;
  ok: boolean;
  status?: number;
  error?: string;
  ms: number;
  text: string;
  reasoning: string;
  finishReason: string;
  toolCalls: Array<{ id: string; name: string; args: string }>;
  usage?: string;
  chunks: number;
}

async function runIde(model: string, caseName: string): Promise<MatrixResult> {
  const start = Date.now();
  const res: MatrixResult = { model, surface: "ide", case: caseName, ok: false, ms: 0, text: "", reasoning: "", finishReason: "", toolCalls: [], chunks: 0 };
  try {
    const body = {
      model,
      messages: [{ role: "user", content: promptFor(caseName) }],
      stream: true,
      stream_options: { include_usage: true },
      metadata: {
        context: {
          request_id: randomUUID(),
          request_set_id: randomUUID(),
          session_id: sid(model),
          source_session_id: "",
          task_id: "common",
          client_type: "5",
        },
        business: { business_product: "cli", business_type: "agent", business_version: VERSION, scene: "assistant" },
      },
      max_tokens: 256,
      tools: toolsFor(caseName),
      parallel_tool_calls: true,
    };
    const tc = toolChoiceFor(caseName);
    if (tc !== undefined) (body as Record<string, unknown>)["tool_choice"] = tc;

    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      "X-Request-ID": randomUUID(),
      "X-Session-ID": sid(model),
      "Cosy-Version": VERSION,
      "Cosy-ClientType": "5",
      "Cosy-MachineOS": machineOs(),
      "Cosy-MachineHostname": machineHostname(),
      "Cosy-MachineId": machineId,
    };

    const response = await fetch(IDE_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    res.status = response.status;
    if (!response.ok) {
      res.error = (await response.text()).slice(0, 300);
      res.ms = Date.now() - start;
      return res;
    }
    await collectSse(response, res, 200);
    res.ok = true;
  } catch (e) {
    res.error = e instanceof Error ? e.message : String(e);
  }
  res.ms = Date.now() - start;
  return res;
}

async function collectSse(response: Response, res: MatrixResult, maxFrames: number): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let buf = "";
  let frames = 0;
  while (frames < maxFrames) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx = buf.indexOf("\n\n");
    while (idx >= 0) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      frames += 1;
      res.chunks += 1;
      for (const line of chunk.split(/\r?\n/)) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") return;
        try {
          const json = JSON.parse(data) as Record<string, unknown>;
          if (json["error"] !== undefined) {
            res.error = JSON.stringify(json["error"]).slice(0, 200);
            return;
          }
          feedFrame(json, res);
        } catch {
          // ignore
        }
      }
      idx = buf.indexOf("\n\n");
    }
  }
}

function feedFrame(json: Record<string, unknown>, res: MatrixResult): void {
  const choices = (json["choices"] as Array<Record<string, unknown>> | undefined) ?? [];
  for (const choice of choices) {
    const delta = (choice["delta"] as Record<string, unknown> | undefined) ?? {};
    if (typeof delta["content"] === "string") res.text += delta["content"] as string;
    if (typeof delta["reasoning_content"] === "string") res.reasoning += delta["reasoning_content"] as string;
    const calls = delta["tool_calls"];
    if (Array.isArray(calls)) {
      let i = 0;
      for (const call of calls) {
        const rec = call as Record<string, unknown>;
        const index = typeof rec["index"] === "number" ? rec["index"] : i++;
        const fn = (rec["function"] ?? {}) as Record<string, unknown>;
        const id = typeof rec["id"] === "string" ? rec["id"] : `call_${index}`;
        const name = typeof fn["name"] === "string" ? fn["name"] : "";
        const args = typeof fn["arguments"] === "string" ? fn["arguments"] : "";
        let entry = res.toolCalls.find(t => t.id === id);
        if (!entry) {
          entry = { id, name, args: "" };
          res.toolCalls.push(entry);
        }
        if (name) entry.name = name;
        if (args) entry.args += args;
      }
    }
    const fr = choice["finish_reason"];
    if (typeof fr === "string" && fr && !res.finishReason) res.finishReason = fr;
  }
  const usage = json["usage"];
  if (usage && typeof usage === "object") res.usage = JSON.stringify(usage);
}

// ---------------------------------------------------------------- gRPC ----
// gRPC tool conversion — mirrors worker `byl`: StringValue description,
// Struct parameters (via SBA/Lat), BoolValue strict.
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

function grpcTools(caseName: string): unknown[] {
  return toolsFor(caseName).map((tool) => {
    const rec = tool as Record<string, unknown>;
    const fn = (rec["function"] ?? {}) as Record<string, unknown>;
    return {
      type: "function",
      function: {
        name: fn["name"] as string,
        description: xG((fn["description"] as string) ?? ""),
        parameters: structOf((fn["parameters"] as Record<string, unknown>) ?? {}),
        strict: UatBool(false),
      },
    };
  });
}

async function runGrpc(model: string, caseName: string): Promise<MatrixResult> {
  const start = Date.now();
  const res: MatrixResult = { model, surface: "grpc", case: caseName, ok: false, ms: 0, text: "", reasoning: "", finishReason: "", toolCalls: [], chunks: 0 };
  const { service } = createChatService(realm);
  try {
    const sd = sid(model);
    const request: Record<string, unknown> = {
      model,
      messages: [{ role: "user", text_content: promptFor(caseName) }],
      stream: { value: true },
      stream_options: { include_usage: { value: true } },
      max_tokens: { value: 256 },
      tools: grpcTools(caseName),
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
    const tc = toolChoiceFor(caseName);
    // gRPC upstream rejects `tool_choice` Struct form (400/406/422). Worker
    // `bFn` sends `Lat(tool_choice)` → plain `{stringValue:"auto"}`.
    // `required` is rejected upstream entirely → omit field, rely on prompt.
    if (tc === "required") {
      // omit tool_choice entirely
    } else if (tc !== undefined) {
      request["tool_choice"] = { stringValue: String(tc) };
    }

    const metadata = new grpc.Metadata();
    metadata.set("authorization", `Bearer ${token}`);
    metadata.set("x-request-id", randomUUID());
    metadata.set("x-session-id", sd);
    metadata.set("cosy-version", VERSION);
    metadata.set("cosy-clienttype", "5");
    metadata.set("cosy-machineos", machineOs());
    const hn = machineHostname();
    if (hn.length > 0) metadata.set("cosy-machinehostname", hn);

    const result = await new Promise<MatrixResult>((resolve) => {
      const stream = service.ChatCompletionStream(request, metadata);
      const timer = setTimeout(() => {
        try {
          stream.cancel();
        } catch {
          // ignore
        }
      }, timeoutMs);

      stream.on("data", (chunk: GrpcChatChunk) => {
        res.chunks += 1;
        for (const choice of chunk.choices ?? []) {
          const delta = (choice.delta ?? {}) as Record<string, unknown>;
          if (typeof delta.content === "string") res.text += delta.content;
          if (typeof delta.reasoning_content === "string") res.reasoning += delta.reasoning_content;
          const calls = delta.tool_calls;
          if (Array.isArray(calls)) {
            let i = 0;
            for (const call of calls) {
              const rec = call as Record<string, unknown>;
              const unwrapped = unwrapStruct(rec);
              const index = typeof unwrapped["index"] === "number" ? unwrapped["index"] : i++;
              const fn = (unwrapped["function"] ?? {}) as Record<string, unknown>;
              const id = typeof unwrapped["id"] === "string" ? unwrapped["id"] : `call_${index}`;
              const name = typeof fn["name"] === "string" ? fn["name"] : "";
              const args = typeof fn["arguments"] === "string" ? fn["arguments"] : "";
              let entry = res.toolCalls.find(t => t.id === id);
              if (!entry) {
                entry = { id, name, args: "" };
                res.toolCalls.push(entry);
              }
              if (name) entry.name = name;
              if (args) entry.args += args;
            }
          }
          if (typeof choice.finish_reason === "string" && choice.finish_reason && !res.finishReason) {
            res.finishReason = choice.finish_reason;
          }
        }
        if (chunk.usage) res.usage = JSON.stringify(chunk.usage);
      });
      stream.on("status", (s: grpc.StatusObject) => {
        clearTimeout(timer);
        if (s.code !== 0) res.error = `grpc-status=${s.code} ${s.details}`;
        resolve(res);
      });
      stream.on("error", (err: Error) => {
        clearTimeout(timer);
        res.error = err.message;
        resolve(res);
      });
      stream.on("end", () => {
        clearTimeout(timer);
        resolve(res);
      });
    });

    res.ok = !res.error;
    res.ms = Date.now() - start;
    return result;
  } catch (e) {
    res.error = e instanceof Error ? e.message : String(e);
    res.ms = Date.now() - start;
    return res;
  } finally {
    service.close();
  }
}

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
    const values = (rec.listValue as Record<string, unknown> | undefined)?.values;
    return Array.isArray(values) ? values.map(unwrapValue) : [];
  }
  return rec;
}

// ---------------------------------------------------------------- runner ----
type Task = { model: string; surface: string; case: string };

const tasks: Task[] = [];
for (const model of models) {
  for (const surface of surfaces) {
    for (const caseName of caseNames) {
      tasks.push({ model, surface, case: caseName });
    }
  }
}

console.log(`total tasks=${tasks.length}`);

let done = 0;
let queue = [...tasks];
const outStream: string[] = [];

function writeLine(line: string): void {
  outStream.push(line);
  writeFileSync(outFile, outStream.join("\n") + "\n", "utf8");
}

async function worker(): Promise<void> {
  while (queue.length > 0) {
    const task = queue.shift();
    if (!task) return;
    const label = `${task.model}/${task.surface}/${task.case}`;
    let result: MatrixResult;
    try {
      result = task.surface === "ide" ? await runIde(task.model, task.case) : await runGrpc(task.model, task.case);
    } catch (e) {
      result = { model: task.model, surface: task.surface, case: task.case, ok: false, error: e instanceof Error ? e.message : String(e), ms: 0, text: "", reasoning: "", finishReason: "", toolCalls: [], chunks: 0 };
    }
    done += 1;
    const line = JSON.stringify({ ...result, label });
    writeLine(line);
    const icon = result.ok ? "✅" : "❌";
    console.log(`[${done}/${tasks.length}] ${icon} ${label} ${result.status ?? ""} ${result.error ?? ""} ms=${result.ms} chunks=${result.chunks} tools=${result.toolCalls.length} finish=${result.finishReason}`);
  }
}

const workers: Promise<void>[] = [];
for (let i = 0; i < Math.min(concurrency, tasks.length); i += 1) {
  workers.push(worker());
}
await Promise.all(workers);
console.log(`\nDONE. results: ${outFile}`);
