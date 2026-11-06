/**
 * Cursor probe — hits the same wire the gateway adapter uses, with the exact
 * same headers and protobuf body shape, so the live wire can be compared 1:1
 * against what `cursor.ts` builds.
 *
 * Surfaces:
 *   --models   POST /aiserver.v1.AiService/AvailableModels (unary, JSON)
 *   --origin   POST /aiserver.v1.ServerConfigService/GetServerConfig (unary)
 *   --hit      POST /agent.v1.AgentService/Run (HTTP/2 bidi, connect+proto)
 *   --sweep   --hit on every model the account's roster declares
 *
 * The Run loop mirrors the adapter's pump: it answers Cursor's control frames
 * (request_context_args, mcp_state_exec_args, allowlist prechecks, KV) so the
 * turn is not left stalling on heartbeats, and it keeps a 5s heartbeat
 * cadence like the donor's continuation policy.
 *
 * Usage:
 *   bun run scripts/provider-probing/cursor/probe-cursor.ts \
 *     --creds C:\Users\Aria\Desktop\cursor-accounts-<ts>.json --hit
 *   bun run ... --creds <file> --label cursor-07z6xyk --models
 *   bun run ... --creds <file> --sweep
 *   bun run ... --creds <file> --hit --model grok-4.6 --message "ping"
 *
 * Tokens are never printed — only masked prefixes.
 */
import { parseArgs } from "node:util";
import {
  maskSecret,
  pickAccount,
  readAccountsFile,
  requireAccountToken,
} from "../lib/accounts";
import { probePostText } from "../lib/http";
import {
  AVAILABLE_MODELS_PATH,
  CONNECT_PROTOCOL_VERSION,
  CONTENT_TYPE_CONNECT_PROTO,
  CURSOR_API_BASE_URL,
  FALLBACK_CLIENT_VERSION,
  RUN_PATH,
  SERVER_CONFIG_PATH,
  normalizeAgentRunOrigin,
  resolveCursorTimezone,
} from "../../../src/providers/integrations/cursor/cursor-shared";
import { createCursorChecksumHeader, resolveCursorDeviceIds } from "../../../src/providers/integrations/cursor/cursor-identity";
import { encodeFrame, FLAG_END_STREAM, streamFrames, decodeFramePayload } from "../../../src/providers/integrations/cursor/protocol/framing";
import { decodeMessage } from "../../../src/providers/integrations/cursor/protocol/messages";
import {
  buildRunRequest,
  buildHeartbeat,
  buildRequestContextResult,
  buildMcpStateResult,
  buildAllowlistPrecheckResult,
  buildKvSetBlobResult,
  buildKvGetBlobResult,
  buildMcpRejected,
} from "../../../src/providers/integrations/cursor/cursor-request";
import { mapAvailableModelsResponse, type CursorModelInfo } from "../../../src/providers/integrations/cursor/cursor-catalog";

const args = parseArgs({
  options: {
    creds: { type: "string" },
    token: { type: "string" },
    label: { type: "string" },
    index: { type: "string" },
    model: { type: "string" },
    message: { type: "string", default: "ping" },
    models: { type: "boolean", default: false },
    origin: { type: "boolean", default: false },
    hit: { type: "boolean", default: false },
    sweep: { type: "boolean", default: false },
    "show-headers": { type: "boolean", default: false },
    timeout: { type: "string", default: "30000" },
  },
});

/** Maps canonical client model IDs to upstream Cursor wire IDs (same as adapter). */
function resolveCursorWireModelId(rawModelId: string): string {
  const id = rawModelId.trim().toLowerCase();
  return id === "auto" ? "default" : rawModelId;
}

/** Common Cursor identity headers for unary calls (mirror of catalog unaryHeaders). */
async function unaryHeaders(credential: string): Promise<Record<string, string>> {
  const { machineId, macMachineId } = await resolveCursorDeviceIds();
  return {
    authorization: `Bearer ${credential}`,
    "connect-protocol-version": CONNECT_PROTOCOL_VERSION,
    "content-type": "application/json",
    accept: "application/json",
    "x-cursor-client-type": "cli",
    "x-cursor-client-version": FALLBACK_CLIENT_VERSION,
    "x-cursor-checksum": createCursorChecksumHeader(machineId, macMachineId),
    "x-ghost-mode": "true",
    "x-request-id": crypto.randomUUID(),
    ...(resolveCursorTimezone() === "" ? {} : { "x-cursor-timezone": resolveCursorTimezone() }),
  };
}

/** One unary Connect call; returns status + full body. */
async function callUnary<T>(
  path: string,
  credential: string,
  body: unknown,
): Promise<{ status: number; ok: boolean; parsed: T; raw: string }> {
  const res = await probePostText(
    `${CURSOR_API_BASE_URL}${path}`,
    await unaryHeaders(credential),
    JSON.stringify(body),
    { timeoutMs: Number(args.values.timeout), bodyCap: 1_000_000 },
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(res.body);
  } catch {
    parsed = undefined;
  }
  return { status: res.status, ok: res.ok, parsed: parsed as T, raw: res.head };
}

