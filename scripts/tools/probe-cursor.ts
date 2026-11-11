/**
 * Live Cursor Run probe: builds the real canonical request and runs the real
 * adapter against one account, so the answer is the model's own output rather
 * than a hand-rolled `fetch` that could pass while dispatch fails.
 *
 *   bun run scripts/tools/probe-cursor.ts \
 *     --creds C:\Users\Aria\Desktop\cursor-accounts-<ts>.json \
 *     --model auto \
 *     --prompt "Reply with the single word: pong"
 *
 *   # List the account's own roster first, then hit every model in the catalog.
 *   bun run scripts/tools/probe-cursor.ts --creds <file> --list-models
 *   bun run scripts/tools/probe-cursor.ts --creds <file> --all
 *
 * The credential is read from the file only: it is never printed, never echoed,
 * and never written anywhere. Output shows model ids, stop reasons, usage and
 * the assistant text — nothing else.
 */
import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { createValidatedFetch } from "../../src/network/egress/fetch";
import { ValidatedNetworkBindingFactory } from "../../src/network/egress/factory";
import { resolveSsrfPolicy } from "../../src/config/network";
import { cursorAdapter } from "../../src/providers/integrations/cursor/cursor";
import {
  CURSOR_MODELS,
  discoverCursorModels,
  fetchCursorRunOrigin,
} from "../../src/providers/integrations/cursor/cursor-catalog";
import { openCursorRun } from "../../src/providers/integrations/cursor/cursor-http2";
import { buildRunRequest } from "../../src/providers/integrations/cursor/cursor-request";
import { buildHeartbeat } from "../../src/providers/integrations/cursor/cursor-request";
import { FALLBACK_CLIENT_VERSION } from "../../src/providers/integrations/cursor/cursor-shared";
import { decodeFramePayload, streamFrames } from "../../src/providers/integrations/cursor/protocol/framing";
import { decodeMessage } from "../../src/providers/integrations/cursor/protocol/messages";
import { parseProviderId, type ProviderDispatchTarget, type ProviderDispatchContext, type ResolvedCredential } from "../../src/providers/provider-contracts";
import type { CanonicalRequest } from "../../src/protocol/canonical-model";

/** One exported account, as the console's account export writes it. */
interface ExportedAccount {
  readonly providerId?: string;
  readonly accessToken?: string;
  readonly refreshToken?: string;
}

function readCredential(path: string): string {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  const accounts: readonly ExportedAccount[] =
    Array.isArray(parsed)
      ? (parsed as ExportedAccount[])
      : typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { accounts?: unknown }).accounts)
        ? ((parsed as { accounts: ExportedAccount[] }).accounts)
        : [];
  for (const account of accounts) {
    if ((account.providerId ?? "cursor") !== "cursor") continue;
    const token = account.accessToken?.trim();
    if (token !== undefined && token.length > 0) return token;
  }
  throw new Error(`No cursor account with an accessToken in ${path}`);
}

const { values } = parseArgs({
  options: {
    creds: { type: "string" },
    model: { type: "string", default: "auto" },
    prompt: { type: "string", default: "Reply with the single word: pong" },
    system: { type: "string" },
    "list-models": { type: "boolean", default: false },
    all: { type: "boolean", default: false },
    tools: { type: "boolean", default: false },
    "tool-result": { type: "string", default: "pong" },
    tenant: { type: "string", default: "probe-tenant" },
    "api-key": { type: "string", default: "probe-key" },
    account: { type: "string", default: "probe-account" },
    image: { type: "string" },
    params: { type: "string" },
    "max-mode": { type: "boolean", default: false },
    raw: { type: "boolean", default: false },
    heartbeat: { type: "boolean", default: false },
    timeout: { type: "string", default: "120000" },
    "read-idle": { type: "string", default: "120000" },
  },
});

const credsPath = values.creds;
if (credsPath === undefined) throw new Error("--creds <path> is required");
const credential = readCredential(credsPath);

const policy = resolveSsrfPolicy();
const bindingFactory = new ValidatedNetworkBindingFactory(policy);
const outboundFetch = createValidatedFetch({ policy });

