/**
 * Live Cursor probe over the real adapter code path.
 *
 * Everything this script does, the gateway does: quota goes through
 * `fetchCursorQuota` (both surfaces plus GetPlanInfo), the model roster goes
 * through `fetchCursorDiscovery` (the three roster RPCs), and a Run turn goes
 * through `cursorAdapter.dispatch` — the same facade, relay, history builder,
 * parked-run registry, and h2/h1 transport the production dispatch uses. There
 * is no hand-rolled wire code here on purpose: an answer from this script is
 * an answer from the adapter.
 *
 * Surfaces:
 *   --quota    fetchCursorQuota — legacy buckets + usage-summary + weekly reset
 *   --models   fetchCursorDiscovery — the account's roster as routes
 *   --hit      one canonical dispatch through cursorAdapter (default model auto)
 *   --relay    tool-relay round trip: turn 1 parks with a held tool call, turn 2 resumes in-band
 *
 * Usage:
 *   bun run scripts/provider-probing/cursor/probe.ts \
 *     --creds C:\Users\Aria\Desktop\cursor-accounts-<ts>.json --quota
 *   bun run ... --creds <file> --models
 *   bun run ... --creds <file> --hit --model auto --prompt "Reply with the single word: pong"
 *
 * The credential is read from the file only: never printed (masked prefix
 * only), never echoed, never written anywhere.
 */
import { parseArgs } from "node:util";
import {
  maskSecret,
  pickAccount,
  readAccountsFile,
  requireAccountToken,
} from "../lib/accounts";
import { resolveSsrfPolicy } from "../../../src/config/network";
import { ValidatedNetworkBindingFactory } from "../../../src/network/egress/factory";
import { cursorAdapter } from "../../../src/providers/integrations/cursor/cursor";
import { fetchCursorDiscovery } from "../../../src/providers/integrations/cursor/cursor-discovery";
import { fetchCursorQuota } from "../../../src/providers/integrations/cursor/cursor-quota";
import { CURSOR_RUN_PATH } from "../../../src/providers/integrations/cursor/cursor-wire";
import type {
  ProviderDispatchContext,
  ProviderDispatchTarget,
} from "../../../src/providers/provider-contracts";
import type {
  CanonicalEvent,
  CanonicalRequest,
  ContentPart,
} from "../../../src/protocol/canonical-model";

const args = parseArgs({
  options: {
    creds: { type: "string" },
    token: { type: "string" },
    label: { type: "string" },
    index: { type: "string" },
    model: { type: "string", default: "auto" },
    prompt: { type: "string", default: "Reply with the single word: pong" },
    quota: { type: "boolean", default: false },
    models: { type: "boolean", default: false },
    hit: { type: "boolean", default: false },
    relay: { type: "boolean", default: false },
    timeout: { type: "string", default: "60000" },
  },
});

function resolveCredential(): string {
  const v = args.values;
  const direct = v.token?.trim() ?? "";
  if (direct.length > 0) return direct;
  if (!v.creds) throw new Error("pass --token <jwt> or --creds <accounts.json>");
  const accounts = readAccountsFile(v.creds!);
  const account = pickAccount(accounts, {
    providerId: "cursor",
    ...(v.label !== undefined ? { label: v.label } : {}),
    ...(v.index !== undefined ? { index: Number(v.index) } : {}),
  });
  return requireAccountToken(account);
}

function buildEgress() {
  // Cursor is direct-only (its bidi stream shape breaks behind a proxy), so
  // the probe binds the same direct-egress factory the production dispatch
  // uses, with the deployment's SSRF policy.
  const factory = new ValidatedNetworkBindingFactory(resolveSsrfPolicy());
  return { fetch: factory.fetch(), http2: factory.http2Bidi() };
}

