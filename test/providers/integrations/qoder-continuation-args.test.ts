import { expect, test } from "bun:test";
import { qoderBodyToCanonicalEvents } from "../../../src/providers/integrations/qoder/qoder";

/**
 * Streaming tool calls must keep their arguments.
 *
 * The upstream streams one call in the OpenAI shape: the first chunk carries
 * `id` + `name` + empty `arguments`, every continuation carries only `index`
 * + the next `arguments` fragment. The translator previously synthesized a
 * fresh `call_<index>` id for each continuation chunk, so those nameless
 * fragments arrived at the encoders under an identity nobody had established
 * and were all dropped — the client saw a call whose arguments were always
 * empty (`{}`), exactly what the qoder/deepseek omp reports showed.
 *
 * Reproduced live (captured frame `acfd7b10`, 60 `tool_call_delta`s from the
 * upstream, `arguments:""` alone at the client); the fix pins the first id per
 * wire index, like the generic chat parser already does.
 */

function frame(delta: Record<string, unknown>, finishReason?: string): string {
  const chunk = {
    choices: [{ delta, index: 0, ...(finishReason === undefined ? {} : { finish_reason: finishReason }) }],
  };
  return `data:${JSON.stringify({ statusCodeValue: 200, body: JSON.stringify(chunk) })}\n\n`;
}

async function collect(chunks: readonly string[]): Promise<Array<Record<string, unknown>>> {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      for (const chunk of chunks) c.enqueue(enc.encode(chunk));
      c.close();
    },
  });
  const out: Array<Record<string, unknown>> = [];
  for await (const e of qoderBodyToCanonicalEvents(stream, new AbortController().signal, "m")) {
    out.push(e as unknown as Record<string, unknown>);
  }
  return out;
}

const calls = (ev: readonly Record<string, unknown>[]) =>
  ev.filter((e) => e["type"] === "tool_call_delta");

const CALL_START: Record<string, unknown> = {
  tool_calls: [
    { function: { arguments: "", name: "echo" }, id: "call_00_full", index: 0, type: "function" },
  ],
};
const continuation = (fragment: string, wireIndex = 0) => ({
  tool_calls: [{ function: { arguments: fragment }, index: wireIndex, type: "function" }],
});

test("index-less continuation fragments rejoin the last seen call id", async () => {
  // Some bridges omit `index` on continuation chunks entirely. The fragment
  // must still land on the call the first chunk established — the generic
  // chat parser does this via `lastSeenToolId`.
  const ev = await collect([
    frame(CALL_START),
    frame({ tool_calls: [{ function: { arguments: '{"text":"a' }, type: "function" }] }),
    frame({ tool_calls: [{ function: { arguments: 'b"}' }, type: "function" }] }),
  ]);
  const deltas = calls(ev);
  for (const d of deltas) expect(d["call_id"]).toBe("call_00_full");
  expect(JSON.parse(deltas.map((d) => String(d["arguments_delta"])).join(""))).toEqual({
    text: "ab",
  });
});

test("a named fragment with a different name does not merge into the last call", async () => {
  // The name is the discriminator: a fragment that names a different tool is
  // a parallel call, not a continuation.
  const ev = await collect([
    frame(CALL_START),
    frame({ tool_calls: [{ function: { arguments: '{"text":"a"}' }, type: "function" }] }),
    frame({
      tool_calls: [
        {
          function: { arguments: '{"path":"b"}' },
          index: 1,
          type: "function",
          id: "call_01_write",
        },
      ],
    }),
  ]);
  const byId = new Map<string, string>();
  for (const d of calls(ev)) {
    const id = String(d["call_id"]);
    byId.set(id, (byId.get(id) ?? "") + String(d["arguments_delta"]));
  }
  expect(byId.get("call_00_full")).toBe('{"text":"a"}');
  expect(byId.get("call_01_write")).toBe('{"path":"b"}');
});

test("index-identified continuation fragments rejoin the pinned call id", async () => {
  const ev = await collect([
    frame(CALL_START),
    frame(continuation('{"text"')),
    frame(continuation(': "hello')),
    frame(continuation('-qoder"}')),
    frame({}, "stop"),
  ]);
  const deltas = calls(ev);
  // Every delta must reference the pinned id, not a per-chunk `call_0`
  // synthetic (the donor pins the first id per wire index).
  for (const delta of deltas) expect(delta["call_id"]).toBe("call_00_full");
  const joined = deltas
    .map((delta) => (delta["arguments_delta"] as string) ?? "")
    .join("");
  expect(JSON.parse(joined)).toEqual({ text: "hello-qoder" });
});

