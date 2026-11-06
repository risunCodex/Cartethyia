/**
 * Cursor native-tool executor unit tests.
 *
 * Exercises `executeNativeTool` directly against a temp workspace: every
 * executable variant, path-escape refusal, shell handling, and the result
 * field names the exec frame expects.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { executeNativeTool, isExecutableNativeTool } from "../../src/providers/integrations/cursor/cursor-exec";
import { CURSOR_TOOL_VARIANTS } from "../../src/providers/integrations/cursor/protocol/tool-canonical";

const WORKSPACE = mkdtempSync(join(tmpdir(), "cursor-exec-test-"));

function setup(): void {
  rmSync(WORKSPACE, { recursive: true, force: true });
  mkdirSync(WORKSPACE, { recursive: true });
  mkdirSync(join(WORKSPACE, "src"), { recursive: true });
  writeFileSync(join(WORKSPACE, "src", "a.ts"), "export const x = 1;\n");
  writeFileSync(join(WORKSPACE, "README.md"), "# Test\n\nHello world.\n");
}

function variantNamed(name: string) {
  for (const v of CURSOR_TOOL_VARIANTS.values()) {
    if (v.name === name) return v;
  }
  return undefined;
}

async function run(name: string, args: Record<string, unknown>) {
  const variant = variantNamed(name);
  if (!variant) throw new Error(`no variant ${name}`);
  return await executeNativeTool(variant, args, WORKSPACE);
}

beforeEach(setup);

describe("Cursor native tool executor", () => {
  test("covers the native exec surface", () => {
    const executable = [...CURSOR_TOOL_VARIANTS.values()].filter(isExecutableNativeTool).map((v) => v.name);
    for (const name of ["read", "pi_read", "write", "pi_write", "grep", "pi_grep", "shell", "pi_bash", "ls", "pi_ls", "pi_edit", "pi_find", "delete"]) {
      expect(executable).toContain(name);
    }
  });

  test("read returns content and the read_result field", async () => {
    const result = await run("read", { path: "src/a.ts" });
    expect(result?.field).toBe("read_result");
    const success = result?.message["success"] as Record<string, unknown>;
    expect(success["content"]).toContain("export const x");
    expect(success["path"]).toContain("a.ts");
  });

  test("read missing file returns file_not_found", async () => {
    const result = await run("read", { path: "nope.ts" });
    expect(result?.message["file_not_found"]).toBeDefined();
  });

  test("read escaping the root is rejected", async () => {
    const result = await run("read", { path: "../outside.ts" });
    expect(result?.message["rejected"]).toBeDefined();
  });

  test("pi_read returns pi_read_result with output", async () => {
    const result = await run("pi_read", { path: "src/a.ts" });
    expect(result?.field).toBe("pi_read_result");
    const success = result?.message["success"] as Record<string, unknown>;
    expect(success["output"]).toContain("export const x");
  });

  test("write creates the file", async () => {
    const result = await run("write", { path: "out.txt", content: "hello\n" });
    expect(result?.field).toBe("write_result");
    expect(existsSync(join(WORKSPACE, "out.txt"))).toBe(true);
    expect(readFileSync(join(WORKSPACE, "out.txt"), "utf8")).toBe("hello\n");
  });

  test("pi_write creates nested paths", async () => {
    const result = await run("pi_write", { path: "nested/deep.txt", content: "x" });
    expect(result?.field).toBe("pi_write_result");
    expect(existsSync(join(WORKSPACE, "nested", "deep.txt"))).toBe(true);
  });

  test("grep finds matches", async () => {
    const result = await run("grep", { pattern: "export const", path: "." });
    expect(result?.field).toBe("grep_result");
    const success = result?.message["success"] as Record<string, unknown>;
    const workspace = success["workspace_results"] as Record<string, { content?: { matches?: unknown[] } }>;
    expect(workspace[""]?.["content"]?.["matches"]?.length).toBeGreaterThan(0);
  });

  test("pi_grep finds matches", async () => {
    const result = await run("pi_grep", { pattern: "export const", path: "." });
    expect(result?.field).toBe("pi_grep_result");
    const success = result?.message["success"] as Record<string, unknown>;
    expect(success["output"]).toContain("a.ts");
  });

  test("shell runs a command and returns shell_result", async () => {
    const result = await run("shell", { command: "echo hi", working_directory: "." });
    expect(result?.field).toBe("shell_result");
    const success = result?.message["success"] as Record<string, unknown>;
    expect(success["stdout"]).toContain("hi");
    expect(success["exit_code"]).toBe(0);
  }, 15000);

  test("shell nonzero exit returns failure", async () => {
    const result = await run("shell", { command: "exit 2", working_directory: "." });
    expect(result?.message["failure"]).toBeDefined();
  }, 15000);

  test("shell rejected when cwd escapes", async () => {
    const result = await run("shell", { command: "pwd", working_directory: "../escape" });
    expect(result?.message["rejected"]).toBeDefined();
  });

  test("ls returns a directory tree", async () => {
    const result = await run("ls", { path: "." });
    expect(result?.field).toBe("ls_result");
    const root = result?.message["success"] as Record<string, unknown>;
    expect(root["directory_tree_root"]).toBeDefined();
  });

  test("pi_edit replaces text", async () => {
    const result = await run("pi_edit", { path: "README.md", edits: [{ old_text: "Hello", new_text: "Hola" }] });
    expect(result?.field).toBe("pi_edit_result");
    expect(readFileSync(join(WORKSPACE, "README.md"), "utf8")).toContain("Hola");
  });

  test("pi_edit missing old_text returns error", async () => {
    const result = await run("pi_edit", { path: "README.md", edits: [{ old_text: "missing", new_text: "x" }] });
    expect(result?.message["error"]).toBeDefined();
  });

  test("delete removes the file", async () => {
    writeFileSync(join(WORKSPACE, "del.txt"), "x");
    const result = await run("delete", { path: "del.txt" });
    expect(result?.field).toBe("delete_result");
    expect(existsSync(join(WORKSPACE, "del.txt"))).toBe(false);
  });

  test("delete refuses the workspace root", async () => {
    const result = await run("delete", { path: "." });
    expect(result?.message["permission_denied"]).toBeDefined();
  });

  test("unknown tool names have no exec result field", () => {
    for (const name of ["fetch", "web_search", "subagent", "task", "switch_mode"]) {
      const variant = variantNamed(name);
      const result = variant ? isExecutableNativeTool(variant) : false;
      expect(result).toBe(false);
    }
  });
});
