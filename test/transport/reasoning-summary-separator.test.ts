/**
 * Copilot streams one thought as many summary items. The token that ends one
 * item is the first half of a word the next item finishes, so a boundary is
 * not a sentence break. Inserting one painted `Gil` in the thinking pane and
 * `iran` in the answer.
 */
import { describe, expect, test } from "bun:test";
import { groupedBlocks } from "../../src/transport/surface/messages/encode";
import { reasoningSummarySeparator } from "../../src/transport/surface/reasoning-summary";

const first = { itemId: "item-0", summaryIndex: 0 };
const second = { itemId: "item-1", summaryIndex: 0 };

describe("reasoning summary separator", () => {
  test("does not split a word across two summary items", () => {
    expect(reasoningSummarySeparator(first, second, "Gil", "iran")).toBe("");
  });

  test("does not start a new paragraph just because the next item starts with a capital", () => {
    expect(reasoningSummarySeparator(first, second, "I will inspect", "The parser"))
      .toBe(" ");
  });

  test("starts a new paragraph when the previous item ended a sentence", () => {
    expect(reasoningSummarySeparator(first, second, "selesai.", "Giliran")).toBe("\n\n");
  });

  test("starts a new paragraph for an explicit Markdown block", () => {
    expect(reasoningSummarySeparator(first, second, "Current thought", "**Next step**"))
      .toBe("\n\n");
  });

  test("joins a continuation of the same item without a break", () => {
    expect(reasoningSummarySeparator(first, first, "Gil", "iran")).toBe("");
  });
});

describe("groupedBlocks merges weak boundaries but splits strong ones", () => {
  test("Copilot-style item changes merge into one thinking block", () => {
    const { blocks } = groupedBlocks([
      { type: "response_start", sequence_number: 1 } as never,
      {
        type: "content_delta",
        sequence_number: 2,
        item_id: "item-0",
        content: { kind: "reasoning", summary: "I'm noting that the summary states ", summary_index: 0 },
      } as never,
      {
        type: "content_delta",
        sequence_number: 3,
        item_id: "item-1",
        content: { kind: "reasoning", summary: "skills are for trace-replay", summary_index: 0 },
      } as never,
      {
        type: "content_delta",
        sequence_number: 4,
        item_id: "item-2",
        content: { kind: "reasoning", summary: ", but the developer seems to have included skill details.", summary_index: 0 },
      } as never,
      { type: "terminal", sequence_number: 5, state: "complete" } as never,
    ]);
    const thinking = blocks.filter((b) => b.type === "thinking");
    expect(thinking).toHaveLength(1);
    expect(thinking[0]?.thinking).toBe(
      "I'm noting that the summary states skills are for trace-replay, but the developer seems to have included skill details.",
    );
  });

  test("a genuine sentence boundary still splits into two thinking blocks", () => {
    const { blocks } = groupedBlocks([
      { type: "response_start", sequence_number: 1 } as never,
      {
        type: "content_delta",
        sequence_number: 2,
        item_id: "item-0",
        content: { kind: "reasoning", summary: "selesai.", summary_index: 0 },
      } as never,
      {
        type: "content_delta",
        sequence_number: 3,
        item_id: "item-1",
        content: { kind: "reasoning", summary: "Giliran", summary_index: 0 },
      } as never,
      { type: "terminal", sequence_number: 4, state: "complete" } as never,
    ]);
    const thinking = blocks.filter((b) => b.type === "thinking");
    expect(thinking).toHaveLength(2);
    expect(thinking[0]?.thinking).toBe("selesai.");
    expect(thinking[1]?.thinking).toBe("\n\nGiliran");
  });
});
