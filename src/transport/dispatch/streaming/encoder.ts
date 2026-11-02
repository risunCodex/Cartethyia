/**
 * Event emission and response buffering for one streamed attempt.
 *
 * Owns the surface encoder (SSE framing), the client transcript copy used by
 * telemetry, and the per-event bookkeeping — the terminal event, usage, and
 * the first-byte / first-content timestamps — that stream completion reads
 * afterwards. Extracted from `dispatchStreamingAttempt` as a seam, not a
 * behavior change: method bodies are the original closure bodies, and the
 * observable ordering (buffer bookkeeping → terminal/usage capture →
 * client-visible tracking → encode + enqueue) is preserved exactly.
 */
import type { CanonicalEvent, SourceSurface, UsageRecord } from "../../../protocol/canonical-model";
import { canonicalTerminal } from "../../../protocol/codecs";
import { reasoningTextOf } from "../../../protocol/reasoning-text";
import { ThinkSplitter } from "../../../protocol/think-split";
import { createDispatchStreamEncoder, type DispatchStreamEncoder } from "../stream-bridge";
import { THINKING_LOOP_MARKER, ThinkingLoopDetector } from "./thinking-loop";

/** The terminal event shape every stream settles (or fails to settle) on. */
export type StreamTerminalEvent = Extract<CanonicalEvent, { type: "terminal" }>;

/**
 * SSE comment frame: valid framing on every streamed surface, ignored by
 * EventSource clients. Never part of content/telemetry.
 */
export const KEEPALIVE_COMMENT_BYTES = new TextEncoder().encode(": keepalive\n\n");

/** Diagnostic transcript budget. Client-facing frames remain uncapped here. */
const CLIENT_RESPONSE_CAP = 512 * 1024;
const EVENT_TRANSCRIPT_CAP = 512 * 1024;
const EVENT_TRANSCRIPT_HEAD_CAP = EVENT_TRANSCRIPT_CAP / 2;
const EVENT_TRANSCRIPT_TAIL_CAP = EVENT_TRANSCRIPT_CAP - EVENT_TRANSCRIPT_HEAD_CAP;

interface TruncatedEventTranscript {
  readonly _truncated: true;
  readonly _omitted_events: number;
  readonly events: readonly (CanonicalEvent & { timestamp: number })[];
  readonly usage?: UsageRecord;
  readonly terminal?: {
    readonly type: "terminal";
    readonly sequence_number: number;
    readonly state: StreamTerminalEvent["state"];
    readonly stop_reason?: StreamTerminalEvent["stop_reason"];
    readonly usage?: UsageRecord;
  };
}

/** Error-frame input in the shape the dispatch stream encoder accepts. */
export type StreamErrorFrameInput = Parameters<DispatchStreamEncoder["encodeError"]>[0];

/**
 * Per-event state and framing for one stream. Client framing and protocol
 * bookkeeping process every event; only the telemetry transcript is bounded.
 */
export class StreamEventPipeline {
  /** Terminal event once the upstream produced one (or a synthetic truncation terminal was emitted). */
  terminal: StreamTerminalEvent | undefined;
  usage: UsageRecord | undefined;
  /** Wall-clock ms of the first byte actually enqueued to the client. */
  firstByteAt: number | undefined;
  firstContentDeltaAtMs: number | undefined;
  lastEventAtMs: number | undefined;
  /** The model the upstream named in its own response, captured from the
   * opening event. Absent when the stream carried none — some providers omit
   * it, and the requested id is not a substitute. */
  reportedModel: string | undefined;
  private readonly eventTranscriptHead: Array<CanonicalEvent & { timestamp: number }> = [];
  private readonly eventTranscriptTail: Array<{ event: CanonicalEvent & { timestamp: number }; bytes: number }> = [];
  private eventTranscriptTailStart = 0;
  private eventTranscriptHeadBytes = 0;
  private eventTranscriptTailBytes = 0;
  private totalEventCount = 0;

