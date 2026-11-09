/**
 * Completion surface reasoning-effort parsing.
 *
 * The completion adapter used to hand-roll its own effort vocabulary, missing
 * "instant" (present in the canonical tuple), so `reasoning_effort:
 * "instant"` silently dropped the reasoning intent. It now routes through the
 * shared `parseReasoningIntent`, so every canonical effort value — including
 * "instant" — must be preserved into `CanonicalRequest.reasoning.effort`, and
 * the `reasoning_level` alias must parse identically to the chat surface.
 */
import { describe, expect, test } from "bun:test";
import { REASONING_EFFORTS } from "../../../src/protocol/canonical-model";
import { completionAdapter } from "../../../src/transport/surface/completion";

function parseWith(patch: Record<string, unknown>) {
  return completionAdapter.parse({
    model: "m",
    prompt: "hello",
    stream: false,
    ...patch,
  });
}

describe("completion adapter reasoning effort", () => {
  test("every canonical effort value is preserved into reasoning.effort", () => {
    for (const effort of REASONING_EFFORTS) {
      const parsed = parseWith({ reasoning_effort: effort });
      expect(parsed.reasoning).toEqual({ effort });
    }
  });

  test('"instant" is accepted (was missing from the hand-rolled vocabulary)', () => {
    const parsed = parseWith({ reasoning_effort: "instant" });
    expect(parsed.reasoning?.effort).toBe("instant");
  });

  test("the reasoning_level alias parses identically", () => {
    for (const effort of REASONING_EFFORTS) {
      const parsed = parseWith({ reasoning_level: effort });
      expect(parsed.reasoning).toEqual({ effort });
    }
  });

  test("an invalid effort yields no reasoning intent", () => {
    const parsed = parseWith({ reasoning_effort: "ultra" });
    expect(parsed.reasoning).toBeUndefined();
  });

  test("a non-string effort yields no reasoning intent", () => {
    expect(parseWith({ reasoning_effort: 5 }).reasoning).toBeUndefined();
    expect(parseWith({ reasoning_level: null }).reasoning).toBeUndefined();
  });

  test("no effort field yields no reasoning intent", () => {
    expect(parseWith({}).reasoning).toBeUndefined();
  });
});
