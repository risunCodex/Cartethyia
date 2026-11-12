/**
 * Cursor HTTP/1.1 fallback wire: RunSSE down, BidiAppend up.
 *
 * No sockets: one injected fetcher records both calls. The append body is
 * decoded back from raw protobuf so the sequence number, request id linkage,
 * and hex message are observations rather than literals copied from the donor.
 */
import { describe, expect, test } from "bun:test";
import { encodeFrame, streamFrames, decodeFramePayload } from "../../src/providers/integrations/cursor/protocol/framing";
import { openCursorRunH1 } from "../../src/providers/integrations/cursor/cursor-http2";
import { encodeMessage } from "../../src/providers/integrations/cursor/protocol/messages";

interface Recorded {
  readonly url: string;
  readonly init: RequestInit;
}

/** Reads one varint from raw protobuf bytes. */
function readVarint(bytes: Uint8Array, at: { i: number }): number {
  let value = 0;
  let shift = 0;
  for (;;) {
    const byte = bytes[at.i] ?? 0;
    at.i += 1;
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return value;
    shift += 7;
  }
}

/** Decodes the four fields of one BidiAppendRequest body. */
function decodeAppendBody(body: Uint8Array): {
  data: string;
  requestId: string;
  seqno: number;
} {
  const at = { i: 0 };
  let data = "";
  let requestId = "";
  let seqno = -1;
  while (at.i < body.byteLength) {
    const tag = readVarint(body, at);
    const field = tag >>> 3;
    const wire = tag & 7;
    if (wire === 0) {
      const value = readVarint(body, at);
      if (field === 3) seqno = value;
      continue;
    }
    if (wire !== 2) throw new Error(`unexpected wire type ${wire}`);
    const length = readVarint(body, at);
    const value = body.subarray(at.i, at.i + length);
    at.i += length;
    if (field === 1) data = new TextDecoder().decode(value);
    if (field === 2) {
      const inner = { i: 0 };
      const innerTag = readVarint(value, inner);
      if ((innerTag >>> 3) !== 1) throw new Error("BidiRequestId field missing");
      const idLength = readVarint(value, inner);
      requestId = new TextDecoder().decode(value.subarray(inner.i, inner.i + idLength));
    }
  }
  return { data, requestId, seqno };
}

function bodyBytes(init: RequestInit): Uint8Array {
  const body = init.body;
  if (body instanceof Uint8Array) return body;
  throw new Error("expected a Uint8Array request body");
}

function openingFrame(init: RequestInit): Uint8Array {
  const frames = [...streamFrames(bodyBytes(init))];
  const frame = frames[0];
  if (frame === undefined) throw new Error("RunSSE opener frame missing");
  expect(frames.length).toBe(1);
  expect(frame.flags).toBe(0);
  return decodeFramePayload(frame);
}

describe("Cursor HTTP/1.1 Run transport", () => {
  test("RunSSE opens with the request id and BidiAppend repeats it, numbered in order", async () => {
    const calls: Recorded[] = [];
    const serverFrame = encodeFrame(0, encodeMessage("AgentServerMessage", {
      interaction_update: { turn_ended: { input_tokens: 1, output_tokens: 1 } },
    }));
    const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      if (String(url).endsWith("/agent.v1.AgentService/RunSSE")) {
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(serverFrame);
            // Keep the down stream open long enough for both appends to be
            // answered; a real Run ends with turn_ended, not with the first
            // chunk's arrival.
            setTimeout(() => controller.close(), 10);
          },
        }), { status: 200 });
      }
      return new Response(new Uint8Array(0), { status: 200 });
    }) as unknown as typeof fetch;

    const ac = new AbortController();
    const transport = await openCursorRunH1({
      requestId: "req-test-42",
      credential: "token",
      fetcher,
      signal: ac.signal,
    });
    expect(transport.mode).toBe("http1");

    await transport.write(new Uint8Array([0x0a, 0x00])); // run_request-ish client message
    await transport.write(new Uint8Array([0x3a, 0x00])); // heartbeat-ish client message
    const chunks: Uint8Array[] = [];
    for await (const chunk of transport.body) chunks.push(chunk);
    expect(chunks.length).toBeGreaterThan(0);

    const sse = calls.find((call) => call.url.endsWith("/agent.v1.AgentService/RunSSE"));
    expect(sse).toBeDefined();
    const opener = openingFrame(sse!.init);
    const openerAt = { i: 0 };
    const openerTag = readVarint(opener, openerAt);
    expect(openerTag >>> 3).toBe(1);
    const openerLength = readVarint(opener, openerAt);
    expect(new TextDecoder().decode(opener.subarray(openerAt.i, openerAt.i + openerLength))).toBe("req-test-42");

    const appends = calls.filter((call) => call.url.endsWith("/aiserver.v1.BidiService/BidiAppend"));
    expect(appends.length).toBe(2);
    const first = decodeAppendBody(bodyBytes(appends[0]!.init));
    const second = decodeAppendBody(bodyBytes(appends[1]!.init));
    expect(first.requestId).toBe("req-test-42");
    expect(second.requestId).toBe("req-test-42");
    expect(first.seqno).toBe(0);
    expect(second.seqno).toBe(1);
    expect(first.data).toBe("0a00");
    expect(second.data).toBe("3a00");
    expect(appends[0]!.init.headers).toBeDefined();
    const headers = appends[0]!.init.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/proto");
    expect(headers["connect-protocol-version"]).toBe("1");
    expect(headers["x-cursor-client-type"]).toBe("cli");
  });

  test("a failing BidiAppend ends the Run with a Connect error envelope", async () => {
    const fetcher = (async (url: string | URL | Request) => {
      if (String(url).endsWith("/agent.v1.AgentService/RunSSE")) {
        // Keep the down stream open long enough for one append to be in
        // flight; a clean close before that would end the Run on its own.
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            setTimeout(() => controller.close(), 10);
          },
        }), { status: 200 });
      }
      return new Response("nope", { status: 429 });
    }) as unknown as typeof fetch;
    const ac = new AbortController();
    const transport = await openCursorRunH1({
      requestId: "req-fail",
      credential: "token",
      fetcher,
      signal: ac.signal,
    });
    await transport.write(new Uint8Array([0x0a, 0x00]));
    const chunks: Uint8Array[] = [];
    for await (const chunk of transport.body) chunks.push(chunk);
    const joined = chunks.reduce((left, right) => {
      const out = new Uint8Array(left.byteLength + right.byteLength);
      out.set(left, 0);
      out.set(right, left.byteLength);
      return out;
    }, new Uint8Array(0));
    expect(new TextDecoder().decode(joined)).toContain("resource_exhausted");
    expect(new TextDecoder().decode(joined)).toContain("nope");
  });
});
