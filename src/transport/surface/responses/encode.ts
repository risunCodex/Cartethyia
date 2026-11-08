import type { CanonicalEvent, CanonicalStopReason, ContentPart, UsageRecord } from "../../../protocol/canonical-model";
import { isRecord } from "../../../protocol/codecs";
import { usageToResponsesWire } from "../../../providers/provider-usage";
import { TEXT_ENCODER } from "../../../protocol/sse-frame";
import { SurfaceStreamEncoder } from "../stream-frame";
import { ResponsesLifecycleError, ResponsesSequenceError } from "./errors";
import type { ResponsesEncodingContext, ResponsesWireEvent } from "./contracts";
import type { SurfaceOutput } from "../adapters";
import { parseResponsesComputerActionChunks } from "./parse";
import { computerOutputToWire, outputToWire } from "./wire-output";



function terminalResponseStatus(state: "complete" | "failed" | "aborted"): {
  event: string;
  status: string;
} {
  if (state === "complete") return { event: "response.completed", status: "completed" };
  if (state === "failed") return { event: "response.failed", status: "failed" };
  return { event: "response.incomplete", status: "incomplete" };
}

function incompleteResponseReason(stopReason: CanonicalStopReason | undefined): string | undefined {
  if (stopReason === "length") return "max_output_tokens";
  if (stopReason === "content_filter") return "content_filter";
  return undefined;
}

type OpenOutputBase = {
  item: Record<string, unknown>;
  itemId: string;
  outputIndex: number;
  contentIndex: number;
  callId?: string;
  /** True when the open tool call is a computer-use call (`computer_call`). */
  isComputer?: boolean;
  /** Streaming content or argument deltas, joined once at finalization. */
  chunks: string[];
};

type OpenOutput =
  | (OpenOutputBase & { kind: "text" })
  | (OpenOutputBase & {
      kind: "reasoning";
      summaryParts: Map<number, string[]>;
      sourceSummaryIndexes: Map<string, number>;
      nextSummaryIndex: number;
    })
  | (OpenOutputBase & { kind: "tool" });

/** Stateful Responses event lifecycle encoder. */
export class ResponsesEventEncoder extends SurfaceStreamEncoder<CanonicalEvent, ResponsesWireEvent> {
  private sequence = 0;
  private inputSequence = -Infinity;
  private started = false;
  private terminal = false;
  private hasError = false;
  private responseModel: string | undefined;
  private systemFingerprint: string | undefined;
  private usage: UsageRecord | undefined;
  private open: OpenOutput | undefined;
  /**
   * Suspended items keyed by stream identity (`text`, `reasoning`,
   * `tool:<callId>`). Upstream tool-arg deltas for parallel calls may
   * interleave; parking lets a returning stream resume its original item
   * instead of forking a duplicate. Done events fire only at explicit
   * finalization (tool result, terminal), never on a switch.
   */
  private readonly parked = new Map<string, OpenOutput>();
  private readonly outputItems: Record<string, unknown>[] = [];
  private readonly computerCalls = new Set<string>();
  private readonly context: ResponsesEncodingContext;

  constructor(context: ResponsesEncodingContext = {}) {
    super();
    this.context = context;
    // One id and creation time for the whole response. Deriving them inside
    // `responseObject` minted a fresh pair on every call, so `response.created`
    // and `response.completed` disagreed on the response identity — clients
    // that correlate a stream by id (and `previous_response_id` chains) broke.
    this.responseId = context.response_id ?? `resp-${crypto.randomUUID()}`;
    this.createdAt = context.created_at ?? Math.floor(Date.now() / 1000);
  }

  private emit(type: string, payload: Record<string, unknown> = {}): ResponsesWireEvent {
    const event: ResponsesWireEvent = { type, sequence_number: this.sequence, ...payload };
    this.sequence += 1;
    return event;
  }
  private readonly responseId: string;
  private readonly createdAt: number;
  private responseObject(status: string): Record<string, unknown> {
    const response: Record<string, unknown> = {
      id: this.responseId,
      object: "response",
      created_at: this.createdAt,
      status,
      model: this.responseModel ?? this.context.model ?? "unknown",
      output: this.outputItems.map((item) => ({ ...item })),
    };
    if (this.systemFingerprint !== undefined)
      response.system_fingerprint = this.systemFingerprint;
    if (this.usage !== undefined) response.usage = usageToResponsesWire(this.usage);
    return response;
  }

