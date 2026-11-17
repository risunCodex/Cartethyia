/**
 * Cursor Run transport + turn policy.
 *
 * The invariants under test:
 * 1. A terminal Connect frame with the END_STREAM flag carries the JSON error
 *    envelope *inside* the HTTP 200 stream; decoding yields a policy, not an
 *    exception, and the base64 `aiserver.v1.ErrorDetails` decides
 *    retryability (the prose message alone cannot).
 * 2. The turn loop never replays a partially delivered answer: once the sink
 *    reports progress, a failure is final. The three escapes (h1 fallback,
 *    discovered-id retry, conversation rotation) fire only before progress,
 *    and rotation happens at most once per turn.
 * 3. Heartbeats are not semantic progress: a stream of heartbeats can still
 *    end incomplete and retryable.
 */
import { describe, expect, test } from "bun:test";
import { encodeFrame, CONNECT_END_STREAM_FLAG } from "../../src/providers/integrations/shared/connect";
import { encodeMessage } from "../../src/providers/integrations/cursor/cursor-protocol/messages";
import {
  decodeCursorEndStream,
  decodeCursorEndStreamBytes,
} from "../../src/providers/integrations/cursor/cursor-errors";
import {
  openHttp2RunTransport,
  type CursorTransportEvent,
} from "../../src/providers/integrations/cursor/cursor-run-transport";
import { runCursorTurn } from "../../src/providers/integrations/cursor/cursor-run";
import type { ValidatedHttp2BidiStream, Http2BidiEndReason, ValidatedOutboundHttp2Bidi } from "../../src/network/bidi";

// ── helpers: a scripted bidi stream over the kept egress contract ──

function fakeStream(chunks: Uint8Array[]): ValidatedHttp2BidiStream & { writes: Uint8Array[] } {
  const writes: Uint8Array[] = [];
  const listeners: Array<(reason: Http2BidiEndReason) => void> = [];
  const body = (async function* () {
    for (const chunk of chunks) yield chunk;
    for (const listener of listeners) listener({ kind: "remote-clean-close" });
  })();
  return {
    response: { status: 200, headers: {} },
    trailers: {},
    body,
    writes,
    async write(chunk: Uint8Array): Promise<void> {
      writes.push(chunk);
    },
    end(): void {},
    abort(): void {},
    onTerminal(listener): () => void {
      listeners.push(listener);
      return () => undefined;
    },
  };
}

function serverFrame(message: Record<string, unknown>, compress = false): Uint8Array {
  return encodeFrame(encodeMessage("agent.v1.AgentServerMessage", message), compress);
}

function endStreamFrame(trailer: Record<string, unknown>): Uint8Array {
  return taggedEnd(new TextEncoder().encode(JSON.stringify(trailer)));
}

/** End-of-stream frames need the END_STREAM flag; encodeFrame never sets it. */
function taggedEnd(payload: Uint8Array): Uint8Array {
  const header = Buffer.alloc(5);
  header[0] = CONNECT_END_STREAM_FLAG;
  header.writeUInt32BE(payload.byteLength, 1);
  return Buffer.concat([header, Buffer.from(payload)]);
}

async function collectEvents(stream: ValidatedHttp2BidiStream): Promise<CursorTransportEvent[]> {
  const transport = openHttp2RunTransport(stream);
  const events: CursorTransportEvent[] = [];
  for await (const event of transport.events) events.push(event);
  return events;
}

describe("Cursor Run transport — frame decode", () => {
  test("server messages decode; the END_STREAM envelope surfaces as a failure", async () => {
    const failureEnvelope = {
      error: {
        code: "resource_exhausted",
        message: "You've hit your free requests limit",
        details: [],
      },
    };
    const events = await collectEvents(
      fakeStream([
        serverFrame({ interactionUpdate: { textDelta: { text: "hi" } } }),
        endStreamFrame(failureEnvelope),
      ]),
    );
    expect(events.length).toBe(2);
    expect(events[0]?.kind).toBe("message");
    const second = events[1];
    expect(second?.kind).toBe("error");
    if (second?.kind === "error") {
      expect(second.failure.policy).toBe("conversation_rejected");
      expect(second.failure.message).toContain("free requests limit");
    }
  });

  test("a clean end-of-stream trailer ends the stream without a failure", async () => {
    const events = await collectEvents(fakeStream([endStreamFrame({})]));
    expect(events.length).toBe(1);
    expect(events[0]?.kind).toBe("end");
  });

  test("compressed frames inflate before decoding", async () => {
    const events = await collectEvents(
      fakeStream([serverFrame({ interactionUpdate: { heartbeat: {} } }, true), endStreamFrame({})]),
    );
    expect(events[0]?.kind).toBe("message");
    if (events[0]?.kind === "message") {
      expect(events[0].message.interactionUpdate?.heartbeat).toBeDefined();
    }
  });
});

