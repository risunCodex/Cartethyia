/**
 * Provider acceptance harness — the local, mandatory gate for every new
 * provider.
 *
 * The design follows mini-swe-agent's discipline: one linear-history loop,
 * deterministic tools, outcome-based checks. There are no per-provider
 * scenarios — a task is a prompt plus checks over the trajectory, and the
 * model decides how many tool rounds it needs. Every dispatch goes through
 * the real registry adapter, so a harness pass is a dispatch pass.
 *
 * Tasks:
 * - `text`           — a plain turn: streamed text, usage, clean terminal.
 * - `single-tool`    — one tool call, result fed back, answer reflects it.
 * - `parallel-tools` — two independent calls (the model chooses whether they
 *                      batch; `INFO parallel` reports, `--strict-parallel` gates).
 * - `arg-fidelity`   — exact argument transport (a reversed string must come
 *                      back reversed through the provider's wire).
 * - `chat-surfaces`  — protocol translation: three reused-session turns with
 *                      different triggers through every caller surface dialect
 *                      (chat completions, responses, messages, completion),
 *                      asserted on the NATIVE encoded output.
 * - `tools-surfaces` — the tool round trip in each tool-capable dialect: the
 *                      call is extracted from the native output and the result
 *                      fed back in the same dialect.
 * - `all`            — everything above.
 *
 * Gemini has no caller-facing ingress (it is an upstream wire only), so it is
 * not in the surface matrix.
 *
 * Usage:
 *   bun run scripts/provider-harness/run.ts --provider cursor \
 *     --creds C:\path\accounts.json --model auto
 *   bun run ... --provider cursor --creds <file> --model grok-4.7-medium --task parallel-tools
 *   bun run ... --provider cursor --token <jwt> --model auto --json
 *
 * The credential is read from the file only: never printed (masked prefix
 * only), never echoed, never written anywhere.
 */
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { maskSecret, readAccountsFile } from "../provider-probing/lib/accounts";
import { resolveSsrfPolicy } from "../../src/config/network";
import { ValidatedNetworkBindingFactory } from "../../src/network/egress/factory";
import { BUNDLED_PROVIDER_MODULES } from "../../src/providers/registry/modules";
import { createDefaultProviderRegistry } from "../../src/providers/registry/modules";
import { parseProviderId, type ProviderAdapter, type ProviderDispatchContext, type ProviderDispatchTarget } from "../../src/providers/provider-contracts";
import type {
  CanonicalMessage,
  CanonicalRequest,
  ContentPart,
} from "../../src/protocol/canonical-model";
import { runChatSurfaces, runToolsSurfaces } from "./surfaces";

// ── deterministic tools ──

const HARNESS_TOOLS = [
  {
    name: "harness_add",
    description: "Adds two integers and returns the sum. Use for any arithmetic.",
    jsonSchema: {
      type: "object",
      properties: { a: { type: "integer" }, b: { type: "integer" } },
      required: ["a", "b"],
    },
  },
  {
    name: "harness_get_weather",
    description: "Returns the weather for a city. Use for any weather question.",
    jsonSchema: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    },
  },
  {
    name: "harness_reverse",
    description: "Reverses the given text exactly, character by character.",
    jsonSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
  },
] as const;

/** Runs one harness tool; deterministic by construction, no environment access. */
function runHarnessTool(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case "harness_add": {
      const a = Number(args["a"]);
      const b = Number(args["b"]);
      return `Sum: ${a + b}`;
    }
    case "harness_get_weather": {
      const city = String(args["city"] ?? "unknown");
      return `Weather in ${city}: 21C, sunny`;
    }
    case "harness_reverse": {
      const text = String(args["text"] ?? "");
      return `Reversed: ${[...text].reverse().join("")}`;
    }
    default:
      return `Unknown tool: ${name}`;
  }
}

// ── tasks ──

export interface HarnessTask {
  readonly name: string;
  readonly prompt: string;
  readonly tools: readonly string[];
  /** The trajectory facts that must hold when the loop ends. */
  readonly checks: readonly HarnessCheck[];
}