  private readonly recoverableResponsesPrelude: boolean;
  private clientVisibleEvent = false;
  // Decoded chunks collected per event and joined once at finalize: `+=` on
  // every chunk reallocates the whole prefix (O(n^2) up to the 512 KiB cap).
  private readonly clientResponseChunks: string[] = [];
  private clientResponseLength = 0;
  private clientResponseTruncated = false;
  // One decoder per stream: `new TextDecoder()` per chunk would allocate
  // on every upstream event for the telemetry transcript copy.
  private readonly clientResponseDecoder = new TextDecoder();
  /**
   * Resolved tenant capture mode. `none`/`metadata` gate the diagnostics the
   * tenant will never be able to see: the JSON-serialized event transcript
   * copy and the client-response accumulation are skipped entirely, so a
   * privacy-lean tenant's streams cost neither the per-event `JSON.stringify`
   * nor the up-to-512 KiB buffered client-response copy. The fields the
   * completion path always needs (terminal, usage, timing, reported model,
   * event count, client-visible flag) are recorded regardless — the Responses
   * prelude retry depends on the flag, and the request row depends on the rest.
   */
  private readonly diagnosticsCaptureMode: "none" | "metadata" | "full";
  private readonly streamEncoder: DispatchStreamEncoder;
  // One splitter per stream, kept purely as a feeder for the loop guard: it
  // reports the content currently inside an open `<think>` span so a runaway
  // chain-of-thought is caught even when the provider wrote it into the text
  // stream. It never re-routes the emitted events — text is forwarded verbatim.
  private readonly thinkSplitter = new ThinkSplitter();
  /**
   * Content-level loop guard. A model that degenerates into a repeated
   * chain-of-thought keeps sending bytes, so the stall timeout — which fires
   * only on silence — never trips and the runaway burns the whole output
   * budget. This detector watches the reasoning text itself and terminates the
   * stream early when a loop shape is recognized.
   */
  private readonly loopDetector = new ThinkingLoopDetector();
  private lastSequenceNumber = -1;

  constructor(
    surface: SourceSurface,
    encoderOptions: Record<string, unknown>,
    recoverableResponsesPrelude: boolean,
    diagnostics: { captureMode: "none" | "metadata" | "full" } = { captureMode: "full" },
  ) {
    this.streamEncoder = createDispatchStreamEncoder(surface, encoderOptions);
    this.recoverableResponsesPrelude = recoverableResponsesPrelude;
    this.diagnosticsCaptureMode = diagnostics.captureMode;
  }

  /** Number of canonical events processed, including those omitted from diagnostics. */
  get eventCount(): number {
    return this.totalEventCount;
  }

  /** Whether any client-renderable event has been emitted (gates the Responses prelude retry). */
  get hasClientVisibleEvent(): boolean {
    return this.clientVisibleEvent;
  }

  /** Whether the loop guard has terminated this stream early. The pull loop
   *  stops consuming the upstream once it has: continuing would keep billing
   *  and emitting a runaway the client was already told is over. */
  get loopDetected(): boolean {
    return this.loopDetector.detected;
  }

  /** The client-facing response transcript (decoded SSE/JSON) — distinct from the provider-side canonical events. */
  get clientResponseText(): string {
    const text = this.clientResponseChunks.join("");
    return this.clientResponseTruncated ? text.slice(0, CLIENT_RESPONSE_CAP) : text;
  }

  /** Bounded canonical-event transcript for telemetry; the wire stream is unaffected. */
  get telemetryEventTranscript():
    | readonly (CanonicalEvent & { timestamp: number })[]
    | TruncatedEventTranscript {
    // Gated modes recorded nothing, so the transcript is the plain empty
    // array — no truncated-marker object for content that was never kept.
    if (this.diagnosticsCaptureMode !== "full") return [];
    const tail = this.eventTranscriptTail.slice(this.eventTranscriptTailStart).map((entry) => entry.event);
    const events = [...this.eventTranscriptHead, ...tail];
    const omittedEvents = this.totalEventCount - events.length;
    if (omittedEvents === 0) return events;
    const terminal = this.terminal;
    return {
      _truncated: true,
      _omitted_events: omittedEvents,
      events,
      ...(this.usage === undefined ? {} : { usage: this.usage }),
      ...(terminal === undefined
        ? {}
        : {
            terminal: {
              type: "terminal" as const,
              sequence_number: terminal.sequence_number,
              state: terminal.state,
              ...(terminal.stop_reason === undefined ? {} : { stop_reason: terminal.stop_reason }),
              ...(terminal.usage === undefined ? {} : { usage: terminal.usage }),
            },
          }),
    };
  }

