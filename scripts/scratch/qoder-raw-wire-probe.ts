/**
 * Verify qoderBodyToCanonicalEvents against the EXACT raw wire captured from
 * live qoder/ultimate parallel tool calls (2026-11-04).
 *
 * The live chunk looks like: `data: {"id":"chatcmpl-...","choices":[{"delta":{...},"finish_reason":null}]}`
 * (no envelope wrapper). Feed the raw SSE lines verbatim and print the events.
 */
import { qoderBodyToCanonicalEvents } from "../../src/providers/integrations/qoder/qoder";

const chunkA = {
  id: "chatcmpl-3a6d5bb6",
  object: "chat.completion.chunk",
  model: "ultimate",
  choices: [
    {
      index: 0,
      delta: {
        tool_calls: [
          {
            index: 0,
            id: "toolu_bdrk_01Cp6XWebrUcyDU8MDfJKNVP",
            type: "function",
            function: {
              name: "kalkulator",
              arguments: '{"expression": "17*23"}{"zona": "Asia/Jakarta"}',
            },
          },
        ],
      },
      finish_reason: null,
    },
  ],
};

const chunkB = {
  id: "chatcmpl-3a6d5bb6",
  object: "chat.completion.chunk",
  model: "ultimate",
  choices: [
    {
      index: 0,
      delta: {
        tool_calls: [
          {
            index: 0,
            id: "toolu_bdrk_01K2QvzpA3SEj7mewA3KtSQ6",
            type: "function",
            function: { name: "get_waktu", arguments: "" },
          },
        ],
      },
      finish_reason: null,
    },
  ],
};

const chunkC = {
  id: "chatcmpl-3a6d5bb6",
  object: "chat.completion.chunk",
  model: "ultimate",
  choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
};

const lines = [chunkA, chunkB, chunkC]
  .map((c) => `data: ${JSON.stringify(c)}`)
  .join("\n\n") + "\n\n";

const enc = new TextEncoder();
const body = new ReadableStream<Uint8Array>({
  start(controller) {
    controller.enqueue(enc.encode(lines));
    controller.close();
  },
});

const events: Array<Record<string, unknown>> = [];
for await (const e of qoderBodyToCanonicalEvents(body, new AbortController().signal, "ultimate")) {
  events.push(e as unknown as Record<string, unknown>);
}

console.log("EVENTS:");
for (const e of events) {
  console.log(JSON.stringify(e));
}
console.log("---");
const calls = events.filter((e) => e["type"] === "tool_call_delta");
console.log(`tool_call_delta count: ${calls.length}`);
for (const c of calls) {
  const args = (c["arguments_delta"] as string) ?? "";
  let valid = true;
  try {
    JSON.parse(args);
  } catch {
    valid = false;
  }
  console.log(`  id=${String(c["call_id"]).slice(0, 16)} name=${String(c["name"])} argsValid=${valid} args=${args.slice(0, 120)}`);
}
