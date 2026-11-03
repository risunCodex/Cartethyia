import { describe, expect, test } from "bun:test";
import { createDefaultProviderRegistry } from "../../src/providers/default-registry";
import type { ProviderDispatchContext, ProviderDispatchTarget } from "../../src/providers/provider-contracts";
import type { CanonicalEvent, CanonicalRequest } from "../../src/protocol/canonical-model";
import { GatewayError } from "../../src/protocol/gateway-error";
import { StreamEventPipeline } from "../../src/transport/dispatch/streaming/encoder";
import { encodeResponsesEvents } from "../../src/transport/surface/responses/encode";
import { withFakeTimers } from "../helpers/clock";

const registry = createDefaultProviderRegistry();
const target: ProviderDispatchTarget = {
  provider_id: "commandcode",
  model_id: "xiaomi/mimo-v2.6-flash",
  wire_family: "responses",
  endpoint_path: "/alpha/generate",
  capabilities: {},
};
const request: CanonicalRequest = {
  model: "public-model-alias",
  source_surface: "responses",
  stream: true,
  messages: [{ role: "user", content: [{ kind: "text", text: "hi" }] }],
  generation_controls: {},
};

function context(
  fetcher: ProviderDispatchContext["outbound_fetch"],
  signal = new AbortController().signal,
  deadline = Date.now() + 30_000,
): ProviderDispatchContext {
  return {
    credential: {
      provider_id: "commandcode",
      credential_kind: "api_key",
      secret: new TextEncoder().encode("fixture-token"),
    },
    outbound_fetch: fetcher,
    deadline,
    abort_signal: signal,
  };
}

function controlledBody() {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const cancelled = Promise.withResolvers<unknown>();
  const body = new ReadableStream<Uint8Array>({
    start(value) { controller = value; },
    cancel(reason) { cancelled.resolve(reason); },
  });
  return {
    body,
    cancelled: cancelled.promise,
    enqueue(event: Record<string, unknown>) {
      if (!controller) throw new Error("Fixture stream did not start");
      controller.enqueue(new TextEncoder().encode(`${JSON.stringify(event)}\n`));
    },
  };
}

async function adapter() {
  const resolved = await registry.resolve("commandcode");
  if (!resolved) throw new Error("Commandcode adapter is not registered");
  return resolved;
}

