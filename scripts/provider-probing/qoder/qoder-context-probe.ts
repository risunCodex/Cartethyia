/**
 * Probe: how much context does the Qoder IDE surface accept for lite-plan
 * slots? Sends chat completions with padded user content sized to N tokens for
 * each target slot and reports status + first response bytes.
 *
 * Writes no secrets; output shows only statuses and heads.
 */
import { randomUUID } from "node:crypto";
import { pickAccount, readAccountsFile, requireAccountToken } from "../lib/accounts";

const VERSION = "1.1.81";
const URL = "https://api2-v2.qoder.sh/model/v1/chat/completions";

const args = process.argv.slice(2);
const credsIndex = args.indexOf("--creds");
const creds = credsIndex >= 0 ? args[credsIndex + 1] : undefined;
const model = args.includes("--model") ? args[args.indexOf("--model") + 1] : "qfmodel";
const cfg = args.includes("--cfg") ? Number(args[args.indexOf("--cfg") + 1]) : 1_000_000;
const sizesArg = args.indexOf("--sizes");
const sizesValue = sizesArg >= 0 ? args[sizesArg + 1] : undefined;
const SIZES = sizesValue !== undefined
  ? sizesValue.split(",").map((s) => Number(s.trim()))
  : [1_000, 20_000, 60_000, 100_000, 150_000, 170_000, 180_000, 200_000, 400_000, 1_000_000];
if (!creds) {
  console.error("usage: bun qoder-context-probe.ts --creds <file> [--model qfmodel] [--cfg 1000000] [--sizes 1000,60000,180000]");
  process.exit(1);
}

const j = readAccountsFile(creds);
const account = pickAccount(j);
const token = requireAccountToken(account);

const machineId = randomUUID().replaceAll("-", "");
const sessionId = randomUUID();

function ideHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    "X-Request-ID": randomUUID(),
    "X-Session-ID": sessionId,
    "Cosy-Version": VERSION,
    "Cosy-ClientType": "5",
    "Cosy-MachineOS": "aarch64_macos",
    "Cosy-MachineHostname": "DESKTOP-QODER",
    "Cosy-MachineId": machineId,
    "Cosy-MachineToken": machineId,
    "Cosy-MachineType": "5",
  };
}

function bodyFor(tokens: number): Record<string, unknown> {
  const payload = "x".repeat(Math.floor(tokens * 4.2));
  return {
    model,
    messages: [
      { role: "user", content: `[context probe ${tokens} tokens] ${payload}` },
      { role: "user", content: "Reply with the single word ok." },
    ],
    stream: true,
    stream_options: { include_usage: true },
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
    max_tokens: 16,
    model_config: { max_input_tokens: cfg, max_output_tokens: 65536 },
  };
}

console.log(`=== Qoder context acceptance probe ===`);
console.log(`model=${model} account=${account.label ?? "(no label)"} model_config.max_input_tokens=${cfg}`);
for (const tokens of SIZES) {
  const body = bodyFor(tokens);
  const start = Date.now();
  const res = await fetch(URL, {
    method: "POST",
    headers: ideHeaders(),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text().catch(() => "");
  const head = text.replace(/\s+/g, " ").slice(0, 160);
  console.log(`\n[tokens=${tokens.toLocaleString()}] ${res.status} (${Date.now() - start}ms)`);
  console.log(`  ${head || "(empty)"}`);
}
