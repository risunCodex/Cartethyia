/**
 * The cross-surface contract suite (proposal F-41).
 *
 * One canonical event list goes through all five encoders — the three surfaces
 * in both streaming and non-streaming mode where they have both — and the
 * results are compared on the four dimensions the proposal pins:
 *
 *   1. stop-reason parity   (canonical reason → each wire's vocabulary)
 *   2. usage parity         (same terminal → same numbers on every surface)
 *   3. tool-call parity     (same deltas → one call per logical call, everywhere)
 *   4. error-shape parity   (same failure → an error object, never a fake success)
 *
 * The suite is the *ledger of divergence*. A surface that behaves differently
 * from the others is allowed only when the divergence is intentional and
 * annotated with the rule that justifies it; every unannotated difference is
 * drift and fails. Known divergences carry their proposal finding number
 * (F-nn) so the commit that fixes the behavior flips exactly the annotated
 * rows and the diff of this suite reads as the changelog of the hardening.
 *
 * The harness deliberately drives the encoders at their public boundary —
 * `jsonCompletion`/`ChatStreamEncoder`, `messagesAdapter.encode`/
 * `MessagesStreamEncoder`, `encodeResponsesWireEvents` — never internal
 * helpers, so a refactor that changes observable behavior fails here.
 */
import { describe, expect, test } from "bun:test";
import type {
  CanonicalEvent,
  CanonicalStopReason,
  UsageRecord,
} from "../../../src/protocol/canonical-model";
import { ChatStreamEncoder, jsonCompletion } from "../../../src/transport/surface/chat/encode";
import type { ChatEncodeOptions, JsonObject } from "../../../src/transport/surface/chat/parse";
import { messagesAdapter } from "../../../src/transport/surface/messages/adapter";
import { MessagesStreamEncoder } from "../../../src/transport/surface/messages/stream";
import type {
  MessagesEncodingContext,
  MessagesResponse,
  MessagesStreamEvent,
} from "../../../src/transport/surface/messages/parse";
import {
  ResponsesEventEncoder,
  encodeResponsesWireEvents,
} from "../../../src/transport/surface/responses/encode";
import type {
  ResponsesEncodingContext,
  ResponsesWireEvent,
} from "../../../src/transport/surface/responses/contracts";

// ===== Canonical event builders =====

/** `Omit` over the canonical event union — plain `Omit` collapses the union. */
type DistributiveOmit<T, K extends string> = T extends unknown ? Omit<T, K> : never;
type CanonicalEventInit = DistributiveOmit<CanonicalEvent, "sequence_number">;

let sequence = 0;
/** Stamps strictly increasing sequence numbers (the Responses encoder enforces it). */
function canon(events: CanonicalEventInit[]): CanonicalEvent[] {
  sequence = 0;
  return events.map((event) => ({ ...event, sequence_number: sequence++ }) as CanonicalEvent);
}

const start = (model = "test-model"): CanonicalEventInit => ({
  type: "message_start",
  model,
});

const text = (content: string): CanonicalEventInit => ({
  type: "content_delta",
  content: { kind: "text", text: content },
});

const thinking = (content: string): CanonicalEventInit => ({
  type: "content_delta",
  content: { kind: "reasoning", payload: content, summary: content },
});

interface ToolDeltaInit {
  id: string;
  name?: string;
  args?: string;
  index?: number;
}

const toolDelta = ({ id, name, args, index }: ToolDeltaInit): CanonicalEventInit => ({
  type: "tool_call_delta",
  call_id: id,
  ...(name === undefined ? {} : { name }),
  ...(args === undefined ? {} : { arguments_delta: args }),
  ...(index === undefined ? {} : { index }),
});

const toolResult = (callId: string, content: string): CanonicalEventInit => ({
  // Results reach the encoders as a `content_delta` carrying a toolResult
  // part — the shape every provider decoder emits. The dedicated
  // `tool_result` canonical EVENT is pinned separately below: only the
  // Responses encoder renders it.
  type: "content_delta",
  content: { kind: "toolResult", call_id: callId, content: [{ kind: "text", text: content }] },
});

function usageRecord(input: number, output: number): UsageRecord {
  return {
    input_tokens: input,
    cached_input_tokens: "unavailable",
    cache_write_tokens: "unavailable",
    uncached_input_tokens: "unavailable",
    output_tokens: output,
    reasoning_tokens: "unavailable",
    estimated_cost: null,
  };
}

const usageEvent = (input: number, output: number): CanonicalEventInit => ({
  type: "usage",
  usage: usageRecord(input, output),
});

interface TerminalInit {
  state: "complete" | "failed" | "aborted";
  reason?: CanonicalStopReason;
  usage?: UsageRecord;
  details?: Record<string, unknown>;
}

const terminal = ({ state, reason, usage, details }: TerminalInit): CanonicalEventInit => ({
  type: "terminal",
  state,
  ...(reason === undefined ? {} : { stop_reason: reason }),
  ...(usage === undefined ? {} : { usage }),
  ...(details === undefined ? {} : { stop_details: details }),
});

const errorEvent = (message: string): CanonicalEventInit => ({
  type: "error",
  category: "upstream_error",
  message,
});

// ===== The harness =====

