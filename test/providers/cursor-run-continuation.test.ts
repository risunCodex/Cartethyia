/**
 * Cursor cross-request Run continuation.
 *
 * Cursor's tool loop spans two client HTTP requests: the first returns a
 * `tool_call_delta` and leaves the upstream Run open; the second submits that
 * tool's result and must land on the *same* Run. The properties asserted here
 * are the ones that make that safe, each with the failure it prevents:
 *
 *   (a) the continuation writes the tool result onto the Run that produced the
 *       call — one `run_request` for the whole loop, no second upstream stream;
 *   (b) a tool result whose call id belongs to another tenant, API key, or
 *       account resolves nothing and is refused, so one caller's answer can
 *       never be written onto another caller's conversation;
 *   (c) a call id that is no longer pending (answered twice, or a terminated
 *       Run) is refused rather than silently continuing onto a Run the model
 *       may no longer be attached to — unless the request replays the complete
 *       conversation (the tool call is present in the history) and the id is
 *       live nowhere in the process, which is the restart/eviction recovery
 *       shape; then the fresh-turn path rebases the whole transcript into a
 *       new Run;
 *   (d) one request carrying results for two different Runs is refused whole;
 *   (e) the borrowed account/pool lease is released exactly once, on the Run's
 *       single terminal path, however many requests touched it;
 *   (f) an idle Run expires on its own, releasing the slot and closing the
 *       stream, so a tool round the client never answered cannot hold an
 *       HTTP/2 stream and a pool slot for the life of the process.
 *
 * No sockets: `outbound_http2` is injected with a scripted stream, and the
 * frames written upstream are decoded back with the production codec rather
 * than compared against a hand-written byte literal.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createCursorAdapter } from "../../src/providers/integrations/cursor/cursor";
import {
  cursorRunSessions,
  type CursorRunSession,
} from "../../src/providers/integrations/cursor/cursor-session-manager";
import { RUN_IDLE_TTL_MS } from "../../src/providers/integrations/cursor/cursor-shared";
import { decodeFramePayload, encodeFrame, streamFrames } from "../../src/providers/integrations/cursor/protocol/framing";
import { decodeMessage, encodeMessage } from "../../src/providers/integrations/cursor/protocol/messages";
import type { CanonicalEvent, CanonicalRequest } from "../../src/protocol/canonical-model";
import type {
  AttemptLeaseOwnership,
  ProviderAdapter,
  ProviderContinuationScope,
  ProviderDispatchContext,
  ProviderDispatchTarget,
} from "../../src/providers/provider-contracts";
import type { Http2BidiEndReason, ValidatedHttp2BidiStream } from "../../src/network/http2-bidi";
import { withFakeTimers } from "../helpers/clock";

/** The MCP namespace the adapter advertises client tools under. */
const MCP_NAMESPACE = "cartethyia";