export type HarnessCheck =
  | { readonly kind: "text-contains"; readonly value: string }
  | { readonly kind: "tool-called"; readonly name: string }
  | { readonly kind: "tool-called-with"; readonly name: string; readonly args: Record<string, unknown> }
  /** Informational by default: whether the MODEL chose to batch the calls in one step. `--strict-parallel` gates on it. */
  | { readonly kind: "calls-together"; readonly names: readonly string[] }
  | { readonly kind: "terminal-stop" };

const TEXT_TASK: HarnessTask = {
  name: "text",
  prompt: "Quick ping test — just say pong back.",
  tools: [],
  checks: [{ kind: "text-contains", value: "pong" }, { kind: "terminal-stop" }],
};

const SINGLE_TOOL_TASK: HarnessTask = {
  name: "single-tool",
  prompt:
    "Could you check the weather in Tokyo for me with your weather tool? I only need the temperature it reports — no guessing.",
  tools: ["harness_get_weather"],
  checks: [
    { kind: "tool-called", name: "harness_get_weather" },
    { kind: "text-contains", value: "21" },
    { kind: "terminal-stop" },
  ],
};

const PARALLEL_TOOLS_TASK: HarnessTask = {
  name: "parallel-tools",
  prompt:
    "Two things, please: what is 17 plus 25, and what is the weather in Oslo right now? Use your tools for both, " +
    "then give me the sum and the weather together.",
  tools: ["harness_add", "harness_get_weather"],
  checks: [
    { kind: "tool-called-with", name: "harness_add", args: { a: 17, b: 25 } },
    { kind: "tool-called", name: "harness_get_weather" },
    { kind: "calls-together", names: ["harness_add", "harness_get_weather"] },
    { kind: "text-contains", value: "42" },
    { kind: "text-contains", value: "21" },
    { kind: "terminal-stop" },
  ],
};

const ARG_FIDELITY_TASK: HarnessTask = {
  name: "arg-fidelity",
  prompt: "Could you reverse the word 'stressed' with your harness_reverse tool and tell me what it returns?",
  tools: ["harness_reverse"],
  checks: [
    { kind: "tool-called-with", name: "harness_reverse", args: { text: "stressed" } },
    { kind: "text-contains", value: "desserts" },
    { kind: "terminal-stop" },
  ],
};

export const HARNESS_TASKS: readonly HarnessTask[] = [
  TEXT_TASK,
  SINGLE_TOOL_TASK,
  PARALLEL_TOOLS_TASK,
  ARG_FIDELITY_TASK,
];

// ── multi-account session ──

/**
 * One conversation continued across rotating accounts.
 *
 * Every turn rides the SAME session id but the NEXT credential — the shape a
 * gateway client produces when account rotation hands the conversation to a
 * different upstream account mid-flight. Continuity must come from the
 * gateway's own history (for Cursor: a fresh conversation rebuilt from the
 * blob records, because a parked run belongs to the account that parked it),
 * and the recall turns prove the model still sees the whole exchange.
 */
const MULTI_ACCOUNT_TASK: HarnessTask = {
  name: "multi-account",
  prompt: "Quick note: the meeting room for tomorrow is B-7. Just acknowledge, please.",
  tools: [],
  checks: [
    { kind: "text-contains", value: "B-7" },
    { kind: "text-contains", value: "7-B" },
    { kind: "terminal-stop" },
  ],
};

const MULTI_ACCOUNT_TURNS: ReadonlyArray<string> = [
  MULTI_ACCOUNT_TASK.prompt,
  "Which meeting room did I mention?",
  "And how would that room code look written backwards?",
];

export interface HarnessAccount {
  readonly credential: string;
  readonly accountId: string | undefined;
  readonly label: string | undefined;
}

