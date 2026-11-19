/**
 * Cursor adapter dispatch — the tool-loop boundary, against a scripted bidi
 * stream and the production codec (no sockets, no network).
 *
 * The invariants under test:
 * 1. A fresh tool round surfaces the held call once and parks with a
 *    `usage_deferred` tool-use terminal — the upstream turn is still open, so
 *    the interim response must not be estimated and billed as a finished turn.
 * 2. A follow-up request ending on PURE tool results resumes the same run
 *    in-band (one upstream stream across the loop) and delivers the result
 *    into the held exec frame; usage arrives from the resumed `turn_ended`.
 * 3. A Messages-origin mixed turn — `tool_result` blocks and follow-up text
 *    in ONE user turn — must NOT resume (the held run would never see the
 *    text): the park is superseded, a fresh run rebuilds from history, and
 *    the superseded stream's still-held calls are paired with error answers.
 * 4. The conversation identity survives across requests of one stateless
 *    caller (inbound session headers here), because the parked-run key is
 *    minted from the cross-surface session resolver, not a per-request UUID.
 */
import { describe, expect, test } from "bun:test";
import { CONNECT_END_STREAM_FLAG, decodeFrame, encodeFrame } from "../../src/providers/integrations/shared/connect";
import { decodeMessage, encodeMessage } from "../../src/providers/integrations/cursor/cursor-protocol/messages";
import { cursorAdapter, toCursorHistory } from "../../src/providers/integrations/cursor/cursor";
import {
  buildRootPromptMessages,
  CursorBlobStore,
  type CursorHistoryMessage,
} from "../../src/providers/integrations/cursor/cursor-history";
import type { CanonicalEvent, CanonicalRequest } from "../../src/protocol/canonical-model";
import type { ProviderDispatchContext, ProviderDispatchTarget } from "../../src/providers/provider-contracts";
import type { Http2BidiEndReason, ValidatedHttp2BidiStream, ValidatedOutboundHttp2Bidi } from "../../src/network/bidi";

// ── helpers ──

interface FakeStream extends ValidatedHttp2BidiStream {
  readonly writes: Uint8Array[];
  /** Feeds one server frame into the response body. */
  push(chunk: Uint8Array): void;
  /** Ends the response body (clean remote close). */
  closeBody(): void;
}

/** A bidi stream whose response body is fed by the test, phase by phase. */
function pushableStream(): FakeStream {
  const writes: Uint8Array[] = [];
  const pending: Uint8Array[] = [];
  const waiters: Array<(value: IteratorResult<Uint8Array>) => void> = [];
  const listeners: Array<(reason: Http2BidiEndReason) => void> = [];
  let closed = false;
  const body: AsyncIterableIterator<Uint8Array> = {
    [Symbol.asyncIterator]: () => body,
    async next(): Promise<IteratorResult<Uint8Array>> {
      const chunk = pending.shift();
      if (chunk !== undefined) return { value: chunk, done: false };
      if (closed) return { value: undefined, done: true };
      return await new Promise((resolve) => waiters.push(resolve));
    },
  };
  const deliver = (value: IteratorResult<IteratorResult<Uint8Array>>): void => {
    while (waiters.length > 0) {
      const waiter = waiters.shift();
      if (waiter !== undefined) waiter(value as IteratorResult<Uint8Array>);
    }
  };
  return {
    response: { status: 200, headers: {} },
    trailers: {},
    body,
    writes,
    push(chunk: Uint8Array): void {
      if (closed) return;
      const waiter = waiters.shift();
      if (waiter !== undefined) waiter({ value: chunk, done: false });
      else pending.push(chunk);
    },
    closeBody(): void {
      closed = true;
      deliver({ value: undefined, done: true });
      for (const listener of listeners) listener({ kind: "remote-clean-close" });
    },
    async write(chunk: Uint8Array): Promise<void> {
      writes.push(chunk);
    },
    end(): void {},
    abort(): void {},
    onTerminal(listener: (reason: Http2BidiEndReason) => void): () => void {
      listeners.push(listener);
      return () => undefined;
    },
  };
}

