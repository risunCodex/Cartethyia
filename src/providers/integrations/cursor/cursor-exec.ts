// Cursor-native tool executor — runs Cursor's host tools locally instead of
// relaying them to the client or refusing them.
//
// Cursor asks the local client to execute host tools through `ExecServerMessage`
// frames (read, shell, write, edit, grep, glob, ls, delete, and the modern
// `pi_*` family). Previously this gateway relayed those to the caller as tool
// calls or refused them; this module executes them in-process, inside one
// workspace root, and returns the protobuf result message the wire expects.
//
// Safety model:
//   - Every filesystem operation resolves inside `root` (the gateway's
//     workspace). A path that escapes is refused with the tool's `rejected`
//     or `permission_denied` case — never executed.
//   - Shell commands run through `spawn` with `shell: false` on POSIX and a
//     parsed argv on Windows (no `cmd /c` string interpolation); the working
//     directory is pinned to `root`.
//   - `delete` refuses to delete the workspace root itself, and `edit`/`write`
//     refuse to touch paths outside the root.
//
// The result shape is keyed by the origin exec frame (which variant asked),
// so a reply can only ever come back in the arm it arrived on.

import { spawn } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  lstatSync,
  readdirSync,
  unlinkSync,
  mkdirSync,
  realpathSync,
} from "node:fs";
import { resolve, join, relative, dirname, isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import type { CursorToolVariant } from "./protocol/tool-canonical";

/** Max output bytes a tool result carries before truncation is reported. */
export const CURSOR_TOOL_MAX_OUTPUT_BYTES = 64 * 1024;
/** Max lines a read result reports before truncation. */
export const CURSOR_TOOL_MAX_LINES = 2000;

/**
 * The decoded result of one executed tool, ready to be wrapped in the exec
 * frame's result oneof.
 */
export interface NativeToolResult {
  /** The ExecClientMessage result field name (e.g. `read_result`, `ct_read_result`). */
  readonly field: string;
  /** The protobuf result message object, keyed by its oneof arm. */
  readonly message: Record<string, unknown>;
}

/** One exec-frame → result-field mapping (wire arms, not tool names). */
const EXEC_RESULT_FIELD: Readonly<Record<string, string>> = {
  shell_args: "shell_result",
  write_args: "write_result",
  delete_args: "delete_result",
  grep_args: "grep_result",
  read_args: "read_result",
  ls_args: "ls_result",
  // Modern exec arms are namespaced `ct_` (cartethyia) on the wire — the
  // upstream calls them `pi_`, but the canonical tool surface is one name per
  // tool, so the wire suffix here is ours alone.
  ct_read_args: "pi_read_result",
  ct_bash_args: "pi_bash_result",
  ct_edit_args: "pi_edit_result",
  ct_write_args: "pi_write_result",
  ct_grep_args: "pi_grep_result",
  ct_find_args: "pi_find_result",
  ct_ls_args: "pi_ls_result",
};

/** Exec frame keys the executor runs, in canonical order. */
const EXEC_TOOL_NAMES: Readonly<Record<string, string>> = {
  shell_args: "shell",
  write_args: "write",
  delete_args: "delete",
  grep_args: "grep",
  read_args: "read",
  ls_args: "ls",
  ct_read_args: "read",
  ct_bash_args: "shell",
  ct_edit_args: "edit",
  ct_write_args: "write",
  ct_grep_args: "grep",
  ct_find_args: "find",
  ct_ls_args: "ls",
};

/** The exec frame key for a legacy variant (wire type in snake form). */
export function execFrameKeyForVariant(variant: CursorToolVariant): string {
  const wire = variant.wireType; // e.g. "ReadToolCall"
  const base = wire.replace(/ToolCall$/, "");
  const snake = base.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
  return `${snake}_args`;
}

/** True when this variant is one the executor can run locally. */
export function isExecutableNativeTool(variant: CursorToolVariant): boolean {
  return Object.hasOwn(EXEC_RESULT_FIELD, execFrameKeyForVariant(variant));
}

/** Resolves one exec frame to its canonical tool name, or undefined. */
export function execFrameToolName(frameKey: string): string | undefined {
  return EXEC_TOOL_NAMES[frameKey];
}

/**
 * Resolves an `ExecServerMessage` frame to `{ frameKey, args }` when the
 * frame carries an executable tool payload. `frameKey` is the wire key
 * (`read_args`, `pi_read_args`, …); `args` are canonicalised snake-case
 * arguments. Returns `undefined` for non-tool frames (id, exec_id,
 * request_context_args, …).
 */
export function resolveExecFrame(
  execServer: Record<string, unknown>,
): { readonly frameKey: string; readonly args: Record<string, unknown> } | undefined {
  for (const [key, value] of Object.entries(execServer)) {
    if (value === null || value === undefined || !key.endsWith("_args")) continue;
    if (!Object.hasOwn(EXEC_RESULT_FIELD, key)) continue;
    return { frameKey: key, args: canonicalToolArgumentsFrom(value) };
  }
  return undefined;
}

function canonicalToolArgumentsFrom(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, child]) => [
      key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[\s-]+/g, "_").toLowerCase(),
      child,
    ]),
  );
}

