import { expect, test } from "bun:test";
import { qoderBodyToCanonicalEvents } from "../../../src/providers/integrations/qoder/qoder";

/**
 * End-to-end tests through the real streaming translator.
 *
 * Qoder speaks plain OpenAI-compatible `tool_calls` deltas on the wire — no
 * DSML/XML text-echo recovery. These pin the structured path end to end,
 * which is the boundary the caller actually sees.
 */

function frame(delta: Record<string, unknown>, finishReason?: string): string {
  const chunk = {
    choices: [{ delta, ...(finishReason === undefined ? {} : { finish_reason: finishReason }) }],
  };
  return `data: ${JSON.stringify({ statusCodeValue: 200, body: JSON.stringify(chunk) })}\n\n`;
}

function body(chunks: readonly string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (const chunk of chunks) c.enqueue(enc.encode(chunk));
      c.close();
    },
  });
}

async function collect(chunks: readonly string[]): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  for await (const e of qoderBodyToCanonicalEvents(body(chunks), new AbortController().signal, "m")) {
    out.push(e as unknown as Record<string, unknown>);
  }
  return out;
}

const part = (e: Record<string, unknown>) => (e["content"] ?? {}) as Record<string, unknown>;

const textOf = (ev: readonly Record<string, unknown>[]) =>
  ev.filter((e) => e["type"] === "content_delta").map((e) => (part(e)["text"] as string) ?? "").join("");

const thinkingOf = (ev: readonly Record<string, unknown>[]) =>
  ev.filter((e) => e["type"] === "content_delta").map((e) => (part(e)["summary"] as string) ?? "").join("");

const callsOf = (ev: readonly Record<string, unknown>[]) => ev.filter((e) => e["type"] === "tool_call_delta");

test("a structured tool_calls delta is emitted as a tool call", async () => {
  const ev = await collect([
    frame({ content: "calling" }),
    frame({ tool_calls: [{ index: 0, id: "call_1", function: { name: "Read", arguments: '{"p":"1"}' } }] }),
    frame({}, "tool_calls"),
  ]);
  expect(callsOf(ev)).toHaveLength(1);
  expect(callsOf(ev)[0]?.["call_id"]).toBe("call_1");
  expect(callsOf(ev)[0]?.["name"]).toBe("Read");
  expect(JSON.parse((callsOf(ev)[0]?.["arguments_delta"] as string) ?? "{}")).toEqual({ p: "1" });
  expect(textOf(ev)).toBe("calling");
});

test("content after finish reason is dropped", async () => {
  // Strict OpenAI clients reject content after the finish reason: once the
  // terminal frame is seen, any later content/reasoning/tool-call fragments
  // must be dropped, and only one terminal may be emitted.
  const ev = await collect([
    frame({ content: "A" }),
    frame({}, "stop"),
    frame({ content: "B" }),
    frame({ tool_calls: [{ index: 0, id: "call_1", function: { name: "Read", arguments: "{}" } }] }),
  ]);
  expect(textOf(ev)).toBe("A");
  expect(callsOf(ev)).toHaveLength(0);
  const terminal = ev.find((e) => e["type"] === "terminal");
  expect(terminal?.["stop_reason"]).toBe("stop");
});

test("continuation fragments are forwarded as separate deltas", async () => {
  // Donor mirror: each `delta.tool_calls` fragment becomes its own
  // `tool_call_delta` — the client stitches by index/id, exactly like the
  // donor's `partial_json` stream. No buffering into one call.
  const ev = await collect([
    frame({ tool_calls: [{ index: 0, id: "call_1", function: { name: "Read", arguments: '{"file_path":' } }] }),
    frame({ tool_calls: [{ index: 0, function: { arguments: '"a.ts"}' } }] }),
    frame({}, "tool_calls"),
  ]);
  const calls = callsOf(ev);
  expect(calls).toHaveLength(2);
  expect(calls[0]?.["call_id"]).toBe("call_1");
  expect(calls[0]?.["name"]).toBe("Read");
  expect((calls[0]?.["arguments_delta"] as string) ?? "").toBe('{"file_path":');
  expect((calls[1]?.["arguments_delta"] as string) ?? "").toBe('"a.ts"}');
});