/** Runs the multi-account task: one session, rotating credentials per turn. */
export async function runMultiAccount(
  adapter: ProviderAdapter,
  candidate: ProviderDispatchTarget,
  buildContext: (account: HarnessAccount) => ProviderDispatchContext,
  accounts: readonly HarnessAccount[],
  reporter: HarnessReporter,
  minGapMs = 3_000,
): Promise<TaskResult> {
  const name = MULTI_ACCOUNT_TASK.name;
  if (accounts.length < 2) {
    const detail = `needs 2+ accounts in --creds (got ${accounts.length}); rotation not exercised`;
    reporter.taskStart(name, detail);
    reporter.check("multi-account rotation", true, detail);
    reporter.taskEnd(name, true);
    return { task: name, pass: true, checks: [{ name: "multi-account rotation", pass: true, detail }], steps: [] };
  }

  reporter.taskStart(name, MULTI_ACCOUNT_TURNS.join(" | "));
  const checks: Array<{ name: string; pass: boolean; detail: string }> = [];
  const conversationId = randomUUID();
  let messages: CanonicalMessage[] = [];
  const answers: string[] = [];

  for (const [index, prompt] of MULTI_ACCOUNT_TURNS.entries()) {
    const account = accounts[index % accounts.length]!;
    reporter.stepStart(index + 1);
    line(`step ${index + 1} — account ${account.label ?? account.accountId ?? "#" + index}`);
    await paceDispatch(minGapMs);
    messages = [...messages, { role: "user", content: [{ kind: "text", text: prompt }] }];
    const request: CanonicalRequest = {
      model: candidate.model_id,
      conversation_id: conversationId,
      messages,
      generation_controls: {},
      stream: true,
      source_surface: "chat",
    };
    let text = "";
    let terminal: { state: string; stopReason: string | undefined } | undefined;
    let error: string | undefined;
    for await (const event of adapter.dispatch(request, candidate, buildContext(account))) {
      if (event.type === "content_delta" && event.content.kind === "text") {
        text += event.content.text;
        reporter.delta(event.content.text);
      } else if (event.type === "terminal") {
        terminal = { state: event.state, stopReason: event.stop_reason };
      } else if (event.type === "error") {
        error = event.message;
      }
    }
    answers.push(text);
    reporter.stepEnd(index + 1, terminal, undefined, error);
    messages = [...messages, { role: "assistant", content: [{ kind: "text", text }] }];
  }

  const recall = answers[1] ?? "";
  const recallPass = recall.includes("B-7");
  checks.push({
    name: "turn 2 (account 2) recalls the room code from turn 1 (account 1)",
    pass: recallPass,
    detail: recallPass ? "found" : `answer: ${JSON.stringify(recall.slice(0, 120))}`,
  });
  reporter.check(checks.at(-1)!.name, recallPass, checks.at(-1)!.detail);

  const reversed = answers[2] ?? "";
  const reversedPass = reversed.includes("7-B");
  checks.push({
    name: "turn 3 recalls and transforms the room code",
    pass: reversedPass,
    detail: reversedPass ? "found" : `answer: ${JSON.stringify(reversed.slice(0, 120))}`,
  });
  reporter.check(checks.at(-1)!.name, reversedPass, checks.at(-1)!.detail);

  const pass = checks.every((check) => check.pass);
  reporter.taskEnd(name, pass);
  return { task: name, pass, checks, steps: [] };
}

// ── the linear-history loop ──

export interface StepRecord {
  readonly step: number;
  readonly text: string;
  readonly calls: ReadonlyArray<{ readonly callId: string; readonly name: string; readonly args: Record<string, unknown> }>;
  readonly results: ReadonlyArray<string>;
  readonly terminal: { readonly state: string; readonly stopReason: string | undefined } | undefined;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number } | undefined;
  readonly error: string | undefined;
}

export interface TaskResult {
  readonly task: string;
  readonly pass: boolean;
  readonly checks: ReadonlyArray<{ readonly name: string; readonly pass: boolean; readonly detail: string }>;
  readonly steps: readonly StepRecord[];
}

interface CollectedStep {
  text: string;
  calls: Array<{ callId: string; name: string; args: Record<string, unknown> }>;
  terminal: { state: string; stopReason: string | undefined } | undefined;
  usage: { inputTokens: number; outputTokens: number } | undefined;
  error: string | undefined;
}

/**
 * Live reporter: every harness event prints as it happens — text deltas
 * stream raw, tool calls appear the moment they surface, results and
 * terminals print per step. The harness is non-blocking to watch: you see a
 * turn in flight, not one summary after the fact.
 */
