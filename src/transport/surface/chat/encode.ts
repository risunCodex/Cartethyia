import type { CanonicalEvent, CanonicalStopReason } from "../../../protocol/canonical-model";
import { repairToolArguments } from "../../../protocol/tool-repair-args";
import { reasoningSummaryIdentity, reasoningSummarySeparator, type ReasoningSummaryIdentity } from "../reasoning-summary";
import { reasoningTextOf } from "../../../protocol/reasoning-text";
import { eventText, stopDetailsError } from "../adapters";
import { isRecord } from "../../../protocol/codecs";
import {
  createToolCallTracker,
  argumentsFrom,
  toolIdentityKey,
  trackToolCall,
  type ToolCallState,
} from "../../../protocol/tool-identity";
import { usageToChatWire, type OpenAiUsage } from "../../../providers/provider-usage";
import { chatFinishReasonForTerminal } from "../../../protocol/stop-reason";
import { TEXT_ENCODER } from "../../../protocol/sse-frame";
import { SurfaceStreamEncoder } from "../stream-frame";
import type { ChatEncodeOptions, ChunkBase, JsonObject } from "./parse";

export { repairToolArguments } from "../../../protocol/tool-repair-args";

function bytesToString(value: string | Uint8Array): string {
  return typeof value === "string" ? value : new TextDecoder().decode(value);
}

export function getResponseId(options: ChatEncodeOptions, events: CanonicalEvent[]): string {
  if (options.response_id !== undefined) return options.response_id;
  if (options.responseId !== undefined) return options.responseId;
  const start = events.find(
    (event) => event.type === "response_start" || event.type === "message_start",
  );
  return start !== undefined && "event_id" in start && start.event_id !== undefined
    ? start.event_id
    : `chatcmpl-${crypto.randomUUID()}`;
}

export function getModel(options: ChatEncodeOptions, events: CanonicalEvent[]): string {
  if (options.model !== undefined) return options.model;
  const start = events.find(
    (event) => event.type === "response_start" || event.type === "message_start",
  );
  return start !== undefined && "model" in start ? (start.model ?? "") : "";
}

/**
 * Resolves the `obfuscation` padding for the stream.
 *
 * `pinned` distinguishes an operator-configured value (`obfuscation`/`padding`
 * in the options) from the synthesized placeholder emitted when the caller
 * only asked for the field to be present. Upstream padding outranks the
 * placeholder — passing the provider's own bytes through is the whole point of
 * the extension — but never an explicit configuration.
 */
function resolveObfuscation(options: ChatEncodeOptions): {
  value: string | undefined;
  pinned: boolean;
} {
  const configured = options.obfuscation ?? options.padding;
  if (configured !== undefined) return { value: bytesToString(configured), pinned: true };
  if (options.include_obfuscation ?? options.includeObfuscation) {
    return { value: "0000000000000000", pinned: false };
  }
  return { value: undefined, pinned: false };
}

function eventObfuscation(event: CanonicalEvent): string | undefined {
  if (event.type !== "content_delta" || event.content.kind !== "extension") return undefined;
  if (!event.content.name.includes("obfuscat")) return undefined;
  const payload = event.content.payload;
  return typeof payload === "string" || payload instanceof Uint8Array
    ? bytesToString(payload)
    : undefined;
}

/** Audio output payload carried as an `audio` extension content part. */
function eventAudio(event: CanonicalEvent): Record<string, unknown> | undefined {
  if (event.type !== "content_delta" || event.content.kind !== "extension") return undefined;
  if (event.content.name !== "audio") return undefined;
  return isRecord(event.content.payload) ? event.content.payload : undefined;
}

function eventReasoningText(event: CanonicalEvent): string | undefined {
  if (event.type !== "content_delta" || event.content.kind !== "reasoning") return undefined;
  return reasoningTextOf(event.content);
}

function mergedReasoningText(events: readonly CanonicalEvent[]): string {
  const chunks: string[] = [];
  let previousIdentity: ReasoningSummaryIdentity | undefined;
  let previousText: string | undefined;
  for (const event of events) {
    const text = eventReasoningText(event);
    if (text === undefined) continue;
    const identity = reasoningSummaryIdentity(event);
    // Identity-less deltas are continuations of one part (same rule as the
    // streaming path): join raw, never force a paragraph break per token.
    const separator = reasoningSummarySeparator(previousIdentity, identity, previousText, text);
    chunks.push(separator, text);
    previousIdentity = identity;
    previousText = text;
  }
  return chunks.join("");
}