  private recordTelemetryEvent(event: CanonicalEvent & { timestamp: number }): void {
    this.totalEventCount += 1;
    // Gated diagnostics: the transcript is only ever read by the terminal
    // capture path in `full` mode, so `none`/`metadata` pay only the count.
    if (this.diagnosticsCaptureMode !== "full") return;
    // Single serialization per event: the byte size is stored with the entry
    // so eviction subtracts without re-serializing the removed event.
    const eventBytes = Buffer.byteLength(JSON.stringify(event), "utf8");
    if (this.eventTranscriptHeadBytes + eventBytes <= EVENT_TRANSCRIPT_HEAD_CAP) {
      this.eventTranscriptHead.push(event);
      this.eventTranscriptHeadBytes += eventBytes;
      return;
    }
    if (eventBytes > EVENT_TRANSCRIPT_TAIL_CAP) return;
    // Index-pointer queue: no O(N) shift() memmove per eviction. Compact the
    // backing array once the dead prefix grows past the live window.
    while (this.eventTranscriptTailBytes + eventBytes > EVENT_TRANSCRIPT_TAIL_CAP) {
      const removed = this.eventTranscriptTail[this.eventTranscriptTailStart];
      if (removed === undefined) break;
      this.eventTranscriptTailStart += 1;
      this.eventTranscriptTailBytes -= removed.bytes;
    }
    if (this.eventTranscriptTailStart > 1024 && this.eventTranscriptTailStart > this.eventTranscriptTail.length / 2) {
      this.eventTranscriptTail.splice(0, this.eventTranscriptTailStart);
      this.eventTranscriptTailStart = 0;
    }
    this.eventTranscriptTail.push({ event, bytes: eventBytes });
    this.eventTranscriptTailBytes += eventBytes;
  }

  private isClientVisibleEvent(event: CanonicalEvent): boolean {
    if (event.type === "tool_call_delta" || event.type === "tool_result") return true;
    if (event.type === "content_delta") {
      // Extension payloads carry no client-renderable content. Reasoning
      // deltas do: they drive the reasoning pane, and withholding them
      // until the first answer token left the client blank for the whole
      // reasoning phase (seconds to minutes). A reasoning delta commits
      // the candidate the same way answer text does.
      return event.content.kind !== "extension";
    }
    return event.type === "terminal" && event.state === "complete";
  }

  private appendClientResponse(bytes: Uint8Array): void {
    // Gated diagnostics: the client-response copy feeds only the terminal
    // capture's client panel, which exists only in `full` mode.
    if (this.diagnosticsCaptureMode !== "full") return;
    if (this.clientResponseTruncated) return;
    const chunk = this.clientResponseDecoder.decode(bytes, { stream: true });
    if (this.clientResponseLength + chunk.length > CLIENT_RESPONSE_CAP) {
      this.clientResponseChunks.push(chunk.slice(0, CLIENT_RESPONSE_CAP - this.clientResponseLength));
      this.clientResponseLength = CLIENT_RESPONSE_CAP;
      this.clientResponseTruncated = true;
      return;
    }
    this.clientResponseChunks.push(chunk);
    this.clientResponseLength += chunk.length;
  }

  private pushEncodedEvent(
    event: CanonicalEvent & { timestamp: number },
    controller: ReadableStreamDefaultController<Uint8Array>,
  ): boolean {
    const toEnqueue = this.streamEncoder.push(event);
    if (toEnqueue.length > 0 && this.firstByteAt === undefined) this.firstByteAt = Date.now();
    for (const bytes of toEnqueue) {
      controller.enqueue(bytes);
      this.appendClientResponse(bytes);
    }
    return toEnqueue.length > 0;
  }

  /**
   * Records one canonical event and frames it onto the client stream.
   * Returns whether any wire bytes were enqueued (an event can be
   * intentionally invisible on the selected client surface).
   */
  enqueueEvent(
    event: CanonicalEvent,
    controller: ReadableStreamDefaultController<Uint8Array>,
  ): boolean {
    // Once the guard has terminated the stream, the surface encoders reject
    // any further event — content *and* a second terminal both throw
    // (`canonical event arrived after terminal`). The pull loop stops on
    // `loopDetected`, so this only matters for an event already in flight;
    // dropping it is the alternative to throwing mid-stream.
    if (this.loopDetector.detected) return false;
    // Text is forwarded verbatim: inline thinking tags are a per-provider
    // decoder concern, not a universal one. Splitting them here for every
    // surface misclassified literal `<think>` in an answer as reasoning — the
    // answer vanished into the thinking pane and the poisoned history stopped
    // follow-up turns. The loop guard still watches reasoning a provider puts
    // inside an open `<think>` span, without reclassifying the answer.
    if (event.type === "content_delta" && event.content.kind === "text") {
      const enqueued = this.enqueueOne(event, controller);
      const split = this.thinkSplitter.push(event.content.text);
      if (split.pendingReasoning.length > 0) {
        if (this.guardReasoning(split.pendingReasoning, controller)) return true;
      }
      return enqueued;
    }
    // Reasoning a provider already classified: feed it to the guard too, so a
    // loop is caught whether the reasoning arrived pre-classified or was
    // recovered from a `<think>` span in the answer.
    if (event.type === "content_delta" && event.content.kind === "reasoning") {
      const enqueued = this.enqueueOne(event, controller);
      this.guardReasoning(reasoningTextOf(event.content) ?? "", controller);
      return enqueued;
    }
    if (event.type === "terminal") {
      return this.enqueueOne(event, controller);
    }
    return this.enqueueOne(event, controller);
  }

