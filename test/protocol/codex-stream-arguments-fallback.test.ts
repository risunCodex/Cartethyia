/**
 * Codex stream: complete tool-call arguments when the upstream skips the
 * argument delta frames.
 *
 * The frame processor used to emit `tool_call_delta` events only from
 * `response.function_call_arguments.delta` /
 * `response.custom_tool_call_input.delta`. An upstream that delivers the
 * whole call on the done frames (or only on `response.output_item.done`)
 * produced zero canonical tool events while `hasToolCall` still flipped the
 * terminal to `tool_use` — the client received a dangling `tool_use` stop
 * with no `tool_use` block, which Claude Code reports as "the model's tool
 * call could not be parsed".
 *
 * The done frames now carry the complete arguments as a fallback, guarded so
 * a call that already streamed deltas is never emitted twice.
 *
 * Every fixture here is synthesized; no provider, database, or Redis is used.
 */
import { describe, expect, test } from "bun:test";
import type { CanonicalEvent } from "../../src/protocol/canonical-model";
import { CodexStreamFrameProcessor } from "../../src/protocol/response/codex";

function toolDeltas(events: readonly CanonicalEvent[]) {
  return events.filter(
    (event): event is Extract<CanonicalEvent, { type: "tool_call_delta" }> =>
      event.type === "tool_call_delta",
  );
}

function run(frames: readonly Record<string, unknown>[]): CanonicalEvent[] {
  const processor = new CodexStreamFrameProcessor(2);
  const events: CanonicalEvent[] = [];
  for (const frame of frames) events.push(...processor.process(frame));
  events.push(...processor.preTerminalEvents());
  events.push(processor.terminalEvent());
  return events;
}

const REASONING_FRAMES: Record<string, unknown>[] = [
  {
    type: "response.output_item.added",
    output_index: 0,
    item: { id: "rs_1", type: "reasoning", encrypted_content: "ENC" },
  },
  {
    type: "response.output_item.done",
    output_index: 0,
    item: { id: "rs_1", type: "reasoning", encrypted_content: "ENC" },
  },
];

