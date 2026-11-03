import { describe, expect, test } from "bun:test";
import type { CanonicalRequest, ContentPart } from "../../src/protocol/canonical-model";
import { decodeResponsesSseStream } from "../../src/protocol/response/responses";
import { canonicalToResponsesPayload } from "../../src/protocol/request/responses";
import { chatAdapter } from "../../src/transport/surface/chat/adapter";

describe("Responses reasoning decoder", () => {
  test("keeps reasoning text separate from its summary", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode([
          'data: {"type":"response.reasoning_text.delta","item_id":"reasoning-1","delta":"private thought"}',
          'data: {"type":"response.reasoning_summary_text.delta","item_id":"reasoning-1","delta":"**Crafting a brief reply**"}',
          'data: {"type":"response.reasoning_summary_text.delta","item_id":"reasoning-1","summary_index":1,"delta":"**Next step**"}',
          'data: {"type":"response.completed","response":{"status":"completed","output":[]}}',
          "data: [DONE]",
          "",
        ].join("\n\n")));
        controller.close();
      },
    });
    const request = {
      model: "test-model",
      source_surface: "responses",
      stream: true,
      messages: [],
    } as unknown as CanonicalRequest;
    const events = [];
    for await (const event of decodeResponsesSseStream(stream, request)) events.push(event);
    const reasoning = events.flatMap((event) => {
      if (event.type !== "content_delta" || event.content.kind !== "reasoning") return [];
      return [{ item_id: event.item_id, content: event.content }];
    });

    expect(reasoning).toEqual([
      {
        item_id: "reasoning-1",
        content: { kind: "reasoning", payload: "private thought" },
      },
      {
        item_id: "reasoning-1",
        content: {
          kind: "reasoning",
          payload: null,
          summary: "**Crafting a brief reply**",
          summary_index: 0,
        },
      },
      {
        item_id: "reasoning-1",
        content: {
          kind: "reasoning",
          payload: null,
          summary: "**Next step**",
          summary_index: 1,
        },
      },
    ]);
    const clientResponse = JSON.parse(
      new TextDecoder().decode(chatAdapter.encode(events).bytes),
    ) as { choices: Array<{ message: { reasoning_content?: string } }> };
    expect(clientResponse.choices[0]?.message.reasoning_content)
      .toBe("private thought\n\n**Crafting a brief reply**\n\n**Next step**");
  });

  test("joins fragmented summary deltas and ignores the completed item echo", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode([
          'data: {"type":"response.output_item.added","output_index":0,"item":{"id":"added-id","type":"reasoning","summary":[{"type":"summary_text","text":"**Summarizing in Indonesian**"},{"type":"summary_text","text":"Saya akan menyamakan laju tangkapan per kucing."}]}}',
          'data: {"type":"response.reasoning_summary_text.delta","item_id":"delta-id","output_index":0,"summary_index":0,"delta":"**Summarizing in Indonesian**"}',
          'data: {"type":"response.reasoning_summary_text.delta","item_id":"delta-id","output_index":0,"summary_index":1,"delta":"Saya akan meny"}',
          'data: {"type":"response.reasoning_summary_text.delta","item_id":"delta-id","output_index":0,"summary_index":2,"delta":"am la"}',
          'data: {"type":"response.reasoning_summary_text.delta","item_id":"delta-id","output_index":0,"summary_index":3,"delta":"ju tang"}',
          'data: {"type":"response.reasoning_summary_text.delta","item_id":"delta-id","output_index":0,"summary_index":4,"delta":"kapan per kucing."}',
          'data: {"type":"response.output_item.done","output_index":0,"item":{"id":"final-id","type":"reasoning","summary":[{"type":"summary_text","text":"**Summarizing in Indonesian**"},{"type":"summary_text","text":"Saya akan menyamakan laju tangkapan per kucing."}]}}',
          'data: {"type":"response.completed","response":{"status":"completed","output":[]}}',
          "data: [DONE]",
          "",
        ].join("\n\n")));
        controller.close();
      },
    });
    const request = {
      model: "test-model",
      source_surface: "responses",
      stream: true,
      messages: [],
    } as unknown as CanonicalRequest;
    const events = [];
    for await (const event of decodeResponsesSseStream(stream, request)) events.push(event);
    const clientResponse = JSON.parse(
      new TextDecoder().decode(chatAdapter.encode(events).bytes),
    ) as { choices: Array<{ message: { reasoning_content?: string } }> };

    expect(clientResponse.choices[0]?.message.reasoning_content).toBe(
      // A fragmented summary joins without losing text; the separator between
      // a part that ends mid-sentence and a capitalized continuation is a
      // space, not a paragraph break (see reasoningSummarySeparator).
      "**Summarizing in Indonesian** Saya akan menyam laju tangkapan per kucing.",
    );
  });

  test("replays encrypted reasoning under the item id it was issued for", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode([
          'data: {"type":"response.output_item.done","output_index":0,"item":{"id":"rs_17pws5a","type":"reasoning","encrypted_content":"gateway-opaque-blob","summary":[{"type":"summary_text","text":"thinking"}]}}',
          'data: {"type":"response.completed","response":{"status":"completed","output":[]}}',
          "data: [DONE]",
          "",
        ].join("\n\n")));
        controller.close();
      },
    });
    const request = {
      model: "test-model",
      source_surface: "responses",
      stream: true,
      messages: [],
    } as unknown as CanonicalRequest;
    const events = [];
    for await (const event of decodeResponsesSseStream(stream, request)) events.push(event);
    let reasoningPart: ContentPart | undefined;
    for (const event of events) {
      if (event.type !== "content_delta" || event.content.kind !== "reasoning") continue;
      reasoningPart = event.content;
      break;
    }
    // The id travels with the payload: the upstream verifies a replay against
    // the item the encrypted content was issued for.
    expect(reasoningPart).toMatchObject({
      encrypted_content: "gateway-opaque-blob",
      item_id: "rs_17pws5a",
    });
    if (reasoningPart === undefined) throw new Error("expected one reasoning part");

    const replay: Record<string, unknown> = canonicalToResponsesPayload({
      ...request,
      messages: [
        { role: "assistant", content: [reasoningPart] },
        { role: "user", content: [{ kind: "text", text: "next" }] },
      ],
      generation_controls: {},
    } as unknown as CanonicalRequest);
    const rawInput: unknown = replay["input"];
    if (!Array.isArray(rawInput)) throw new Error("expected an input item array");
    const replayed = rawInput.find(
      (item): item is Record<string, unknown> =>
        typeof item === "object" && item !== null && "type" in item && item["type"] === "reasoning",
    );
    expect(replayed).toMatchObject({ id: "rs_17pws5a", encrypted_content: "gateway-opaque-blob" });
  });
});