test("parallel tool calls keep distinct ids", async () => {
  const ev = await collect([
    frame({
      tool_calls: [
        { index: 0, id: "call_1", function: { name: "Read", arguments: '{"p":"1"}' } },
        { index: 1, id: "call_2", function: { name: "Write", arguments: '{"p":"2"}' } },
      ],
    }),
    frame({}, "tool_calls"),
  ]);
  const calls = callsOf(ev);
  expect(calls).toHaveLength(2);
  expect(calls[0]?.["call_id"]).toBe("call_1");
  expect(calls[1]?.["call_id"]).toBe("call_2");
});

test("glued parallel arguments are forwarded verbatim (no split)", async () => {
  // Donor mirror: the translator never splits or repairs glued JSON — each
  // `delta.tool_calls` element is forwarded as-is, so the client decides. The
  // second call's empty arguments arrive untouched too.
  const ev = await collect([
    frame({
      tool_calls: [
        {
          index: 0,
          id: "call_1",
          function: { name: "kalkulator", arguments: '{"expression": "17*23"}{"zona": "Asia/Jakarta"}' },
        },
        { index: 1, id: "call_2", function: { name: "get_waktu", arguments: "" } },
      ],
    }),
    frame({}, "tool_calls"),
  ]);
  const calls = callsOf(ev);
  expect(calls).toHaveLength(2);
  expect((calls[0]?.["arguments_delta"] as string) ?? "").toBe('{"expression": "17*23"}{"zona": "Asia/Jakarta"}');
  expect(calls[1]?.["call_id"]).toBe("call_2");
  expect((calls[1]?.["arguments_delta"] as string) ?? "").toBe("");
});

test("continuation fragments are forwarded as separate deltas", async () => {
  // Donor mirror: each fragment becomes its own `tool_call_delta` — the
  // client stitches by index/id, exactly like the donor's `partial_json`
  // stream. No buffering into one call.
  const ev = await collect([
    frame({
      tool_calls: [
        {
          index: 0,
          id: "toolu_A",
          function: { name: "kalkulator", arguments: '{"expression": "17*23"}{"zona": "Asia/Jakarta"}' },
        },
      ],
    }),
    frame({
      tool_calls: [
        { index: 1, id: "toolu_B", function: { name: "get_waktu", arguments: "" } },
      ],
    }),
    frame({}, "tool_calls"),
  ]);
  const calls = callsOf(ev);
  expect(calls).toHaveLength(2);
  expect((calls[0]?.["arguments_delta"] as string) ?? "").toBe('{"expression": "17*23"}{"zona": "Asia/Jakarta"}');
  expect(calls[1]?.["call_id"]).toBe("toolu_B");
});

test("fragment arguments are forwarded as-is without repair", async () => {
  // Donor mirror: a half-built arguments string reaches the client exactly as
  // received — no stitching, no repair, no JSON validation.
  const ev = await collect([
    frame({ tool_calls: [{ index: 0, id: "call_1", function: { name: "bash", arguments: '{"command"' } }] }),
    frame({ tool_calls: [{ index: 0, function: { arguments: 'ls -la"}' } }] }),
    frame({}, "tool_calls"),
  ]);
  const calls = callsOf(ev);
  expect(calls).toHaveLength(2);
  expect(calls[0]?.["call_id"]).toBe("call_1");
  expect((calls[0]?.["arguments_delta"] as string) ?? "").toBe('{"command"');
  expect((calls[1]?.["arguments_delta"] as string) ?? "").toBe('ls -la"}');
});

test("reasoning_content is surfaced as reasoning content", async () => {
  const ev = await collect([
    frame({ reasoning_content: "Let me verify." }),
    frame({ content: "ok" }),
    frame({}, "stop"),
  ]);
  expect(thinkingOf(ev)).toBe("Let me verify.");
  expect(textOf(ev)).toBe("ok");
});

