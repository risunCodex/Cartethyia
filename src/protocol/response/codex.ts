/**
 * Codex Responses → canonical events (non-stream path) and Codex streaming
 * frame processor. Also owns the shared reasoning-item → `content_delta`
 * helper and the `mapCodexStopReason` decision table that both the
 * non-stream converter and the frame processor depend on.
 *
 * Includes the whitespace-loop safety net that mirrors reference
 * `CODEX_WHITESPACE_TOOL_CALL_ARGUMENT_DELTA_EVENT_LIMIT` — a model stuck
 * emitting only whitespace tool-call-argument deltas would otherwise hang
 * the dispatch loop forever.
 */
import { GatewayError } from "../gateway-error";
import { type CanonicalEvent, type CanonicalRequest, type CanonicalStopReason } from "../canonical-model";
import { usageFromProvider, readResponsesReasoningDelta } from '../../providers/provider-usage';
import { canonicalTerminal, decodeCodexToolCallId, isRecord, readOutputIndex } from '../codecs';
import { gatewayErrorFromStreamError } from '../stream-error-frames';

function mapCodexStopReason(
  status: unknown,
  hasToolCall: boolean,
  endTurn?: unknown,
): CanonicalStopReason | undefined {
  if (typeof status !== "string") return undefined;
  // `in_progress`/`queued` map to `stop` so early snapshots don't stall the
  // canonical terminal.
  if (status === "in_progress" || status === "queued") return "stop";
  if (status === "completed") {
    if (hasToolCall) {
      // For completed tool-use with `end_turn:false`, callers escalate to
      // `pause_turn` after this function; tool_use takes precedence here.
      return "tool_use";
    }
    if (endTurn === false) return "pause_turn" as CanonicalStopReason;
    return "stop";
  }
  if (status === "incomplete") {
    // An incomplete stream that produced a tool call is a tool-use stop, not a
    // length stop; the caller decides executability. A truncated non-tool
    // stream is `length`.
    return hasToolCall ? "tool_use" : "length";
  }
  if (status === "failed" || status === "cancelled") return "error";
  return undefined;
}

function reasoningSummary(item: Record<string, unknown>): string | undefined {
  const summary = item["summary"];
  if (typeof summary === "string") return summary;
  if (Array.isArray(summary)) {
    const texts: string[] = [];
    for (const part of summary) {
      if (typeof part === "string") texts.push(part);
      else if (
        part &&
        typeof part === "object" &&
        "text" in part &&
        typeof part.text === "string"
      ) {
        texts.push(part.text);
      }
    }
    return texts.filter((t) => t.length > 0).join("\n\n") || undefined;
  }
  return typeof item["content"] === "string" ? item["content"] : undefined;
}

export function reasoningEvent(
  item: Record<string, unknown>,
  sequence_number: number,
  output_index?: number,
): CanonicalEvent {
  const summary = reasoningSummary(item);
  const encrypted = item["encrypted_content"];
  return {
    type: "content_delta",
    sequence_number,
    ...(typeof item["id"] === "string" ? { item_id: item["id"] } : {}),
    ...(output_index === undefined ? {} : { output_index }),
    content: {
      kind: "reasoning",
      // A summary is not a reasoning_text payload. Putting it in both fields
      // made the Responses encoder emit the same summary again as readable
      // content, where adjacent parts lost their summary_index separators.
      payload: null,
      ...(summary === undefined ? {} : { summary }),
      ...(typeof encrypted === "string"
        ? {
            encrypted_content: encrypted,
            ...(typeof item["id"] === "string" ? { item_id: item["id"] } : {}),
          }
        : {}),
      ...(summary === undefined && typeof encrypted === "string"
        ? { opaque: true as const }
        : {}),
    },
  };
}

