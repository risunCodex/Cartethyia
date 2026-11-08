import { expect, test } from "bun:test";
import { MessagesStreamEncoder } from "../../../src/transport/surface/messages/stream";
import { stopData } from "../../../src/transport/surface/messages/encode";

function collect(events: Parameters<MessagesStreamEncoder["push"]>[0][]) {
  const enc = new MessagesStreamEncoder();
  const out: unknown[] = [];
  for (const e of events) out.push(...enc.push(e));
  out.push(...enc.finish());
  return out;
}

test("streamed tool arguments arrive as input_json_delta fragments", () => {
  const events = collect([
    { type: "response_start", sequence_number: 1 } as never,
    {
      type: "tool_call_delta",
      sequence_number: 2,
      call_id: "call_1",
      name: "shell",
      arguments_delta: '{"command":',
    } as never,
    {
      type: "tool_call_delta",
      sequence_number: 3,
      call_id: "call_1",
      arguments_delta: '"echo hi"}',
    } as never,
    { type: "terminal", sequence_number: 4, state: "complete" } as never,
  ]);
  const start = events.find((e) => (e as any).type === "content_block_start");
  const deltas = events.filter((e) => (e as any).type === "content_block_delta");
  const toolStart = start as any;
  expect(toolStart.content_block.type).toBe("tool_use");
  expect(toolStart.content_block.name).toBe("shell");
  const partials = deltas
    .map((d) => (d as any).delta.partial_json ?? "")
    .join("");
  expect(JSON.parse(partials)).toEqual({ command: "echo hi" });
});

test("a zero-argument tool call opens the block with input {} and no delta", () => {
  const events = collect([
    { type: "response_start", sequence_number: 1 } as never,
    {
      type: "tool_call_delta",
      sequence_number: 2,
      call_id: "call_1",
      name: "write",
      arguments_delta: "",
    } as never,
    { type: "terminal", sequence_number: 3, state: "complete" } as never,
  ]);
  const start = events.find((e) => (e as any).type === "content_block_start") as any;
  expect(start.content_block.type).toBe("tool_use");
  expect(start.content_block.input).toEqual({});
  const deltas = events.filter((e) => (e as any).type === "content_block_delta");
  expect(deltas).toHaveLength(0);
});

test("an upstream error event emits an error frame, not message_stop", () => {
  const events = collect([
    { type: "response_start", sequence_number: 1 } as never,
    {
      type: "error",
      sequence_number: 2,
      category: "upstream",
      message: "Devin stream error permission_denied: an internal error occurred",
      retryable: false,
    } as never,
    {
      type: "terminal",
      sequence_number: 3,
      state: "aborted",
      stop_reason: "error",
    } as never,
  ]);
  expect(events.some((e) => (e as any).type === "message_stop")).toBe(false);
  const err = events.find((e) => (e as any).type === "error") as any;
  expect(err.error.type).toBe("server_error");
  expect(String(err.error.message)).toContain("permission_denied");
});

test("a client-aborted terminal without an error event stays message_stop", () => {
  const events = collect([
    { type: "response_start", sequence_number: 1 } as never,
    { type: "terminal", sequence_number: 2, state: "aborted" } as never,
  ]);
  expect(events.some((e) => (e as any).type === "error")).toBe(false);
  expect(events.some((e) => (e as any).type === "message_stop")).toBe(true);
});

test("stopData marks an aborted terminal with an error event as failed", () => {
  const { failed } = stopData([
    { type: "response_start", sequence_number: 1 } as never,
    {
      type: "error",
      sequence_number: 2,
      category: "upstream",
      message: "boom",
      retryable: false,
    } as never,
    { type: "terminal", sequence_number: 3, state: "aborted", stop_reason: "error" } as never,
  ]);
  expect(failed).toBe(true);
});

test("stopData leaves a client aborted terminal without error event as not failed", () => {
  const { failed } = stopData([
    { type: "response_start", sequence_number: 1 } as never,
    { type: "terminal", sequence_number: 2, state: "aborted" } as never,
  ]);
  expect(failed).toBe(false);
});
