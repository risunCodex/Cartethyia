/**
 * Qoder-specific SSE decoding + enveloped stream → canonical events.
 *
 * The generic `decodeSseEvents` splits on newlines and treats a bare line
 * (no `data:` prefix) with no open event as malformed. Qoder's surfaces embed
 * literal newline bytes inside JSON string values (e.g. `raw_usage` keys like
 * `"data_policy_preferre\n\nnd_count"`), which fragments one logical `data:`
 * event into many physical lines — including blank lines that are not event
 * boundaries. The generic decoder can throw `Malformed SSE line` on the
 * trailing fragments of those giant events.
 *
 * This decoder is tolerant by construction: it accumulates one event's payload
 * across `data:` lines, bare continuations, and blank lines until the payload
 * is a complete JSON value or the `[DONE]` sentinel. It never throws on a
 * bare fragment — payload completeness is the only way an event ends.
 *
 * The enveloped-stream mapping (`qoderBodyToCanonicalEvents`) is the sole
 * chat-stream parser for the live legacy COSY surface
 * (`/algo/.../agent_chat_generation`). It understands Qoder's envelope
 * (`{headers, body, statusCodeValue, statusCode}`), direct OpenAI chunks, and
 * the terminal `raw_usage` event, and maps them to canonical events. The dead
 * surfaces (gRPC `model.chat.ChatService`, IDE `/model/v1`) are not part of
 * this module anymore.
 */

import { GatewayError } from "../../../protocol/gateway-error";
import { isCompleteJsonValue } from "../../../protocol/sse-decoder";
import type { CanonicalEvent } from "../../../protocol/canonical-model";
import { usageFromProvider, readReasoningText } from "../../provider-usage";
import { mapChatFinishReason } from "../shared/cli-client-kit";
import {
  classifyUpstreamError,
  extractUpstreamMessage,
  isUpstreamQueued,
  queueRetryAfterMs,
  upstreamErrorIdentifier,
} from "../../../protocol/upstream-errors";
import { QODER_PROVIDER_ID } from "./qoder-realm";
import { noteQoderQueue } from "./qoder-risk";

export interface QoderSseEvent {
  readonly event: string | null;
  readonly data: string;
}

const DEFAULT_MAX_EVENT_BYTES = 8 * 1024 * 1024;

/**
 * Decodes Qoder SSE into complete events.
 */
export async function* decodeQoderSseEvents(
  body: ReadableStream<Uint8Array> | null,
  signal?: AbortSignal,
  maxEventBytes = DEFAULT_MAX_EVENT_BYTES,
): AsyncIterable<QoderSseEvent> {
  if (body === null) return;

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let lineBuffer = "";
  let current: string | null = null; // accumulated payload of the open event
  let eventBytes = 0;

  /** Returns the open payload when complete, else null (clearing it). */
  const takeComplete = (): string | null => {
    if (current === null) return null;
    const trimmed = current.trim();
    if (trimmed.length === 0) {
      current = null;
      eventBytes = 0;
      return null;
    }
    if (trimmed === "[DONE]" || isCompleteJsonValue(trimmed)) {
      const out = current;
      current = null;
      eventBytes = 0;
      return out;
    }
    return null;
  };

  while (true) {
    const { done, value } = await reader.read();
    if (signal?.aborted) return;
    if (done) break;
    lineBuffer += decoder.decode(value, { stream: true });
    // Drain complete lines from the buffer into the accumulation stream.
    let newlineIndex: number;
    while ((newlineIndex = lineBuffer.indexOf("\n")) >= 0) {
      let line = lineBuffer.slice(0, newlineIndex).replace(/\r$/, "");
      lineBuffer = lineBuffer.slice(newlineIndex + 1);
      if (line.startsWith("data:")) {
        const payload = line.slice(5).replace(/^ /, "");
        eventBytes += payload.length;
        if (eventBytes > maxEventBytes) {
          current = null;
          eventBytes = 0;
          continue;
        }
        if (current === null) {
          current = payload;
        } else {
          current += "\n" + payload;
        }
        const complete = takeComplete();
        if (complete !== null) {
          yield { event: null, data: complete };
        }
      } else if (line.trim() === "") {
        // Blank line inside a giant event is a continuation, not a boundary.
        if (current !== null) {
          const complete = takeComplete();
          if (complete !== null) {
            yield { event: null, data: complete };
          }
        }
      } else if (line.startsWith("event:")) {
        // We don't key off event names; keep the accumulated payload flowing.
        continue;
      } else {
        // Bare continuation line (no `data:` prefix): treat as payload.
        if (current !== null) {
          current += "\n" + line;
          const complete = takeComplete();
          if (complete !== null) {
            yield { event: null, data: complete };
          }
        }
      }
    }
  }
  // Flush remaining buffer / payload.
  if (lineBuffer.length > 0) {
    if (current === null) {
      current = lineBuffer.trim();
    } else {
      current += "\n" + lineBuffer;
    }
  }
  const complete = takeComplete();
  if (complete !== null) yield { event: null, data: complete };
}

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