export interface HarnessReporter {
  taskStart(name: string, prompt: string): void;
  stepStart(step: number): void;
  delta(text: string): void;
  toolCall(step: number, call: { callId: string; name: string; args: Record<string, unknown> }): void;
  toolResult(step: number, name: string, result: string): void;
  stepEnd(step: number, terminal: { state: string; stopReason: string | undefined } | undefined, usage: { inputTokens: number; outputTokens: number } | undefined, error: string | undefined): void;
  check(name: string, pass: boolean, detail: string): void;
  taskEnd(name: string, pass: boolean): void;
}

const reportStart = Date.now();
function stamp(): string {
  return `+${((Date.now() - reportStart) / 1000).toFixed(1)}s`;
}

let sinceDelta = false;
function line(text: string): void {
  if (sinceDelta) console.log();
  sinceDelta = false;
  console.log(`  [${stamp()}] ${text}`);
}

// Same-account cadence pacing: Cursor throttles rapid back-to-back dispatches
// on one account with an opaque resource_exhausted envelope (live-verified —
// a burst of harness turns trips it in seconds). The gateway paces same-
// account dispatches in production; the harness paces itself here.
let lastDispatchAt = 0;

export async function paceDispatch(minGapMs: number): Promise<void> {
  const since = Date.now() - lastDispatchAt;
  if (lastDispatchAt > 0 && since < minGapMs) {
    await new Promise((resolve) => setTimeout(resolve, minGapMs - since));
  }
  lastDispatchAt = Date.now();
}

export const liveReporter: HarnessReporter = {
  taskStart(name, prompt) {
    console.log(`\n== ${name} ==`);
    console.log(`  [${stamp()}] prompt: ${JSON.stringify(prompt.slice(0, 120))}`);
  },
  stepStart(step) {
    line(`step ${step} — dispatching…`);
  },
  delta(text) {
    process.stdout.write(text);
    sinceDelta = true;
  },
  toolCall(step, call) {
    line(`step ${step} ⚙ ${call.name} ${JSON.stringify(call.args)}`);
  },
  toolResult(step, name, result) {
    line(`step ${step} ↳ ${name} → ${JSON.stringify(result.slice(0, 120))}`);
  },
  stepEnd(step, terminal, usage, error) {
    if (error !== undefined) {
      line(`step ${step} ⚠ error: ${error}`);
      return;
    }
    const usageText = usage === undefined ? "" : ` usage in=${usage.inputTokens} out=${usage.outputTokens}`;
    line(`step ${step} ⏹ ${terminal ? `${terminal.state}/${terminal.stopReason ?? "-"}` : "-"}${usageText}`);
  },
  check(name, pass, detail) {
    line(`${pass ? "PASS" : "FAIL"}  ${name} — ${detail}`);
  },
  taskEnd(name, pass) {
    line(`${pass ? "✅ PASS" : "❌ FAIL"} ${name}`);
  },
};

const silentReporter: HarnessReporter = {
  taskStart(): void {},
  stepStart(): void {},
  delta(): void {},
  toolCall(): void {},
  toolResult(): void {},
  stepEnd(): void {},
  check(): void {},
  taskEnd(): void {},
};

/** Consumes one dispatch's event stream into a step record, reporting live. */
async function collectStep(
  adapter: ProviderAdapter,
  request: CanonicalRequest,
  candidate: ProviderDispatchTarget,
  context: ProviderDispatchContext,
  reporter: HarnessReporter,
  step: number,
): Promise<CollectedStep> {
  const collected: CollectedStep = {
    text: "",
    calls: [],
    terminal: undefined,
    usage: undefined,
    error: undefined,
  };
  const openArgs = new Map<string, string>();
  const announced = new Set<string>();
  for await (const event of adapter.dispatch(request, candidate, context)) {
    if (event.type === "content_delta") {
      const part: ContentPart = event.content;
      if (part.kind === "text") {
        collected.text += part.text;
        reporter.delta(part.text);
      }
      continue;
    }
    if (event.type === "tool_call_delta") {
      const buffered = (openArgs.get(event.call_id) ?? "") + (event.arguments_delta ?? "");
      openArgs.set(event.call_id, buffered);
      const existing = collected.calls.find((call) => call.callId === event.call_id);
      if (existing === undefined) {
        collected.calls.push({
          callId: event.call_id,
          name: event.name ?? "",
          args: {},
        });
      } else if (event.name !== undefined) {
        existing.name = event.name;
      }
      continue;
    }
    if (event.type === "usage") {
      collected.usage = { inputTokens: event.usage.input_tokens, outputTokens: event.usage.output_tokens };
      continue;
    }
    if (event.type === "terminal") {
      collected.terminal = { state: event.state, stopReason: event.stop_reason };
      continue;
    }
    if (event.type === "error") {
      collected.error = event.message;
      continue;
    }
  }
  // Arguments deltas are complete once the dispatch ended; parse them here so
  // a malformed argument payload is visible in the trajectory, not swallowed.
  for (const call of collected.calls) {
    const buffered = openArgs.get(call.callId) ?? "";
    try {
      call.args = buffered.length > 0 ? (JSON.parse(buffered) as Record<string, unknown>) : {};
    } catch {
      call.args = { __unparsed: buffered };
    }
    if (!announced.has(call.callId)) {
      announced.add(call.callId);
      reporter.toolCall(step, call);
    }
  }
  return collected;
}