/** One logical tool call as every surface must ultimately express it. */
interface CallView {
  id: string;
  name: string;
  args: string;
}

/** Normalized view of one surface's rendering of a canonical event list. */
interface SurfaceView {
  /** Visible answer text. */
  text: string;
  /** Visible reasoning text. */
  reasoning: string;
  /** Tool calls, in emission order. */
  calls: CallView[];
  /** Number of `tool_use`-style blocks STARTED (stream duplication detector). */
  callBlockStarts: number;
  /** The wire's terminal stop word, or null when the wire omits it. */
  stop: string | null;
  /** Response status word for surfaces that have one (`completed`/`incomplete`/`failed`). */
  status: string | null;
  /** The wire's usage object, or null when the wire attaches none. */
  usage: Record<string, unknown> | null;
  /** The wire's error object, or null when the surface reported success. */
  error: Record<string, unknown> | null;
}

const MODEL = "test-model";

function encodeChatSync(events: CanonicalEvent[], cancelled = false): SurfaceView {
  const options: ChatEncodeOptions = { model: MODEL, cancelled };
  const body = jsonCompletion(events, options, MODEL, "chat-sync", 0);
  const error = body["error"];
  const message = (body["choices"] as JsonObject[] | undefined)?.[0]?.["message"] as
    | JsonObject
    | undefined;
  const choices = body["choices"] as JsonObject[] | undefined;
  const calls = Array.isArray(message?.["tool_calls"])
    ? (message?.["tool_calls"] as JsonObject[]).map((call) => {
        const fn = call["function"] as JsonObject;
        return { id: String(call["id"]), name: String(fn["name"]), args: String(fn["arguments"]) };
      })
    : [];
  return {
    text: typeof message?.["content"] === "string" ? message["content"] : "",
    reasoning: typeof message?.["reasoning_content"] === "string" ? message["reasoning_content"] : "",
    calls,
    callBlockStarts: calls.length,
    stop: (choices?.[0]?.["finish_reason"] as string | null) ?? null,
    status: null,
    usage: (body["usage"] as Record<string, unknown> | null) ?? null,
    error: error === undefined ? null : (error as Record<string, unknown>),
  };
}

function encodeChatStream(events: CanonicalEvent[], cancelled = false): SurfaceView {
  const encoder = new ChatStreamEncoder({ model: MODEL, include_usage: true, cancelled });
  const chunks: JsonObject[] = [];
  for (const event of events) chunks.push(...encoder.push(event));
  chunks.push(...encoder.finish());
  let textOut = "";
  let reasoning = "";
  const callsById = new Map<number, { id: string; name: string; args: string }>();
  let stop: string | null = null;
  let usage: Record<string, unknown> | null = null;
  let error: Record<string, unknown> | null = null;
  for (const chunk of chunks) {
    if (chunk["error"] !== undefined) error = chunk["error"] as Record<string, unknown>;
    const choices = chunk["choices"] as JsonObject[] | undefined;
    const choice = choices?.[0];
    if (chunk["usage"] !== undefined && chunk["usage"] !== null)
      usage = chunk["usage"] as Record<string, unknown>;
    if (choice === undefined) continue;
    if (choice["finish_reason"] !== null && choice["finish_reason"] !== undefined)
      stop = choice["finish_reason"] as string;
    const delta = (choice["delta"] ?? {}) as JsonObject;
    if (typeof delta["content"] === "string") textOut += delta["content"];
    if (typeof delta["reasoning_content"] === "string") reasoning += delta["reasoning_content"];
    if (Array.isArray(delta["tool_calls"])) {
      for (const raw of delta["tool_calls"] as JsonObject[]) {
        const index = Number(raw["index"]);
        const fn = (raw["function"] ?? {}) as JsonObject;
        const entry = callsById.get(index) ?? { id: "", name: "", args: "" };
        if (typeof raw["id"] === "string") entry.id = raw["id"];
        if (typeof fn["name"] === "string") entry.name = fn["name"];
        if (typeof fn["arguments"] === "string") entry.args += fn["arguments"];
        callsById.set(index, entry);
      }
    }
  }
  const calls = [...callsById.entries()].sort(([a], [b]) => a - b).map(([, call]) => call);
  return {
    text: textOut,
    reasoning,
    calls,
    callBlockStarts: calls.length,
    stop,
    status: null,
    usage,
    error,
  };
}

function encodeMessagesSync(events: CanonicalEvent[]): SurfaceView {
  const context: MessagesEncodingContext = { response_id: "msg-sync", model: MODEL };
  const response = messagesAdapter.encode(events, context) as MessagesResponse | { type: "error"; error: Record<string, unknown> };
  if (response.type === "error") {
    return {
      text: "",
      reasoning: "",
      calls: [],
      callBlockStarts: 0,
      stop: null,
      status: null,
      usage: null,
      error: response.error as Record<string, unknown>,
    };
  }
  const blocks = response.content as JsonObject[];
  const calls = blocks
    .filter((block) => block["type"] === "tool_use")
    .map((block) => ({
      id: String(block["id"]),
      name: String(block["name"]),
      args: JSON.stringify(block["input"] ?? {}),
    }));
  const textOf = (block: JsonObject): string =>
    block["type"] === "text" ? String(block["text"] ?? "") : "";
  const thinkingOf = (block: JsonObject): string =>
    block["type"] === "thinking" ? String(block["thinking"] ?? "") : "";
  return {
    text: blocks.map(textOf).join(""),
    reasoning: blocks.map(thinkingOf).join(""),
    calls,
    callBlockStarts: calls.length,
    stop: response.stop_reason,
    status: null,
    usage: response.usage as Record<string, unknown>,
    error: null,
  };
}

