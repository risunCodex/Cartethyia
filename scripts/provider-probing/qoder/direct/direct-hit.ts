/**
 * Direct-hit probe against the unpacked Qoder CLI binary.
 *
 * Uses the REAL `qodercli.exe` (v1.1.83, Bun-compiled, extracted from
 * `qodercli-windows-x64.zip`) as the client — no reimplementation of the wire,
 * no COSY signer, no gRPC proto. The binary itself performs login (token
 * exchange), machine identity (UMID), signing (WASM), and streaming.
 *
 * Auth injection (proven):
 *   - PAT (`pt-...`): `QODER_PERSONAL_ACCESS_TOKEN` env — WORKS. The CLI
 *     exchanges it for a job token and proceeds (verified live: --list-models
 *     and --model cmodel --print both succeed).
 *   - Device token (`dt-...`): `QODER_SDK_AUTH_PAYLOAD_FILE` payload
 *     (`{type:"accessToken", accessToken}`) is read only in SDK/host mode —
 *     plain CLI mode answers `NonInteractiveAuthRequiredError`. Run
 *     `qodercli login` once interactively for device-token accounts.
 *
 * Usage:
 *   bun run scripts/provider-probing/qoder/direct/direct-hit.ts \
 *     --creds "C:\Users\...\qoder-accounts-<ts>.json" \
 *     --model cmodel --prompt "Halo" [--list-models] [--timeout-ms 120000]
 *
 * Flags:
 *   --creds <path>      exported-account JSON (qoder-accounts-*.json)
 *   --model <id>        roster key or virtual id (default cmodel)
 *   --prompt <text>     user prompt (default "Halo, perkenalkan dirimu singkat.")
 *   --prompt-file <path> read the prompt from a file (for large payloads)
 *   --list-models       run `--list-models` instead of a chat hit
 *   --cli <path>        override CLI binary path (default: unpacked trash copy)
 *   --timeout-ms <n>    total timeout for the spawn (default 120000)
 *   --keep-payload      keep the generated payload file (debug)
 */
import { parseArgs } from "node:util";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const DEFAULT_CLI = "D:/tmp/unpacked/qoder/Trash/qoder-cli-windows-x64/qodercli.exe";

const { values } = parseArgs({
  options: {
    creds: { type: "string" },
    model: { type: "string", default: "cmodel" },
    prompt: { type: "string", default: "Halo, perkenalkan dirimu singkat." },
    "prompt-file": { type: "string" },
    "list-models": { type: "boolean", default: false },
    cli: { type: "string" },
    "timeout-ms": { type: "string", default: "120000" },
    "keep-payload": { type: "boolean", default: false },
  },
});

const creds = values.creds;
if (!creds) throw new Error("--creds <path> is required");

const cli = values.cli ?? DEFAULT_CLI;
if (!existsSync(cli)) throw new Error(`CLI binary not found: ${cli}`);

const timeoutMs = Number(values["timeout-ms"]);
if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("--timeout-ms must be a positive number");

// --- load the exported account -------------------------------------------------
const raw = JSON.parse(readFileSync(creds, "utf8"));
const accounts = Array.isArray(raw) ? raw : raw.accounts ?? [];
if (accounts.length === 0) throw new Error("no accounts in creds file");
const account = accounts[0];
const token = account.accessToken ?? account.token ?? "";
if (typeof token !== "string" || token.length === 0) {
  throw new Error(`account ${account.label ?? "?"} has no accessToken`);
}
const kind = token.startsWith("dt-") ? "device-token" : token.startsWith("pt-") ? "pat" : "unknown";
const masked = token.slice(0, 4) + "…" + token.slice(-4);
console.log(`account=${account.label ?? "?"} kind=${kind} token=${masked}`);

// Auth injection strategy:
//   1. PAT (`pt-...`): `QODER_PERSONAL_ACCESS_TOKEN` env — proven to work
//      with the unpacked CLI (`--list-models` succeeded with it).
//   2. Device token (`dt-...`): try `QODER_SDK_AUTH_PAYLOAD_FILE` payload
//      (`{type:"accessToken", accessToken}`) — the SDK host path.
const useEnvPat = kind === "pat";
const env: Record<string, string | undefined> = { ...process.env };
let payloadDir: string | undefined;
if (useEnvPat) {
  env.QODER_PERSONAL_ACCESS_TOKEN = token;
  console.log("auth: QODER_PERSONAL_ACCESS_TOKEN (PAT)");
} else {
  if (kind === "device-token") {
    console.warn(
      "[warn] Device token (dt-...) via SDK payload env is NOT accepted in plain CLI mode " +
        "(NonInteractiveAuthRequiredError). Use a PAT account, or run `qodercli login` once interactively.",
    );
  }
  payloadDir = mkdtempSync(join(tmpdir(), "qoder-direct-hit-"));
  const payloadPath = join(payloadDir, "auth-payload.json");
  writeFileSync(payloadPath, JSON.stringify({ type: "accessToken", accessToken: token }), "utf8");
  env.QODER_SDK_AUTH_PAYLOAD_FILE = payloadPath;
  console.log(`auth: QODER_SDK_AUTH_PAYLOAD_FILE=${payloadPath}`);
}

// --- build the args ---------------------------------------------------------------
const args: string[] = [];
if (values["list-models"]) {
  args.push("--list-models");
} else {
  args.push("--model", values.model!);
  args.push("--print");
  args.push("--no-session-persistence");
  const promptText = values["prompt-file"] !== undefined
    ? readFileSync(values["prompt-file"], "utf8")
    : values.prompt!;
  args.push(promptText);
}

console.log(`cli=${cli}`);
console.log(`args=${args.join(" ")}`);

// --- spawn --------------------------------------------------------------------------
const child = spawn(cli, args, {
  env: {
    ...env,
    // Non-interactive; avoid waiting on prompts.
    QODER_ENV: process.env.QODER_ENV ?? "prod",
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});

let stdout = "";
let stderr = "";
child.stdout.on("data", (d) => {
  stdout += d.toString();
});
child.stderr.on("data", (d) => {
  stderr += d.toString();
});

const timer = setTimeout(() => {
  console.log("TIMEOUT — killing child");
  child.kill("SIGKILL");
}, timeoutMs);

child.on("error", (err) => {
  clearTimeout(timer);
  console.error("spawn error:", err.message);
  cleanup();
  process.exit(1);
});

child.on("exit", (code, signal) => {
  clearTimeout(timer);
  console.log(`\n--- exit code=${code} signal=${signal ?? ""} ---`);
  if (stdout.length > 0) {
    // Print tail only — the full output can be very large.
    const lines = stdout.split(/\r?\n/);
    const tail = lines.slice(-80).join("\n");
    console.log("--- STDOUT (tail 80 lines) ---");
    console.log(tail);
  }
  if (stderr.length > 0) {
    console.log("--- STDERR (tail 40 lines) ---");
    console.log(stderr.split(/\r?\n/).slice(-40).join("\n"));
  }
  cleanup();
  process.exit(code ?? 0);
});

function cleanup(): void {
  if (!values["keep-payload"] && payloadDir !== undefined) {
    try {
      rmSync(payloadDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}