function contextFor(): ProviderDispatchContext {
  const resolved: ResolvedCredential = {
    provider_id: parseProviderId("cursor"),
    credential_kind: "oauth",
    secret: new TextEncoder().encode(credential),
  };
  return {
    credential: resolved,
    deadline: Date.now() + Number(values.timeout),
    abort_signal: AbortSignal.timeout(Number(values.timeout)),
    outbound_fetch: outboundFetch,
    outbound_http2: bindingFactory.http2Bidi(undefined, undefined),
    // The adapter refuses a tool call it cannot hand to a later request, so a
    // tool probe must present the same scope a real dispatch would.
    continuation_scope: {
      tenantId: values.tenant ?? "probe-tenant",
      apiKeyId: values["api-key"] ?? "probe-key",
      providerId: "cursor",
      providerAccountId: values.account ?? "probe-account",
    },
  };
}

function requestFor(modelId: string): CanonicalRequest {
  return {
    model: modelId,
    messages: [{ role: "user", content: [{ kind: "text", text: values.prompt! }] }],
    ...(values.system === undefined
      ? {}
      : { system: [{ kind: "text", text: values.system }] }),
    ...(values.tools
      ? {
          tools: [
            {
              name: "lookup",
              description: "Look up a fact.",
              jsonSchema: { type: "object", properties: { q: { type: "string" } } },
            },
          ],
        }
      : {}),
    ...(values.image === undefined
      ? {}
      : {
          messages: [
            {
              role: "user",
              content: [
                { kind: "text", text: values.prompt! },
                {
                  kind: "image",
                  payload: { source: { type: "base64", data: values.image, media_type: "image/png" } },
                },
              ],
            },
          ],
        }),
    generation_controls: { max_tokens: 512 },
    stream: true,
    source_surface: "chat",
  };
}

function candidateFor(modelId: string): ProviderDispatchTarget {
  return {
    provider_id: parseProviderId("cursor"),
    model_id: modelId,
    wire_family: "chat",
    endpoint_path: "/agent.v1.AgentService/Run",
    capabilities: { tools: true, reasoning: true, prompt_caching: true },
  };
}

/** Call id the last probe captured, for the tool-result continuation probe. */
let capturedCallId: string | undefined;

async function runOne(modelId: string): Promise<void> {
  const startedAt = Date.now();
  let text = "";
  let reasoning = "";
  let stopReason = "none";
  let usage: unknown;
  const toolCalls: string[] = [];
  const errors: string[] = [];
  try {
    // A manual iterator, never `break`: breaking disposes the generator, which
    // stops the Run's frame reader. The Run must stay read (heartbeats drained)
    // between the two legs of the tool loop, exactly as it does in the gateway.
    const events = cursorAdapter.dispatch(requestFor(modelId), candidateFor(modelId), contextFor())[
      Symbol.asyncIterator
    ]();
    let next = await events.next();
    while (next.done !== true) {
      const event = next.value;
      if (event.type === "content_delta") {
        if (event.content.kind === "text") text += event.content.text;
        else if (event.content.kind === "reasoning") reasoning += event.content.summary ?? "";
      } else if (event.type === "tool_call_delta") {
        toolCalls.push(`${event.name}(${event.arguments_delta})`);
        capturedCallId = event.call_id;
        if (values.tools) {
          stopReason = "tool_use (Run held)";
          break;
        }
      } else if (event.type === "terminal") {
        stopReason = event.stop_reason ?? "unknown";
        usage = event.usage;
        if (event.state === "failed") errors.push("Cursor Run failed (see stop_reason=error)");
        if (event.stop_details !== undefined) {
          errors.push(JSON.stringify(event.stop_details));
        }
      }
      next = await events.next();
    }
  } catch (error) {
    const err = error as { message?: string; status?: number; code?: string };
    errors.push(`[${err.code ?? "error"} ${err.status ?? ""}] ${err.message ?? String(error)}`);
    console.log(`thrown: ${JSON.stringify(err)}`);
  }
  const latencyMs = Date.now() - startedAt;
  console.log(`\n=== ${modelId} ===`);
  console.log(`stop_reason : ${stopReason}`);
  console.log(`latency_ms  : ${latencyMs}`);
  if (usage !== undefined) console.log(`usage       : ${JSON.stringify(usage)}`);
  if (toolCalls.length > 0) console.log(`tool_calls  : ${JSON.stringify(toolCalls)}`);
  if (errors.length > 0) console.log(`errors      : ${JSON.stringify(errors)}`);
  if (reasoning.length > 0) console.log(`reasoning   : ${reasoning.slice(0, 800)}`);
  console.log(`text        : ${text.slice(0, 2000)}`);
}