/**
 * The queue shape out of a queued envelope, e.g. `queueType=p4
 * subCode=RESOURCE_LIMIT`.
 *
 * The queue code alone (`10605`) conflates two different upstream states: a
 * capacity queue that admits within the stated interval, and a sustained
 * priority-class pin (observed as `queueType: "p4"` with
 * `subCode: "RESOURCE_LIMIT"` on every account, realm, and model while quota
 * reads healthy) that is an egress/machine-dimension risk signal, not
 * congestion. Those fields ride the envelope body, so they are surfaced on
 * the error detail verbatim — operators need to see `p4` in telemetry to
 * tell "wait it out" from "your egress is flagged", and the account-health
 * machinery keys its cooldown evidence off the same detail.
 */
function qoderQueueShapeTags(rec: Record<string, unknown>): string {
  const sources = [rec["body"], rec].filter(
    (value): value is Record<string, unknown> =>
      typeof value === "object" && value !== null && !Array.isArray(value),
  );
  const tags: string[] = [];
  for (const key of ["queueType", "subCode", "queue_type", "sub_code"]) {
    for (const source of sources) {
      const value = source[key];
      if (typeof value === "string" && value.trim().length > 0) {
        tags.push(`${key}=${value.trim()}`);
        break;
      }
    }
  }
  return tags.join(" ");
}

/**
 * Splits one SSE `data:` payload into frames:
 * - the envelope form `{"headers":...,"body":"<json>","statusCodeValue":200}`,
 * - a direct OpenAI chunk `{"choices":[...]}`,
 * - the `[DONE]` sentinel.
 *
 * A non-200 envelope is classified through the gateway error policy and thrown
 * as a `GatewayError`, including Qoder's queued-request signal (`10605` /
 * `isQueued`).
 */
