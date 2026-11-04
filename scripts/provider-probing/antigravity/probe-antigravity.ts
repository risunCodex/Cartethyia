/**
 * Live Antigravity wire probe (control-plane + chat + image).
 *
 * Reads exported accounts from a JSON file (same shape as the console
 * export), never prints tokens, and reports only status + first bytes of
 * each upstream response. The probe is deliberately raw: it does NOT use
 * the adapter, so the reference client's wire can be compared 1:1 with the
 * adapter's current shape.
 *
 *   bun run scripts/provider-probing/antigravity/probe-antigravity.ts \
 *     --creds "C:\...\antigravity-accounts-<ts>.json"
 *
 * Control-plane (default): loadCodeAssist → fetchAvailableModels →
 * retrieveUserQuotaSummary, using the reference UA + full clientMetadata.
 *
 *   # Adapter wire shape instead of reference.
 *   bun run ... --creds <file> --ua adapter
 *   # List models only, write full JSON.
 *   bun run ... --creds <file> --models --out models.json
 *   # Chat stream probe (default body: minimal agent envelope).
 *   bun run ... --creds <file> --chat gemini-2.5-flash --stream-head 5
 *   # Chat with the adapter's exact envelope (production payload).
 *   bun run ... --creds <file> --chat gemini-2.5-flash --mode adapter
 *   # Image generation probe.
 *   bun run ... --creds <file> --image "a cat drawing"
 *   # Try a specific base URL (reference list or custom).
 *   bun run ... --creds <file> --base-url https://cloudcode-pa.googleapis.com
 *
 * Flags:
 *   --creds <path>        required; account export file
 *   --label <name>        select account by label
 *   --index <n>           select account by zero-based index
 *   --base-url <url>      override base URL (default: reference prod)
 *   --ua ref|adapter      UA shape (default ref)
 *   --version <v>         reference ideVersion (default 2.6.0)
 *   --os <os>             reference os field (default windows)
 *   --arch <arch>         reference arch field (default amd64)
 *   --hub-version <v>     adapter hub version (default 2.8.0)
 *   --ua-os-type <s>      adapter os_type field (default darwin)
 *   --ua-arch <s>         adapter arch field (default arm64)
 *   --ua-cl <n>           adapter cl field (default 963137146)
 *   --metadata ref|adapter client-metadata shape for control-plane (default ref)
 *   --control             run control-plane probes (default when no other action)
 *   --models              fetchAvailableModels, print normalized summary
 *   --raw                 print full JSON bodies (capped, token-safe)
 *   --out <path>          write raw response JSON to a file
 *   --chat [model]        chat probe (default model gemini-2.5-flash)
 *   --mode legacy|current|minimal chat envelope shape (default minimal)
 *   --diff                run chat with all three envelope modes for comparison
 *   --stream-head <n>     SSE events to read for chat (default 3)
 *   --image <prompt>      image generation probe
 *   --size <w>x<h>       image size (default 1024x1024)
 *   --count <n>          image candidate count (default 1)
 *   --no-project          skip project resolution (control-plane calls)
 *   --timeout-ms <n>     per-request timeout (default 20000)
 */
import { parseArgs } from "node:util";
import { writeFileSync } from "node:fs";
import {
  readAccountsFile,
  pickAccount,
  requireAccountToken,
} from "../lib/accounts";
import { probePost, probePostText, formatProbe } from "../lib/http";
import {
  ANTIGRAVITY_REF_BASE_URLS,
  ANTIGRAVITY_ADAPTER_BASE_URLS,
  ANTIGRAVITY_PATH,
  referenceClientMetadata,
  adapterClientMetadata,
  referenceUserAgent,
  adapterUserAgent,
  controlPlaneHeaders,
  maskToken,
  tokenKey,
} from "./antigravity-shared";
import { buildEnvelope, type EnvelopeMode } from "./antigravity-wire-shapes";

