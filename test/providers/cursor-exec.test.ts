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
import { executeNativeTool } from "../../src/providers/integrations/cursor/cursor-exec";
import { CURSOR_TOOL_VARIANTS } from "../../src/providers/integrations/cursor/protocol/tool-canonical";

const WORKSPACE = mkdtempSync(join(tmpdir(), "cursor-exec-test-"));

function setup(): void {
  rmSync(WORKSPACE, { recursive: true, force: true });
  mkdirSync(WORKSPACE, { recursive: true });
  mkdirSync(join(WORKSPACE, "src"), { recursive: true });
  writeFileSync(join(WORKSPACE, "src", "a.ts"), "export const x = 1;\n");
  writeFileSync(join(WORKSPACE, "README.md"), "# Test\n\nHello world.\n");
}

/** Returns the exec frame key for a canonical tool name (legacy surface). */
function frameKeyForName(name: string): string {
  for (const v of CURSOR_TOOL_VARIANTS.values()) {
    if (v.name === name) {
      const wire = v.wireType.replace(/ToolCall$/, "");
      return `${wire.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase()}_args`;
    }
  }
  return "";
}

async function run(name: string, args: Record<string, unknown>) {
  const frameKey = frameKeyForName(name);
  if (!frameKey) throw new Error(`no frame for ${name}`);
  return await executeNativeTool(frameKey, args, WORKSPACE);
}

beforeEach(setup);

describe("Cursor native tool executor", () => {
  test("covers the native exec surface", () => {
    for (const name of ["read", "write", "grep", "shell", "ls", "edit", "delete"]) {
      expect(frameKeyForName(name)).not.toBe("");
    }
    // `find` exists only on the modern wire arm — no legacy FindToolCall.
    expect(frameKeyForName("find")).toBe("");
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

  test("ct_read returns pi_read_result with output (modern wire arm)", async () => {
    const result = await executeNativeTool("ct_read_args", { path: "src/a.ts" }, WORKSPACE);
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

  test("ct_write creates nested paths (modern wire arm)", async () => {
    const result = await executeNativeTool("ct_write_args", { path: "nested/deep.txt", content: "x" }, WORKSPACE);
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

  test("ct_grep finds matches (modern wire arm)", async () => {
    const result = await executeNativeTool("ct_grep_args", { pattern: "export const", path: "." }, WORKSPACE);
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

  test("ct_edit replaces text (modern wire arm)", async () => {
    const result = await executeNativeTool("ct_edit_args", { path: "README.md", edits: [{ old_text: "Hello", new_text: "Hola" }] }, WORKSPACE);
    expect(result?.field).toBe("pi_edit_result");
    expect(readFileSync(join(WORKSPACE, "README.md"), "utf8")).toContain("Hola");
  });

  test("ct_edit missing old_text returns error", async () => {
    const result = await executeNativeTool("ct_edit_args", { path: "README.md", edits: [{ old_text: "missing", new_text: "x" }] }, WORKSPACE);
    expect(result?.message["error"]).toBeDefined();
  });

  test("ct_find lists matching files (modern find arm)", async () => {
    const result = await executeNativeTool("ct_find_args", { path: ".", pattern: "**/*.ts" }, WORKSPACE);
    expect(result?.field).toBe("pi_find_result");
    const success = result?.message["success"] as Record<string, unknown>;
    expect(success["output"]).toContain("a.ts");
  });

  test("ct_find glob matching is separator-independent", async () => {
    // `*.ts` must not match a nested path on either separator: the matcher
    // normalizes to forward slashes, so `src\a.ts` (Windows) behaves exactly
    // like `src/a.ts` (POSIX) — `*.ts` misses both and `**/*.ts` hits both.
    const shallow = await executeNativeTool("ct_find_args", { path: ".", pattern: "*.ts" }, WORKSPACE);
    const shallowSuccess = shallow?.message["success"] as Record<string, unknown>;
    expect(String(shallowSuccess["output"])).not.toContain("a.ts");
    const deep = await executeNativeTool("ct_find_args", { path: ".", pattern: "**/*.ts" }, WORKSPACE);
    const deepSuccess = deep?.message["success"] as Record<string, unknown>;
    expect(String(deepSuccess["output"])).toContain("a.ts");
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

  test("unknown tool names have no exec frame", async () => {
    // `subagent` has no variant at all.
    expect(frameKeyForName("subagent")).toBe("");
    // Known-but-unexecutable names resolve to a frame key, but execution
    // returns undefined (the executor does not implement them).
    expect(await executeNativeTool("task_args", {}, WORKSPACE)).toBeUndefined();
    expect(await executeNativeTool("fetch_args", {}, WORKSPACE)).toBeUndefined();
    expect(await executeNativeTool("web_search_args", {}, WORKSPACE)).toBeUndefined();
  });
});