  /**
   * Feeds one reasoning chunk to the loop guard and, on the first hit,
   * terminates the stream early. Returns whether it terminated.
   *
   * The terminal is a real canonical terminal rather than an error frame: the
   * client already received valid reasoning, and the runaway is cut off
   * mid-generation — which is exactly what `stop_reason: "length"` means on
   * every surface (`length` / `max_tokens`). `provider_stop_reason` carries the
   * marker so the cut is distinguishable from hitting the real token cap.
   */
  private guardReasoning(
    text: string,
    controller: ReadableStreamDefaultController<Uint8Array>,
  ): boolean {
    const reason = text.length > 0 ? this.loopDetector.push(text) : undefined;
    if (reason === undefined) return false;
    this.enqueueOne(
      canonicalTerminal({
        sequenceNumber: this.lastSequenceNumber + 1,
        state: "complete",
        stopReason: "length",
        providerStopReason: THINKING_LOOP_MARKER,
      }),
      controller,
    );
    return true;
  }

  private enqueueOne(
    event: CanonicalEvent,
    controller: ReadableStreamDefaultController<Uint8Array>,
  ): boolean {
    // A split emits two events from one chunk, so the second repeats the source
    // sequence number. The Responses encoder requires strictly increasing
    // numbers, so bump only on a repeat: an already-increasing stream keeps the
    // decoder's own numbers untouched.
    const sequenceNumber = Math.max(event.sequence_number, this.lastSequenceNumber + 1);
    this.lastSequenceNumber = sequenceNumber;
    const timestampedEvent = { ...event, sequence_number: sequenceNumber, timestamp: Date.now() };
    this.recordTelemetryEvent(timestampedEvent);
    this.lastEventAtMs = timestampedEvent.timestamp;

    if (event.type === "content_delta" && this.firstContentDeltaAtMs === undefined) {
      this.firstContentDeltaAtMs = timestampedEvent.timestamp;
    }

    // Captured once, from the opening event. Later events do not repeat it, and
    // a stream that never opens carries no model at all — which is reported as
    // absent rather than backfilled from the request.
    if (
      this.reportedModel === undefined &&
      (event.type === "response_start" || event.type === "message_start") &&
      typeof event.model === "string" &&
      event.model.trim().length > 0
    ) {
      this.reportedModel = event.model;
    }

    if (event.type === "terminal") {
      this.terminal = event;
      if (event.usage) this.usage = event.usage;
    } else if (event.type === "usage") {
      this.usage = event.usage;
    }
    // A Responses prelude that carries no client-renderable content
    // (response_start, usage, extension deltas) is tracked so a provider
    // that closes before producing anything can be retried once. It is
    // streamed as it arrives, not held: holding it until the first answer
    // token blanked the client for the whole reasoning phase, which is the
    // perceived "first response is slow and doesn't chunk" behavior.
    if (this.recoverableResponsesPrelude && this.isClientVisibleEvent(event)) {
      this.clientVisibleEvent = true;
    }
    return this.pushEncodedEvent(timestampedEvent, controller);
  }

  /** Flushes the surface encoder's closing frames (including the `[DONE]` sentinel). */
  finishEncoders(controller: ReadableStreamDefaultController<Uint8Array>): void {
    for (const bytes of this.streamEncoder.finish()) {
      controller.enqueue(bytes);
      this.appendClientResponse(bytes);
    }
  }

  /** Frames and enqueues the terminal SSE error event, recording it in the client transcript. */
  emitErrorFrame(
    input: StreamErrorFrameInput,
    controller: ReadableStreamDefaultController<Uint8Array>,
  ): void {
    for (const bytes of this.streamEncoder.encodeError(input)) {
      controller.enqueue(bytes);
      this.appendClientResponse(bytes);
    }
  }

  /**
   * Discards the buffered state of a Responses prelude that never reached
   * the client, so the single pre-content retry starts from a clean slate.
   * `clientVisibleEvent` is deliberately NOT reset: once anything
   * client-renderable was emitted the retry guard must stay closed.
   */
  resetUncommittedPrelude(): void {
    this.eventTranscriptHead.length = 0;
    this.eventTranscriptTail.length = 0;
    this.eventTranscriptHeadBytes = 0;
    this.eventTranscriptTailBytes = 0;
    this.totalEventCount = 0;
    this.terminal = undefined;
    this.usage = undefined;
    this.lastEventAtMs = undefined;
  }
}
