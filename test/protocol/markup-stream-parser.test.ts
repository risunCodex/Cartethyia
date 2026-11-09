/**
 * Shared streaming-prefix parser scaffold (P-F3).
 *
 * DSML, OMP, and Qwen all share one stateful `MarkupStreamParser` loop. This
 * suite proves the refactor is behavior-preserving: for each grammar and each
 * of its fixtures, feeding the input as chunks split at EVERY boundary (inside
 * openers, marker tails, closers, argument tags) yields exactly the same text
 * and calls as feeding the whole input at once. Grammar-specific semantics
 * (DSML byte-exact passthrough + block-size fail-open, OMP dumpminated-envelope
 * discard, Qwen opener-fragment hold) are asserted explicitly on top.
 */
import { describe, expect, test } from "bun:test";
import { DsmlStreamParser } from "../../src/protocol/dsml";
import {
  MarkupStreamParser,
  type MarkupStreamParseResult,
} from "../../src/protocol/markup-stream-parser";
import { OmpToolCallMarkupParser } from "../../src/protocol/response/omp-tool-call-markup";
import { QwenToolCallScanner } from "../../src/protocol/translation/dialect/qwen";

interface BoundParser<C extends { readonly id: string }> {
  push(chunk: string): MarkupStreamParseResult<C>;
  flush(): MarkupStreamParseResult<C>;
}

/** Feeds `input` in two chunks split at `cut`, then drains the tail. */
function splitAggregate<C extends { readonly id: string }>(
  make: () => BoundParser<C>,
  input: string,
  cut: number,
): MarkupStreamParseResult<C> {
  const parser = make();
  const first = parser.push(input.slice(0, cut));
  const second = parser.push(input.slice(cut));
  const tail = parser.flush();
  return {
    text: first.text + second.text + tail.text,
    calls: [...first.calls, ...second.calls, ...tail.calls],
  };
}

/** Feeds `input` whole, then drains the tail. */
function monolithic<C extends { readonly id: string }>(
  make: () => BoundParser<C>,
  input: string,
): MarkupStreamParseResult<C> {
  const parser = make();
  const first = parser.push(input);
  const tail = parser.flush();
  return { text: first.text + tail.text, calls: [...first.calls, ...tail.calls] };
}

/** Every cut point must reproduce the monolithic result exactly. */
function assertSplitEquivalence<C extends { readonly id: string }>(
  make: () => BoundParser<C>,
  input: string,
): void {
  const expected = monolithic(make, input);
  for (let cut = 0; cut <= input.length; cut += 1) {
    const got = splitAggregate(make, input, cut);
    try {
      expect(got).toEqual(expected);
    } catch (error) {
      throw new Error(`split mismatch at cut ${cut}: ${String(error)}`);
    }
  }
}

const PIPE = "｜｜"; // ｜｜

const NAMED = new Set(["exec_command"]);

const DSML_BLOCK =
  `<${PIPE}DSML${PIPE} calls>\n` +
  `<${PIPE}DSML${PIPE} invoke name="exec_command">\n` +
  `<${PIPE}DSML${PIPE} parameter name="cmd" string="true">ls -la</${PIPE}DSML${PIPE} parameter>\n` +
  `</${PIPE}DSML${PIPE} invoke>\n` +
  `</${PIPE}DSML${PIPE} calls>`;