export function parseCodexResponsesJsonToEvents(
  json: Record<string, unknown>,
  request: CanonicalRequest,
): CanonicalEvent[] {
  const id = (json["id"] as string | undefined) ?? "resp_codex";
  const model = (json["model"] as string | undefined) ?? request.model;
  const events: CanonicalEvent[] = [
    { type: "response_start", sequence_number: 1, event_id: id, model },
  ];
  let seq = 2;

  const output =
    (json["output"] as Array<Record<string, unknown>> | undefined) ?? [];
  for (const [outputIndex, item] of output.entries()) {
    const type = item["type"] as string | undefined;
    if (type === "message") {
      const content = item["content"] as
        | Array<Record<string, unknown>>
        | undefined;
      if (content !== undefined) {
        for (const block of content) {
          const bType = block["type"] as string | undefined;
          if (bType === "output_text" && typeof block["text"] === "string") {
            events.push({
              type: "content_delta",
              sequence_number: seq++,
              content: { kind: "text", text: block["text"] as string },
            });
            if (
              request.provider_options?.capture_web_search_citations === true &&
              Array.isArray(block["annotations"]) &&
              block["annotations"].length > 0
            ) {
              events.push({
                type: "content_delta",
                sequence_number: seq++,
                content: {
                  kind: "extension",
                  name: "web_search_citations",
                  payload: {
                    annotations: block["annotations"],
                    text: block["text"],
                  },
                },
              });
            }
          } else if (
            bType === "refusal" &&
            typeof block["refusal"] === "string"
          ) {
            events.push({
              type: "content_delta",
              sequence_number: seq++,
              content: { kind: "text", text: block["refusal"] as string },
            });
          }
        }
      }
    } else if (type === "reasoning") {
      events.push(reasoningEvent(item, seq++, outputIndex));
    } else if (type === "function_call") {
      const rawCallId =
        (item["call_id"] as string | undefined) ??
        (item["id"] as string | undefined) ??
        "call";
      const decodedCallId = decodeCodexToolCallId(rawCallId);
      events.push({
        type: "tool_call_delta",
        sequence_number: seq++,
        call_id: decodedCallId,
        name: (item["name"] as string | undefined) ?? undefined,
        arguments_delta: (item["arguments"] as string | undefined) ?? "",
      } as CanonicalEvent);
    } else if (type === "custom_tool_call") {
      const rawCallId =
        (item["call_id"] as string | undefined) ??
        (item["id"] as string | undefined) ??
        "call";
      const decodedCallId = decodeCodexToolCallId(rawCallId);
      const input = (item["input"] as string | undefined) ?? "";
      events.push({
        type: "tool_call_delta",
        sequence_number: seq++,
        call_id: decodedCallId,
        name: (item["name"] as string | undefined) ?? undefined,
        arguments_delta: input,
      } as CanonicalEvent);
    } else if (type === "computer_call") {
      const rawCallId =
        (item["call_id"] as string | undefined) ??
        (item["id"] as string | undefined) ??
        "call";
      const decodedCallId = decodeCodexToolCallId(rawCallId);
      events.push({
        type: "tool_call_delta",
        sequence_number: seq++,
        call_id: decodedCallId,
        name: "computer",
        arguments_delta: JSON.stringify((item["action"] as unknown) ?? {}),
      } as CanonicalEvent);
    }
  }
  // Fallback for chat-like shape (choices).
  if (output.length === 0) {
    const choices = json["choices"] as
      | Array<Record<string, unknown>>
      | undefined;
    if (choices !== undefined && choices.length > 0) {
      const first = choices[0];
      if (first !== undefined) {
        const msg = first["message"] as Record<string, unknown> | undefined;
        if (
          msg !== undefined &&
          typeof msg["content"] === "string" &&
          msg["content"].length > 0
        ) {
          events.push({
            type: "content_delta",
            sequence_number: seq++,
            content: { kind: "text", text: msg["content"] },
          });
        }
      }
    }
  }

  const usage = usageFromProvider(json["usage"]);
  const status =
    typeof json["status"] === "string" ? json["status"] : undefined;
  const hasToolCall = output.some(
    (item) =>
      item["type"] === "function_call" ||
      item["type"] === "custom_tool_call" ||
      item["type"] === "computer_call",
  );
  const endTurn =
    (json["end_turn"] as boolean | undefined) ??
    ((json["response"] as Record<string, unknown> | undefined)?.["end_turn"] as
      | boolean
      | undefined);
  // An incomplete response that produced a tool call is always a tool-use
  // stop; every other incomplete response is a length stop. There is no
  // separate executability gate — scanning tool arguments for parseable JSON
  // returns `tool_use` on both outcomes, so the scan and the
  // `incomplete_details.reason` read could not change the result.
  const stopReason = mapCodexStopReason(status, hasToolCall, endTurn);
  let finalStopReason = stopReason;
  if (endTurn === false && stopReason === "stop") {
    finalStopReason = "pause_turn" as CanonicalStopReason;
  }
  events.push(
    canonicalTerminal({
      sequenceNumber: seq++,
      state:
        status === "failed"
          ? "failed"
          : status === "cancelled"
            ? "aborted"
            : "complete",
      stopReason: finalStopReason,
      providerStopReason: status,
      stopDetails: endTurn === false ? { type: "pause_turn" } : undefined,
      usage,
    }),
  );
  return events;
}

