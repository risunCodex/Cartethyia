/**
 * Dev-only live test against the local Cartethyia gateway.
 *
 * Usage:
 *   bun run scripts/provider-probing/qoder/direct/qoder-gateway-live-test.ts [mode]
 *
 * mode: "tools" (default) | "no-tools" | "tools-no-choice" | "tools-no-parallel"
 *
 * Every mode hits `qwen3.8-flash` through the gateway so the gateway's own
 * account/token handling applies (the upstream token may be refreshed by the
 * gateway's provider machinery). Reports SSE chunks and any retry markers.
 */
import { Database } from "bun:sqlite";
import { decryptCredentialToString } from "../../../../src/security/crypto";

const DB_PATH = process.argv[2] ?? "C:/Users/Aria/AppData/Roaming/cartethyia/cartethyia.sqlite";
const GATEWAY = "http://127.0.0.1:12800/v1/chat/completions";
const MODEL = "qoder/qwen3.8-flash";

function pickApiKey(): string {
  const db = new Database(DB_PATH, { readonly: true });
  const rows = db
    .query(
      `SELECT key_encrypted FROM api_keys
        WHERE enabled = 1 AND revoked_at IS NULL
          AND key_encrypted IS NOT NULL
          AND scopes LIKE '%routing:invoke%'
        ORDER BY created_at DESC LIMIT 1`,
    )
    .all() as Array<Record<string, unknown>>;
  db.close();
  if (rows.length === 0) throw new Error("no routing-capable key with encrypted secret found");
  const enc = (rows[0] as Record<string, unknown>).key_encrypted;
  if (typeof enc !== "object" || enc === null || !("buffer" in enc)) {
    throw new Error("key_encrypted is not a buffer");
  }
  return decryptCredentialToString((enc as { buffer: Uint8Array }).buffer);
}

const TOOL = {
  type: "function",
  function: {
    name: "kalkulator",
    description: "Menghitung hasil operasi aritmatika sederhana.",
    parameters: {
      type: "object",
      properties: {
        expression: { type: "string", description: "Ekspresi aritmatika, mis. '17*23'" },
      },
      required: ["expression"],
    },
  },
};

const TOOL2 = {
  type: "function",
  function: {
    name: "kalkulator2",
    description: "Menghitung hasil operasi aritmatika sederhana kedua.",
    parameters: {
      type: "object",
      properties: {
        expression: { type: "string", description: "Ekspresi aritmatika, mis. '8+9'" },
      },
      required: ["expression"],
    },
  },
};

function buildBody(mode: string): Record<string, unknown> {
  const base: Record<string, unknown> = {
    model: MODEL,
    messages: [{ role: "user", content: "Hitung 17 * 23 pakai tool kalkulator ya." }],
    stream: true,
  };
  if (mode === "no-tools") return base;
  if (mode === "tools" || mode === "raw") {
    return { ...base, tools: [TOOL], tool_choice: "auto" };
  }
  if (mode === "tools-no-choice") {
    return { ...base, tools: [TOOL] };
  }
  if (mode === "tools-no-parallel") {
    return { ...base, tools: [TOOL], tool_choice: "auto", parallel_tool_calls: false };
  }
  if (mode === "tools-multi") {
    return {
      ...base,
      messages: [
        {
          role: "user",
          content: "Hitung 17*23 dan 8+9 sekaligus: panggil tool kalkulator buat 17*23 dan tool kalkulator2 buat 8+9 dalam satu jawaban. Dua panggilan tool paralel.",
        },
      ],
      tools: [TOOL, TOOL2],
      tool_choice: "auto",
    };
  }
  throw new Error(`unknown mode: ${mode}`);
}

