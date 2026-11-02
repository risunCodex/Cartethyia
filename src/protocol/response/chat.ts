/**
 * [OpenAI]-compatible /chat/completions response decoder: wire JSON/SSE → canonical events.
 */
import { canonicalTerminal } from "../codecs";
import { GatewayError } from "../gateway-error";
import { type CanonicalEvent, type CanonicalRequest } from "../canonical-model";
import { decodeSseEvents } from "../sse-decoder";
import { gatewayErrorFromStreamError } from "../stream-error-frames";
import { mergeResponsesUsage } from "./responses";
import { usageFromProvider, readReasoningText } from "../../providers/provider-usage";
import { createToolEmitLedger } from "../tool-identity";
import { ThinkSplitter, stripThinkingTags } from "../think-split";
import { DsmlToolCallParser, parseDsmlToolCalls } from "./dsml";
import {
  OmpToolCallMarkupParser,
  parseOmpToolCallMarkup,
  type OmpTextToolCall,
} from "./omp-tool-call-markup";


export function mapChatStopReason(
  reason: unknown,
): "stop" | "length" | "tool_use" | "content_filter" | undefined {
  if (reason === "stop") return "stop";
  if (reason === "length") return "length";
  if (reason === "tool_calls") return "tool_use";
  if (reason === "content_filter") return "content_filter";
  return undefined;
}