function serverFrame(message: Record<string, unknown>): Uint8Array {
  return encodeFrame(encodeMessage("agent.v1.AgentServerMessage", message), false);
}

function endStreamFrame(): Uint8Array {
  const payload = new TextEncoder().encode("{}");
  const header = Buffer.alloc(5);
  header[0] = CONNECT_END_STREAM_FLAG;
  header.writeUInt32BE(payload.byteLength, 1);
  return Buffer.concat([header, payload]);
}

function decodedWrites(stream: FakeStream): Record<string, unknown>[] {
  return stream.writes.map((chunk) => {
    const frame = decodeFrame(Buffer.from(chunk));
    return decodeMessage<Record<string, unknown>>("agent.v1.AgentClientMessage", frame.payload);
  });
}

interface DialerPhases {
  dialer: ValidatedOutboundHttp2Bidi;
  opened: FakeStream[];
}

/**
 * A dialer whose Nth open returns a fresh stream and immediately serves it —
 * frames buffered before the reader starts are drained in order.
 */
function phasedDialer(serve: (stream: FakeStream, phase: number) => void): DialerPhases {
  const opened: FakeStream[] = [];
  let phase = 0;
  const dialer: ValidatedOutboundHttp2Bidi = async () => {
    phase += 1;
    const stream = pushableStream();
    opened.push(stream);
    serve(stream, phase);
    return stream;
  };
  return { dialer, opened };
}

function context(dialer: ValidatedOutboundHttp2Bidi, sessionHeader: string): ProviderDispatchContext {
  return {
    credential: {
      provider_id: "cursor" as never,
      credential_kind: "api_key",
      secret: new TextEncoder().encode("sk-cursor-test"),
      account_id: "acct-1",
    } as never,
    deadline: Date.now() + 60_000,
    abort_signal: new AbortController().signal,
    outbound_fetch: (async () => {
      throw new Error("roster unavailable in test");
    }) as never,
    outbound_http2: dialer,
    request_headers: { "x-opencode-session": sessionHeader },
    lease_ownership: {
      transferToProviderSession: () => () => undefined,
    },
  } as ProviderDispatchContext;
}

const target: ProviderDispatchTarget = {
  provider_id: "cursor" as never,
  model_id: "test-model",
  wire_family: "chat" as never,
  endpoint_path: "/agent.v1.AgentService/Run",
  capabilities: {},
};

const WEATHER_ARGS = { city: "Paris" };

function request(messages: CanonicalRequest["messages"]): CanonicalRequest {
  return {
    model: "test-model",
    system: [{ kind: "text", text: "You are helpful." }],
    messages,
    tools: [
      {
        name: "get_weather",
        description: "weather lookup",
        jsonSchema: { type: "object", properties: { city: { type: "string" } } },
      },
    ],
    generation_controls: {},
    stream: true,
    source_surface: "chat",
  };
}

/** The server half of one parkable tool round: probe, call, declared batch. */
function serveToolRound(stream: FakeStream, callId: string): void {
  stream.push(
    serverFrame({
      execServerMessage: { id: 1, execId: "exec-ctx", requestContextArgs: {} },
    }),
  );
  stream.push(
    serverFrame({
      execServerMessage: {
        id: 2,
        execId: "exec-call",
        mcpArgs: {
          name: "get_weather",
          toolName: "get_weather",
          toolCallId: callId,
          args: { city: new TextEncoder().encode(JSON.stringify(WEATHER_ARGS.city)) },
        },
      },
    }),
  );
  stream.push(
    serverFrame({ interactionUpdate: { toolRequestsListed: { callCount: 1 } } }),
  );
}