async function run(mode: string): Promise<void> {
  const secret = pickApiKey();
  const body = buildBody(mode);
  console.log(`\n========== MODE=${mode} ==========`);
  console.log(`model=${MODEL} tools=${Array.isArray(body.tools) ? (body.tools as unknown[]).length : 0} tool_choice=${"tool_choice" in body ? String(body.tool_choice) : "-"}`);

  const startedAt = Date.now();
  const res = await fetch(GATEWAY, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${secret}`,
    },
    body: JSON.stringify(body),
  });

  console.log(`HTTP ${res.status} ${res.statusText} (${Date.now() - startedAt}ms)`);
  if (!res.ok) {
    const text = await res.text();
    console.log("BODY: " + text.slice(0, 1500));
    return;
  }

  let chunks = 0;
  let contentLen = 0;
  let reasoningLen = 0;
  const toolCalls: Array<{ id: string; name: string; args: string }> = [];
  let terminal: string | undefined;
  let sawError = false;
  let sawRetry = false;
  let firstContentLogged = false;
  const rawDump = mode === "raw";

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === "[DONE]") {
        terminal = terminal ?? "DONE";
        continue;
      }
      let ev: unknown;
      try {
        ev = JSON.parse(payload);
      } catch {
        continue;
      }
      chunks += 1;
      if (typeof ev !== "object" || ev === null) continue;
      const e = ev as Record<string, unknown>;
      if (rawDump) {
        console.log(`  [chunk ${chunks}] RAW: ${JSON.stringify(e).slice(0, 700)}`);
      }

      if (e.error) {
        sawError = true;
        console.log(`  [chunk ${chunks}] ERROR: ${JSON.stringify(e.error).slice(0, 400)}`);
        continue;
      }
      if (e.retry || e.retry_after || e.retry_reason) {
        sawRetry = true;
        console.log(`  [chunk ${chunks}] RETRY MARKER: ${JSON.stringify(e).slice(0, 300)}`);
        continue;
      }

      const choices = e.choices;
      if (!Array.isArray(choices) || choices.length === 0) {
        if (e.usage) console.log(`  [chunk ${chunks}] usage=${JSON.stringify(e.usage)}`);
        continue;
      }
      const delta = (choices[0] as Record<string, unknown>).delta as Record<string, unknown> | undefined;
      if (delta) {
        if (typeof delta.content === "string" && delta.content.length > 0) {
          contentLen += delta.content.length;
          if (!firstContentLogged) {
            firstContentLogged = true;
            console.log(`  [chunk ${chunks}] first content: ${JSON.stringify(delta.content.slice(0, 120))}`);
          }
        }
        if (typeof delta.reasoning_content === "string") {
          reasoningLen += delta.reasoning_content.length;
        }
        const tcs = delta.tool_calls;
        if (Array.isArray(tcs) && tcs.length > 0) {
          for (const raw of tcs as Array<Record<string, unknown>>) {
            const fn = (raw.function ?? {}) as Record<string, unknown>;
            const id = typeof raw.id === "string" ? raw.id : `call_${String(raw.index ?? toolCalls.length)}`;
            const name = typeof fn.name === "string" ? fn.name : "";
            const args = typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments ?? "");
            let existing = toolCalls.find((t) => t.id === id);
            if (!existing) {
              existing = { id, name, args: "" };
              toolCalls.push(existing);
            }
            if (name) existing.name = name;
            if (args && args !== '""') existing.args += args;
          }
          if (chunks <= 3) console.log(`  [chunk ${chunks}] tool_calls delta: ${JSON.stringify((delta.tool_calls as unknown[]).slice(0, 2)).slice(0, 250)}`);
        }
      }
      const finish = (choices[0] as Record<string, unknown>).finish_reason;
      if (typeof finish === "string" && finish.length > 0) {
        terminal = finish;
        console.log(`  [chunk ${chunks}] finish_reason=${finish}`);
      }
    }
  }

  console.log(`--- hasil (${Date.now() - startedAt}ms) ---`);
  console.log(`chunks=${chunks} content_chars=${contentLen} reasoning_chars=${reasoningLen}`);
  console.log(`tool_calls=${toolCalls.length}`);
  for (const tc of toolCalls) {
    console.log(`  -> id=${tc.id.slice(0, 16)} name=${tc.name} args=${tc.args.slice(0, 200)}`);
  }
  console.log(`terminal=${terminal ?? "(none)"} sawError=${sawError} sawRetry=${sawRetry}`);
}

const mode = process.argv[3] ?? "tools";
await run(mode).catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