/** Prints one model row compactly. */
function formatModel(m: CursorModelInfo): string {
  const caps = [
    m.supportsImages === true ? "vision" : "",
    m.supportsThinking === true ? "thinking" : "",
    m.supportsAgent === true ? "agent" : "",
    m.supportsMaxMode === true ? "max" : "",
  ].filter(Boolean);
  const variants = m.variants
    .map((v) => v.parameterValues.map((p) => `${p.id}=${p.value}`).join(","))
    .join(" | ");
  return `${m.id}${m.displayName !== m.id ? ` (${m.displayName})` : ""}${caps.length ? ` [${caps.join(",")}]` : ""}${m.maxContext ? ` ctx=${m.maxContext}` : ""}${variants ? ` :: ${variants}` : ""}`;
}

/** Opens an HTTP/2 bidi stream to the Run endpoint (node:http2). */
function openRunStream(origin: string, headers: Record<string, string>) {
  const http2 = require("node:http2") as typeof import("node:http2");
  const session = http2.connect(origin, { rejectUnauthorized: true });
  const stream = session.request({ ...headers, ":method": "POST", ":path": RUN_PATH });
  return { session, stream };
}

/** One Run hit; returns a one-line verdict. Never prints tokens. */
async function probeHitOnce(
  origin: string,
  credential: string,
  rawModelId: string,
  message: string,
  showHeaders: boolean,
): Promise<string> {
  const modelId = resolveCursorWireModelId(rawModelId);
  // Same headers the adapter's runHeaders() builds, minus the pool validation.
  const { machineId, macMachineId } = await resolveCursorDeviceIds();
  const headers: Record<string, string> = {
    authorization: `Bearer ${credential}`,
    "content-type": CONTENT_TYPE_CONNECT_PROTO,
    "connect-protocol-version": CONNECT_PROTOCOL_VERSION,
    "connect-accept-encoding": "gzip,br",
    "x-cursor-client-type": "cli",
    "x-cursor-client-version": FALLBACK_CLIENT_VERSION,
    "x-cursor-checksum": createCursorChecksumHeader(machineId, macMachineId),
    "x-cursor-streaming": "true",
    "x-ghost-mode": "true",
    "x-request-id": crypto.randomUUID(),
    "user-agent": "connect-es/1.6.1",
    ...(resolveCursorTimezone() === "" ? {} : { "x-cursor-timezone": resolveCursorTimezone() }),
  };
  if (showHeaders) {
    console.log("run headers:");
    for (const [k, val] of Object.entries(headers)) {
      console.log(`  ${k}: ${/auth|token/i.test(k) ? val.slice(0, 12) + "…" : val}`);
    }
  }
  const payload = buildRunRequest({
    text: message,
    modelId,
    conversationId: crypto.randomUUID(),
    runId: crypto.randomUUID(),
    history: [],
  });
  const { session, stream } = openRunStream(origin, headers);

  return await new Promise<string>((resolve) => {
    const timeout = setTimeout(() => {
      clearInterval(heartbeatTimer);
      stream.close();
      session.close();
      resolve(`FAIL ${modelId} [timeout]`);
    }, Number(args.values.timeout));

    // Heartbeat cadence: the edge answers a turn only after it has seen at
    // least one client heartbeat (donor pins this to 5s).
    const heartbeatTimer = setInterval(() => {
      try {
        stream.write(encodeFrame(0, buildHeartbeat()));
      } catch {
        clearInterval(heartbeatTimer);
      }
    }, 5_000);
    heartbeatTimer.unref?.();

    // Send the encoded run request immediately. The stream stays open: the
    // edge expects heartbeats and control replies until it ends the run with
    // `turn_ended` + END_STREAM. Closing the write side here made the server
    // answer `cancelled: KV stream closed` even after the model produced text.
    stream.write(encodeFrame(0, payload));

    let sawTurnEnded = false;
    let sawText = false;
    let sawHeartbeat = false;
    let providerModel = "";
    let sawToolCall = false;
    let toolNames: string[] = [];

    stream.on("response", (responseHeaders) => {
      if (responseHeaders[":status"] !== 200) {
        clearTimeout(timeout);
        clearInterval(heartbeatTimer);
        stream.close();
        session.close();
        resolve(`FAIL ${modelId} [http ${responseHeaders[":status"]}]`);
      }
    });

    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      const buf = Buffer.concat(chunks);
      let consumed = 0;
      for (const frame of streamFrames(new Uint8Array(buf))) {
        consumed += 5 + frame.payload.byteLength;
        const body = decodeFramePayload(frame);
        // A refusal is a Connect JSON error envelope, not protobuf: an
        // exhausted/closed account answers with one inside a 200 stream.
        const envelopeText = new TextDecoder().decode(body).trimStart();
        if (envelopeText.startsWith("{\"error\"")) {
          let envelope: { error?: { code?: unknown; message?: unknown; details?: unknown } } | undefined;
          try {
            envelope = JSON.parse(envelopeText) as typeof envelope;
          } catch {
            envelope = undefined;
          }
          const code = envelope?.error?.code ?? "?";
          const msg = envelope?.error?.message ?? "";
          // Pull the human-readable detail out of typed error details when
          // present (`debug.details.title` / `debug.details.detail`).
          const details = envelope?.error?.details;
          let detailMsg = msg;
          if (Array.isArray(details)) {
            for (const d of details) {
              const debug = (d as { debug?: { details?: { title?: string; detail?: string } } })?.debug?.details;
              if (debug?.detail) {
                detailMsg = `${debug.title ? `${debug.title}: ` : ""}${debug.detail}`;
                break;
              }
              if (debug?.title && detailMsg === msg) detailMsg = debug.title;
            }
          }
          if (frame.flags & FLAG_END_STREAM) {
            clearTimeout(timeout);
            clearInterval(heartbeatTimer);
            stream.close();
            session.close();
            resolve(`FAIL ${modelId} [error ${code}: ${detailMsg}]`);
            return;
          }
          continue;
        }
        try {
          const msg = decodeMessage("AgentServerMessage", body);
          const rec = msg as Record<string, unknown>;
          const interaction = (rec["interaction_update"] ?? {}) as Record<string, unknown>;

          if (interaction["heartbeat"]) {
            sawHeartbeat = true;
            continue;
          }
          if (interaction["text_delta"]) {
            sawText = true;
            continue;
          }
          if (interaction["thinking_delta"]) {
            // Reasoning deltas are content too — count them as activity.
            sawText = true;
            continue;
          }
          if (interaction["turn_ended"]) {
            sawTurnEnded = true;
            const ended = interaction["turn_ended"] as Record<string, unknown>;
            if (typeof ended["model"] === "string") providerModel = ended["model"];
            // The run is terminal the moment turn_ended arrives; the END_STREAM
            // frame may be delayed or coalesced, so resolve here rather than
            // waiting for it. Clean up: stop heartbeats and close the stream.
            clearTimeout(timeout);
            clearInterval(heartbeatTimer);
            stream.close();
            session.close();
            resolve(`PASS ${modelId}${providerModel ? ` -> ${providerModel}` : ""}${sawText ? "" : " [no-text]"}`);
            return;
          }

          // Control frames the adapter answers to keep the Run alive.
          const exec = (rec["exec_server_message"] ?? {}) as Record<string, unknown>;
          const execId = typeof exec["id"] === "number" ? exec["id"] : 0;
          const execIdString = typeof exec["exec_id"] === "string" ? exec["exec_id"] : undefined;
          if (exec["request_context_args"]) {
            stream.write(encodeFrame(0, buildRequestContextResult(execId, { tools: [], mcp_info_complete: true }, execIdString)));
            continue;
          }
          if (exec["mcp_state_exec_args"]) {
            stream.write(encodeFrame(0, buildMcpStateResult(execId, [], execIdString)));
            continue;
          }
          if (exec["shell_allowlist_precheck_args"]) {
            stream.write(encodeFrame(0, buildAllowlistPrecheckResult(execId, "shell", execIdString, true)));
            continue;
          }
          if (exec["mcp_allowlist_precheck_args"]) {
            stream.write(encodeFrame(0, buildAllowlistPrecheckResult(execId, "mcp", execIdString, false)));
            continue;
          }
          if (exec["web_fetch_allowlist_precheck_args"]) {
            stream.write(encodeFrame(0, buildAllowlistPrecheckResult(execId, "web_fetch", execIdString, false)));
            continue;
          }
          if (exec["mcp_args"]) {
            // A tool call the client must answer — count it, then reject so the
            // model continues (the probe cannot execute tools).
            const mcp = exec["mcp_args"] as Record<string, unknown>;
            const toolName = typeof mcp["tool_name"] === "string" ? mcp["tool_name"] : "?";
            sawToolCall = true;
            toolNames.push(toolName);
            stream.write(encodeFrame(0, buildMcpRejected(execId, "probe cannot execute tools", execIdString)));
            continue;
          }
          const kv = (rec["kv_server_message"] ?? {}) as Record<string, unknown>;
          const kvId = typeof kv["id"] === "number" ? kv["id"] : 0;
          if (kv["set_blob_args"]) {
            stream.write(encodeFrame(0, buildKvSetBlobResult(kvId)));
            continue;
          }
          if (kv["get_blob_args"]) {
            stream.write(encodeFrame(0, buildKvGetBlobResult(kvId, new Uint8Array(0))));
            continue;
          }
        } catch {
          // One undecodable frame is not fatal (adapter ignores unknown fields).
          continue;
        }
        if (frame.flags & FLAG_END_STREAM) {
          clearTimeout(timeout);
          clearInterval(heartbeatTimer);
          stream.close();
          session.close();
          if (sawTurnEnded) {
            const extras: string[] = [];
            if (!sawText) extras.push("no-text");
            if (sawToolCall) extras.push(`tools=[${toolNames.join(",")}]`);
            else if (sawHeartbeat) extras.push("heartbeat");
            resolve(`PASS ${modelId}${providerModel ? ` -> ${providerModel}` : ""}${extras.length ? ` [${extras.join(", ")}]` : ""}`);
          } else {
            resolve(`FAIL ${modelId} [ended without turn_ended${sawHeartbeat ? " (heartbeat-only)" : ""}]`);
          }
          return;
        }
      }
      if (consumed > 0) chunks.splice(0, consumed);
    });

    stream.on("error", (err: Error) => {
      clearTimeout(timeout);
      clearInterval(heartbeatTimer);
      session.close();
      resolve(`FAIL ${modelId} [stream error: ${err.message}]`);
    });

    stream.on("end", () => {
      clearTimeout(timeout);
      clearInterval(heartbeatTimer);
      session.close();
      if (sawTurnEnded) {
        resolve(`PASS ${modelId}${providerModel ? ` -> ${providerModel}` : ""}${sawText ? "" : " [no-text]"}`);
      } else {
        resolve(`FAIL ${modelId} [stream ended without turn_ended]`);
      }
    });
  });
}

