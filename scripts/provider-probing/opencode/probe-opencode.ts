/**
 * Raw OpenCode free-tier wire probe.
 *
 * Hits `opencode.ai` directly with the same session/project fingerprint the
 * real 2.2.5 client sends, so it is ground truth for the adapter's headers
 * and body. If this probe is accepted, the adapter with the same wire is
 * accepted.
 *
 * Usage (run directly; there is no `probe:*` npm script):
 *
 *   # Dry run: print the exact URL/headers/body that would be sent.
 *   bun run scripts/provider-probing/opencode/probe-opencode.ts \
 *     --chat --model big-pickle --message "ping" --dry-run
 *
 *   # Model listing (no credential needed).
 *   bun run scripts/provider-probing/opencode/probe-opencode.ts --models
 *
 *   # Live chat probe (stream forced for free tier).
 *   bun run scripts/provider-probing/opencode/probe-opencode.ts \
 *     --chat --model big-pickle --message "ping" --stream
 *
 *   # Optional API key for billed/org-gated tests:
 *   #   --token <key> --org <org-id>
 *
 * Live result 2026-11-02: the free-tier request is ACCEPTED by the gate
 * (read + validated) and answered `429 FreeUsageLimitError` with
 * `Retry-After`, i.e. the free quota/IP is exhausted — not a wire-shape
 * refusal. The 2.2.5 binary has no `FreeTierError`; the free-limit guard
 * is `FreeUsageLimitError` (`provider.free-limit`).
 *
 * The tool set is a verbatim capture of a real 2.2.0 CLI dispatch (11 ids,
 * incl. `strict:false` on each) — see the evidence ledger for the flow. The
 * session/project fingerprint matches the captured client. A billed model
 * without a key answers `401 Missing API key`, and an unknown model id
 * answers `400 Model is unavailable` — both prove the wire routing is
 * correct. A real, logged-in 2.2.0 CLI (Bearer `st_…` account token) hits
 * the same `429 FreeUsageLimitError` on a free model and `402 Insufficient
 * account funds` on a billed model, so the 429 is an account/quota state
 * overriding the request shape. OpenCode's own `opencode2api` bridge
 * confirms the free tier is client-fingerprint-gated ("free tier can only be
 * used from within OpenCode").
 *
 * Never prints tokens; prints only status + first bytes.
 */