export function parseChatResponseToEvents(
  json: Record<string, unknown>,
  request: CanonicalRequest,
): CanonicalEvent[] {
  const id = (json["id"] as string) ?? "resp_chat";
  const model = (json["model"] as string) ?? request.model;
  const systemFingerprint =
    typeof json["system_fingerprint"] === "string" ? json["system_fingerprint"] : undefined;
  const events: CanonicalEvent[] = [
    {
      type: "response_start",
      sequence_number: 1,
      event_id: id,
      model,
      ...(systemFingerprint === undefined ? {} : { system_fingerprint: systemFingerprint }),
    },
  ];
  const choices = (json["choices"] as Array<Record<string, unknown>>) ?? [];
  const first = choices[0] as Record<string, unknown> | undefined;
  const message = first?.["message"] as Record<string, unknown> | undefined;
  const declaredToolNames = declaredToolNamesForRequest(request);
  const callableToolNames = callableToolNamesForRequest(request);
  let recoveredToolCalls = 0;
  if (message) {
    const reasoningRaw = readReasoningText(message);
    const reasoningMarkup =
      typeof reasoningRaw === "string" && (request.tools?.length ?? 0) > 0
        ? parseOmpToolCallMarkup(reasoningRaw, declaredToolNames)
        : undefined;
    // hy4-preview-f (and other buddy reasoning models) sometimes wraps its own
    // reasoning in `<think>…</think>` inside `reasoning_content`, which then
    // reaches the client as literal tag bytes. The field itself is the stream
    // for reasoning here, so the tags cannot carry structure — strip them.
    const reasoning =
      typeof reasoningRaw === "string"
        ? stripThinkingTags(reasoningMarkup?.text ?? reasoningRaw)
        : reasoningRaw;
    if (typeof reasoning === "string" && reasoning.length > 0) {
      events.push({
        type: "content_delta",
        sequence_number: events.length + 1,
        response_id: id,
        // `reasoning_content` is the readable reasoning stream (Responses
        // `reasoning_text`), not a summary — keep it in `payload` only.
        content: { kind: "reasoning", payload: reasoning },
      });
    }
    const content = message["content"] as string | null;
    const recoveredMarkup =
      typeof content === "string" && (request.tools?.length ?? 0) > 0
        ? parseOmpToolCallMarkup(content, declaredToolNames)
        : undefined;
    const contentWithoutMarkup = recoveredMarkup?.text ?? content;
    const recovered =
      typeof contentWithoutMarkup === "string"
        ? parseDsmlToolCalls(contentWithoutMarkup, declaredToolNames)
        : undefined;
    const visible = recovered === undefined ? contentWithoutMarkup : recovered.text;
    if (typeof visible === "string" && visible.includes("<think")) {
      const think = new ThinkSplitter();
      const split = think.push(visible);
      const rest = think.flush();
      const reasoning = `${split.reasoning}${rest.reasoning}`;
      const text = `${split.text}${rest.text}`;
      if (reasoning.length > 0) {
        events.push({
          type: "content_delta",
          sequence_number: events.length + 1,
          response_id: id,
          content: { kind: "reasoning", payload: null, summary: reasoning },
        });
      }
      if (text.length > 0) {
        events.push({
          type: "content_delta",
          sequence_number: events.length + 1,
          response_id: id,
          content: { kind: "text", text },
        });
      }
    } else if (visible) {
      events.push({
        type: "content_delta",
        sequence_number: events.length + 1,
        response_id: id,
        content: { kind: "text", text: visible },
      });
    }
    const refusal = message["refusal"];
    if (typeof refusal === "string" && refusal.length > 0) {
      events.push({
        type: "content_delta",
        sequence_number: events.length + 1,
        response_id: id,
        content: { kind: "refusal", text: refusal },
      });
    }
    const structuredCalls = message["tool_calls"];
    const hasStructuredCalls =
      Array.isArray(structuredCalls) &&
      structuredCalls.some((candidate) => {
        if (typeof candidate !== "object" || candidate === null) return false;
        const record = candidate as Record<string, unknown>;
        const fn =
          typeof record["function"] === "object" && record["function"] !== null
            ? (record["function"] as Record<string, unknown>)
            : undefined;
        const callId = typeof record["id"] === "string" && record["id"].length > 0;
        const name =
          typeof fn?.["name"] === "string" && fn["name"].length > 0
            ? fn["name"]
            : typeof record["name"] === "string"
              ? record["name"]
              : undefined;
        return callId && name !== undefined && name.length > 0;
      });
    // A request that declared no tools carries no allowlist to enforce, so a
    // recovered block is honoured as-is exactly as before; a request that did
    // declare them must never execute a name it did not offer.
    const recoveredCalls =
      declaredToolNames.size > 0
        ? (recovered?.calls ?? []).filter((call) => callableToolNames.has(call.name))
        : (recovered?.calls ?? []);
    const toolCalls = hasStructuredCalls
      ? structuredCalls
      : recoveredMarkup?.calls.some((call) => callableToolNames.has(call.name))
        ? recoveredMarkup.calls
            .filter((call) => callableToolNames.has(call.name))
            .map((call) => ({
              id: call.id,
              function: { name: call.name, arguments: call.arguments },
            }))
        : recoveredCalls;
    if (!hasStructuredCalls && recoveredMarkup !== undefined) {
      recoveredToolCalls = recoveredMarkup.calls.filter((call) =>
        callableToolNames.has(call.name),
      ).length;
    }
    for (const tc of toolCalls) {
      if (typeof tc !== "object" || tc === null) continue;
      const record = tc as Record<string, unknown>;
      const fn = typeof record["function"] === "object" && record["function"] !== null
        ? (record["function"] as Record<string, unknown>)
        : undefined;
      // Malformed tool calls (missing id/name) are dropped, not poisoned
      // into the ledger: an undefined id/name downstream breaks pairing and
      // surfaces as a confusing unknown-tool error instead of a clean skip.
      const callId = typeof record["id"] === "string" && record["id"].length > 0 ? record["id"] : undefined;
      const name = typeof fn?.["name"] === "string" && fn["name"].length > 0
        ? fn["name"]
        : typeof record["name"] === "string" ? record["name"] : undefined;
      const args = typeof fn?.["arguments"] === "string"
        ? fn["arguments"]
        : typeof record["arguments"] === "string" ? record["arguments"] : "{}";
      if (callId === undefined || name === undefined) continue;
      const itemId = callId;
      events.push({
        type: "tool_call_delta",
        sequence_number: events.length + 1,
        response_id: id,
        item_id: itemId,
        call_id: callId,
        name,
        arguments_delta: args,
      });
    }
    // Audio output (`modalities: ["audio"]`) rides on `message.audio`; carry it
    // as an extension part so the Chat encoder can re-emit the same object.
    const audio = message["audio"];
    if (audio !== null && typeof audio === "object") {
      events.push({
        type: "content_delta",
        sequence_number: events.length + 1,
        response_id: id,
        content: { kind: "extension", name: "audio", payload: audio },
      });
    }
  }
  const rawUsage = json["usage"] as Record<string, unknown> | undefined;
  const usageRecord = usageFromProvider(
    rawUsage
      ? {
          ...rawUsage,
          input_tokens: rawUsage["input_tokens"] ?? rawUsage["prompt_tokens"],
          output_tokens: rawUsage["output_tokens"] ?? rawUsage["completion_tokens"],
        }
      : undefined,
  );
  const providerStopReason = first?.["finish_reason"];
  const chatJsonStopReason = mapChatStopReason(providerStopReason);
  const chatJsonProviderStopReason =
    typeof providerStopReason === "string" ? providerStopReason : undefined;
  events.push(
    canonicalTerminal({
      sequenceNumber: events.length + 1,
      responseId: id,
      state: "complete",
      stopReason: recoveredToolCalls > 0 ? "tool_use" : chatJsonStopReason,
      providerStopReason: chatJsonProviderStopReason,
      usage: usageRecord,
    }),
  );
  return events;
}

