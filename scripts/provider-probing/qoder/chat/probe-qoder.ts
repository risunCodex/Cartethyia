/**
 * Live Qoder chat wire probe — the single canonical probe for the Qoder chat
 * surface: legacy COSY signed `/algo` (`agent_chat_generation`).
 *
 * The modern IDE `/model/v1` and gRPC `ChatService` surfaces are dead upstream
 * (404 / UNIMPLEMENTED since 2026-11-07) and are not probed anymore.
 *
 * This probe verifies the gateway's outbound fingerprint work end-to-end:
 * every request is dialed through the validated egress with a TLS ClientHello
 * profile (`--profile qoder-app`, default), so the wire identity matches the
 * Qoder desktop app's captured ClientHello. When the fingerprint is right the
 * upstream answers right away — `ttfb_ms` is the measured time from dial to
 * response headers.
 *
 * Usage:
 *   bun run scripts/provider-probing/qoder/chat/probe-qoder.ts \
 *     --creds <accounts.json> [flags]
 *
 * Flags:
 *   --creds <path>        required; exported-account JSON file
 *   --model <id>          model id (default "auto")
 *   --all                 probe every model in the intl roster (config keys)
 *   --models              list models from the roster endpoint (signed GET)
 *   --prompt <text>       the prompt sent to every model (default: a short
 *                         Indonesian self-introduction)
 *   --cli                 present the CLI identity (clienttype 5, cli/assistant,
 *                         Bun UA, plain scrambled body) instead of the desktop
 *                         app identity (default: app — clienttype 10, app,
 *                         undici UA, zstd body)
 *   --profile <id>        TLS ClientHello profile id (default "qoder-app";
 *                         "default" uses the runtime TLS stack)
 *   --host <host>         upstream host for COSY chat (default "api2";
 *                         "api1"|"api2"|"api3" or a full https URL)
 *   --reply               print the streamed answer text
 *   --model-echo          print every `model` field seen in the stream
 *   --lite                free-tier lite config (1M input, 64k output)
 *   --chars <n>           with --lite: payload size in chars (default 4200000)
 *   --timeout-ms <n>      request timeout ms (default 60000)
 *   --label <name>        select account by label
 *   --index <n>           select account by zero-based index
 *
 * Examples:
 *   # All models, one prompt each, qoder-app TLS profile (default), head probe
 *   bun run scripts/provider-probing/qoder/chat/probe-qoder.ts \
 *     --creds a.json --all
 *
 *   # Stream full replies on every roster model, CLI identity
 *   bun run scripts/provider-probing/qoder/chat/probe-qoder.ts \
 *     --creds a.json --all --reply --cli
 */
import { parseArgs } from "node:util";
import { writeFileSync } from "node:fs";
import { maskSecret, maskUuid } from "../../lib/accounts";
import { formatProbe, probeGet } from "../../lib/http";
import {
  QODER_VERSION,
  QODER_LEGACY_CHAT_URL,
  QODER_MODEL_LIST_URL,
  buildCosyHeaders,
  loadProbeAccount,
  summarizeRedacted,
  transformQoderBody,
  type QoderProbeAuth,
} from "../lib/shared";
import { createValidatedFetch } from "../../../../src/network/egress/fetch";
import { decodeQoderSseEvents, qoderEnvelopeToFrames } from "../../../../src/providers/integrations/qoder/qoder-sse";
import { isQoderPat, resolveQoderAuth } from "../../../../src/providers/integrations/qoder/qoder-auth";
import { buildQoderRequest, callQoder } from "../../../../src/providers/integrations/qoder/qoder-chat";
import { QODER_INTL_MODEL_CONFIGS } from "../../../../src/providers/integrations/qoder/qoder-catalog";

const DEFAULT_PROMPT = "Halo, perkenalkan dirimu singkat.";

/** Resolves the COSY chat URL for a `--host` value (alias or full URL). */
function chatUrl(host: string): string {
  const path = "/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1";
  if (host.startsWith("http://") || host.startsWith("https://")) return `${host.replace(/\/+$/, "")}${path}`;
  if (host === "api1" || host === "api2" || host === "api3") return `https://${host}.qoder.sh${path}`;
  throw new Error(`--host must be api1|api2|api3 or a full https URL (got "${host}")`);
}

interface LiteModelConfig {
  readonly id: string;
  readonly display_name: string;
  readonly max_input_tokens: number;
  readonly max_output_tokens?: number;
  readonly is_vl: boolean;
  readonly is_reasoning: boolean;
}

/** Roster config for one model key, with a safe fallback for unknown keys. */
function modelConfigFor(model: string): LiteModelConfig {
  const cfg = QODER_INTL_MODEL_CONFIGS[model];
  if (cfg) return cfg;
  return {
    id: model,
    display_name: model,
    max_input_tokens: 180_000,
    is_vl: true,
    is_reasoning: false,
  };
}

/** A canonical request shaped the way the gateway's `buildQoderRequest` wants it. */
function canonicalRequestFor(model: string, text: string): Record<string, unknown> {
  return {
    model,
    messages: [{ role: "user", content: [{ kind: "text", text }] }],
    generation_controls: {},
    stream: true,
    source_surface: "chat",
  };
}