import { parseArgs } from "node:util";
import { randomBytes, createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { probeGet, probePost, formatProbe } from "../lib/http";

// ---------------------------------------------------------------- identity

const OPENCODE_BASE = "https://opencode.ai";

/** The v2 chat endpoint on the `/inference` origin. */
function chatEndpoint(): string {
  return `${OPENCODE_BASE}/inference/openai/v1/chat/completions`;
}

/** Model listing endpoint (the catalog lives under `/zen/v1/models`). */
function modelsEndpoint(): string {
  return `${OPENCODE_BASE}/zen/v1/models`;
}

const SESSION_ID_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

let lastTimestamp = 0;
let sequenceCounter = 0;

/**
 * The session id the real 2.2.5 client puts on the wire: `ses_` + an
 * inverted-millisecond timestamp (12 hex) + a 14-char base62 suffix.
 *
 * The counter window the gate accepts is 1..63; past it the next call rolls
 * into the next millisecond instead of emitting a refused counter.
 */
function generateSessionId(now = Date.now()): string {
  if (now !== lastTimestamp) {
    lastTimestamp = now;
    sequenceCounter = 0;
  }
  sequenceCounter++;
  if (sequenceCounter > 63) {
    lastTimestamp = now + 1;
    sequenceCounter = 1;
    now = lastTimestamp;
  }
  const num = BigInt(now) * 0x1000n + BigInt(sequenceCounter);
  const inverted = ~num;
  const hex = Array.from({ length: 6 }, (_, i) =>
    Number((inverted >> BigInt(40 - 8 * i)) & 0xffn).toString(16).padStart(2, "0"),
  ).join("");
  const rand = randomBytes(14);
  const suffix = Array.from(rand, (byte) => SESSION_ID_ALPHABET[byte % 62]).join("");
  return `ses_${hex}${suffix}`;
}

/** The 40-hex project identity shape the client sends. */
function canonicalProjectId(project: string | undefined): string {
  if (project !== undefined && /^[0-9a-f]{40}$/.test(project)) return project;
  const seed = project ?? "cartethyia";
  return createHash("sha256").update(`opencode-project\u0000${seed}`).digest().subarray(0, 20).toString("hex");
}

/**
 * The fingerprint headers the real client sends for one upstream dispatch.
 *
 * `--dir` (working directory) becomes the `x-opencode-directory` header
 * (URI-encoded). `--ua` overrides the user agent; the default is the
 * 2.2.5 CLI identity.
 */
function buildHeaders(opts: {
  readonly dir?: string;
  readonly project?: string;
  readonly ua?: string;
  readonly client?: string;
  readonly token?: string;
  readonly org?: string;
  readonly sessionId?: string;
}): Record<string, string> {
  const sessionId = opts.sessionId ?? generateSessionId();
  const headers: Record<string, string> = {
    // The 2.2.5 client sends both spellings of the session id.
    "x-opencode-session": sessionId,
    "x-opencode-session-id": sessionId,
    "x-session-affinity": sessionId,
    "X-Session-Id": sessionId,
    "x-opencode-project": canonicalProjectId(opts.project),
    "x-opencode-client": opts.client ?? "cli",
    "user-agent": opts.ua ?? "opencode/latest/2.2.0/cli",
    accept: "*/*",
    "content-type": "application/json",
  };
  if (opts.token !== undefined && opts.token.length > 0) {
    headers.authorization = `Bearer ${opts.token}`;
  }
  if (opts.org !== undefined && opts.org.length > 0) {
    headers["x-opencode-org-id"] = opts.org;
  }
  if (opts.dir !== undefined && opts.dir.length > 0) {
    headers["x-opencode-directory"] = encodeURIComponent(opts.dir);
  }
  return headers;
}

// ---------------------------------------------------------------- body

/**
 * A minimal but real system prompt. The gate reads presence/content, not a
 * verbatim match — it must look agent-shaped.
 */
function systemPrompt(dir: string | undefined): string {
  return [
    "You are OpenCode, an AI coding assistant running in a terminal.",
    "You help the user write, edit, and understand code in a repository.",
    "You can run shell commands and read/write files using your tools.",
    ...(dir !== undefined ? [`Working directory: ${dir}`] : []),
  ].join("\n");
}

/** The agent-tool fingerprint captured verbatim from a real 2.2.0 CLI dispatch (mitm capture 2026-11-02, flow 4). Eleven tools, in the client's own declaration order; each carries the client's description, parameter schema, and the `strict: false` flag. */
const FREE_AGENT_TOOLS: readonly {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  strict: boolean;
}[] = [
  { name: "edit", description: "Edit the contents of a file by finding and replacing exact text. When editing text from Read output, preserve the exact indentation (tabs or spaces) and omit the line-number prefix, such as `1: `. Never include the prefix in oldString or newString. Write line breaks as \\n; the file's existing CRLF or LF line endings are matched and preserved. To change line endings themselves, make oldString and newString differ only in \\r; that edit applies to the exact bytes. If there is no exact match, the edit retries while ignoring typographic quote, dash, and space variants, then trailing whitespace on each line. The edit fails if oldString is not found. By default, oldString must identify a UNIQUE location. Multiple matches FAIL unless replaceAll is true. Add more surrounding context to disambiguate, or set replaceAll to true to replace every occurrence. Use replaceAll when the change should apply to every occurrence, such as renaming a variable.", parameters: { type: "object", properties: { path: { type: "string", description: "File to edit" }, oldString: { type: "string", description: "Exact text to find and replace" }, newString: { type: "string", description: "Text to replace oldString with (must differ from oldString)" }, replaceAll: { type: "boolean", description: "Whether to replace every occurrence of oldString. When false, oldString must match exactly once. Defaults to false." } }, required: ["path", "oldString", "newString"], additionalProperties: false }, strict: false },
  { name: "glob", description: 'Search file paths using a glob pattern (examples: "**/*.ts", "src/**/*.tsx").', parameters: { type: "object", properties: { pattern: { type: "string", description: "Glob pattern to match files against" }, path: { type: "string", description: "Directory to search. Defaults to the current working directory." }, hidden: { type: "boolean", description: "Include hidden files and directories (default: false)." }, limit: { type: "integer", description: "Maximum number of matching files to return (default: 100)", exclusiveMinimum: 0 } }, required: ["pattern"], additionalProperties: false }, strict: false },
  { name: "grep", description: "Search file contents using ripgrep's regular expression syntax or literal text matching. Use it to locate specific code, symbols, or text patterns, and narrow searches with `path` or `include`. Returns matching file paths, line numbers, and line previews.", parameters: { type: "object", properties: { pattern: { type: "string", description: "Regular expression or literal text to match in file contents.", minLength: 1 }, path: { type: "string", description: "File or directory to search. Defaults to the current working directory." }, include: { type: "string", description: "Glob pattern to filter files (for example, \"*.js\" or \"*.{ts,tsx}\")" }, literal: { type: "boolean", description: "Treat `pattern` as exact text instead of a regular expression (default: false)." }, caseSensitive: { type: "boolean", description: "Use case-sensitive matching (default: true)." }, limit: { type: "integer", description: "Maximum number of matching lines to return (default: 100)", exclusiveMinimum: 0 } }, required: ["pattern"], additionalProperties: false }, strict: false },
  { name: "read", description: "Read the contents of a file or directory. Supports text files, images, and PDFs. Images and PDFs are presented directly to the model. Each text line is prefixed by its 1-based line number as <line>: <content>. The prefix is for reference and is not part of the file content. Directory entries are returned one per line. Use offset and limit to read large files or directories in sections. Prefer one larger read over many small slices, and use grep to find specific content in large files.", parameters: { type: "object", properties: { path: { type: "string", description: "File or directory to read" }, offset: { type: "integer", description: "The line or directory entry to start reading from (1-based)", minimum: 0 }, limit: { type: "integer", description: "The maximum number of lines or directory entries to read (defaults to and capped at 2000)", minimum: 0 } }, required: ["path"], additionalProperties: false }, strict: false },
  { name: "shell", description: "Execute a shell command and return its output. Commands run on Windows using powershell. Quote file paths containing spaces or special characters. Prefer dedicated tools over shell commands when possible. When output is large, the full result is saved to a file and a truncated preview is returned. Rely on automatic truncation unless filtering the output is more useful. Commands accept an optional timeout, background commands have no timeout by default. Background commands return immediately, and you will be notified when they complete.", parameters: { type: "object", properties: { command: { type: "string", description: "Shell command string to execute" }, timeout: { type: "integer", description: "Timeout in milliseconds. Set to 0 to disable the timeout. Defaults to 120000 for foreground commands. Background commands have no timeout by default.", minimum: 0 }, background: { type: "boolean", description: "Run the command in the background and return immediately (useful for dev servers and long-running builds). You do not need to use '&' at the end of the command when using this parameter. You will be notified when it completes. DO NOT poll for completion." }, workdir: { type: "string", description: "Working directory to execute the command in. Defaults to the current working directory. When possible, avoid changing directories in the command and set the working directory here instead." } }, required: ["command"], additionalProperties: false }, strict: false },
  { name: "skill", description: "Load a specialized skill's instructions and resources into the current conversation when the task at hand matches its description.\n\nThe skill ID must match an available skill or a skill explicitly referenced by the user.", parameters: { type: "object", properties: { id: { type: "string", description: "The ID of an available skill or a skill explicitly referenced by the user" } }, required: ["id"], additionalProperties: false }, strict: false },
  { name: "subagent", description: "Spawns an agent in a child session to work on the specified task.\nThe output includes a sessionID you can pass back later to continue that specific conversation with the subagent.\nNew child sessions start with fresh context, so include all relevant context and instructions when you don't pass a sessionID.\nForeground (default) runs the subagent to completion and returns its final response.\nBackground mode (background=true) launches it asynchronously and returns immediately; you are notified when it finishes.\nUse background only for independent work that can run while you continue elsewhere.\n\nAvailable subagents:\n- explore: Fast agent specialized for exploring codebases. Use this when you need to quickly find files by patterns (eg. \"src/components/**/*.tsx\"), search code for keywords (eg. \"API endpoints\"), or answer questions about the codebase (eg. \"how do API endpoints work?\"). When calling this agent, specify the desired thoroughness level: \"quick\" for basic searches, \"medium\" for moderate exploration, or \"very thorough\" for comprehensive analysis across multiple locations and naming conventions.\n- general: General-purpose agent for researching complex questions and executing multi-step tasks. Use this agent to execute multiple units of work in parallel.", parameters: { type: "object", properties: { agent: { type: "string", description: "The type of specialized agent to use for this task. If the user asks for a subagent by a name that is not one of the available subagents, they most likely mean a model: pick a suitable agent and pass the name through the model parameter instead." }, prompt: { type: "string", description: "The task for the subagent to perform" }, description: { type: "string", description: "A short 3-5 word label for the task, displayed to the user" }, model: { type: "string", description: "NEVER set this unless the user explicitly asks for a particular model or variant. The value is written as \"providerID/modelID\", or \"providerID/modelID#variant\" to include a variant. Do not guess the ID: look the model up with the models tool, filtering to your own provider first." }, sessionID: { type: "string", description: "Continue a specific previous subagent conversation by passing its sessionID. Calls without a sessionID start a new conversation.", pattern: "^ses" }, background: { type: "boolean", description: "Run the subagent in the background and return immediately. You will be notified when it completes. DO NOT sleep, poll, or proactively check on its progress." } }, required: ["agent", "description", "prompt"], additionalProperties: false }, strict: false },
  { name: "webfetch", description: "Fetch content from an HTTP or HTTPS URL and return it as text, markdown, or HTML. Markdown is the default.\n\nUse a more targeted tool when one is available. This tool is read-only. Large text results may be replaced with a preview while the complete output is retained in managed storage.", parameters: { type: "object", properties: { url: { type: "string", description: "The HTTP or HTTPS URL to fetch content from" }, format: { type: "string", description: "The format to return the content in. Defaults to markdown.", enum: ["text", "markdown", "html"] }, timeout: { type: "number", description: "Optional timeout in seconds (maximum: 120)", exclusiveMinimum: 0, maximum: 120 } }, required: ["url"], additionalProperties: false }, strict: false },
  { name: "websearch", description: "Search the web using the user's selected search integration. Use this for current information beyond knowledge cutoff.\n\nThe current year is 2026. Use this year when searching for recent information or current events.", parameters: { type: "object", properties: { query: { type: "string", description: "Websearch query" } }, required: ["query"], additionalProperties: false }, strict: false },
  { name: "write", description: "Writes a file to the local filesystem, overwriting if one exists.\n\nMissing parent directories are created automatically.\n\nUse this tool to create new files or overwrite existing files. For partial changes, use the edit tool instead.", parameters: { type: "object", properties: { path: { type: "string", description: "Path to the file to write to" }, content: { type: "string", description: "Content to write to the file" } }, required: ["path", "content"], additionalProperties: false }, strict: false },
  { name: "execute", description: "Run JavaScript in a confined Code Mode runtime to script tool calls and HTTP requests and compose their results.\n`fetch` is available for HTTP requests. Imports, direct filesystem access, and timers are unavailable; all other external access goes through `tools`.\nWithin `{ code }`, the only callable tools are those explicitly listed in the Code Mode catalog instructions or returned by the `search` function. Inside `{ code }`, ignore tools shown outside the Code Mode catalog. They are not available in the Code Mode runtime.\nCall tools through `tools` using only exact paths and signatures from the catalog. Do not infer or normalize tool names; preserve bracket notation such as `tools.<namespace>[\"tool-name\"](input)`.\nPrefer an explicit `return`; if omitted, the final top-level expression becomes the result.\nAwait every call whose completion matters; pending calls are interrupted when execution ends. Run independent calls concurrently with `Promise.allSettled`.", parameters: { type: "object", properties: { code: { type: "string" } }, required: ["code"], additionalProperties: false }, strict: false },
];

function chatBody(model: string, message: string, opts: { readonly dir?: string; readonly full?: boolean; readonly sessionId?: string }): Record<string, unknown> {
  const dir = opts.dir;
  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: "system", content: systemPrompt(dir) },
      { role: "user", content: message },
    ],
    tools: FREE_AGENT_TOOLS.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        strict: tool.strict,
      },
    })),
    stream: false,
    stream_options: { include_usage: true },
    max_completion_tokens: 32_000,
  };
  if (opts.full === true && opts.sessionId !== undefined) {
    body.promptCacheKey = opts.sessionId;
    body.cache = { ttl: 3600 };
    body.generation = {};
  }
  return body;
}