function encodeMessagesStream(events: CanonicalEvent[]): SurfaceView {
  const encoder = new MessagesStreamEncoder({ response_id: "msg-stream", model: MODEL });
  const wire: MessagesStreamEvent[] = [];
  for (const event of events) wire.push(...encoder.push(event));
  wire.push(...encoder.finish());
  let textOut = "";
  let reasoning = "";
  let stop: string | null = null;
  let usage: Record<string, unknown> | null = null;
  let error: Record<string, unknown> | null = null;
  const blocks = new Map<number, { type: string; id?: string; name?: string; input: string }>();
  let callBlockStarts = 0;
  for (const event of wire) {
    if (event.type === "content_block_start") {
      const block = event["content_block"] as JsonObject;
      const index = Number(event["index"]);
      if (block["type"] === "tool_use") {
        callBlockStarts += 1;
        blocks.set(index, {
          type: "tool_use",
          id: String(block["id"]),
          name: String(block["name"]),
          input: "",
        });
      } else if (block["type"] === "text") {
        blocks.set(index, { type: "text", input: "" });
      } else if (block["type"] === "thinking") {
        blocks.set(index, { type: "thinking", input: "" });
      }
      continue;
    }
    if (event.type === "content_block_delta") {
      const index = Number(event["index"]);
      const delta = event["delta"] as JsonObject;
      const entry = blocks.get(index);
      if (delta["type"] === "text_delta") textOut += String(delta["text"] ?? "");
      if (delta["type"] === "thinking_delta") reasoning += String(delta["thinking"] ?? "");
      if (delta["type"] === "input_json_delta" && entry?.type === "tool_use")
        entry.input += String(delta["partial_json"] ?? "");
      continue;
    }
    if (event.type === "message_delta") {
      stop = (event["delta"] as JsonObject)["stop_reason"] as string | null;
      usage = (event["usage"] ?? null) as Record<string, unknown> | null;
      continue;
    }
    if (event.type === "error") error = event["error"] as Record<string, unknown>;
  }
  const calls = [...blocks.values()]
    .filter((block) => block.type === "tool_use")
    .map((block) => ({
      id: block.id ?? "",
      name: block.name ?? "",
      args: block.input.length === 0 ? "{}" : block.input,
    }));
  return { text: textOut, reasoning, calls, callBlockStarts, stop, status: null, usage, error };
}

function responsesFinalResponse(wire: ResponsesWireEvent[]): Record<string, unknown> | null {
  for (let index = wire.length - 1; index >= 0; index -= 1) {
    const event = wire[index];
    if (event === undefined) continue;
    if (event["response"] !== undefined) return event["response"] as Record<string, unknown>;
  }
  return null;
}

function encodeResponses(events: CanonicalEvent[]): { view: SurfaceView; wire: ResponsesWireEvent[] } {
  const context: ResponsesEncodingContext = { response_id: "resp-sync", model: MODEL };
  const wire = encodeResponsesWireEvents(events, context);
  const response = responsesFinalResponse(wire);
  const output = (response?.["output"] ?? []) as JsonObject[];
  const textItems = output.filter((item) => item["type"] === "message");
  const textOut = textItems
    .flatMap((item) => item["content"] as JsonObject[])
    .filter((part) => part["type"] === "output_text")
    .map((part) => String(part["text"] ?? ""))
    .join("");
  const reasoningItems = output.filter((item) => item["type"] === "reasoning");
  const reasoning = reasoningItems
    .flatMap((item) => (item["content"] ?? []) as JsonObject[])
    .filter((part) => part["type"] === "reasoning_text")
    .map((part) => String(part["text"] ?? ""))
    .join("");
  const calls = output
    .filter((item) => item["type"] === "function_call")
    .map((item) => ({
      id: String(item["call_id"]),
      name: String(item["name"] ?? ""),
      args: String(item["arguments"] ?? ""),
    }));
  const status = (response?.["status"] as string | undefined) ?? null;
  const responseError = response?.["error"] as Record<string, unknown> | undefined;
  return {
    view: {
      text: textOut,
      reasoning,
      calls,
      callBlockStarts: calls.length,
      stop: null,
      status,
      usage: (response?.["usage"] as Record<string, unknown> | undefined) ?? null,
      error: responseError ?? null,
    },
    wire,
  };
}