describe("Cursor errors — envelope classification", () => {
  test("base64 ErrorDetails decides retryability and the policy", () => {
    // An ErrorDetails{error: ERROR_TIMEOUT (25), details:{is_retryable: true}}.
    const details = encodeMessage("aiserver.v1.ErrorDetails", {
      error: 25,
      details: { detail: "upstream timeout", isRetryable: true },
    });
    const failure = decodeCursorEndStream({
      error: { message: "boom" },
      details: [{ type: "type.googleapis.com/aiserver.v1.ErrorDetails", value: Buffer.from(details).toString("base64") }],
    });
    expect(failure?.policy).toBe("retryable");
    expect(failure?.code).toBe(25);
    expect(failure?.name).toBe("ERROR_TIMEOUT");
    expect(failure?.upstreamRetryable).toBe(true);
    expect(failure?.message).toContain("upstream timeout");
  });

  test("auth codes are terminal for the credential", () => {
    const details = encodeMessage("aiserver.v1.ErrorDetails", { error: 12 });
    const failure = decodeCursorEndStream({
      error: { message: "token expired" },
      details: [{ type: "aiserver.v1.ErrorDetails", value: Buffer.from(details).toString("base64") }],
    });
    expect(failure?.policy).toBe("auth");
  });

  test("BAD_MODEL_NAME / not_found maps to the model fallback policy", () => {
    const details = encodeMessage("aiserver.v1.ErrorDetails", { error: 5 });
    const failure = decodeCursorEndStream({
      error: { message: "Connect error not_found: model gone" },
      details: [{ type: "aiserver.v1.ErrorDetails", value: Buffer.from(details).toString("base64") }],
    });
    expect(failure?.policy).toBe("model_not_found");
  });

  test("a message that names resource_exhausted poisons the conversation", () => {
    const failure = decodeCursorEndStream({
      error: { code: "resource_exhausted", message: "resource_exhausted" },
    });
    expect(failure?.policy).toBe("conversation_rejected");
  });

  test("bytes entry point matches the object entry point", () => {
    const payload = new TextEncoder().encode(JSON.stringify({ error: { message: "gone" } }));
    const failure = decodeCursorEndStreamBytes(payload);
    expect(failure?.message).toContain("gone");
  });
});

// ── turn policy ──

function turnDialer(chunks: Uint8Array[]): ValidatedOutboundHttp2Bidi {
  return async () => fakeStream(chunks);
}

function failingDialer(message: string): ValidatedOutboundHttp2Bidi {
  return async () => {
    throw new Error(message);
  };
}