describe("Commandcode registry to Responses client", () => {
  for (const [text, reasoning, newline] of [
    ["literal <", "", true],
    ["literal <thi", "", false],
    ["<think>reasoning</think>literal <", "reasoning", true],
    ["<think>reasoning<", "", false],
  ] as const) {
    test(`flushes ${JSON.stringify(text)} before one terminal (newline=${newline})`, async () => {
      const fixture = [
        { type: "text-delta", text },
        { type: "finish-step", finishReason: "stop", usage: { inputTokens: 3, outputTokens: 2 } },
        { type: "finish" },
      ].map((event) => JSON.stringify(event)).join("\n") + (newline ? "\n" : "");
      const events: CanonicalEvent[] = [];
      for await (const event of (await adapter()).dispatch(request, target, context(async () => new Response(fixture)))) {
        events.push(event);
      }
      expect(events[0]).toMatchObject({ type: "response_start", model: target.model_id });
      expect(events.filter((event) => event.type === "terminal")).toHaveLength(1);
      expect(events.at(-1)).toMatchObject({ type: "terminal", state: "complete", usage: { input_tokens: 3, output_tokens: 2 } });
      expect(events.map((event) => event.sequence_number)).toEqual(events.map((_, index) => index + 1));
      const expectedText = text.includes("</think>") ? "literal <" : text;
      const clientDeltas = events.filter((event) => event.type === "content_delta");
      expect(clientDeltas.flatMap((event) => event.content.kind === "text" ? [event.content.text] : []).join("")).toBe(expectedText);
      expect(clientDeltas.flatMap((event) => event.content.kind === "reasoning" ? [event.content.summary ?? ""] : []).join("")).toBe(reasoning);

      const pipeline = new StreamEventPipeline("responses", { model: request.model }, false);
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const event of events) pipeline.enqueueEvent(event, controller);
          pipeline.finishEncoders(controller);
          controller.close();
        },
      });
      const sse = await new Response(stream).text();
      expect(sse).toContain('"type":"response.completed"');
      expect(sse).toContain(`"model":"${target.model_id}"`);
      expect(sse).not.toContain('"model":"commandcode"');
      if (expectedText) expect(sse).toContain(`"text":"${expectedText}"`);
      if (reasoning) expect(sse).toContain(reasoning);
      const output = JSON.parse(new TextDecoder().decode(encodeResponsesEvents(events, { model: request.model }).bytes)) as Record<string, unknown>;
      expect(output).toMatchObject({ model: target.model_id, status: "completed" });
      if (expectedText) expect(output["output"]).toContainEqual(expect.objectContaining({ type: "message", content: [expect.objectContaining({ type: "output_text", text: expectedText })] }));
    });
  }

  test("encodes a nonstream request with its literal suffix and selected model", async () => {
    const events: CanonicalEvent[] = [];
    const fixture = '{"type":"text-delta","text":"literal <"}\n{"type":"finish"}\n';
    for await (const event of (await adapter()).dispatch({ ...request, stream: false }, target, context(async () => new Response(fixture)))) events.push(event);
    const output = JSON.parse(new TextDecoder().decode(encodeResponsesEvents(events).bytes)) as Record<string, unknown>;
    expect(output).toMatchObject({ model: target.model_id, status: "completed" });
    expect(output["output"]).toContainEqual(expect.objectContaining({ type: "message", content: [expect.objectContaining({ type: "output_text", text: "literal <" })] }));
  });

  test("does not consume content, duplicate finishes, or errors after terminal", async () => {
    const fixture = [
      { type: "text-delta", text: "literal <" },
      { type: "finish" },
      { type: "text-delta", text: "must not escape" },
      { type: "finish" },
      { type: "error", message: "must not fail a completed response" },
    ].map((event) => JSON.stringify(event)).join("\n") + "\n";
    const events: CanonicalEvent[] = [];
    for await (const event of (await adapter()).dispatch(request, target, context(async () => new Response(fixture)))) events.push(event);
    expect(events.filter((event) => event.type === "terminal")).toHaveLength(1);
    const output = new TextDecoder().decode(encodeResponsesEvents(events).bytes);
    expect(output).toContain("literal <");
    expect(output).not.toContain("must not");
  });

  test("preserves a tag prefix split across upstream reads", async () => {
    const fixture = controlledBody();
    const events: CanonicalEvent[] = [];
    const iterator = (await adapter()).dispatch(request, target, context(async () => new Response(fixture.body)))[Symbol.asyncIterator]();
    const start = await iterator.next();
    if (!start.done) events.push(start.value);
    fixture.enqueue({ type: "text-delta", text: "literal <" });
    const first = await iterator.next();
    if (!first.done) events.push(first.value);
    fixture.enqueue({ type: "text-delta", text: "thi" });
    fixture.enqueue({ type: "finish" });
    while (true) {
      const event = await iterator.next();
      if (event.done) break;
      events.push(event.value);
    }
    const output = new TextDecoder().decode(encodeResponsesEvents(events).bytes);
    expect(output).toContain("literal <thi");
    expect(events.at(-1)).toMatchObject({ type: "terminal", state: "complete" });
  });

  test("keeps an unterminated stream failed after flushing its final text", async () => {
    const events: CanonicalEvent[] = [];
    for await (const event of (await adapter()).dispatch(request, target, context(async () => new Response('{"type":"text-delta","text":"literal <"}')))) events.push(event);
    expect(events.at(-1)).toMatchObject({ type: "terminal", state: "failed" });
    expect(new TextDecoder().decode(encodeResponsesEvents(events).bytes)).toContain("literal <");
  });

  test("decodes split UTF-8 and paired thinking tags before tool and terminal events", async () => {
    const fixture = [
      { type: "text-delta", text: "<thinking>reasoning 漢</thinking>answer 字" },
      { type: "tool-call", toolCallId: "call-1", toolName: "read", input: { path: "fixture" } },
      { type: "finish-step", finishReason: "tool_calls" },
      { type: "finish" },
    ].map((event) => JSON.stringify(event)).join("\n");
    const bytes = new TextEncoder().encode(fixture);
    let index = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (index === bytes.length) controller.close();
        else controller.enqueue(bytes.subarray(index, ++index));
      },
    });
    const events: CanonicalEvent[] = [];
    for await (const event of (await adapter()).dispatch(request, target, context(async () => new Response(body)))) events.push(event);
    expect(events.map((event) => event.sequence_number)).toEqual(events.map((_, position) => position + 1));
    expect(events.filter((event) => event.type === "content_delta")).toMatchObject([
      { content: { kind: "reasoning", summary: "reasoning 漢" } },
      { content: { kind: "text", text: "answer 字" } },
    ]);
    expect(events.filter((event) => event.type === "tool_call_delta")).toMatchObject([
      { call_id: "call-1", name: "read", arguments_delta: "" },
      { call_id: "call-1", arguments_delta: '{"path":"fixture"}' },
    ]);
    expect(events.at(-1)).toMatchObject({ type: "terminal", state: "complete", stop_reason: "tool_use" });
    const output = JSON.parse(new TextDecoder().decode(encodeResponsesEvents(events).bytes)) as Record<string, unknown>;
    expect(output).toMatchObject({ model: target.model_id, status: "completed" });
  });
});