type OpenItemEntry = {
  item: Record<string, unknown>;
  blockIndex: number;
  outputIndex?: number | undefined;
  itemId?: string | undefined;
  /** True once an arguments/input delta frame was seen for this item. */
  argDeltasSeen?: boolean;
};

/** Shared incremental parser for a single `response.*` frame. */
export class CodexStreamFrameProcessor {
  #seq: number;
  #captureWebSearchCitations: boolean;
  hasToolCall = false;
  terminalStatus: string | undefined;
  terminalUsage: Record<string, unknown> | undefined;
  terminalEndTurn: boolean | undefined;
  terminalIncompleteDetails: unknown | undefined;
  readonly #reasoningDeltaIds = new Set<string>();
  // output_index routing + `output_item.added` registration.
  readonly #openItems = new Map<string, OpenItemEntry>();
  readonly #openItemsByOutputIndex = new Map<number, OpenItemEntry>();
  // Argument deltas seen for calls that never registered an `output_item.added`
  // entry; correlates the done-frame fallback with streamed deltas.
  readonly #orphanArgDeltaKeys = new Set<string>();

  // Whitespace-loop guard: a model stuck emitting only whitespace tool-call
  // argument deltas would otherwise hang the dispatch loop forever.
  readonly #whitespaceDeltaTracking = new Map<
    string,
    { count: number; chars: number }
  >();
  static readonly WHITESPACE_DELTA_EVENT_LIMIT = 256;
  static readonly WHITESPACE_DELTA_CHAR_LIMIT = 16 * 1024;
  constructor(startSeq: number, captureWebSearchCitations = false) {
    this.#seq = startSeq;
    this.#captureWebSearchCitations = captureWebSearchCitations;
  }