/** Resolves a tool path against the workspace root; null when it escapes. */
function resolveInside(root: string, input: string | undefined): string | null {
  if (input === undefined || input.trim().length === 0) return null;
  const raw = input.trim();
  const abs = isAbsolute(raw) ? raw : resolve(root, raw);
  const rel = relative(root, abs);
  if (rel.startsWith("..") || isAbsolute(rel)) return null;
  return abs;
}

/** Best-effort realpath for exists checks; falls back to the resolved path. */
function safeRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

function isFile(p: string): boolean {
  try {
    return lstatSync(p).isFile();
  } catch {
    return false;
  }
}

function isDir(p: string): boolean {
  try {
    return lstatSync(p).isDirectory();
  } catch {
    return false;
  }
}

function truncate(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= maxBytes) return { text, truncated: false };
  // Trim by characters so we never split a UTF-8 sequence.
  let out = text;
  while (Buffer.byteLength(out, "utf8") > maxBytes) {
    out = out.slice(0, -1);
  }
  return { text: out, truncated: true };
}

function shellSuccess(args: Record<string, unknown>, cwd: string, stdout: string, stderr: string, exitCode: number, startedMs: number): Record<string, unknown> {
  return {
    success: {
      command: String(args["command"] ?? ""),
      working_directory: String(args["working_directory"] ?? cwd),
      exit_code: exitCode,
      stdout,
      stderr,
      execution_time: Date.now() - startedMs,
    },
  };
}

function shellFailure(args: Record<string, unknown>, cwd: string, stdout: string, stderr: string, exitCode: number, startedMs: number): Record<string, unknown> {
  return {
    failure: {
      command: String(args["command"] ?? ""),
      working_directory: String(args["working_directory"] ?? cwd),
      exit_code: exitCode,
      stdout,
      stderr,
      execution_time: Date.now() - startedMs,
    },
  };
}