describe("Cursor Run turn — retry policy", () => {
  test("a clean turn ends on turn_ended without retries", async () => {
    const result = await runCursorTurn({
      accessToken: "tok",
      buildRequest: () => ({ conversationId: "c1" }),
      sink: { onMessage: () => ({ progress: true }) },
      http2: turnDialer([
        serverFrame({ interactionUpdate: { textDelta: { text: "answer" } } }),
        serverFrame({ interactionUpdate: { turnEnded: { outputTokens: 1 } } }),
        endStreamFrame({}),
      ]),
      fetch: (async () => new Response("unused")) as unknown as typeof fetch,
      conversationId: "c1",
    });
    expect(result.status).toBe("turn-ended");
    expect(result.attempts).toBe(1);
  });

  test("a cut stream before any output retries; after progress it is final", async () => {
    // No output at all, stream just ends: incomplete → retryable → new attempt.
    let opens = 0;
    const dialer: ValidatedOutboundHttp2Bidi = async () => {
      opens += 1;
      return fakeStream([]); // ends immediately without turn_ended
    };
    const result = await runCursorTurn({
      accessToken: "tok",
      buildRequest: () => ({}),
      sink: { onMessage: () => undefined },
      http2: dialer,
      fetch: (async () => new Response("unused")) as unknown as typeof fetch,
      retryBaseMs: 1,
    });
    expect(result.status).toBe("failed");
    expect(opens).toBeGreaterThan(1); // it retried
    if (result.status === "failed") {
      expect(result.failure.policy).toBe("retryable");
    }
  });

  test("progress forbids replay: a failure after delivered output is final", async () => {
    let opens = 0;
    const dialer: ValidatedOutboundHttp2Bidi = async () => {
      opens += 1;
      return fakeStream([
        serverFrame({ interactionUpdate: { textDelta: { text: "partial" } } }),
        endStreamFrame({ error: { message: "boom" } }),
      ]);
    };
    const result = await runCursorTurn({
      accessToken: "tok",
      buildRequest: () => ({}),
      sink: { onMessage: () => ({ progress: true }) },
      http2: dialer,
      fetch: (async () => new Response("unused")) as unknown as typeof fetch,
    });
    expect(opens).toBe(1);
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.attempts).toBe(1);
    }
  });

  test("a blocked h2 path falls back to the h1 carrier for the whole turn", async () => {
    const h2 = failingDialer("ALPN: h2 is not supported");
    const fetchCalls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      fetchCalls.push(url);
      if (url.endsWith("/agent.v1.AgentService/RunSSE")) {
        return new Response("no", { status: 500 });
      }
      return new Response("ok");
    }) as unknown as typeof fetch;
    const result = await runCursorTurn({
      accessToken: "tok",
      buildRequest: () => ({}),
      sink: { onMessage: () => undefined },
      http2: h2,
      fetch: fetchImpl,
      retryBaseMs: 1,
    });
    // The turn moved to h1: at least one RunSSE attempt happened.
    expect(fetchCalls.some((url) => url.endsWith("/agent.v1.AgentService/RunSSE"))).toBe(true);
    expect(result.status).toBe("failed");
  });

  test("conversation rotation happens at most once per turn", async () => {
    const seenConversationIds: string[] = [];
    let opens = 0;
    const dialer: ValidatedOutboundHttp2Bidi = async () => {
      opens += 1;
      return fakeStream([
        endStreamFrame({ error: { code: "resource_exhausted", message: "resource_exhausted" } }),
      ]);
    };
    const result = await runCursorTurn({
      accessToken: "tok",
      buildRequest: (state) => {
        seenConversationIds.push(state.conversationId);
        return {};
      },
      sink: { onMessage: () => undefined },
      http2: dialer,
      fetch: (async () => new Response("unused")) as unknown as typeof fetch,
      conversationId: "original",
    });
    // original + exactly one rotation, then terminal (no more rotations).
    expect(new Set(seenConversationIds).size).toBe(2);
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.failure.policy).toBe("conversation_rejected");
    }
    expect(opens).toBe(2);
  });

  test("heartbeats never count as progress", async () => {
    const dialer: ValidatedOutboundHttp2Bidi = async () =>
      fakeStream([
        serverFrame({ interactionUpdate: { heartbeat: {} } }),
        serverFrame({ interactionUpdate: { heartbeat: {} } }),
      ]); // ends without turn_ended
    let heartbeatFrames = 0;
    const result = await runCursorTurn({
      accessToken: "tok",
      buildRequest: () => ({}),
      sink: {
        onMessage: (message) => {
          // Heartbeats reach the sink (the relay uses them as quiet-timer
          // ticks to hand off a held tool batch) but the loop must ignore
          // their progress answer — even a sink that always claims progress
          // cannot make a heartbeat semantic.
          if (message.interactionUpdate?.heartbeat !== undefined) heartbeatFrames += 1;
          return { progress: true };
        },
      },
      http2: dialer,
      fetch: (async () => new Response("unused")) as unknown as typeof fetch,
      retryBaseMs: 1,
    });
    // Every attempt re-delivers the same two heartbeats; the incomplete
    // stream is retryable, so the retry loop re-opens and sees them again.
    expect(heartbeatFrames).toBeGreaterThanOrEqual(2);
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      // No semantic progress → the incomplete stream is retryable, not terminal.
      expect(result.failure.policy).toBe("retryable");
    }
  });
});

describe("Cursor error envelope — transport cuts", () => {
  test("a bare internal envelope is retryable (the proxy's own stream cut)", () => {
    // Live 2026-11-17: a multi-tool-round continuation died mid-turn with
    // {"error":{"code":"internal","message":"premature EOF"}} while frames
    // were still flowing — a cut in envelope clothing, not a verdict.
    const failure = decodeCursorEndStream({
      error: { code: "internal", message: "premature EOF" },
    });
    expect(failure?.policy).toBe("retryable");
    expect(failure?.message).toBe("premature EOF");
  });

  test("a semantic envelope keeps its policy (internal is not applied)", () => {
    const failure = decodeCursorEndStream({
      error: { code: "resource_exhausted", message: "Error" },
    });
    expect(failure?.policy).toBe("conversation_rejected");
  });
});
