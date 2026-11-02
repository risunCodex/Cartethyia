/**
 * OpenCode wire replay tool.
 *
 * Reads a captured OpenCode request (from the mitmproxy flows of a real CLI
 * dispatch) and either prints it readable or replays it verbatim upstream.
 * Also unpacks the minified opencode CLI binary: finds the builder regions
 * that contain `/inference` and beautifies them so the request-shaping code
 * can be read.
 *
 * Usage (run directly; no `probe:*` npm script):
 *
 *   # Unpack + beautify the builder regions from the CLI binary.
 *   bun run scripts/provider-probing/opencode/replay-opencode.ts unpack \
 *     [--bin <path-to-opencode.exe>] [--out <dir>]
 *
 *   # Print a captured request (from the extracted flow JSON) readably.
 *   bun run scripts/provider-probing/opencode/replay-opencode.ts dump <flow.json>
 *
 *   # Replay a captured request upstream (drops no headers by default).
 *   bun run scripts/provider-probing/opencode/replay-opencode.ts send <flow.json> \
 *     [--token <key>] [--org <org-id>] [--no-auth] [--timeout-ms <ms>]
 *
 * Flow JSON shape:
 *   { "method": "POST", "url": "https://opencode.ai/...",
 *     "headers": { "authorization": "Bearer st_…", ... },
 *     "body": "…raw JSON string…" | "bodyFile": "path/to/body.json" }
 *
 * Never prints token values: headers that carry credentials are shown only as
 * `Bearer ***` (length kept) in dump mode, and `--no-auth`/`--token`
 * intentionally replace them before replay.
 */
import { parseArgs } from "node:util";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { probeGet, probePost, formatProbe } from "../lib/http";
import { beautify } from "../lib/beautify";

// ----------------------------------------------------------- unpack command

const DEFAULT_BIN = "C:\\Users\\Aria\\.bun\\install\\global\\node_modules\\@opencode\\cli\\bin\\opencode.exe";
const DEFAULT_OUT = "D:\\tmp\\scratch\\opencode-replay";
const REGION_WINDOW = 60_000;

function findAll(haystack: Buffer, needle: Buffer): number[] {
  const out: number[] = [];
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    out.push(i);
    i = haystack.indexOf(needle, i + 1);
  }
  return out;
}

async function cmdUnpack(binPath: string, outDir: string): Promise<void> {
  if (!existsSync(binPath)) throw new Error(`binary not found: ${binPath}`);
  mkdirSync(outDir, { recursive: true });
  const data = readFileSync(binPath);
  const needle = Buffer.from("/inference");
  const hits = findAll(data, needle);
  console.log(`binary ${binPath} (${data.length} bytes); /inference hits: ${hits.length}`);
  if (hits.length === 0) throw new Error("no /inference hit found — is this the opencode CLI binary?");

  for (const [idx, at] of hits.entries()) {
    const start = Math.max(0, at - REGION_WINDOW);
    const end = Math.min(data.length, at + REGION_WINDOW);
    const chunk = data.subarray(start, end).toString("utf8");
    const readable = beautify(chunk);
    const outFile = join(outDir, `builder-inference-${idx}.readable.js`);
    writeFileSync(outFile, readable, "utf8");
    console.log(`  [${idx}] byte ${at} -> ${outFile} (${readable.length} chars)`);
  }
  console.log(`\nunpacked ${hits.length} regions into ${outDir}`);
}

// ------------------------------------------------------------ flow loading

interface FlowRequest {
  readonly method: string;
  readonly url: string;
  readonly headers?: Record<string, string>;
  readonly body?: string;
  readonly bodyFile?: string;
}

