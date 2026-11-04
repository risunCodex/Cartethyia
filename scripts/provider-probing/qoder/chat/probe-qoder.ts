/**
 * Live Qoder chat wire probe — the single canonical probe for the Qoder chat
 * surfaces: legacy COSY signed `/algo` (agent_chat_generation), modern IDE
 * `/model/v1`, and a plain-bearer legacy variant for comparison.
 *
 * This file supersedes the six scripts merged into it: qoder-transport-probe,
 * qoder-response-shape, qoder-cross-model, qoder-business-probe,
 * qoder-legacy-reply, and qoder-lite-cosy-1m. It never prints tokens, never
 * writes credentials, and shows status + first bytes unless `--reply` /
 * `--model-echo` ask for a streamed read. The gRPC surface is NOT part of this
 * probe (it lives in grpc/).
 *
 * Usage:
 *   bun run scripts/provider-probing/qoder/chat/probe-qoder.ts \
 *     --creds <accounts.json> [flags]
 *
 * Flags:
 *   --creds <path>        required; exported-account JSON file
 *   --model <id>          model id (default "auto")
 *   --all                 probe every model in the default roster list
 *   --models              list models from the roster endpoint (signed GET)
 *   --ide-only            skip the legacy surface; only the IDE surface
 *   --surface <s>         ide|legacy|both|plain-bearer (default "both")
 *   --reply               stream the full SSE reply instead of just the head
 *   --model-echo          collect + print the `model` fields seen per surface
 *   --cross               probe several models on the IDE surface (comma list
 *                         via --model; default "qfmodel,qmodel,dmodel")
 *   --headers <h>         IDE header variant: minimal|machine (default machine)
 *   --lite                legacy COSY lite config (free tier, 1M input)
 *   --chars <n>           with --lite: payload size in chars (default 4200000)
 *   --sizes <csv>         accepted for compatibility with the capacity probe
 *                         (unused here)
 *   --ctx <n>             max_input_tokens for the IDE body (unset by default)
 *   --timeout-ms <n>      request timeout ms (default 60000)
 *   --json                with --models: print the full model array as JSON
 *   --out <path>          with --models: write the JSON array to a file
 *   --label <name>        select account by label
 *   --index <n>           select account by zero-based index
 *
 * Examples:
 *   # Head probe on both surfaces (default), auto model
 *   bun run scripts/provider-probing/qoder/chat/probe-qoder.ts --creds a.json
 *
 *   # Stream full replies on both surfaces for qfmodel
 *   bun run scripts/provider-probing/qoder/chat/probe-qoder.ts \
 *     --creds a.json --model qfmodel --reply
 *
 *   # Model fields seen per surface (response-shape behavior)
 *   bun run scripts/provider-probing/qoder/chat/probe-qoder.ts \
 *     --creds a.json --model-echo --surface both
 *
 *   # Legacy only: signed vs plain-bearer comparison (transport-probe behavior)
 *   bun run scripts/provider-probing/qoder/chat/probe-qoder.ts \
 *     --creds a.json --surface legacy
 *   bun run scripts/provider-probing/qoder/chat/probe-qoder.ts \
 *     --creds a.json --surface plain-bearer
 *
 *   # Free-tier lite via legacy COSY at a big payload (lite-1m behavior)
 *   bun run scripts/provider-probing/qoder/chat/probe-qoder.ts \
 *     --creds a.json --lite --chars 4200000
 *
 *   # Cross-model IDE probe (per-account vs per-model check)
 *   bun run scripts/provider-probing/qoder/chat/probe-qoder.ts \
 *     --creds a.json --cross --model qfmodel,qmodel,dmodel
 *
 *   # Roster listing, pretty JSON to stdout or a file
 *   bun run scripts/provider-probing/qoder/chat/probe-qoder.ts \
 *     --creds a.json --models --json
 *   bun run scripts/provider-probing/qoder/chat/probe-qoder.ts \
 *     --creds a.json --models --out roster.json
 */