  private start(model?: string): ResponsesWireEvent[] {
    if (this.started) {
      if (model !== undefined && this.responseModel !== undefined && model !== this.responseModel)
        throw new ResponsesLifecycleError("Response model changed after response.created");
      return [];
    }
    this.started = true;
    this.responseModel = model ?? this.context.model;
    return [this.emit("response.created", { response: this.responseObject("in_progress") })];
  }
  private openKey(kind: OpenOutput["kind"], callId?: string): string {
    return kind === "tool" ? `tool:${callId ?? ""}` : kind;
  }

  /**
   * Parks the active item so a later delta for it resumes the same stream.
   *
   * Only tool-call streams park: upstream commonly interleaves `arguments`
   * deltas for parallel tool calls (A, B, A), and parking is what keeps the
   * second A delta on the same `output_item` instead of forking a duplicate.
   *
   * A text/reasoning switch does NOT park — see `closeActiveNonTool`.
   */
  private suspendTool(): void {
    if (this.open === undefined || this.open.kind !== "tool") return;
    this.parked.set(this.openKey(this.open.kind, this.open.callId), this.open);
    this.open = undefined;
  }

  /** Restore a parked item as active, if present. */
  private restoreParked(key: string): boolean {
    const state = this.parked.get(key);
    if (state === undefined) return false;
    this.parked.delete(key);
    this.open = state;
    return true;
  }

  /**
   * Closes the active item IF it is a text or reasoning item.
   *
   * Text and reasoning items are forward-only in the Responses contract: once
   * the stream moves on, their `.done` events must fire before the next
   * `output_item.added` lands. Parking them (as tools do) emitted the second
   * `output_item.added` while the first item was still "open" on the wire,
   * which the hy4-preview-f family exposed clearly — the reasoning item's
   * `reasoning_summary_text.done` and `output_item.done` arrived AFTER the
   * message item's own `output_item.done`, so a strict client's UI showed the
   * thinking block still streaming while the answer text was already landing.
   *
   * Tool calls are left to {@link suspendTool} because their args genuinely do
   * interleave across parallel calls, and that is what parking exists for.
   */
  private closeActiveNonTool(): ResponsesWireEvent[] {
    if (this.open === undefined || this.open.kind === "tool") return [];
    const state = this.open;
    this.open = undefined;
    return this.finalizeState(state);
  }

  /** Finalize every open item (active first, then parked by output order). */
  private closeAll(): ResponsesWireEvent[] {
    const events: ResponsesWireEvent[] = [];
    if (this.open !== undefined) {
      const state = this.open;
      this.open = undefined;
      this.parked.delete(this.openKey(state.kind, state.callId));
      events.push(...this.finalizeState(state));
    }
    const rest = [...this.parked.values()].sort((a, b) => a.outputIndex - b.outputIndex);
    this.parked.clear();
    for (const state of rest) events.push(...this.finalizeState(state));
    return events;
  }