/**
 * Chat's `finish_reason`. Chat has no "cancelled"/"error" vocabulary of its
 * own: aborted streams carry the failure word the table chose, and failed
 * streams carry their signal in the error frame/envelope, so no reason
 * defaults to `stop` on a terminal that did not complete (F-35).
 */
function finishReason(
  stopReason: CanonicalStopReason | undefined,
  state: "complete" | "failed" | "aborted",
): string {
  return chatFinishReasonForTerminal(stopReason, state);
}
function eventToolCall(
  event: CanonicalEvent,
): { state: ToolCallState; hasArguments: boolean } | undefined {
  if (event.type === "tool_call_delta") {
    const index = typeof event.index === "number" && event.index >= 0 ? event.index : -1;
    const state: ToolCallState = {
      id: event.call_id,
      arguments: event.arguments_delta ?? "",
      index,
    };
    if (event.name !== undefined) state.name = event.name;
    return {
      state,
      hasArguments: event.arguments_delta !== undefined,
    };
  }
  if (event.type === "content_delta" && event.content.kind === "toolCall") {
    return {
      state: {
        id: event.content.call_id,
        name: event.content.name,
        arguments:
          typeof event.content.arguments === "string"
            ? event.content.arguments
            : JSON.stringify(event.content.arguments),
        index: event.content.index ?? -1,
      },
      hasArguments: true,
    };
  }
  return undefined;
}

function chunk(
  base: Omit<ChunkBase, "choices" | "usage">,
  choices: unknown[],
  usage: OpenAiUsage | null,
  obfuscation?: string,
): JsonObject {
  return {
    ...base,
    choices,
    usage,
    ...(obfuscation === undefined ? {} : { obfuscation }),
  };
}
export function asJsonBytes(value: unknown): Uint8Array {
  return TEXT_ENCODER.encode(JSON.stringify(value));
}

