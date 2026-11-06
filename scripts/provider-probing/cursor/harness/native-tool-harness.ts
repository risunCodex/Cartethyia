/**
 * Cursor native-tool harness — drives `executeNativeTool` against a scratch
 * workspace and reports pass/fail per tool, including parallel execution.
 *
 * This is the tool-loop oracle for the adapter's "native, no MCP fallback"
 * path: it simulates exactly what a Cursor `ExecServerMessage` frame asks for
 * and verifies the executor answers with the right result shape.
 *
 * Usage:
 *   bun run scripts/provider-probing/cursor/harness/native-tool-harness.ts
 *   bun run ... --workspace D:\tmp\cursor-harness (default)
 *   bun run ... --only read,glob,shell   (subset)
 *
 * Tokens are never involved — this harness is purely local.
 */
import { parseArgs } from "node:util";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  executeNativeTool,
} from "../../../../src/providers/integrations/cursor/cursor-exec";
import { CURSOR_TOOL_VARIANTS } from "../../../../src/providers/integrations/cursor/protocol/tool-canonical";

const args = parseArgs({
  options: {
    workspace: { type: "string" },
    only: { type: "string" },
    timeout: { type: "string", default: "15000" },
  },
});

const WORKSPACE = args.values.workspace ?? join(tmpdir(), "cursor-harness");
const TIMEOUT = Number(args.values.timeout);
const ONLY = args.values.only?.split(",").map((s) => s.trim()).filter(Boolean) ?? [];

/** Ensure the scratch workspace exists with a few sample files. */
function setupWorkspace(): void {
  rmSync(WORKSPACE, { recursive: true, force: true });
  mkdirSync(WORKSPACE, { recursive: true });
  mkdirSync(join(WORKSPACE, "src"), { recursive: true });
  mkdirSync(join(WORKSPACE, "docs"), { recursive: true });
  writeFileSync(join(WORKSPACE, "README.md"), "# Harness\n\nSample file for native tool tests.\n");
  writeFileSync(join(WORKSPACE, "src", "index.ts"), "export const answer = 42;\n");
  writeFileSync(join(WORKSPACE, "src", "util.ts"), "export function ok(): boolean {\n  return true;\n}\n");
  writeFileSync(join(WORKSPACE, "docs", "guide.md"), "# Guide\n\nRead me.\n");
}

/** Looks up a variant by its canonical tool name. */
function variantNamed(name: string) {
  for (const variant of CURSOR_TOOL_VARIANTS.values()) {
    if (variant.name === name) return variant;
  }
  return undefined;
}

/** The exec frame key for a canonical tool name (legacy surface). */
function frameKeyForName(name: string): string {
  const variant = variantNamed(name);
  if (variant === undefined) return "";
  const wire = variant.wireType.replace(/ToolCall$/, "");
  return `${wire.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase()}_args`;
}

let passed = 0;
let failed = 0;
const failures: string[] = [];

