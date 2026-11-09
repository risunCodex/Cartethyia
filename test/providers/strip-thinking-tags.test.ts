import { describe, expect, test } from "bun:test";
import { stripThinkingTags, ThinkingTagStripper } from "../../src/protocol/think-split";

/**
 * The reasoning path on `chat.ts` forwards `reasoning_content` through to the
 * client verbatim. hy4-preview-f (and other buddy reasoning models) sometimes
 * double-wraps the field with `<think>…</think>`, so the tag bytes reach the
 * client as literal text — a reader then sees the "reasoning" as the tagged
 * block and reports the model as not thinking at all.
 *
 * `stripThinkingTags` is the helper the reasoning path runs each settled value
 * through. These lock the shape it has to keep.
 */

describe("stripThinkingTags — the reasoning path's defence against upstream double-wrap", () => {
  test("drops a paired think wrapper and keeps the inner text", () => {
    expect(stripThinkingTags("<think>step one</think>")).toBe("step one");
  });

  test("drops both tag spellings — <think> and <thinking>", () => {
    expect(stripThinkingTags("<thinking>a</thinking><think>b</think>")).toBe("ab");
  });

  test("keeps a stray closing tag that has no opener", () => {
    // An unpaired closing tag is the subject of the answer — a model reciting
    // the syntax — not markup that leaked. Swallowing it silently rewrote the
    // answer, which is a class of poisoning in its own right.
    expect(stripThinkingTags("step one</think>")).toBe("step one</think>");
  });

  test("keeps an opening tag whose close never arrived", () => {
    expect(stripThinkingTags("see <think> syntax")).toBe("see <think> syntax");
  });

  test("drops an open tag that carries attributes", () => {
    expect(stripThinkingTags('<think signature="x">inside</think>')).toBe("inside");
  });

  test("drops whitespace inside the closing tag", () => {
    expect(stripThinkingTags("<think>inside</think >")).toBe("inside");
  });
  test("leaves a value with no tag characters untouched (no allocation)", () => {
    const value = "plain reasoning text, no tags at all";
    expect(stripThinkingTags(value)).toBe(value);
  });

  test("leaves `<` that is not part of a think tag alone", () => {
    expect(stripThinkingTags("a < b and c > d")).toBe("a < b and c > d");
  });

  test("case variants are deliberately left for the splitter to find", () => {
    // The reasoning leak this closes is lowercase; mixed-case is a separate
    // signal, so the function does not quietly expand what it says it strips.
    expect(stripThinkingTags("<Think>x</Think>")).toBe("<Think>x</Think>");
  });

  test("handles multiple wrapped segments in one string", () => {
    expect(stripThinkingTags("<think>a</think>mid<think>b</think>")).toBe("amidb");
  });
});

describe("ThinkingTagStripper — order-preserving reasoning-channel strip", () => {
  test("preserves source order across tagged and untagged content", () => {
    const s = new ThinkingTagStripper();
    expect(s.push("thought A <think>inner</think> thought B")).toBe("thought A inner thought B");
    expect(s.flush()).toBe("");
  });

  test("recognizes an opening tag split across two deltas", () => {
    const s = new ThinkingTagStripper();
    expect(s.push("thought A <thi")).toBe("thought A ");
    expect(s.push("nk>inner</think> thought B")).toBe("inner thought B");
    expect(s.flush()).toBe("");
  });

  test("recognizes a closing tag split across two deltas", () => {
    const s = new ThinkingTagStripper();
    expect(s.push("thought A <think>inner</thi")).toBe("thought A ");
    expect(s.push("nk> thought B")).toBe("inner thought B");
    expect(s.flush()).toBe("");
  });

  test("keeps multiple interleaved spans in order", () => {
    const s = new ThinkingTagStripper();
    expect(s.push("a <think>1</think> b <think>2</think> c")).toBe("a 1 b 2 c");
  });

  test("fail-opens an unclosed span verbatim, restoring its opening tag", () => {
    const s = new ThinkingTagStripper();
    expect(s.push("thought A <think>never closed")).toBe("thought A ");
    expect(s.flush()).toBe("<think>never closed");
  });

  test("leaves code spans alone", () => {
    const s = new ThinkingTagStripper();
    expect(s.push("see <think> literal `code` </think> after")).toBe("see  literal `code`  after");
  });
});