/** Builds the next request's messages after a tool round (linear history). */
function messagesWithToolRound(
  messages: readonly CanonicalMessage[],
  calls: ReadonlyArray<{ callId: string; name: string; args: Record<string, unknown> }>,
  results: ReadonlyArray<string>,
): CanonicalMessage[] {
  return [
    ...messages,
    {
      role: "assistant",
      content: calls.map(
        (call): ContentPart => ({
          kind: "toolCall",
          call_id: call.callId,
          name: call.name,
          arguments: call.args,
        }),
      ),
    },
    {
      role: "tool",
      content: calls.map(
        (call, index): ContentPart => ({
          kind: "toolResult",
          call_id: call.callId,
          content: results[index] ?? "",
        }),
      ),
    },
  ];
}

/** Runs one task to completion: dispatch → answer tools → repeat, linearly. */
export async function runTask(
  task: HarnessTask,
  adapter: ProviderAdapter,
  candidate: ProviderDispatchTarget,
  buildContext: () => ProviderDispatchContext,
  maxSteps: number,
  reporter: HarnessReporter = silentReporter,
  strictParallel = false,
  minGapMs = 3_000,
): Promise<TaskResult> {
  const tools = HARNESS_TOOLS.filter((tool) => task.tools.includes(tool.name));
  // One conversation id per task run: the follow-up turns are continuations of
  // the same conversation, which is what lets a provider resume in-band (for
  // Cursor, the parked run) instead of rebuilding.
  const conversationId = randomUUID();
  let messages: CanonicalMessage[] = [
    { role: "user", content: [{ kind: "text", text: task.prompt }] },
  ];
  const steps: StepRecord[] = [];
  reporter.taskStart(task.name, task.prompt);

  for (let step = 1; step <= maxSteps; step += 1) {
    reporter.stepStart(step);
    await paceDispatch(minGapMs);
    const request: CanonicalRequest = {
      model: candidate.model_id,
      conversation_id: conversationId,
      messages,
      ...(tools.length > 0 ? { tools } : {}),
      generation_controls: {},
      stream: true,
      source_surface: "chat",
    };
    const collected = await collectStep(adapter, request, candidate, buildContext(), reporter, step);
    const results = collected.calls.map((call) => runHarnessTool(call.name, call.args));
    steps.push({
      step,
      text: collected.text,
      calls: collected.calls,
      results,
      terminal: collected.terminal,
      usage: collected.usage,
      error: collected.error,
    });
    for (const [index, call] of collected.calls.entries()) {
      reporter.toolResult(step, call.name, results[index] ?? "");
    }
    reporter.stepEnd(step, collected.terminal, collected.usage, collected.error);
    if (collected.calls.length === 0 || collected.error !== undefined) break;
    messages = messagesWithToolRound(messages, collected.calls, results);
  }

  const last = steps.at(-1);
  const allCalls = steps.flatMap((step) => step.calls);
  const finalText = steps.map((step) => step.text).join("");
  const firstToolStep = steps.find((step) => step.calls.length > 0);

  const checks = task.checks.map((check): { name: string; pass: boolean; detail: string } => {
    switch (check.kind) {
      case "text-contains": {
        const pass = finalText.includes(check.value);
        return { name: `text contains "${check.value}"`, pass, detail: pass ? "found" : `final text: ${finalText.slice(0, 200)}` };
      }
      case "tool-called": {
        const pass = allCalls.some((call) => call.name === check.name);
        return { name: `called ${check.name}`, pass, detail: pass ? "called" : `calls seen: ${allCalls.map((c) => c.name).join(", ") || "none"}` };
      }
      case "tool-called-with": {
        const call = allCalls.find((entry) => entry.name === check.name);
        const pass = call !== undefined && JSON.stringify(call.args) === JSON.stringify(check.args);
        return {
          name: `called ${check.name} with exact args`,
          pass,
          detail: call === undefined ? "never called" : `args: ${JSON.stringify(call.args)}`,
        };
      }
      case "calls-together": {
        const inOneStep =
          firstToolStep !== undefined && check.names.every((name) => firstToolStep.calls.some((call) => call.name === name));
        return {
          name: `${strictParallel ? "parallel" : "INFO   parallel"} — ${check.names.join(" + ")} in one step`,
          pass: strictParallel ? inOneStep : true,
          detail: inOneStep
            ? `yes (step ${firstToolStep?.step})`
            : firstToolStep === undefined
              ? "no tool steps"
              : `no — the model sequenced them: ${steps.filter((s) => s.calls.length > 0).map((s) => `${s.step}[${s.calls.map((c) => c.name).join(",")}]`).join(" ")}`,
        };
      }
      case "terminal-stop": {
        const pass = last?.terminal?.state === "complete" && last?.terminal?.stopReason === "stop";
        return {
          name: "terminal complete/stop",
          pass,
          detail: last?.terminal === undefined ? "no terminal" : `${last.terminal.state}/${last.terminal.stopReason ?? "-"}`,
        };
      }
    }
  });
  for (const check of checks) reporter.check(check.name, check.pass, check.detail);
  const pass = checks.every((check) => check.pass);
  reporter.taskEnd(task.name, pass);

  return { task: task.name, pass, checks, steps };
}

