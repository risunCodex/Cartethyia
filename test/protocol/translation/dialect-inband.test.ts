/**
 * In-band tool-call scanner tests: Qwen <tool_call> JSON, and dialect-gated
 * selection in the chat SSE decoder.
 */
import { describe, expect, test } from "bun:test";
import { QwenToolCallScanner } from "../../../src/protocol/translation/dialect/qwen";
import { createInbandScanner } from "../../../src/protocol/translation/dialect/inband";

describe("QwenToolCallScanner", () => {
  test("recovers a complete <tool_call> JSON block", () => {
    const scanner = new QwenToolCallScanner(new Set(["web_search"]));
    const result = scanner.push(
      'Before <tool_call>{"name":"web_search","arguments":{"query":"ok"}}</tool_call> after',
    );
    expect(result.text).toBe("Before  after");
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0]!.name).toBe("web_search");
    expect(result.calls[0]!.arguments).toContain('"query"');
  });

  test("holds a split opener across chunks", () => {
    const scanner = new QwenToolCallScanner(new Set(["web_search"]));
    const first = scanner.push("x <tool");
    expect(first.text).toBe("x ");
    const second = scanner.push('_call>{"name":"web_search","arguments":{}}</tool_call>');
    expect(second.calls).toHaveLength(1);
    expect(second.text).toBe("");
  });

  test("undeclared tool names stay text", () => {
    const scanner = new QwenToolCallScanner(new Set(["safe"]));
    const result = scanner.push('<tool_call>{"name":"unsafe","arguments":{}}</tool_call>');
    expect(result.calls).toHaveLength(0);
    expect(result.text).toContain("<tool_call>");
  });

  test("unterminated block is dropped on flush, not leaked", () => {
    const scanner = new QwenToolCallScanner(new Set(["web_search"]));
    scanner.push("<tool_call>{\"name\":\"web_search\"");
    const result = scanner.flush();
    expect(result.calls).toHaveLength(0);
    expect(result.text).toBe("");
  });
});

describe("createInbandScanner", () => {
  test("selects scanners by dialect", () => {
    expect(createInbandScanner("qwen", new Set())).toBeInstanceOf(QwenToolCallScanner);
    expect(createInbandScanner("deepseek", new Set())).toBeDefined();
    expect(createInbandScanner("openai", new Set())).toBeUndefined();
    expect(createInbandScanner(null, new Set())).toBeUndefined();
  });
});
