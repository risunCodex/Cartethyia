/**
 * Qoder probe dispatcher — one entry point for every probe in this directory.
 *
 *   bun run scripts/provider-probing/qoder/main.ts <probe> [args...]
 *
 * The probe name is a short alias; extra args are forwarded verbatim to the
 * underlying script (e.g. `--creds <file> --model qmodel`).
 *
 *   bun run .../main.ts                        # list probes
 *   bun run .../main.ts chat --creds a.json --model auto
 *   bun run .../main.ts meta --creds a.json --model qmodel
 *   bun run .../main.ts capacity --creds a.json --mode context
 *   bun run .../main.ts retention --creds a.json --mode retention
 *   bun run .../main.ts grpc-meta --creds a.json --model dmodel
 *   bun run .../main.ts grpc-echo --creds a.json --echo-only
 *   bun run .../main.ts entitlement --creds a.json --header-mode all
 *   bun run .../main.ts roster --creds a.json --roster-key qfmodel
 *   bun run .../main.ts credits --creds a.json [--claim]
 *   bun run .../main.ts device-login --out x.json [--label "my account"]
 *   bun run .../main.ts export-accounts <sqlite> <out.json>
 *   bun run .../main.ts body-inspect
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

const PROBES: Record<string, string> = {
  // chat / transport / wire (single canonical probe)
  chat: "chat/probe-qoder.ts",
  meta: "chat/probe-qoder-meta.ts",
  capacity: "chat/qoder-capacity-probe.ts",
  retention: "chat/qoder-capacity-probe.ts",
  // grpc
  "grpc-meta": "grpc/qoder-grpc-meta.ts",
  "grpc-echo": "grpc/qoder-grpc-meta.ts",
  // quota / entitlement / roster / credits
  entitlement: "quota/qoder-entitlement-probe.ts",
  roster: "quota/qoder-entitlement-probe.ts",
  credits: "quota/probe-qoder-credits.ts",
  // auth / export / inspect
  "device-login": "auth/qoder-device-login.ts",
  "export-accounts": "auth/qoder-export-accounts.ts",
  "body-inspect": "inspect/qoder-body-inspect.ts",
};

const alias = process.argv[2];
if (!alias || !PROBES[alias]) {
  console.log("Qoder probe dispatcher — usage:");
  console.log("  bun run scripts/provider-probing/qoder/main.ts <probe> [args...]\n");
  console.log("Available probes:");
  for (const [name, file] of Object.entries(PROBES)) {
    console.log(`  ${name.padEnd(14)} → ${file}`);
  }
  process.exit(alias ? 2 : 0);
}

const script = join(here, PROBES[alias]!);
const child = spawn(process.execPath, [script, ...process.argv.slice(3)], {
  stdio: "inherit",
});
child.on("exit", (code) => process.exit(code ?? 1));