function encodeResponsesStream(events: CanonicalEvent[]): SurfaceView {
  const context: ResponsesEncodingContext = { response_id: "resp-stream", model: MODEL };
  // The streaming and non-streaming paths share one encoder class; drive it
  // incrementally so per-push state (parking, suspension) is exercised.
  const instance = new ResponsesEventEncoder(context);
  const wire: ResponsesWireEvent[] = [];
  for (const event of events) wire.push(...instance.push(event));
  wire.push(...instance.finish());
  let textOut = "";
  let reasoning = "";
  let status: string | null = null;
  let usage: Record<string, unknown> | null = null;
  let error: Record<string, unknown> | null = null;
  const argsById = new Map<string, string>();
  const namesById = new Map<string, string>();
  const callOrder: string[] = [];
  for (const event of wire) {
    if (event.type === "response.output_text.delta") textOut += String(event["delta"] ?? "");
    if (event.type === "response.reasoning_text.delta") reasoning += String(event["delta"] ?? "");
    if (event.type === "response.function_call_arguments.delta") {
      const id = String(event["item_id"]);
      argsById.set(id, (argsById.get(id) ?? "") + String(event["delta"] ?? ""));
    }
    if (event.type === "response.output_item.added") {
      const item = event["item"] as JsonObject;
      if (item["type"] === "function_call") {
        const id = String(item["call_id"]);
        namesById.set(id, String(item["name"] ?? ""));
        if (!callOrder.includes(id)) callOrder.push(id);
      }
    }
    if (event.type === "response.completed" || event.type === "response.failed" || event.type === "response.incomplete") {
      status = event.type === "response.completed" ? "completed" : event.type === "response.failed" ? "failed" : "incomplete";
      const response = event["response"] as Record<string, unknown>;
      usage = (response["usage"] ?? null) as Record<string, unknown> | null;
      if (response["error"] !== undefined) error = response["error"] as Record<string, unknown>;
    }
    if (event.type === "response.error" && error === null) {
      error = { category: event["category"], message: event["message"] } as Record<string, unknown>;
    }
  }
  const calls = callOrder.map((id) => ({ id, name: namesById.get(id) ?? "", args: argsById.get(id) ?? "" }));
  return { text: textOut, reasoning, calls, callBlockStarts: callOrder.length, stop: null, status, usage, error };
}

/** All five encoders over one canonical event list. */
function encodeAll(events: CanonicalEventInit[], cancelled = false) {
  const canonical = canon(events);
  return {
    chatSync: encodeChatSync(canonical, cancelled),
    chatStream: encodeChatStream(canonical, cancelled),
    messagesSync: encodeMessagesSync(canonical),
    messagesStream: encodeMessagesStream(canonical),
    responses: encodeResponses(canonical).view,
    responsesStream: encodeResponsesStream(canonical),
  };
}

// ===== Shared expectations =====

function expectSameCalls(expected: CallView[], actual: CallView[], label: string): void {
  expect(actual.map((call) => ({ ...call, args: normalizeJson(call.args) }))).toEqual(
    expected.map((call) => ({ ...call, args: normalizeJson(call.args) })),
  );
  void label;
}

/** Compares argument JSON by value so formatting differences are not drift. */
function normalizeJson(args: string): unknown {
  if (args.length === 0) return {};
  try {
    return JSON.parse(args);
  } catch {
    return args;
  }
}

function expectUsageParity(
  usage: Record<string, unknown> | null,
  input: number,
  output: number,
  label: string,
): void {
  expect(usage, `${label}: usage must be present`).not.toBeNull();
  expect(usage?.["prompt_tokens"] ?? usage?.["input_tokens"]).toBe(input);
  expect(usage?.["completion_tokens"] ?? usage?.["output_tokens"]).toBe(output);
}

// ===== 1. Text parity =====

describe("contract: text parity", () => {
  const events = [start(), text("Hel"), text("lo"), terminal({ state: "complete", reason: "stop" })];

  test("every encoder renders the same answer text (stream)", () => {
    const all = encodeAll(events);
    for (const [label, view] of Object.entries(all)) {
      expect(view.text, `${label}`).toBe("Hello");
    }
  });

  test("every encoder renders the same answer text (non-stream chat + messages + responses sync)", () => {
    const all = encodeAll(events);
    expect(all.chatSync.text).toBe("Hello");
    expect(all.messagesSync.text).toBe("Hello");
    expect(all.responses.text).toBe("Hello");
  });
});

// ===== 2. Reasoning parity =====

describe("contract: reasoning parity", () => {
  const events = [
    start(),
    thinking("th"),
    thinking("ink"),
    text("Answer"),
    terminal({ state: "complete", reason: "stop" }),
  ];

  test("every encoder renders the same reasoning text", () => {
    const all = encodeAll(events);
    for (const [label, view] of Object.entries(all)) {
      expect(view.reasoning, `${label}`).toBe("think");
    }
  });
});

// ===== 3. Tool-call parity =====