describe("Commandcode request and stream deadlines", () => {
  test("an active stream survives its opening deadline", async () => {
    const registered = await adapter();
    const fixture = controlledBody();
    await withFakeTimers(async (clock) => {
      const iterator = registered.dispatch(request, target, context(async () => new Response(fixture.body), undefined, Date.now() + 50))[Symbol.asyncIterator]();
      expect((await iterator.next()).value).toMatchObject({ type: "response_start" });
      for (let index = 0; index < 3; index++) {
        await clock.advance(100);
        fixture.enqueue({ type: "text-delta", text: `chunk-${index}` });
        expect((await iterator.next()).value).toMatchObject({ type: "content_delta", content: { text: `chunk-${index}` } });
      }
      fixture.enqueue({ type: "finish" });
      expect((await iterator.next()).value).toMatchObject({ type: "terminal", state: "complete" });
      expect((await iterator.next()).done).toBe(true);
      await fixture.cancelled;
    });
  });

  test("the opening deadline remains an upstream 504", async () => {
    const registered = await adapter();
    const opened = Promise.withResolvers<void>();
    await withFakeTimers(async (clock) => {
      const iterator = registered.dispatch(request, target, context(async (_input, init) => {
        opened.resolve();
        const { promise, reject } = Promise.withResolvers<Response>();
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        return await promise;
      }, undefined, Date.now() + 50))[Symbol.asyncIterator]();
      const pending = iterator.next();
      const rejected = pending.catch((error: unknown) => error);
      await Promise.race([
        opened.promise,
        pending.then(() => { throw new Error("Dispatch completed before opening the fixture transport"); }),
      ]);
      await clock.advance(51);
      expect(await rejected).toMatchObject({ code: "deadline_exceeded", status: 504, origin: "upstream" });
    });
  });

  test("a timed stall abort still cancels the upstream reader as a 504", async () => {
    const registered = await adapter();
    const fixture = controlledBody();
    const controller = new AbortController();
    const reason = new GatewayError("deadline_exceeded", 504, "upstream stall watchdog", {}, "upstream");
    await withFakeTimers(async (clock) => {
      const iterator = registered.dispatch(request, target, context(async () => new Response(fixture.body), controller.signal))[Symbol.asyncIterator]();
      await iterator.next();
      fixture.enqueue({ type: "text-delta", text: "active" });
      await iterator.next();
      const pending = iterator.next();
      const rejected = pending.catch((error: unknown) => error);
      const timeout = setTimeout(() => controller.abort(reason), 100);
      try {
        await clock.advance(101);
        expect(await rejected).toBe(reason);
        expect(await fixture.cancelled).toBe(reason);
      } finally {
        clearTimeout(timeout);
      }
    });
  });

  for (const reason of [
    new GatewayError("deadline_exceeded", 504, "upstream stall watchdog", {}, "upstream"),
    new DOMException("deadline", "TimeoutError"),
    new DOMException("client cancelled", "AbortError"),
  ]) {
    test(`stops a pending stream read for ${reason.name}: ${reason.message}`, async () => {
      const fixture = controlledBody();
      const controller = new AbortController();
      const iterator = (await adapter()).dispatch(request, target, context(async () => new Response(fixture.body), controller.signal))[Symbol.asyncIterator]();
      await iterator.next();
      const pending = iterator.next();
      const rejected = pending.catch((error: unknown) => error);
      controller.abort(reason);
      if (reason instanceof GatewayError) {
        expect(await rejected).toBe(reason);
      } else {
        expect(await rejected).toMatchObject({ code: reason.name === "TimeoutError" ? "deadline_exceeded" : "transport_closed", status: reason.name === "TimeoutError" ? 504 : 499 });
      }
      expect(await fixture.cancelled).toBe(reason);
    });
  }
});
