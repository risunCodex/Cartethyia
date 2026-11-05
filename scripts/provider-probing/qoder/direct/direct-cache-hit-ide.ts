/**
 * Qoder prompt-cache probe — IDE HTTP surface (`/model/v1/chat/completions`).
 *
 * The gRPC probe (`direct-cache-hit.ts`) saw no `prompt_tokens_details` on
 * the wire. This runs the SAME byte-identical-repeat test on the IDE HTTP
 * surface, which carries `usage` AND the richer `raw_usage` frame — so we can
 * tell whether the HTTP surface reports cache hits the gRPC surface hides.
 *
 *   bun run scripts/provider-probing/qoder/direct/direct-cache-hit-ide.ts \
 *     --creds <qoder-accounts-*.json> --model dfmodel [--calls 4]
 */
import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { hostname as osHostname } from "node:os";

const { values } = parseArgs({
  options: {
    creds: { type: "string" },
    model: { type: "string", default: "dfmodel" },
    prompt: { type: "string", default: "Tolong jelaskan dalam satu paragraf: apa perbedaan antara HTTP dan WebSocket?" },
    calls: { type: "string", default: "4" },
    "timeout-ms": { type: "string", default: "180000" },
  },
});

const creds = values.creds;
if (!creds) throw new Error("--creds <path> is required");
const calls = Number(values.calls);
if (!Number.isFinite(calls) || calls < 2 || calls > 8) throw new Error("--calls must be 2..8");

const raw = JSON.parse(readFileSync(creds, "utf8"));
const account = (Array.isArray(raw) ? raw : raw.accounts ?? [])[0];
const token = account.accessToken ?? account.token ?? "";
if (typeof token !== "string" || token.length === 0) throw new Error("no accessToken");
const userId: string = account.authState?.userId ?? "";
const machineId: string = account.authState?.machineId ?? randomUUID();

const VERSION = "1.1.83";
const IDE_URL = "https://api2-v2.qoder.sh/model/v1/chat/completions";
const promptText = values.prompt!;

function machineOs(): string {
  const arch = process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : process.arch;
  return `${arch}_${process.platform}`;
}
function machineHostname(): string {
  const safe = (osHostname() ?? "").trim().toLowerCase().replace(/[^\x21-\x7e]+/gu, "-").replace(/-{2,}/gu, "-").replace(/^-+|-+$/gu, "");
  return safe.length <= 96 ? safe : `${safe.slice(0, 87)}-${createHash("sha256").update(safe).digest("hex").slice(0, 8)}`;
}
function sessionIdFor(uid: string, model: string): string {
  return createHash("sha256").update(`qoder-session:${uid}:${model}`).digest("hex").slice(0, 32);
}

const sessionId = sessionIdFor(userId !== "" ? userId : machineId, values.model!);
console.log(`account=${account.label ?? "?"} token=${token.slice(0, 4)}…${token.slice(-4)}`);
console.log(`sessionKey=${userId !== "" ? "userId" : "machineId"} sessionId=${sessionId.slice(0, 16)}… (stable)`);
console.log(`model=${values.model} calls=${calls} surface=ide (http)`);

function buildRequest(messages: Array<Record<string, unknown>>): Record<string, unknown> {
  return {
    model: values.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: 128,
    tools: [],
    metadata: {
      context: {
        request_id: randomUUID(),
        request_set_id: randomUUID(),
        session_id: sessionId,
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
  };
}

function headers(): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    "X-Request-ID": randomUUID(),
    "X-Session-ID": sessionId,
    "Cosy-Version": VERSION,
    "Cosy-ClientType": "5",
    "Cosy-MachineOS": machineOs(),
    "Cosy-MachineHostname": machineHostname(),
    "Cosy-MachineId": machineId,
  };
}