describe("MarkupStreamParser chunk-split equivalence", () => {
  test("DSML: prose around two strict blocks", () => {
    const input = `Intro.\n${DSML_BLOCK}\nMiddle.\n${DSML_BLOCK}\nOutro.`;
    assertSplitEquivalence(() => new DsmlStreamParser({ allowedNames: NAMED }), input);
  });

  test("DSML: an impure block passes through byte-exact", () => {
    const opener = `<${PIPE}DSML${PIPE} calls>`;
    const closer = `</${PIPE}DSML${PIPE} calls>`;
    const impure = opener + "leading junk\n" + DSML_BLOCK.slice(opener.length, -closer.length) + closer;
    assertSplitEquivalence(() => new DsmlStreamParser({ allowedNames: NAMED }), `x ${impure} y`);
    const result = splitAggregate(() => new DsmlStreamParser({ allowedNames: NAMED }), `x ${impure} y`, 0);
    expect(result.text).toBe(`x ${impure} y`);
    expect(result.calls).toHaveLength(0);
  });

  test("DSML: an unclosed block past the cap fails open", () => {
    const opener = `<${PIPE}DSML${PIPE} calls>`;
    const payload = "x".repeat(64);
    const input = opener + payload + `</${PIPE}DSML${PIPE} calls>tail`;
    assertSplitEquivalence(
      () => new DsmlStreamParser({ allowedNames: NAMED, maxBlockBytes: 16 }),
      input,
    );
    const result = splitAggregate(
      () => new DsmlStreamParser({ allowedNames: NAMED, maxBlockBytes: 16 }),
      input,
      0,
    );
    expect(result.text).toBe(input);
    expect(result.calls).toHaveLength(0);
  });

  test("OMP: prose around two complete envelopes", () => {
    const markerA = "6124c78e";
    const markerB = "abcd0001";
    const envelope = (marker: string): string =>
      `<tool_calls:${marker}><tool_call:${marker}>todo` +
      `<arg_key:${marker}>op</arg_key:${marker}><arg_value:${marker}>init</arg_value:${marker}>` +
      `</tool_call:${marker}></tool_calls:${marker}>`;
    const input = `Planning. ${envelope(markerA)} then ${envelope(markerB)} Done.`;
    assertSplitEquivalence(() => new OmpToolCallMarkupParser(new Set(["todo"])), input);
    const result = splitAggregate(() => new OmpToolCallMarkupParser(new Set(["todo"])), input, 0);
    expect(result.calls).toHaveLength(2);
    expect(result.text).toBe("Planning.  then  Done.");
  });

  test("OMP: an unterminated envelope is discarded at flush", () => {
    const marker = "6124c78e";
    const partial =
      `<tool_calls:${marker}><tool_call:${marker}>todo` +
      `<arg_key:${marker}>op</arg_key:${marker}><arg_value:${marker}>init`;
    const input = `before ${partial}`;
    assertSplitEquivalence(() => new OmpToolCallMarkupParser(new Set(["todo"])), input);
    const result = splitAggregate(() => new OmpToolCallMarkupParser(new Set(["todo"])), input, 0);
    expect(result.text).toBe("before ");
    expect(result.calls).toHaveLength(0);
  });

  test("Qwen: prose around two JSON tool-call blocks", () => {
    const block = '<tool_call>{"name":"web_search","arguments":{"query":"ok"}}</tool_call>';
    const input = `Before ${block} mid ${block} after`;
    assertSplitEquivalence(() => new QwenToolCallScanner(new Set(["web_search"])), input);
    const result = splitAggregate(() => new QwenToolCallScanner(new Set(["web_search"])), input, 0);
    expect(result.calls).toHaveLength(2);
    expect(result.text).toBe("Before  mid  after");
  });

  test("Qwen: an unterminated block is dropped at flush", () => {
    const input = '<tool_call>{"name":"web_search"';
    assertSplitEquivalence(() => new QwenToolCallScanner(new Set(["web_search"])), input);
    const result = splitAggregate(() => new QwenToolCallScanner(new Set(["web_search"])), input, 0);
    expect(result.text).toBe("");
    expect(result.calls).toHaveLength(0);
  });

  test("Qwen: an undeclared tool name stays text", () => {
    const input = '<tool_call>{"name":"unsafe","arguments":{}}</tool_call>';
    assertSplitEquivalence(() => new QwenToolCallScanner(new Set(["safe"])), input);
    const result = splitAggregate(() => new QwenToolCallScanner(new Set(["safe"])), input, 0);
    expect(result.calls).toHaveLength(0);
    expect(result.text).toBe(input);
  });
});

describe("MarkupStreamParser core options", () => {
  const call = (value: string): { readonly id: string; readonly value: string } => ({
    id: `c_${value}`,
    value,
  });

  test("classification: literal skip vs hold vs found", () => {
    const makeParser = () =>
      new MarkupStreamParser<{ readonly id: string; readonly value: string }>({
        openers: ["<B:"],
        classifyOpener: (pending, index) => {
          const remainder = pending.slice(index);
          const opening = /^<B:([0-9a-f]{8})>/.exec(remainder);
          if (opening === null) {
            if (remainder.startsWith("<B:") && /^[0-9a-f]{0,8}$/.test(remainder.slice(3))) {
              return { kind: "hold" };
            }
            return { kind: "literal" };
          }
          return {
            kind: "found",
            closer: "</B>",
            parse: () => [{ value: opening[1] as string }],
            callId: (raw, _index, _seq) => call(raw.value),
          };
        },
      });

    // A non-hex candidate is literal text: "<" is emitted and the rest settles.
    const bad = makeParser().push("a <B:zzz tail");
    expect(bad.text).toBe("a <B:zzz tail");
    expect(bad.calls).toHaveLength(0);

    // A partial hex candidate is held across chunks until the closer arrives.
    const held = makeParser();
    const first = held.push("<B:12");
    expect(first.text).toBe("");
    expect(first.calls).toHaveLength(0);
    const second = held.push("345678>ok</B>rest");
    expect(second.calls).toHaveLength(1);
    expect(second.calls[0]).toEqual(call("12345678"));
    expect(second.text).toBe("rest");
    expect(held.flush().text).toBe("");
  });

  test("fail-open onUnclosed emits from the opener past the cap", () => {
    const parser = new MarkupStreamParser<{ readonly id: string; readonly value: string }>({
      openers: ["<B>"],
      classifyOpener: () => ({ kind: "found", closer: "</B>", parse: () => undefined }),
      onUnclosed: (pending, openIndex) =>
        pending.length - openIndex > 8 ? { kind: "passThrough" } : "hold",
    });
    const first = parser.push("<B>0123456789");
    expect(first.text).toBe("<B>0123456789");
    expect(first.calls).toHaveLength(0);
    expect(parser.flush().text).toBe("");
  });

  test("flush discards a held opener tail when the policy says so", () => {
    const parser = new MarkupStreamParser<{ readonly id: string; readonly value: string }>({
      openers: ["<B>"],
      classifyOpener: () => ({ kind: "hold" }),
      flush: (pending) => (pending.startsWith("<B>") ? "" : pending),
    });
    parser.push("<B>stuff");
    expect(parser.flush().text).toBe("");
  });
});