interface CliArgs {
  creds?: string | undefined;
  label?: string | undefined;
  index?: number | undefined;
  baseUrl?: string | undefined;
  ua?: "ref" | "adapter";
  version?: string | undefined;
  os?: string | undefined;
  arch?: string | undefined;
  hubVersion?: string | undefined;
  uaOsType?: string | undefined;
  uaArch?: string | undefined;
  uaCl?: string | undefined;
  metadata?: "ref" | "adapter" | undefined;
  control?: boolean;
  models?: boolean;
  raw?: boolean;
  out?: string | undefined;
  chat?: string | undefined;
  mode?: EnvelopeMode;
  diff?: boolean;
  streamHead?: number;
  image?: string | undefined;
  size?: string | undefined;
  count?: number;
  noProject?: boolean;
  timeoutMs?: number | undefined;
  help?: boolean;
}

function parseCli(): CliArgs {
  const { values } = parseArgs({
    options: {
      creds: { type: "string" },
      label: { type: "string" },
      index: { type: "string" },
      "base-url": { type: "string" },
      ua: { type: "string" },
      version: { type: "string" },
      os: { type: "string" },
      arch: { type: "string" },
      "hub-version": { type: "string" },
      "ua-os-type": { type: "string" },
      "ua-arch": { type: "string" },
      "ua-cl": { type: "string" },
      metadata: { type: "string" },
      control: { type: "boolean", default: false },
      models: { type: "boolean", default: false },
      raw: { type: "boolean", default: false },
      out: { type: "string" },
      chat: { type: "string" },
      mode: { type: "string" },
      diff: { type: "boolean", default: false },
      "stream-head": { type: "string" },
      image: { type: "string" },
      size: { type: "string" },
      count: { type: "string" },
      "no-project": { type: "boolean", default: false },
      "timeout-ms": { type: "string" },
      help: { type: "boolean", default: false },
    },
  });
  return {
    creds: values.creds,
    label: values.label,
    index: values.index === undefined ? undefined : Number(values.index),
    baseUrl: values["base-url"],
    ua: values.ua === "adapter" ? "adapter" : "ref",
    version: values.version,
    os: values.os,
    arch: values.arch,
    hubVersion: values["hub-version"],
    uaOsType: values["ua-os-type"],
    uaArch: values["ua-arch"],
    uaCl: values["ua-cl"],
    metadata: values.metadata === "adapter" ? "adapter" : values.metadata === "ref" ? "ref" : undefined,
    control: values.control ?? false,
    models: values.models ?? false,
    raw: values.raw ?? false,
    out: values.out,
    chat: values.chat,
    mode: (values.mode === "legacy" || values.mode === "current" || values.mode === "minimal"
      ? values.mode
      : values.mode === "adapter"
        ? "current"
        : "minimal"),
    diff: values.diff ?? false,
    streamHead: values["stream-head"] === undefined ? 3 : Number(values["stream-head"]),
    image: values.image,
    size: values.size,
    count: values.count === undefined ? 1 : Number(values.count),
    noProject: values["no-project"] ?? false,
    timeoutMs: values["timeout-ms"] === undefined ? undefined : Number(values["timeout-ms"]),
    help: values.help ?? false,
  };
}

const HELP = `Antigravity wire probe

  bun run scripts/provider-probing/antigravity/probe-antigravity.ts --creds <file> [opts]

Actions (mutually exclusive-ish; default is --control):
  --control            control-plane: loadCodeAssist → fetchAvailableModels → quota summary
  --models             fetchAvailableModels only, print normalized model summary
  --chat [model]       chat stream probe (default model gemini-2.5-flash)
  --image <prompt>     image generation probe

Wire shape:
  --ua ref|adapter     User-Agent shape (default ref)
  --metadata ref|adapter  control-plane client-metadata shape (default ref)
  --mode legacy|current|minimal  chat envelope shape (default minimal)
  --diff               chat: run all three envelope modes for comparison
  --no-project         skip project resolution for control-plane calls

"legacy" = the adapter at baseline 0482e934 (old wire). "current" = the
adapter's production envelope. "minimal" = a small raw agent envelope.
See top-of-file comment for full flag list.`;