// ── CLI ──

/** Every account the harness may use: one for most tasks, all of them for multi-account rotation. */
function resolveAccounts(): HarnessAccount[] {
  const v = args.values;
  const direct = v.token?.trim() ?? "";
  if (direct.length > 0) return [{ credential: direct, accountId: undefined, label: undefined }];
  if (!v.creds) throw new Error("pass --token <jwt> or --creds <accounts.json>");
  const accounts = readAccountsFile(v.creds!);
  const scoped = accounts.filter((account) => {
    if (v.label !== undefined) return account.label === v.label;
    if (v.index !== undefined) return accounts.indexOf(account) === Number(v.index);
    return account.providerId === undefined || account.providerId === args.values.provider;
  });
  const usable = scoped.filter((account) => typeof account.accessToken === "string" && account.accessToken!.trim().length > 0);
  if (usable.length === 0) throw new Error(`no accounts with an accessToken in ${v.creds!}`);
  return usable.map((account) => ({
    credential: account.accessToken!.trim(),
    accountId: account.id ?? account.label,
    label: account.label,
  }));
}

const args = parseArgs({
  options: {
    provider: { type: "string", default: "cursor" },
    model: { type: "string" },
    creds: { type: "string" },
    token: { type: "string" },
    label: { type: "string" },
    index: { type: "string" },
    task: { type: "string" },
    steps: { type: "string", default: "5" },
    timeout: { type: "string", default: "90000" },
    "strict-parallel": { type: "boolean", default: false },
    "min-gap-ms": { type: "string", default: "3000" },
    json: { type: "boolean", default: false },
  },
});

