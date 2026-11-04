/**
 * Semi-batch stress probe — IDE/HTTP surface only.
 *
 * Fires N concurrent-ish requests (small stagger) to `/model/v1/chat/completions`
 * for one model, and captures per-request: status, model echo, raw_usage
 * (provider_model/supply_model/router), error/queueing. Goal: observe fallback
 * behavior when many requests hit at once (queued / rate-limit / backend
 * switch / same-model reuse).
 *
 * Usage:
 *   bun run scripts/provider-probing/qoder/direct/direct-batch-ide.ts \
 *     --creds <accounts.json> --model cmodel \
 *     [--requests 10] [--stagger 300] [--concurrency 10] [--timeout-ms 120000]
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
    prompt: { type: "string", default: "Halo" },
    requests: { type: "string", default: "5" },
    stagger: { type: "string", default: "250" },
    concurrency: { type: "string", default: "5" },
    "timeout-ms": { type: "string", default: "60000" },
    burst: { type: "boolean", default: false },
  },
});

const creds = values.creds;
if (!creds) throw new Error("--creds <path> is required");
const N = Number(values.requests);
const staggerMs = Number(values.stagger);
const concurrency = Number(values.concurrency);
const timeoutMs = Number(values["timeout-ms"]);

const raw = JSON.parse(readFileSync(creds, "utf8"));
const account = (Array.isArray(raw) ? raw : raw.accounts ?? [])[0];
const token = account.accessToken ?? account.token ?? "";
const userId: string = account.authState?.userId ?? "";
const machineId: string = account.authState?.machineId ?? randomUUID();
const VERSION = "1.1.83";
const IDE_URL = "https://api2-v2.qoder.sh/model/v1/chat/completions";

function machineOs(): string {
  const arch = process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : process.arch;
  return `${arch}_${process.platform}`;
}
function machineHostname(): string {
  const str = (osHostname() ?? "").trim().toLowerCase();
  const safe = str.replace(/[^\x21-\x7e]+/gu, "-").replace(/-{2,}/gu, "-").replace(/^-+|-+$/gu, "");
  return safe.length <= 96 ? safe : `${safe.slice(0, 87)}-${createHash("sha256").update(safe).digest("hex").slice(0, 8)}`;
}
function sessionIdFor(uid: string, m: string): string {
  return createHash("sha256").update(`qoder-session:${uid}:${m}`).digest("hex").slice(0, 32);
}

function bodyFor(): Record<string, unknown> {
  const rid = randomUUID();
  return {
    model: values.model,
    messages: [{ role: "user", content: values.prompt }],
    stream: true,
    stream_options: { include_usage: true },
    metadata: {
      context: {
        request_id: rid,
        request_set_id: randomUUID(),
        session_id: sessionIdFor(userId, values.model!),
        source_session_id: "",
        task_id: "common",
        client_type: "5",
      },
      business: { business_product: "cli", business_type: "agent", business_version: VERSION, scene: "assistant" },
    },
    max_tokens: 64,
    tools: [],
    parallel_tool_calls: true,
  };
}

interface BatchResult {
  n: number;
  ok: boolean;
  status?: number;
  ms: number;
  modelEcho: string;
  text: string;
  rawUsage: Record<string, unknown> | undefined;
  finishReason: string;
  firstFrame: string;
  error?: string;
  timeouts: number;
}

async function one(i: number): Promise<BatchResult> {
  const start = Date.now();
  const res: BatchResult = { n: i, ok: false, ms: 0, modelEcho: "", text: "", rawUsage: undefined, finishReason: "", firstFrame: "", timeouts: 0 };
  console.log(`  ► req#${i + 1} start (t+${Date.now() - startAnchor}ms)`);
  try {
    const response = await fetch(IDE_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        "X-Request-ID": randomUUID(),
        "X-Session-ID": sessionIdFor(userId, values.model!),
        "Cosy-Version": VERSION,
        "Cosy-ClientType": "5",
        "Cosy-MachineOS": machineOs(),
        "Cosy-MachineHostname": machineHostname(),
        "Cosy-MachineId": machineId,
      },
      body: JSON.stringify(bodyFor()),
      signal: AbortSignal.timeout(timeoutMs),
    });
    res.status = response.status;
    console.log(`  ► req#${i + 1} HTTP ${response.status} (t+${Date.now() - startAnchor}ms)`);
    if (!response.ok) {
      res.error = (await response.text()).slice(0, 300);
      res.ms = Date.now() - start;
      return res;
    }
    // Stream baca sampai [DONE] (raw_usage di frame finish)
    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let done = false;
    while (!done && reader) {
      const { value, done: d } = await reader.read();
      if (d) break;
      buf += decoder.decode(value, { stream: true });
      let idx = buf.indexOf("\n\n");
      while (idx >= 0) {
        const chunk = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const dataParts: string[] = [];
        for (const line of chunk.split(/\r?\n/)) {
          if (line.startsWith("data:")) dataParts.push(line.slice(5).trim());
        }
        const data = dataParts.join("");
        if (data === "[DONE]") {
          done = true;
          break;
        }
        if (!data) continue;
        try {
          const json = JSON.parse(data) as Record<string, unknown>;
          if (!res.firstFrame) res.firstFrame = data.slice(0, 600);
          if (typeof json["model"] === "string" && !res.modelEcho) res.modelEcho = json["model"] as string;
          if (json["raw_usage"] && typeof json["raw_usage"] === "object") res.rawUsage = json["raw_usage"] as Record<string, unknown>;
          const choices = (json["choices"] as Array<Record<string, unknown>> | undefined) ?? [];
          for (const choice of choices) {
            const delta = (choice["delta"] as Record<string, unknown> | undefined) ?? {};
            if (typeof delta["content"] === "string") res.text += delta["content"] as string;
            const fr = choice["finish_reason"];
            if (typeof fr === "string" && fr && !res.finishReason) res.finishReason = fr;
          }
        } catch {
          // skip
        }
        idx = buf.indexOf("\n\n");
      }
    }
      res.ok = true;
    } catch (e) {
    res.error = e instanceof Error ? e.message : String(e);
    if (/timed out|Timeout/i.test(res.error ?? "")) res.timeouts = 1;
    console.log(`  ✖ req#${i + 1} ERROR ${res.error.slice(0, 100)}`);
  }
  res.ms = Date.now() - start;
  const rawInfo = res.rawUsage
    ? ` provider=${String(res.rawUsage["provider_model"] ?? res.rawUsage["supply_model"] ?? "?")} target=${String(res.rawUsage["target"] ?? "?")}`
    : "";
  console.log(`  ✔ req#${i + 1} done ms=${res.ms} echo=${res.modelEcho || "-"} finish=${res.finishReason || "-"}${rawInfo}`);
  return res;
}

console.log(`model=${values.model} requests=${N} stagger=${staggerMs}ms concurrency=${concurrency} timeout=${timeoutMs}ms`);
console.log(`account=${account.label ?? "?"} token=${token.slice(0, 4)}…${token.slice(-4)}`);

// Bangun timeline: stagger (default) atau burst (semua t=0)
const starts = Array.from({ length: N }, (_, i) => (values.burst ? 0 : i * staggerMs));
const tasks = starts.map((t, i) => ({ t, i }));

const results: BatchResult[] = [];
const startAnchor = Date.now();

async function worker(): Promise<void> {
  while (true) {
    const task = tasks.shift();
    if (!task) return;
    // stagger: tunggu hingga waktunya relatif startAnchor
    const wait = task.t - (Date.now() - startAnchor);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    const r = await one(task.i);
    results.push(r);
  }
}

(async () => {
  const workers: Promise<void>[] = [];
  for (let i = 0; i < Math.min(concurrency, N); i += 1) workers.push(worker());
  await Promise.all(workers);

  console.log("\n=== SUMMARY ===");
  const ok = results.filter((r) => r.ok);
  console.log(`total=${results.length} ok=${ok.length} fail=${results.length - ok.length}`);
  const providers = new Map<string, number>();
  const targets = new Map<string, number>();
  for (const r of results) {
    const p = r.rawUsage ? String(r.rawUsage["provider_model"] ?? r.rawUsage["supply_model"] ?? "?") : "(no raw_usage)";
    const t = r.rawUsage ? String(r.rawUsage["target"] ?? "?") : "?";
    providers.set(p, (providers.get(p) ?? 0) + 1);
    targets.set(t, (targets.get(t) ?? 0) + 1);
  }
  console.log("\nprovider_model/supply_model distribution:");
  for (const [k, v] of providers) console.log(`  ${v}x ${k}`);
  console.log("\ntarget distribution:");
  for (const [k, v] of targets) console.log(`  ${v}x ${k}`);
  const avg = ok.reduce((a, r) => a + r.ms, 0) / Math.max(1, ok.length);
  console.log(`\navg ms (ok) = ${Math.round(avg)}`);

  // Anomali: echo beda dari model request
  const oddEcho = results.filter((r) => r.ok && r.modelEcho && r.modelEcho !== values.model);
  if (oddEcho.length > 0) {
    console.log(`\n⚠️ MODEL ECHO BERBEDA dari request (${oddEcho.length}):`);
    for (const r of oddEcho) console.log(`  req#${r.n} echo=${r.modelEcho}`);
  }
  // Finish reason yang tidak biasa
  const finishes = new Map<string, number>();
  for (const r of results) {
    const f = r.finishReason || "(empty)";
    finishes.set(f, (finishes.get(f) ?? 0) + 1);
  }
  console.log("\nfinish_reason distribution:");
  for (const [k, v] of finishes) console.log(`  ${v}x ${k}`);
})();
