/**
 * Qoder IDE-surface capacity probe (absorbed `qoder-context-probe.ts` and
 * `qoder-session-retention-probe.ts` into one script with two modes).
 *
 * Modes:
 *   - context (default): for each size in `--sizes`, sends an IDE chat with a
 *     padded user message sized to N tokens (4.2 chars/token) plus a short
 *     follow-up, and reports status + first response bytes. Exercises
 *     `model_config.max_input_tokens` at the given `--cfg` ceiling.
 *   - retention: marker-retention design — one fixed `session_id`, turn 0
 *     sends ~perTurn tokens + a hidden marker, turn 1 asks for the marker, and
 *     turns 2..N each send perTurn more tokens then ask for the marker again.
 *     Prints per-turn whether the marker survives.
 *
 * All requests are raw JSON POSTs to the modern IDE surface
 * (`QODER_IDE_CHAT_URL`, plain bearer, no legacy COSY signing).
 *
 *   bun run scripts/provider-probing/qoder/chat/qoder-capacity-probe.ts \
 *     --creds <accounts.json> [--label "Akun Ytprem"] \
 *     [--model dmodel] [--mode context|retention] \
 *     [--cfg 1000000] [--sizes 1000,20000,60000,100000,150000,170000,180000,200000,400000,1000000] \
 *     [--turns 17] [--per-turn 60000] [--timeout-ms 120000]
 */
import { parseArgs } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import {
  buildIdeChatBody,
  ideChatHeaders,
  loadProbeAccount,
  QODER_IDE_CHAT_URL,
  QODER_VERSION,
  readSse,
} from "../lib/shared";

const args = parseArgs({
  options: {
    creds: { type: "string", required: true },
    label: { type: "string" },
    model: { type: "string", default: "dmodel" },
    mode: { type: "string", default: "context" },
    cfg: { type: "string", default: "1000000" },
    sizes: {
      type: "string",
      default: "1000,20000,60000,100000,150000,170000,180000,200000,400000,1000000",
    },
    turns: { type: "string", default: "17" },
    "per-turn": { type: "string", default: "60000" },
    "timeout-ms": { type: "string", default: "120000" },
  },
});

const mode = args.values.mode;
if (mode !== "context" && mode !== "retention") {
  throw new Error(`--mode must be "context" or "retention" (got "${mode}")`);
}

const TIMEOUT_MS = Number(args.values["timeout-ms"]);
const creds = args.values.creds;
if (creds === undefined) throw new Error("--creds <path> is required");
const { account, token, userId, machineId } = loadProbeAccount({
  creds,
  ...(args.values.label !== undefined ? { label: args.values.label } : {}),
});
const model = args.values.model;
const cfg = Number(args.values.cfg);
const turns = Number(args.values.turns);
const perTurn = Number(args.values["per-turn"]);

const MARKER = "SECRET_MARKER_7Q9Z";

function parseSizes(csv: string): number[] {
  const sizes = csv
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (sizes.length === 0) throw new Error(`--sizes must contain positive numbers (got "${csv}")`);
  return sizes;
}

