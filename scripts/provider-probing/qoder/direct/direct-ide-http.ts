/**
 * IDE HTTP surface direct hit — `/model/v1/chat/completions` (OpenAI-shaped).
 *
 * This is the IDE/HTTP surface (NOT the legacy COSY). Headers mirror the
 * worker `sendModelServerHttpChat` (qoder-worker-runtime.obf.mjs) + live
 * capture: Authorization Bearer, X-Request-ID/X-Session-ID, and the Cosy
 * identity headers. Device token (`dt-...`) is used directly (no PAT exchange).
 *
 * Usage:
 *   bun run scripts/provider-probing/qoder/direct/direct-ide-http.ts \
 *     --creds <qoder-accounts-*.json> --model cmodel \
 *     --prompt "Halo" [--surface ide|cosy|both] [--timeout-ms 120000]
 */
import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { hostname as osHostname } from "node:os";

const { values } = parseArgs({
  options: {
    creds: { type: "string" },
    model: { type: "string", default: "cmodel" },
    prompt: { type: "string", default: "Halo, perkenalkan dirimu singkat." },
    "prompt-file": { type: "string" },
    surface: { type: "string", default: "ide" },
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
if (!token.startsWith("dt-") && !token.startsWith("pt-")) {
  throw new Error(`unsupported token kind: ${token.slice(0, 3)}...`);
}
const userId: string = account.authState?.userId ?? "";
const machineId: string = account.authState?.machineId ?? randomUUID();
console.log(`account=${account.label ?? "?"} token=${token.slice(0, 4)}…${token.slice(-4)} userId=${userId} machineId=${machineId.slice(0, 8)}…`);

// --- helpers (mirror lib/shared) ---
function machineOs(): string {
  const arch = process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : process.arch;
  return `${arch}_${process.platform}`;
}
function machineHostname(): string {
  const raw = (osHostname() ?? "").trim().toLowerCase();
  const safe = raw.replace(/[^\x21-\x7e]+/gu, "-").replace(/-{2,}/gu, "-").replace(/^-+|-+$/gu, "");
  if (safe.length <= 96) return safe;
  return `${safe.slice(0, 87)}-${createHash("sha256").update(safe).digest("hex").slice(0, 8)}`;
}
function sessionIdFor(uid: string, model: string): string {
  return createHash("sha256").update(`qoder-session:${uid}:${model}`).digest("hex").slice(0, 32);
}

const VERSION = "1.1.83";

// --- surface URL / headers ---
const IDE_URL = "https://api2-v2.qoder.sh/model/v1/chat/completions";
const COSY_URL =
  "https://api1.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1";

function ideHeaders(model: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    "X-Request-ID": randomUUID(),
    "X-Session-ID": sessionIdFor(userId, model),
    "Cosy-Version": VERSION,
    "Cosy-ClientType": "5",
    "Cosy-MachineOS": machineOs(),
    "Cosy-MachineHostname": machineHostname(),
    "Cosy-MachineId": machineId,
  };
}

function ideBody(model: string): Record<string, unknown> {
  const rid = randomUUID();
  const sid = sessionIdFor(userId, model);
  const promptText = values["prompt-file"] !== undefined
    ? readFileSync(values["prompt-file"], "utf8")
    : values.prompt!;
  return {
    model,
    messages: [{ role: "user", content: promptText }],
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
    max_tokens: 64,
    tools: [],
    parallel_tool_calls: true,
  };
}

// --- SSE reader (previous) ---
async function readSse(response: Response, maxFrames = 200): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let buf = "";
  let frames = 0;
  let text = "";
  let reasoning = "";
  let modelSeen = "";
  let rawUsage: Record<string, unknown> | undefined;
  let rawUsagePrinted = false;
  while (frames < maxFrames) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx = buf.indexOf("\n\n");
    while (idx >= 0) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      frames += 1;
      // Akumulasi semua baris `data:` dalam satu event (bisa multi-line)
      let dataParts: string[] = [];
      for (const line of chunk.split(/\r?\n/)) {
        if (line.startsWith("data:")) dataParts.push(line.slice(5).trim());
      }
      const data = dataParts.join("");
      if (data === "[DONE]") {
        console.log("  [DONE] received");
        console.log(`  model_echo=${modelSeen || "(none)"}`);
        if (rawUsage && !rawUsagePrinted) {
          rawUsagePrinted = true;
          console.log(`  RAW_USAGE=${JSON.stringify(rawUsage, null, 2)}`);
        }
        return;
      }
      if (!data) continue;
      try {
        const json = JSON.parse(data) as {
          model?: string;
          choices?: Array<{ delta?: { content?: string; reasoning_content?: string }; finish_reason?: string | null }>;
          error?: unknown;
          usage?: unknown;
          raw_usage?: unknown;
        };
        if (json.error !== undefined) {
          console.log(`  error frame: ${JSON.stringify(json.error).slice(0, 300)}`);
          return;
        }
        if (typeof json.model === "string" && !modelSeen) modelSeen = json.model;
        if (json.raw_usage !== undefined && typeof json.raw_usage === "object") {
          rawUsage = json.raw_usage as Record<string, unknown>;
        }
        const delta = json.choices?.[0]?.delta;
        if (delta?.content) text += delta.content;
        if (delta?.reasoning_content) reasoning += delta.reasoning_content;
        // Jangan return di finish_reason — raw_usage datang di frame yang sama
        // (sebelum [DONE]), jadi lanjut sampai [DONE].
      } catch {
        // data terbelah / bukan JSON lengkap — lewati
      }
      idx = buf.indexOf("\n\n");
    }
  }
  console.log(`  model_echo=${modelSeen || "(none)"}`);
  if (rawUsage && !rawUsagePrinted) {
    rawUsagePrinted = true;
    console.log(`  RAW_USAGE=${JSON.stringify(rawUsage, null, 2)}`);
  }
  if (reasoning) console.log(`  reasoning: ${reasoning.slice(0, 400)}`);
  console.log(`  text: ${text.slice(0, 800) || "(no text)"}`);
  console.log(`  frames=${frames}`);
}

async function hit(url: string, label: string): Promise<void> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: ideHeaders(values.model!),
      body: JSON.stringify(ideBody(values.model!)),
      signal: ac.signal,
    });
    console.log(`\n=== ${label} ===`);
    console.log(`status=${res.status}`);
    console.log(`url=${url}`);
    if (!res.ok) {
      const body = await res.text();
      console.log(`body: ${body.slice(0, 500)}`);
      return;
    }
    await readSse(res);
  } catch (e) {
    console.log(`ERROR: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    clearTimeout(timer);
  }
}

const surfaces = values.surface === "both" ? ["ide", "cosy"] : [values.surface];
for (const s of surfaces) {
  if (s === "ide") await hit(IDE_URL, "IDE/HTTP /model/v1");
  else if (s === "cosy") await hit(COSY_URL, "COSY legacy (comparison)");
  else throw new Error("--surface must be ide|cosy|both");
}