describe("CodexStreamFrameProcessor argument fallback", () => {
  test("emits the complete arguments from function_call_arguments.done when no deltas were streamed", () => {
    const events = run([
      ...REASONING_FRAMES,
      {
        type: "response.output_item.added",
        output_index: 1,
        item: { id: "fc_1", type: "function_call", call_id: "call_1", name: "Bash", arguments: "" },
      },
      {
        type: "response.function_call_arguments.done",
        item_id: "fc_1",
        output_index: 1,
        arguments: '{"command":"ls"}',
      },
      {
        type: "response.output_item.done",
        output_index: 1,
        item: { id: "fc_1", type: "function_call", call_id: "call_1", name: "Bash", arguments: '{"command":"ls"}' },
      },
      { type: "response.completed", response: { status: "completed", usage: { input_tokens: 1, output_tokens: 1 } } },
    ]);

    const deltas = toolDeltas(events);
    expect(deltas).toHaveLength(1);
    expect(deltas[0]?.call_id).toBe("call_1");
    expect(deltas[0]?.name).toBe("Bash");
    expect(deltas[0]?.arguments_delta).toBe('{"command":"ls"}');
    const terminal = events.at(-1);
    expect(terminal?.type).toBe("terminal");
    expect(terminal?.type === "terminal" ? terminal.stop_reason : undefined).toBe("tool_use");
  });

  test("emits the complete call from output_item.done when no argument frame was streamed at all", () => {
    const events = run([
      ...REASONING_FRAMES,
      {
        type: "response.output_item.done",
        output_index: 1,
        item: { id: "fc_2", type: "function_call", call_id: "call_2", name: "Read", arguments: '{"file_path":"/x"}' },
      },
      { type: "response.completed", response: { status: "completed", usage: { input_tokens: 1, output_tokens: 1 } } },
    ]);

    const deltas = toolDeltas(events);
    expect(deltas).toHaveLength(1);
    expect(deltas[0]?.call_id).toBe("call_2");
    expect(deltas[0]?.name).toBe("Read");
    expect(deltas[0]?.arguments_delta).toBe('{"file_path":"/x"}');
  });

  test("does not duplicate arguments when deltas already streamed", () => {
    const events = run([
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { id: "fc_3", type: "function_call", call_id: "call_3", name: "Bash", arguments: "" },
      },
      { type: "response.function_call_arguments.delta", item_id: "fc_3", output_index: 0, delta: '{"a":' },
      { type: "response.function_call_arguments.delta", item_id: "fc_3", output_index: 0, delta: "1}" },
      { type: "response.function_call_arguments.done", item_id: "fc_3", output_index: 0, arguments: '{"a":1}' },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: { id: "fc_3", type: "function_call", call_id: "call_3", name: "Bash", arguments: '{"a":1}' },
      },
      { type: "response.completed", response: { status: "completed", usage: { input_tokens: 1, output_tokens: 1 } } },
    ]);

    const deltas = toolDeltas(events);
    expect(deltas).toHaveLength(2);
    expect(deltas.map((delta) => delta.arguments_delta).join("")).toBe('{"a":1}');
  });

  test("recovers a registered call whose completion frames never arrived", () => {
    // The reported incident: the canonical stream ended with `tool_use` but
    // carried no `tool_call_delta` — a call the upstream registered and billed
    // (its tokens were in the usage totals) but never completed. The terminal
    // reconcile surfaces it from the `output_item.added` item.
    const events = run([
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { id: "fc_9", type: "function_call", call_id: "call_9", name: "Bash", arguments: '{"command":"ls"}' },
      },
      { type: "response.completed", response: { status: "completed", usage: { input_tokens: 1, output_tokens: 1 } } },
    ]);

    const deltas = toolDeltas(events);
    expect(deltas).toHaveLength(1);
    expect(deltas[0]?.call_id).toBe("call_9");
    expect(deltas[0]?.name).toBe("Bash");
    expect(deltas[0]?.arguments_delta).toBe('{"command":"ls"}');
    const terminal = events.at(-1);
    expect(terminal?.type).toBe("terminal");
    expect(terminal?.type === "terminal" ? terminal.stop_reason : undefined).toBe("tool_use");
  });

  test("does not duplicate calls whose arg deltas already streamed", () => {
    const events = run([
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { id: "fc_10", type: "function_call", call_id: "call_10", name: "Bash", arguments: "" },
      },
      { type: "response.function_call_arguments.delta", item_id: "fc_10", output_index: 0, delta: '{"x":1}' },
      { type: "response.completed", response: { status: "completed" } },
    ]);

    expect(toolDeltas(events)).toHaveLength(1);
  });

  test("a completed text-only turn emits no tool calls", () => {
    const events = run([
      { type: "response.output_text.delta", item_id: "tx_1", delta: "hello" },
      { type: "response.completed", response: { status: "completed" } },
    ]);
    expect(toolDeltas(events)).toHaveLength(0);
    const terminal = events.at(-1);
    expect(terminal?.type === "terminal" ? terminal.stop_reason : undefined).toBe("stop");
  });

  test("falls back to custom_tool_call_input.done for custom tool calls", () => {
    const events = run([
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { id: "ct_1", type: "custom_tool_call", call_id: "call_ct", name: "apply_patch", input: "" },
      },
      { type: "response.custom_tool_call_input.done", item_id: "ct_1", output_index: 0, input: "*** Begin Patch" },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: { id: "ct_1", type: "custom_tool_call", call_id: "call_ct", name: "apply_patch", input: "*** Begin Patch" },
      },
      { type: "response.completed", response: { status: "completed", usage: { input_tokens: 1, output_tokens: 1 } } },
    ]);

    const deltas = toolDeltas(events);
    expect(deltas).toHaveLength(1);
    expect(deltas[0]?.call_id).toBe("call_ct");
    expect(deltas[0]?.arguments_delta).toBe("*** Begin Patch");
  });
});