/**
 * Lists models from the shared gateway surface (`/algo/api/v2/model/list`).
 *
 * The request is a GET that carries the signed `{}` body — the COSY signature
 * covers the body, so a bare or plain-bearer GET fails with `101 Signature
 * invalid`.
 */
async function listModels(
  auth: QoderProbeAuth,
  opts: { readonly json?: boolean; readonly out?: string } = {},
): Promise<void> {
  const rawBody = "{}";
  const encoded = transformQoderBody(rawBody);
  const headers = {
    ...buildCosyHeaders(QODER_MODEL_LIST_URL, rawBody, auth, QODER_VERSION, undefined, { key: "auto", source: "system" }),
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

interface StreamProbeOptions {
  readonly label: string;
  readonly url: string;
  readonly modelKey: string;
  readonly request: Record<string, unknown>;
  readonly auth: QoderProbeAuth;
  readonly realm: "intl" | "cn";
  readonly profile: "app" | "cli";
  readonly timeoutMs: number;
  readonly showText: boolean;
  readonly showModels: boolean;
}

/**
 * Streams one SSE reply through the gateway's own `callQoder` transport, so
 * the probe sends exactly the adapter's wire (clienttype/business/scene, zstd
 * body, signature over the scrambled transform). Reports time-to-first-byte
 * (`ttfb_ms`) — the fingerprint check: a matching ClientHello gets headers
 * back immediately.
 */
async function streamProbe(opts: StreamProbeOptions): Promise<void> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs);
  const fetchFn = createValidatedFetch({ tlsProfile: currentProfile });
  const modelConfig = modelConfigFor(opts.modelKey);
  const startedAt = performance.now();
  try {
    const body = buildQoderRequest(opts.modelKey, opts.request as never, modelConfig, opts.auth, opts.realm);
    const response = await callQoder(opts.url, body, opts.modelKey, opts.auth, ac.signal, fetchFn as never, undefined, opts.profile);
    const ttfbMs = Math.round(performance.now() - startedAt);
    console.log(`[${opts.label}] status=${response.status} ttfb_ms=${ttfbMs}`);
    if (!response.body) {
      console.log("  (empty body)");
      return;
    }
    const textParts: string[] = [];
    const reasoningParts: string[] = [];
    const models = new Set<string>();
    let frames = 0;
    let terminal = false;
    for await (const sse of decodeQoderSseEvents(response.body, ac.signal)) {
      let framesArray: Array<{ event: string | null; data: string }>;
      try {
        framesArray = qoderEnvelopeToFrames(sse.data);
      } catch (error) {
        console.log(`  error: ${summarizeRedacted(error)}`);
        terminal = true;
        break;
      }
      for (const frame of framesArray) {
        const payload = frame.data.trim();
        if (payload.length === 0) continue;
        if (payload === "[DONE]") {
          terminal = true;
          continue;
        }
        frames += 1;
        let json: Record<string, unknown>;
        try {
          json = JSON.parse(payload) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (typeof json["model"] === "string") models.add(json["model"] as string);
        const bodyRec = json["body"];
        const inner =
          typeof bodyRec === "string"
            ? (JSON.parse(bodyRec) as Record<string, unknown>)
            : bodyRec && typeof bodyRec === "object"
              ? (bodyRec as Record<string, unknown>)
              : json;
        const choices = (inner?.["choices"] as Array<Record<string, unknown>> | undefined) ?? [];
        for (const choice of choices) {
          const delta = choice?.["delta"] as Record<string, unknown> | undefined;
          if (!delta) continue;
          if (typeof delta["content"] === "string") textParts.push(delta["content"] as string);
          if (typeof delta["reasoning_content"] === "string") reasoningParts.push(delta["reasoning_content"] as string);
        }
        const fr = inner?.["finish_reason"];
        if (fr !== undefined && fr !== null && fr !== "") terminal = true;
      }
      if (terminal) break;
    }
    if (opts.showText) {
      const reasoning = reasoningParts.join("");
      const text = textParts.join("");
      if (reasoning.length > 0) console.log(`  reasoning: ${reasoning.slice(0, 800)}`);
      console.log(`  text: ${text.slice(0, 1500) || "(no text content yet)"}`);
    }
    console.log(`  frames: ${frames} terminal=${terminal}`);
    if (opts.showModels) {
      console.log(`  model fields seen: ${models.size > 0 ? [...models].join(", ") : "(none)"}`);
    }
  } catch (error) {
    console.log(`  ERROR ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timer);
  }
}

/** Probes the legacy `/algo` surface (signed COSY) via the gateway's transport. */
async function probeLegacy(
  model: string,
  auth: QoderProbeAuth,
  opts: {
    readonly reply: boolean;
    readonly echo: boolean;
    readonly prompt: string;
    readonly host: string;
    readonly timeoutMs: number;
    readonly cli: boolean;
  },
): Promise<void> {
  const url = chatUrl(opts.host);
  const label = `legacy/cosy (${model} @ ${opts.host})`;
  await streamProbe({
    label,
    url,
    modelKey: model,
    request: canonicalRequestFor(model, opts.prompt),
    auth,
    realm: "intl",
    profile: opts.cli ? "cli" : "app",
    timeoutMs: opts.timeoutMs,
    showText: opts.reply,
    showModels: opts.echo,
  });
}

/** Free-tier lite probe: big payload size acceptance, via the gateway's transport. */
async function probeLite(
  auth: QoderProbeAuth,
  opts: { readonly model: string; readonly chars: number; readonly timeoutMs: number; readonly cli: boolean },
): Promise<void> {
  const payload = "x".repeat(opts.chars);
  const modelKey = opts.model;
  const cfg: LiteModelConfig = {
    id: modelKey,
    display_name: "Lite-Qwen-3.7-Plus",
    max_input_tokens: 1_000_000,
    max_output_tokens: 65536,
    is_vl: true,
    is_reasoning: false,
  };
  console.log("=== Qoder LITE legacy COSY probe ===");
  console.log(`model=${modelKey} chars=${opts.chars.toLocaleString()}`);
  const start = Date.now();
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), opts.timeoutMs);
    const fetchFn = createValidatedFetch({ tlsProfile: currentProfile });
    const request = canonicalRequestFor(modelKey, payload);
    const body = buildQoderRequest(modelKey, request as never, cfg, auth, "intl");
    const res = await callQoder(QODER_LEGACY_CHAT_URL, body, modelKey, auth, ac.signal, fetchFn as never, undefined, opts.cli ? "cli" : "app");
    clearTimeout(timer);
    console.log(`status=${res.status} elapsed=${Math.round((Date.now() - start) / 1000)}s`);
    const text = await res.text().catch(() => "");
    if (res.ok) {
      console.log(`=> ACCEPTED ${opts.chars.toLocaleString()} chars (${Math.round((opts.chars / 4) / 1000)}k tokens approx)`);
    } else {
      console.log(`=> REJECTED (status ${res.status}) head=${text.slice(0, 160)}`);
    }
  } catch (error) {
    console.log(`ERROR ${error instanceof Error ? error.message : String(error)}`);
  }
}

const { values } = parseArgs({
  options: {
    creds: { type: "string" },
    model: { type: "string", default: "auto" },
    all: { type: "boolean", default: false },
    models: { type: "boolean", default: false },
    prompt: { type: "string", default: DEFAULT_PROMPT },
    profile: { type: "string", default: "qoder-app" },
    host: { type: "string", default: "api2" },
    cli: { type: "boolean", default: false },
    reply: { type: "boolean", default: false },
    "model-echo": { type: "boolean", default: false },
    lite: { type: "boolean", default: false },
    chars: { type: "string", default: "4200000" },
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
const chars = Number(values.chars);
if (!Number.isFinite(chars) || chars < 0) {
  throw new Error(`--chars must be a non-negative number (got ${values.chars})`);
}
const currentProfile = values.profile;

const loaded = loadProbeAccount({
  providerId: "qoder",
  ...(values.creds !== undefined ? { creds: values.creds } : {}),
  ...(values.label !== undefined ? { label: values.label } : {}),
  ...(values.index !== undefined ? { index: values.index } : {}),
});
const account = loaded.account;

console.log(
  `account=${account.label ?? "?"} (${account.providerId ?? "?"}/${account.credentialKind ?? "?"}) ` +
    `token=${maskSecret(loaded.token)} machineId=${maskUuid(loaded.machineId)} profile=${currentProfile}`,
);

// PAT accounts must be exchanged for a job token before COSY signing — the
// same exchange the gateway performs (`resolveQoderAuth`).
let auth = loaded.auth;
if (isQoderPat(loaded.token)) {
  const resolved = await resolveQoderAuth({
    secret: loaded.token,
    authState: { userId: loaded.userId, machineId: loaded.machineId, realm: "intl" },
    signal: AbortSignal.timeout(15_000),
    fetcher: fetch,
    realm: "intl",
  });
  auth = { ...loaded.auth, securityOauthToken: resolved.securityOauthToken };
}

if (values.models) {
  try {
    await listModels(auth, {
      json: values.json,
      ...(values.out !== undefined ? { out: values.out } : {}),
    });
  } catch (error) {
    console.log(`[models] ERROR ${error instanceof Error ? error.message : String(error)}`);
  }
  process.exit(0);
}

if (values.lite) {
  await probeLite(auth, { model: values.model, chars, timeoutMs, cli: values.cli });
  process.exit(0);
}

const models = values.all ? Object.keys(QODER_INTL_MODEL_CONFIGS) : [values.model];

for (const model of models) {
  try {
    await probeLegacy(model, auth, {
      reply: values.reply,
      echo: values["model-echo"],
      prompt: values.prompt,
      host: values.host,
      timeoutMs,
      cli: values.cli,
    });
  } catch (error) {
    console.log(`[model ${model}] ERROR ${error instanceof Error ? error.message : String(error)}`);
  }
}