function summarizeModel(wireId: string, value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  const modelEnum = typeof v.model === "string" ? v.model : "";
  const name = typeof v.displayName === "string" ? v.displayName : "";
  const maxTokens = typeof v.maxTokens === "number" ? v.maxTokens : "?";
  const maxOut = typeof v.maxOutputTokens === "number" ? v.maxOutputTokens : "?";
  const internal = v.isInternal === true ? " [internal]" : "";
  return `${wireId} (${name}) model=${modelEnum} ctx=${maxTokens} out=${maxOut}${internal}`;
}

async function main(): Promise<void> {
  const args = parseCli();
  if (args.help || !args.creds) {
    console.log(HELP);
    process.exit(args.help ? 0 : 1);
  }
  const accounts = readAccountsFile(args.creds);
  const account = pickAccount(accounts, {
    providerId: "antigravity",
    ...(args.label === undefined ? {} : { label: args.label }),
    ...(args.index === undefined ? {} : { index: args.index }),
  });
  const token = requireAccountToken(account);
  console.log(`account=${account.label ?? account.id ?? "?"} token=${maskToken(token)} key=${tokenKey(token)}`);

  const ua =
    args.ua === "adapter"
      ? adapterUserAgent(args.hubVersion, args.uaOsType, args.uaArch, args.uaCl)
      : referenceUserAgent(args.version, args.os, args.arch);
  console.log(`user-agent (${args.ua}) = ${ua}`);

  // Base URL set to probe.
  const customBase = args.baseUrl;
  const bases = customBase
    ? [customBase.replace(/\/+$/, "")]
    : args.ua === "adapter"
      ? [...ANTIGRAVITY_ADAPTER_BASE_URLS]
      : [...ANTIGRAVITY_REF_BASE_URLS];
  console.log(`base-url candidates: ${bases.join(" | ")}`);

  const timeoutMs = args.timeoutMs ?? (args.chat !== undefined ? 90_000 : 20_000);

  // Project resolution (reference client resolves via loadCodeAssist / USS).
  let project: string | undefined;
  if (!args.noProject) {
    project = await resolveProject(token, ua, bases, args, timeoutMs);
    console.log(`project: ${project ?? "(none)"}`);
  }

  if (args.models) {
    await probeAvailableModels(token, ua, bases, project, args, timeoutMs);
    return;
  }
  if (args.chat !== undefined) {
    if (args.diff) {
      console.log("\n===== envelope diff: legacy vs current vs minimal =====");
      for (const mode of ["legacy", "current", "minimal"] as const) {
        await probeChat(token, ua, bases, project, { ...args, mode }, timeoutMs);
      }
    } else {
      await probeChat(token, ua, bases, project, args, timeoutMs);
    }
    return;
  }
  if (args.image !== undefined) {
    await probeImage(token, ua, bases, project, args, timeoutMs);
    return;
  }
  // default: control-plane
  await probeControl(token, ua, bases, project, args, timeoutMs);
}

function metadataFor(args: CliArgs): { ideName: string; ideType: string; ideVersion: string } | { ideType: string } {
  return args.metadata === "adapter" ? adapterClientMetadata : referenceClientMetadata(args.version);
}

