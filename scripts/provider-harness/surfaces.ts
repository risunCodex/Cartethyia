/**
 * Protocol-translation tasks: the same chat and tool flows exercised through
 * every caller-facing surface dialect.
 *
 * The harness normally speaks CanonicalRequest directly — these tasks do NOT:
 * each turn is built as a surface-native body (OpenAI Chat Completions,
 * OpenAI Responses, Anthropic Messages, legacy Completions), parsed through
 * that surface's real ingress adapter into canonical form, dispatched through
 * the provider adapter, and the canonical events are re-encoded through the
 * surface's real egress encoder. Assertions read the **native** output — the
 * caller's own dialect — so a translation defect shows up as a missing field,
 * not as an adapter failure.
 *
 * The conversation session is reused: each surface runs three turns on one
 * session id with three DIFFERENT triggers (set → recall → transform), so
 * context reuse is proven by the answers, not by identical prompts.
 *
 * Gemini has no caller-facing ingress surface (it exists only as an upstream
 * wire in `src/protocol/{request,response}/gemini.ts`), so it is not part of
 * this matrix.
 */
import type {
  CanonicalEvent,
  CanonicalRequest,
} from "../../src/protocol/canonical-model";
import type {
  ProviderAdapter,
  ProviderDispatchContext,
  ProviderDispatchTarget,
} from "../../src/providers/provider-contracts";
import { chatAdapter } from "../../src/transport/surface/chat/adapter";
import { messagesAdapter } from "../../src/transport/surface/messages/adapter";
import { responsesAdapter } from "../../src/transport/surface/responses/adapter";
import { completionAdapter } from "../../src/transport/surface/completion";
import { paceDispatch, type HarnessReporter, type TaskResult } from "./run";

/** The tool the surface tool round-trip declares, in each dialect's schema. */
const TOOL_NAME = "harness_get_weather";
const TOOL_PROMPT = `Could you check the weather in Tokyo with your weather tool? I only need the temperature it reports.`;
const TOOL_RESULT = "Weather in Tokyo: 21C, sunny";

type Record_ = Record<string, unknown>;

// ── native dialect builders + readers ──

interface SurfaceSpec {
  readonly name: string;
  /** Builds one chat turn's native body from the prior transcript. */
  chatTurn(model: string, history: ReadonlyArray<{ role: string; text: string }>): Record_;
  /** Builds one tool round's native bodies (call, then result turn). */
  toolTurn(model: string): { call: Record_; resultTurn: (nativeCall: Record_) => Record_ };
  /** Joins every text the surface's native output carries. */
  nativeText(encoded: unknown): string;
  /** Reads the first tool call out of the surface's native output, if any. */
  nativeToolCall(encoded: unknown): { name: string; args: Record<string, unknown> } | undefined;
  readonly supportsTools: boolean;
  /** Stateless dialects chain their own context: each turn gets a fresh session. */
  readonly statelessSession?: boolean;
}

function isRecord_(value: unknown): value is Record_ {
  return typeof value === "object" && value !== null;
}

function joinBlocks(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((item) =>
      isRecord_(item) && typeof item["text"] === "string" && (item["type"] === "text" || item["type"] === "output_text")
        ? (item["text"] as string)
        : "",
    )
    .join("");
}

const WEATHER_SCHEMA: Record_ = {
  type: "object",
  properties: { city: { type: "string" } },
  required: ["city"],
};