export async function* decodeChatSseStream(
  body: ReadableStream<Uint8Array>,
  request: CanonicalRequest,
  signal?: AbortSignal,
): AsyncIterable<CanonicalEvent> {
  let seq = 1;
  let finishReason: unknown;
  let rawUsage: Record<string, unknown> | undefined;
  // Last seen tool-call id (and name) per wire index. OpenAI streams the id
  // (and name) only on the first fragment of each call; later fragments carry
  // just `function.arguments`. Without this memory every continuation fragment
  // becomes a separate phantom call downstream. A fragment that carries a
  // *different* name than the recorded call at its index starts a new call
  // (sequential index reuse) instead of merging into the old one. Bridges that
  // omit `index` on every fragment still have one signal left — the most
  // recent call — so that is the fallback before declaring a fragment orphaned.
  const lastToolIdByIndex = new Map<number, string>();
  const lastToolNameByIndex = new Map<number, string>();
  let lastSeenToolId: string | undefined;
  let lastSeenToolName: string | undefined;
  let structuredToolCallEmitted = false;
  const recoveredMarkupCalls: OmpTextToolCall[] = [];
  // Single emission ledger: one entry per logical call.
  const ledger = createToolEmitLedger();
  const think = new ThinkSplitter();
  // Separate splitter for the reasoning channel: `reasoning_content` is its own
  // stream, and interleaving it into the answer splitter would let a tag in one
  // channel swallow the other's text.
  const reasoningThink = new ThinkSplitter();
  const declaredToolNames = declaredToolNamesForRequest(request);
  const callableToolNames = callableToolNamesForRequest(request);
  const contentMarkup =
    (request.tools?.length ?? 0) > 0 ? new OmpToolCallMarkupParser(declaredToolNames) : undefined;
  const reasoningMarkup =
    (request.tools?.length ?? 0) > 0 ? new OmpToolCallMarkupParser(declaredToolNames) : undefined;
  const dsmlMarkup =
    (request.tools?.length ?? 0) > 0 ? new DsmlToolCallParser(declaredToolNames) : undefined;
  yield {
    type: "response_start",
    sequence_number: seq++,
    model: request.model,
  } as CanonicalEvent;
  for await (const sse of decodeSseEvents(body, { signal })) {
    const data = sse.data.trim();
    // [DONE] is the spec'd terminal marker: stop decoding without waiting
    // for TCP close. Waiting (continue) deadlocks gated bridges where the
    // close itself depends on our terminal event; anything after [DONE] is
    // malformed and ignored.
    if (data === "[DONE]") break;
    if (!data) continue;
    try {
      const json = JSON.parse(data) as Record<string, unknown>;
      // An explicit error envelope inside a 200 OK is an upstream failure that
      // arrived after the status line. Recording it only as a `failed` terminal
      // left the client with no code and telemetry with `unknown_error`, so the
      // frame is raised as a typed error like the Claude and Gemini decoders
      // already do. `{error: {...}}` is the documented shape; a top-level
      // `type: "error"` frame carries the error object itself.
      const streamError = gatewayErrorFromStreamError(
        json["error"] ?? (json["type"] === "error" ? json : undefined),
        "upstream returned an error frame",
      );
      if (streamError !== undefined) throw streamError;
      // Merge, don't overwrite: split-usage bridges (xAI pattern: prompt
      // tokens early, totals late) would otherwise lose prompt/cache counts.
      rawUsage = mergeResponsesUsage(
        rawUsage,
        json["usage"] as Record<string, unknown> | undefined,
      );
      const choices = (json["choices"] as Array<Record<string, unknown>>) ?? [];
      for (const choice of choices) {
        const delta = choice["delta"] as Record<string, unknown> | undefined;
        // Empty-string deltas are keepalive/placeholder frames some bridges
        // emit between real chunks. Forwarding them as content is not
        // cosmetic: downstream surface encoders open a block per content
        // event, so a run of empty text deltas interleaved with empty
        // reasoning deltas fragments one answer into alternating
        // text/thinking blocks.
        if (typeof delta?.["content"] === "string" && delta["content"].length > 0) {
          const raw = delta["content"] as string;
          const markup = contentMarkup?.push(raw);
          if (markup !== undefined) recoveredMarkupCalls.push(...markup.calls);
          const recovered = dsmlMarkup?.push(markup?.text ?? raw);
          const visible = recovered?.text ?? markup?.text ?? raw;
          const split = think.push(visible);
          if (split.reasoning.length > 0) {
            yield {
              type: "content_delta",
              sequence_number: seq++,
              content: { kind: "reasoning", payload: null, summary: split.reasoning },
            } as CanonicalEvent;
          }
          if (split.text.length > 0) {
            yield {
              type: "content_delta",
              sequence_number: seq++,
              content: { kind: "text", text: split.text },
            } as CanonicalEvent;
          }
          if (recovered !== undefined) {
            for (const call of recovered.calls) {
              yield {
                type: "tool_call_delta",
                sequence_number: seq++,
                call_id: call.id,
                name: call.name,
                arguments_delta: call.arguments,
              } as CanonicalEvent;
            }
          }
        }
        const reasoningRaw = delta ? readReasoningText(delta) : undefined;
        const reasoningMarkupResult =
          typeof reasoningRaw === "string" ? reasoningMarkup?.push(reasoningRaw) : undefined;
        // Strip stray `<think>` tags the upstream double-wrapped inside its own
        // reasoning stream (buddy's hy4-preview-f leaks them per-delta). This
        // is the splitter's job, not `stripThinkingTags`'s: a stateless strip
        // cannot see a tag split across two deltas, so `"<thi"` was emitted
        // verbatim and only the following `</think>` removed.
        const reasoningSplit =
          typeof reasoningRaw === "string"
            ? reasoningThink.push(reasoningMarkupResult?.text ?? reasoningRaw)
            : undefined;
        // Both sides are reasoning. The splitter routes text outside a
        // `<think>` span to its `.text` side, but this field is the reasoning
        // stream in its entirety: untagged prose here is still thought, not
        // answer. Taking only `.reasoning` dropped every un-tagged delta.
        const reasoningText =
          reasoningSplit === undefined
            ? undefined
            : `${reasoningSplit.reasoning}${reasoningSplit.text}`;
        if (typeof reasoningText === "string" && reasoningText.length > 0) {
          yield {
            type: "content_delta",
            sequence_number: seq++,
            content: { kind: "reasoning", payload: null, summary: reasoningText },
          } as CanonicalEvent;
        }
        const calls = (delta?.["tool_calls"] as Array<Record<string, unknown>>) ?? [];
        for (const call of calls) {
          const fn = call["function"] as Record<string, unknown> | undefined;
          // A missing or non-integer index carries no routing information:
          // only a validated integer may join fragments, otherwise fragments
          // would collapse onto call 0 (some bridges omit `index` or send
          // floats). `trackToolCall` downstream pins unknown indexes by id.
          const rawIndex = call["index"];
          const index =
            typeof rawIndex === "number" && Number.isInteger(rawIndex) && rawIndex >= 0
              ? rawIndex
              : undefined;
          const rawId = call["id"];
          const realId = typeof rawId === "string" && rawId.length > 0 ? rawId : undefined;
          const rawName = fn?.["name"];
          const fragName = typeof rawName === "string" && rawName.length > 0 ? rawName : undefined;
          // Name compatibility decides whether an id-less fragment continues
          // the call already known at its index (or, when the bridge omits
          // `index` entirely, the most recent call) or starts a new one.
          const indexName = index === undefined ? undefined : lastToolNameByIndex.get(index);
          const indexId = index === undefined ? undefined : lastToolIdByIndex.get(index);
          const inheritable =
            fragName === undefined ||
            (index === undefined ? lastSeenToolName : indexName) === undefined ||
            fragName === (index === undefined ? lastSeenToolName : indexName);
          let id: string;
          // Index emitted downstream only when the wire index genuinely
          // identifies this call (an explicit id at that index). Inherited
          // and orphaned fragments omit it so the tracker pins them by id
          // memory; re-emitting the shared wire index would overwrite the
          // first call's slot in the index-keyed materializer.
          let emitIndex: number | undefined;
          let establishedNew = false;

          if (realId !== undefined) {
            id = realId;
            emitIndex = index;
            establishedNew = true;
          } else if (index !== undefined && indexId !== undefined && inheritable) {
            id = indexId;
          } else if (index === undefined && lastSeenToolId !== undefined && inheritable) {
            id = lastSeenToolId;
          } else {
            // Same index with a different (or first-seen) name, or no identity
            // to inherit: a new call. Split instead of concatenating two JSON
            id = ledger.nextOrphanId(index === undefined ? "call" : `call-${index}-frag`);
            establishedNew = true;
          }

          lastSeenToolId = id;
          if (fragName !== undefined) lastSeenToolName = fragName;
          if (index !== undefined) {
            // A continuation must not erase the name recorded for its call;
            // only a newly established call (or a fragment that restates the
            // name) rewrites the index memory.
            if (establishedNew) lastToolIdByIndex.set(index, id);
            if (fragName !== undefined) lastToolNameByIndex.set(index, fragName);
            else if (establishedNew) lastToolNameByIndex.delete(index);
          }
          const rawArgs = fn?.["arguments"];
          const args = typeof rawArgs === "string" ? rawArgs : "";
          // Only a *second identity* carrying the same name and full arguments
          // is a duplicate definition. A repeat of the same id is a
          // continuation fragment and must always yield its delta.
          const duplicate =
            establishedNew &&
            fragName !== undefined &&
            ledger.isDuplicateDefinition(id, fragName, args);
          if (!duplicate) {
            if (establishedNew) ledger.claimFirstEmission(id, fragName, args);
            structuredToolCallEmitted = true;
            yield {
              type: "tool_call_delta",
              sequence_number: seq++,
              call_id: id,
              ...(emitIndex === undefined ? {} : { index: emitIndex }),
              ...(fragName === undefined ? {} : { name: fragName }),
              arguments_delta: args,
            } as CanonicalEvent;
          }
        }
        const audioDelta = delta?.["audio"];
        if (audioDelta !== null && typeof audioDelta === "object") {
          yield {
            type: "content_delta",
            sequence_number: seq++,
            content: { kind: "extension", name: "audio", payload: audioDelta },
          } as CanonicalEvent;
        }
        finishReason = choice["finish_reason"] ?? finishReason;
      }
    } catch (error: unknown) {
      // A typed upstream error is not a decode failure — rethrow it so the
      // classified code (quota, overload, context length) survives.
      if (error instanceof GatewayError) throw error;
      // Corrupt upstream bytes, not a client mistake: `invalid_request` made
      // the client retry an identical request against the same broken stream.
      throw new GatewayError(
        "platform_unavailable",
        502,
        error instanceof Error
          ? `Malformed SSE event: ${error.message} (request {requestId}). The upstream sent something we can't read — retry 🌙`
          : `Malformed SSE event (request {requestId}). The upstream sent something we can't read — retry 🌙`,
        {},
        "upstream",
      );
    }
  }
  const contentMarkupTail = contentMarkup?.flush();
  if (contentMarkupTail !== undefined) {
    recoveredMarkupCalls.push(...contentMarkupTail.calls);
    if (contentMarkupTail.text.length > 0) {
      const split = think.push(contentMarkupTail.text);
      if (split.reasoning.length > 0) {
        yield {
          type: "content_delta",
          sequence_number: seq++,
          content: { kind: "reasoning", payload: null, summary: split.reasoning },
        } as CanonicalEvent;
      }
      if (split.text.length > 0) {
        yield {
          type: "content_delta",
          sequence_number: seq++,
          content: { kind: "text", text: split.text },
        } as CanonicalEvent;
      }
    }
  }
  const dsmlMarkupTail = dsmlMarkup?.flush();
  if (dsmlMarkupTail !== undefined) {
    if (dsmlMarkupTail.text.length > 0) {
      const split = think.push(dsmlMarkupTail.text);
      if (split.reasoning.length > 0) {
        yield {
          type: "content_delta",
          sequence_number: seq++,
          content: { kind: "reasoning", payload: null, summary: split.reasoning },
        } as CanonicalEvent;
      }
      if (split.text.length > 0) {
        yield {
          type: "content_delta",
          sequence_number: seq++,
          content: { kind: "text", text: split.text },
        } as CanonicalEvent;
      }
    }
    for (const call of dsmlMarkupTail.calls) recoveredMarkupCalls.push(call);
  }
  const reasoningMarkupTail = reasoningMarkup?.flush();
  if (reasoningMarkupTail?.text) {
    const split = reasoningThink.push(reasoningMarkupTail.text);
    // Both sides are reasoning: see the per-delta branch above.
    const reasoningText = `${split.reasoning}${split.text}`;
    if (reasoningText.length > 0) {
      yield {
        type: "content_delta",
        sequence_number: seq++,
        content: { kind: "reasoning", payload: null, summary: reasoningText },
      } as CanonicalEvent;
    }
  }
  // Release anything the reasoning splitter held for a tag that never
  // completed, before `think.flush()` and the terminal.
  const reasoningRest = reasoningThink.flush();
  const reasoningTail = `${reasoningRest.reasoning}${reasoningRest.text}`;
  if (reasoningTail.length > 0) {
    yield {
      type: "content_delta",
      sequence_number: seq++,
      content: { kind: "reasoning", payload: null, summary: reasoningTail },
    } as CanonicalEvent;
  }
  const rest = think.flush();
  if (rest.reasoning.length > 0) {
    yield {
      type: "content_delta",
      sequence_number: seq++,
      content: { kind: "reasoning", payload: null, summary: rest.reasoning },
    } as CanonicalEvent;
  }
  if (rest.text.length > 0) {
    yield {
      type: "content_delta",
      sequence_number: seq++,
      content: { kind: "text", text: rest.text },
    } as CanonicalEvent;
  }
  let recoveredMarkupToolCallsEmitted = 0;
  if (!structuredToolCallEmitted) {
    for (const call of recoveredMarkupCalls) {
      if (!callableToolNames.has(call.name)) continue;
      yield {
        type: "tool_call_delta",
        sequence_number: seq++,
        call_id: call.id,
        name: call.name,
        arguments_delta: call.arguments,
      } as CanonicalEvent;
      recoveredMarkupToolCallsEmitted += 1;
    }
  }
  const chatStopReason = mapChatStopReason(finishReason);
  const chatProviderStopReason =
    typeof finishReason === "string" ? finishReason : undefined;
  // A stream that ends without any finish_reason was truncated (TCP cut,
  // upstream died mid-body). It must never bill as a success: report failed
  // so telemetry, usage, and health all record the failure.
  const truncated = finishReason === undefined;
  yield canonicalTerminal({
    sequenceNumber: seq++,
    state: signal?.aborted
      ? "aborted"
      : finishReason === "error" || finishReason === "failed" || truncated
        ? "failed"
        : "complete",
    // An upstream that ends without a verdict must not render as a clean
    // `stop`. `chatFinishReason(undefined)` falls back to `stop`, so the client
    // saw a completed turn while telemetry recorded a 502 upstream transport
    // failure — the failure this terminal already carries was invisible to it.
    stopReason:
      truncated && signal?.aborted !== true
        ? "error"
        : !structuredToolCallEmitted && recoveredMarkupToolCallsEmitted > 0
          ? "tool_use"
          : chatStopReason,
    providerStopReason: chatProviderStopReason,
    usage: usageFromProvider(rawUsage),
  });
}

function declaredToolNamesForRequest(request: CanonicalRequest): ReadonlySet<string> {
  return new Set((request.tools ?? []).map((tool) => tool.name));
}

function callableToolNamesForRequest(request: CanonicalRequest): ReadonlySet<string> {
  const declared = declaredToolNamesForRequest(request);
  const choice = request.tool_choice;
  if (choice === "none") return new Set();
  if (choice === undefined || typeof choice === "string") return declared;
  if (choice.type === "tool" || choice.type === "custom") {
    return declared.has(choice.name) ? new Set([choice.name]) : new Set();
  }
  return new Set(choice.names.filter((name) => declared.has(name)));
}