async function postChat(body: Record<string, unknown>, headers: Record<string, string>): Promise<Response> {
  return fetch(QODER_IDE_CHAT_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

async function runContext(): Promise<void> {
  const headers = ideChatHeaders({ token, machineId });
  const sizes = parseSizes(args.values.sizes);

  console.log("=== Qoder context acceptance probe ===");
  console.log(`model=${model} account=${account.label ?? "(no label)"} model_config.max_input_tokens=${cfg}`);

  for (const tokens of sizes) {
    const content = `[context probe ${tokens} tokens] ${"x".repeat(Math.floor(tokens * 4.2))}`;
    const built = buildIdeChatBody({
      model,
      message: content,
      maxTokens: 16,
      contextTokens: cfg,
      outputTokens: 65_536,
    });
    built.body.messages = [
      { role: "user", content },
      { role: "user", content: "Reply with the single word ok." },
    ];

    const start = Date.now();
    const res = await postChat(built.body, headers);
    const text = await res.text().catch(() => "");
    const head = text.replace(/\s+/g, " ").slice(0, 160);
    console.log(`\n[tokens=${tokens.toLocaleString()}] ${res.status} (${Date.now() - start}ms)`);
    console.log(`  ${head || "(empty)"}`);
  }
}

async function runRetention(): Promise<void> {
  const sessionId = createHash("sha256").update(`qoder-session:${userId}:${model}`).digest("hex").slice(0, 32);
  const headers = ideChatHeaders({ token, machineId, sessionId });

  /** Builds one IDE chat body pinned to the fixed session_id. */
  function buildMsg(content: string): Record<string, unknown> {
    const built = buildIdeChatBody({
      model,
      message: content,
      maxTokens: 64,
      contextTokens: 1_000_000,
      outputTokens: 65_536,
    });
    built.body.messages = [{ role: "user", content }];
    built.body.metadata = {
      context: {
        request_id: built.rid,
        request_set_id: randomUUID(),
        session_id: sessionId,
        source_session_id: "",
        task_id: "common",
        client_type: "5",
      },
      business: {
        business_product: "cli",
        business_type: "agent",
        business_version: QODER_VERSION,
        scene: "assistant",
      },
    };
    return built.body;
  }

  async function sendTurn(content: string): Promise<number> {
    const res = await postChat(buildMsg(content), headers);
    await readSse(res, {}); // drain/cancel the body so the connection closes
    return res.status;
  }

  async function askMarker(): Promise<{ readonly status: number; readonly reply: string }> {
    const res = await postChat(
      buildMsg(
        "What is the exact secret marker from the first message of this session? Reply with only the marker string.",
      ),
      headers,
    );
    let reply = "";
    await readSse(res, {
      onDelta(text) {
        reply += text;
      },
    });
    return { status: res.status, reply };
  }

  console.log("=== Qoder session retention probe ===");
  console.log(`model=${model} session=${sessionId.slice(0, 8)}… turns=${turns} perTurn=${perTurn}`);
  console.log(`marker=${MARKER}`);

  // Turn 0: big payload + marker
  const t0Payload = "x".repeat(Math.floor(perTurn * 4.2)) + ` [MEMO: the marker is ${MARKER}]`;
  console.log(
    `\n[turn 0] sending ~${Math.round(t0Payload.length / 4.2).toLocaleString()} tokens (${t0Payload.length.toLocaleString()} chars)`,
  );
  const s0 = await sendTurn(t0Payload);
  console.log(`  status=${s0}`);

  // Turn 1: retention check
  console.log("\n[turn 1] asking marker (retention check)");
  const r1 = await askMarker();
  const knows1 = r1.reply.includes(MARKER);
  console.log(`  status=${r1.status} knowsMarker=${knows1}`);
  console.log(`  reply="${r1.reply.slice(0, 400)}"`);
  console.log(`  replyLen=${r1.reply.length}`);
  if (!knows1) {
    console.log("  [notice] marker not found — server may not retain history per session_id");
  }

  // Turns 2..N: stack new tokens, then ask for the marker again
  let cumulativeTokens = Math.floor(t0Payload.length / 4.2) + 1;
  for (let t = 2; t <= turns; t += 1) {
    const payload = "y".repeat(Math.floor(perTurn * 4.2)) + ` [TURN_${t} ${randomUUID().slice(0, 8)}]`;
    cumulativeTokens += perTurn;
    console.log(`\n[turn ${t}] cumulative≈${Math.round(cumulativeTokens / 1000)}k tokens`);
    const st = await sendTurn(payload);
    console.log(`  status=${st}`);
    if (st !== 200) {
      console.log(`=> Failed at cumulative ${Math.round(cumulativeTokens / 1000)}k tokens`);
      break;
    }
    const r = await askMarker();
    const found = r.reply.includes(MARKER);
    console.log(`  knowsMarker=${found}`);
    console.log(`  reply="${r.reply.slice(0, 200)}"`);
  }
}

if (mode === "context") {
  await runContext();
} else {
  await runRetention();
}