async function probeQuota(credential: string): Promise<void> {
  console.log(`token: ${maskSecret(credential)}`);
  console.log("\n== quota: fetchCursorQuota (auth/usage + usage-summary + GetPlanInfo) ==");
  const result = await fetchCursorQuota(credential, globalThis.fetch);
  console.log(`source: ${result.source}`);
  console.log(`plan: ${result.plan ?? "(none)"}`);
  console.log(`accountLabel: ${result.accountLabel ?? "(none)"}`);
  console.log(`error: ${result.error ?? "(none)"}`);
  for (const window of result.windows) {
    const used = window.used === null ? "percent-only" : String(window.used);
    const limit = window.limit === null ? "-" : String(window.limit);
    const reset = window.resetsAt === null || window.resetsAt === undefined ? "-" : new Date(window.resetsAt).toISOString();
    console.log(
      `  [${window.kind}] ${window.label}: used=${used} limit=${limit} usedPercent=${window.usedPercent ?? "-"} accounting=${window.accounting} resets=${reset}${window.modelIds ? ` models=${window.modelIds.join(",")}` : ""}`,
    );
  }
}

async function probeModels(credential: string): Promise<void> {
  console.log(`token: ${maskSecret(credential)}`);
  console.log("\n== discovery: fetchCursorDiscovery (GetUsableModels + AvailableModels + GetDefaultModelForCli) ==");
  const discovery = await fetchCursorDiscovery(credential, globalThis.fetch);
  console.log(`routes: ${discovery.routes.length}`);
  for (const route of discovery.routes) {
    const params = route.parameters.map((p) => `${p.id}=${p.value}`).join(",");
    console.log(
      `  ${route.routeId} | slug=${route.legacySlug} wire=${route.wireModelId}${params ? ` params=[${params}]` : ""} maxMode=${route.maxMode} ctx=${route.contextTokens} usable=${route.accountUsable} default=${route.isDefault} (${route.displayName})`,
    );
  }
  console.log(`default: ${discovery.defaultRoute?.routeId ?? "(unidentified)"} (${discovery.defaultDisplayName ?? "-"})`);
  console.log(`usable (${discovery.usableSlugs.length}): ${discovery.usableSlugs.join(", ")}`);
}

function buildContext(
  credential: string,
  timeoutMs: number,
  egress: ReturnType<typeof buildEgress>,
): ProviderDispatchContext {
  return {
    credential: {
      provider_id: "cursor",
      credential_kind: "oauth",
      secret: new TextEncoder().encode(credential),
    },
    deadline: Date.now() + timeoutMs,
    abort_signal: AbortSignal.timeout(timeoutMs),
    outbound_fetch: egress.fetch,
    outbound_http2: egress.http2,
  };
}

const candidate: ProviderDispatchTarget = {
  provider_id: "cursor",
  model_id: args.values.model!,
  wire_family: "chat",
  endpoint_path: CURSOR_RUN_PATH,
  capabilities: {},
};

const PROBE_TOOL = {
  name: "probe_echo",
  description: "Echoes its text argument back. Use it when asked to.",
  jsonSchema: {
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
  },
};

async function probeHit(credential: string, timeoutMs: number): Promise<void> {
  const v = args.values;
  console.log(`token: ${maskSecret(credential)}`);
  console.log(`
== hit: cursorAdapter.dispatch model=${v.model} ==`);
  const egress = buildEgress();
  const context = buildContext(credential, timeoutMs, egress);
  const request: CanonicalRequest = {
    model: v.model!,
    messages: [{ role: "user", content: [{ kind: "text", text: v.prompt! }] }],
    generation_controls: {},
    stream: true,
    source_surface: "chat",
  };

  const started = Date.now();
  for await (const event of cursorAdapter.dispatch(request, candidate, context)) {
    printEvent(event, started);
  }
}

/**
 * Tool-relay round trip: turn one must park the run with a held tool call,
 * turn two (same conversation id, trailing tool result) must resume it
 * in-band and finish the turn with the result the probe supplied.
 */