import { parseArgs } from "node:util";
import { writeFileSync } from "node:fs";
import { maskSecret, maskUuid } from "../../lib/accounts";
import { formatProbe, probeGet, probePost, probePostText } from "../../lib/http";
import { buildCosyHeaders, transformQoderBody } from "../cosy-signer";
import {
  QODER_VERSION,
  QODER_IDE_CHAT_URL,
  QODER_LEGACY_CHAT_URL,
  QODER_MODEL_LIST_URL,
  buildIdeChatBody,
  buildLegacyChatBody,
  ideChatHeaders,
  loadProbeAccount,
  readSse,
  summarizeRedacted,
  type LoadedProbeAccount,
  type SseHandlers,
} from "../lib/shared";
import type { QoderProbeAuth } from "../cosy-signer";

type Surface = "ide" | "legacy" | "plain-bearer";
type HeadersVariant = "minimal" | "machine";

const DEFAULT_MODELS = ["auto", "qmodel", "dmodel", "qwen3.8-max"] as const;
const CROSS_DEFAULT_MODELS = "qfmodel,qmodel,dmodel";

/**
 * Lists models from the shared gateway surface (`/algo/api/v2/model/list`).
 *
 * The request is a GET that carries the signed `{}` body — the COSY signature
 * covers the body, so a bare or plain-bearer GET fails with `101 Signature
 * invalid`. The same signed probe serves both the plugin and the IDE worker.
 */