/** Parses a command string into an argv array (Windows-aware). */
function parseCommand(command: string): string[] {
  const argv: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote !== null) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === " " || ch === "\t") {
      if (current.length > 0) {
        argv.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (current.length > 0) argv.push(current);
  return argv;
}

async function runShell(
  args: Record<string, unknown>,
  root: string,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const command = String(args["command"] ?? "").trim();
  if (!command) return { rejected: { reason: "empty command" } };
  const cwd = String(args["working_directory"] ?? root).trim() || root;
  const cwdAbs = resolveInside(root, cwd);
  if (cwdAbs === null) return { rejected: { command, working_directory: cwd, reason: "working directory escapes the workspace root" } };

  const started = Date.now();
  const shellTimeout = timeoutMs > 0 ? timeoutMs : 30_000;
  const argv = parseCommand(command);
  if (argv.length === 0) return { rejected: { command, working_directory: cwd, reason: "empty command" } };

  return await new Promise<Record<string, unknown>>((resolvePromise) => {
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd: cwdAbs,
      shell: false,
      windowsHide: true,
      env: { ...process.env, CURSOR_WORKSPACE_ROOT: root },
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      resolvePromise({
        timeout: {
          command,
          working_directory: cwd,
          timeout_ms: shellTimeout,
        },
      });
    }, shellTimeout);
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString("utf8");
      if (Buffer.byteLength(stdout) > CURSOR_TOOL_MAX_OUTPUT_BYTES * 2) child.stdout.pause();
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString("utf8");
      if (Buffer.byteLength(stderr) > CURSOR_TOOL_MAX_OUTPUT_BYTES * 2) child.stderr.pause();
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({
        failure: {
          command,
          working_directory: cwd,
          exit_code: -1,
          stdout,
          stderr: `${stderr}\n${err.message}`.trim(),
          execution_time: Date.now() - started,
        },
      });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const out = truncate(stdout, CURSOR_TOOL_MAX_OUTPUT_BYTES);
      const err = truncate(stderr, CURSOR_TOOL_MAX_OUTPUT_BYTES);
      if (code === 0) {
        resolvePromise(shellSuccess(args, cwd, out.text, err.text, 0, started));
      } else {
        resolvePromise(shellFailure(args, cwd, out.text, err.text, code ?? -1, started));
      }
    });
  });
}

async function readFile(
  args: Record<string, unknown>,
  root: string,
  pi: boolean,
): Promise<Record<string, unknown>> {
  const path = resolveInside(root, String(args["path"] ?? ""));
  if (path === null) {
    return pi
      ? { error: { error: "path escapes the workspace root" } }
      : { rejected: { path: String(args["path"] ?? ""), reason: "path escapes the workspace root" } };
  }
  if (!existsSync(path)) {
    return pi
      ? { error: { error: `file not found: ${path}` } }
      : { file_not_found: { path } };
  }
  if (!isFile(path)) {
    return pi
      ? { error: { error: `not a regular file: ${path}` } }
      : { invalid_file: { path, reason: "not a regular file" } };
  }
  try {
    const size = lstatSync(path).size;
    const offset = typeof args["offset"] === "number" ? Math.max(0, args["offset"]) : 0;
    const raw = readFileSync(path, "utf8");
    const lines = raw.split("\n");
    let content: string;
    let truncation: Record<string, unknown> | undefined;
    if (offset > 0 || lines.length > CURSOR_TOOL_MAX_LINES) {
      const slice = lines.slice(offset, offset + CURSOR_TOOL_MAX_LINES).join("\n");
      const out = truncate(slice, CURSOR_TOOL_MAX_OUTPUT_BYTES);
      content = out.text;
      if (out.truncated || lines.length > CURSOR_TOOL_MAX_LINES) {
        truncation = {
          truncated: true,
          truncated_by: "line_limit",
          total_lines: lines.length,
          output_lines: Math.min(lines.length - offset, CURSOR_TOOL_MAX_LINES),
          output_bytes: Buffer.byteLength(content),
          max_lines: CURSOR_TOOL_MAX_LINES,
        };
      }
    } else {
      const out = truncate(raw, CURSOR_TOOL_MAX_OUTPUT_BYTES);
      content = out.text;
      if (out.truncated) {
        truncation = {
          truncated: true,
          truncated_by: "byte_limit",
          total_lines: lines.length,
          output_lines: lines.length,
          output_bytes: Buffer.byteLength(content),
          max_bytes: CURSOR_TOOL_MAX_OUTPUT_BYTES,
        };
      }
    }
    if (pi) {
      return truncation
        ? { success: { output: content, truncation } }
        : { success: { output: content } };
    }
    return {
      success: {
        path,
        content,
        total_lines: lines.length,
        file_size: size,
        truncated: truncation !== undefined,
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return pi ? { error: { error: msg } } : { error: { path, error: msg } };
  }
}

function globFiles(args: Record<string, unknown>, root: string): Record<string, unknown> {
  const target = resolveInside(root, String(args["target_directory"] ?? "."));
  if (target === null) return { error: "target directory escapes the workspace root" };
  if (!isDir(target)) return { error: `not a directory: ${target}` };
  const pattern = String(args["glob_pattern"] ?? "**/*");
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 12) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      const rel = relative(target, full);
      let isDirEntry = false;
      try {
        isDirEntry = lstatSync(full).isDirectory();
      } catch {
        continue;
      }
      if (isDirEntry) {
        const match = simpleGlobMatch(pattern, rel);
        if (match) out.push(rel);
        walk(full, depth + 1);
      } else {
        const match = simpleGlobMatch(pattern, rel);
        if (match) out.push(rel);
      }
    }
  };
  walk(target, 0);
  out.sort();
  return { files: out };
}