function report(name: string, ok: boolean, detail: string): void {
  if (ok) {
    passed++;
    console.log(`PASS ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function runTool(name: string, args_: Record<string, unknown>): Promise<Record<string, unknown> | undefined> {
  const frameKey = frameKeyForName(name);
  if (!frameKey) return undefined;
  const result = await executeNativeTool(frameKey, args_, WORKSPACE, TIMEOUT);
  return result?.message;
}

/** Runs a modern (ct_*) wire arm directly. */
async function runToolCc(frameKey: string, args_: Record<string, unknown>): Promise<Record<string, unknown> | undefined> {
  const result = await executeNativeTool(frameKey, args_, WORKSPACE, TIMEOUT);
  return result?.message;
}

async function main(): Promise<void> {
  console.log(`workspace: ${WORKSPACE}`);
  setupWorkspace();

  const want = (name: string): boolean => ONLY.length === 0 || ONLY.includes(name);

  // ── read ──
  if (want("read")) {
    const r = await runTool("read", { path: "src/index.ts" });
    const content = (r as { success?: { content?: string } })?.success?.content ?? "";
    report("read", typeof content === "string" && content.includes("answer = 42"), `content=${JSON.stringify(content.slice(0, 40))}`);

    const missing = await runTool("read", { path: "nope.ts" });
    report("read.missing", Boolean((missing as { file_not_found?: unknown })?.file_not_found), "file_not_found");

    const escape = await runTool("read", { path: "../outside.ts" });
    report("read.escape", Boolean((escape as { rejected?: unknown })?.rejected), "rejected on escape");
  }

  // ── ct_read ── (modern wire arm)
  if (want("ct_read")) {
    const r = await runToolCc("ct_read_args", { path: "src/util.ts" });
    const output = (r as { success?: { output?: string } })?.success?.output ?? "";
    report("ct_read", output.includes("function ok"), `output=${JSON.stringify(output.slice(0, 40))}`);
  }

  // ── write / ct_write ──
  if (want("write")) {
    await runTool("write", { path: "new-file.txt", content: "hello\n" });
    report("write", existsSync(join(WORKSPACE, "new-file.txt")), "file created");
    await runToolCc("ct_write_args", { path: "sub/ct.txt", content: "ct content\n" });
    report("ct_write", existsSync(join(WORKSPACE, "sub", "ct.txt")), "exists=true");
  }
  if (want("grep")) {
    const r = await runTool("grep", { pattern: "answer", path: "." });
    const matches = ((r as { success?: { workspace_results?: Record<string, { content?: { matches?: unknown[] } }> } })?.success?.workspace_results?.[""]?.content?.matches) ?? [];
    report("grep", matches.length > 0, `matches=${matches.length}`);

    const pi = await runToolCc("ct_grep_args", { pattern: "function", path: "." });
    const piOut = (pi as { success?: { output?: string } })?.success?.output ?? "";
    report("ct_grep", piOut.includes("function"), `output=${JSON.stringify(piOut.slice(0, 40))}`);
  }

  // ── ls / ct_ls ──
  if (want("ls")) {
    const r = await runTool("ls", { path: "." });
    const root = (r as { success?: { directory_tree_root?: Record<string, unknown> } })?.success?.directory_tree_root;
    report("ls", Boolean(root && (root["children_dirs"] as unknown[]).length > 0), `root=${JSON.stringify(root).slice(0, 80)}`);

    const pi = await runToolCc("ct_ls_args", { path: "." });
    const piOut = (pi as { success?: { output?: string } })?.success?.output ?? "";
    report("ct_ls", piOut.includes("src"), `output=${JSON.stringify(piOut.slice(0, 60))}`);
  }

  // ── ct_edit ── (modern wire arm; legacy edit has no exec-frame slot)
  if (want("ct_edit")) {
    await runToolCc("ct_edit_args", { path: "README.md", edits: [{ old_text: "Harness", new_text: "Cursor Harness" }] });
    const edited = readFileSync(join(WORKSPACE, "README.md"), "utf8");
    report("ct_edit", edited.includes("Cursor Harness"), `file=${JSON.stringify(edited.slice(0, 40))}`);
    const err = await runToolCc("ct_edit_args", { path: "README.md", edits: [{ old_text: "nonexistent", new_text: "x" }] });
    report("ct_edit.missing-old", Boolean((err as { error?: unknown })?.error), "error when old_text missing");
  }

  // ── shell / pi_bash ──
  if (want("shell")) {
    const r = await runTool("shell", { command: "echo harness-ok", working_directory: "." });
    const success = (r as { success?: { stdout?: string; exit_code?: number } })?.success;
    report("shell", success?.stdout?.includes("harness-ok") === true, `stdout=${JSON.stringify(success?.stdout)}`);

    const fail = await runTool("shell", { command: "exit 3", working_directory: "." });
    report("shell.exit", Boolean((fail as { failure?: unknown })?.failure), "failure on nonzero exit");

    const escape = await runTool("shell", { command: "pwd", working_directory: "../escape" });
    report("shell.escape", Boolean((escape as { rejected?: unknown })?.rejected), "rejected on escaped cwd");
  }

  // ── delete ──
  if (want("delete")) {
    writeFileSync(join(WORKSPACE, "temp-delete.txt"), "x");
    const r = await runTool("delete", { path: "temp-delete.txt" });
    report("delete", !existsSync(join(WORKSPACE, "temp-delete.txt")), `message=${JSON.stringify(r).slice(0, 60)}`);

    const rootDel = await runTool("delete", { path: "." });
    report("delete.root", Boolean((rootDel as { permission_denied?: unknown })?.permission_denied), "permission_denied on root");
  }

  // ── parallel ──
  if (want("parallel")) {
    const t0 = Date.now();
    const results = await Promise.all([
      runTool("read", { path: "src/index.ts" }),
      runTool("read", { path: "src/util.ts" }),
      runTool("read", { path: "docs/guide.md" }),
      runTool("ls", { path: "." }),
      runTool("shell", { command: "echo p1", working_directory: "." }),
    ]);
    const elapsed = Date.now() - t0;
    const allOk = results.every((r) => r !== undefined);
    const hasText = results.slice(0, 3).every((r) => {
      const content = ((r as { success?: { content?: string } })?.success?.content ?? "");
      return content.length > 0;
    });
    report("parallel", allOk && hasText, `5 tools in ${elapsed}ms`);
  }

  // ── every executable exec frame is covered ──
  if (want("coverage")) {
    const frames = [
      "read_args", "shell_args", "write_args", "delete_args", "grep_args", "ls_args",
      "ct_read_args", "ct_bash_args", "ct_edit_args", "ct_write_args", "ct_grep_args", "ct_find_args", "ct_ls_args",
    ];
    let covered = 0;
    for (const frame of frames) {
      const result = await executeNativeTool(frame, {}, WORKSPACE, 1000);
      if (result !== undefined) covered++;
    }
    report("coverage", covered === frames.length, `${covered}/${frames.length} exec frames executable`);
  }

  console.log(`\n${passed} pass, ${failed} fail`);
  if (failures.length > 0) console.log(`failures: ${failures.join(", ")}`);
  process.exit(failed > 0 ? 1 : 0);
}

await main();