async function listModels(
  auth: QoderProbeAuth,
  opts: { readonly json?: boolean; readonly out?: string } = {},
): Promise<void> {
  const rawBody = "{}";
  const encoded = transformQoderBody(rawBody);
  const headers = {
    ...buildCosyHeaders(QODER_MODEL_LIST_URL, rawBody, auth, QODER_VERSION),
    "x-model-key": "auto",
    "x-model-source": "system",
  };
  const res = await probeGet(QODER_MODEL_LIST_URL, headers, { body: encoded, bodyCap: 100_000 });
  console.log(formatProbe("model/list (signed)", res));
  try {
    const parsed = JSON.parse(res.body) as { chat?: Array<Record<string, unknown>>; error?: unknown };
    const chat = parsed.chat;
    if (opts.json && Array.isArray(chat)) {
      const pretty = JSON.stringify(chat, null, 2);
      if (opts.out !== undefined) {
        writeFileSync(opts.out, `${pretty}\n`, "utf8");
        console.log(`  wrote ${opts.out} (${chat.length} models)`);
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

interface LegacyRequest {
  readonly body: Record<string, unknown>;
  readonly rid: string;
  readonly raw: string;
  readonly encoded: ArrayBuffer;
}

/**
 * Copies an encoded Buffer into a fresh, sized ArrayBuffer. Bun's Buffer type
 * is generic over ArrayBufferLike, which is not assignable to the DOM BodyInit
 * union; a real ArrayBuffer is. One copy per request is negligible for probe
 * payloads (largest: the lite 4.2M-char body).
 */
function toArrayBuffer(view: Buffer): ArrayBuffer {
  const copy = new ArrayBuffer(view.byteLength);
  new Uint8Array(copy).set(view);
  return copy;
}

/** Builds a legacy `agent_chat_generation` request (signed or plain bearer). */
function buildLegacyRequest(model: string, userId: string, text: string, lite: boolean): LegacyRequest {
  const built = lite
    ? buildLegacyChatBody({
        model,
        userId,
        text,
        isReasoning: false,
        displayName: "Lite-Qwen-3.7-Plus",
        maxInputTokens: 1_000_000,
        maxOutputTokens: 65536,
      })
    : buildLegacyChatBody({ model, userId, text });
  const raw = JSON.stringify(built.body);
  const encoded = toArrayBuffer(transformQoderBody(raw));
  return { body: built.body, rid: built.rid, raw, encoded };
}

interface InnerChatFrame {
  readonly model?: string;
  readonly choices?: Array<{ readonly delta?: { readonly content?: string; readonly reasoning_content?: string } }>;
}

/**
 * Unwraps the legacy SSE envelope `{ headers?, body: "<json>" }` and absorbs
 * the nested `model` / `choices[].delta` fields. Frames that are already
 * OpenAI-shaped are handled by `readSse` itself (`onModel`/`onDelta`).
 */
function absorbLegacyFrame(
  frame: Record<string, unknown>,
  textParts: string[],
  reasoningParts: string[],
  models: Set<string>,
): void {
  const bodyStr = frame.body;
  if (typeof bodyStr !== "string") return;
  let inner: InnerChatFrame | null = null;
  try {
    inner = JSON.parse(bodyStr) as InnerChatFrame | null;
  } catch {
    return;
  }
  if (inner === null) return;
  if (typeof inner.model === "string") models.add(inner.model);
  const delta = inner.choices?.[0]?.delta;
  if (delta === undefined) return;
  if (typeof delta.content === "string") textParts.push(delta.content);
  if (typeof delta.reasoning_content === "string") reasoningParts.push(delta.reasoning_content);
}

interface StreamProbeOptions {
  readonly label: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: BodyInit;
  readonly timeoutMs: number;
  readonly showText: boolean;
  readonly showModels: boolean;
}

/** Streams one SSE reply via the shared `readSse` reader. */
async function streamProbe(opts: StreamProbeOptions): Promise<void> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs);
  try {
    const response = await fetch(opts.url, {
      method: "POST",
      headers: opts.headers,
      body: opts.body,
      signal: ac.signal,
    });
    console.log(`[${opts.label}] status=${response.status}`);
    if (!response.body) {
      console.log("  (empty body)");
      return;
    }
    const textParts: string[] = [];
    const reasoningParts: string[] = [];
    const models = new Set<string>();
    const handlers: SseHandlers = {
      onDelta: (part) => textParts.push(part),
      onReasoning: (part) => reasoningParts.push(part),
      onModel: (model) => models.add(model),
      onFrame: (frame) => absorbLegacyFrame(frame, textParts, reasoningParts, models),
      onError: (error) => console.log(`  error: ${summarizeRedacted(error)}`),
    };
    const { frames, stopped } = await readSse(response, handlers);
    if (opts.showText) {
      const reasoning = reasoningParts.join("");
      const text = textParts.join("");
      if (reasoning.length > 0) console.log(`  reasoning: ${reasoning.slice(0, 800)}`);
      console.log(`  text: ${text.slice(0, 1500) || "(no text content yet)"}`);
    }
    console.log(`  frames: ${frames} stopped=${stopped}`);
    if (opts.showModels) {
      console.log(`  model fields seen: ${models.size > 0 ? [...models].join(", ") : "(none)"}`);
    }
  } catch (error) {
    console.log(`  ERROR ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timer);
  }
}

/** Probes the modern IDE `/model/v1` surface. */
async function probeIde(
  model: string,
  loaded: LoadedProbeAccount,
  opts: {
    readonly reply: boolean;
    readonly echo: boolean;
    readonly headers: HeadersVariant;
    readonly ctx?: number;
    readonly timeoutMs: number;
  },
): Promise<void> {
  const { body, rid, sid } = buildIdeChatBody({
    model,
    version: QODER_VERSION,
    ...(opts.ctx !== undefined ? { contextTokens: opts.ctx } : {}),
  });
  const headers = ideChatHeaders({
    token: loaded.token,
    requestId: rid,
    sessionId: sid,
    ...(opts.headers === "machine" ? { machineId: loaded.machineId } : {}),
  });
  const label = `ide/model-v1 (${model})`;
  if (opts.reply || opts.echo) {
    await streamProbe({
      label,
      url: QODER_IDE_CHAT_URL,
      headers,
      body: JSON.stringify(body),
      timeoutMs: opts.timeoutMs,
      showText: opts.reply,
      showModels: opts.echo,
    });
    return;
  }
  const res = await probePost(QODER_IDE_CHAT_URL, headers, JSON.stringify(body), { timeoutMs: opts.timeoutMs });
  console.log(formatProbe(label, res));
}

/** Probes the legacy `/algo` surface (signed COSY or plain bearer). */
async function probeLegacy(
  model: string,
  loaded: LoadedProbeAccount,
  opts: {
    readonly reply: boolean;
    readonly echo: boolean;
    readonly surface: "legacy" | "plain-bearer";
    readonly timeoutMs: number;
  },
): Promise<void> {
  const req = buildLegacyRequest(model, loaded.userId, "ping", false);
  const label =
    opts.surface === "plain-bearer"
      ? `legacy/plain-bearer (${model})`
      : `legacy/cosy (${model})`;
  const headers =
    opts.surface === "plain-bearer"
      ? ideChatHeaders({ token: loaded.token, requestId: req.rid, sessionId: req.rid })
      : buildCosyHeaders(QODER_LEGACY_CHAT_URL, req.raw, loaded.auth, QODER_VERSION);
  if (opts.reply || opts.echo) {
    await streamProbe({
      label,
      url: QODER_LEGACY_CHAT_URL,
      headers,
      body: req.encoded,
      timeoutMs: opts.timeoutMs,
      showText: opts.reply,
      showModels: opts.echo,
    });
    return;
  }
  const res = await probePost(QODER_LEGACY_CHAT_URL, headers, req.encoded, { timeoutMs: opts.timeoutMs });
  console.log(formatProbe(label, res));
}

/** Cross-model probe: several models on the IDE surface (plain bearer). */
async function probeCross(
  models: readonly string[],
  loaded: LoadedProbeAccount,
  opts: { readonly timeoutMs: number },
): Promise<void> {
  for (const model of models) {
    const { body, rid, sid } = buildIdeChatBody({ model, version: QODER_VERSION });
    const headers = ideChatHeaders({ token: loaded.token, requestId: rid, sessionId: sid });
    try {
      const res = await probePostText(QODER_IDE_CHAT_URL, headers, JSON.stringify(body), {
        timeoutMs: opts.timeoutMs,
        bodyCap: 300,
      });
      console.log(`\n=== ${model} ===`);
      console.log(`status=${res.status}`);
      console.log(`body: ${res.body}`);
    } catch (error) {
      console.log(`\n=== ${model} === ERROR: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/** Free-tier lite probe: legacy COSY signed, big payload size acceptance. */
async function probeLite(
  loaded: LoadedProbeAccount,
  opts: { readonly model: string; readonly chars: number; readonly timeoutMs: number },
): Promise<void> {
  const payload = "x".repeat(opts.chars);
  const req = buildLegacyRequest(opts.model, loaded.userId, payload, true);
  const headers = buildCosyHeaders(QODER_LEGACY_CHAT_URL, req.raw, loaded.auth, QODER_VERSION);
  console.log("=== Qoder LITE legacy COSY probe ===");
  console.log(`model=${opts.model} chars=${opts.chars.toLocaleString()}`);
  console.log(`rawBytes=${req.raw.length.toLocaleString()} encodedBytes=${req.encoded.byteLength.toLocaleString()}`);
  const start = Date.now();
  try {
    const res = await probePost(QODER_LEGACY_CHAT_URL, headers, req.encoded, { timeoutMs: opts.timeoutMs });
    console.log(formatProbe("legacy/lite-cosy (signed)", res));
    console.log(`elapsed=${Math.round((Date.now() - start) / 1000)}s`);
    if (res.ok) {
      console.log(`=> ACCEPTED ${opts.chars.toLocaleString()} chars (${Math.round((opts.chars / 4) / 1000)}k tokens approx)`);
    } else {
      console.log("=> REJECTED (see head)");
    }
  } catch (error) {
    console.log(`ERROR ${error instanceof Error ? error.message : String(error)}`);
  }
}

function selectedSurfaces(value: string, ideOnly: boolean): Surface[] {
  if (ideOnly) return ["ide"];
  switch (value) {
    case "ide":
      return ["ide"];
    case "legacy":
      return ["legacy"];
    case "plain-bearer":
      return ["plain-bearer"];
    case "both":
      return ["legacy", "ide"];
    default:
      throw new Error(`--surface must be one of ide|legacy|both|plain-bearer (got ${value})`);
  }
}

const { values } = parseArgs({
  options: {
    creds: { type: "string" },
    model: { type: "string", default: "auto" },
    all: { type: "boolean", default: false },
    models: { type: "boolean", default: false },
    "ide-only": { type: "boolean", default: false },
    surface: { type: "string", default: "both" },
    reply: { type: "boolean", default: false },
    "model-echo": { type: "boolean", default: false },
    cross: { type: "boolean", default: false },
    headers: { type: "string", default: "machine" },
    lite: { type: "boolean", default: false },
    chars: { type: "string", default: "4200000" },
    sizes: { type: "string" },
    ctx: { type: "string" },
    "timeout-ms": { type: "string", default: "60000" },
    json: { type: "boolean", default: false },
    out: { type: "string" },
    label: { type: "string" },
    index: { type: "string" },
  },
});

const timeoutMs = Number(values["timeout-ms"]);
if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
  throw new Error(`--timeout-ms must be a positive number (got ${values["timeout-ms"]})`);
}

if (values.headers !== "minimal" && values.headers !== "machine") {
  throw new Error(`--headers must be "minimal" or "machine" (got ${values.headers})`);
}
const headersMode: HeadersVariant = values.headers === "minimal" ? "minimal" : "machine";

let ctx: number | undefined;
if (values.ctx !== undefined) {
  const n = Number(values.ctx);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`--ctx must be a positive number (got ${values.ctx})`);
  ctx = n;
}

const chars = Number(values.chars);
if (!Number.isFinite(chars) || chars < 0) {
  throw new Error(`--chars must be a non-negative number (got ${values.chars})`);
}

const loaded = loadProbeAccount({
  providerId: "qoder",
  ...(values.creds !== undefined ? { creds: values.creds } : {}),
  ...(values.label !== undefined ? { label: values.label } : {}),
  ...(values.index !== undefined ? { index: values.index } : {}),
});
const account = loaded.account;

console.log(
  `account=${account.label ?? "?"} (${account.providerId ?? "?"}/${account.credentialKind ?? "?"}) ` +
    `token=${maskSecret(loaded.token)} machineId=${maskUuid(loaded.machineId)}`,
);

if (values.models) {
  try {
    await listModels(loaded.auth, {
      json: values.json,
      ...(values.out !== undefined ? { out: values.out } : {}),
    });
  } catch (error) {
    console.log(`[models] ERROR ${error instanceof Error ? error.message : String(error)}`);
  }
  process.exit(0);
}

if (values.lite) {
  await probeLite(loaded, { model: values.model, chars, timeoutMs });
  process.exit(0);
}

if (values.cross) {
  const modelProvided = process.argv.some((arg) => arg === "--model" || arg.startsWith("--model="));
  const models = (modelProvided ? values.model : CROSS_DEFAULT_MODELS)
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  await probeCross(models, loaded, { timeoutMs });
  process.exit(0);
}

const surfaces = selectedSurfaces(values.surface, values["ide-only"]);
const models = values.all ? [...DEFAULT_MODELS] : [values.model];

for (const model of models) {
  for (const surface of surfaces) {
    try {
      if (surface === "ide") {
        await probeIde(model, loaded, {
          reply: values.reply,
          echo: values["model-echo"],
          headers: headersMode,
          ...(ctx !== undefined ? { ctx } : {}),
          timeoutMs,
        });
      } else {
        await probeLegacy(model, loaded, {
          reply: values.reply,
          echo: values["model-echo"],
          surface,
          timeoutMs,
        });
      }
    } catch (error) {
      console.log(`[model ${model}/${surface}] ERROR ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