/** `GetServerConfig` answer the injected unary fetch returns for Run origins. */
function serverConfigResponse(): Response {
  return new Response(JSON.stringify({ agentUrlConfig: { agentnUrl: "https://agentn.cursor.sh" } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/**
 * One fake Run stream: a long-lived byte queue the test appends to.
 *
 * The queue is shared by every reader and is consumed once, because that is
 * what a real Run does — a second pump of the same stream continues where the
 * first stopped instead of replaying the server's earlier frames. When the
 * queue drains the stream ends, which is what lets the first request's pump
 * return its interim `tool_use` terminal.
 */
class FakeStream implements ValidatedHttp2BidiStream {
  readonly response = { status: 200, headers: {} };
  readonly trailers: Record<string, string> = {};
  /** Every chunk the adapter wrote upstream, in order. */
  readonly written: Uint8Array[] = [];
  /** Every teardown reason the adapter passed to `abort`. */
  readonly closes: (string | undefined)[] = [];
  private readonly terminalListeners = new Set<(reason: Http2BidiEndReason) => void>();
  private queue: Uint8Array[];
  private finished = false;
  private waiter: (() => void) | undefined;

  constructor(script: readonly Uint8Array[] = []) {
    this.queue = [...script];
  }

  get body(): AsyncIterable<Uint8Array> {
    return this;
  }

  async *[Symbol.asyncIterator](): AsyncIterableIterator<Uint8Array> {
    for (;;) {
      const chunk = this.queue.shift();
      if (chunk !== undefined) {
        yield chunk;
        continue;
      }
      if (this.finished) return;
      await new Promise<void>((resolve) => {
        this.waiter = resolve;
      });
    }
  }

  /** Appends one server frame, reopening a stream that had drained. */
  push(chunk: Uint8Array): void {
    this.queue.push(chunk);
    this.finished = false;
    const resolve = this.waiter;
    this.waiter = undefined;
    resolve?.();
  }

  /** Ends the response side once the queued frames are read. */
  endBody(): void {
    this.finished = true;
    const resolve = this.waiter;
    this.waiter = undefined;
    resolve?.();
  }

  async write(chunk: Uint8Array): Promise<void> {
    this.written.push(chunk);
  }

  end(): void {
  }

  abort(reason?: unknown): void {
    this.closes.push(typeof reason === "string" ? reason : undefined);
    for (const listener of this.terminalListeners) listener({ kind: "local-close" });
  }

  onTerminal(listener: (reason: Http2BidiEndReason) => void): () => void {
    this.terminalListeners.add(listener);
    return () => {
      this.terminalListeners.delete(listener);
    };
  }

  /** Every client message this stream received, decoded from its frames. */
  messages(): Record<string, unknown>[] {
    const out: Record<string, unknown>[] = [];
    for (const chunk of this.written) {
      for (const frame of streamFrames(chunk)) {
        if (frame.payload.byteLength === 0) continue;
        try {
          out.push(decodeMessage("AgentClientMessage", decodeFramePayload(frame)));
        } catch {
          // A frame this script did not produce is not the assertion's subject.
        }
      }
    }
    return out;
  }

  /** Every `mcp_result` the adapter wrote onto this Run. */
  mcpResults(): Record<string, unknown>[] {
    const results: Record<string, unknown>[] = [];
    for (const message of this.messages()) {
      const exec = message["exec_client_message"];
      if (exec === null || typeof exec !== "object") continue;
      const result = (exec as Record<string, unknown>)["mcp_result"];
      if (result === null || typeof result !== "object") continue;
      results.push(result as Record<string, unknown>);
    }
    return results;
  }

  /** How many `AgentRunRequest`s the adapter submitted on this stream. */
  runRequestCount(): number {
    return this.messages().filter((message) => message["run_request"] !== undefined).length;
  }
}

/** Builds one Connect frame carrying an encoded `AgentServerMessage`. */
function serverFrame(message: Record<string, unknown>): Uint8Array {
  return encodeFrame(0, encodeMessage("AgentServerMessage", message));
}

/** `ExecServerMessage{mcp_args}` for one tool the request declared. */
function mcpCallFrame(execId: number, toolName: string, args: Uint8Array[] = []): Uint8Array {
  return serverFrame({
    exec_server_message: {
      id: execId,
      mcp_args: {
        provider_identifier: MCP_NAMESPACE,
        tool_name: toolName,
        ...(args.length > 0 ? { args } : {}),
      },
    },
  });
}

/** `interaction_update{turn_ended}`: the Run's authoritative end and usage. */
function turnEndedFrame(inputTokens = 100, outputTokens = 20): Uint8Array {
  return serverFrame({
    interaction_update: {
      turn_ended: { input_tokens: inputTokens, output_tokens: outputTokens, cache_read: 5 },
    },
  });
}

function writeVarint(out: number[], value: number): void {
  let remaining = value;
  while (remaining > 0x7f) {
    out.push((remaining & 0x7f) | 0x80);
    remaining >>>= 7;
  }
  out.push(remaining);
}

function writeLengthDelimited(out: number[], field: number, bytes: Uint8Array): void {
  writeVarint(out, (field << 3) | 2);
  writeVarint(out, bytes.byteLength);
  for (const byte of bytes) out.push(byte);
}

/**
 * One `map<string, google.protobuf.Value>` entry, as `McpArgs.args` carries it.
 *
 * `McpArgs.args` is a repeated-bytes capture in the vendored schema, so the
 * entry is encoded by hand and read back through the adapter's own decoder —
 * the round trip is what makes the emitted arguments an observation rather
 * than a fixture.
 */
function argEntry(key: string, value: string): Uint8Array {
  const valueBytes: number[] = [];
  writeLengthDelimited(valueBytes, 3, new TextEncoder().encode(value));
  const out: number[] = [];
  writeLengthDelimited(out, 1, new TextEncoder().encode(key));
  writeLengthDelimited(out, 2, new Uint8Array(valueBytes));
  return new Uint8Array(out);
}

const LOOKUP_TOOL = {
  name: "lookup",
  description: "Look something up.",
  jsonSchema: { type: "object", properties: { query: { type: "string" } } },
} as const;

/** The client's own shell surface, declared like the recorded requests do. */
const BASH_TOOL = {
  name: "_bash",
  description: "Run a shell command.",
  jsonSchema: {
    type: "object",
    properties: { i: { type: "string" }, command: { type: "string" }, cwd: { type: "string" } },
    required: ["i", "command"],
    additionalProperties: false,
  },
} as const;

// The canonical Cursor-native name. A native `shell` frame only relays when
// something declared a tool of exactly that name — variants stay separate, so
// `shell` here is not `_bash` above and not `pi_bash`.
const SHELL_TOOL = {
  name: "shell",
  description: "Run a shell command.",
  jsonSchema: { type: "object", properties: {} },
} as const;

/** The client's own file-write surface. */
const WRITE_TOOL = {
  name: "_write",
  description: "Write a file.",
  jsonSchema: {
    type: "object",
    properties: { i: { type: "string" }, path: { type: "string" }, content: { type: "string" } },
    required: ["i", "path", "content"],
    additionalProperties: false,
  },
} as const;

/** One request declaring exactly the given tools. */
function requestWithTools(
  tools: readonly (typeof LOOKUP_TOOL | typeof BASH_TOOL | typeof WRITE_TOOL | typeof SHELL_TOOL)[],
): CanonicalRequest {
  return {
    model: "cursor-model",
    messages: [{ role: "user", content: [{ kind: "text", text: "what is the weather?" }] }],
    tools: [...tools],
    stream: true,
    generation_controls: {},
    source_surface: "chat",
  };
}

/** `ExecServerMessage{shell_args}` — Cursor's native shell request. */
function shellExecFrame(execId: number, command: string, cwd = process.cwd()): Uint8Array {
  return serverFrame({
    exec_server_message: {
      id: execId,
      shell_args: { command, working_directory: cwd },
    },
  });
}

/** One request that declares `lookup` and asks a question. */
function requestWithTool(): CanonicalRequest {
  return {
    model: "cursor-model",
    messages: [{ role: "user", content: [{ kind: "text", text: "what is the weather?" }] }],
    tools: [LOOKUP_TOOL],
    stream: true,
    generation_controls: {},
    source_surface: "chat",
  };
}

/** One request carrying the client's answer to `callId`. */
function continuationRequest(callId: string, text = "72F and clear"): CanonicalRequest {
  return {
    model: "cursor-model",
    messages: [
      { role: "user", content: [{ kind: "text", text: "what is the weather?" }] },
      { role: "assistant", content: [{ kind: "toolCall", call_id: callId, name: "lookup", arguments: "{}" }] },
      {
        role: "tool",
        content: [{ kind: "toolResult", call_id: callId, content: [{ kind: "text", text }] }],
      },
    ],
    tools: [LOOKUP_TOOL],
    stream: true,
    generation_controls: {},
    source_surface: "chat",
  };
}

/** How many releases the injected lease recorded. */
interface ReleaseCounter {
  releases: number;
}

/**
 * One borrowed lease whose release is counted, shaped like
 * `AttemptLeaseOwnership`: a second transfer returns `undefined`, so two
 * requests touching the same Run cannot both hand the release over.
 */
function leaseFor(counter: ReleaseCounter): AttemptLeaseOwnership {
  let transferred = false;
  return {
    transferToProviderSession: () => {
      if (transferred) return undefined;
      transferred = true;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        counter.releases += 1;
      };
    },
  } as unknown as AttemptLeaseOwnership;
}

/** The scope recorded when a Run is created under tenant `t1` / key `k1`. */
function scopeOf(overrides: Partial<ProviderContinuationScope> = {}): ProviderContinuationScope {
  return {
    tenantId: "t1",
    apiKeyId: "k1",
    providerId: "cursor",
    providerAccountId: "account-1",
    ...overrides,
  };
}

interface Harness {
  readonly context: ProviderDispatchContext;
  readonly target: ProviderDispatchTarget;
  /** Streams opened by this dispatch, in order. */
  readonly streams: FakeStream[];
}

/**
 * One dispatch context whose HTTP/2 egress opens a reused scripted stream and
 * whose unary fetch answers `GetServerConfig` with an allowlisted agent origin.
 *
 * `reuse` lets a continuation dispatch reach the Run the first request opened,
 * which is the whole point: no stream is opened for a continuation.
 */
function harnessWith(
  script: readonly Uint8Array[],
  scope: ProviderContinuationScope | undefined,
  lease?: AttemptLeaseOwnership,
  reuse?: FakeStream,
): Harness {
  const streams: FakeStream[] = reuse === undefined ? [] : [reuse];
  const context = {
    credential: {
      provider_id: "cursor",
      credential_kind: "oauth",
      account_id: scope?.providerAccountId ?? "account-1",
      secret: new TextEncoder().encode("cursor-token"),
    },
    deadline: Date.now() + 60_000,
    abort_signal: new AbortController().signal,
    outbound_fetch: async () => serverConfigResponse(),
    outbound_http2: async () => {
      const stream = reuse ?? new FakeStream(script);
      streams.push(stream);
      return stream;
    },
    ...(scope === undefined ? {} : { continuation_scope: scope }),
    ...(lease === undefined ? {} : { lease_ownership: lease }),
  } as unknown as ProviderDispatchContext;
  const target = {
    provider_id: "cursor",
    model_id: "cursor-model",
    wire_family: "chat",
    endpoint_path: "/agent.v1.AgentService/Run",
    capabilities: {},
  } as unknown as ProviderDispatchTarget;
  return { context, target, streams };
}

/** Runs one dispatch to completion, capturing a thrown error instead of raising. */
async function collect(
  adapter: ProviderAdapter,
  request: CanonicalRequest,
  harness: Harness,
): Promise<{ events: CanonicalEvent[]; error?: unknown }> {
  const events: CanonicalEvent[] = [];
  try {
    for await (const event of adapter.dispatch(request, harness.target, harness.context)) {
      events.push(event);
    }
  } catch (error) {
    return { events, error };
  }
  return { events };
}

/** The `call_id` of the first tool call one dispatch emitted. */
function toolCallIdOf(events: readonly CanonicalEvent[]): string {
  const tool = events.find((event) => event.type === "tool_call_delta");
  if (tool === undefined || tool.type !== "tool_call_delta") throw new Error("no tool call emitted");
  return tool.call_id;
}

/** The terminal event one dispatch emitted, when it emitted one. */
function terminalOf(events: readonly CanonicalEvent[]): CanonicalEvent | undefined {
  return events.find((event) => event.type === "terminal");
}

/** One Run left open with a pending tool call, and the stream behind it. */
interface OpenRun {
  readonly callId: string;
  readonly stream: FakeStream;
}

/**
 * Opens a Run whose first turn ends holding one pending tool call.
 *
 * The script drains, so the pump returns its interim `tool_use` terminal and
 * the Run stays registered — exactly the state a second client request resumes.
 */
async function openRunAwaitingToolCall(
  adapter: ProviderAdapter,
  options: {
    readonly execId?: number;
    readonly lease?: AttemptLeaseOwnership;
  } = {},
): Promise<OpenRun> {
  const stream = new FakeStream([
    mcpCallFrame(options.execId ?? 7, "lookup", [argEntry("query", "weather")]),
  ]);
  stream.endBody();
  const harness = harnessWith([], scopeOf(), options.lease, stream);
  const opened = await collect(adapter, requestWithTool(), harness);
  expect(opened.error).toBeUndefined();
  // The interim terminal defers usage: the real count arrives with the Run's
  // `turn_ended` on the continuation request, not as an estimate now.
  expect(terminalOf(opened.events)).toMatchObject({
    state: "complete",
    stop_reason: "tool_use",
    usage_deferred: true,
  });
  return { callId: toolCallIdOf(opened.events), stream };
}

/** A continuation dispatch that reaches `stream` — the Run already open. */
function continuationHarness(scope: ProviderContinuationScope, stream: FakeStream): Harness {
  return harnessWith([], scope, undefined, stream);
}

/**
 * A Run session record with no live socket behind it.
 *
 * Registered directly on the manager so a test can pose the state a transport
 * failure leaves behind: the record survived, the handle did not.
 */
function runSession(runId: string, scope: ProviderContinuationScope): CursorRunSession {
  return {
    runId,
    conversationId: `conversation-${runId}`,
    scope,
    descriptors: [],
    pending: new Map(),
    calls: new Map(),
    usage: undefined,
    failure: undefined,
  };
}

beforeEach(() => {
  cursorRunSessions.terminateAll("test reset");
});

afterEach(() => {
  cursorRunSessions.terminateAll("test teardown");
});

describe("Cursor cross-request Run continuation", () => {
  test("a tool result is written onto the Run that produced the call", async () => {
    const adapter = createCursorAdapter();
    const { callId, stream } = await openRunAwaitingToolCall(adapter);
    expect(callId.startsWith("call_cursor_")).toBe(true);
    expect(cursorRunSessions.size).toBe(1);

    // The continuation is a separate client HTTP request with its own context.
    stream.push(turnEndedFrame());
    const second = continuationHarness(scopeOf(), stream);
    const resumed = await collect(adapter, continuationRequest(callId), second);
    expect(resumed.error).toBeUndefined();
    // No upstream stream was opened: the held Run answered.
    expect(second.streams.length).toBe(1);
    expect(second.streams[0]).toBe(stream);

    const results = stream.mcpResults();
    expect(results.length).toBe(1);
    expect(JSON.stringify(results[0])).toContain("72F and clear");
    // One Run request for the whole loop: the continuation never re-submitted.
    expect(stream.runRequestCount()).toBe(1);
  });

  test("an executable call's arguments are decoded from Cursor's map field", async () => {
    const adapter = createCursorAdapter();
    const stream = new FakeStream([mcpCallFrame(7, "lookup", [argEntry("query", "weather")])]);
    stream.endBody();
    const opened = await collect(adapter, requestWithTool(), harnessWith([], scopeOf(), undefined, stream));
    const tool = opened.events.find((event) => event.type === "tool_call_delta");
    expect(tool?.type === "tool_call_delta" ? tool.arguments_delta : undefined).toBe('{"query":"weather"}');
  });

  test("the continuation finishes the turn on the same Run and closes it", async () => {
    const adapter = createCursorAdapter();
    const { callId, stream } = await openRunAwaitingToolCall(adapter);

    stream.push(turnEndedFrame(120, 30));
    const second = continuationHarness(scopeOf(), stream);
    const resumed = await collect(adapter, continuationRequest(callId), second);
    expect(resumed.error).toBeUndefined();
    expect(terminalOf(resumed.events)).toMatchObject({ state: "complete", stop_reason: "stop" });
    // Usage is the Run's own `turn_ended`, not an estimate for a second turn.
    const terminal = terminalOf(resumed.events);
    expect(terminal?.type === "terminal" ? terminal.usage?.input_tokens : undefined).toBe(120);
    // The Run owed no further answer, so it was torn down.
    expect(cursorRunSessions.size).toBe(0);
    expect(stream.closes.length).toBe(1);
  });

  test("a call id from another API key resolves nothing and is refused", async () => {
    const adapter = createCursorAdapter();
    const { callId, stream } = await openRunAwaitingToolCall(adapter);

    // A different API key under the same tenant: the call id is unguessable,
    // but it is still only a string a client can carry into another request.
    const other = continuationHarness(scopeOf({ apiKeyId: "k2" }), stream);
    const refused = await collect(adapter, continuationRequest(callId), other);
    expect(refused.error).toBeDefined();
    expect(String((refused.error as Error).message)).toContain("no longer pending");
    // The refused request must not have written onto the real Run.
    expect(stream.mcpResults().length).toBe(0);
    expect(cursorRunSessions.size).toBe(1);
  });

  test("a call id from another tenant or account resolves nothing", async () => {
    const adapter = createCursorAdapter();
    const { callId, stream } = await openRunAwaitingToolCall(adapter);

    for (const scope of [scopeOf({ tenantId: "t2" }), scopeOf({ providerAccountId: "account-2" })]) {
      const other = continuationHarness(scope, stream);
      const refused = await collect(adapter, continuationRequest(callId), other);
      expect(refused.error).toBeDefined();
    }
    // Both refusals left the Run live and untouched.
    expect(stream.mcpResults().length).toBe(0);
    expect(cursorRunSessions.size).toBe(1);
  });

  test("a tool result with no continuation scope cannot claim a Run", async () => {
    const adapter = createCursorAdapter();
    // A route with no scope must not hold a Run open for a result at all.
    const unscoped = harnessWith([turnEndedFrame()], undefined);
    const refused = await collect(adapter, continuationRequest("call_cursor_run_1_7"), unscoped);
    expect(refused.error).toBeDefined();
    expect(String((refused.error as Error).message)).toContain("cannot be matched");
    expect(unscoped.streams.length).toBe(0);
  });

  test("a replayed tool result after the call is answered rebases into a fresh Run", async () => {
    const adapter = createCursorAdapter();
    const { callId, stream } = await openRunAwaitingToolCall(adapter);

    stream.push(turnEndedFrame());
    const answered = await collect(
      adapter,
      continuationRequest(callId),
      continuationHarness(scopeOf(), stream),
    );
    expect(answered.error).toBeUndefined();
    expect(cursorRunSessions.size).toBe(0);

    // The same result sent again resolves nothing: a call id live nowhere in
    // the process and a result whose tool call is present in the replayed
    // conversation is exactly the restart-replay recovery shape, so the
    // adapter rebases the complete history into a fresh Run instead of
    // refusing the resend it just asked the client for.
    const replay = harnessWith([turnEndedFrame()], scopeOf());
    const rebased = await collect(adapter, continuationRequest(callId), replay);
    expect(rebased.error).toBeUndefined();
    expect(replay.streams.length).toBe(1);
    // The replayed exchange travels as rebased history: the request submitted
    // a fresh Run turn (not a resume).
    expect(replay.streams[0]?.runRequestCount()).toBe(1);
    expect(cursorRunSessions.size).toBe(0);
  });

  test("results for two different Runs in one request are refused whole", async () => {
    const adapter = createCursorAdapter();
    const first = await openRunAwaitingToolCall(adapter, { execId: 1 });
    const secondStream = new FakeStream([mcpCallFrame(2, "lookup")]);
    secondStream.endBody();
    const secondHarness = harnessWith([], scopeOf(), undefined, secondStream);
    const openedB = await collect(adapter, requestWithTool(), secondHarness);
    const callB = toolCallIdOf(openedB.events);
    expect(first.callId).not.toBe(callB);
    expect(cursorRunSessions.size).toBe(2);

    const mixedRequest: CanonicalRequest = {
      ...continuationRequest(first.callId),
      messages: [
        ...continuationRequest(first.callId).messages.slice(0, -1),
        {
          role: "tool",
          content: [
            { kind: "toolResult", call_id: first.callId, content: [{ kind: "text", text: "a" }] },
            { kind: "toolResult", call_id: callB, content: [{ kind: "text", text: "b" }] },
          ],
        },
      ],
    };
    const mixed = continuationHarness(scopeOf(), first.stream);
    const refused = await collect(adapter, mixedRequest, mixed);
    expect(refused.error).toBeDefined();
    expect(String((refused.error as Error).message)).toContain("different Cursor Runs");
    // Neither Run received a result: a partial write would corrupt both.
    expect(first.stream.mcpResults().length).toBe(0);
    expect(secondStream.mcpResults().length).toBe(0);
    expect(refused.events.length).toBe(0);
  });

  test("the borrowed lease is released exactly once across the loop", async () => {
    const adapter = createCursorAdapter();
    const counter: ReleaseCounter = { releases: 0 };
    const lease = leaseFor(counter);
    const { callId, stream } = await openRunAwaitingToolCall(adapter, { lease });
    // Held open for the answer: not released at the end of the first request.
    expect(counter.releases).toBe(0);

    // The continuation request takes its own lease; a Run that already owns one
    // must not take a second, so the slot is released once when the Run ends.
    stream.push(turnEndedFrame());
    const second = harnessWith([], scopeOf(), lease, stream);
    const resumed = await collect(adapter, continuationRequest(callId), second);
    expect(resumed.error).toBeUndefined();
    expect(counter.releases).toBe(1);
  });

  test("the pending call is scoped before the answer reaches the Run", async () => {
    const adapter = createCursorAdapter();
    const { callId } = await openRunAwaitingToolCall(adapter);
    // The routing layer reads the owning account from the call id alone, before
    // it knows which provider a candidate belongs to.
    expect(cursorRunSessions.describePendingCall(callId, { tenantId: "t1", apiKeyId: "k1" })).toEqual({
      providerId: "cursor",
      providerAccountId: "account-1",
    });
    expect(
      cursorRunSessions.describePendingCall(callId, { tenantId: "t1", apiKeyId: "k2" }),
    ).toBeUndefined();
  });

  test("a Run whose socket is gone rebases from history instead of answering", async () => {
    const adapter = createCursorAdapter();
    // The record survived but the adapter holds no handle for it — the state a
    // transport failure the pump did not observe leaves behind. Writing into a
    // dead stream would lose the answer, so the request rebases.
    const runId = "run-without-handle";
    const callId = `call_cursor_${runId}_7`;
    cursorRunSessions.register({
      session: runSession(runId, scopeOf()),
      close: () => undefined,
  });
    expect(cursorRunSessions.registerPendingCall(runId, { callId, execId: 7, toolName: "lookup" })).toBe(true);

    const fresh = harnessWith([turnEndedFrame(11, 2)], scopeOf());
    const result = await collect(adapter, continuationRequest(callId), fresh);
    expect(result.error).toBeUndefined();
    // A rebase submits a Run request: it is a new upstream turn, not a resume.
    expect(fresh.streams.length).toBe(1);
    expect(fresh.streams[0]?.runRequestCount()).toBe(1);
    // And the dead Run's record was released rather than left to expire.
    expect(cursorRunSessions.size).toBe(0);
  });
});

describe("Cursor Run idle expiry", () => {
  test("an unanswered Run expires, closes its stream, and releases the slot", async () => {
    const adapter = createCursorAdapter();
    const counter: ReleaseCounter = { releases: 0 };

    await withFakeTimers(async (clock) => {
      const { callId, stream } = await openRunAwaitingToolCall(adapter, { lease: leaseFor(counter) });
      expect(cursorRunSessions.size).toBe(1);
      expect(counter.releases).toBe(0);

      await clock.advance(RUN_IDLE_TTL_MS + 1);

      expect(cursorRunSessions.size).toBe(0);
      expect(stream.closes.length).toBe(1);
      expect(counter.releases).toBe(1);

      // After expiry the stale result rebases into a fresh Run: the evicted
      // Run exists nowhere in the process, and the replay carries the tool
      // call in its recorded history.
      stream.push(turnEndedFrame());
      const rebased = await collect(
        adapter,
        continuationRequest(callId),
        continuationHarness(scopeOf(), stream),
      );
      expect(rebased.error).toBeUndefined();
      expect(cursorRunSessions.size).toBe(0);
    });
  });

  test("a Run answered near its idle deadline still completes the turn", async () => {
    const adapter = createCursorAdapter();

    await withFakeTimers(async (clock) => {
      const { callId, stream } = await openRunAwaitingToolCall(adapter);
      expect(cursorRunSessions.size).toBe(1);

      // Almost the whole TTL passes, then the client answers: the answer must
      // not land on a Run the expiry reaper has already torn down.
      await clock.advance(RUN_IDLE_TTL_MS - 1);
      expect(cursorRunSessions.size).toBe(1);

      stream.push(turnEndedFrame());
      const resumed = await collect(
        adapter,
        continuationRequest(callId),
        continuationHarness(scopeOf(), stream),
      );
      expect(resumed.error).toBeUndefined();
      // The turn ended, so the Run was torn down rather than left to expire.
      expect(cursorRunSessions.size).toBe(0);
      expect(stream.closes.length).toBe(1);
    });
  });
});

describe("Cursor host tool execution", () => {
  test("a shell exec is executed locally and answered with a shell_result frame", async () => {
    const adapter = createCursorAdapter();
    const stream = new FakeStream([shellExecFrame(5, "echo hi")]);
    stream.endBody();
    const opened = await collect(adapter, requestWithTools([LOOKUP_TOOL]), harnessWith([], scopeOf(), undefined, stream));
    expect(opened.error).toBeUndefined();
    expect(opened.events.some((event) => event.type === "tool_call_delta")).toBe(false);
    expect(cursorRunSessions.size).toBe(0);
    // The native exec is answered in-band with a typed shell_result — not a
    // refusal, and not a relayed tool call.
    const answered = stream.messages().find((message) => message["exec_client_message"] !== undefined);
    expect(answered).toBeDefined();
    const exec = answered?.["exec_client_message"] as Record<string, unknown>;
    expect(exec["shell_result"]).toBeDefined();
    expect(JSON.stringify(exec["shell_result"])).toContain("echo hi");
  });

  test("a shell frame with a declared shell tool is still executed locally, not relayed", async () => {
    // The old behaviour relayed declared host tools to the client; the executor
    // now answers them in-band regardless of client tool declarations.
    const adapter = createCursorAdapter();
    const stream = new FakeStream([shellExecFrame(5, "echo hi")]);
    stream.endBody();
    const opened = await collect(adapter, requestWithTools([SHELL_TOOL]), harnessWith([], scopeOf(), undefined, stream));
    expect(opened.error).toBeUndefined();
    expect(opened.events.some((event) => event.type === "tool_call_delta")).toBe(false);
    const answered = stream.messages().find((message) => message["exec_client_message"] !== undefined);
    expect(answered).toBeDefined();
    const exec = answered?.["exec_client_message"] as Record<string, unknown>;
    expect(exec["shell_result"]).toBeDefined();
  });
});