async function main(): Promise<void> {
  const v = args.values;
  const providerId = parseProviderId(v.provider!);
  const module = BUNDLED_PROVIDER_MODULES.find((entry) => entry.id === providerId);
  if (module === undefined) throw new Error(`unknown bundled provider: ${providerId}`);
  const accounts = resolveAccounts();
  console.log(
    `provider=${providerId} model=${v.model ?? "(provider default)"} accounts=${accounts.length} token=${maskSecret(accounts[0]!.credential)}`,
  );

  const registry = createDefaultProviderRegistry();
  const adapter = await registry.resolve(providerId);
  if (adapter === undefined) throw new Error(`adapter did not load for ${providerId}`);

  // Model identity: the bundled catalog for the endpoint/family; a model the
  // catalog does not list still runs (discovery-backed rosters resolve it).
  const models = (await module.loadModels?.()) ?? [];
  const row = v.model !== undefined ? models.find((entry) => entry.modelId === v.model) : undefined;
  const modelId = row?.modelId ?? v.model ?? models[0]?.modelId;
  if (modelId === undefined) throw new Error("no model id: pass --model or ship a catalog");
  const wireFamily = row?.wireFamily ?? module.wireFamilyDefault ?? "chat";
  const endpointPath = row?.endpointPath ?? module.endpointPathsByWireFamily?.[wireFamily] ?? "";
  const candidate: ProviderDispatchTarget = {
    provider_id: providerId,
    model_id: modelId,
    wire_family: wireFamily,
    endpoint_path: endpointPath,
    capabilities: {},
  };

  const factory = new ValidatedNetworkBindingFactory(resolveSsrfPolicy());
  const timeoutMs = Number(v.timeout);
  const buildContext = (account: HarnessAccount): ProviderDispatchContext => ({
    credential: {
      provider_id: providerId,
      account_id: account.accountId,
      credential_kind: "api_key",
      secret: new TextEncoder().encode(account.credential),
    },
    deadline: Date.now() + timeoutMs,
    abort_signal: AbortSignal.timeout(timeoutMs),
    outbound_fetch: factory.fetch(),
    outbound_http2: factory.http2Bidi(),
  });

  const maxSteps = Number(v.steps);
  const wanted = v.task
    ?.split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  // `all` = every suite: canonical tasks, multi-account rotation, and both
  // surface matrices (chat + tools on every caller dialect).
  const includeMultiAccount = wanted === undefined || wanted.includes("all") || wanted.includes("multi-account");
  const includeSurfaces =
    wanted === undefined || wanted.includes("all") || wanted.includes("chat-surfaces") || wanted.includes("tools-surfaces");
  const selected =
    wanted === undefined || wanted.length === 0
      ? HARNESS_TASKS
      : wanted.includes("all")
        ? HARNESS_TASKS
        : HARNESS_TASKS.filter((task) => wanted.includes(task.name));
  if (selected.length === 0 && !includeSurfaces && !includeMultiAccount) {
    throw new Error(
      `unknown task: ${v.task} (known: ${HARNESS_TASKS.map((t) => t.name).join(", ")}, multi-account, chat-surfaces, tools-surfaces, all)`,
    );
  }

  const reporter = v.json === true ? silentReporter : liveReporter;

  const results: TaskResult[] = [];
  for (const task of selected) {
    const result = await runTask(task, adapter, candidate, () => buildContext(accounts[0]!), maxSteps, reporter, v["strict-parallel"] === true, Number(v["min-gap-ms"]));
    results.push(result);
  }
  if (includeMultiAccount) {
    results.push(await runMultiAccount(adapter, candidate, buildContext, accounts, reporter, Number(v["min-gap-ms"])));
  }
  if (includeSurfaces) {
    const deps = { adapter, candidate, buildContext: () => buildContext(accounts[0]!), reporter, minGapMs: Number(v["min-gap-ms"]) };
    if (wanted === undefined || wanted.includes("all") || wanted.includes("chat-surfaces")) {
      results.push(await runChatSurfaces(deps, modelId));
    }
    if (wanted === undefined || wanted.includes("all") || wanted.includes("tools-surfaces")) {
      results.push(await runToolsSurfaces(deps, modelId));
    }
  }

  const passed = results.filter((result) => result.pass).length;
  if (v.json === true) {
    console.log(
      JSON.stringify(
        {
          provider: providerId,
          model: modelId,
          passed,
          total: results.length,
          results: results.map((result) => ({
            task: result.task,
            pass: result.pass,
            checks: result.checks,
            steps: result.steps,
          })),
        },
        null,
        2,
      ),
    );
  } else {
    console.log(`\n${passed}/${results.length} tasks passed (${providerId}, model ${modelId})`);
  }
  if (passed !== results.length) process.exit(1);
}

main().catch((error) => {
  console.error(`harness failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