/** Minimal glob matcher: `*` (within a segment), `**` (any depth), `?`. */
function simpleGlobMatch(pattern: string, value: string): boolean {
  const re = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "__GLOBSTAR__")
    .replace(/\*/g, "[^/]*")
    .replace(/__GLOBSTAR__/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${re}$`).test(value);
}

function grepFiles(args: Record<string, unknown>, root: string, pi: boolean): Record<string, unknown> {
  const pattern = String(args["pattern"] ?? "");
  if (!pattern) return pi ? { error: { error: "empty pattern" } } : { error: { error: "empty pattern" } };
  const path = String(args["path"] ?? "");
  const searchRoot = path ? resolveInside(root, path) : root;
  if (searchRoot === null) {
    return pi ? { error: { error: "path escapes the workspace root" } } : { error: { error: "path escapes the workspace root" } };
  }
  const glob = String(args["glob"] ?? "");
  const ignoreCase = args["ignore_case"] === true || args["case_insensitive"] === true;
  const literal = args["literal"] === true;
  const limit = typeof args["limit"] === "number" ? args["limit"] : 200;
  const flags = ignoreCase ? "gi" : "g";
  const re = literal ? new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags) : new RegExp(pattern, flags);
  const matches: Array<{ file: string; matches: Array<{ lineNumber: number; content: string }> }> = [];
  let totalMatched = 0;

  const walk = (dir: string, depth: number) => {
    if (depth > 12 || totalMatched >= limit) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (totalMatched >= limit) return;
      if (entry.startsWith(".")) continue;
      const full = join(dir, entry);
      const rel = relative(searchRoot, full);
      let isDirEntry = false;
      try {
        isDirEntry = lstatSync(full).isDirectory();
      } catch {
        continue;
      }
      if (isDirEntry) {
        walk(full, depth + 1);
        continue;
      }
      if (glob && !simpleGlobMatch(glob, rel)) continue;
      try {
        const content = readFileSync(full, "utf8");
        const lines = content.split("\n");
        const fileMatches: Array<{ lineNumber: number; content: string }> = [];
        for (let i = 0; i < lines.length && fileMatches.length < 20; i++) {
          re.lastIndex = 0;
          if (re.test(lines[i]!)) {
            fileMatches.push({ lineNumber: i + 1, content: lines[i]!.slice(0, 500) });
          }
        }
        if (fileMatches.length > 0) {
          matches.push({ file: rel, matches: fileMatches });
          totalMatched += fileMatches.length;
        }
      } catch {
        // unreadable file — skip
      }
    }
  };
  walk(searchRoot, 0);

  if (pi) {
    const lines = matches.flatMap((m) => m.matches.map((mm) => `${m.file}:${mm.lineNumber}:${mm.content}`));
    const out = truncate(lines.join("\n"), CURSOR_TOOL_MAX_OUTPUT_BYTES);
    return { success: { output: out.text, truncation: out.truncated ? { truncated: true, truncated_by: "byte_limit" } : undefined } };
  }
  return {
    success: {
      pattern,
      path: path || root,
      output_mode: "content",
      workspace_results: {
        "": {
          content: {
            matches,
            total_lines: totalMatched,
            total_matched_lines: totalMatched,
            client_truncated: totalMatched >= limit,
            ripgrep_truncated: false,
          },
        },
      },
    },
  };
}

function lsTree(args: Record<string, unknown>, root: string, pi: boolean): Record<string, unknown> {
  const path = resolveInside(root, String(args["path"] ?? "."));
  if (path === null) {
    return pi ? { error: { error: "path escapes the workspace root" } } : { rejected: { path: String(args["path"] ?? ""), reason: "path escapes the workspace root" } };
  }
  if (!isDir(path)) {
    return pi ? { error: { error: `not a directory: ${path}` } } : { error: { path, error: "not a directory" } };
  }
  const buildNode = (dir: string): Record<string, unknown> => {
    const childrenDirs: Record<string, unknown>[] = [];
    const childrenFiles: Array<{ name: string }> = [];
    let entries: string[];
    try {
      entries = readdirSync(dir).sort();
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      try {
        if (lstatSync(full).isDirectory()) childrenDirs.push(buildNode(full));
        else childrenFiles.push({ name: entry });
      } catch {
        // skip
      }
    }
    return {
      abs_path: dir,
      children_dirs: childrenDirs,
      children_files: childrenFiles,
      num_files: childrenFiles.length,
    };
  };
  const tree = buildNode(path);
  if (pi) {
    const lines: string[] = [];
    const flatten = (node: Record<string, unknown>, prefix: string) => {
      for (const d of (node["children_dirs"] ?? []) as Record<string, unknown>[]) {
        lines.push(`${prefix}${d["abs_path"]}/`);
        flatten(d, `${prefix}  `);
      }
      for (const f of (node["children_files"] ?? []) as Array<{ name: string }>) {
        lines.push(`${prefix}${f.name}`);
      }
    };
    flatten(tree, "");
    const out = truncate(lines.join("\n"), CURSOR_TOOL_MAX_OUTPUT_BYTES);
    return { success: { output: out.text, truncation: out.truncated ? { truncated: true, truncated_by: "byte_limit" } : undefined } };
  }
  return { success: { directory_tree_root: tree } };
}

function editFile(args: Record<string, unknown>, root: string, pi: boolean): Record<string, unknown> {
  const path = resolveInside(root, String(args["path"] ?? ""));
  if (path === null) {
    return pi ? { rejected: { reason: "path escapes the workspace root" } } : { rejected: { path: String(args["path"] ?? ""), reason: "path escapes the workspace root" } };
  }
  if (!existsSync(path)) {
    return pi ? { error: { error: `file not found: ${path}` } } : { file_not_found: { path } };
  }
  if (!isFile(path)) {
    return pi ? { error: { error: `not a regular file: ${path}` } } : { invalid_file: { path, reason: "not a regular file" } };
  }
  try {
    const original = readFileSync(path, "utf8");
    let content = original;
    // Legacy edit: stream_content is the *new full content* (old EditToolArgs
    // semantics — the IDE sends the entire replacement file).
    if (typeof args["stream_content"] === "string" && !pi) {
      content = args["stream_content"];
    } else {
      const edits = (args["edits"] ?? []) as Array<{ old_text?: string; new_text?: string }>;
      for (const edit of edits) {
        const oldText = edit.old_text ?? "";
        const newText = edit.new_text ?? "";
        if (!oldText) continue;
        if (!content.includes(oldText)) {
          return pi
            ? { error: { error: `old_text not found in ${path}` } }
            : { error: { path, error: `old_text not found in ${path}` } };
        }
        content = content.replace(oldText, newText);
      }
    }
    writeFileSync(path, content, "utf8");
    const lines = content.split("\n");
    const out = truncate(content, CURSOR_TOOL_MAX_OUTPUT_BYTES);
    if (pi) {
      return {
        success: {
          output: out.text,
          truncation: out.truncated ? { truncated: true, truncated_by: "byte_limit" } : undefined,
        },
      };
    }
    return {
      success: {
        path,
        content: out.text,
        total_lines: lines.length,
        file_size: Buffer.byteLength(content),
        truncated: out.truncated,
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return pi ? { error: { error: msg } } : { error: { path, error: msg } };
  }
}

function writeFileTool(args: Record<string, unknown>, root: string, pi: boolean): Record<string, unknown> {
  const path = resolveInside(root, String(args["path"] ?? ""));
  if (path === null) {
    return pi ? { rejected: { reason: "path escapes the workspace root" } } : { rejected: { path: String(args["path"] ?? ""), reason: "path escapes the workspace root" } };
  }
  let content = "";
  if (typeof args["content"] === "string") content = args["content"];
  else if (typeof args["file_text"] === "string") content = args["file_text"];
  else if (args["file_bytes"] instanceof Uint8Array) content = new TextDecoder().decode(args["file_bytes"] as Uint8Array);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, "utf8");
    const lines = content.split("\n");
    if (pi) {
      const out = truncate(content, CURSOR_TOOL_MAX_OUTPUT_BYTES);
      return {
        success: {
          output: out.text,
          truncation: out.truncated ? { truncated: true, truncated_by: "byte_limit" } : undefined,
        },
      };
    }
    return {
      success: {
        path,
        lines_created: lines.length,
        file_size: Buffer.byteLength(content),
        file_content_after_write: truncate(content, CURSOR_TOOL_MAX_OUTPUT_BYTES).text,
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return pi ? { error: { error: msg } } : { error: { path, error: msg } };
  }
}

function deleteFileTool(args: Record<string, unknown>, root: string): Record<string, unknown> {
  const path = resolveInside(root, String(args["path"] ?? ""));
  if (path === null) {
    return { rejected: { path: String(args["path"] ?? ""), reason: "path escapes the workspace root" } };
  }
  if (path === safeRealpath(root)) {
    return { permission_denied: { path, client_visible_error: "refusing to delete the workspace root", is_readonly: true } };
  }
  if (!existsSync(path)) {
    return { error: { path, error: "file not found" } };
  }
  try {
    unlinkSync(path);
    return { success: { path, deleted_file: path } };
  } catch (err) {
    return { error: { path, error: err instanceof Error ? err.message : String(err) } };
  }
}

/**
 * Executes one Cursor-native exec frame. `frameKey` is the exec-frame key
 * (`read_args`, `pi_read_args`, …); `args` are the decoded canonical (snake)
 * arguments. Returns the result message for the frame's result oneof, or
 * `undefined` when the frame is not executable (the caller refuses it).
 */
export async function executeNativeTool(
  frameKey: string,
  args: Record<string, unknown>,
  root: string,
  timeoutMs = 30_000,
): Promise<NativeToolResult | undefined> {
  const field = EXEC_RESULT_FIELD[frameKey];
  if (field === undefined) return undefined;

  let message: Record<string, unknown>;
  switch (frameKey) {
    case "read_args":
      message = await readFile(args, root, false);
      break;
    case "ct_read_args":
      message = await readFile(args, root, true);
      break;
    case "shell_args":
      message = await runShell(args, root, timeoutMs);
      break;
    case "ct_bash_args":
      message = await runShell(args, root, timeoutMs);
      break;
    case "glob_args":
      message = globFiles(args, root);
      break;
    case "grep_args":
      message = grepFiles(args, root, false);
      break;
    case "ct_grep_args":
      message = grepFiles(args, root, true);
      break;
    case "ls_args":
      message = lsTree(args, root, false);
      break;
    case "ct_ls_args":
      message = lsTree(args, root, true);
      break;
    case "edit_args":
      message = editFile(args, root, false);
      break;
    case "ct_edit_args":
      message = editFile(args, root, true);
      break;
    case "write_args":
      message = writeFileTool(args, root, false);
      break;
    case "ct_write_args":
      message = writeFileTool(args, root, true);
      break;
    case "delete_args":
      message = deleteFileTool(args, root);
      break;
    case "ct_find_args": {
      const path = resolveInside(root, String(args["path"] ?? "."));
      if (path === null) message = { error: { error: "path escapes the workspace root" } };
      else {
        const pattern = String(args["pattern"] ?? "*");
        const files = globFiles({ target_directory: path, glob_pattern: pattern }, root);
        message = { success: { output: (files["files"] as string[] ?? []).join("\n") } };
      }
      break;
    }
    default:
      return undefined;
  }

  return { field, message };
}

/** Blobs a file for output-blob results (unused here; kept for symmetry). */
export function fileDigest(path: string): string {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return "";
  }
}
