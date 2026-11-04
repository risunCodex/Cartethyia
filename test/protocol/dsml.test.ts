import { expect, test } from "bun:test";
import {
  DsmlStreamParser,
  parseDsmlToolCalls,
  type DsmlParseOptions,
  type DsmlToolCall,
} from "../../src/protocol/dsml";

/**
 * Strict-dialect matrix, ported from the codebuddy2api reference bridge
 * (`app/dsml.py` + `tests/test_dsml.py`). These pin the CodeBuddy/WorkBuddy
 * wire behavior: exact variants, byte-exact rejection, allowlist semantics,
 * streaming boundary handling, and the oversized-unclosed-block guard.
 */

// Full-width bars are written as escapes on purpose: a silently mangled copy
// would test nothing while still looking green.
const PIPE = "\uFF5C\uFF5C"; // ｜｜
const WIDE = "\uFF5C"; // ｜
const BAR = "|";

type StrictResult = { text: string; calls: readonly DsmlToolCall[] };

/** Strict parse: the CodeBuddy dialect's `{ text, calls }` shape. */
function strictParse(text: string, options: DsmlParseOptions = {}): StrictResult | undefined {
  const recovered = parseDsmlToolCalls(text, options);
  if (recovered === undefined) return undefined;
  return "text" in recovered ? { text: recovered.text, calls: recovered.calls } : undefined;
}

const DSML_BLOCK =
  `<${PIPE}DSML${PIPE} calls>\n` +
  `<${PIPE}DSML${PIPE} invoke name="exec_command">\n` +
  `<${PIPE}DSML${PIPE} parameter name="cmd" string="true">ls -la</${PIPE}DSML${PIPE} parameter>\n` +
  `</${PIPE}DSML${PIPE} invoke>\n` +
  `</${PIPE}DSML${PIPE} calls>`;

const ARGS = '{"cmd":"ls -la"}';
const NAMED = new Set(["exec_command"]);

function variantBlock(sep: string, name: string): string {
  return (
    `<${sep}DSML${sep} ${name}>` +
    `<${sep}DSML${sep} invoke name="exec_command">` +
    `<${sep}DSML${sep} parameter name="cmd" string="true">ls -la</${sep}DSML${sep} parameter>` +
    `</${sep}DSML${sep} invoke>` +
    `</${sep}DSML${sep} ${name}>`
  );
}

function renamedBlock(name: string): string {
  return DSML_BLOCK.replace('name="exec_command"', `name="${name}"`);
}

test("a whole strict block converts and leaves clean text", () => {
  const recovered = strictParse(DSML_BLOCK, { allowedNames: NAMED });
  expect(recovered?.text).toBe("");
  expect(recovered?.calls).toHaveLength(1);
  expect(recovered?.calls[0]?.name).toBe("exec_command");
  expect(recovered?.calls[0]?.arguments).toBe(ARGS);
});

test("split at every boundary converts exactly once", () => {
  for (let cut = 1; cut < DSML_BLOCK.length; cut += 1) {
    const parser = new DsmlStreamParser({ allowedNames: NAMED });
    const first = parser.push(DSML_BLOCK.slice(0, cut));
    const last = parser.push(DSML_BLOCK.slice(cut));
    const tail = parser.flush();
    expect(`${first.text}${last.text}${tail.text}`).toBe("");
    const calls = [...first.calls, ...last.calls, ...tail.calls];
    expect(calls).toHaveLength(1);
    expect(calls[0]?.arguments).toBe(ARGS);
  }
});

test("impure blocks are returned byte-exact", () => {
  const opener = `<${PIPE}DSML${PIPE} calls>`;
  const closer = `</${PIPE}DSML${PIPE} calls>`;
  const inner = DSML_BLOCK.slice(opener.length, -closer.length);
  const variants = [
    opener + "leading junk\n" + inner + closer,
    DSML_BLOCK.slice(0, -closer.length) + "trailing junk" + closer,
    opener + "only prose, no invoke" + closer,
  ];
  for (const marked of variants) {
    expect(strictParse(marked, { allowedNames: NAMED })).toBeUndefined();
    // The streaming parser must pass the rejected block through byte-for-byte.
    const parser = new DsmlStreamParser({ allowedNames: NAMED });
    const first = parser.push(marked);
    const tail = parser.flush();
    expect(`${first.text}${tail.text}`).toBe(marked);
    expect([...first.calls, ...tail.calls]).toHaveLength(0);
  }
});

test("strict mode rejects undeclared names", () => {
  const renamed = renamedBlock("shell_exec");
  expect(strictParse(renamed, { allowedNames: NAMED })).toBeUndefined();
  const parser = new DsmlStreamParser({ allowedNames: NAMED });
  const first = parser.push(renamed);
  const tail = parser.flush();
  expect(`${first.text}${tail.text}`).toBe(renamed);
  expect([...first.calls, ...tail.calls]).toHaveLength(0);
});