test("two parallel calls keep separate identities across index 0 and 1", async () => {
  const secondStart: Record<string, unknown> = {
    tool_calls: [
      { function: { arguments: "", name: "write" }, id: "call_01_full", index: 1, type: "function" },
    ],
  };
  const ev = await collect([
    frame(CALL_START),
    frame(continuation('{"text":"a"}')),
    frame(secondStart),
    frame(continuation('{"path":"b"}', 1)),
  ]);
  const byFragment = calls(ev).map((delta) => [
    delta["call_id"],
    delta["arguments_delta"],
    delta["index"],
  ]);
  const echoFragments = byFragment.filter(([id]) => id === "call_00_full");
  const writeFragments = byFragment.filter(([id]) => id === "call_01_full");
  expect(JSON.parse(echoFragments.map(([, args]) => String(args)).join(""))).toEqual({
    text: "a",
  });
  expect(JSON.parse(writeFragments.map(([, args]) => String(args)).join(""))).toEqual({
    path: "b",
  });
});

test("a chunk carrying both id and arguments pins AND emits in one pass", async () => {
  // Some frames carry the name and a first real fragment together.
  const ev = await collect([
    frame({ tool_calls: [{ function: { arguments: '{"a":', name: "echo" }, id: "call_00_x", index: 0, type: "function" }] }),
    frame(continuation('1}')),
  ]);
  expect(JSON.parse(calls(ev).map((d) => String(d["arguments_delta"])).join(""))).toEqual({ a: 1 });
});

test("continuation fragments carrying an empty id rejoin the pinned call", async () => {
  // The qfmodel/qmodel_latest slots echo `id: ""` on every continuation chunk
  // (the first chunk carries the real id). Treating the empty string as a
  // fresh call id would orphan every argument fragment under `""` — the real
  // call is then emitted with empty arguments and the fragments are lost. An
  // empty id must behave exactly like a missing one and rejoin the pinned id.
  const ev = await collect([
    frame(CALL_START),
    frame({
      tool_calls: [
        {
          function: { arguments: '{"text":"a' },
          id: "",
          index: 0,
          type: "function",
        },
      ],
    }),
    frame({
      tool_calls: [
        {
          function: { arguments: 'b"}' },
          id: "",
          index: 0,
          type: "function",
        },
      ],
    }),
  ]);
  const deltas = calls(ev);
  // Donor mirror: fragments are forwarded as separate deltas under the pinned
  // id — the client stitches them. The start frame (empty arguments) and each
  // continuation are all separate deltas, every one on the pinned id.
  expect(deltas.length).toBeGreaterThanOrEqual(2);
  for (const d of deltas) expect(d["call_id"]).toBe("call_00_full");
  expect(JSON.parse(deltas.map((d) => String(d["arguments_delta"])).join(""))).toEqual({
    text: "ab",
  });
});

test("parallel calls with empty-id continuations keep distinct identities", async () => {
  const secondStart: Record<string, unknown> = {
    tool_calls: [
      { function: { arguments: "", name: "write" }, id: "call_01_full", index: 1, type: "function" },
    ],
  };
  const ev = await collect([
    frame(CALL_START),
    frame({
      tool_calls: [
        {
          function: { arguments: '{"text":"a"}' },
          id: "",
          index: 0,
          type: "function",
        },
      ],
    }),
    frame(secondStart),
    frame({
      tool_calls: [
        {
          function: { arguments: '{"path":"b"}' },
          id: "",
          index: 1,
          type: "function",
        },
      ],
    }),
  ]);
  const byId = new Map<string, string>();
  for (const d of calls(ev)) {
    const id = String(d["call_id"]);
    byId.set(id, (byId.get(id) ?? "") + String(d["arguments_delta"]));
  }
  expect(byId.get("call_00_full")).toBe('{"text":"a"}');
  expect(byId.get("call_01_full")).toBe('{"path":"b"}');
});

test("an empty-argument call is forwarded verbatim, not dropped", async () => {
  // Qoder's DeepSeek occasionally emits a native call with empty arguments and
  // never continues it. The translator must still forward it unchanged: the
  // harness's own feedback loop ("missing key") is what makes the model retry
  // with arguments. Silently dropping it here would hide the failure and leave
  // the model without the feedback it needs.
  const ev = await collect([
    frame({
      tool_calls: [
        { function: { arguments: "", name: "echo" }, id: "call_empty", index: 0, type: "function" },
      ],
    }),
    frame({}, "tool_calls"),
  ]);
  const deltas = calls(ev);
  expect(deltas).toHaveLength(1);
  expect(deltas[0]?.["call_id"]).toBe("call_empty");
  expect(deltas[0]?.["name"]).toBe("echo");
  expect(deltas[0]?.["arguments_delta"]).toBe("");
});

