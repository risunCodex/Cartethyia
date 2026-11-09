/**
 * Qoder IDE surface (`/model/v1/chat/completions`) — request builder, SSE/
 * envelope parsing, canonical-event mapping, and the empty-stream recovery
 * sniff.
 *
 * Surface contract: the IDE surface is the only Qoder surface that echoes
 * strategy metadata (`raw_usage` → provider_model/target) and it streams
 * immediately, but it caps at ~256 KiB and is used in production **only for
 * probing/testing** — gRPC is the default billed carrier and COSY the
 * free/lite carrier (see `qoder-adapter.ts`).
 */
import { GatewayError } from "../../../protocol/gateway-error";
import type { CanonicalEvent, CanonicalRequest, CanonicalStopReason } from "../../../protocol/canonical-model";
import { usageFromProvider, readReasoningText } from "../../provider-usage";
import { classifyUpstreamError, extractUpstreamMessage, isUpstreamQueued, queueRetryAfterMs, upstreamErrorIdentifier } from "../../../transport/failure-policy";
import { getQoderVersion } from "../../operations/client-versions";
import { buildQoderRequest } from "./qoder-chat";
import { decodeQoderSseEvents } from "./qoder-sse";
import { QODER_PROVIDER_ID, type QoderRealm } from "./qoder-realm";
import type { QoderAuth, QoderModelConfig } from "./qoder-types";

/**
 * The human-readable text out of a Qoder error envelope.
 *
 * The envelope is Qoder's own wrapper around the stream, and it does not use
 * one field for the message: the text has been seen as a nested `error`
 * object, a bare string `body`, and a top-level `message`/`msg`. The canonical
 * extractor covers the structured shapes; a string body and the top-level
 * fields cover the rest. Whatever survives is bounded the same way an upstream
 * message is, so a verbose envelope cannot blow up the public error line.
 */
function qoderEnvelopeMessage(rec: Record<string, unknown>): string {
  const structured = extractUpstreamMessage(rec["body"]);
  if (structured.length > 0) return structured;
  if (typeof rec["body"] === "string" && rec["body"].trim().length > 0 && rec["body"] !== "[DONE]")
    return rec["body"].replace(/[\r\n]+/g, " ").trim().slice(0, 500);
  return extractUpstreamMessage(rec);
}

