/**
 * Live Qoder wire probe: plugin (COSY Bearer) vs IDE (plain Bearer).
 *
 * Reusable probe for the two Qoder chat surfaces. It reads exported accounts
 * from a JSON file, never prints tokens, and shows only status + first bytes
 * of each upstream response.
 *
 *   bun run scripts/provider-probing/qoder/probe-qoder.ts \
 *     --creds "C:\Users\...\qoder-accounts-<ts>.json"
 *
 *   # Probe a specific model on both surfaces (default: auto)
 *   bun run scripts/provider-probing/qoder/probe-qoder.ts \
 *     --creds <file> --model qmodel
 *
 *   # Probe every model in the roster
 *   bun run scripts/provider-probing/qoder/probe-qoder.ts --creds <file> --all
 *
 *   # Skip the plugin surface (only the IDE /model/v1 path)
 *   bun run scripts/provider-probing/qoder/probe-qoder.ts --creds <file> --ide-only
 *
 * The credential is read from the file only and is never printed, echoed, or
 * written. Output shows probes, statuses, and response heads — nothing else.
 */
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import {
  maskSecret,
  maskUuid,
  pickAccount,
  readAccountsFile,
  requireAccountToken,
  type ExportedAccount,
} from "../lib/accounts";
import { formatProbe, probeGet, probePost } from "../lib/http";
import { buildCosyHeaders, transformQoderBody } from "./cosy-signer";

const VERSION = "1.1.81";
const IDE_URL = "https://api2-v2.qoder.sh/model/v1/chat/completions";

const MODELS = ["auto", "qmodel", "dmodel", "qwen3.8-max"] as const;

interface QoderAuth {
  readonly userId: string;
  readonly userName: string;
  readonly userType: string;
  readonly securityOauthToken: string;
  readonly refreshToken: string;
}

function authFromAccount(account: ExportedAccount): QoderAuth {
  return {
    userId: account.authState?.userId ?? "",
    userName: "",
    userType: "personal_standard",
    securityOauthToken: requireAccountToken(account),
    refreshToken: "",
  };
}