/** The server half of a quiet text turn that ends the run. */
function serveTextTurn(stream: FakeStream, text: string): void {
  stream.push(serverFrame({ interactionUpdate: { textDelta: { text } } }));
  stream.push(
    serverFrame({ interactionUpdate: { turnEnded: { inputTokens: 10, outputTokens: 5 } } }),
  );
  stream.push(endStreamFrame());
}

async function collect(generator: AsyncGenerator<CanonicalEvent>): Promise<CanonicalEvent[]> {
  const events: CanonicalEvent[] = [];
  for await (const event of generator) events.push(event);
  return events;
}

const WEATHER_TURN: CanonicalRequest["messages"] = [
  { role: "user", content: [{ kind: "text", text: "weather in Paris?" }] },
];

const MIXED_TURN: CanonicalRequest["messages"] = [
  ...WEATHER_TURN,
  {
    role: "assistant",
    content: [
      { kind: "toolCall", call_id: "call_1", name: "get_weather", arguments: WEATHER_ARGS },
    ],
  },
  {
    role: "user",
    content: [
      { kind: "toolResult", call_id: "call_1", content: "sunny" },
      { kind: "text", text: "now what?" },
    ],
  },
];

// ── tests ──

describe("Cursor dispatch — the tool loop across requests", () => {
  test("a fresh round parks: the call surfaces once and the terminal defers usage", async () => {
    const { dialer, opened } = phasedDialer((stream) => serveToolRound(stream, "call_1"));

    const events = await collect(
      cursorAdapter.dispatch(request(WEATHER_TURN), target, context(dialer, "sess-fresh")),
    );

    const calls = events.filter((event) => event.type === "tool_call_delta");
    expect(calls.length).toBe(1);
    const call = calls[0] as { call_id?: string; name?: string; arguments_delta?: string };
    expect(call.call_id).toBe("call_1");
    expect(call.name).toBe("get_weather");
    expect(JSON.parse(call.arguments_delta ?? "{}")).toEqual(WEATHER_ARGS);

    const terminal = events.at(-1) as {
      type: string;
      state?: string;
      stop_reason?: string;
      usage_deferred?: true;
    };
    expect(terminal.type).toBe("terminal");
    expect(terminal.state).toBe("complete");
    expect(terminal.stop_reason).toBe("tool_use");
    // The upstream turn is still open across the request boundary.
    expect(terminal.usage_deferred).toBe(true);

    // The handshake rode the same stream; the run parked with it open.
    expect(opened.length).toBe(1);
    const written = decodedWrites(opened[0]!);
    expect(
      written.some((message) => {
        const exec = message["execClientMessage"] as
          | { requestContextResult?: { success?: unknown } }
          | undefined;
        return exec?.requestContextResult?.success !== undefined;
      }),
    ).toBe(true);
  });

  test("pure tool results resume the same run in-band and deliver the result", async () => {
    let parkStream: FakeStream | undefined;
    const dialer: ValidatedOutboundHttp2Bidi = async () => {
      if (parkStream !== undefined) throw new Error("no second stream may open on resume");
      parkStream = pushableStream();
      serveToolRound(parkStream, "call_1");
      return parkStream;
    };

    const parkedEvents = await collect(
      cursorAdapter.dispatch(request(WEATHER_TURN), target, context(dialer, "sess-resume")),
    );
    expect((parkedEvents.at(-1) as { stop_reason?: string }).stop_reason).toBe("tool_use");

    // The continuation frames must arrive while the resume consumes the
    // parked queue, not before (a turn ended while parked would tear the
    // pump down), so they ride a timer the resuming dispatch waits past.
    setTimeout(() => {
      parkStream?.push(serverFrame({ interactionUpdate: { textDelta: { text: "sunny in Paris" } } }));
      parkStream?.push(
        serverFrame({ interactionUpdate: { turnEnded: { inputTokens: 10, outputTokens: 5 } } }),
      );
      parkStream?.push(endStreamFrame());
    }, 25);

    const events = await collect(
      cursorAdapter.dispatch(
        request([
          ...WEATHER_TURN,
          {
            role: "assistant",
            content: [
              { kind: "toolCall", call_id: "call_1", name: "get_weather", arguments: WEATHER_ARGS },
            ],
          },
          {
            role: "tool",
            content: [{ kind: "toolResult", call_id: "call_1", content: "sunny" }],
          },
        ]),
        target,
        context(dialer, "sess-resume"),
      ),
    );

    const terminal = events.at(-1) as {
      type: string;
      state?: string;
      stop_reason?: string;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    expect(terminal.type).toBe("terminal");
    expect(terminal.state).toBe("complete");
    expect(terminal.stop_reason).toBe("stop");
    // Usage arrives from the resumed turn's `turn_ended`, not an estimate.
    expect(terminal.usage?.input_tokens).toBe(10);
    expect(terminal.usage?.output_tokens).toBe(5);

    // The result was delivered into the held exec frame of run 1.
    const written = decodedWrites(parkStream!);
    const answered = written.find((message) => {
      const exec = message["execClientMessage"] as { mcpResult?: Record<string, unknown> } | undefined;
      return exec?.mcpResult !== undefined;
    });
    const exec = answered?.["execClientMessage"] as {
      mcpResult?: { success?: { content?: Array<{ text?: { text?: string } }> } };
    };
    expect(exec.mcpResult?.success?.content?.[0]?.text?.text).toBe("sunny");
  });

  test("a mixed tool-result+text turn rebuilds and pairs the superseded stream's held calls", async () => {
    const { dialer, opened } = phasedDialer((stream, phase) => {
      if (phase === 1) serveToolRound(stream, "call_1"); // parks, stays open
      else serveTextTurn(stream, "rebuilt turn");
    });

    const parkedEvents = await collect(
      cursorAdapter.dispatch(request(WEATHER_TURN), target, context(dialer, "sess-mixed")),
    );
    expect((parkedEvents.at(-1) as { stop_reason?: string }).stop_reason).toBe("tool_use");

    const events = await collect(
      cursorAdapter.dispatch(request(MIXED_TURN), target, context(dialer, "sess-mixed")),
    );

    // The mixed turn must NOT resume — the held run would never see the
    // text — so a fresh run rebuilt and completed.
    const terminal = events.at(-1) as { type: string; state?: string; stop_reason?: string };
    expect(terminal.type).toBe("terminal");
    expect(terminal.stop_reason).toBe("stop");
    expect(opened.length).toBe(2);

    // The superseded stream's still-held call was paired at teardown.
    const superseded = decodedWrites(opened[0]!).some((message) => {
      const exec = message["execClientMessage"] as
        | { mcpResult?: { error?: { error?: string } } }
        | undefined;
      return exec?.mcpResult?.error?.error?.includes("closed before this call completed") === true;
    });
    expect(superseded).toBe(true);
  });
});

describe("Cursor dispatch — mixed-turn history pairing (Messages shape)", () => {
  test("a tool_result riding the final user turn reaches the transcript and the text stays live", async () => {
    const contextStub = {
      credential: {
        provider_id: "cursor" as never,
        credential_kind: "api_key" as const,
        secret: new Uint8Array(),
      },
      deadline: 0,
      abort_signal: new AbortController().signal,
    } as unknown as ProviderDispatchContext;
    const { history, active } = await toCursorHistory(request(MIXED_TURN), contextStub);

    // The results answer the assistant call above them; without this record
    // the rebuild refuses the history ("tool call ... has no result").
    const toolRecord = history.find(
      (record): record is Extract<CursorHistoryMessage, { role: "tool" }> => record.role === "tool",
    );
    expect(toolRecord?.toolCallId).toBe("call_1");
    expect(toolRecord?.toolName).toBe("get_weather");

    // Only the text rides the live turn.
    expect(active?.text).toBe("now what?");

    // And the pair builds: this is the throw the pre-fix shape produced.
    const store = new CursorBlobStore();
    expect(() => buildRootPromptMessages(history, store)).not.toThrow();
  });
});