export function qoderEnvelopeToFrames(data: string): Array<{ event: string | null; data: string }> {
  if (data === "[DONE]") return [{ event: null, data: "[DONE]" }];
  let envelope: unknown;
  // The IDE surface sometimes embeds literal newlines inside JSON string
  // values (e.g. the raw_usage event carries keys like
  // `"data_policy_preferre\n\nnd_count"`). Those bytes are not valid JSON, so
  // the first parse fails; when it does, salvage the event by escaping the
  // raw newlines inside string values and parse again. The repaired text is
  // also what the direct-chunk branch hands to the chunk parser below, so its
  // own `JSON.parse` succeeds too.
  let repaired = data;
  try {
    envelope = JSON.parse(data);
  } catch {
    const attempted = escapeJsonRawNewlines(data);
    if (attempted !== data) {
      try {
        envelope = JSON.parse(attempted);
        repaired = attempted;
      } catch {
        envelope = undefined;
      }
    }
  }
  if (typeof envelope !== "object" || envelope === null || Array.isArray(envelope)) return [];
  const rec = envelope as Record<string, unknown>;
  if (rec["statusCodeValue"] !== undefined && rec["statusCodeValue"] !== 200) {
    const status = typeof rec["statusCodeValue"] === "number" ? (rec["statusCodeValue"] as number) : 502;
    // Qoder reports failures inside the stream envelope instead of as HTTP
    // responses, so classify its structured provider code and status through
    // the same gateway error policy as the other dispatch paths.
    const detail = qoderEnvelopeMessage(rec);
    const identifier = upstreamErrorIdentifier(rec["body"]) ?? upstreamErrorIdentifier(rec);
    // Qoder signals a queued request the same way inside the stream as it does
    // on HTTP: `{"code":"10605", "isQueued":true, "retryAfterSeconds":N}` on a
    // non-200 envelope. The status table would read the 403 as a refusal, and
    // the caller would end its turn on a request that was only waiting.
    const queuedWaitMs = isUpstreamQueued(rec["body"]) ?? false;
    const waitMs = queuedWaitMs
      ? (queueRetryAfterMs(rec["body"]) ?? undefined)
      : undefined;
    const classification = queuedWaitMs
      ? { code: "upstream_queued" as const, status: 503, origin: "upstream" as const }
      : classifyUpstreamError(status, identifier);
    throw new GatewayError(
      classification.code,
      classification.status,
      detail.length > 0 ? `${detail} (request {requestId}). The upstream came back empty-handed — retry 🌙` : `Qoder stream envelope returned HTTP ${status} (request {requestId}). The upstream came back empty-handed — retry 🌙`,
      {
        providerId: QODER_PROVIDER_ID,
        providerStatus: status,
        ...(identifier ? { providerCode: identifier } : {}),
        ...(classification.credentialEvidence ? { credentialEvidence: true } : {}),
        ...(classification.rateLimitScope
          ? { rateLimitScope: classification.rateLimitScope }
          : {}),
        ...(waitMs === undefined ? {} : { retryAfterMs: waitMs, cooldownMs: waitMs }),
        ...(queuedWaitMs ? { reason: "upstream-queued" } : {}),
      },
      classification.origin,
    );
  }
  const body = rec["body"];
  if (body === "[DONE]") return [{ event: null, data: "[DONE]" }];
  if (typeof body === "string") return [{ event: null, data: body.replace(/\r?\n/g, "") }];
  // Direct OpenAI chunk (IDE surface): no envelope body, but a `choices` array
  // is present. Pass the (repaired) raw data through so the chunk parser sees
  // it.
  if (Array.isArray(rec["choices"])) return [{ event: null, data: repaired }];
  return [];
}

/**
 * Escapes raw newline bytes that appear inside JSON string values.
 *
 * The IDE surface emits `data:` events whose JSON payload contains literal
 * newlines inside strings (the terminal `raw_usage` event carries keys like
 * `"data_policy_preferre\n\nnd_count"`). `JSON.parse` rejects those bytes, so
 * before parsing we rewrite each raw `\n` found inside a string to the two
 * characters `\n`. Bytes outside strings (whitespace, structural separators)
 * are left untouched.
 */
function escapeJsonRawNewlines(data: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < data.length; i += 1) {
    const ch = data[i]!;
    if (inString) {
      if (escaped) {
        out += ch;
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        out += ch;
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = false;
        out += ch;
        continue;
      }
      if (ch === "\n" || ch === "\r") {
        out += "\\n";
        continue;
      }
      out += ch;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    out += ch;
  }
  return out;
}

function mapQoderFinishReason(raw: unknown): CanonicalStopReason | undefined {
  if (raw === "stop") return "stop";
  if (raw === "length") return "length";
  if (raw === "tool_calls") return "tool_use";
  if (raw === "content_filter") return "content_filter";
  if (raw === "error") return "error";
  if (raw === "refusal") return "refusal";
  return undefined;
}

/**
 * Keys the IDE surface's `raw_usage` (and top-level frame) carries that
 * describe the model that *actually* served the turn. The production
 * transports (gRPC / COSY) only echo an opaque roster key, so this metadata is
 * the one place the upstream names its real supply model/target.
 */
const QODER_PROVIDER_META_KEYS = [
  "provider_model",
  "from_model",
  "supply_model",
  "supply_account",
  "supply_region",
  "model_level",
  "router_strategy_name",
  "router_strategy_type",
  "scheduler_times",
  "target",
  "target_id",
] as const;

/** Collects provider metadata from a raw_usage object and its `data` child. */
function collectQoderProviderMeta(
  target: Record<string, unknown>,
  rawUsageObj: Record<string, unknown>,
): void {
  const data = rawUsageObj["data"];
  const candidates: unknown[] = [rawUsageObj, data];
  for (const src of candidates) {
    if (!src || typeof src !== "object" || Array.isArray(src)) continue;
    const s = src as Record<string, unknown>;
    for (const key of QODER_PROVIDER_META_KEYS) {
      const value = s[key];
      if (value !== undefined && value !== null && target[key] === undefined) {
        target[key] = value;
      }
    }
  }
}

