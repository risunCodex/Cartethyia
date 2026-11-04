/**
 * Probe: does the Qoder model server retain conversation history per
 * `session_id`? If yes, a 1M-token context can be built cumulatively across
 * turns without re-sending history (each turn's body stays under the ~256KB
 * upstream body cap). If no, accumulated history must be re-sent every turn,
 * which blows the body cap around ~4-5 turns.
 *
 * Design:
 *   - One fixed session_id.
 *   - Turn 0 sends ~60k tokens + a secret marker.
 *   - Turn 1 asks for the marker (retention check).
 *   - Turns 2..N each send ~60k new tokens, up to ~1M total, then ask for
 *     the marker again (retention at scale).
 *
 * Usage:
 *   bun run scripts/provider-probing/qoder/qoder-session-retention-probe.ts \
 *     --creds <accounts.json> [--model dmodel] [--turns 17] [--per-turn 60000]
 */
import { parseArgs } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { pickAccount, readAccountsFile, requireAccountToken } from "../lib/accounts";

const args = parseArgs({
  options: {
    creds: { type: "string", required: true },
    label: { type: "string" },
    model: { type: "string", default: "dmodel" },
    turns: { type: "string", default: "17" },
    perTurn: { type: "string", default: "60000" },
    "per-turn": { type: "string" },
  },
});

const j = readAccountsFile(args.values.creds!);
const account = pickAccount(j, {
  ...(args.values.label !== undefined ? { label: args.values.label } : {}),
});
const token = requireAccountToken(account);
const userId = account.authState?.userId ?? "";
const model = args.values.model!;
const turns = Number(args.values.turns);
const perTurn = Number(args.values.perTurn ?? args.values["per-turn"]);
const VERSION = "1.1.81";
const URL = "https://api2-v2.qoder.sh/model/v1/chat/completions";
const machineId = randomUUID().replaceAll("-", "");
const sessionId = createHash("sha256").update(`qoder-session:${userId}:${model}`).digest("hex").slice(0, 32);

const MARKER = "SECRET_MARKER_7Q9Z";

function heads(): Record<string, string> {
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

function bodyFor(content: string): Record<string, unknown> {
  return {
    model,
    messages: [{ role: "user", content }],
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
    max_tokens: 64,
    model_config: { max_input_tokens: 1_000_000, max_output_tokens: 65536 },
  };
}

async function chat(content: string): Promise<{ status: number; text: string }> {
  const res = await fetch(URL, {
    method: "POST",
    headers: heads(),
    body: JSON.stringify(bodyFor(content)),
    signal: AbortSignal.timeout(120_000),
  });
  const text = await res.text().catch(() => "");
  return { status: res.status, text };
}

/** Collects the full SSE stream and joins all delta content/meaning chunks. */
async function chatFull(content: string): Promise<{ status: number; reply: string }> {
  const res = await fetch(URL, {
    method: "POST",
    headers: heads(),
    body: JSON.stringify(bodyFor(content)),
    signal: AbortSignal.timeout(120_000),
  });
  const text = await res.text().catch(() => "");
  // The IDE surface streams `data:` JSON events; join every delta in order.
  const parts: string[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (payload === "[DONE]") break;
    try {
      const evt = JSON.parse(payload) as {
        choices?: Array<{ delta?: { content?: string | null } }>;
      };
      for (const choice of evt.choices ?? []) {
        const delta = choice.delta?.content;
        if (typeof delta === "string" && delta.length > 0) parts.push(delta);
      }
    } catch {
      // skip non-JSON data lines
    }
  }
  return { status: res.status, reply: parts.join("") };
}

console.log(`=== Qoder session retention probe ===`);
console.log(`model=${model} session=${sessionId.slice(0, 8)}… turns=${turns} perTurn=${perTurn}`);
console.log(`marker=${MARKER}`);

// Turn 0: big payload + marker
const t0Payload = "x".repeat(perTurn * 4) + ` [MEMO: the marker is ${MARKER}]`;
console.log(`\n[turn 0] sending ~${(t0Payload.length / 4).toLocaleString()} tokens (${t0Payload.length.toLocaleString()} chars)`);
let r = await chat(t0Payload);
console.log(`  status=${r.status} first=${r.text.replace(/\s+/g, " ").slice(0, 100)}`);

// Turn 1: retention check
console.log(`\n[turn 1] asking marker (retention check)`);
const r1 = await chatFull(`What is the exact secret marker from the first message of this session? Reply with only the marker string.`);
const knows1 = r1.reply.includes(MARKER);
console.log(`  status=${r1.status} knowsMarker=${knows1}`);
console.log(`  reply="${r1.reply.slice(0, 400)}"`);
console.log(`  replyLen=${r1.reply.length}`);

if (!knows1) {
  console.log(`\n=> Server does NOT retain history per session_id. Cumulative 1M is not feasible via turns.`);
  process.exit(0);
}

// Turns 2..N: keep stacking new tokens
let cumulativeTokens = (t0Payload.length / 4) + 1;
for (let t = 2; t <= turns; t += 1) {
  const payload = "y".repeat(perTurn * 4) + ` [TURN_${t} ${randomUUID().slice(0, 8)}]`;
  cumulativeTokens += perTurn;
  console.log(`\n[turn ${t}] cumulative≈${Math.round(cumulativeTokens / 1000)}k tokens`);
  r = await chat(payload);
  const ok = r.status === 200;
  console.log(`  status=${r.status} ${ok ? "" : r.text.replace(/\s+/g, " ").slice(0, 120)}`);
  if (!ok) {
    console.log(`=> Failed at cumulative ${Math.round(cumulativeTokens / 1000)}k tokens`);
    break;
  }
}

// Final retention check
console.log(`\n[final] asking marker again at cumulative≈${Math.round(cumulativeTokens / 1000)}k tokens`);
const rFinal = await chatFull(`What is the exact secret marker from the first message of this session? Reply with only the marker string.`);
console.log(`  status=${rFinal.status} knowsMarker=${rFinal.reply.includes(MARKER)}`);
console.log(`  reply="${rFinal.reply.slice(0, 400)}"`);
console.log(`  replyLen=${rFinal.reply.length}`);