test("a raw_usage terminal frame with literal newlines inside its JSON is salvaged", async () => {
  // The IDE surface emits a terminal raw_usage event whose JSON payload
  // contains literal newline bytes inside string values (e.g.
  // `"time_of_\nscheduler"`). Those bytes are not valid JSON, so the
  // translator must repair the frame instead of dropping it. If it is
  // dropped, the terminal is synthesized without any finish reason
  // (`provider_stop_reason` stays absent) — the salvage path is what makes
  // the finish reason and usage flow through.
  const chunk = {
    choices: [] as unknown[],
    created: 1793589918,
    id: "chatcmpl-x",
    model: "qfmodel",
    object: "chat.completion.chunk",
    raw_usage: {
      data: {
        completion_tokens: 37,
        model: "bailian-qwen3.8-flash",
        model_context: { ["time_of_\nscheduler"]: 401 },
      },
    },
  };
  const ev = await collect(["data: " + JSON.stringify(chunk) + "\n\n"]);
  const terminal = ev.find((e) => e["type"] === "terminal");
  expect(terminal).toBeDefined();
  expect(terminal?.["stop_reason"]).toBe("stop");
  expect(terminal?.["provider_stop_reason"]).toBe("stop");
});

test("a raw_usage terminal frame carries provider metadata", async () => {
  // The IDE surface's raw_usage names the model that actually served the
  // turn (provider_model/target) — the production transports echo only an
  // opaque roster key. The translator must surface it on the terminal event
  // so probes can report it.
  const chunk = {
    choices: [] as unknown[],
    created: 1793589918,
    id: "chatcmpl-x",
    model: "lite",
    object: "chat.completion.chunk",
    raw_usage: {
      data: {
        completion_tokens: 37,
        provider_model: "qwen3.7-plus",
        supply_model: "qwen3.7-plus",
        supply_region: "global",
        model_level: "lite",
        target: "bailian-qwen3.7-plus-free-260401",
      },
    },
  };
  const ev = await collect(["data: " + JSON.stringify(chunk) + "\n\n"]);
  const terminal = ev.find((e) => e["type"] === "terminal");
  expect(terminal).toBeDefined();
  expect(terminal?.["provider_metadata"]).toEqual({
    provider_model: "qwen3.7-plus",
    supply_model: "qwen3.7-plus",
    supply_region: "global",
    model_level: "lite",
    target: "bailian-qwen3.7-plus-free-260401",
  });
});

test("plain text passes through untouched", async () => {
  const ev = await collect([
    frame({ content: "Answer is 42." }),
    frame({}, "stop"),
  ]);
  expect(textOf(ev)).toBe("Answer is 42.");
  expect(callsOf(ev)).toHaveLength(0);
});

test("a turn whose structured call ran reports tool_use", async () => {
  const ev = await collect([
    frame({ tool_calls: [{ index: 0, id: "call_1", function: { name: "Read", arguments: "{}" } }] }),
    frame({}, "tool_calls"),
  ]);
  const terminal = ev.find((e) => e["type"] === "terminal");
  expect(terminal?.["stop_reason"]).toBe("tool_use");
});

test("tool-style prose passes through as plain text (no echo recovery)", async () => {
  // Donor mirror: the translator never scans model text for tool calls — any
  // prose, including something that looks like a tool echo, reaches the
  // client as ordinary content.
  const echo =
    "assistant 请求调用工具\n" +
    "<tool_call>\n" +
    "<name>edit</name>\n" +
    "<arguments>{\"path\":\"D:/tmp/a.txt\",\"oldString\":\"x\",\"newString\":\"y\"}</arguments>\n" +
    "</tool_call>";
  const ev = await collect([frame({ content: echo }), frame({}, "stop")]);
  expect(textOf(ev)).toBe(echo);
  expect(callsOf(ev)).toHaveLength(0);
});

test("finish_reason error maps to a failed terminal", async () => {
  const ev = await collect([
    frame({ reasoning_content: "thinking…" }),
    frame({}, "error"),
  ]);
  const terminal = ev.find((e) => e["type"] === "terminal");
  expect(terminal).toBeDefined();
  expect(terminal?.["state"]).toBe("failed");
  expect(terminal?.["stop_reason"]).toBe("error");
  expect(terminal?.["provider_stop_reason"]).toBe("error");
});

test("finish_reason refusal maps to a complete terminal with refusal stop", async () => {
  const ev = await collect([
    frame({ reasoning_content: "I should not assist with this." }),
    frame({}, "refusal"),
  ]);
  const terminal = ev.find((e) => e["type"] === "terminal");
  expect(terminal).toBeDefined();
  // Refusal is a valid model answer, not a transport failure.
  expect(terminal?.["state"]).toBe("complete");
  expect(terminal?.["stop_reason"]).toBe("refusal");
  expect(terminal?.["provider_stop_reason"]).toBe("refusal");
});
