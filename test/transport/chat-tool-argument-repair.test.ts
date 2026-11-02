/**
 * Copilot streams tool arguments that are not strict JSON. The client parses
 * the assembled string and, on failure, reports the call as `Tool <name> not
 * found` with the parser's own message. The repair makes the string parse
 * before it leaves the gateway.
 */
import { describe, expect, test } from "bun:test";
import { repairToolArguments } from "../../src/transport/surface/chat/encode";

describe("chat tool argument repair", () => {
  test("escapes a raw newline inside a string", () => {
    const raw = '{"command":"echo hello\nworld"}';
    const repaired = repairToolArguments(raw);
    expect(JSON.parse(repaired)).toEqual({ command: "echo hello\nworld" });
  });

  test("drops a trailing comma", () => {
    const repaired = repairToolArguments('{"path":"a.ts",}');
    expect(JSON.parse(repaired)).toEqual({ path: "a.ts" });
  });

  test("leaves valid JSON untouched", () => {
    const raw = '{"count":3,"ok":true}';
    expect(repairToolArguments(raw)).toBe(raw);
  });

  test("returns an empty call as an object", () => {
    expect(repairToolArguments("")).toBe("{}");
  });


  test("repairs an unquoted key", () => {
    const repaired = repairToolArguments('{path:"a.ts"}');
    expect(JSON.parse(repaired)).toEqual({ path: "a.ts" });
  });

  test("repairs a truncated object", () => {
    // jsonrepair completes the dangling key rather than dropping it, so the
    // call survives with an explicit null instead of failing to parse.
    const repaired = repairToolArguments('{"path":"a.ts","depth":');
    expect(JSON.parse(repaired)).toEqual({ path: "a.ts", depth: null });
  });

  // `jsonrepair` turns arbitrary prose into a quoted JSON string, which parses
  // but is not a tool-argument object. Accepting it would replace a clear
  // parser error with a silent string argument, so it must be refused.
  test("refuses text that repairs to a non-object", () => {
    expect(repairToolArguments("not json at all")).toBe("not json at all");
  });

  test("refuses text that repairs to an array", () => {
    expect(repairToolArguments("[1,2,]")).toBe("[1,2,]");
  });

  test("returns text that makes jsonrepair throw unchanged", () => {
    // A multiline patch header is not near-JSON; `jsonrepair` throws on it
    // ("Unexpected character" / "Object key expected") rather than returning a
    // repaired string. That throw must not escape — it would bubble through the
    // responses encoder into a 500 internal error. The raw text survives as the
    // caller's tool-argument payload instead.
    const raw = "*** Begin Patch\n*** Update File: src/x.ts\n@@\n- old line\n+ new line\n";
    expect(repairToolArguments(raw)).toBe(raw);
  });
});