/** The client version the wire sends, matching the donor's installer lookup. */
async function resolveClientVersion(): Promise<string> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    const response = await fetch("https://cursor.com/install", { signal: controller.signal });
    clearTimeout(timer);
    if (!response.ok) return FALLBACK_CLIENT_VERSION;
    const match = (await response.text()).match(/downloads\.cursor\.com\/lab\/([^/"'\s]+)\//);
    return match !== null ? `cli-${match[1]}` : FALLBACK_CLIENT_VERSION;
  } catch {
    return FALLBACK_CLIENT_VERSION;
  }
}

/** Decodes frame payloads the way the adapter's pump does, synchronously. */
function decodeServerMessagesSync(bytes: Uint8Array): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const frame of streamFrames(bytes)) {
    try {
      out.push(decodeMessage("AgentServerMessage", decodeFramePayload(frame)));
    } catch {
      // Unknown-field frame: the adapter skips these too.
    }
  }
  return out;
}

async function main(): Promise<void> {
  if (values["list-models"]) {
    const discovered = await discoverCursorModels({ credential, fetcher: outboundFetch as unknown as typeof fetch });
    console.log(`discovered ${discovered.length} models:`);
    for (const model of discovered) console.log(`  - ${model.modelId} (ctx ${model.contextLimit ?? "n/a"})`);
    return;
  }
  if (values.raw) {
    // The adapter's own transport, but the decoded messages are printed instead
    // of being projected onto canonical events: when a Run returns no text this
    // is what says whether the model answered, refused, or asked for a control
    // reply the adapter did not send.
    const origin = await fetchCursorRunOrigin({ credential, fetcher: outboundFetch as unknown as typeof fetch });
    const clientVersion = await resolveClientVersion();
    console.log(`origin: ${origin}`);
    console.log(`client: ${clientVersion}`);
    const signal = AbortSignal.timeout(Number(values.timeout));
    const opened = await openCursorRun({
      origin,
      credential,
      outboundHttp2: bindingFactory.http2Bidi(undefined, undefined),
      signal,
      readIdleMs: Number(values["read-idle"]),
      clientVersion,
    });
    await opened.write(
      buildRunRequest({
        text: values.prompt!,
        modelId: values.model!,
        conversationId: crypto.randomUUID(),
      }),
    );
    // Mirror the adapter's 5s client-heartbeat cadence so the raw path proves
    // the wire answer, not the same heartbeat-only stream.
    const beat = setInterval(() => void opened.write(buildHeartbeat()).catch(() => undefined), 5_000);
    beat.unref();
    // Raw bytes first, undecorated: a frame the message decoder skips (an
    // unknown field) still proves what the upstream actually sent.
    let count = 0;
    let rawBytes = 0;
    const captured: Uint8Array[] = [];
    for await (const chunk of opened.stream.body) {
      rawBytes += chunk.byteLength;
      count += 1;
      captured.push(chunk);
      const hex = Array.from(chunk.subarray(0, 64))
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
      console.log(`chunk#${count} bytes=${chunk.byteLength} hex=${hex}`);
      if (count >= 40) break;
    }
    console.log(`total_raw_bytes: ${rawBytes}`);
    // Re-decode the same bytes through the adapter's decoder: the hex above
    // proves what arrived, this shows what the adapter makes of it.
    let decoded = 0;
    const merged = new Uint8Array(rawBytes);
    let at = 0;
    for (const part of captured) {
      merged.set(part, at);
      at += part.byteLength;
    }
    for (const message of decodeServerMessagesSync(merged)) {
      decoded += 1;
      console.log(`decoded#${decoded} ${JSON.stringify(message).slice(0, 1500)}`);
      if (decoded >= 10) break;
    }
    console.log(`decoded_messages: ${decoded}`);
    // The frame the decoder could not turn into a message: gunzip it and show
    // the raw protobuf bytes, which is where the model's answer must be.
    const frames = [...streamFrames(merged)];
    console.log(`frame_count: ${frames.length}`);
    for (const [index, frame] of frames.entries()) {
      const payload = decodeFramePayload(frame);
      console.log(
        `frame#${index + 1} flags=${frame.flags} compressed=${frame.payload.byteLength} plain=${payload.byteLength} hex=${Array.from(payload.subarray(0, 48)).map((b) => b.toString(16).padStart(2, "0")).join("")}`,
      );
      // Not protobuf: the upstream answered with a Connect JSON error envelope,
      // which is the real refusal reason a probe has to surface verbatim.
      const text = new TextDecoder().decode(payload);
      if (text.trimStart().startsWith("{")) console.log(`frame#${index + 1} json=${text.slice(0, 800)}`);
    }
    clearInterval(beat);
    const response = opened.stream.response;
    console.log(
      `status=${response.status} headers=${JSON.stringify(response.headers)} trailers=${JSON.stringify(opened.stream.trailers)} frames=${count}`,
    );
    opened.stream.abort();
    return;
  }

  if (values.heartbeat) {
    // A probe request advertises no tools, so Cursor's tool-config handshake is
    // skipped and the Run streams only heartbeats; the reply is a wire probe.
    const origin = await fetchCursorRunOrigin({ credential, fetcher: outboundFetch as unknown as typeof fetch });
    const opened = await openCursorRun({
      origin,
      credential,
      outboundHttp2: bindingFactory.http2Bidi(undefined, undefined),
      signal: AbortSignal.timeout(Number(values.timeout)),
      readIdleMs: Number(values["read-idle"]),
      clientVersion: await resolveClientVersion(),
    });
    await opened.write(buildHeartbeat());
    const response = opened.stream.response;
    console.log(`heartbeat status=${response.status} trailers=${JSON.stringify(opened.stream.trailers)}`);
    opened.stream.abort();
    return;
  }
  const ids = values.all ? CURSOR_MODELS.map((model) => model.modelId) : [values.model! as string];
  for (const id of ids) await runOne(id);

  // Tool loop: first run asks for a tool call, second run answers it on the
  // same held Run. `--tools` alone stops at the call; `--tools --tool-result`
  // replays the captured call id as a continuation request.
  if (values.tools && capturedCallId !== undefined) {
    const callId: string = capturedCallId;
    const modelId = values.model!;
    const request = requestFor(modelId);
    request.messages = [
      { role: "user", content: [{ kind: "text", text: "Call the lookup tool with q=ping." }] },
      {
        role: "assistant",
        content: [{ kind: "toolCall", call_id: callId, name: "lookup", arguments: { q: "ping" } }],
      },
      {
        role: "tool",
        content: [{ kind: "toolResult", call_id: callId, content: [{ kind: "text", text: values["tool-result"] }] }],
      },
    ];
    const startedAt = Date.now();
    let text = "";
    let stopReason = "none";
    let usage: unknown;
    try {
      for await (const event of cursorAdapter.dispatch(request, candidateFor(modelId), contextFor())) {
        if (event.type === "content_delta" && event.content.kind === "text") text += event.content.text;
        else if (event.type === "terminal") {
          stopReason = event.stop_reason ?? "unknown";
          usage = event.usage;
        }
      }
    } catch (error) {
      console.log(`\n=== tool-result ${modelId} ===`);
      console.log(`error       : ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    console.log(`\n=== tool-result ${modelId} ===`);
    console.log(`stop_reason : ${stopReason}`);
    console.log(`latency_ms  : ${Date.now() - startedAt}`);
    if (usage !== undefined) console.log(`usage       : ${JSON.stringify(usage)}`);
    console.log(`text        : ${text.slice(0, 2000)}`);
  }
}

await main();