async function resolveProject(
  token: string,
  ua: string,
  bases: readonly string[],
  args: CliArgs,
  timeoutMs: number,
): Promise<string | undefined> {
  const metadata = metadataFor(args);
  for (const base of bases) {
    try {
      const body = { metadata };
      const full = await probePostText(
        `${base}${ANTIGRAVITY_PATH.loadCodeAssist}`,
        controlPlaneHeaders(token, ua),
        JSON.stringify(body),
        { timeoutMs, bodyCap: 200_000 },
      );
      console.log(formatProbe("loadCodeAssist", full));
      if (!full.ok) continue;
      const parsed = parseMaybeJson(full.body);
      const projectId = extractProjectId(parsed);
      if (projectId) return projectId;
    } catch (error) {
      console.log(`loadCodeAssist ${base} error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return undefined;
}

function parseMaybeJson(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function extractProjectId(payload: Record<string, unknown> | null): string | undefined {
  if (!payload) return undefined;
  const raw = payload["cloudaicompanionProject"];
  if (typeof raw === "string" && raw.length > 0) return raw;
  if (typeof raw === "object" && raw !== null) {
    const id = (raw as Record<string, unknown>)["id"];
    if (typeof id === "string" && id.length > 0) return id;
  }
  return undefined;
}

async function probeControl(
  token: string,
  ua: string,
  bases: readonly string[],
  project: string | undefined,
  args: CliArgs,
  timeoutMs: number,
): Promise<void> {
  console.log("\n=== control-plane (loadCodeAssist) ===");
  for (const base of bases) {
    const headers = controlPlaneHeaders(token, ua);
    const body = JSON.stringify({ metadata: metadataFor(args) });
    const res = await probePostText(`${base}${ANTIGRAVITY_PATH.loadCodeAssist}`, headers, body, { timeoutMs, bodyCap: 200_000 });
    console.log(formatProbe(`loadCodeAssist ${base}`, res));
    if (args.raw && res.ok) console.log("  body:", res.body);
    if (res.ok) break;
  }

  console.log("\n=== control-plane (fetchAvailableModels) ===");
  for (const base of bases) {
    const headers = controlPlaneHeaders(token, ua);
    const body = JSON.stringify(project ? { project } : {});
    const res = await probePostText(`${base}${ANTIGRAVITY_PATH.fetchAvailableModels}`, headers, body, { timeoutMs, bodyCap: 200_000 });
    console.log(formatProbe(`fetchAvailableModels ${base}`, res));
    if (args.raw && res.ok) console.log("  body:", res.body);
    if (res.ok) break;
  }

  console.log("\n=== control-plane (retrieveUserQuotaSummary) ===");
  for (const base of bases) {
    const headers = controlPlaneHeaders(token, ua, {
      "x-client-name": "antigravity",
      "x-client-version": args.version ?? "2.6.0",
    });
    const body = JSON.stringify(project ? { project } : {});
    const res = await probePostText(`${base}${ANTIGRAVITY_PATH.retrieveUserQuotaSummary}`, headers, body, { timeoutMs, bodyCap: 200_000 });
    console.log(formatProbe(`retrieveUserQuotaSummary ${base}`, res));
    if (args.raw && res.ok) console.log("  body:", res.body);
    if (res.ok) break;
  }
}

async function probeAvailableModels(
  token: string,
  ua: string,
  bases: readonly string[],
  project: string | undefined,
  args: CliArgs,
  timeoutMs: number,
): Promise<void> {
  for (const base of bases) {
    const headers = controlPlaneHeaders(token, ua);
    const body = JSON.stringify(project ? { project } : {});
    const res = await probePostText(`${base}${ANTIGRAVITY_PATH.fetchAvailableModels}`, headers, body, { timeoutMs, bodyCap: 20_000_000 });
    console.log(formatProbe(`fetchAvailableModels ${base}`, res));
    if (!res.ok) continue;
    if (args.out) writeFileSync(args.out, res.body, "utf8");
    const parsed = parseMaybeJson(res.body);
    const models = parsed?.["models"];
    if (models && typeof models === "object") {
      console.log("--- models ---");
      for (const [id, raw] of Object.entries(models as Record<string, unknown>)) {
        const line = summarizeModel(id, raw) ?? id;
        console.log(`  ${line}`);
      }
    }
    break;
  }
}

/**
 * Posts a chat request and reads the first N SSE `data:` events, then cancels
 * the stream. Streaming responses never end, so reading to EOF would hang —
 * this mirrors how the adapter consumes the stream.
 */
async function probeChatStream(
  url: string,
  headers: Record<string, string>,
  body: string,
  maxEvents: number,
  timeoutMs: number,
): Promise<{ status: number; ok: boolean; contentType: string; events: string[] }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { method: "POST", headers, body, signal: controller.signal });
    const contentType = response.headers.get("content-type") ?? "";
    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => "");
      return {
        status: response.status,
        ok: response.ok,
        contentType,
        events: text ? [text.slice(0, 400)] : [],
      };
    }
    const events: string[] = [];
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0 && events.length < maxEvents) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (line.startsWith("data:")) {
            const data = line.slice(5).trim();
            if (data === "[DONE]") {
              events.push("[DONE]");
              buffer = "";
              break;
            }
            if (data.length > 0) events.push(data);
          }
        }
        if (events.length >= maxEvents || events.includes("[DONE]")) break;
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    return { status: response.status, ok: response.ok, contentType, events };
  } finally {
    clearTimeout(timer);
  }
}

async function probeChat(
  token: string,
  ua: string,
  bases: readonly string[],
  project: string | undefined,
  args: CliArgs,
  timeoutMs: number,
): Promise<void> {
  const model = args.chat ?? "gemini-2.5-flash";
  const message = "Reply with the single word: OK";
  const mode = args.mode ?? "minimal";
  console.log(`\n=== chat ${model} (envelope=${mode}) ==="`);

  const payload = buildEnvelope(mode, model, message, project);
  console.log(`  requestId=${payload.requestId} model=${payload.model} requestType=${payload.requestType}`);

  const maxEvents = Math.max(1, (args.streamHead ?? 3));
  for (const base of bases) {
    const headers = controlPlaneHeaders(token, ua, { accept: "text/event-stream" });
    const url = `${base}${ANTIGRAVITY_PATH.streamGenerateContent}`;
    const res = await probeChatStream(url, headers, JSON.stringify(payload), maxEvents, timeoutMs);
    console.log(`[streamGenerateContent ${base}] status=${res.status}${res.ok ? "" : " (not ok)"}`);
    console.log(`  content-type: ${res.contentType}`);
    if (!res.ok) {
      if (res.events.length > 0) console.log(`  body: ${JSON.stringify(res.events[0])}`);
      continue;
    }
    for (let i = 0; i < res.events.length; i++) {
      console.log(`  sse[${i}]: ${(res.events[i] ?? "").slice(0, 300)}`);
    }
    if (res.events.length === 0) console.log("  sse: (no data events yet)");
    break;
  }
}

async function probeImage(
  token: string,
  ua: string,
  bases: readonly string[],
  project: string | undefined,
  args: CliArgs,
  timeoutMs: number,
): Promise<void> {
  const prompt = args.image ?? "a cat";
  const [w, h] = (args.size ?? "1024x1024").split("x").map((s) => Number(s));
  const count = Math.max(1, args.count ?? 1);
  const model = "gemini-3.1-flash-image";
  const payload: Record<string, unknown> = {
    model,
    request: {
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      systemInstruction: { parts: [{ text: "You are an AI image generator." }] },
      generationConfig: {
        responseModalities: ["IMAGE"],
        candidateCount: count,
        imageConfig: { aspectRatio: `${w}:${h}` },
      },
      safetySettings: [],
    },
    requestType: "agent",
    requestId: `probe-image-${Date.now()}`,
    userAgent: "antigravity",
    ...(project ? { project } : {}),
  };
  console.log(`\n=== image ${model} (${w}x${h}, n=${count}) ===`);
  for (const base of bases) {
    const headers = controlPlaneHeaders(token, ua, { accept: "text/event-stream" });
    const url = `${base}${ANTIGRAVITY_PATH.streamGenerateContent}`;
    const res = await probePost(url, headers, JSON.stringify(payload), { timeoutMs });
    console.log(formatProbe(`image ${base}`, res));
    if (res.ok) break;
  }
}

await main();