  /** Finalize one item: materialize chunks, snapshot output, emit done. */
  private finalizeState(open: OpenOutput): ResponsesWireEvent[] {
    open.item.status = "completed";
    const outputIndex = open.outputIndex;
    // Materialize streaming deltas once (O(N) join) instead of per-chunk
    // O(N²) string concatenation on the hot path.
    const chunks = open.chunks.join("");
    const summaryParts =
      open.kind === "reasoning"
        ? [...open.summaryParts.entries()].sort(
            ([leftIndex], [rightIndex]) => leftIndex - rightIndex,
          )
        : undefined;
    if (open.kind === "text") {
      const content = Array.isArray(open.item["content"]) ? open.item["content"] : [];
      const textPart = content[0];
      if (isRecord(textPart) && textPart["type"] === "output_text") {
        textPart["text"] = chunks;
      }
    } else if (open.kind === "tool") {
      if (open.isComputer === true)
        open.item["actions"] = parseResponsesComputerActionChunks(chunks);
      else open.item["arguments"] = chunks;
    } else if (open.kind === "reasoning") {
      if (open.chunks.length > 0) {
        open.item["content"] = [{ type: "reasoning_text", text: chunks }];
      }
      if (summaryParts !== undefined && summaryParts.length > 0) {
        open.item["summary"] = summaryParts.map(([, summaryChunks]) => ({
          type: "summary_text",
          text: summaryChunks.join(""),
        }));
      }
    }
    this.outputItems[outputIndex] = { ...open.item };
    const events: ResponsesWireEvent[] = [];
    if (open.kind === "text") {
      events.push(
        this.emit("response.output_text.done", {
          item_id: open.itemId,
          output_index: outputIndex,
          content_index: open.contentIndex,
          text: String(
            Array.isArray(open.item["content"]) && isRecord(open.item["content"][0])
              ? (open.item["content"][0]["text"] ?? "")
              : "",
          ),
        }),
      );
      events.push(
        this.emit("response.content_part.done", {
          item_id: open.itemId,
          output_index: outputIndex,
          content_index: open.contentIndex,
          part: { type: "output_text" },
        }),
      );
    } else if (open.kind === "tool" && open.isComputer !== true) {
      events.push(
        this.emit("response.function_call_arguments.done", {
          item_id: open.itemId,
          output_index: outputIndex,
          arguments: String(open.item["arguments"] ?? ""),
        }),
      );
    } else if (open.kind === "reasoning") {
      // Close each indexed summary part with a matching text and part lifecycle.
      if (summaryParts !== undefined) {
        for (const [summaryIndex, summaryChunks] of summaryParts) {
          const text = summaryChunks.join("");
          events.push(
            this.emit("response.reasoning_summary_text.done", {
              item_id: open.itemId,
              output_index: outputIndex,
              summary_index: summaryIndex,
              text,
            }),
          );
          events.push(
            this.emit("response.reasoning_summary_part.done", {
              item_id: open.itemId,
              output_index: outputIndex,
              summary_index: summaryIndex,
              part: { type: "summary_text", text },
            }),
          );
        }
      }
      if (open.chunks.length > 0) {
        events.push(
          this.emit("response.reasoning_text.done", {
            item_id: open.itemId,
            output_index: outputIndex,
            content_index: 0,
            text: chunks,
          }),
        );
      }
    }
    events.push(
      this.emit("response.output_item.done", {
        output_index: outputIndex,
        item: { ...open.item },
      }),
    );
    return events;
  }


  private openText(): ResponsesWireEvent[] {
    if (this.open?.kind === "text") return [];
    const events: ResponsesWireEvent[] = this.closeActiveNonTool();
    this.suspendTool();
    const outputIndex = this.outputItems.length;
    const itemId = `item-${outputIndex}`;
    const item: Record<string, unknown> = {
      id: itemId,
      type: "message",
      role: "assistant",
      status: "in_progress",
      content: [],
    };
    this.open = {
      kind: "text",
      item,
      itemId,
      outputIndex,
      contentIndex: 0,
      chunks: [],
    };
    this.outputItems.push({ ...item });
    events.push(
      this.emit("response.output_item.added", { output_index: outputIndex, item: { ...item } }),
    );
    events.push(
      this.emit("response.content_part.added", {
        item_id: itemId,
        output_index: outputIndex,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      }),
    );
    return events;
  }