export async function* qoderBodyToCanonicalEvents(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  model: string,
): AsyncIterable<CanonicalEvent> {
  let seq = 1;
  let started = false;
  let finishReason: unknown = undefined;
  let rawUsage: Record<string, unknown> | undefined = undefined;
  const providerMetadata: Record<string, unknown> = {};
  let hasTerminal = false;
  // Once a finish reason or `[DONE]` is seen the turn is over: delta content,
  // reasoning, and tool-call fragments in later frames must be dropped —
  // strict OpenAI clients reject content after the finish reason. Usage,
  // errors, and the marker itself still flow.
  let finishSeen = false;
  /** First-sighting id per wire tool-call index, for continuation chunks. */
  const indexIds = new Map<number, string>();
  /** Last seen call id, for index-less continuation fragments. */
  let lastSeenToolId: string | undefined = undefined;

  for await (const sse of decodeQoderSseEvents(body, signal)) {
    const sseData = sse.data;
    let frames: Array<{ event: string | null; data: string }>;
    try {
      frames = qoderEnvelopeToFrames(sseData);
    } catch (e) {
      throw e;
    }
    for (const frame of frames) {
      const data = frame.data.trim();
      if (!data) continue;
      if (data === "[DONE]") {
        hasTerminal = true;
        finishSeen = true;
        if (!started) {
          yield { type: "response_start", sequence_number: seq++, model } as CanonicalEvent;
          started = true;
        }
        continue;
      }
      let json: Record<string, unknown>;
      try {
        json = JSON.parse(data) as Record<string, unknown>;
      } catch {
        continue;
      }
      // The upstream names the real model in each chunk. Use the first one we
      // see for the opening event so the client sees the same model the
      // provider actually served, not the (virtual) id that was requested.
      if (!started && typeof json["model"] === "string") {
        const upstreamModel = (json["model"] as string).trim();
        yield {
          type: "response_start",
          sequence_number: seq++,
          model: upstreamModel.length > 0 ? upstreamModel : model,
        } as CanonicalEvent;
        started = true;
      }
      // IDE surface error event: `{"code":"invalid_model_error","message":"..."}`
      // carries no choices. Surface it as an upstream failure instead of an
      // empty successful stream.
      if (json["error"] !== undefined && json["choices"] === undefined) {
        const error = json["error"] as Record<string, unknown> | string;
        const message =
          typeof error === "string"
            ? error
            : typeof error?.["message"] === "string"
              ? (error["message"] as string)
              : typeof json["message"] === "string"
                ? (json["message"] as string)
                : "Qoder model server error";
        const code = typeof json["code"] === "string" ? (json["code"] as string) : undefined;
        throw new GatewayError(
          code === "invalid_model_error" ? "model_not_found" : "platform_unavailable",
          code === "invalid_model_error" ? 404 : 502,
          `${message} (request {requestId}). The upstream came back empty-handed — retry 🌙`,
          { providerId: QODER_PROVIDER_ID, ...(code === undefined ? {} : { providerCode: code }) },
          "upstream",
        );
      }
      if (json["usage"] && typeof json["usage"] === "object") rawUsage = json["usage"] as Record<string, unknown>;
      // IDE surface terminal event: `choices:[]` + `raw_usage`. It carries the
      // final usage and confirms the turn ended, so record it and synthesize a
      // stop reason — the terminal event has no `choices[].finish_reason`.
      if (json["raw_usage"] && typeof json["raw_usage"] === "object") {
        const rawUsageObj = json["raw_usage"] as Record<string, unknown>;
        collectQoderProviderMeta(providerMetadata, rawUsageObj);
        rawUsage = (rawUsageObj["data"] as Record<string, unknown> | undefined) ?? rawUsageObj;
        if (json["choices"] === undefined || (json["choices"] as unknown[]).length === 0) {
          finishReason = finishReason ?? "stop";
        }
      }
      const choices = (json["choices"] as Array<Record<string, unknown>>) ?? [];
      // After a finish was seen (per-choice or top-level finish_reason, or
      // `[DONE]`) the turn is over: delta content, reasoning, and tool-call
      // fragments in later frames are dropped — strict OpenAI clients reject
      // content after the finish reason. Usage and errors still flow.
      if (!finishSeen) {
        for (const choice of choices) {
          const delta = choice["delta"] as Record<string, unknown> | undefined;
          if (delta) {
            if (typeof delta["content"] === "string" && (delta["content"] as string).length > 0) {
              const piece = delta["content"] as string;
              yield {
                type: "content_delta",
                sequence_number: seq++,
                content: { kind: "text", text: piece },
              } as CanonicalEvent;
              continue;
            }
            const reasoningText = readReasoningText(delta);
            if (typeof reasoningText === "string" && reasoningText.length > 0) {
              yield {
                type: "content_delta",
                sequence_number: seq++,
                content: { kind: "reasoning", payload: null, summary: reasoningText },
              } as CanonicalEvent;
              continue;
            }
            const toolCalls = delta["tool_calls"] as Array<Record<string, unknown>> | undefined;
            if (toolCalls) {
              for (const tc of toolCalls) {
                const fn = tc["function"] as Record<string, unknown> | undefined;
                const index = typeof tc["index"] === "number" ? (tc["index"] as number) : undefined;
                // The donor (StreamAdapter `vTe` / `$Dl`) forwards each tool-call
                // delta exactly as received — `id`, `index`, `name`, and the raw
                // `arguments` string fragment — with no buffering, splitting, or
                // JSON repair. It does pin the first seen id per wire `index`
                // and reuses it for continuation fragments, so the client's
                // trackers keep one identity per call. Do the same here: each
                // delta becomes its own `tool_call_delta` under the pinned id.
                const declaredId =
                  typeof tc["id"] === "string" && (tc["id"] as string).length > 0
                    ? (tc["id"] as string)
                    : undefined;
                const fragName = typeof fn?.["name"] === "string" ? (fn["name"] as string).trim() : undefined;
                const fragArgs =
                  typeof fn?.["arguments"] === "string" ? (fn["arguments"] as string) : "";
                if (declaredId !== undefined && index !== undefined && !indexIds.has(index)) {
                  indexIds.set(index, declaredId);
                }
                if (declaredId !== undefined) lastSeenToolId = declaredId;
                const callId =
                  (index !== undefined ? indexIds.get(index) : undefined) ??
                  declaredId ??
                  lastSeenToolId ??
                  `call_anon_${Date.now().toString(36)}_${seq}`;
                yield {
                  type: "tool_call_delta",
                  sequence_number: seq++,
                  call_id: callId,
                  index: index ?? 0,
                  name: fragName,
                  arguments_delta: fragArgs,
                } as CanonicalEvent;
              }
            }
          }
          const fr = choice["finish_reason"];
          // The IDE surface sends an empty string (`""`) for the per-delta finish
          // reason, which is not a real stop signal — only a value that maps to a
          // canonical stop reason (or the terminal `[DONE]` frame) ends the turn.
          if (fr !== null && fr !== undefined && fr !== "") {
            finishReason = fr;
            finishSeen = true;
          }
          // Some providers send usage in choices[0].usage or top-level
          if (choice["usage"] && typeof choice["usage"] === "object") rawUsage = choice["usage"] as Record<string, unknown>;
        }
      }
      // Some Qoder chunks carry finish_reason at top level (empty string means
      // no stop signal, same as the per-delta field).
      if (json["finish_reason"] !== undefined && json["finish_reason"] !== "") {
        finishReason = json["finish_reason"];
        finishSeen = true;
      }
    }
  }
  // A `[DONE]` frame from the IDE surface may be the only terminal signal (the
  // //-delta `finish_reason` is empty and `raw_usage` is not always sent), so
  // a clean end-of-stream with no finish reason is a normal stop, not a
  // truncation. If no terminal arrived at all, still synthesize one (prevents
  // truncation error).
  if (!started) {
    yield { type: "response_start", sequence_number: seq++, model } as CanonicalEvent;
  }
  if (hasTerminal && finishReason === undefined) finishReason = "stop";
  const stopReason = mapQoderFinishReason(finishReason);
  const _providerStop = typeof finishReason === "string" ? finishReason : undefined;
  void hasTerminal;
  // No buffered tool-call flush: each `delta.tool_calls` fragment is emitted
  // as its own `tool_call_delta` as it arrives (donor mirror), so the client
  // stitches by `index`/`id` itself. Usage and terminal still flow here.
  yield {
    type: "terminal",
    sequence_number: seq++,
    // `error` is a failed terminal; every other stop (stop, tool_use,
    // refusal, content_filter, length) is a complete turn.
    state: stopReason === "error" ? "failed" : "complete",
    ...(stopReason === undefined ? {} : { stop_reason: stopReason }),
    ...(_providerStop === undefined ? {} : { provider_stop_reason: _providerStop }),
    usage: usageFromProvider(rawUsage),
    ...(Object.keys(providerMetadata).length > 0 ? { provider_metadata: providerMetadata } : {}),
  } as CanonicalEvent;
}