const SURFACES: readonly SurfaceSpec[] = [
  {
    name: "chat",
    supportsTools: true,
    chatTurn: (model, history) => ({
      model,
      stream: true,
      messages: history.map((entry) => ({ role: entry.role, content: entry.text })),
    }),
    toolTurn: (model) => ({
      call: {
        model,
        stream: true,
        messages: [{ role: "user", content: TOOL_PROMPT }],
        tools: [{ type: "function", function: { name: TOOL_NAME, description: "Returns the weather for a city.", parameters: WEATHER_SCHEMA } }],
        tool_choice: "auto",
      },
      resultTurn: (nativeCall) => ({
        model,
        stream: true,
        messages: [
          { role: "user", content: TOOL_PROMPT },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: String(nativeCall["id"] ?? "call-harness"),
                type: "function",
                function: { name: TOOL_NAME, arguments: JSON.stringify(nativeCall["args"] ?? {}) },
              },
            ],
          },
          { role: "tool", tool_call_id: String(nativeCall["id"] ?? "call-harness"), content: TOOL_RESULT },
        ],
        tools: [{ type: "function", function: { name: TOOL_NAME, description: "Returns the weather for a city.", parameters: WEATHER_SCHEMA } }],
      }),
    }),
    nativeText: (encoded) => {
      const body = isRecord_(encoded) ? encoded : {};
      const choices = Array.isArray(body["choices"]) ? body["choices"] : [];
      const first = choices[0];
      if (!isRecord_(first)) return "";
      // chat completions carry the answer at message.content; legacy text
      // completions carry choices[0].text.
      const message = isRecord_(first["message"]) ? first["message"] : {};
      return joinBlocks(message["content"] ?? first["text"]);
    },
    nativeToolCall: (encoded) => {
      const body = isRecord_(encoded) ? encoded : {};
      const choices = Array.isArray(body["choices"]) ? body["choices"] : [];
      const message = isRecord_(choices[0]) && isRecord_((choices[0] as Record_)["message"]) ? ((choices[0] as Record_)["message"] as Record_) : {};
      const calls = Array.isArray(message["tool_calls"]) ? message["tool_calls"] : [];
      const call = calls.find((item) => isRecord_(item) && isRecord_((item as Record_)["function"]));
      if (!isRecord_(call)) return undefined;
      const fn = call["function"] as Record_;
      let args: Record<string, unknown> = {};
      try {
        args = typeof fn["arguments"] === "string" ? (JSON.parse(fn["arguments"] as string) as Record<string, unknown>) : {};
      } catch {
        args = {};
      }
      return { name: String(fn["name"] ?? ""), args };
    },
  },
  {
    name: "messages",
    supportsTools: true,
    chatTurn: (model, history) => ({
      model,
      max_tokens: 512,
      stream: true,
      messages: history.map((entry) => ({ role: entry.role, content: [{ type: "text", text: entry.text }] })),
    }),
    toolTurn: (model) => ({
      call: {
        model,
        max_tokens: 512,
        stream: true,
        messages: [{ role: "user", content: [{ type: "text", text: TOOL_PROMPT }] }],
        tools: [{ name: TOOL_NAME, description: "Returns the weather for a city.", input_schema: WEATHER_SCHEMA }],
      },
      resultTurn: (nativeCall) => ({
        model,
        max_tokens: 512,
        stream: true,
        messages: [
          { role: "user", content: [{ type: "text", text: TOOL_PROMPT }] },
          {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: String(nativeCall["id"] ?? "toolu-harness"),
                name: TOOL_NAME,
                input: nativeCall["args"] ?? {},
              },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: String(nativeCall["id"] ?? "toolu-harness"),
                content: TOOL_RESULT,
              },
            ],
          },
        ],
        tools: [{ name: TOOL_NAME, description: "Returns the weather for a city.", input_schema: WEATHER_SCHEMA }],
      }),
    }),
    nativeText: (encoded) => joinBlocks(isRecord_(encoded) ? encoded["content"] : undefined),
    nativeToolCall: (encoded) => {
      const body = isRecord_(encoded) ? encoded : {};
      const content = Array.isArray(body["content"]) ? body["content"] : [];
      const use = content.find((item) => isRecord_(item) && item["type"] === "tool_use");
      if (!isRecord_(use)) return undefined;
      return { name: String(use["name"] ?? ""), args: isRecord_(use["input"]) ? (use["input"] as Record_) : {} };
    },
  },
  {
    name: "responses",
    supportsTools: true,
    chatTurn: (model, history) => ({
      model,
      stream: true,
      input: history.map((entry) => ({
        role: entry.role,
        content: [{ type: entry.role === "user" ? "input_text" : "output_text", text: entry.text }],
      })),
    }),
    toolTurn: (model) => ({
      call: {
        model,
        stream: true,
        input: [{ role: "user", content: [{ type: "input_text", text: TOOL_PROMPT }] }],
        tools: [{ type: "function", name: TOOL_NAME, description: "Returns the weather for a city.", parameters: WEATHER_SCHEMA }],
      },
      resultTurn: (nativeCall) => ({
        model,
        stream: true,
        input: [
          { role: "user", content: [{ type: "input_text", text: TOOL_PROMPT }] },
          {
            type: "function_call",
            call_id: String(nativeCall["call_id"] ?? nativeCall["id"] ?? "fc-harness"),
            name: TOOL_NAME,
            arguments: JSON.stringify(nativeCall["args"] ?? {}),
          },
          {
            type: "function_call_output",
            call_id: String(nativeCall["call_id"] ?? nativeCall["id"] ?? "fc-harness"),
            output: TOOL_RESULT,
          },
        ],
        tools: [{ type: "function", name: TOOL_NAME, description: "Returns the weather for a city.", parameters: WEATHER_SCHEMA }],
      }),
    }),
    nativeText: (encoded) => {
      const body = isRecord_(encoded) ? encoded : {};
      const output = Array.isArray(body["output"]) ? body["output"] : [];
      return output
        .map((item) => (isRecord_(item) && item["type"] === "message" ? joinBlocks(item["content"]) : ""))
        .join("");
    },
    nativeToolCall: (encoded) => {
      const body = isRecord_(encoded) ? encoded : {};
      const output = Array.isArray(body["output"]) ? body["output"] : [];
      const call = output.find((item) => isRecord_(item) && item["type"] === "function_call");
      if (!isRecord_(call)) return undefined;
      let args: Record<string, unknown> = {};
      try {
        args = typeof call["arguments"] === "string" ? (JSON.parse(call["arguments"] as string) as Record<string, unknown>) : {};
      } catch {
        args = {};
      }
      return { name: String(call["name"] ?? ""), args };
    },
  },
  {
    name: "completion",
    supportsTools: false,
    // The transcript chain IS the context — reusing a server-side session on
    // top of it duplicates the exchange and the model goes silent on the next
    // turn (live-verified). Statelessness is the dialect's contract.
    statelessSession: true,
    chatTurn: (model, history) => ({
      model,
      stream: true,
      // Legacy completions are stateless text: the caller chains the prior
      // transcript into the prompt — the dialect's own continuation idiom.
      // The trailing "Assistant:" cue is deliberately omitted: a chat-backed
      // provider answers it with an empty completion (live-verified), while
      // the transcript alone carries the turn-taking.
      prompt: history.map((entry) => `${entry.role === "user" ? "User" : "Assistant"}: ${entry.text}`).join("\n"),
    }),
    toolTurn: (_model) => ({ call: {}, resultTurn: () => ({}) }),
    nativeText: (encoded) => {
      const body = isRecord_(encoded) ? encoded : {};
      const choices = Array.isArray(body["choices"]) ? body["choices"] : [];
      const first = choices[0];
      return isRecord_(first) && typeof first["text"] === "string" ? first["text"] : "";
    },
    nativeToolCall: () => undefined,
  },
];

