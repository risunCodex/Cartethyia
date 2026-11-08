import type { CanonicalEvent, CanonicalStopReason } from "../../../protocol/canonical-model";
import { jsonrepair } from "jsonrepair";
import { reasoningSummaryIdentity, reasoningSummarySeparator, type ReasoningSummaryIdentity } from "../reasoning-summary";
import { reasoningTextOf } from "../../../protocol/reasoning-text";
import { eventText } from "../adapters";
import { isRecord } from "../../../protocol/codecs";
import {
  createToolCallTracker,
  trackToolCall,
  type ToolCallState,
} from "../../../protocol/tool-identity";
import { usageToChatWire, type OpenAiUsage } from "../../../providers/provider-usage";
import { chatFinishReason } from "../../../protocol/stop-reason";
import { TEXT_ENCODER } from "../../../protocol/sse-frame";
import { SurfaceStreamEncoder } from "../stream-frame";
import type { ChatEncodeOptions, ChunkBase, JsonObject } from "./parse";

/**
 * Tool arguments the client can parse.
 *
 * Copilot (and other chat bridges) stream arguments that are not strict JSON:
 * a raw control character inside a string, a trailing comma, an unquoted key.
 * The client parses the assembled string with `JSON.parse` and, on failure,
 * reports the call as `Tool <name> not found` with the parser's message
 * (`Unexpected trailing characters`, `Invalid number`).
 *
 * Repairing is delegated to `jsonrepair`, which handles the whole family of
 * near-JSON shapes (truncated objects, unquoted keys, single quotes, trailing
 * commas) instead of the two cases a hand-rolled scanner covered.
 *
 * The policy around it is unchanged and is the load-bearing part: the result
 * is parsed only to validate, and anything that does not parse *to an object*
 * is discarded in favour of the original text — a half-repaired call is worse
 * than the original error. The object check matters because `jsonrepair` will
 * happily turn arbitrary prose into a quoted JSON string, which parses but is
 * not a tool-argument object.
 */
export function repairToolArguments(raw: string): string {
  if (raw.length === 0) return "{}";
  try {
    const repaired = repairToolArgumentText(raw);
    const parsed: unknown = JSON.parse(repaired);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return raw;
    return repaired;
  } catch {
    return raw;
  }
}

/** Repairs near-JSON text into strict JSON. Throws when the text is unrepairable. */
function repairToolArgumentText(json: string): string {
  return jsonrepair(json);
}

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
 * own: aborted streams are unread and failed streams carry their signal in the
 * error frame/envelope, so the table's words cover both and no reason defaults
 * to `stop`.
 */
export function finishReason(stopReason: CanonicalStopReason | undefined): string {
  return chatFinishReason(stopReason);
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

export function chunk(
  base: Omit<ChunkBase, "choices" | "usage">,
  choices: unknown[],
  usage: OpenAiUsage | null,
  obfuscation?: string,
): ChunkBase {
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
  let terminalFinishReason: string | null = null;
  let usage: OpenAiUsage | null = null;
  const cancelled =
    options.cancelled === true || options.aborted === true || options.signal?.aborted === true;
  for (const event of events) {
    const tool = eventToolCall(event);
    if (tool) {
      const tracked = trackToolCall(tracker, {
        id: tool.state.id,
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
      terminalFinishReason = finishReason(event.stop_reason);
      if (!cancelled && event.state !== "aborted" && event.usage) usage = usageToChatWire(event.usage);
    }
  }
  if (cancelled) usage = null;
  const message: JsonObject = {
    role: "assistant",
    content: content.length === 0 ? null : content,
    ...(reasoningContent.length === 0 ? {} : { reasoning_content: reasoningContent }),
  };
  if (toolCalls.size > 0) {
    message.tool_calls = [...toolCalls.values()]
      .filter((tool) => tool.name !== undefined && tool.name.trim().length > 0)
      .sort((a, b) => a.index - b.index)
      .map((tool) => ({
        id: tool.id,
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
  const terminal = events.findLast((event) => event.type === "terminal");
  if (terminal?.type === "terminal" && terminal.state === "failed") {
    const raw = isRecord(terminal.stop_details) ? terminal.stop_details : undefined;
    const errorMessage =
      typeof raw?.["message"] === "string" && raw["message"].length > 0
        ? raw["message"]
        : "The upstream response failed";
    // A failed terminal returns an error response, not a completion with a
    // finish_reason: the client must be able to tell the refusal/limit from a
    // finished answer. OpenAI error responses carry no `choices`.
    const errorResult: JsonObject = {
      id,
      object: "chat.completion",
      created,
      model,
      usage,
      error: {
        type: "server_error",
        code: terminal.stop_reason ?? "provider_error",
        ...(typeof raw?.["status"] === "number" ? { status: raw["status"] } : {}),
        message: errorMessage,
      },
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
    return {
      ...chunk(
        {
          ...this.base,
          ...(this.serviceTier === undefined ? {} : { service_tier: this.serviceTier }),
        },
        choices,
        usage,
        obfuscation ?? this.configuredObfuscation,
      ),
    };
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
      // The discriminator is the tracker, not the id shape. Keying on a `call_`
      // prefix dropped the argument continuations of every provider whose ids
      // are shaped differently — Anthropic's `toolu_…`, the synthesized
      // `call-N-frag` — so those calls reached the client with no arguments at
      // all. A nameless delta is a slice only when its id is not already an
      // established call; a continuation reuses the id the tracker holds.
      if (tool.state.name === undefined && !this.tracker.states.has(tool.state.id)) {
        return result;
      }
      const tracked = trackToolCall(this.tracker, {
        id: tool.state.id,
        name: tool.state.name,
        args: tool.state.arguments,
        index: tool.state.index,
      });
      const delta: JsonObject = {
        index: tracked.index,
        ...(tracked.isFirst ? { id: tool.state.id } : {}),
        type: "function",
        function: {
          ...(tool.state.name === undefined ? {} : { name: tool.state.name }),
          arguments: tool.state.arguments,
        },
      };
      result.push(
        this.withBase(
          [{ index: 0, delta: { tool_calls: [delta] }, finish_reason: null }],
          null,
          padding,
        ),
      );
      this.emittedAny = true;
      return result;
    }
    if (event.type === "keepalive") {
      result.push(this.withBase([], null, padding));
      this.emittedAny = true;
      return result;
    }
    if (event.type === "terminal") {
      this.terminalState = event.state;
      this.terminalReason = finishReason(event.stop_reason);
      // A failed terminal is a real failure: emit an error frame with the
      // upstream's message instead of a `finish_reason: "error"` chunk. The
      // client receives the reason (rate limit, quota, upstream error) rather
      // than a bare "error" word it has to guess at. `stop_details` carries
      // the failure details when the adapter set them; otherwise the stop
      // reason is the only signal.
      if (event.state === "failed") {
        const raw = isRecord(event.stop_details) ? event.stop_details : undefined;
        const message =
          typeof raw?.["message"] === "string" && raw["message"].length > 0
            ? raw["message"]
            : "The upstream response failed";
        this.emittedAny = true;
        return [
          {
            error: {
              type: "server_error",
              code: event.stop_reason ?? "provider_error",
              ...(typeof raw?.["status"] === "number" ? { status: raw["status"] } : {}),
              message,
            },
          },
        ];
      }
      if (!this.cancelled && event.state !== "aborted" && event.usage)
        this.finalUsage = usageToChatWire(event.usage);
      const usage = this.cancelled || event.state === "aborted" ? null : this.finalUsage;
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