export function jsonCompletion(
  events: CanonicalEvent[],
  options: ChatEncodeOptions,
  model: string,
  id: string,
  created: number,
): JsonObject {
  const content = events
    .map(eventText)
    .filter((value): value is string => value !== undefined)
    .join("");
  const reasoningContent = mergedReasoningText(events);
  const toolCalls = new Map<number, ToolCallState>();
  const tracker = createToolCallTracker();
  // F-24: one logical call can arrive under two prefix spellings (`call_x` /
  // `fc_x`). The tracker keys by identity so both spellings accumulate into
  // ONE call, and the client is handed the first raw spelling it saw — the
  // id the backend actually sent and the transcript can replay.
  const rawIdByIdentity = new Map<string, string>();
  let terminalFinishReason: string | null = null;
  let terminalState: "complete" | "failed" | "aborted" | undefined;
  let usage: OpenAiUsage | null = null;
  const cancelled =
    options.cancelled === true || options.aborted === true || options.signal?.aborted === true;
  for (const event of events) {
    const tool = eventToolCall(event);
    if (tool) {
      const identity = toolIdentityKey(tool.state.id);
      if (!rawIdByIdentity.has(identity)) rawIdByIdentity.set(identity, tool.state.id);
      const tracked = trackToolCall(tracker, {
        id: identity,
        name: tool.state.name,
        args: tool.state.arguments,
        index: tool.state.index,
      });
      toolCalls.set(tracked.index, tracked.state);
    }
    if (event.type === "usage") {
      usage = usageToChatWire(event.usage);
      continue;
    }
    if (event.type === "terminal") {
      terminalState = event.state;
      terminalFinishReason = finishReason(event.stop_reason, event.state);
      // F-40: usage on terminal state — an UPSTREAM-aborted stream still
      // reports the usage it delivered (the client is listening and the turn
      // is billable); only a caller-cancelled stream (`cancelled`) nulls it,
      // because nobody is reading.
      if (!cancelled && event.usage) usage = usageToChatWire(event.usage);
    }
  }
  if (cancelled) usage = null;
  const namedToolCalls = [...toolCalls.values()]
    .filter((tool) => tool.name !== undefined && tool.name.trim().length > 0)
    .sort((a, b) => a.index - b.index);
  // F-36: the dangling-stop guard the Messages surface has always applied —
  // a `tool_calls` finish with zero nameable calls is a stop the client
  // cannot act on (it would loop forever waiting to answer calls that are
  // not there), so it downgrades to `stop`.
  if (terminalFinishReason === "tool_calls" && namedToolCalls.length === 0)
    terminalFinishReason = "stop";
  const message: JsonObject = {
    role: "assistant",
    content: content.length === 0 ? null : content,
    ...(reasoningContent.length === 0 ? {} : { reasoning_content: reasoningContent }),
  };
  if (namedToolCalls.length > 0) {
    message.tool_calls = namedToolCalls.map((tool) => ({
      id: rawIdByIdentity.get(tool.id) ?? tool.id,
      type: "function",
      // Zero-argument calls assemble as "{}": an empty string is not
      // valid JSON for the client's parser.
      function: { name: tool.name!, arguments: repairToolArguments(tool.arguments) },
    }));
  }
  const audio = events.map(eventAudio).findLast((value) => value !== undefined);
  if (audio !== undefined) message.audio = audio;
  const result: JsonObject = {
    id,
    object: "chat.completion",
    created,
    model,
    choices: [{ index: 0, message, finish_reason: terminalFinishReason }],
    usage,
  };
  if (terminalState === "failed") {
    // A failed terminal returns an error response, not a completion with a
    // finish_reason: the client must be able to tell the refusal/limit from a
    // finished answer. OpenAI error responses carry no `choices`.
    const terminal = events.findLast(
      (event): event is Extract<CanonicalEvent, { type: "terminal" }> =>
        event.type === "terminal",
    );
    const errorResult: JsonObject = {
      id,
      object: "chat.completion",
      created,
      model,
      usage,
      error: stopDetailsError(terminal?.stop_details, terminal?.stop_reason),
    };
    const serviceTier = options.service_tier ?? options.serviceTier;
    if (serviceTier !== undefined) errorResult.service_tier = serviceTier;
    return errorResult;
  }
  const serviceTier = options.service_tier ?? options.serviceTier;
  if (serviceTier !== undefined) result.service_tier = serviceTier;
  const start = events.find(
    (event): event is Extract<CanonicalEvent, { type: "response_start" | "message_start" }> =>
      event.type === "response_start" || event.type === "message_start",
  );
  if (start?.system_fingerprint !== undefined)
    result.system_fingerprint = start.system_fingerprint;
  return result;
}

/**
 * Incremental SSE encoder for Chat Completions. It is the only encoder for
 * this surface: it preserves state across individual `push` calls so a
 * handler can flush `data: ...` lines as upstream `CanonicalEvent`s arrive.
 */
export class ChatStreamEncoder extends SurfaceStreamEncoder<CanonicalEvent, JsonObject> {
  private readonly base: {
    id: string;
    object: "chat.completion.chunk";
    created: number;
    model: string;
    service_tier?: string;
  };
  private tracker = createToolCallTracker();
  private finalUsage: OpenAiUsage | null = null;
  private terminalState: "complete" | "failed" | "aborted" | undefined;
  private terminalReason: string | undefined;
  private configuredObfuscation: string | undefined;
  // Set when `configuredObfuscation` is an operator-configured value rather
  // than the synthesized placeholder, so upstream padding knows whether it is
  // allowed to take over once the extension event arrives.
  private readonly obfuscationPinned: boolean;
  private readonly serviceTier: string | undefined;
  private readonly includeUsage: boolean | undefined;
  private readonly cancelled: boolean;
  private emittedAny = false;
  /** True once a delta carrying a real tool name has been emitted (F-36). */
  private emittedNamedToolCall = false;
  /** Call identities already introduced to the client (the id rides the first frame). */
  private readonly emittedToolCallIds = new Set<string>();
  /** Arguments bytes already emitted per call identity (the pending-tail cursor). */
  private readonly emittedToolArguments = new Map<string, number>();
  /** First raw spelling seen per call identity — the id the client is handed (F-24). */
  private readonly firstRawToolIds = new Map<string, string>();
  private previousReasoningSummaryIdentity: ReasoningSummaryIdentity | undefined;
  private previousReasoningSummaryText: string | undefined;
  private baseModel: string;
  private baseId: string;
  private readonly created: number;