describe("contract: tool-call parity", () => {
  test("one streamed call under one spelling → one call on every surface", () => {
    const events = [
      start(),
      toolDelta({ id: "call_abc", name: "get_weather", args: '{"city": "Tok', index: 0 }),
      toolDelta({ id: "call_abc", args: 'yo"}', index: 0 }),
      terminal({ state: "complete", reason: "tool_use" }),
    ];
    const expected: CallView[] = [
      { id: "call_abc", name: "get_weather", args: '{"city": "Tokyo"}' },
    ];
    const all = encodeAll(events);
    expectSameCalls(expected, all.chatSync.calls, "chat sync");
    expectSameCalls(expected, all.chatStream.calls, "chat stream");
    expectSameCalls(expected, all.messagesSync.calls, "messages sync");
    expectSameCalls(expected, all.messagesStream.calls, "messages stream");
    expectSameCalls(expected, all.responses.calls, "responses");
    expectSameCalls(expected, all.responsesStream.calls, "responses stream");
    // The terminal stop reason agrees everywhere.
    expect(all.chatSync.stop).toBe("tool_calls");
    expect(all.chatStream.stop).toBe("tool_calls");
    expect(all.messagesSync.stop).toBe("tool_use");
    expect(all.messagesStream.stop).toBe("tool_use");
  });

  test("two parallel interleaved calls → exactly two calls on every surface", () => {
    const events = [
      start(),
      toolDelta({ id: "call_a", name: "alpha", args: '{"x":', index: 0 }),
      toolDelta({ id: "call_b", name: "beta", args: '{"y":', index: 1 }),
      toolDelta({ id: "call_a", args: "1}", index: 0 }),
      toolDelta({ id: "call_b", args: "2}", index: 1 }),
      terminal({ state: "complete", reason: "tool_use" }),
    ];
    const expected: CallView[] = [
      { id: "call_a", name: "alpha", args: '{"x":1}' },
      { id: "call_b", name: "beta", args: '{"y":2}' },
    ];
    const all = encodeAll(events);
    expectSameCalls(expected, all.chatSync.calls, "chat sync");
    expectSameCalls(expected, all.chatStream.calls, "chat stream");
    expectSameCalls(expected, all.messagesSync.calls, "messages sync");
    expectSameCalls(expected, all.messagesStream.calls, "messages stream");
    expectSameCalls(expected, all.responses.calls, "responses");
    expectSameCalls(expected, all.responsesStream.calls, "responses stream");
  });

  test("F-24 fixed: one call under two prefix spellings is one call everywhere", () => {
    // `call_abc` and `fc_abc` are the same logical call (toolIdentityKey).
    // Every encoder keys per-call state by identity and hands the client the
    // first raw spelling it saw, with the arguments joined across both
    // spellings. Before the fix: chat truncated the arguments, the Messages
    // sync path split the call, and Responses emitted a second nameless item.
    const events = [
      start(),
      toolDelta({ id: "call_abc", name: "get_weather", args: '{"city":', index: 0 }),
      toolDelta({ id: "fc_abc", args: ' "Tokyo"}', index: 1 }),
      terminal({ state: "complete", reason: "tool_use" }),
    ];
    const expected: CallView[] = [
      { id: "call_abc", name: "get_weather", args: '{"city": "Tokyo"}' },
    ];
    const all = encodeAll(events);
    expectSameCalls(expected, all.chatSync.calls, "chat sync");
    expectSameCalls(expected, all.chatStream.calls, "chat stream");
    expectSameCalls(expected, all.messagesSync.calls, "messages sync");
    expectSameCalls(expected, all.messagesStream.calls, "messages stream");
    expectSameCalls(expected, all.responses.calls, "responses");
    expectSameCalls(expected, all.responsesStream.calls, "responses stream");
    // The reverse order hands back the OTHER spelling (first seen wins).
    const reversed = encodeAll([
      start(),
      toolDelta({ id: "fc_abc", name: "get_weather", args: '{"city":', index: 0 }),
      toolDelta({ id: "call_abc", args: ' "Tokyo"}', index: 1 }),
      terminal({ state: "complete", reason: "tool_use" }),
    ]);
    expectSameCalls(
      [{ id: "fc_abc", name: "get_weather", args: '{"city": "Tokyo"}' }],
      reversed.chatSync.calls,
      "chat sync (first raw spelling wins)",
    );
    expectSameCalls(
      [{ id: "fc_abc", name: "get_weather", args: '{"city": "Tokyo"}' }],
      reversed.responses.calls,
      "responses (first raw spelling wins)",
    );
  });

  test("F-25 fixed: composite prefixes collapse to one call", () => {
    // Responses bridges wrap already-prefixed ids: `fc_call_x` and `call_x`
    // are one logical call. The provider decoders' emission ledger
    // (toolIdentityKey) drops the duplicate definition; at the encoder the
    // two spellings accumulate as one call's fragments under one identity.
    const events = [
      start(),
      toolDelta({ id: "call_x", name: "get", args: '{"a":' }),
      toolDelta({ id: "fc_call_x", args: '1}' }),
      terminal({ state: "complete", reason: "tool_use" }),
    ];
    const all = encodeAll(events);
    expectSameCalls(
      [{ id: "call_x", name: "get", args: '{"a":1}' }],
      all.chatSync.calls,
      "chat sync",
    );
    expectSameCalls(
      [{ id: "call_x", name: "get", args: '{"a":1}' }],
      all.messagesStream.calls,
      "messages stream",
    );
    expectSameCalls(
      [{ id: "call_x", name: "get", args: '{"a":1}' }],
      all.responses.calls,
      "responses",
    );
  });

  test("F-26 fixed: truncated argument JSON repairs identically on every sync path", () => {
    // The near-JSON a bridged upstream streams. Where the arguments become a
    // complete value (each sync encoder / the Responses finalization), the
    // shared jsonrepair pass produces the same strict JSON.
    const events = [
      start(),
      toolDelta({ id: "call_1", name: "get", args: '{"a": 1,' }),
      terminal({ state: "complete", reason: "tool_use" }),
    ];
    const all = encodeAll(events);
    const expected: CallView[] = [{ id: "call_1", name: "get", args: '{"a":1}' }];
    expectSameCalls(expected, all.chatSync.calls, "chat sync");
    expectSameCalls(expected, all.messagesSync.calls, "messages sync");
    expectSameCalls(expected, all.responses.calls, "responses (finalization)");
  });
});

