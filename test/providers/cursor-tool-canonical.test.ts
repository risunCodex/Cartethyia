/**
 * Cursor-native tool variants resolve to canonical calls.
 *
 * The canonical vocabulary is one name per tool: `read` covers both
 * `ReadToolCall` and the modern exec arm. The map is keyed by wire field so
 * encode/decode round-trips still preserve the exact arm that arrived.
 */
import { describe, expect, test } from "bun:test";
import {
  CURSOR_TOOL_VARIANTS,
  cursorToolArm,
  decodeCursorNativeToolCall,
} from "../../src/providers/integrations/cursor/protocol/tool-canonical";

describe("cursor native tool mapping", () => {
  test("every arm resolves to a canonical name", () => {
    const names = [...CURSOR_TOOL_VARIANTS.values()].map((v) => v.name);
    expect(names).toContain("read");
    expect(names).toContain("shell");
    expect(names).toContain("edit");
    expect(names).toContain("write");
    expect(names).toContain("grep");
    expect(names).toContain("ls");
    expect(names).toContain("delete");
    expect(names).toContain("write_shell_stdin");
    // The modern exec family is not exposed under pi_* names — those wire
    // arms are handled by the executor directly, not as separate tools.
    for (const field of [61, 62, 63, 64, 65, 66, 67]) {
      expect(CURSOR_TOOL_VARIANTS.get(field)).toBeUndefined();
    }
  });

  test("a decoded legacy call keeps its canonical name", () => {
    const decoded = decodeCursorNativeToolCall("call-1", {
      readToolCall: { args: { path: "src/main.ts" } },
    });
    expect(decoded?.name).toBe("read");
    expect(decoded?.variant.field).toBe(8);
    expect(decoded?.arguments).toEqual({ path: "src/main.ts" });
  });

  test("an unknown arm is left unclaimed", () => {
    expect(cursorToolArm({ mcpToolCall: { args: {} } })).toBeUndefined();
    expect(decodeCursorNativeToolCall("c", { mcpToolCall: { args: {} } })).toBeUndefined();
  });

  test("a ToolCall with no populated arm is not a tool call", () => {
    expect(cursorToolArm({})).toBeUndefined();
    expect(cursorToolArm({ shellToolCall: null })).toBeUndefined();
  });
});