export function qoderEnvelopeToFrames(data: string): Array<{ event: string | null; data: string }> {
  if (data === "[DONE]") return [{ event: null, data: "[DONE]" }];
  let envelope: unknown;
  // Raw newlines inside JSON string values (e.g. `raw_usage` keys like
  // `"data_policy_preferre\n\nnd_count"`) are not valid JSON, so the first
  // parse fails; when it does, salvage the event by escaping the raw newlines
  // inside string values and parse again.
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
    // The body rides the envelope as a JSON *string* on some deployments and
    // as an object on others. The queue classifier and the retry-after reader
    // are record-shaped: a string body reached them unparsed, so a queued
    // stream classified as a plain 403 (`authentication_failed`) and the
    // priority class (`queueType`/`subCode`) never surfaced. Parse once here
    // so every consumer sees the same record.
    let bodyForClassification: unknown = rec["body"];
    if (typeof bodyForClassification === "string" && /^\s*[{\[]/.test(bodyForClassification)) {
      try {
        bodyForClassification = JSON.parse(bodyForClassification);
      } catch {
        // keep the raw string; the extractors handle text bodies
      }
    }
    const detail = qoderEnvelopeMessage({ ...rec, body: bodyForClassification });
    const identifier =
      upstreamErrorIdentifier(bodyForClassification) ?? upstreamErrorIdentifier(rec);
    const queuedWaitMs = isUpstreamQueued(bodyForClassification) ?? false;
    const waitMs = queuedWaitMs
      ? (queueRetryAfterMs(bodyForClassification) ?? undefined)
      : undefined;
    const classification = queuedWaitMs
      ? { code: "upstream_queued" as const, status: 503, origin: "upstream" as const }
      : classifyUpstreamError(status, identifier);
    const queueTags = queuedWaitMs
      ? qoderQueueShapeTags({ ...rec, body: bodyForClassification })
      : "";
    if (queuedWaitMs) {
      // Risk telemetry: the queue's priority class is the signal that
      // distinguishes a capacity wait from an egress/machine pin.
      const bodyRecord =
        typeof bodyForClassification === "object" && bodyForClassification !== null
          ? (bodyForClassification as Record<string, unknown>)
          : undefined;
      const queueType =
        bodyRecord !== undefined && typeof bodyRecord["queueType"] === "string"
          ? (bodyRecord["queueType"] as string)
          : undefined;
      noteQoderQueue(QODER_PROVIDER_ID, queueType);
    }
    const queueDetail = queueTags.length > 0 ? `${detail} [${queueTags}]`.trim() : detail;
    throw new GatewayError(
      classification.code,
      classification.status,
      queueDetail.length > 0 ? `${queueDetail} (request {requestId}). The upstream came back empty-handed — retry 🌙` : `Qoder stream envelope returned HTTP ${status} (request {requestId}). The upstream came back empty-handed — retry 🌙`,
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
  // Direct OpenAI chunk: no envelope body, but a `choices` array is present.
  // Pass the (repaired) raw data through so the chunk parser sees it.
  if (Array.isArray(rec["choices"])) return [{ event: null, data: repaired }];
  return [];
}

/**
 * Escapes raw newline bytes that appear inside JSON string values.
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

/**
 * Keys the stream's `raw_usage` (and top-level frame) carries that describe the
 * model that *actually* served the turn. The production COSY surface only
 * echoes an opaque roster key, so this metadata is the one place the upstream
 * names its real supply model/target.
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

/**
 * Maps one Qoder stream (legacy COSY / enveloped SSE) to canonical events.
 *
 * This is the only live chat-stream parser (2026-11-11): the gRPC and IDE
 * surfaces are dead on every resolving host, so `qoderBodyToCanonicalEvents`
 * is the sole path used by the adapter.
 */
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
    const frames = qoderEnvelopeToFrames(sse.data);
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
      // Error event: `{"code":"invalid_model_error","message":"..."}` carries
      // no choices. Surface it as an upstream failure instead of an empty
      // successful stream.
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
      // Terminal event: `choices:[]` + `raw_usage`. It carries the final usage
      // and confirms the turn ended, so record it and synthesize a stop reason —
      // the terminal event has no `choices[].finish_reason`.
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
      // fragments in later frames are dropped. Usage and errors still flow.
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
          if (fr !== null && fr !== undefined && fr !== "") {
            finishReason = fr;
            finishSeen = true;
          }
          if (choice["usage"] && typeof choice["usage"] === "object") rawUsage = choice["usage"] as Record<string, unknown>;
        }
      }
      if (json["finish_reason"] !== undefined && json["finish_reason"] !== "") {
        finishReason = json["finish_reason"];
        finishSeen = true;
      }
    }
  }
  if (!started) {
    yield { type: "response_start", sequence_number: seq++, model } as CanonicalEvent;
  }
  if (hasTerminal && finishReason === undefined) finishReason = "stop";
  const stopReason = mapChatFinishReason(finishReason);
  const _providerStop = typeof finishReason === "string" ? finishReason : undefined;
  yield {
    type: "terminal",
    sequence_number: seq++,
    state: stopReason === "error" ? "failed" : "complete",
    ...(stopReason === undefined ? {} : { stop_reason: stopReason }),
    ...(_providerStop === undefined ? {} : { provider_stop_reason: _providerStop }),
    usage: usageFromProvider(rawUsage),
    ...(Object.keys(providerMetadata).length > 0 ? { provider_metadata: providerMetadata } : {}),
  } as CanonicalEvent;
}