test("weak mode accepts identifier names only", () => {
  const weak = new DsmlStreamParser({ allowedNames: new Set() });
  const block = variantBlock(BAR, "function_calls").replace(
    'name="exec_command"',
    'name="browser.navigate"',
  );
  const first = weak.push(block);
  const tail = weak.flush();
  expect(first.text).toBe("");
  expect(first.calls).toHaveLength(1);
  expect(first.calls[0]?.name).toBe("browser.navigate");
  expect(tail.text).toBe("");

  const bad = renamedBlock("<tool_name>");
  const badParser = new DsmlStreamParser({ allowedNames: new Set() });
  const badFirst = badParser.push(bad);
  const badTail = badParser.flush();
  expect(`${badFirst.text}${badTail.text}`).toBe(bad);
  expect([...badFirst.calls, ...badTail.calls]).toHaveLength(0);
});

test("ascii and single-bar variants convert", () => {
  for (const [sep, name] of [
    [BAR, "function_calls"],
    [WIDE, "calls"],
  ] as const) {
    const recovered = strictParse(variantBlock(sep, name), { allowedNames: NAMED });
    expect(recovered?.calls).toHaveLength(1);
    expect(recovered?.calls[0]?.arguments).toBe(ARGS);
  }
});

test("mismatched separators never convert", () => {
  const marked =
    `<${PIPE}DSML${PIPE} calls>` +
    `<${BAR}DSML${BAR} invoke name="exec_command">` +
    `<${BAR}DSML${BAR} parameter name="cmd" string="true">ls -la</${BAR}DSML${BAR} parameter>` +
    `</${BAR}DSML${BAR} invoke>` +
    `</${BAR}DSML${BAR} function_calls>`;
  const parser = new DsmlStreamParser({ allowedNames: NAMED });
  const first = parser.push(marked + "tail");
  const tail = parser.flush();
  expect(first.text).toBe("");
  expect([...first.calls, ...tail.calls]).toHaveLength(0);
  expect(`${first.text}${tail.text}`).toBe(marked + "tail");
});

test("an unclosed block is flushed verbatim", () => {
  const parser = new DsmlStreamParser({ allowedNames: NAMED });
  const opener = `<${PIPE}DSML${PIPE} calls>`;
  const invoke = `<${PIPE}DSML${PIPE} invoke name="exec_command">`;
  const first = parser.push(opener + invoke);
  expect(first.text).toBe("");
  expect(first.calls).toHaveLength(0);
  expect(parser.flush().text).toBe(opener + invoke);
});

test("an unclosed block past the cap passes through as text", () => {
  // Small cap so the test stays fast; the production default matches the
  // reference's 256 KB.
  const parser = new DsmlStreamParser({ allowedNames: NAMED, maxBlockBytes: 16 });
  const opener = `<${PIPE}DSML${PIPE} calls>`;
  const payload = "x".repeat(64);
  const first = parser.push(opener + payload);
  expect(first.calls).toHaveLength(0);
  expect(first.text).toBe(opener + payload);
  const second = parser.push(`</${PIPE}DSML${PIPE} calls>tail`);
  expect(second.text).toBe(`</${PIPE}DSML${PIPE} calls>tail`);
  expect(second.calls).toHaveLength(0);
});

test("parameter type variants decode like the reference", () => {
  const block =
    `<${PIPE}DSML${PIPE} calls>` +
    `<${PIPE}DSML${PIPE} invoke name="exec_command">` +
    `<${PIPE}DSML${PIPE} parameter name="cmd" string="true">ls -la</${PIPE}DSML${PIPE} parameter>` +
    `<${PIPE}DSML${PIPE} parameter name="timeout">30</${PIPE}DSML${PIPE} parameter>` +
    `<${PIPE}DSML${PIPE} parameter name="opts">{"a": 1}</${PIPE}DSML${PIPE} parameter>` +
    `<${PIPE}DSML${PIPE} parameter name="broken">[1,2</${PIPE}DSML${PIPE} parameter>` +
    `</${PIPE}DSML${PIPE} invoke></${PIPE}DSML${PIPE} calls>`;
  const recovered = strictParse(block, { allowedNames: NAMED });
  // Keys are recursively sorted (sort_keys=True), broken JSON falls back to
  // its raw string, `string="true"` stays raw, and the rest parses as JSON.
  expect(recovered?.calls[0]?.arguments).toBe(
    '{"broken":"[1,2","cmd":"ls -la","opts":{"a":1},"timeout":30}',
  );
});

test("prose before, between, and after blocks survives untouched", () => {
  const text = `Intro.\n${DSML_BLOCK}\nMiddle.\n${DSML_BLOCK}\nOutro.`;
  const recovered = strictParse(text, { allowedNames: NAMED });
  expect(recovered?.text).toBe("Intro.\n\nMiddle.\n\nOutro.");
  expect(recovered?.calls).toHaveLength(2);
  expect(recovered?.calls[0]?.id).not.toBe(recovered?.calls[1]?.id);
});

test("a partial opener at a chunk edge waits for the next chunk", () => {
  const parser = new DsmlStreamParser({ allowedNames: NAMED });
  const cut = 11; // inside `<｜｜DSML｜｜ calls>`
  const first = parser.push(DSML_BLOCK.slice(0, cut));
  expect(first.calls).toHaveLength(0);
  // The pending opener must not be emitted as visible prose yet.
  expect(first.text).toBe("");
  const last = parser.push(DSML_BLOCK.slice(cut));
  const tail = parser.flush();
  expect([...first.calls, ...last.calls, ...tail.calls]).toHaveLength(1);
  expect(`${first.text}${last.text}${tail.text}`).toBe("");
});