async function resolveOrigin(credential: string): Promise<string | undefined> {
  const { ok, parsed, raw } = await callUnary<Record<string, unknown>>(
    SERVER_CONFIG_PATH,
    credential,
    { telem_enabled: false },
  );
  if (!ok) {
    console.log(`origin fetch failed: ${raw}`);
    return undefined;
  }
  const config = parsed?.["agentUrlConfig"] as Record<string, unknown> | undefined;
  const origin = normalizeAgentRunOrigin((config?.["agentnUrl"] ?? config?.["agentUrl"]) as string | undefined);
  if (!origin) {
    console.log("origin resolve failed (GetServerConfig missing agentnUrl/agentUrl)");
    return undefined;
  }
  return origin;
}

async function fetchModels(credential: string): Promise<CursorModelInfo[] | undefined> {
  const { ok, parsed, raw } = await callUnary<{ models?: unknown }>(
    AVAILABLE_MODELS_PATH,
    credential,
    { includeLongContextModels: true, useModelParameters: true, useCloudAgentEffortModes: true },
  );
  if (!ok) {
    console.log(`models fetch failed: ${raw}`);
    return undefined;
  }
  return mapAvailableModelsResponse(parsed ?? {});
}

async function main(): Promise<void> {
  const v = args.values;
  const token = v.token?.trim() ?? "";
  let credential = token;
  if (!credential) {
    if (!v.creds) throw new Error("pass --token <jwt> or --creds <accounts.json>");
    const accounts = readAccountsFile(v.creds!);
    const account = pickAccount(accounts, {
      providerId: "cursor",
      ...(v.label !== undefined ? { label: v.label } : {}),
      ...(v.index !== undefined ? { index: Number(v.index) } : {}),
    });
    credential = requireAccountToken(account);
  }
  console.log(`token prefix: ${maskSecret(credential)}`);

  // --models: fetch the live roster.
  if (v.models === true) {
    const models = await fetchModels(credential);
    if (!models) return;
    console.log(`\n${models.length} models:`);
    for (const m of models) console.log(`  ${formatModel(m)}`);
    return;
  }

  // --origin: resolve the Run origin.
  if (v.origin === true) {
    const origin = await resolveOrigin(credential);
    if (origin) console.log(`origin: ${origin}`);
    return;
  }

  // --hit / --sweep: open a Run.
  if (v.hit === true || v.sweep === true) {
    const origin = await resolveOrigin(credential);
    if (!origin) return;
    console.log(`origin: ${origin}`);

    if (v.sweep === true) {
      const models = await fetchModels(credential);
      if (!models) return;
      console.log(`\n=== sweep (${models.length} models) ===`);
      for (const m of models) {
        const outcome = await probeHitOnce(origin, credential, m.id, v.message!, v["show-headers"] === true);
        console.log(outcome);
      }
      return;
    }

    const modelId = v.model ?? "auto";
    const outcome = await probeHitOnce(origin, credential, modelId, v.message!, v["show-headers"] === true);
    console.log(outcome);
    return;
  }

  console.log("no probe selected — use --models, --origin, --hit, or --sweep");
}

await main();