async function sseCollect(response: Response): Promise<{
  usage: Record<string, unknown> | undefined;
  rawUsage: Record<string, unknown> | undefined;
  text: string;
  frames: number;
}> {
  const reader = response.body?.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let frames = 0;
  let text = "";
  let usage: Record<string, unknown> | undefined;
  let rawUsage: Record<string, unknown> | undefined;
  while (frames < 500) {
    const { value, done } = await reader!.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx = buf.indexOf("\n\n");
    while (idx >= 0) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      frames += 1;
      const dataParts: string[] = [];
      for (const line of chunk.split(/\r?\n/)) if (line.startsWith("data:")) dataParts.push(line.slice(5).trim());
      const data = dataParts.join("");
      if (data === "[DONE]" || !data) {
        idx = buf.indexOf("\n\n");
        continue;
      }
      try {
        const json = JSON.parse(data) as Record<string, unknown>;
        if (typeof json["usage"] === "object" && json["usage"] !== null) usage = json["usage"] as Record<string, unknown>;
        if (typeof json["raw_usage"] === "object" && json["raw_usage"] !== null) rawUsage = json["raw_usage"] as Record<string, unknown>;
        const choices = Array.isArray(json["choices"]) ? (json["choices"] as Array<Record<string, unknown>>) : [];
        const delta = choices[0]?.["delta"] as Record<string, unknown> | undefined;
        if (typeof delta?.["content"] === "string") text += delta["content"];
      } catch {
        // skip
      }
      idx = buf.indexOf("\n\n");
    }
  }
  return { usage, rawUsage, text, frames };
}

const R1 = "Terima kasih. Sekarang jelaskan perbedaan TCP vs UDP.";
const R2 = "Dan kapan saya harus memakai HTTP/2?";
const sequences: Array<{ label: string; messages: Array<Record<string, unknown>> }> = [];
if (calls >= 1) sequences.push({ label: "A1 fresh        [P]", messages: [{ role: "user", content: promptText }] });
if (calls >= 2) sequences.push({ label: "A2 identical     [P]", messages: [{ role: "user", content: promptText }] });
if (calls >= 3) sequences.push({ label: "A3 prefix-hit  [P,R1]", messages: [{ role: "user", content: promptText }, { role: "user", content: R1 }] });
if (calls >= 4) sequences.push({ label: "A4 prefix-hit [P,R1,R2]", messages: [{ role: "user", content: promptText }, { role: "user", content: R1 }, { role: "user", content: R2 }] });

let sawAnyCached = false;
for (const { label, messages } of sequences) {
  const res = await fetch(IDE_URL, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(buildRequest(messages)),
  });
  const col = await sseCollect(res);
  const usage = col.usage ?? {};
  const ptd = (usage["prompt_tokens_details"] ?? {}) as Record<string, unknown>;
  const cached = typeof ptd["cached_tokens"] === "number" ? ptd["cached_tokens"] : "—";
  if (typeof cached === "number" && cached > 0) sawAnyCached = true;
  console.log(`\n=== ${label} ===`);
  console.log(`  http=${res.status} frames=${col.frames} answerChars=${col.text.length}`);
  console.log(`  usage=${JSON.stringify(col.usage ?? null)}`);
  console.log(`  prompt_tokens_details.cached_tokens=${cached}`);
  if (col.rawUsage) {
    const keys = Object.keys(col.rawUsage);
    console.log(`  raw_usage keys=${keys.join(",")}`);
    if (keys.length > 0) console.log(`  raw_usage=${JSON.stringify(col.rawUsage).slice(0, 800)}`);
  } else {
    console.log("  raw_usage=(absent)");
  }
}

console.log(`\n=== VERDICT ===`);
if (sawAnyCached) {
  console.log("IDE HTTP surface REPORTS cache hits (cached_tokens > 0). gRPC hides them?");
} else {
  console.log("IDE HTTP surface ALSO does NOT report cache hits.");
  console.log("Apply the shared session-cache estimator (like trae/kiro) — next version.");
}