  private openReasoning(
    content: Extract<ContentPart, { kind: "reasoning" }>,
  ): ResponsesWireEvent[] {
    if (this.open?.kind === "reasoning") return [];
    const events: ResponsesWireEvent[] = this.closeActiveNonTool();
    this.suspendTool();
    // Accept encrypted reasoning declared by route capability profile.
    const outputIndex = this.outputItems.length;
    const itemId = `item-${outputIndex}`;
    const item: Record<string, unknown> = {
      id: itemId,
      type: "reasoning",
      status: "in_progress",
      summary: [],
      content: [],
    };
    if (typeof content.encrypted_content === "string") item.encrypted_content = content.encrypted_content;    this.open = {
      kind: "reasoning",
      item,
      itemId,
      outputIndex,
      contentIndex: 0,
      chunks: [],
      summaryParts: new Map(),
      sourceSummaryIndexes: new Map(),
      nextSummaryIndex: 0,
    };
    this.outputItems.push({ ...item });
    events.push(
      this.emit("response.output_item.added", { output_index: outputIndex, item: { ...item } }),
    );
    return events;
  }

  /**
   * Maps a source reasoning-item/summary-index pair to one Responses summary
   * part. Separate source items can both start at summary_index 0; remap those
   * collisions so their summaries remain distinct instead of overwriting or
   * concatenating at one index.
   */
  private outputSummaryIndex(
    open: OpenOutput & { kind: "reasoning" },
    event: Extract<CanonicalEvent, { type: "content_delta" }>,
  ): number {
    const sourceIndex =
      event.content.kind === "reasoning" ? (event.content.summary_index ?? 0) : 0;
    const sourceIdentity =
      event.item_id !== undefined
        ? `item:${event.item_id}`
        : `output:${event.output_index ?? 0}`;
    const key = `${sourceIdentity}:${sourceIndex}`;
    const existing = open.sourceSummaryIndexes.get(key);
    if (existing !== undefined) return existing;
    let outputIndex = sourceIndex;
    if (open.summaryParts.has(outputIndex)) {
      outputIndex = open.nextSummaryIndex;
      while (open.summaryParts.has(outputIndex)) outputIndex += 1;
    }
    open.sourceSummaryIndexes.set(key, outputIndex);
    open.nextSummaryIndex = Math.max(open.nextSummaryIndex, outputIndex + 1);
    return outputIndex;
  }

  /** Open a summary part the first time a particular summary index arrives. */
  private openReasoningSummaryPart(
    open: OpenOutput & { kind: "reasoning" },
    summaryIndex: number,
  ): ResponsesWireEvent[] {
    if (open.summaryParts.has(summaryIndex)) return [];
    open.summaryParts.set(summaryIndex, []);
    return [
      this.emit("response.reasoning_summary_part.added", {
        item_id: open.itemId,
        output_index: open.outputIndex,
        summary_index: summaryIndex,
        part: { type: "summary_text", text: "" },
      }),
    ];
  }

  private openTool(callId: string, name?: string): ResponsesWireEvent[] {
    if (this.open?.kind === "tool" && this.open.callId === callId) return [];
    const events: ResponsesWireEvent[] = this.closeActiveNonTool();
    this.suspendTool();
    if (this.restoreParked(this.openKey("tool", callId))) return events;
    const outputIndex = this.outputItems.length;
    const itemId = callId;
    const isComputer = name === "computer";
    if (isComputer) this.computerCalls.add(callId);
    const item: Record<string, unknown> = isComputer
      ? {
          id: itemId,
          type: "computer_call",
          call_id: callId,
          actions: [],
          pending_safety_checks: [],
          status: "in_progress",
        }
      : {
          id: itemId,
          type: "function_call",
          call_id: callId,
          arguments: "",
          status: "in_progress",
        };
    if (name !== undefined && !isComputer) item.name = name;
    this.open = {
      kind: "tool",
      item,
      itemId,
      outputIndex,
      contentIndex: 0,
      callId,
      isComputer,
      chunks: [],
    };
    this.outputItems.push({ ...item });
    events.push(
      this.emit("response.output_item.added", { output_index: outputIndex, item: { ...item } }),
    );
    return events;
  }

