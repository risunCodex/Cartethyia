/**
 * Cursor Run hardening, adapted from oh-my-pi.
 *
 * The four tool-loop failures these lock down: a model-not-found retried five
 * times, an HTTP/2 block retried as HTTP/2, a completed tool call re-sent after
 * a checkpoint, and a step that waits out its heartbeats after the server has
 * already counted every call. Plus the drain and settlement primitives that
 * make both exits of a stream safe.
 */
import { describe, expect, test } from "bun:test";
import { GatewayError } from "../../src/protocol/gateway-error";
import {
  classifyCursorFailure,
  createCheckpointState,
  createRunCompletion,
  cursorQuietError,
  drainInFlightDispatches,
  frameShapeOf,
  reconcileToolCount,
  topLevelFieldNumbers,
} from "../../src/providers/integrations/cursor/cursor-hardening";
import { isH2BlockedOpen, openRetryDelayMs, isRetryableOpenFailure } from "../../src/providers/integrations/cursor/cursor-http2";

describe("Cursor failure classification", () => {
  test("a model-not-found is terminal, never retried", () => {
    const c = classifyCursorFailure(new Error("Connect error not_found: AI Model Not Found"), "http2");
    expect(c.kind).toBe("model_not_found");
    expect(c.retryable).toBe(false);
    expect(c.fallbackH1).toBe(false);
  });

  test("quota exhaustion is terminal, not a transport retry", () => {
    const c = classifyCursorFailure(
      new GatewayError("quota_exceeded", 429, "resource exhausted", {}, "upstream"),
      "http2",
    );
    expect(c.kind).toBe("resource_exhausted");
    expect(c.retryable).toBe(false);
  });

  test("an HTTP/2 block falls back to HTTP/1.1 instead of retrying HTTP/2", () => {
    const c = classifyCursorFailure(new Error("nghttp2: protocol error / RST_STREAM"), "http2");
    expect(c.kind).toBe("h2_blocked");
    expect(c.fallbackH1).toBe(true);
    expect(c.retryable).toBe(true);
  });

  test("a conversation conflict rotates the conversation on retry", () => {
    const c = classifyCursorFailure(new Error("AgentStoreConflictError: conversation stale"), "http1");
    expect(c.kind).toBe("conversation_rejected");
    expect(c.rotateConversation).toBe(true);
  });

  test("open retries are bounded and never applied to auth/quota refusals", () => {
    expect(isRetryableOpenFailure(new GatewayError("authentication_failed", 401, "no"))).toBe(false);
    expect(isRetryableOpenFailure(new GatewayError("quota_exceeded", 429, "no"))).toBe(false);
    expect(isRetryableOpenFailure(new Error("ECONNRESET"))).toBe(true);
    expect([0, 1, 2, 3, 4, 5].map(openRetryDelayMs)).toEqual([500, 1000, 2000, 4000, 8000, 8000]);
    expect(isH2BlockedOpen(Object.assign(new Error("HTTP/2 protocol error"), { code: "ERR_HTTP2_PROTOCOL_ERROR" }))).toBe(true);
    expect(isH2BlockedOpen(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }))).toBe(false);
  });
});

describe("Cursor checkpoint / tool count", () => {
  test("a step ends when the server's count covers the dispatched calls", () => {
    const cp = createCheckpointState();
    cp.dispatchedCount = 2;
    cp.pendingCallIds.add("a");
    cp.pendingCallIds.add("b");
    cp.completedCallIds.add("a");
    const r = reconcileToolCount(cp, 2);
    expect(r.endStep).toBe(true);
    expect(r.resend).toEqual(["b"]);
  });

  test("calls the server already counted are never re-submitted", () => {
    const cp = createCheckpointState();
    cp.pendingCallIds.add("a");
    cp.completedCallIds.add("a");
    expect(reconcileToolCount(cp, 1).resend).toEqual([]);
  });

  test("a quiet Run names its checkpoint, step and preceding kinds", () => {
    const cp = createCheckpointState();
    cp.index = 4;
    cp.step = 2;
    cp.streak = 3;
    Object.assign(cp, { kinds: ["exec_server_message", "interaction_update"] });
    const error = cursorQuietError(cp);
    expect(error.message).toContain("checkpoint 4");
    expect(error.message).toContain("step checkpoint #2");
    expect(error.message).toContain("3 in a row");
    expect(error.message).toContain("exec_server_message, interaction_update");
    expect(classifyCursorFailure(error, "http2").kind).toBe("quiet");
  });

  test("wire traces carry shape only: kind, field numbers, size", () => {
    const bytes = new Uint8Array([0x0a, 0x02, 0x08, 0x01, 0x12, 0x01, 0x00]);
    const shape = frameShapeOf({ interaction_update: { heartbeat: {} }, __bytes: bytes });
    expect(shape.kind).toBe("interaction_update");
    expect(shape.fields).toEqual([1, 2]);
    expect(shape.size).toBe(7);
    expect(JSON.stringify(shape)).not.toContain("heartbeat");
    expect(topLevelFieldNumbers(bytes)).toEqual([1, 2]);
  });
});

describe("Cursor stream settlement and drain", () => {
  test("a Run settles only once; late end/error events are no-ops", async () => {
    const completion = createRunCompletion();
    expect(completion.settle("end")).toBe(true);
    expect(completion.settle("error")).toBe(false);
    expect(await completion.promise).toBe("end");
  });

  test("in-flight dispatches drain on both exits, including ones spawned late", async () => {
    const dispatches = new Set<Promise<void>>();
    const order: number[] = [];
    const first = (async () => {
      await Promise.resolve();
      order.push(1);
      const nested = (async () => {
        await Promise.resolve();
        order.push(2);
      })();
      dispatches.add(nested);
      void nested.finally(() => dispatches.delete(nested));
    })();
    dispatches.add(first);
    void first.finally(() => dispatches.delete(first));
    await drainInFlightDispatches(dispatches);
    expect(order).toEqual([1, 2]);
    expect(dispatches.size).toBe(0);
  });

  test("an aborted caller does not wait out a hung exec handler", async () => {
    const dispatches = new Set<Promise<void>>();
    const ac = new AbortController();
    const hung = new Promise<void>(() => undefined);
    dispatches.add(hung);
    ac.abort();
    await drainInFlightDispatches(dispatches, ac.signal);
    expect(true).toBe(true);
  });
});
