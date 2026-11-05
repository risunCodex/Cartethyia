/**
 * Single-request IDE/HTTP probe that captures the full `raw_usage` metadata
 * (supply_model/supply_account/supply_region/provider_model/target/model_context)
 * plus model echo and usage. Since `raw_usage` is not always present, retries
 * up to `--attempts` times until it is captured (one request at a time).
 *
 * Usage:
 *   bun run scripts/provider-probing/qoder/direct/direct-single-meta.ts \
 *     --creds <accounts.json> --model cmodel \
 *     [--prompt "Halo"] [--attempts 3] [--timeout-ms 90000]
 */
import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { hostname as osHostname } from "node:os";

const { values } = parseArgs({
  options: {
    creds: { type: "string" },
    token: { type: "string" },
    model: { type: "string", default: "cmodel" },
    prompt: { type: "string", default: "Halo, jawab dalam satu kalimat: apa itu 1+1?" },
    attempts: { type: "string", default: "3" },
    "fresh-session": { type: "boolean", default: false },
    "timeout-ms": { type: "string", default: "90000" },
  },
});

const creds = values.creds;
if (!creds && !values.token) throw new Error("--creds <path> or --token <jt/dt/pt> is required");
const attempts = Number(values.attempts);
const timeoutMs = Number(values["timeout-ms"]);

const raw = values.token ? null : JSON.parse(readFileSync(creds!, "utf8"));
const account = values.token ? { label: "job-token" } : (Array.isArray(raw) ? raw : raw.accounts ?? [])[0];
const token = values.token ?? account.accessToken ?? account.token ?? "";
const userId: string = values.token ? "" : (account.authState?.userId ?? "");
const machineId: string = values.token ? randomUUID() : (account.authState?.machineId ?? randomUUID());
const VERSION = "1.1.83";
const IDE_URL = "https://api2-v2.qoder.sh/model/v1/chat/completions";

function machineOs(): string {
  const arch = process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : process.arch;
  return `${arch}_${process.platform}`;
}
function machineHostname(): string {
  const s = (osHostname() ?? "").trim().toLowerCase();
  const safe = s.replace(/[^\x21-\x7e]+/gu, "-").replace(/-{2,}/gu, "-").replace(/^-+|-+$/gu, "");
  return safe.length <= 96 ? safe : `${safe.slice(0, 87)}-${createHash("sha256").update(safe).digest("hex").slice(0, 8)}`;
}
function sessionIdFor(uid: string, m: string): string {
  return createHash("sha256").update(`qoder-session:${uid}:${m}`).digest("hex").slice(0, 32);
}

console.log(`account=${account.label ?? "?"} token=${token.slice(0, 4)}…${token.slice(-4)}`);
console.log(`model=${values.model} attempts=${attempts} prompt="${values.prompt}"`);

interface Capture {
  rawUsage: Record<string, unknown> | undefined;
  modelEcho: string;
  usage: Record<string, unknown> | undefined;
  text: string;
  finishReason: string;
  responseHeaders: Record<string, string>;
  status: number;
  ms: number;
}

async function attempt(): Promise<Capture> {
  const start = Date.now();
  const rid = randomUUID();
  const sessionId = values["fresh-session"] ? randomUUID() : sessionIdFor(userId, values.model!);
  const body = {
    model: values.model,
    messages: [{ role: "user", content: values.prompt }],
    stream: true,
    stream_options: { include_usage: true },
    metadata: {
      context: {
        request_id: rid,
        request_set_id: randomUUID(),
        session_id: sessionId,
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

  const res = await fetch(IDE_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      "X-Request-ID": rid,
      "X-Session-ID": sessionId,
      "Cosy-Version": VERSION,
      "Cosy-ClientType": "5",
      "Cosy-MachineOS": machineOs(),
      "Cosy-MachineHostname": machineHostname(),
      "Cosy-MachineId": machineId,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });

  const cap: Capture = {
    rawUsage: undefined,
    modelEcho: "",
    usage: undefined,
    text: "",
    finishReason: "",
    responseHeaders: {},
    status: res.status,
    ms: 0,
  };
  res.headers.forEach((v, k) => {
    cap.responseHeaders[k] = v;
  });

  if (!res.ok) {
    cap.ms = Date.now() - start;
    console.log(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return cap;
  }

  const reader = res.body?.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (reader) {
    const { value, done } = await reader.read();
    if (done) break;
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
        cap.ms = Date.now() - start;
        return cap;
      }
      if (!data) continue;
      try {
        const json = JSON.parse(data) as Record<string, unknown>;
        if (typeof json["model"] === "string" && !cap.modelEcho) cap.modelEcho = json["model"] as string;
        if (json["raw_usage"] && typeof json["raw_usage"] === "object") cap.rawUsage = json["raw_usage"] as Record<string, unknown>;
        if (json["usage"] && typeof json["usage"] === "object") cap.usage = json["usage"] as Record<string, unknown>;
        const choices = (json["choices"] as Array<Record<string, unknown>> | undefined) ?? [];
        for (const choice of choices) {
          const delta = (choice["delta"] as Record<string, unknown> | undefined) ?? {};
          if (typeof delta["content"] === "string") cap.text += delta["content"] as string;
          const fr = choice["finish_reason"];
          if (typeof fr === "string" && fr && !cap.finishReason) cap.finishReason = fr;
        }
      } catch {
        // skip
      }
      idx = buf.indexOf("\n\n");
    }
  }
  cap.ms = Date.now() - start;
  return cap;
}

(async () => {
  for (let i = 0; i < attempts; i += 1) {
    console.log(`\n--- attempt ${i + 1}/${attempts} ---`);
    const cap = await attempt();
    console.log(`HTTP ${cap.status} · ms=${cap.ms} · echo=${cap.modelEcho || "-"} · finish=${cap.finishReason || "-"} · text="${cap.text.slice(0, 80)}"`);
    console.log(`response headers: ${JSON.stringify(cap.responseHeaders)}`);
    if (cap.rawUsage) {
      console.log("\n=== RAW_USAGE (metadata) ===");
      console.log(JSON.stringify(cap.rawUsage, null, 2));
      return;
    }
    console.log("(raw_usage tidak muncul — coba lagi)");
  }
  console.log("\n⚠️ raw_usage tidak muncul setelah semua percobaan.");
})();
