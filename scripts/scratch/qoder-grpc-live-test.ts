/**
 * Dev-only live test: hits the local Cartethyia gateway (127.0.0.1:12800)
 * with model `qwen3.8-flash` + a function tool, and reports the SSE stream.
 *
 * The API key is read from the Lite SQLite DB and decrypted in-process —
 * never printed. Replays the exact scenario that previously failed with
 * "Qoder gRPC stream failed … object expected" / 400 upstream / DSML leak.
 */
import { Database } from "bun:sqlite";
import { decryptCredentialToString } from "../../src/security/crypto";

const DB_PATH = process.argv[2] ?? "C:/Users/Aria/AppData/Roaming/cartethyia/cartethyia.sqlite";
const GATEWAY = "http://127.0.0.1:12800/v1/chat/completions";
const MODEL = "qwen3.8-flash";

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

async function main(): Promise<void> {
  const secret = pickApiKey();
  const masked = `${secret.slice(0, 8)}…${secret.slice(-4)}`;
  console.log(`gateway=${GATEWAY}`);
  console.log(`model=${MODEL}`);
  console.log(`key=${masked} (len=${secret.length})`);

  const body = {
    model: MODEL,
    messages: [
      {
        role: "user",
        content: "Hitung 17 * 23 pakai tool kalkulator ya.",
      },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "kalkulator",
          description: "Menghitung hasil operasi aritmatika sederhana.",
          parameters: {
            type: "object",
            properties: {
              expression: {
                type: "string",
                description: "Ekspresi aritmatika, mis. '17*23'",
              },
            },
            required: ["expression"],
          },
        },
      },
    ],
    tool_choice: "auto",
    stream: true,
  };

  const startedAt = Date.now();
  const res = await fetch(GATEWAY, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${secret}`,
    },
    body: JSON.stringify(body),
  });

  console.log(`\nHTTP ${res.status} ${res.statusText} (${Date.now() - startedAt}ms)`);
  res.headers.forEach((v, k) => console.log(`  ${k}: ${v}`));

  if (!res.ok) {
    const text = await res.text();
    console.log("BODY: " + text.slice(0, 2000));
    return;
  }

  let chunks = 0;
  let contentLen = 0;
  let reasoningLen = 0;
  const toolCalls: Array<{ id: string; name: string; args: string }> = [];
  let terminal: string | undefined;
  let sawError = false;
  let sawRetry = false;

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
        if (typeof delta.content === "string") {
          contentLen += delta.content.length;
          if (chunks <= 2 || contentLen <= 120) {
            console.log(`  [chunk ${chunks}] content: ${JSON.stringify(delta.content.slice(0, 80))}`);
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
        }
      }
      const finish = (choices[0] as Record<string, unknown>).finish_reason;
      if (typeof finish === "string" && finish.length > 0) {
        terminal = finish;
        console.log(`  [chunk ${chunks}] finish_reason=${finish}`);
      }
    }
  }

  console.log(`\n=== HASIL ===`);
  console.log(`chunks=${chunks}`);
  console.log(`content_chars=${contentLen}`);
  console.log(`reasoning_chars=${reasoningLen}`);
  console.log(`tool_calls=${toolCalls.length}`);
  for (const tc of toolCalls) {
    console.log(`  -> id=${tc.id.slice(0, 16)} name=${tc.name} args=${tc.args.slice(0, 200)}`);
  }
  console.log(`terminal=${terminal ?? "(none)"}`);
  console.log(`sawError=${sawError}`);
  console.log(`sawRetry=${sawRetry}`);

  const ok = !sawError && !sawRetry && toolCalls.length > 0 && terminal === "tool_calls";
  console.log(`\nVERDICT: ${ok ? "PASS ✅ (tool_calls streamed)" : "FAIL ❌"}`);
}

await main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
