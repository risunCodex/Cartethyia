/**
 * The shared tool pairing ledger (proposal F-5) and the arguments
 * normalizer (F-4) — the two rules that previously lived on one surface
 * each and produced different verdicts for the same transcript elsewhere.
 */
import { describe, expect, test } from "bun:test";
import type { CanonicalMessage } from "../../src/protocol/canonical-model";
import {
  dropUnpairedToolResults,
  scanToolPairingIssues,
} from "../../src/protocol/tool-ledger";
import { normalizeToolCallArguments } from "../../src/protocol/tool-arguments";

const call = (callId: string, name = "tool"): CanonicalMessage["content"][number] => ({
  kind: "toolCall",
  call_id: callId,
  name,
  arguments: "{}",
});

const result = (callId: string): CanonicalMessage["content"][number] => ({
  kind: "toolResult",
  call_id: callId,
  content: "ok",
});

const text = (value: string): CanonicalMessage["content"][number] => ({ kind: "text", text: value });

describe("scanToolPairingIssues", () => {
  test("a paired exchange has no issues", () => {
    const messages: CanonicalMessage[] = [
      { role: "assistant", content: [call("c1")] },
      { role: "tool", content: [result("c1")] },
    ];
    expect(scanToolPairingIssues(messages)).toEqual([]);
  });

  test("a result answered in a user turn pairs (Messages re-homes results there)", () => {
    const messages: CanonicalMessage[] = [
      { role: "assistant", content: [call("c1")] },
      { role: "user", content: [result("c1")] },
    ];
    expect(scanToolPairingIssues(messages)).toEqual([]);
  });

  test("an orphan result in a tool turn is reported", () => {
    const messages: CanonicalMessage[] = [{ role: "tool", content: [result("ghost")] }];
    expect(scanToolPairingIssues(messages)).toEqual([
      { code: "orphan_result", callId: "ghost", messageIndex: 0 },
    ]);
  });

  test("an orphan result in a system turn is NOT reported (results cannot live there)", () => {
    const messages: CanonicalMessage[] = [{ role: "system", content: [result("ghost")] }];
    expect(scanToolPairingIssues(messages)).toEqual([]);
  });

  test("a duplicate result for one call is reported", () => {
    const messages: CanonicalMessage[] = [
      { role: "assistant", content: [call("c1")] },
      { role: "tool", content: [result("c1")] },
      { role: "tool", content: [result("c1")] },
    ];
    expect(scanToolPairingIssues(messages)).toEqual([
      { code: "duplicate_result", callId: "c1", messageIndex: 2 },
    ]);
  });

  test("a duplicate call id is reported", () => {
    const messages: CanonicalMessage[] = [
      { role: "assistant", content: [call("c1")] },
      { role: "assistant", content: [call("c1")] },
    ];
    expect(scanToolPairingIssues(messages)).toEqual([
      { code: "duplicate_call", callId: "c1", messageIndex: 1 },
    ]);
  });

  test("a call without a name is invalid", () => {
    const messages: CanonicalMessage[] = [
      { role: "assistant", content: [{ kind: "toolCall", call_id: "c1", name: "", arguments: "{}" }] },
    ];
    expect(scanToolPairingIssues(messages)).toEqual([
      { code: "invalid_call", callId: "c1", messageIndex: 0 },
    ]);
  });

  test("an exempt result id (hosted server tool) is neither orphan nor duplicate", () => {
    const messages: CanonicalMessage[] = [
      { role: "user", content: [result("srvu_1"), result("srvu_1")] },
    ];
    expect(
      scanToolPairingIssues(messages, { exemptResultId: (id) => id.startsWith("srvu_") }),
    ).toEqual([]);
  });
});

describe("dropUnpairedToolResults (the Chat/Responses ingress repair)", () => {
  test("orphan results are dropped with their now-empty turns", () => {
    const messages: CanonicalMessage[] = [
      { role: "user", content: [text("hello")] },
      { role: "tool", content: [result("ghost")] },
      { role: "tool", content: [result("ghost"), text("kept")] },
    ];
    const repaired = dropUnpairedToolResults(messages);
    expect(repaired).toEqual([
      { role: "user", content: [text("hello")] },
      { role: "tool", content: [text("kept")] },
    ]);
  });

  test("duplicate results are dropped, first result wins", () => {
    const messages: CanonicalMessage[] = [
      { role: "assistant", content: [call("c1")] },
      { role: "tool", content: [result("c1")] },
      { role: "tool", content: [result("c1")] },
    ];
    const repaired = dropUnpairedToolResults(messages);
    expect(repaired.length).toBe(2);
    expect(repaired[1]?.content).toEqual([result("c1")]);
  });

  test("calls are never touched (synthesis is a dispatch decision)", () => {
    const messages: CanonicalMessage[] = [{ role: "assistant", content: [call("lonely")] }];
    expect(dropUnpairedToolResults(messages)).toEqual(messages);
  });

  test("an unchanged history returns the same reference", () => {
    const messages: CanonicalMessage[] = [
      { role: "assistant", content: [call("c1")] },
      { role: "tool", content: [result("c1")] },
    ];
    expect(dropUnpairedToolResults(messages)).toBe(messages);
  });
});

describe("normalizeToolCallArguments (F-4)", () => {
  test("absent and blank arguments are a zero-arg call", () => {
    expect(normalizeToolCallArguments(undefined, "f")).toBe("{}");
    expect(normalizeToolCallArguments(null, "f")).toBe("{}");
    expect(normalizeToolCallArguments("", "f")).toBe("{}");
    expect(normalizeToolCallArguments("   ", "f")).toBe("{}");
  });

  test("an object is stringified once", () => {
    expect(normalizeToolCallArguments({ a: 1 }, "f")).toBe('{"a":1}');
  });

  test("a caller string that already parses to an object is kept verbatim", () => {
    // Byte fidelity: no re-serialization, so a passthrough request keeps the
    // exact argument bytes it arrived with.
    expect(normalizeToolCallArguments('{"a": 1, "b":2}', "f")).toBe('{"a": 1, "b":2}');
  });

  test("a non-JSON string is rejected, never forwarded", () => {
    // The exact payload the Chat surface used to forward verbatim; jsonrepair
    // cannot turn prose into an object, so it is refused at ingress.
    expect(() => normalizeToolCallArguments("not json{", "f")).toThrow("must be valid JSON");
  });

  test("near-JSON a bridge legitimately streams is repaired once at ingress", () => {
    // Trailing comma — the shape pinned by the VS Code cross-surface session.
    expect(normalizeToolCallArguments('{"path":"a.ts",}', "f")).toBe('{"path":"a.ts"}');
    expect(normalizeToolCallArguments("{a:1}", "f")).toBe('{"a":1}');
  });

  test("valid JSON that is not an object is rejected", () => {
    expect(() => normalizeToolCallArguments("42", "f")).toThrow("must be a JSON object");
    expect(() => normalizeToolCallArguments('"text"', "f")).toThrow("must be a JSON object");
    expect(() => normalizeToolCallArguments("[1,2]", "f")).toThrow("must be a JSON object");
  });

  test("any other value is rejected", () => {
    expect(() => normalizeToolCallArguments(42, "f")).toThrow("must be a JSON object");
    expect(() => normalizeToolCallArguments(true, "f")).toThrow("must be a JSON object");
    expect(() => normalizeToolCallArguments([1], "f")).toThrow("must be a JSON object");
  });
});