  private processContent(
    content: ContentPart,
    sourceEvent: Extract<CanonicalEvent, { type: "content_delta" }>,
  ): ResponsesWireEvent[] {
    if (content.kind === "text") {
      const events = this.openText();
      events.push(
        this.emit("response.output_text.delta", {
          item_id: this.open?.itemId,
          output_index: this.open?.outputIndex,
          content_index: this.open?.contentIndex ?? 0,
          delta: content.text,
        }),
      );
      if (this.open !== undefined) {
        this.open.chunks.push(content.text);
        // Reserve the output_text content part once; the running text lives in
        // `chunks` and is joined in closeOpen(), avoiding O(N²) concatenation.
        const existing = this.open.item["content"];
        if (!Array.isArray(existing) || existing.length === 0) {
          this.open.item["content"] = [
            { type: "output_text", text: "", annotations: [] },
          ];
        }
      }
      return events;
    }
    if (content.kind === "reasoning") {
      const events = this.openReasoning(content);
      if (content.summary !== undefined && this.open?.kind === "reasoning") {
        const open = this.open;
        const summaryIndex = this.outputSummaryIndex(open, sourceEvent);
        // Open the matching summary part before its first delta.
        events.push(...this.openReasoningSummaryPart(open, summaryIndex));
        const summaryChunks = open.summaryParts.get(summaryIndex);
        if (summaryChunks === undefined)
          throw new Error("reasoning summary state missing after opening its part");
        const separator =
          summaryChunks.length === 0 &&
          open.summaryParts.size > 1 &&
          !/^\s/.test(content.summary)
            ? "\n\n"
            : "";
        const delta = `${separator}${content.summary}`;
        events.push(
          this.emit("response.reasoning_summary_text.delta", {
            item_id: open.itemId,
            output_index: open.outputIndex,
            summary_index: summaryIndex,
            delta,
          }),
        );
        summaryChunks.push(delta);
      }
      if (typeof content.encrypted_content === "string")
        events.push(
          this.emit("response.reasoning.encrypted_content", {
            item_id: this.open?.itemId,
            output_index: this.open?.outputIndex,
            encrypted_content: content.encrypted_content,
          }),
        );
      // Readable reasoning text (non-opaque payload) is the model's visible
      // chain of thought — surface it as `reasoning_text` content, distinct
      // from the condensed `summary`.
      const readable =
        content.opaque !== true && content.encrypted_content === undefined
          ? typeof content.payload === "string"
            ? content.payload
            : undefined
          : undefined;
      if (readable !== undefined && this.open !== undefined) {
        events.push(
          this.emit("response.reasoning_text.delta", {
            item_id: this.open.itemId,
            output_index: this.open.outputIndex,
            content_index: 0,
            delta: readable,
          }),
        );
        this.open.chunks.push(readable);
        const existing = this.open.item["content"];
        if (!Array.isArray(existing) || existing.length === 0) {
          this.open.item["content"] = [{ type: "reasoning_text", text: "" }];
        }
      }
      return events;
    }
    if (content.kind === "toolCall") {
      const events = this.openTool(content.call_id, content.name);
      const delta =
        typeof content.arguments === "string"
          ? content.arguments
          : JSON.stringify(content.arguments);
      if (this.open !== undefined) this.open.chunks.push(delta);
      if (this.open?.isComputer !== true)
        events.push(
          this.emit("response.function_call_arguments.delta", {
            item_id: content.call_id,
            output_index: this.open?.outputIndex,
            delta,
          }),
        );
      return events;
    }
    if (content.kind === "toolResult")
      return this.processToolResult(content.call_id, content.content);
    if (content.kind === "image") {
      const events = this.openText();
      const imagePart = { type: "output_image", image: content.payload };
      events.push(
        this.emit("response.content_part.added", {
          item_id: this.open?.itemId,
          output_index: this.open?.outputIndex,
          content_index: this.open?.contentIndex ?? 0,
          part: imagePart,
        }),
      );
      if (this.open !== undefined) {
        const existing = this.open.item["content"];
        const existingContent = Array.isArray(existing) ? existing : [];
        this.open.item["content"] = [...existingContent, imagePart];
      }
      return events;
    }
    if (content.kind === "refusal")
      return [this.emit("response.extension", { name: "refusal", payload: content.text })];
    return [this.emit("response.extension", { name: content.kind, payload: content })];
  }
  private processToolResult(
    callId: string,
    content: readonly ContentPart[] | string,
  ): ResponsesWireEvent[] {
    // Finalize exactly this call wherever it lives (active or parked) so a
    // result for one parallel call never closes its siblings.
    const key = this.openKey("tool", callId);
    let events: ResponsesWireEvent[] = [];
    if (this.open?.kind === "tool" && this.open.callId === callId) {
      const state = this.open;
      this.open = undefined;
      this.parked.delete(key);
      events = this.finalizeState(state);
    } else {
      const parked = this.parked.get(key);
      if (parked !== undefined) {
        this.parked.delete(key);
        events = this.finalizeState(parked);
      }
    }
    const outputIndex = this.outputItems.length;
    const item: Record<string, unknown> = this.computerCalls.has(callId)
      ? {
          id: callId,
          type: "computer_call_output",
          call_id: callId,
          output: computerOutputToWire(content),
          status: "completed",
        }
      : {
          id: callId,
          type: "function_call_output",
          call_id: callId,
          output: outputToWire(content),
          status: "completed",
        };
    this.outputItems.push({ ...item });
    events.push(
      this.emit("response.output_item.added", { output_index: outputIndex, item: { ...item } }),
    );
    events.push(
      this.emit("response.output_item.done", { output_index: outputIndex, item: { ...item } }),
    );
    return events;
  }
  private processTerminal(
    state: "complete" | "failed" | "aborted",
    stopReason?: CanonicalStopReason,
    usage?: UsageRecord,
    stopDetails?: unknown,
  ): ResponsesWireEvent[] {
    if (this.terminal)
      throw new ResponsesLifecycleError("Responses stream has more than one terminal event");
    if (usage !== undefined) this.usage = usage;
    const events = this.closeAll();
    // An upstream error event before an `aborted` terminal is a failure, not
    // an incomplete response: the client must see `response.failed` rather
    // than `response.incomplete` (the same distinction the Messages encoder
    // applies in `stopData`).
    const effectiveState = state === "aborted" && this.hasError ? "failed" : state;
    const status = terminalResponseStatus(effectiveState);
    const response = this.responseObject(status.status);
    const incompleteReason =
      status.status === "incomplete" ? incompleteResponseReason(stopReason) : undefined;
    if (incompleteReason !== undefined) response.incomplete_details = { reason: incompleteReason };
    if (effectiveState === "failed") {
      const raw = isRecord(stopDetails) ? stopDetails : undefined;
      const message =
        typeof raw?.["message"] === "string" && raw["message"].length > 0
          ? raw["message"]
          : "The upstream response failed";
      response.error = {
        type: "server_error",
        code: stopReason ?? "provider_error",
        ...(typeof raw?.["status"] === "number" ? { status: raw["status"] } : {}),
        message,
      };
    }
    events.push(this.emit(status.event, { response }));
    this.terminal = true;
    return events;
  }
  /** Consume one canonical event and return all corresponding wire events. */
  push(event: CanonicalEvent): ResponsesWireEvent[] {
    if (!Number.isFinite(event.sequence_number) || event.sequence_number <= this.inputSequence)
      throw new ResponsesSequenceError(
        `Canonical sequence_number must increase monotonically: ${event.sequence_number}`,
      );
    this.inputSequence = event.sequence_number;
    if (this.terminal) {
      // `usage` after terminal is legitimate: several upstreams stream it in
      // a trailing chunk after the finish-reason chunk (Qoder gRPC does). The
      // canonical contract allows it, and dropping it here would either throw a
      // false `invalid_lifecycle` (recording a failed attempt for a response
      // the client already received complete) or lose the usage. Any *other*
      // event after terminal is a genuine lifecycle violation.
      if (event.type === "usage") {
        this.usage = event.usage;
        return [];
      }
      throw new ResponsesLifecycleError("Canonical event arrived after terminal Responses event");
    }
    if (event.type === "response_start") {
      if (event.system_fingerprint !== undefined)
        this.systemFingerprint = event.system_fingerprint;
      return this.start(event.model);
    }
    if (event.type === "message_start") {
      if (event.system_fingerprint !== undefined)
        this.systemFingerprint = event.system_fingerprint;
      return this.start();
    }
    const events = this.start();
    if (event.type === "content_delta")
      return events.concat(this.processContent(event.content, event));
    if (event.type === "tool_call_delta") {
      const toolEvents = this.openTool(event.call_id, event.name);
      const delta = event.arguments_delta ?? "";
      if (this.open !== undefined) this.open.chunks.push(delta);
      if (this.open?.isComputer !== true)
        toolEvents.push(
          this.emit("response.function_call_arguments.delta", {
            item_id: event.call_id,
            output_index: this.open?.outputIndex,
            delta,
          }),
        );
      return events.concat(toolEvents);
    }
    if (event.type === "tool_result")
      return events.concat(this.processToolResult(event.call_id, event.content));
    if (event.type === "usage") {
      this.usage = event.usage;
      return events;
    }
    if (event.type === "keepalive") return events.concat(this.emit("response.keepalive"));
    if (event.type === "error") {
      this.hasError = true;
      return events.concat(
        this.emit("response.error", { category: event.category, message: event.message }),
      );
    }
    if (event.type === "terminal")
      return events.concat(
        this.processTerminal(event.state, event.stop_reason, event.usage, event.stop_details),
      );
    throw new ResponsesLifecycleError(`Unsupported canonical event type: ${event.type}`);
  }