  constructor(
    private readonly options: ChatEncodeOptions = {},
    model?: string,
    id?: string,
    created?: number,
  ) {
    super();
    this.baseModel = model ?? options.model ?? "";
    this.baseId = id ?? options.response_id ?? options.responseId ?? `chatcmpl-${crypto.randomUUID()}`;
    this.created = created ?? options.created ?? Math.floor(Date.now() / 1000);
    this.serviceTier = options.service_tier ?? options.serviceTier;
    this.includeUsage = options.include_usage ?? options.includeUsage;
    this.cancelled =
      options.cancelled === true || options.aborted === true || options.signal?.aborted === true;
    const obfuscation = resolveObfuscation(options);
    this.configuredObfuscation = obfuscation.value;
    this.obfuscationPinned = obfuscation.pinned;
    this.base = {
      id: this.baseId,
      object: "chat.completion.chunk" as const,
      created: this.created,
      model: this.baseModel,
      ...(this.serviceTier === undefined ? {} : { service_tier: this.serviceTier }),
    };
  }

  private withBase(
    choices: unknown[],
    usage: OpenAiUsage | null,
    obfuscation?: string,
  ): JsonObject {
    // `this.base` already carries `service_tier` when configured (constructor),
    // so one spread in `chunk` is the whole copy — the old extra tier spread
    // and outer `{ ...chunk(...) }` wrap re-copied the base per SSE frame.
    return chunk(this.base, choices, usage, obfuscation ?? this.configuredObfuscation);
  }

