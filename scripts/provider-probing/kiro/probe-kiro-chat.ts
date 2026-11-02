/**
 * Live Kiro chat probe — IDE (1.4.62 runtime) vs CLI (2.37.0).
 *
 * Reads exported accounts from the same JSON file the console writes, never
 * prints tokens. Engines:
 *
 *   - `ide` — `POST https://runtime.{region}.kiro.dev/generateAssistantResponse`
 *     (`KiroRuntimeService.GenerateAssistantResponse`), AWS EventStream answer.
 *     This mirrors the 1.4.62 IDE (the surface the adapter uses).
 *   - `cli` — the SAME runtime surface, probed with the CLI's User-Agent
 *     (`Kiro-CLI/2.37.0`). Wire audit of the 2.37.0 CLI binary shows the chat
 *     path uses the identical AWS SDK codegen clients as the IDE
 *     (`amzn_codewhisperer_streaming_client` →
 *     `AmazonCodeWhispererStreamingService.GenerateAssistantResponse`); there is
 *     no separate public KAS ACP HTTP endpoint (`app.kiro.dev` answers 403, and
 *     `mavis-control-plane` is the embedded v3 engine's local service name).
 *   - `auto` (default) — picks `ide` for stored `authMethod` that maps to the
 *     runtime surface (builder-id/idc/api_key/external_idp/social) and `cli`
 *     for `kiro-cli`/cli token accounts.
 *
 * Usage:
 *   bun run scripts/provider-probing/kiro/probe-kiro-chat.ts \
 *     --creds "C:\Users\...\kiro-accounts-<ts>.json" --engine auto --message "ping"
 *   bun run scripts/provider-probing/kiro/probe-kiro-chat.ts \
 *     --creds <file> --engine cli --model auto --message "hi"
 *   bun run scripts/provider-probing/kiro/probe-kiro-chat.ts \
 *     --creds <file> --engine ide --model claude-sonnet-4.5 --message "hi"
 */
import { parseArgs } from "node:util";
import {
  maskSecret,
  maskUuid,
  pickAccount,
  readAccountsFile,
} from "../lib/accounts";
import {
  authFromAccount,
  probeGeneration,
  type KiroAuth,
} from "./probe-kiro";

const CLI_VERSION = "2.37.0";
// Wire audit of the 2.37.0 CLI binary: the chat path uses the SAME AWS SDK
// codegen clients as the IDE — `amzn_codewhisperer_streaming_client`
// (`AmazonCodeWhispererStreamingService.GenerateAssistantResponse`) against
// `https://runtime.{region}.kiro.dev/generateAssistantResponse`, and
// `amzn_codewhisperer_client` (`AmazonCodeWhispererService.*`) against
// `https://management.{region}.kiro.dev`. There is NO public KAS ACP HTTP
// endpoint at `app.kiro.dev` (403 "Bearer token authentication requires a
// resolvable operation"); `mavis-control-plane` is the embedded v3 engine's
// LOCAL service name (ACP over stdio/WebSocket, `_kiro.dev/*` extensions).
// A CLI real hit is therefore the same runtime surface with the CLI UA.
const KAS_RUNTIME_PATH = "/generateAssistantResponse";

type Engine = "auto" | "ide" | "cli";

/** authMethod → roughly which surface the stored credential belongs to. */
function resolveEngine(authMethod: string, requested: Engine): Engine {
  if (requested !== "auto") return requested;
  const lower = authMethod.toLowerCase();
  if (lower === "kiro-cli" || lower === "cli" || lower === "machine_token") return "cli";
  return "ide";
}

async function cliChat(
  auth: KiroAuth,
  model: string,
  message: string,
  opts: { readonly timeoutMs: number; readonly run: boolean },
): Promise<void> {
  // The CLI's chat surface is the runtime service, probed with the CLI UA.
  // Direct HTTP to the KAS ACP control plane (`app.kiro.dev`) is NOT a public
  // endpoint — it answers 403. `--run` dials the real runtime service.
  if (!opts.run) {
    console.log(`\n[cli] DRY-RUN — same runtime surface as IDE, with the CLI User-Agent.`);
    console.log(`  POST https://runtime.{region}.kiro.dev${KAS_RUNTIME_PATH}`);
    console.log(`  user-agent: Kiro-CLI/${CLI_VERSION}`);
    console.log(`  Pass --run to send the real request (requires an active credential).\n`);
    return;
  }

  try {
    // The CLI binary (2.37.0) uses the identical stream client as the IDE
    // (`AmazonCodeWhispererStreamingService.GenerateAssistantResponse`); the
    // only client difference is the UA/amz-UA marker.
    await probeGeneration(auth, model, {
      userAgent: `Kiro-CLI/${CLI_VERSION}`,
      message,
      timeoutMs: opts.timeoutMs,
    });
  } catch (error) {
    console.log(`  ERROR ${error instanceof Error ? error.message : String(error)}`);
  }
}

const { values } = parseArgs({
  options: {
    creds: { type: "string" },
    engine: { type: "string", default: "auto" },
    model: { type: "string", default: "auto" },
    message: { type: "string", default: "ping" },
    timeout: { type: "string", default: "30000" },
    run: { type: "boolean", default: false },
    label: { type: "string" },
    index: { type: "string" },
  },
});

const credsPath = values.creds;
if (credsPath === undefined) throw new Error("--creds <path> is required");

const accounts = readAccountsFile(credsPath);
const account = pickAccount(accounts, {
  providerId: "kiro",
  ...(values.label !== undefined ? { label: values.label } : {}),
  ...(values.index !== undefined ? { index: Number(values.index) } : {}),
});
const auth = authFromAccount(account);
const requestedEngine = values.engine as Engine;
const engine = resolveEngine(auth.authMethod, requestedEngine);

console.log(
  `account=${account.label ?? "?"} (${account.providerId ?? "?"}/${account.credentialKind ?? "?"}) ` +
    `token=${maskSecret(auth.accessToken)} region=${auth.region} authMethod=${auth.authMethod} ` +
    `machineId=${maskUuid(auth.machineId)} engine=${engine} (requested=${requestedEngine})`,
);

if (engine === "cli") {
  await cliChat(auth, values.model, values.message, {
    timeoutMs: Number(values.timeout),
    run: values.run,
  });
} else {
  await probeGeneration(auth, values.model, { timeoutMs: Number(values.timeout) });
}