// ── the flow ──

interface SurfaceFlowDeps {
  readonly adapter: ProviderAdapter;
  readonly candidate: ProviderDispatchTarget;
  readonly buildContext: () => ProviderDispatchContext;
  readonly reporter: HarnessReporter;
  readonly minGapMs: number;
}

/** One turn: native body → ingress parse → dispatch → egress encode → native JSON. */
async function surfaceTurn(
  surface: SurfaceSpec,
  nativeBody: Record_,
  deps: SurfaceFlowDeps,
  sessionId: string,
): Promise<{ native: Record_; events: CanonicalEvent[] }> {
  await paceDispatch(deps.minGapMs);
  const parsed: CanonicalRequest = (surface.name === "chat"
    ? chatAdapter
    : surface.name === "messages"
      ? messagesAdapter
      : surface.name === "responses"
        ? responsesAdapter
        : completionAdapter
  ).parse(nativeBody);
  parsed.model = deps.candidate.model_id;
  parsed.conversation_id = sessionId;

  const events: CanonicalEvent[] = [];
  for await (const event of deps.adapter.dispatch(parsed, deps.candidate, deps.buildContext())) {
    events.push(event);
    if (event.type === "content_delta" && event.content.kind === "text") deps.reporter.delta(event.content.text);
  }
  const encoder =
    surface.name === "chat"
      ? chatAdapter.encode(events, { model: deps.candidate.model_id })
      : surface.name === "messages"
        ? messagesAdapter.encodeOutput(events, { model: deps.candidate.model_id })
        : surface.name === "responses"
          ? responsesAdapter.encodeOutput(events, { model: deps.candidate.model_id })
          : completionAdapter.encodeOutput(events, { model: deps.candidate.model_id });
  const native = JSON.parse(new TextDecoder().decode(encoder.bytes)) as Record_;
  return { native, events };
}