function ideBody(model: string, requestId: string, requestSetId: string, sessionId: string): Record<string, unknown> {
  // Shape mirrors the IDE's PFn() body builder for the model-server surface.
  return {
    model,
    messages: [{ role: "user", content: "ping" }],
    stream: true,
    stream_options: { include_usage: true },
    metadata: {
      context: {
        request_id: requestId,
        request_set_id: requestSetId,
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
  };
}

function ideHeaders(auth: QoderAuth, machineId: string, requestId: string, sessionId: string): Record<string, string> {
  return {
    Authorization: `Bearer ${auth.securityOauthToken}`,
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    "X-Request-ID": requestId,
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

/**
 * Lists models from the shared gateway surface (`/algo/api/v2/model/list`).
 *
 * This is the endpoint both the plugin and the IDE use. The request is a GET
 * that carries the signed `{}` body — the COSY signature covers the body, so
 * a bare or plain-bearer GET fails with `101 Signature invalid`. The IDE also
 * signs this endpoint (its worker uses the WASM signer), so the same signed
 * probe serves both surfaces; `--ide` only changes the label.
 */
async function listModels(
  auth: QoderAuth,
  machineId: string,
  opts: { readonly ide?: boolean } = {},
): Promise<void> {
  const url = "https://api2.qoder.sh/algo/api/v2/model/list?Encode=1";
  const rawBody = "{}";
  const encoded = transformQoderBody(rawBody);
  const headers = {
    ...buildCosyHeaders(url, rawBody, auth, VERSION),
    "x-model-key": "auto",
    "x-model-source": "system",
  };
  void machineId;
  const res = await probeGet(url, headers, { body: encoded, bodyCap: 100_000 });
  console.log(formatProbe(opts.ide ? "ide/model/list (signed)" : "plugin/model/list", res));
  try {
    const parsed = JSON.parse(res.body) as { chat?: Array<Record<string, unknown>>; error?: unknown };
    const chat = parsed.chat;
    if (values.json && Array.isArray(chat)) {
      const pretty = JSON.stringify(chat, null, 2);
      if (values.out !== undefined) {
        writeFileSync(values.out, `${pretty}\n`, "utf8");
        console.log(`  wrote ${values.out} (${chat.length} models)`);
      } else {
        console.log(pretty);
      }
      return;
    }
    if (Array.isArray(chat)) {
      for (const row of chat) {
        const key = String(row["key"] ?? "");
        const display = String(row["display_name"] ?? "");
        const vl = row["is_vl"] === true ? " vl" : "";
        const reasoning = row["is_reasoning"] === true ? " reasoning" : "";
        const free = row["is_free"] === true ? " free" : "";
        const def = row["is_default"] === true ? " default" : "";
        const ctx = row["max_input_tokens"] !== undefined ? ` ctx=${String(row["max_input_tokens"])}` : "";
        const format = typeof row["format"] === "string" ? ` fmt=${String(row["format"])}` : "";
        const status = typeof row["status"] === "string" ? ` status=${String(row["status"])}` : "";
        console.log(`  - ${key} (${display})${vl}${reasoning}${free}${def}${ctx}${format}${status}`);
      }
    } else if (parsed.error !== undefined) {
      console.log(`  error: ${JSON.stringify(parsed.error).slice(0, 400)}`);
    } else {
      console.log(`  (unexpected shape: ${res.head.slice(0, 160)})`);
    }
  } catch {
    // Body is not JSON; the head already shows what came back.
  }
}



async function probeIde(auth: QoderAuth, machineId: string, model: string): Promise<void> {
  const rid = randomUUID();
  const ridSet = randomUUID();
  const sid = randomUUID();
  const res = await probePost(
    IDE_URL,
    ideHeaders(auth, machineId, rid, sid),
    JSON.stringify(ideBody(model, rid, ridSet, sid)),
  );
  console.log(formatProbe(`ide/model-v1 (${model})`, res));
}

/** Reads enough of an SSE stream to surface the model's actual text reply. */
async function probeReply(
  label: string,
  url: string,
  headers: Record<string, string>,
  encoded: Buffer,
  timeoutMs: number,
): Promise<void> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: encoded as unknown as BodyInit,
      signal: ac.signal,
    });
    console.log(`[${label}] status=${response.status}`);
    if (!response.body) {
      console.log("  (empty body)");
      return;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let frames = 0;
    let text = "";
    let reasoning = "";
    let stopped = false;
    try {
      while (frames < 60) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx = buf.indexOf("\n\n");
        while (idx >= 0) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          frames += 1;
          for (const line of chunk.split(/\r?\n/)) {
            if (!line.startsWith("data:")) continue;
            const data = line.slice(5).trim();
            if (data === "[DONE]") {
              stopped = true;
              continue;
            }
            try {
              const json = JSON.parse(data) as {
                choices?: Array<{ delta?: { content?: string; reasoning_content?: string }; finish_reason?: string | null }>;
                error?: unknown;
              };
              if (json.error !== undefined) {
                console.log(`  error: ${JSON.stringify(json.error).slice(0, 400)}`);
                stopped = true;
                continue;
              }
              const delta = json.choices?.[0]?.delta;
              if (delta) {
                if (typeof delta.content === "string") text += delta.content;
                if (typeof delta.reasoning_content === "string") reasoning += delta.reasoning_content;
              }
              const fr = json.choices?.[0]?.finish_reason;
              if (fr) stopped = true;
            } catch {
              // not JSON — ignore non-data lines
            }
          }
          idx = buf.indexOf("\n\n");
        }
        if (stopped) break;
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    if (reasoning.length > 0) console.log(`  reasoning: ${reasoning.slice(0, 800)}`);
    console.log(`  text: ${text.slice(0, 1500) || "(no text content yet)"}`);
    console.log(`  frames: ${frames} stopped=${stopped}`);
  } catch (error) {
    console.log(`  ERROR ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timer);
  }
}

const { values } = parseArgs({
  options: {
    creds: { type: "string" },
    model: { type: "string", default: "auto" },
    all: { type: "boolean", default: false },
    "ide-only": { type: "boolean", default: false },
    models: { type: "boolean", default: false },
    json: { type: "boolean", default: false },
    reply: { type: "boolean", default: false },
    out: { type: "string" },
    label: { type: "string" },
    index: { type: "string" },
    timeout: { type: "string", default: "20000" },
  },
});

const credsPath = values.creds;
if (credsPath === undefined) throw new Error("--creds <path> is required");

const accounts = readAccountsFile(credsPath);
const account = pickAccount(accounts, {
  providerId: "qoder",
  ...(values.label !== undefined ? { label: values.label } : {}),
  ...(values.index !== undefined ? { index: Number(values.index) } : {}),
});
const auth = authFromAccount(account);
const machineId =
  account.authState?.machineId && account.authState.machineId.length > 0
    ? account.authState.machineId
    : randomUUID();

console.log(
  `account=${account.label ?? "?"} (${account.providerId ?? "?"}/${account.credentialKind ?? "?"}) ` +
    `token=${maskSecret(auth.securityOauthToken)} machineId=${maskUuid(machineId)}`,
);

if (values.models) {
  try {
    if (!values["ide-only"]) await listModels(auth, machineId);
    await listModels(auth, machineId, { ide: true });
  } catch (error) {
    console.log(`[models] ERROR ${error instanceof Error ? error.message : String(error)}`);
  }
  process.exit(0);
}

const models = values.all ? [...MODELS] : [values.model as string];
const timeoutMs = Number(values.timeout);
for (const model of models) {
  try {
    if (values.reply) {
      const rid2 = randomUUID();
      const ridSet = randomUUID();
      const sid2 = randomUUID();
      const ideBodyRaw = JSON.stringify(ideBody(model, rid2, ridSet, sid2));
      await probeReply(`ide/model-v1 reply (${model})`, IDE_URL, ideHeaders(auth, machineId, rid2, sid2), Buffer.from(ideBodyRaw), timeoutMs);
      continue;
    }
    await probeIde(auth, machineId, model);
  } catch (error) {
    console.log(`[model ${model}] ERROR ${error instanceof Error ? error.message : String(error)}`);
  }
}
