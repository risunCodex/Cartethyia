/**
 * Copilot streams one thought as many summary items. The token that ends one
 * item is the first half of a word the next item finishes, so a boundary is
 * not a sentence break. Inserting one painted `Gil` in the thinking pane and
 * `iran` in the answer.
 */
import { describe, expect, test } from "bun:test";
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