// ===== 4. Stop-reason parity table =====

describe("contract: stop-reason table", () => {
  // The intentional per-wire vocabulary (protocol/stop-reason.ts). Rows are
  // [canonical reason, chat finish_reason, messages stop_reason].
  const COMPLETE_ROWS: Array<[CanonicalStopReason, string, string]> = [
    ["stop", "stop", "end_turn"],
    ["length", "length", "max_tokens"],
    ["tool_use", "tool_calls", "tool_use"],
    ["content_filter", "content_filter", "refusal"],
    ["refusal", "content_filter", "refusal"],
    ["pause_turn", "stop", "pause_turn"],
  ];

  for (const [reason, chatWord, messagesWord] of COMPLETE_ROWS) {
    test(`complete terminal with stop_reason=${reason}`, () => {
      // A tool_use terminal needs a nameable call, or the F-36 dangling-stop
      // guard downgrades it — the mapping under test is the reason word, so
      // the row carries the call a real tool_use turn would have.
      const events =
        reason === "tool_use"
          ? [start(), toolDelta({ id: "call_1", name: "get", args: "{}" }), terminal({ state: "complete", reason })]
          : [start(), text("hi"), terminal({ state: "complete", reason })];
      const all = encodeAll(events);
      expect(all.chatSync.stop).toBe(chatWord);
      expect(all.chatStream.stop).toBe(chatWord);
      expect(all.messagesSync.stop).toBe(messagesWord);
      expect(all.messagesStream.stop).toBe(messagesWord);
      // The OpenAI Responses wire expresses a length/content-filter stop
      // through `response.incomplete` + `incomplete_details.reason` — never
      // through `response.completed`, which would tell the client it has the
      // whole answer (fixed with F-35). A refusal completes with a refusal
      // output, which is the wire's own shape for it.
      if (reason === "length" || reason === "content_filter") {
        expect(all.responses.status).toBe("incomplete");
        expect(all.responsesStream.status).toBe("incomplete");
      } else {
        expect(all.responses.status).toBe("completed");
        expect(all.responsesStream.status).toBe("completed");
      }
    });
  }

  test("complete terminal with no stop reason → chat stop, messages end_turn", () => {
    const all = encodeAll([start(), text("hi"), terminal({ state: "complete" })]);
    expect(all.chatSync.stop).toBe("stop");
    expect(all.chatStream.stop).toBe("stop");
    expect(all.messagesSync.stop).toBe("end_turn");
    expect(all.messagesStream.stop).toBe("end_turn");
  });
});

// ===== 5. Terminal state semantics =====

describe("contract: terminal state semantics", () => {
  test("F-35 fixed: an aborted terminal is a failure word on chat, never a fake stop", () => {
    // The upstream dropped the stream mid-turn. Messages omits the stop word
    // (null), Responses reports `incomplete`, and Chat reports the table's
    // failure word — a truncated answer must not read as a finished one.
    const events = [start(), text("partial answ"), terminal({ state: "aborted" })];
    const all = encodeAll(events);
    expect(all.messagesSync.stop).toBeNull();
    expect(all.messagesStream.stop).toBeNull();
    expect(all.responses.status).toBe("incomplete");
    expect(all.responsesStream.status).toBe("incomplete");
    expect(all.chatSync.stop).toBe("error");
    expect(all.chatStream.stop).toBe("error");
  });

  test("aborted terminal preceded by an error event is a failure on messages and responses", () => {
    const events = [start(), text("partial"), errorEvent("upstream reset"), terminal({ state: "aborted" })];
    const all = encodeAll(events);
    expect(all.messagesSync.error).not.toBeNull();
    expect(all.messagesStream.error).not.toBeNull();
    expect(all.responses.status).toBe("failed");
    expect(all.responsesStream.status).toBe("failed");
  });

  test("failed terminal produces an error object on every surface — never a completion", () => {
    const details = { code: "rate_limited", message: "slow down" };
    const events = [start(), text("hi"), terminal({ state: "failed", reason: "error", details })];
    const all = encodeAll(events);
    // Chat/Responses take the failure message from `stop_details` and the code
    // from the canonical stop reason.
    expect(all.chatSync.error).toEqual({ type: "server_error", code: "error", message: "slow down" });
    expect(all.chatStream.error).toEqual({ type: "server_error", code: "error", message: "slow down" });
    expect(all.responses.status).toBe("failed");
    expect(all.responses.error).toEqual({ type: "server_error", code: "error", message: "slow down" });
    // Divergence row (annotate now, fold into the F-38/P2 error unification):
    // Messages derives the failure message from a canonical `error` event and
    // never reads `stop_details`, so the provider's diagnostic text is lost
    // when only `stop_details` carried it.
    expect(all.messagesSync.error).toEqual({ type: "server_error", message: "The upstream response failed" });
    expect(all.messagesStream.error).toEqual({ type: "server_error", message: "The upstream response failed" });
  });

  test("F-38 fixed: one response.error payload shape on both paths", () => {
    // The push path (canonical error event) and the fatal encoder now share
    // one builder: origin, code, category, message — a client keying on
    // `code` can classify a mid-stream error.
    const events = [start(), errorEvent("midstream trouble"), terminal({ state: "aborted" })];
    const canonical = canon(events);
    const wire = encodeResponsesWireEvents(canonical, { model: MODEL });
    const midstream = wire.find((event) => event.type === "response.error");
    expect(midstream).toBeDefined();
    expect(midstream?.["code"]).toBe("upstream_error");
    expect(midstream?.["category"]).toBe("upstream_error");
    expect(midstream?.["origin"]).toBe("upstream");
    expect(midstream?.["message"]).toBe("midstream trouble");
  });
});