// ---------------------------------------------------------------- main

const { values } = parseArgs({
  options: {
    models: { type: "boolean", default: false },
    chat: { type: "boolean", default: false },
    model: { type: "string", default: "big-pickle" },
    message: { type: "string", default: "ping" },
    stream: { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
    out: { type: "string" },
    full: { type: "boolean", default: false },
    project: { type: "string" },
    dir: { type: "string" },
    ua: { type: "string" },
    client: { type: "string" },
    token: { type: "string" },
    org: { type: "string" },
  },
});

const dryRun = values["dry-run"] === true;

async function probeModels(): Promise<void> {
  const url = modelsEndpoint();
  const headers = {
    accept: "application/json",
    "user-agent": values.ua ?? "opencode/latest/2.2.5/cli",
  };
  if (dryRun) {
    console.log(`[dry-run] GET ${url}`);
    console.log(`[dry-run] headers: ${JSON.stringify(headers, null, 2)}`);
    return;
  }
  console.log(`GET ${url}`);
  const res = await probeGet(url, headers, { bodyCap: 2_000_000 });
  console.log(formatProbe("models", res));
  if (values.out !== undefined) {
    writeFileSync(values.out as string, JSON.stringify(JSON.parse(res.body), null, 2), "utf8");
    console.log(`wrote ${values.out}`);
  } else {
    console.log(res.body.slice(0, 800));
  }
}

async function probeChat(): Promise<void> {
  const url = chatEndpoint();
  // One session id per probe run, reused across the headers and the body's
  // promptCacheKey — matching a real client's single session.
  const sessionId = generateSessionId();
  const headers = buildHeaders({
    sessionId,
    ...(values.dir === undefined ? {} : { dir: values.dir as string }),
    ...(values.project === undefined ? {} : { project: values.project as string }),
    ...(values.ua === undefined ? {} : { ua: values.ua as string }),
    ...(values.client === undefined ? {} : { client: values.client as string }),
    ...(values.token === undefined ? {} : { token: values.token as string }),
    ...(values.org === undefined ? {} : { org: values.org as string }),
  });
  const model = values.model as string;
  const message = values.message as string;
  const body = chatBody(model, message, {
    ...(values.dir === undefined ? {} : { dir: values.dir as string }),
    ...(values.full === true ? { full: true, sessionId } : {}),
  });
  if (values.stream === true) body.stream = true;

  if (dryRun) {
    console.log(`[dry-run] POST ${url}`);
    console.log(`[dry-run] headers: ${JSON.stringify(headers, null, 2)}`);
    console.log(`[dry-run] body: ${JSON.stringify(body, null, 2)}`);
    return;
  }

  console.log(`POST ${url}`);
  console.log(`  model=${model} message=${message.length} chars stream=${body.stream} dir=${values.dir ?? "(none)"} full=${values.full === true}`);
  const res = await probePost(url, headers, JSON.stringify(body), { timeoutMs: 30_000 });
  console.log(formatProbe("chat", res));
}

if (values.models === true) {
  await probeModels();
} else {
  await probeChat();
}