/**
 * Builds the modern model-server (`/model/v1/chat/completions`) request body.
 *
 * It reuses the message translation from `buildQoderRequest` (tool turns,
 * reasoning echo, image parts) and wraps the result in the OpenAI-shaped body
 * the IDE surface expects: top-level `model`, `messages`, `stream_options`,
 * and a `metadata.context`/`metadata.business` block. `model` is the roster
 * key after virtual-name resolution, so the upstream never sees a virtual id
 * (which it answers by falling back to `auto`).
 */
export function buildQoderIdeRequest(
  modelId: string,
  request: CanonicalRequest,
  modelConfig: QoderModelConfig,
  auth: QoderAuth,
  realm: QoderRealm = "intl",
  version = getQoderVersion(),
): Record<string, unknown> {
  const legacy = buildQoderRequest(modelId, request, modelConfig, auth, realm);
  const messages = legacy.messages as Array<Record<string, unknown>>;
  // The IDE surface (`model/v1/chat/completions`) must ship the same tool
  // declaration as the legacy builder. The unpacked desktop client (worker
  // `PFn`) injects `tools` directly when present — without it the upstream
  // sees no toolset and answers with a DSML text block (or claims no tool
  // exists) instead of a structured `tool_calls`. The remaining knobs
  // (`parallel_tool_calls`, `tool_choice`, …) ride the `parameters`
  // passthrough (worker `vyl`), matching the reference exactly.
  const tools = legacy.tools as Array<Record<string, unknown>> | undefined;
  return {
    model: modelId,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    ...(tools !== undefined && tools.length > 0 ? { tools } : {}),
    ...(legacy.parameters === undefined ? {} : { parameters: legacy.parameters }),
    // The same reasoning-effort field the legacy surface uses; without it the
    // IDE surface streams no thinking for models that need the push (Sonus,
    // Cantus). Undefined when the caller asked for none and the roster has no
    // default, matching the legacy builder.
    ...(legacy.reasoningEffort === undefined ? {} : { reasoningEffort: legacy.reasoningEffort }),
    // The full wire config (model key, window, output ceiling, tier) the legacy
    // surface sends. The IDE surface reads the same block, so shipping it keeps
    // the request the same shape for every Qoder model — including lite's 1M
    // window and 64k output cap.
    ...(legacy.model_config === undefined ? {} : { model_config: legacy.model_config }),
    metadata: {
      context: {
        request_id: legacy.request_id,
        request_set_id: legacy.request_set_id,
        session_id: legacy.session_id,
        source_session_id: "",
        task_id: "common",
        client_type: "5",
      },
      business: {
        business_product: "cli",
        business_type: "agent",
        business_version: version,
        scene: "assistant",
      },
    },
    max_tokens: (legacy.max_tokens as number) ?? 65_536,
  };
}