// ===== 6. Usage parity =====

describe("contract: usage parity", () => {
  test("complete terminal: every surface reports the same input/output tokens", () => {
    const usage = usageRecord(120, 34);
    const events = [
      start(),
      text("hi"),
      usageEvent(120, 34),
      terminal({ state: "complete", reason: "stop", usage }),
    ];
    const all = encodeAll(events);
    expectUsageParity(all.chatSync.usage, 120, 34, "chat sync");
    expectUsageParity(all.chatStream.usage, 120, 34, "chat stream");
    expectUsageParity(all.messagesSync.usage, 120, 34, "messages sync");
    expectUsageParity(all.messagesStream.usage, 120, 34, "messages stream");
    expectUsageParity(all.responses.usage, 120, 34, "responses");
    expectUsageParity(all.responsesStream.usage, 120, 34, "responses stream");
  });

  test("usage event alone (no terminal usage) still lands on every surface", () => {
    const events = [start(), text("hi"), usageEvent(10, 5), terminal({ state: "complete", reason: "stop" })];
    const all = encodeAll(events);
    expectUsageParity(all.chatSync.usage, 10, 5, "chat sync");
    expectUsageParity(all.messagesSync.usage, 10, 5, "messages sync");
    expectUsageParity(all.responses.usage, 10, 5, "responses");
  });

  test("F-40 fixed: an upstream-aborted terminal reports usage on every surface", () => {
    // The same aborted terminal with usage: every surface attaches it — the
    // client is listening and the turn is billable. Only an explicitly
    // caller-cancelled stream nulls chat's usage (nobody is reading), which
    // the chat encoders keep handling through their own options.
    const usage = usageRecord(50, 7);
    const events = [start(), text("hi"), terminal({ state: "aborted", usage })];
    const all = encodeAll(events);
    expectUsageParity(all.messagesSync.usage, 50, 7, "messages sync");
    expectUsageParity(all.messagesStream.usage, 50, 7, "messages stream");
    expectUsageParity(all.responses.usage, 50, 7, "responses");
    expectUsageParity(all.chatSync.usage, 50, 7, "chat sync");
    expectUsageParity(all.chatStream.usage, 50, 7, "chat stream");
  });

  test("F-40: an explicitly caller-cancelled chat stream still nulls usage", () => {
    const usage = usageRecord(50, 7);
    const events = [start(), text("hi"), terminal({ state: "aborted", usage })];
    const canonical = canon(events);
    const sync = encodeChatSync(canonical, true);
    const stream = encodeChatStream(canonical, true);
    expect(sync.usage).toBeNull();
    expect(stream.usage).toBeNull();
  });
});

// ===== 7. Unnamed and interleaved tool calls =====