const CHAT_TURNS: ReadonlyArray<{ role: string; text: string }> = [
  { role: "user", text: "Quick note: the meeting room for tomorrow is B-7. Just acknowledge, please." },
  { role: "user", text: "Which meeting room did I mention?" },
  { role: "user", text: "And how would that room code look written backwards?" },
];

const CHAT_EXPECTATIONS: ReadonlyArray<{ readonly turn: number; readonly contains: string }> = [
  { turn: 2, contains: "B-7" },
  { turn: 3, contains: "7-B" },
];

/** Chat on every surface: one session per surface, three turns, three triggers. */
export async function runChatSurfaces(deps: SurfaceFlowDeps, modelId: string): Promise<TaskResult> {
  const checks: Array<{ name: string; pass: boolean; detail: string }> = [];
  for (const surface of SURFACES) {
    deps.reporter.taskStart(`chat-surfaces/${surface.name}`, CHAT_TURNS.map((t) => t.text).join(" | "));
    const sessionId = `harness-chat-${surface.name}-${crypto.randomUUID()}`;
    const history: Array<{ role: string; text: string }> = [];
    for (const [index, turn] of CHAT_TURNS.entries()) {
      deps.reporter.stepStart(index + 1);
      history.push({ role: "user", text: turn.text });
      const session = surface.statelessSession === true ? `harness-chat-${surface.name}-${crypto.randomUUID()}` : sessionId;
      const { native } = await surfaceTurn(surface, surface.chatTurn(modelId, history), deps, session);
      const text = surface.nativeText(native);
      history.push({ role: "assistant", text });
      deps.reporter.stepEnd(index + 1, { state: "complete", stopReason: "stop" }, undefined, undefined);
    }
    for (const expectation of CHAT_EXPECTATIONS) {
      const assistantText = history[expectation.turn * 2 - 1]?.text ?? "";
      const pass = assistantText.includes(expectation.contains);
      checks.push({
        name: `${surface.name} turn ${expectation.turn}: contains "${expectation.contains}" (native output)`,
        pass,
        detail: pass ? "found" : `native text: ${JSON.stringify(assistantText.slice(0, 120))}`,
      });
      deps.reporter.check(checks.at(-1)!.name, pass, checks.at(-1)!.detail);
    }
    const surfacePass = checks.slice(-CHAT_EXPECTATIONS.length).every((check) => check.pass);
    deps.reporter.taskEnd(`chat-surfaces/${surface.name}`, surfacePass);
  }
  return { task: "chat-surfaces", pass: checks.every((check) => check.pass), checks, steps: [] };
}

/** Tool round-trip in each tool-capable dialect: call extracted from native output, result fed back native. */
export async function runToolsSurfaces(deps: SurfaceFlowDeps, modelId: string): Promise<TaskResult> {
  const checks: Array<{ name: string; pass: boolean; detail: string }> = [];
  for (const surface of SURFACES.filter((entry) => entry.supportsTools)) {
    deps.reporter.taskStart(`tools-surfaces/${surface.name}`, TOOL_PROMPT);
    const sessionId = `harness-tools-${surface.name}-${crypto.randomUUID()}`;

    const callTurn = await surfaceTurn(surface, surface.toolTurn(modelId).call, deps, sessionId);
    const nativeCall = surface.nativeToolCall(callTurn.native);
    const callPass = nativeCall !== undefined && nativeCall.name === TOOL_NAME;
    checks.push({
      name: `${surface.name}: tool call surfaces natively (${TOOL_NAME})`,
      pass: callPass,
      detail: callPass ? `args: ${JSON.stringify(nativeCall?.args)}` : `native output had no ${TOOL_NAME} call`,
    });
    deps.reporter.check(checks.at(-1)!.name, callPass, checks.at(-1)!.detail);

    const resultNative = await surfaceTurn(surface, surface.toolTurn(modelId).resultTurn(nativeCall ?? {}), deps, sessionId);
    const text = surface.nativeText(resultNative.native);
    const resultPass = text.includes("21");
    checks.push({
      name: `${surface.name}: final answer carries the tool result (native output)`,
      pass: resultPass,
      detail: resultPass ? "found 21" : `native text: ${JSON.stringify(text.slice(0, 120))}`,
    });
    deps.reporter.check(checks.at(-1)!.name, resultPass, checks.at(-1)!.detail);
    deps.reporter.taskEnd(`tools-surfaces/${surface.name}`, callPass && resultPass);
  }
  return { task: "tools-surfaces", pass: checks.every((check) => check.pass), checks, steps: [] };
}