function loadFlow(path: string): FlowRequest {
  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<FlowRequest>;
  if (typeof raw.url !== "string" || typeof raw.method !== "string") {
    throw new Error(`flow must contain string "url" and "method": ${path}`);
  }
  let body: string | undefined = raw.body;
  if (raw.bodyFile !== undefined) {
    const bodyPath = join(dirname(path), raw.bodyFile);
    body = readFileSync(bodyPath, "utf8");
  }
  return {
    method: raw.method,
    url: raw.url,
    ...(raw.headers !== undefined ? { headers: raw.headers } : {}),
    ...(body !== undefined ? { body } : {}),
  };
}

const CRED_HEADERS = new Set([
  "authorization",
  "x-api-key",
  "api-key",
  "cookie",
  "set-cookie",
  "x-opencode-org-id",
]);

function redactHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers ?? {})) {
    const key = k.toLowerCase();
    if (CRED_HEADERS.has(key)) {
      out[k] = key === "authorization" && /^Bearer\s+/i.test(v) ? `Bearer ${"*".repeat(v.length - 7)}` : "***";
    } else {
      out[k] = v;
    }
  }
  return out;
}

function prettyBody(body: string | undefined): string {
  if (body === undefined) return "(no body)";
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}

function cmdDump(flowPath: string): void {
  const flow = loadFlow(flowPath);
  console.log(`${flow.method} ${flow.url}`);
  console.log("headers:");
  for (const [k, v] of Object.entries(redactHeaders(flow.headers))) console.log(`  ${k}: ${v}`);
  console.log(`body (${flow.body?.length ?? 0} chars):`);
  console.log(prettyBody(flow.body));
}

// ------------------------------------------------------------- send command

async function cmdSend(
  flowPath: string,
  opts: { token?: string; org?: string; noAuth: boolean; timeoutMs: number },
): Promise<void> {
  const flow = loadFlow(flowPath);
  const headers: Record<string, string> = { ...(flow.headers ?? {}) };

  if (opts.noAuth) {
    for (const key of Object.keys(headers)) {
      if (CRED_HEADERS.has(key.toLowerCase())) delete headers[key];
    }
  } else if (opts.token !== undefined && opts.token.length > 0) {
    headers.authorization = `Bearer ${opts.token}`;
    // A token implies a billed/org-gated route; drop anonymous sentinels.
    if (headers.authorization === "Bearer public") delete headers.authorization;
  }
  if (opts.org !== undefined && opts.org.length > 0) headers["x-opencode-org-id"] = opts.org;

  console.log(`replaying ${flow.method} ${flow.url}`);
  if (flow.method === "GET") {
    const res = await probeGet(flow.url, headers, { timeoutMs: opts.timeoutMs });
    console.log(formatProbe("replay", res));
  } else {
    const res = await probePost(flow.url, headers, flow.body ?? "", { timeoutMs: opts.timeoutMs });
    console.log(formatProbe("replay", res));
  }
}

// ------------------------------------------------------------------- main

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    bin: { type: "string" },
    out: { type: "string" },
    token: { type: "string" },
    org: { type: "string" },
    "no-auth": { type: "boolean", default: false },
    "timeout-ms": { type: "string", default: "30000" },
  },
});

const command = positionals[0];
const flowArg = positionals[1];

switch (command) {
  case "unpack": {
    const binPath = values.bin ?? DEFAULT_BIN;
    const outDir = values.out ?? DEFAULT_OUT;
    await cmdUnpack(binPath, outDir);
    break;
  }
  case "dump": {
    if (!flowArg) throw new Error("dump requires a flow.json path");
    cmdDump(flowArg);
    break;
  }
  case "send": {
    if (!flowArg) throw new Error("send requires a flow.json path");
    await cmdSend(flowArg, {
      ...(values.token !== undefined ? { token: values.token } : {}),
      ...(values.org !== undefined ? { org: values.org } : {}),
      noAuth: values["no-auth"] === true,
      timeoutMs: Number(values["timeout-ms"]),
    });
    break;
  }
  default:
    console.error(`unknown command: ${command ?? "(none)"}`);
    console.error("usage: replay-opencode.ts <unpack|dump|send> [args]");
    process.exitCode = 1;
}
