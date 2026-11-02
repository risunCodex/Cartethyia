import { describe, expect, test } from "bun:test";
import { decodeSseEvents } from "../../src/protocol/sse-decoder";

function streamFrom(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

async function collect(text: string, chunkSize = 0): Promise<string[]> {
  let encoded = text;
  const out: string[] = [];
  let stream: ReadableStream<Uint8Array>;
  if (chunkSize === 0) {
    stream = streamFrom(encoded);
  } else {
    const bytes = new TextEncoder().encode(encoded);
    let i = 0;
    stream = new ReadableStream({
      start(controller) {
        while (i < bytes.length) {
          const size = Math.min(chunkSize, bytes.length - i);
          controller.enqueue(bytes.subarray(i, i + size));
          i += size;
        }
        controller.close();
      },
    });
  }
  for await (const ev of decodeSseEvents(stream)) out.push(ev.data);
  return out;
}

describe("decodeSseEvents", () => {
  test("normal single data event", async () => {
    const events = await collect("data: hello\n\n");
    expect(events).toEqual(["hello"]);
  });

  test("multiple data events", async () => {
    const events = await collect('data: {"a":1}\n\ndata: {"b":2}\n\n');
    expect(events).toHaveLength(2);
    expect(JSON.parse(events[0]!)).toEqual({ a: 1 });
    expect(JSON.parse(events[1]!)).toEqual({ b: 2 });
  });

  test("bare continuation lines join the open data event", async () => {
    // Qoder IDE /model/v1 emits JSON with literal newlines; the decoder must
    // treat non-prefixed lines as continuations of the open `data:` event.
    const events = await collect('data: {"a": 1,\n"b": 2}\n\n');
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0]!)).toEqual({ a: 1, b: 2 });
  });

  test("blank line inside a JSON string is a continuation, not an event boundary", async () => {
    // Qoder raw_usage has literal "\n\n" inside string values. Without the
    // JSON-depth guard this split the event and threw "Malformed SSE line".
    const json =
      '{"choices":[],"created":1,"id":"x","model":"qfmodel","object":"chat.completion.chunk",' +
      '"raw_usage":{"data":{"model_context":{"data_policy_preferre\n\nnd_count":0}}}}';
    const events = await collect("data: " + json + "\n\n");
    expect(events).toHaveLength(1);
    // The event is collected intact (raw newlines preserved, not split).
    expect(events[0]!).toContain("data_policy_preferre\n\nnd_count");
  });

  test("blank line inside a JSON string survives arbitrary chunking", async () => {
    const json =
      '{"choices":[],"raw_usage":{"data":{"model_context":{"workspace_file_co\n\nunt":-1}}}}';
    const events = await collect("data: " + json + "\n\n", 7);
    expect(events).toHaveLength(1);
    expect(events[0]!).toContain("workspace_file_co\n\nunt");
  });

  test("[DONE] still terminates as a complete non-JSON value", async () => {
    const events = await collect('data: {"x":1}\n\ndata: [DONE]\n\n');
    expect(events).toHaveLength(2);
    expect(events[1]).toBe("[DONE]");
  });

  test("malformed non-continuation line still throws", async () => {
    // A bare line with no open data event is a real protocol violation.
    const stream = streamFrom("garbage without data prefix\n\n");
    await expect(async () => {
      for await (const _ of decodeSseEvents(stream)) {
        // drain
      }
    }).toThrow(/Malformed SSE line/);
  });
});
