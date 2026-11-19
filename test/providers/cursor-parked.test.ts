/**
 * Cursor parked-run resume contract.
 *
 * The invariants under test:
 * 1. A parked run resumes in-band only when ALL THREE conditions hold: same
 *    model, same wire model id, same conversation — and the results cover the
 *    held calls exactly (no missing, no extra, no duplicates). A partial
 *    result set would leave a call unpaired, and "an unpaired call is
 *    stripped from every rebuilt transcript".
 * 2. A parked run is never leaked: replaced, released, or idle-deadlined
 *    runs all tear their transport down; a second park for one conversation
 *    aborts the first.
 */
import { describe, expect, test } from "bun:test";
import {
  canResumeParkedRun,
  CursorParkedRegistry,
  CURSOR_PARKED_IDLE_MS,
  type CursorParkedItem,
  type CursorParkedRun,
  type ParkedRunResults,
} from "../../src/providers/integrations/cursor/cursor-parked";
import type { CursorRunTransport, CursorTransportEvent } from "../../src/providers/integrations/cursor/cursor-run-transport";
import { CursorToolRelay, type RelayedToolCall } from "../../src/providers/integrations/cursor/cursor-relay";

function fakeTransport(aborts: string[]): CursorRunTransport {
  return {
    carrier: "http2",
    events: (async function* (): AsyncGenerator<CursorTransportEvent> {
      // never yields: the parked run sits paused
    })(),
    async write(): Promise<void> {},
    end(): void {},
    abort(reason?: unknown): void {
      aborts.push(String(reason));
    },
  };
}

function parked(overrides: Partial<CursorParkedRun> = {}, aborts: string[] = []): CursorParkedRun {
  const calls: RelayedToolCall[] = [
    { callId: "call-1", toolName: "deploy", args: {} },
    { callId: "call-2", toolName: "deploy", args: {} },
  ];
  return {
    conversationId: "conv-1",
    wireModelId: "claude-opus-5",
    modelKey: "claude-opus-5-high",
    calls,
    transport: fakeTransport(aborts),
    iterator: (async function* (): AsyncGenerator<CursorParkedItem> {})(),
    relay: new CursorToolRelay([], { onToolCall: () => undefined }),
    parkedAt: 1_000,
    ...overrides,
  };
}

function request(overrides: Partial<ParkedRunResults> = {}): ParkedRunResults {
  return {
    conversationId: "conv-1",
    wireModelId: "claude-opus-5",
    modelKey: "claude-opus-5-high",
    results: [
      { callId: "call-1", content: "ok", isError: false },
      { callId: "call-2", content: "ok", isError: false },
    ],
    ...overrides,
  };
}

describe("Cursor parked run — resume contract", () => {
  test("an exact match resumes in-band", () => {
    expect(canResumeParkedRun(parked(), request())).toBe(true);
  });

  test("a different conversation never resumes (results would land on the wrong turn)", () => {
    expect(canResumeParkedRun(parked(), request({ conversationId: "conv-2" }))).toBe(false);
  });

  test("a different wire model id never resumes", () => {
    expect(canResumeParkedRun(parked(), request({ wireModelId: "grok-4.7" }))).toBe(false);
  });

  test("a different routed model never resumes", () => {
    expect(canResumeParkedRun(parked(), request({ modelKey: "grok-4.7" }))).toBe(false);
  });

  test("a partial result set never resumes (the missing call would stay unpaired)", () => {
    expect(
      canResumeParkedRun(
        parked(),
        request({ results: [{ callId: "call-1", content: "ok", isError: false }] }),
      ),
    ).toBe(false);
  });

  test("extra or duplicate results never resume", () => {
    expect(
      canResumeParkedRun(
        parked(),
        request({
          results: [
            { callId: "call-1", content: "ok", isError: false },
            { callId: "call-1", content: "ok", isError: false }, // duplicate
          ],
        }),
      ),
    ).toBe(false);
  });

  test("an errored result still counts as an answer (isError is content, not absence)", () => {
    expect(
      canResumeParkedRun(
        parked(),
        request({
          results: [
            { callId: "call-1", content: "boom", isError: true },
            { callId: "call-2", content: "ok", isError: false },
          ],
        }),
      ),
    ).toBe(true);
  });
});

describe("Cursor parked registry — lifecycle", () => {
  // The park-time idle sweep runs on the same toy clock as the fixtures:
  // every park in these tests passes an explicit `now` at t=1000, when the
  // t=1000 fixture is fresh.
  test("peek returns the live run and consume removes it", () => {
    const registry = new CursorParkedRegistry();
    const run = parked();
    registry.park(run, 1_000);
    expect(registry.size).toBe(1);
    expect(registry.peek("conv-1", 1_500)).toBe(run);
    expect(registry.consume("conv-1")).toBe(run);
    expect(registry.size).toBe(0);
    expect(registry.consume("conv-1")).toBeUndefined();
  });

  test("a second park for one conversation aborts the first stream", () => {
    const aborts: string[] = [];
    const registry = new CursorParkedRegistry();
    registry.park(parked({}, aborts), 1_000);
    registry.park(parked({}, aborts), 1_000);
    expect(aborts).toEqual(["replaced by a new parked run"]);
    expect(registry.size).toBe(1);
  });

  test("a park sweeps entries past the idle deadline — no same-key peek required", () => {
    const aborts: string[] = [];
    const registry = new CursorParkedRegistry();
    registry.park(parked({}, aborts), 1_000);
    // A different conversation parks later: the expired entry — whose caller
    // never peeks its key again — is torn down together with its lease.
    registry.park(parked({ conversationId: "conv-2" }, aborts), 1_000 + CURSOR_PARKED_IDLE_MS + 1);
    expect(aborts).toEqual(["parked run idle deadline"]);
    expect(registry.size).toBe(1);
  });

  test("an idle-deadline run is released lazily and aborts its transport", () => {
    const aborts: string[] = [];
    const registry = new CursorParkedRegistry();
    registry.park(parked({}, aborts), 1_000);
    // Past the deadline: the entry is gone and the stream is torn down.
    expect(registry.peek("conv-1", 1_000 + CURSOR_PARKED_IDLE_MS + 1)).toBeUndefined();
    expect(aborts).toEqual(["parked run idle deadline"]);
  });

  test("release without resuming tears the stream down", () => {
    const aborts: string[] = [];
    const registry = new CursorParkedRegistry();
    registry.park(parked({}, aborts), 1_000);
    registry.release("conv-1", "request rebuilt instead");
    expect(aborts).toEqual(["request rebuilt instead"]);
    expect(registry.size).toBe(0);
  });
});