  push(event: CanonicalEvent): JsonObject[] {
    const result: JsonObject[] = [];
    if (event.type === "usage") {
      this.finalUsage = usageToChatWire(event.usage);
      return result;
    }
    if (
      (event.type === "message_start" || event.type === "response_start") &&
      event.model !== undefined
    ) {
      if (
        this.options.model === undefined &&
        this.options.response_id === undefined &&
        this.options.responseId === undefined
      ) {
        if (event.model !== this.baseModel) {
          this.baseModel = event.model;
          (this.base as unknown as Record<string, unknown>).model = event.model;
        }
        if (event.event_id !== undefined && event.event_id !== this.baseId) {
          this.baseId = event.event_id;
          (this.base as unknown as Record<string, unknown>).id = event.event_id;
        }
      }
    }
    const eventPadding = eventObfuscation(event);
    if (eventPadding !== undefined && !this.obfuscationPinned) {
      this.configuredObfuscation = eventPadding;
    }
    const padding = this.configuredObfuscation;
    if (event.type === "message_start" || event.type === "response_start") {
      result.push(
        this.withBase(
          [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
          null,
          padding,
        ),
      );
      this.emittedAny = true;
      return result;
    }
    const reasoningText = eventReasoningText(event);
    if (reasoningText !== undefined) {
      const identity = reasoningSummaryIdentity(event);
      const separator = reasoningSummarySeparator(
        this.previousReasoningSummaryIdentity,
        identity,
        this.previousReasoningSummaryText,
        reasoningText,
      );
      this.previousReasoningSummaryIdentity = identity;
      this.previousReasoningSummaryText = reasoningText;
      result.push(
        this.withBase(
          [{ index: 0, delta: { reasoning_content: `${separator}${reasoningText}` }, finish_reason: null }],
          null,
          padding,
        ),
      );
      this.emittedAny = true;
      return result;
    }
    const text = eventText(event);
    if (text !== undefined) {
      result.push(
        this.withBase([{ index: 0, delta: { content: text }, finish_reason: null }], null, padding),
      );
      this.emittedAny = true;
      return result;
    }
    const audio = eventAudio(event);
    if (audio !== undefined) {
      result.push(
        this.withBase([{ index: 0, delta: { audio }, finish_reason: null }], null, padding),
      );
      this.emittedAny = true;
      return result;
    }
    const tool = eventToolCall(event);
    if (tool) {
      // Copilot streams one call as many events. Every event but the last
      // carries a slice of the id and a slice of the arguments, and no name.
      // The last carries the real id, the name, and the whole arguments.
      // Forwarding the slices made one write into dozens of nameless calls.
      //
      // F-36: a call the upstream has not named yet is withheld entirely —
      // a `function` delta without a name is a call the client cannot
      // execute. Every fragment is still tracked (they accumulate under the
      // id), and emission works on the pending tail: the first named frame
      // carries the id, the name, and every fragment that arrived before it,
      // exactly the shape Copilot's own last event had.
      //
      // F-24: tracking keys by identity (`call_x` / `fc_x` are one call) and
      // the client is handed the first raw spelling seen.
      const identity = toolIdentityKey(tool.state.id);
      if (!this.firstRawToolIds.has(identity))
        this.firstRawToolIds.set(identity, tool.state.id);
      const tracked = trackToolCall(this.tracker, {
        id: identity,
        name: tool.state.name,
        args: tool.state.arguments,
        index: tool.state.index,
      });
      const resolvedName = tool.state.name ?? tracked.state.name;
      if (resolvedName === undefined || resolvedName.trim().length === 0) return result;
      const alreadyEmitted = this.emittedToolCallIds.has(identity);
      const sent = this.emittedToolArguments.get(identity) ?? 0;
      // `sent` always equals the accumulated length at the previous emit, so
      // once a call has emitted, this event's fragment IS the pending tail.
      // Re-deriving it from the joined string would re-materialize the whole
      // prefix on every delta — quadratic over a large tool argument. The
      // first emission still needs the full accumulated text.
      const pending = alreadyEmitted
        ? tool.state.arguments
        : argumentsFrom(tracked.state, sent);
      if (alreadyEmitted && pending.length === 0) return result;
      const delta: JsonObject = {
        index: tracked.index,
        ...(alreadyEmitted ? {} : { id: tool.state.id }),
        type: "function",
        function: {
          name: resolvedName,
          arguments: pending,
        },
      };
      this.emittedToolCallIds.add(identity);
      this.emittedToolArguments.set(identity, sent + pending.length);
      result.push(
        this.withBase(
          [{ index: 0, delta: { tool_calls: [delta] }, finish_reason: null }],
          null,
          padding,
        ),
      );
      this.emittedAny = true;
      this.emittedNamedToolCall = true;
      return result;
    }
    if (event.type === "keepalive") {
      result.push(this.withBase([], null, padding));
      this.emittedAny = true;
      return result;
    }
    if (event.type === "terminal") {
      this.terminalState = event.state;
      this.terminalReason = finishReason(event.stop_reason, event.state);
      // A failed terminal is a real failure: emit an error frame with the
      // upstream's message instead of a `finish_reason: "error"` chunk. The
      // client receives the reason (rate limit, quota, upstream error) rather
      // than a bare "error" word it has to guess at. `stop_details` carries
      // the failure details when the adapter set them; otherwise the stop
      // reason is the only signal.
      if (event.state === "failed") {
        this.emittedAny = true;
        return [{ error: stopDetailsError(event.stop_details, event.stop_reason) }];
      }
      // F-36: the dangling-stop guard — a `tool_calls` finish with no
      // nameable call emitted is a stop the client cannot act on, so it
      // downgrades to `stop` (the same rule the Messages encoders apply).
      if (this.terminalReason === "tool_calls" && !this.emittedNamedToolCall)
        this.terminalReason = "stop";
      // F-40: same policy as the sync path — an upstream-aborted terminal
      // still reports its usage; only a caller-cancelled stream nulls it.
      if (!this.cancelled && event.usage) this.finalUsage = usageToChatWire(event.usage);
      const usage = this.cancelled ? null : this.finalUsage;
      result.push(
        this.withBase(
          [{ index: 0, delta: {}, finish_reason: this.terminalReason }],
          usage,
          padding,
        ),
      );
      this.emittedAny = true;
      return result;
    }
    return result;
  }

  finish(): JsonObject[] {
    const result: JsonObject[] = [];
    if (this.terminalState === undefined && !this.emittedAny) {
      result.push(this.withBase([], null, this.configuredObfuscation));
    }
    if (
      this.includeUsage === true &&
      this.terminalState === "complete" &&
      !this.cancelled &&
      this.finalUsage !== null
    ) {
      result.push(this.withBase([], this.finalUsage, this.configuredObfuscation));
    }
    return result;
  }
}