  /**
   * Resolves which tool call a stream delta belongs to.
   *
   * `response.function_call_arguments.delta` / `custom_tool_call_input.delta`
   * frames carry `item_id` and `output_index`, not `call_id` — so defaulting
   * to a literal would make every parallel call share one id and merge their
   * arguments into corrupt JSON. Look the call up in the items registered by
   * `response.output_item.added` instead, and prefer the item id (a unique
   * handle) over a shared literal when the upstream never names the call id.
   */
  #resolveToolIdentity(json: Record<string, unknown>): {
    callId: string;
    name: string | undefined;
    entry: OpenItemEntry | undefined;
  } {
    const itemId =
      typeof json["item_id"] === "string" ? (json["item_id"] as string) : undefined;
    const outputIndex = readOutputIndex(json);
    const entry =
      (itemId === undefined ? undefined : this.#openItems.get(itemId)) ??
      (outputIndex === undefined
        ? undefined
        : this.#openItemsByOutputIndex.get(outputIndex));
    const frameName =
      typeof json["name"] === "string" && (json["name"] as string).length > 0
        ? (json["name"] as string)
        : undefined;
    const entryName = entry === undefined ? undefined : entry.item["name"];
    const name =
      frameName ??
      (typeof entryName === "string" && entryName.length > 0 ? entryName : undefined);
    const rawCallId =
      typeof json["call_id"] === "string" ? (json["call_id"] as string) : undefined;
    if (rawCallId !== undefined)
      return { callId: decodeCodexToolCallId(rawCallId), name, entry };
    const entryCallId = entry === undefined ? undefined : entry.item["call_id"];
    if (typeof entryCallId === "string")
      return { callId: decodeCodexToolCallId(entryCallId), name, entry };
    if (itemId !== undefined) return { callId: itemId, name, entry };
    if (entry?.itemId !== undefined) return { callId: entry.itemId, name, entry };
    if (outputIndex !== undefined) return { callId: `idx_${outputIndex}`, name, entry };
    return { callId: "call", name, entry };
  }

  /**
   * Trips a hard error once a tool call has emitted only whitespace-only
   * argument deltas past the reference's event/char thresholds — a
   * pathological model loop that would otherwise never reach `.done`.
   */
  #checkWhitespaceLoopGuard(key: string, delta: string): void {
    if (delta.trim().length > 0) {
      this.#whitespaceDeltaTracking.delete(key);
      return;
    }
    const prev = this.#whitespaceDeltaTracking.get(key) ?? {
      count: 0,
      chars: 0,
    };
    const next = { count: prev.count + 1, chars: prev.chars + delta.length };
    this.#whitespaceDeltaTracking.set(key, next);
    if (
      next.count > CodexStreamFrameProcessor.WHITESPACE_DELTA_EVENT_LIMIT ||
      next.chars > CodexStreamFrameProcessor.WHITESPACE_DELTA_CHAR_LIMIT
    ) {
      throw new GatewayError(
        "tool_call_loop_detected",
        502,
        "Codex whitespace-loop guard tripped (request {requestId}): tool call emitted only whitespace argument deltas past the safety threshold. Caught in a loop — breaking the cycle 🔁",
        { call_key: key, event_count: next.count, char_count: next.chars },
      );
    }
  }

  /**
   * Key identifying one call's argument stream across delta/done frames.
   * Delta and done frames for the same item share `item_id` (or the
   * `output_index` when the id is absent), which correlates the
   * complete-arguments fallback below with deltas already streamed.
   */
  #argumentStreamKey(
    itemId: string | undefined,
    outputIndex: number | undefined,
    callId: string,
  ): string {
    return itemId ?? (outputIndex !== undefined ? `idx_${outputIndex}` : callId);
  }

  /** Records that argument deltas were seen for a call. */
  #noteArgumentDeltas(entry: OpenItemEntry | undefined, key: string): void {
    if (entry !== undefined) {
      entry.argDeltasSeen = true;
    } else {
      this.#orphanArgDeltaKeys.add(key);
    }
  }

  /** True when any argument delta was already seen for this call. */
  #hasArgumentDeltas(entry: OpenItemEntry | undefined, key: string): boolean {
    if (entry !== undefined) return entry.argDeltasSeen === true;
    return this.#orphanArgDeltaKeys.has(key);
  }

  /** Returns true once a frame carrying the terminal status/type has been seen. */
  get isDone(): boolean {
    return this.terminalStatus !== undefined;
  }

  /** Processes one parsed `response.*` frame, returning zero or more canonical events. */
  process(json: Record<string, unknown>): CanonicalEvent[] {
    const events: CanonicalEvent[] = [];
    const t = json["type"] as string | undefined;
    if (t === "response.output_item.added") {
      const item = json["item"] as Record<string, unknown> | undefined;
      const outputIndex = readOutputIndex(json);
      const itemId =
        item !== undefined && typeof item["id"] === "string"
          ? (item["id"] as string)
          : undefined;
      const entry: OpenItemEntry = {
        item: item ?? {},
        blockIndex: this.#seq,
        outputIndex,
        itemId,
      };
      if (itemId !== undefined) this.#openItems.set(itemId, entry);
      if (outputIndex !== undefined)
        this.#openItemsByOutputIndex.set(outputIndex, entry);
      // `function_call` items carry no state this decoder needs at `added`
      // time; the arguments arrive through the `.delta`/`.done` events below.
    } else if (
      t === "response.output_text.delta" &&
      typeof json["delta"] === "string" &&
      json["delta"].length > 0
    ) {
      events.push({
        type: "content_delta",
        sequence_number: this.#seq++,
        content: { kind: "text", text: json["delta"] as string },
      } as CanonicalEvent);
    } else if (
      t === "response.refusal.delta" &&
      typeof json["delta"] === "string" &&
      json["delta"].length > 0
    ) {
      events.push({
        type: "content_delta",
        sequence_number: this.#seq++,
        content: { kind: "text", text: json["delta"] as string },
      } as CanonicalEvent);
    } else if (
      t === "response.function_call_arguments.delta" &&
      typeof json["delta"] === "string"
    ) {
      const { callId, name, entry } = this.#resolveToolIdentity(json);
      const itemId =
        typeof json["item_id"] === "string"
          ? (json["item_id"] as string)
          : undefined;
      const key = itemId ?? callId;
      this.#checkWhitespaceLoopGuard(key, json["delta"] as string);
      events.push({
        type: "tool_call_delta",
        sequence_number: this.#seq++,
        call_id: callId,
        name,
        arguments_delta: json["delta"] as string,
      } as CanonicalEvent);
      this.#noteArgumentDeltas(
        entry,
        this.#argumentStreamKey(itemId, readOutputIndex(json), callId),
      );
      this.hasToolCall = true;
    } else if (
      t === "response.custom_tool_call_input.delta" &&
      typeof json["delta"] === "string"
    ) {
      const { callId, name, entry } = this.#resolveToolIdentity(json);
      const itemId =
        typeof json["item_id"] === "string"
          ? (json["item_id"] as string)
          : undefined;

      events.push({
        type: "tool_call_delta",
        sequence_number: this.#seq++,
        call_id: callId,
        name,
        arguments_delta: json["delta"] as string,
      } as CanonicalEvent);
      this.#noteArgumentDeltas(
        entry,
        this.#argumentStreamKey(itemId, readOutputIndex(json), callId),
      );
      this.hasToolCall = true;
    } else if (
      t === "response.reasoning_summary_text.delta" &&
      typeof json["delta"] === "string"
    ) {
      const summary = readResponsesReasoningDelta(json);
      if (summary !== undefined) {
        const summaryIndex =
          typeof json["summary_index"] === "number" && Number.isInteger(json["summary_index"])
            ? json["summary_index"]
            : 0;
        events.push({
          type: "content_delta",
          sequence_number: this.#seq++,
          ...(typeof json["item_id"] === "string" ? { item_id: json["item_id"] } : {}),
          ...(typeof json["output_index"] === "number"
            ? { output_index: json["output_index"] }
            : {}),
          content: {
            kind: "reasoning",
            payload: null,
            summary,
            summary_index: summaryIndex,
          },
        });
        const reasoningItemId =
          typeof json["item_id"] === "string" ? json["item_id"] : undefined;
        if (reasoningItemId !== undefined)
          this.#reasoningDeltaIds.add(reasoningItemId);
      }
    } else if (
      t === "response.reasoning_text.delta" &&
      typeof json["delta"] === "string"
    ) {
      events.push({
        type: "content_delta",
        sequence_number: this.#seq++,
        ...(typeof json["item_id"] === "string" ? { item_id: json["item_id"] } : {}),
        ...(typeof json["output_index"] === "number"
          ? { output_index: json["output_index"] }
          : {}),
        content: {
          kind: "reasoning",
          payload: json["delta"],
        },
      });
    } else if (t === "response.function_call_arguments.done") {
      // The arguments normally arrive as `.delta` frames above; an upstream
      // that skips them carries the complete string only here, so emit it
      // when nothing was streamed — otherwise the call vanishes while the
      // terminal still reports `tool_use`.
      this.hasToolCall = true;
      const { callId, name, entry } = this.#resolveToolIdentity(json);
      const itemId =
        typeof json["item_id"] === "string"
          ? (json["item_id"] as string)
          : undefined;
      const key = this.#argumentStreamKey(itemId, readOutputIndex(json), callId);
      if (!this.#hasArgumentDeltas(entry, key)) {
        const args = json["arguments"];
        events.push({
          type: "tool_call_delta",
          sequence_number: this.#seq++,
          call_id: callId,
          name,
          arguments_delta: typeof args === "string" ? args : "",
        } as CanonicalEvent);
      }
      this.#noteArgumentDeltas(entry, key);
    } else if (t === "response.custom_tool_call_input.done") {
      // As above: the input normally arrives as deltas, so `.done` only
      // completes it — unless no delta was ever seen.
      this.hasToolCall = true;
      const { callId, name, entry } = this.#resolveToolIdentity(json);
      const itemId =
        typeof json["item_id"] === "string"
          ? (json["item_id"] as string)
          : undefined;
      const key = this.#argumentStreamKey(itemId, readOutputIndex(json), callId);
      if (!this.#hasArgumentDeltas(entry, key)) {
        const input = json["input"];
        events.push({
          type: "tool_call_delta",
          sequence_number: this.#seq++,
          call_id: callId,
          name,
          arguments_delta: typeof input === "string" ? input : "",
        } as CanonicalEvent);
      }
      this.#noteArgumentDeltas(entry, key);
    } else if (t === "response.output_item.done") {
      const item = json["item"];
      if (item && typeof item === "object") {
        const outputItem = item as Record<string, unknown>;
        const outputItemId =
          typeof outputItem["id"] === "string" ? outputItem["id"] : undefined;
        const outputIndex = readOutputIndex(json);
        const encrypted = outputItem["encrypted_content"];
        if (
          this.#captureWebSearchCitations &&
          outputItem["type"] === "message" &&
          Array.isArray(outputItem["content"])
        ) {
          const annotations = outputItem.content.flatMap((block) =>
            block &&
            typeof block === "object" &&
            !Array.isArray(block) &&
            Array.isArray((block as Record<string, unknown>)["annotations"])
              ? ((block as Record<string, unknown>)["annotations"] as unknown[])
              : [],
          );
          const text = outputItem.content
            .flatMap((block) =>
              block &&
              typeof block === "object" &&
              !Array.isArray(block) &&
              (block as Record<string, unknown>)["type"] === "output_text" &&
              typeof (block as Record<string, unknown>)["text"] === "string"
                ? [(block as Record<string, unknown>)["text"] as string]
                : [],
            )
            .join("");
          if (annotations.length > 0) {
            events.push({
              type: "content_delta",
              sequence_number: this.#seq++,
              content: {
                kind: "extension",
                name: "web_search_citations",
                payload: { annotations, text },
              },
            });
          }
        }
        if (outputItem["type"] === "reasoning") {
          const summaryAlreadyStreamed =
            outputItemId !== undefined && this.#reasoningDeltaIds.has(outputItemId);
          if (typeof encrypted === "string" && summaryAlreadyStreamed) {
            events.push(
              reasoningEvent(
                { id: outputItemId, encrypted_content: encrypted },
                this.#seq++,
                outputIndex,
              ),
            );
          } else if (!summaryAlreadyStreamed) {
            events.push(reasoningEvent(outputItem, this.#seq++, outputIndex));
          }
        }
        if (
          outputItem["type"] === "function_call" ||
          outputItem["type"] === "custom_tool_call" ||
          outputItem["type"] === "computer_call"
        ) {
          this.hasToolCall = true;
          // Upstreams that skip every argument frame deliver the complete call
          // only on this item; without it the terminal still reports `tool_use`
          // while no `tool_use` block ever reaches the client.
          const entry =
            (outputItemId === undefined
              ? undefined
              : this.#openItems.get(outputItemId)) ??
            (outputIndex === undefined
              ? undefined
              : this.#openItemsByOutputIndex.get(outputIndex));
          const rawCallId =
            typeof outputItem["call_id"] === "string"
              ? (outputItem["call_id"] as string)
              : outputItemId;
          const callId =
            rawCallId === undefined ? "call" : decodeCodexToolCallId(rawCallId);
          const itemName = outputItem["name"];
          const name =
            outputItem["type"] === "computer_call"
              ? "computer"
              : typeof itemName === "string" && itemName.length > 0
                ? itemName
                : undefined;
          const args =
            outputItem["type"] === "function_call"
              ? outputItem["arguments"]
              : outputItem["type"] === "custom_tool_call"
                ? outputItem["input"]
                : JSON.stringify(outputItem["action"] ?? {});
          const key = this.#argumentStreamKey(outputItemId, outputIndex, callId);
          if (!this.#hasArgumentDeltas(entry, key)) {
            events.push({
              type: "tool_call_delta",
              sequence_number: this.#seq++,
              call_id: callId,
              name,
              arguments_delta: typeof args === "string" ? args : "",
            } as CanonicalEvent);
          }
          this.#noteArgumentDeltas(entry, key);
        }
        // Every completed item unregisters its routing entries, whatever its
        // type; the three call kinds differ from the rest only in `hasToolCall`.
        if (outputItemId !== undefined) this.#openItems.delete(outputItemId);
        if (outputIndex !== undefined)
          this.#openItemsByOutputIndex.delete(outputIndex);
      }
    } else if (
      t === "response.completed" ||
      t === "response.incomplete" ||
      t === "response.failed" ||
      t === "response.cancelled" ||
      t === "response.done"
    ) {
      this.terminalStatus = t.slice("response.".length);
      const response = json["response"];
      if (response && typeof response === "object") {
        const responseObj = response as Record<string, unknown>;
        if (typeof responseObj["status"] === "string")
          this.terminalStatus = responseObj["status"];
        if (responseObj["usage"] && typeof responseObj["usage"] === "object") {
          this.terminalUsage = responseObj["usage"] as Record<string, unknown>;
        }
        if ("end_turn" in responseObj)
          this.terminalEndTurn = responseObj["end_turn"] as boolean | undefined;
        if ("incomplete_details" in responseObj)
          this.terminalIncompleteDetails = responseObj["incomplete_details"];
      }
      if ("end_turn" in json)
        this.terminalEndTurn = json["end_turn"] as boolean | undefined;
      if (
        "incomplete_details" in json &&
        this.terminalIncompleteDetails === undefined
      )
        this.terminalIncompleteDetails = json["incomplete_details"];
    } else if (t === "response.metadata") {
      // Header capture happens in the dispatch loop via
      // `captureSessionHeadersFromResponse`; no canonical event to emit.
    } else if (t === "error") {
      // An explicit error frame inside a 200 OK is an upstream failure, not a
      // truncated stream: classify it so the client receives a code instead of
      // a bare `failed` terminal. `response.error` carries the detail when the
      // frame is a `response.failed`-style envelope.
      const streamError = gatewayErrorFromStreamError(
        json["error"] ?? (isRecord(json["response"]) ? json["response"]["error"] : undefined),
        "upstream returned an error frame",
      );
      if (streamError !== undefined) throw streamError;
      this.terminalStatus = "failed";
    } else if (typeof json["delta"] === "string" && json["delta"].length > 0) {
      // An unrecognized frame carrying a bare `delta` used to be forwarded as
      // answer text. Reasoning frames that fall through the chain above — the
      // last `else if` is the catch-all for every type this decoder does not
      // name — then leaked into the answer verbatim. Keeping the payload
      // visible as an extension part is the unknown-event convention the
      // Responses stream already uses (`responses:<type>`), so the frame stays
      // in telemetry without ever reaching the answer. Dropping it instead
      // would silently discard real content.
      events.push({
        type: "content_delta",
        sequence_number: this.#seq++,
        content: {
          kind: "extension",
          name: "codex:untyped_delta",
          payload: json["delta"] as string,
        },
      } as CanonicalEvent);
    } else {
      const choices = json["choices"] as
        | Array<Record<string, unknown>>
        | undefined;
      if (choices !== undefined) {
        for (const ch of choices) {
          const delta = ch["delta"] as Record<string, unknown> | undefined;
          if (
            typeof delta?.["content"] === "string" &&
            delta["content"].length > 0
          ) {
            events.push({
              type: "content_delta",
              sequence_number: this.#seq++,
              content: { kind: "text", text: delta["content"] },
            } as CanonicalEvent);
          }
        }
      }
    }
    return events;
  }

  /**
   * Emits tool calls that were registered but whose completion frames never
   * arrived (or arrived in a shape this decoder does not name).
   *
   * The terminal must never claim `tool_use` while a call the upstream billed
   * is invisible to the client — Claude Code reports that as "the model's tool
   * call could not be parsed" and retries into the same empty turn. A call is
   * recovered here only when it is still open (never `output_item.done`) and
   * its arguments were never streamed (they were already emitted if they were);
   * the complete payload is whatever the `output_item.added` item carried.
   */
  preTerminalEvents(): CanonicalEvent[] {
    if (this.terminalStatus === undefined) return [];
    const events: CanonicalEvent[] = [];
    const seen = new Set<OpenItemEntry>();
    for (const entry of [
      ...this.#openItems.values(),
      ...this.#openItemsByOutputIndex.values(),
    ]) {
      if (seen.has(entry)) continue;
      seen.add(entry);
      const type = entry.item["type"];
      if (
        type !== "function_call" &&
        type !== "custom_tool_call" &&
        type !== "computer_call"
      ) {
        continue;
      }
      if (entry.argDeltasSeen === true) continue;
      const rawCallId =
        typeof entry.item["call_id"] === "string"
          ? (entry.item["call_id"] as string)
          : entry.itemId;
      const callId =
        rawCallId === undefined ? "call" : decodeCodexToolCallId(rawCallId);
      const name =
        type === "computer_call"
          ? "computer"
          : typeof entry.item["name"] === "string" &&
              (entry.item["name"] as string).length > 0
            ? (entry.item["name"] as string)
            : undefined;
      const args =
        type === "function_call"
          ? entry.item["arguments"]
          : type === "custom_tool_call"
            ? entry.item["input"]
            : typeof entry.item["action"] === "object"
              ? JSON.stringify(entry.item["action"])
              : undefined;
      events.push({
        type: "tool_call_delta",
        sequence_number: this.#seq++,
        call_id: callId,
        name,
        arguments_delta: typeof args === "string" ? args : "",
      } as CanonicalEvent);
      this.hasToolCall = true;
    }
    return events;
  }

  /** Builds the terminal canonical event once the stream has ended. */
  terminalEvent(): CanonicalEvent {
    // An incomplete terminal always promotes to tool_use when any tool call
    // was seen, so no separate executability scan is needed here.
    const effectiveHasToolCall = this.hasToolCall;
    let stopReason = mapCodexStopReason(
      this.terminalStatus,
      effectiveHasToolCall,
      this.terminalEndTurn,
    );
    if (this.terminalEndTurn === false && stopReason === "stop") {
      stopReason = "pause_turn" as CanonicalStopReason;
    }
    const usage = usageFromProvider(this.terminalUsage);
    return canonicalTerminal({
      sequenceNumber: this.#seq++,
      // No terminal status means the stream ended without a terminal frame
      // (truncated). A cut stream must never report complete.
      state:
        this.terminalStatus === "failed" || this.terminalStatus === undefined
          ? "failed"
          : this.terminalStatus === "cancelled"
            ? "aborted"
            : "complete",
      stopReason,
      providerStopReason: this.terminalStatus,
      stopDetails:
        this.terminalEndTurn === false ? { type: "pause_turn" } : undefined,
      usage,
    });
  }
}