  /** Complete the encoder and enforce exactly one terminal event. */
  finish(): ResponsesWireEvent[] {
    if (!this.terminal)
      throw new ResponsesLifecycleError("Responses stream ended without a terminal event");
    return [];
  }

  /**
   * Encodes a fatal stream error as `response.error` followed immediately by
   * `response.failed`.
   *
   * The OpenAI Responses SDK (and any strict client) requires a terminal
   * lifecycle event (`response.completed`, `response.failed`, or
   * `response.incomplete`) to close the stream cleanly.  Emitting only
   * `response.error` and then closing the SSE connection causes the SDK to
   * throw "stream closed before a terminal response event was received".
   *
   * `response.error` is kept so the client can surface the error message;
   * `response.failed` immediately follows so the client's state machine
   * reaches a terminal state and stops waiting.
   */
  encodeError(input: {
    readonly origin: string;
    readonly code: string;
    readonly message: string;
    readonly details: unknown;
  }): ResponsesWireEvent[] {
    if (this.terminal) return [];
    this.terminal = true;
    const errorEvent = this.emit("response.error", {
      origin: input.origin,
      code: input.code,
      message: input.message,
      details: input.details,
    });
    const response = this.responseObject("failed");
    response["error"] = {
      type: "server_error",
      code: input.code,
      message: input.message,
    };
    const failedEvent = this.emit("response.failed", { response });
    return [errorEvent, failedEvent];
  }
}

/** Encode synchronous canonical events into ordered Responses wire events. */
export function encodeResponsesWireEvents(
  events: Iterable<CanonicalEvent>,
  context: ResponsesEncodingContext = {},
): ResponsesWireEvent[] {
  const encoder = new ResponsesEventEncoder(context);
  const wireEvents: ResponsesWireEvent[] = [];
  for (const event of events) wireEvents.push(...encoder.push(event));
  wireEvents.push(...encoder.finish());
  return wireEvents;
}

/** Encode synchronous canonical events as a byte-oriented Responses output. */
export function encodeResponsesEvents(
  events: Iterable<CanonicalEvent>,
  context: ResponsesEncodingContext = {},
): SurfaceOutput {
  const wireEvents = encodeResponsesWireEvents(events, context);
  const terminal = wireEvents.at(-1);
  const response = terminal?.response;
  return {
    bytes: TEXT_ENCODER.encode(JSON.stringify(response ?? null)),
    content_type: "application/json",
  };
}