async function probeRelay(credential: string, timeoutMs: number): Promise<void> {
  const v = args.values;
  console.log(`token: ${maskSecret(credential)}`);
  console.log(`
== relay: cursorAdapter.dispatch model=${v.model} (two turns, one tool) ==`);
  const egress = buildEgress();
  const conversationId = `probe-${crypto.randomUUID()}`;

  // Turn 1: the model should call probe_echo.
  const context = buildContext(credential, timeoutMs, egress);
  const request: CanonicalRequest = {
    model: v.model!,
    conversation_id: conversationId,
    messages: [
      { role: "user", content: [{ kind: "text", text: v.prompt! }] },
    ],
    tools: [PROBE_TOOL],
    generation_controls: {},
    stream: true,
    source_surface: "chat",
  };

  const started = Date.now();
  let toolCall: { callId: string; name: string } | undefined;
  for await (const event of cursorAdapter.dispatch(request, candidate, context)) {
    if (event.type === "tool_call_delta") {
      toolCall = { callId: event.call_id, name: event.name ?? "" };
      continue;
    }
    printEvent(event, started);
  }
  if (toolCall === undefined) {
    console.log("\nrelay: the model never called the tool — relay round trip not exercised");
    return;
  }

  // Turn 2: the trailing tool result resumes the parked run in-band.
  console.log(`
== relay turn 2: resuming with the tool result (conversation ${conversationId}) ==`);
  const context2 = buildContext(credential, timeoutMs, egress);
  const request2: CanonicalRequest = {
    model: v.model!,
    conversation_id: conversationId,
    messages: [
      { role: "user", content: [{ kind: "text", text: v.prompt! }] },
      {
        role: "assistant",
        content: [
          { kind: "toolCall", call_id: toolCall.callId, name: toolCall.name, arguments: { text: "probe-was-here" } },
        ],
      },
      {
        role: "tool",
        content: [{ kind: "toolResult", call_id: toolCall.callId, content: "echo: probe-was-here" }],
      },
    ],
    tools: [PROBE_TOOL],
    generation_controls: {},
    stream: true,
    source_surface: "chat",
  };
  const started2 = Date.now();
  for await (const event of cursorAdapter.dispatch(request2, candidate, context2)) {
    printEvent(event, started2);
  }
}


function printEvent(event: CanonicalEvent, started: number): void {
  const at = ((Date.now() - started) / 1000).toFixed(1);
  if (event.type === "response_start") {
    console.log(`[${at}s] response start (model=${event.model ?? "-"})`);
    return;
  }
  if (event.type === "content_delta") {
    const part: ContentPart = event.content;
    if (part.kind === "text") process.stdout.write(part.text);
    else if (part.kind === "reasoning") process.stdout.write(`(think) ${part.summary ?? ""}`);
    return;
  }
  if (event.type === "tool_call_delta") {
    console.log(`[${at}s] TOOL CALL ${event.name} id=${event.call_id} args=${event.arguments_delta ?? ""}`);
    return;
  }
  if (event.type === "usage") {
    const u = event.usage;
    console.log(
      `\n[${at}s] usage: in=${u.input_tokens} (cached=${u.cached_input_tokens}) out=${u.output_tokens} reasoning=${u.reasoning_tokens} cost=${u.estimated_cost}`,
    );
    return;
  }
  if (event.type === "terminal") {
    console.log(
      `\n[${at}s] terminal: state=${event.state} stop=${event.stop_reason ?? "-"}`,
    );
    return;
  }
  if (event.type === "error") {
    console.log(`\n[${at}s] ERROR (${event.category}, retryable=${event.retryable ?? "-"}): ${event.message}`);
    return;
  }
  console.log(`[${at}s] event: ${event.type}`);
}

async function main(): Promise<void> {
  const v = args.values;
  if (!v.quota && !v.models && !v.hit && !v.relay) {
    console.error("nothing to do: pass --quota, --models, --hit, and/or --relay");
    process.exit(1);
  }
  const credential = resolveCredential();
  const timeoutMs = Number(v.timeout);
  if (v.quota === true) await probeQuota(credential);
  if (v.models === true) await probeModels(credential);
  if (v.hit === true) await probeHit(credential, timeoutMs);
  if (v.relay === true) await probeRelay(credential, timeoutMs);
}

main().catch((error) => {
  console.error(`probe failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