describe("contract: unnamed tool calls", () => {
  test("F-36 fixed: a tool_use stop with zero nameable calls downgrades on chat too", () => {
    // The upstream streamed arguments but never a name. Messages drops the
    // call and downgrades `tool_use` → `end_turn`; chat now mirrors the rule
    // on both paths (the argument-only deltas are withheld until a name
    // arrives, and a `tool_calls` finish with no nameable call downgrades to
    // `stop` — the dangling stop the client cannot act on).
    const events = [
      start(),
      toolDelta({ id: "call_x", args: '{"a":1}' }),
      terminal({ state: "complete", reason: "tool_use" }),
    ];
    const all = encodeAll(events);
    expect(all.messagesSync.calls).toEqual([]);
    expect(all.messagesSync.stop).toBe("end_turn");
    expect(all.messagesStream.calls).toEqual([]);
    expect(all.messagesStream.stop).toBe("end_turn");
    expect(all.chatSync.stop).toBe("stop");
    expect(all.chatSync.calls).toEqual([]);
    expect(all.chatStream.stop).toBe("stop");
    expect(all.chatStream.calls).toEqual([]);
  });

  test("F-36: a named call arriving after argument fragments still emits whole", () => {
    // The Copilot shape — argument slices first, the name on the last event.
    // Withholding must not lose the fragments: the tracker accumulates them
    // and the deltas flow once the name lands.
    const events = [
      start(),
      toolDelta({ id: "call_1", args: '{"a":' }),
      toolDelta({ id: "call_1", args: "1}" }),
      toolDelta({ id: "call_1", name: "get" }),
      terminal({ state: "complete", reason: "tool_use" }),
    ];
    const all = encodeAll(events);
    expectSameCalls([{ id: "call_1", name: "get", args: '{"a":1}' }], all.chatStream.calls, "chat stream");
    expect(all.chatStream.stop).toBe("tool_calls");
  });

  test("F-37 [divergence — to flip in the P2 tail]: continuation delta without a name after a tool result is silently lost on Messages", () => {
    // Delta A, delta B, result A, delta B(continuation, no name): the
    // Messages stream wipes every per-call map at the first tool result, so
    // the continuation re-enters a fresh tracker with NO name and the
    // nameless-delta guard swallows it — B's final argument fragment never
    // reaches the client, and the stop reason downgrades to `end_turn`.
    // Chat and Responses keep full arguments for both calls.
    const events = [
      start(),
      toolDelta({ id: "call_a", name: "alpha", args: '{"x":1}', index: 0 }),
      toolDelta({ id: "call_b", name: "beta", args: '{"y":', index: 1 }),
      toolResult("call_a", "a done"),
      toolDelta({ id: "call_b", args: '2}', index: 1 }),
      terminal({ state: "complete", reason: "tool_use" }),
    ];
    const all = encodeAll(events);
    expectSameCalls(
      [
        { id: "call_a", name: "alpha", args: '{"x":1}' },
        { id: "call_b", name: "beta", args: '{"y":2}' },
      ],
      all.chatSync.calls,
      "chat sync",
    );
    // F-37 fixed on the sync path too: the flushed block grows in place when
    // the continuation arrives.
    expectSameCalls(
      [
        { id: "call_a", name: "alpha", args: '{"x":1}' },
        { id: "call_b", name: "beta", args: '{"y":2}' },
      ],
      all.messagesSync.calls,
      "messages sync (block grows in place — F-37 fixed)",
    );
    expectSameCalls(
      [
        { id: "call_a", name: "alpha", args: '{"x":1}' },
        { id: "call_b", name: "beta", args: '{"y":2}' },
      ],
      all.responses.calls,
      "responses (parked, resumed)",
    );
    // F-37 fixed: the continuation resumes B's parked block — full arguments
    // on every path, and the tool_use stop stays accurate.
    expectSameCalls(
      [
        { id: "call_a", name: "alpha", args: '{"x":1}' },
        { id: "call_b", name: "beta", args: '{"y":2}' },
      ],
      all.messagesStream.calls,
      "messages stream (parked, resumed — F-37 fixed)",
    );
    expect(all.messagesStream.stop).toBe("tool_use");
  });

  test("F-37 [divergence — to flip in the P2 tail]: continuation delta with a name re-opens a duplicate block index on Messages", () => {
    // Same shape, but the continuation re-carries the name (providers that
    // repeat it per delta). The wipe means B opens a SECOND tool_use block
    // with the SAME stream index it already used — duplicate block, and a
    // client that tracks blocks by index executes the call twice.
    const events = [
      start(),
      toolDelta({ id: "call_a", name: "alpha", args: '{"x":1}', index: 0 }),
      toolDelta({ id: "call_b", name: "beta", args: '{"y":', index: 1 }),
      toolResult("call_a", "a done"),
      toolDelta({ id: "call_b", name: "beta", args: '2}', index: 1 }),
      terminal({ state: "complete", reason: "tool_use" }),
    ];
    const all = encodeAll(events);
    // Chat/Responses keep exactly two calls with joined arguments.
    expectSameCalls(
      [
        { id: "call_a", name: "alpha", args: '{"x":1}' },
        { id: "call_b", name: "beta", args: '{"y":2}' },
      ],
      all.chatStream.calls,
      "chat stream",
    );
    expectSameCalls(
      [
        { id: "call_a", name: "alpha", args: '{"x":1}' },
        { id: "call_b", name: "beta", args: '{"y":2}' },
      ],
      all.responsesStream.calls,
      "responses stream",
    );
    // F-37 fixed: two block starts — A and B — and B's block carries the
    // joined arguments.
    expect(all.messagesStream.callBlockStarts, "one block per call — F-37 fixed").toBe(2);
    expectSameCalls(
      [
        { id: "call_a", name: "alpha", args: '{"x":1}' },
        { id: "call_b", name: "beta", args: '{"y":2}' },
      ],
      all.messagesStream.calls,
      "messages stream (parked, resumed — F-37 fixed)",
    );
  });

  test("F-37-layer [divergence]: canonical tool_result events render on Responses only", () => {
    // A canonical `tool_result` EVENT (as opposed to a content_delta with a
    // toolResult part) is rendered by the Responses encoder and silently
    // dropped by Chat and Messages — one canonical event, three verdicts.
    const events = [start(), text("working"), { type: "tool_result", call_id: "call_a", content: [{ kind: "text", text: "done" }] } as CanonicalEventInit, terminal({ state: "complete", reason: "stop" })];
    const all = encodeAll(events);
    expect(all.responses.calls).toEqual([]); // no function_call items
    expect(all.chatSync.text).toBe("working");
    expect(all.messagesSync.text).toBe("working");
    const canonical = canon(events);
    const wire = encodeResponsesWireEvents(canonical, { model: MODEL });
    expect(wire.some((event) => event.type === "response.output_item.added" && (event["item"] as JsonObject)["type"] === "function_call_output")).toBe(true);
  });
});
