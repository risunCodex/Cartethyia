/**
 * Qoder gRPC transport — `model.chat.ChatService/ChatCompletionStream`.
 *
 * This is the only proven surface for real 1M-token context: the HTTP IDE
 * surface caps at ~256 KiB (~60K tokens), while gRPC accepts bodies up to
 * ~5.5M–6M chars (~1.3M–1.4M tokens) — verified live 2026-11-05, see
 * `documentation/research/qoder/live/2026-11-05-qoder-payload-limits.md`.
 *
 * gRPC only serves billed models: a free-tier row (`lite`) answers
 * `quota exceeded` (116) on this surface, so free-tier dispatch must use the
 * legacy COSY surface instead (see `qoder-adapter.ts` transport selection).
 *
 * The proto is vendored at `vendor/qoder-proto/chat.proto` (from the unpacked
 * desktop client, version 1.1.81, `qoder-worker-runtime.mjs`).
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { GatewayError } from "../../../protocol/gateway-error";
import type { CanonicalEvent, CanonicalRequest, CanonicalStopReason, UsageRecord } from "../../../protocol/canonical-model";
import type { ProviderCaptureExchange } from "../../provider-contracts";
import { usageFromProvider } from "../../provider-usage";
import { getQoderVersion } from "../../operations/client-versions";
import { qoderMachineOs, qoderMachineHostname } from "../../operations/cli-platform";
import { qoderSessionId } from "./qoder-auth";
import { flattenCanonicalContent } from "./qoder-body";
import { qoderGrpcHost } from "./qoder-realm";
import type { QoderAuth, QoderRealm } from "./qoder-types";
// The proto is embedded as a generated TS source (see `chat-proto.ts`), so
// the gRPC surface works from source, dist, and the standalone binary alike —
// the proto loader only reads from a path, so the string is materialized once
// to a temp file per process.
import { CHAT_PROTO_SOURCE } from "./chat-proto";

const PROTO_PATH = materializeChatProto();

function materializeChatProto(): string {
  const dir = mkdtempSync(join(tmpdir(), "cartethyia-qoder-grpc-"));
  const path = join(dir, "chat.proto");
  writeFileSync(path, CHAT_PROTO_SOURCE);
  // Best-effort cleanup; a leftover temp file is harmless but avoid keeping it.
  process.on("exit", () => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });
  return path;
}

let packageDefinitionCache: ReturnType<typeof protoLoader.loadSync> | null = null;
let grpcClientCache: any = null;

function loadProtoDefinition() {
  if (packageDefinitionCache === null) {
    packageDefinitionCache = protoLoader.loadSync(PROTO_PATH, {
      keepCase: true,
      longs: String,
      enums: String,
      defaults: false,
      oneofs: true,
    });
  }
  return packageDefinitionCache;
}

/** Loads (once) the gRPC service client. */
export function qoderGrpcClient(): any {
  if (grpcClientCache !== null) return grpcClientCache;
  const proto = grpc.loadPackageDefinition(loadProtoDefinition()) as Record<string, any>;
  const model = proto.model as Record<string, any> | undefined;
  grpcClientCache = model?.chat?.ChatService;
  if (grpcClientCache === undefined) {
    throw new Error("Qoder gRPC proto did not resolve model.chat.ChatService");
  }
  return grpcClientCache;
}

/**
 * Channel options for the Qoder gRPC surface — mirrors the desktop client
 * (`NDl` in the unpacked worker): disable HTTP proxy, pin the authority /
 * SSL target name to the model-server host, and raise the message length
 * limits to 32 MiB. grpc-js defaults to a 4 MiB receive cap, which aborts
 * large streams that the upstream serves fine.
 */
export function qoderGrpcChannelOptions(host: string): Record<string, number | string> {
  return {
    "grpc.enable_http_proxy": 0,
    "grpc.default_authority": host,
    "grpc.ssl_target_name_override": host,
    "grpc.max_receive_message_length": 32 * 1024 * 1024,
    "grpc.max_send_message_length": 32 * 1024 * 1024,
  };
}

/** Maps one canonical message onto the proto `ChatMessage` shape. */
function mapMessage(message: CanonicalRequest["messages"][number]): Record<string, unknown> {
  const text = flattenCanonicalContent(message.content);
  const out: Record<string, unknown> = { role: message.role };
  if (text.length > 0) out.text_content = text;
  return out;
}

/**
 * Maps one already-translated OpenAI-shaped message (from `buildQoderRequest`)
 * onto the proto `ChatMessage` shape — including structured tool history.
 *
 * The gRPC surface is a protobuf mirror of the same OpenAI-shaped body the
 * HTTP IDE surface sends, so the structured transcript (assistant
 * `tool_calls`, `tool` result turns) is mapped field-for-field instead of
 * being flattened to text.
 */
function toProtoChatMessage(msg: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { role: msg["role"] };
  const content = msg["content"];
  if (typeof content === "string" && content.length > 0) out.text_content = content;
  const toolCalls = msg["tool_calls"];
  if (Array.isArray(toolCalls) && toolCalls.length > 0) {
    out.tool_calls = toolCalls.map((tc) => {
      const fn = (tc?.["function"] ?? {}) as Record<string, unknown>;
      const callId = tc?.["call_id"];
      const call = {
        id: typeof tc["id"] === "string" && (tc["id"] as string).length > 0
          ? { value: tc["id"] }
          : undefined,
        // The desktop client's `jDl` also carries `call_id` (StringValue)
        // when the source message has one — preserve it for full tool-turn
        // fidelity.
        call_id: typeof callId === "string" && (callId as string).length > 0
          ? { value: callId }
          : undefined,
        // `arguments` is a `google.protobuf.Value`; a JSON string maps to
        // `{ stringValue: … }` (camelCase), matching the client's `Qat()`.
        type: { value: "function" },
        function: {
          name: typeof fn["name"] === "string" ? (fn["name"] as string) : "",
          arguments: {
            stringValue:
              typeof fn["arguments"] === "string"
                ? (fn["arguments"] as string)
                : fn["arguments"] !== undefined && fn["arguments"] !== null
                  ? JSON.stringify(fn["arguments"])
                  : "",
          },
        },
      };
      const outCall: Record<string, unknown> = {};
      if (call.id !== undefined) outCall.id = call.id;
      if (call.call_id !== undefined) outCall.call_id = call.call_id;
      outCall.type = call.type;
      outCall.function = call.function;
      return outCall;
    });
  }
  const toolCallId = msg["tool_call_id"];
  if (typeof toolCallId === "string" && toolCallId.length > 0) {
    out.tool_call_id = { value: toolCallId };
  }
  const reasoning = msg["reasoning_content"];
  if (typeof reasoning === "string" && reasoning.length > 0) {
    out.reasoning_content = { value: reasoning };
  }
  return out;
}

/**
 * Converts a plain JSON value into a `google.protobuf.Value` wire shape —
 * mirroring the desktop client's `Qat()` helper. A JSON object becomes a
 * `Struct` (`{ fields: Map<string, Value> }`), arrays become `listValue`,
 * scalars map to `stringValue`/`numberValue`/`boolValue`/`nullValue`.
 */
function toProtoValue(value: unknown): Record<string, unknown> {
  if (value === null || value === undefined) return { nullValue: 0 };
  if (typeof value === "number") return { numberValue: value };
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { boolValue: value };
  if (Array.isArray(value)) return { listValue: { values: value.map(toProtoValue) } };
  if (typeof value === "object") {
    const fields: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) fields[k] = toProtoValue(v);
    return { structValue: { fields } };
  }
  return { stringValue: String(value) };
}

/**
 * Converts a plain JSON object into a `google.protobuf.Struct` wire shape —
 * the desktop client's `oBA()` helper. Struct fields must be wrapped as
 * `Value`s, not forwarded raw; a raw JSON object inside a Struct is rejected
 * at serialization time ("object expected").
 */
function toProtoStruct(obj: Record<string, unknown>): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) fields[k] = toProtoValue(v);
  return { fields };
}

/**
 * Converts a decoded `google.protobuf.Value` back to a plain JS value — the
 * inverse of {@link toProtoValue}. The tagged union key (`stringValue`,
 * `numberValue`, `boolValue`, `nullValue`, `structValue`, `listValue`) picks
 * the payload; `kind` is metadata and ignored.
 */
function fromProtoValue(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return value;
  const v = value as Record<string, unknown>;
  if ("stringValue" in v) return v.stringValue;
  if ("numberValue" in v) return v.numberValue;
  if ("boolValue" in v) return v.boolValue;
  if ("nullValue" in v) return null;
  if ("structValue" in v) return fromProtoStruct(v.structValue);
  if ("listValue" in v) {
    const inner = v.listValue as Record<string, unknown> | undefined;
    const values = inner?.values;
    return Array.isArray(values) ? values.map(fromProtoValue) : [];
  }
  return undefined;
}

/**
 * Converts a decoded `google.protobuf.Struct` back to a plain JS object — the
 * inverse of {@link toProtoStruct}. The upstream gRPC response carries
 * `delta.tool_calls` as repeated Structs, and each element's fields are
 * `Value` tagged unions (not raw JSON).
 */
export function fromProtoStruct(struct: unknown): Record<string, unknown> {
  if (typeof struct !== "object" || struct === null) return {};
  const fields = (struct as Record<string, unknown>).fields;
  if (typeof fields !== "object" || fields === null) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields as Record<string, unknown>)) {
    const decoded = fromProtoValue(v);
    if (decoded !== undefined) out[k] = decoded;
  }
  return out;
}

/** One decoded `delta.tool_calls` element, in the shape the mapper consumes. */
export interface QoderProtoToolFragment {
  /** Trimmed declared call id, or undefined when the delta omits it. */
  readonly id?: string;
  /** Wire `index` (0-based), or undefined when omitted. */
  readonly index?: number;
  /** Trimmed tool name, or undefined on continuation chunks. */
  readonly name?: string;
  /** Raw argument fragment string, or undefined when the delta has none. */
  readonly args?: string;
}

/** A tool-call delta ready to become a canonical event (donor `$Dl` mirror). */
export interface QoderDrainedToolCall {
  readonly callId: string;
  readonly index: number;
  readonly name: string | undefined;
  readonly arguments: string;
}

/**
 * Maps a decoded `delta.tool_calls` element to a canonical `tool_call_delta`
 * exactly like the donor's `$Dl` — pass-through: `id`, `index`, `name`, and
 * the raw `arguments` string fragment are forwarded as received, with no
 * buffering, splitting, or JSON repair. The client stitches fragments by
 * `index`/`id` itself (mirroring the donor's StreamAdapter `vTe`, which only
 * tracks args for state and forwards each `partial_json` fragment verbatim).
 */
export class QoderToolCallBuffer {
  /** Consume one decoded tool-call delta element and emit its canonical event. */
  consume(frag: QoderProtoToolFragment): QoderDrainedToolCall {
    const { id, index, name, args } = frag;
    const callId = id ?? (index !== undefined ? `call_${String(index)}` : `call_anon`);
    return {
      callId,
      index: index ?? 0,
      name,
      arguments: args ?? "",
    };
  }
}

/** Stitching state for continuation fragments (per-stream). */
export interface QoderToolFragmentState {
  /**
   * The call id of the most recently announced tool call. Continuation
   * fragments (which echo `id: ""` and a non-distinct `index: 0`) attach to
   * this call — verified live (2026-11-05): upstream announces one call at a
   * time (`id` + empty args), then streams that call's arguments as several
   * small fragments before announcing the next call. The index is always 0,
   * so it cannot distinguish calls.
   */
  lastSeenToolId?: string;
}

/**
 * Resolves the call id for one wire fragment.
 *
 * - A fragment carrying a real `id` announces a (new) tool call: it becomes
 *   the current active call and is returned.
 * - A continuation fragment (`id: ""`) belongs to the current active call —
 *   the upstream streams arguments in fragments right after the announce, and
 *   each parallel call's argument fragments arrive before the next announce.
 *
 * Without this, each continuation gets a fresh fallback id and the client
 * sees an empty-arguments call plus orphaned fragments (regression found live
 * 2026-11-05 via opencode→CarteLocal).
 */
export function resolveQoderToolFragmentId(
  state: QoderToolFragmentState,
  declaredId: string | undefined,
): string | undefined {
  if (declaredId !== undefined && declaredId.length > 0) {
    state.lastSeenToolId = declaredId;
    return declaredId;
  }
  return state.lastSeenToolId;
}

/**
 * Maps the shared OpenAI-shaped `tools` array (from `qoderTools`) onto the
 * proto `Tool` shape — field-for-field matching the desktop client's `YDl()`
 * mapper.
 *
 * Wrapper-typed fields (`StringValue description`, `BoolValue strict`) are
 * sent as `{ value: … }`; `parameters` is a `Struct` so each value is wrapped
 * by `toProtoStruct`. Undefined fields are dropped entirely (client `X6`).
 */
function toProtoTools(tools: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return tools.map((tool) => {
    const fn = (tool["function"] ?? {}) as Record<string, unknown>;
    const out: Record<string, unknown> = {
      type: typeof tool["type"] === "string" ? (tool["type"] as string) : "function",
      function: {
        name: typeof fn["name"] === "string" ? (fn["name"] as string) : "",
        parameters: toProtoStruct((fn["parameters"] as Record<string, unknown> | undefined) ?? { type: "object", properties: {} }),
      },
    };
    const description = out["function"] as Record<string, unknown>;
    if (typeof fn["description"] === "string" && (fn["description"] as string).length > 0) {
      description["description"] = { value: fn["description"] };
    }
    if (typeof fn["strict"] === "boolean") {
      description["strict"] = { value: fn["strict"] };
    }
    return out;
  });
}

/**
 * Builds the gRPC `ChatCompletionRequest` from a canonical request.
 *
 * The request mirrors the OpenAI-shaped body the HTTP IDE surface sends: the
 * messages, tool declarations, and tool-choice knobs come from
 * `buildQoderRequest` (passed as `legacy`) so both transports share the exact
 * same translation — including the structured tool history and the `tools`
 * array. Without `tools` the upstream sees no toolset and answers with a DSML
 * text block (or claims no tool exists) instead of a structured `tool_calls`.
 */
export function buildQoderGrpcRequest(
  modelId: string,
  request: CanonicalRequest,
  userId: string,
  _contextWindow = 1_000_000,
  legacy?: {
    readonly messages: Array<Record<string, unknown>>;
    readonly tools?: Array<Record<string, unknown>>;
    readonly parameters?: Record<string, unknown>;
  },
): Record<string, unknown> {
  const sessionId = qoderSessionId(userId, modelId);
  const messages = legacy === undefined ? request.messages.map(mapMessage) : legacy.messages.map(toProtoChatMessage);
  const tools = legacy === undefined ? [] : toProtoTools(legacy.tools ?? []);
  const toolChoice = legacy?.parameters?.["tool_choice"];
  const parallel = legacy?.parameters?.["parallel_tool_calls"];
  // Donor mirror (`QFn`): `max_tokens` is sent only when the caller set it —
  // the donor wraps the caller's value in `{value: …}` and omits the field
  // entirely otherwise. Hard-coding 65536 turned a caller request into a
  // different model behavior than the reference desktop client.
  const maxTokens = legacy?.parameters?.["max_tokens"];
  const contextLength = legacy?.parameters?.["context_length"];
  return {
    model: modelId,
    messages,
    // `stream` is a plain `bool` in the proto (field 6) — not a wrapper.
    stream: true,
    stream_options: { include_usage: { value: true } },
    ...(maxTokens === undefined ? {} : { max_tokens: { value: Number(maxTokens) } }),
    // `tools` is repeated; an empty array serializes to nothing on the wire,
    // so it is safe to always include. The upstream only ever sees a
    // declaration when one exists.
    tools,
    // Mirror the donor's `QFn`: `parallel_tool_calls` is sent only when the
    // caller set it (the donor wraps the caller's parameter in `{value: …}`).
    ...(parallel === undefined ? {} : { parallel_tool_calls: { value: Boolean(parallel) } }),
    // `tool_choice` is a `google.protobuf.Value`; a string choice maps to
    // `{ stringValue: … }` (camelCase), matching the desktop client's `Qat()`.
    // gRPC rejects `tool_choice: "required"` outright (verified live
    // 2026-11-05 model matrix: 400/406/422 on most models — dmodel/dfmodel/
    // qmodel_38max/mmodel/cmodel). Omit it and let the neutral prompt carry the
    // intent; `auto`/named choices are still sent.
    ...(toolChoice !== undefined && toolChoice !== "required" ? { tool_choice: { stringValue: String(toolChoice) } } : {}),
    metadata: {
      context: {
        request_id: randomUUID(),
        session_id: sessionId,
        task_id: "common",
        request_set_id: randomUUID(),
        client_type: "5",
        source_session_id: "",
        ...(contextLength === undefined ? {} : { context_length: String(contextLength) }),
      },
      business: {
        product: "cli",
        type: "agent",
        version: getQoderVersion(),
      },
    },
  };
}

/** gRPC metadata headers mirroring the desktop client's identity headers. */
export function qoderGrpcMetadata(auth: QoderAuth, modelId = ""): grpc.Metadata {
  const metadata = new grpc.Metadata();
  metadata.set("authorization", `Bearer ${auth.securityOauthToken}`);
  metadata.set("x-request-id", randomUUID());
  metadata.set("x-session-id", qoderSessionId(auth.userId, modelId));
  // The desktop client's gRPC surface sends exactly this set (bundle
  // `bDl`/`patchCompletionStream`): version, client type, real machine OS,
  // and the sanitized hostname. It does NOT send `cosy-machinetype` /
  // `cosy-machinetoken` on gRPC (those are HTTP-only identity headers), and
  // sending a bogus device token here is a candidate for a server-side
  // mid-stream reset — see documentation/proposals/qoder-grpc-wire-alignment.md.
  const version = getQoderVersion();
  metadata.set("cosy-version", version);
  metadata.set("cosy-clienttype", "5");
  metadata.set("cosy-machineos", qoderMachineOs());
  const hostname = qoderMachineHostname();
  if (hostname.length > 0) metadata.set("cosy-machinehostname", hostname);
  return metadata;
}

/**
 * gRPC metadata headers safe to persist in the provider-request panel.
 *
 * Mirrors the HTTP capture allowlist (`CAPTURED_REQUEST_HEADERS` in
 * `transport/dispatch/attempt-finalize.ts`): session/identity framing is kept,
 * but credentials are never stored. `authorization` (the Bearer job token) is
 * deliberately excluded — the HTTP wrapper never captures it, and the gRPC
 * capture must not either.
 */
const GRPC_CAPTURED_HEADERS = [
  "x-request-id",
  "x-session-id",
  "cosy-version",
  "cosy-clienttype",
  "cosy-machineos",
  "cosy-machinehostname",
  "x-opencode-client",
  "x-opencode-session",
  "x-opencode-session-id",
  "x-opencode-parent-session-id",
  "x-opencode-request",
  "x-opencode-project",
  "x-conversation-id",
  "x-conversation-request-id",
  "x-conversation-message-id",
  "x-root-request-id",
  "x-trace-id",
  "traceparent",
  "b3",
] as const;

/**
 * A gRPC exchange is not a `fetch`, so the HTTP capture wrapper never sees it.
 * The adapter fills the sink directly with a faithful rendering of the proto
 * call: the request line (grpc method, host, allowlisted metadata, and the
 * translated body) and a deferred response that resolves to the collected
 * stream summary.
 */
export function captureQoderGrpcRequest(
  request: Record<string, unknown>,
  metadata: grpc.Metadata,
  realm: QoderRealm,
): Record<string, unknown> {
  const host = qoderGrpcHost(realm);
  const map = metadata.getMap() as Record<string, string | string[]>;
  const headers: Record<string, string> = {};
  for (const name of GRPC_CAPTURED_HEADERS) {
    const value = map[name];
    if (value === undefined) continue;
    headers[name] = Array.isArray(value) ? value.join(", ") : String(value);
  }
  return {
    method: "POST",
    url: `grpc://${host}/model.chat.ChatService/ChatCompletionStream`,
    headers,
    body: request,
  };
}

/** Maps a proto `finish_reason` to the canonical stop reason. */
function mapFinishReason(raw: string | undefined): CanonicalStopReason | undefined {
  switch (raw) {
    case "stop":
      return "stop";
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "length":
      return "length";
    default:
      return undefined;
  }
}

/**
 * Streams one gRPC `ChatCompletionStream` call into canonical events.
 *
 * `signal` aborts the call; the gRPC status is mapped to a GatewayError when
 * the call fails before any chunk.
 */
export async function* qoderGrpcToCanonicalEvents(
  request: Record<string, unknown>,
  metadata: grpc.Metadata,
  realm: QoderRealm,
  signal: AbortSignal,
  capture?: ProviderCaptureExchange,
): AsyncGenerator<CanonicalEvent> {
  const ChatService = qoderGrpcClient();
  const host = qoderGrpcHost(realm);
  const client = new ChatService(`${host}:443`, grpc.credentials.createSsl(), qoderGrpcChannelOptions(host));
  let sequence = 0;
  const nextSeq = () => {
    sequence += 1;
    return sequence;
  };
  try {
    const stream = client.ChatCompletionStream(request, metadata);
    let aborted = false;
    // Once a terminal event is emitted the turn is over: any later content,
    // reasoning, or tool-call fragments must be dropped — strict OpenAI
    // clients reject content after the finish reason. A second terminal is
    // skipped too (the upstream can re-emit the finish frame).
    let finished = false;
    // Last usage chunk seen; attached to the terminal event (the upstream
    // streams usage after the finish-reason chunk, and a standalone `usage`
    // event after terminal breaks strict Messages encoders).
    let pendingUsage: UsageRecord | undefined;
    /** Whether the terminal already carried the pending usage. */
    let terminalEmitted = false;
    // The gRPC exchange is not a fetch, so the HTTP capture wrapper never sees
    // it. Fill the sink with the translated request and a deferred response
    // that resolves to the collected stream summary — this is what Request
    // Detail shows for Qoder instead of the PAT exchange or an empty panel.
    if (capture !== undefined) {
      capture.request = captureQoderGrpcRequest(request, metadata, realm);
      capture.response = new Promise((resolve) => {
        const summary: Record<string, unknown> = {
          transport: "grpc",
          chunks: 0,
          answer_chars: 0,
          reasoning_chars: 0,
          tool_calls: 0,
          models: [] as string[],
          usage: undefined,
          stop_reason: undefined,
          status_code: 0,
          // Materialized response content (bounded): the text the model
          // emitted, the reasoning trace, and the tool calls that were
          // announced. This is what Request Detail shows instead of a bare
          // statistics block.
          text: "",
          reasoning: "",
          toolCalls: [] as Array<{ index: number; id?: string; name?: string; arguments?: string }>,
        };
        // Per-index tool-call fragments (the upstream streams one call at a
        // time: id + empty args, then argument fragments, index always 0).
        const toolCallsByIndex = new Map<number, { id?: string; name?: string; arguments?: string }>();
        const MAX_TEXT_CHARS = 16_000;
        const MAX_TOOL_CALLS = 50;
        const MAX_TOOL_ARGS_CHARS = 2_000;
        // `stream` is attached to `data` below; the summary is updated there.
        const onData = (chunk: unknown) => {
          const rec = chunk as Record<string, unknown>;
          summary["chunks"] = (summary["chunks"] as number) + 1;
          const model = rec["model"];
          if (typeof model === "string" && model.length > 0) {
            const models = summary["models"] as string[];
            if (!models.includes(model)) models.push(model);
          }
          const usage = rec["usage"];
          if (usage !== undefined && typeof usage === "object") summary["usage"] = usage;
          const choices = Array.isArray(rec["choices"]) ? (rec["choices"] as Array<Record<string, unknown>>) : [];
          for (const choice of choices) {
            const delta = choice["delta"] as Record<string, unknown> | undefined;
            const content = delta?.["content"];
            if (typeof content === "string" && content.length > 0) {
              summary["answer_chars"] = (summary["answer_chars"] as number) + content.length;
              const text = summary["text"] as string;
              if (text.length < MAX_TEXT_CHARS) {
                summary["text"] = (text + content).slice(0, MAX_TEXT_CHARS);
              }
            }
            const reasoning = delta?.["reasoning_content"];
            if (typeof reasoning === "string" && reasoning.length > 0) {
              summary["reasoning_chars"] = (summary["reasoning_chars"] as number) + reasoning.length;
              const reasoningText = summary["reasoning"] as string;
              if (reasoningText.length < MAX_TEXT_CHARS) {
                summary["reasoning"] = (reasoningText + reasoning).slice(0, MAX_TEXT_CHARS);
              }
            }
            const calls = delta?.["tool_calls"];
            if (Array.isArray(calls) && calls.length > 0) {
              summary["tool_calls"] = (summary["tool_calls"] as number) + calls.length;
              for (const rawTc of calls) {
                const tc = fromProtoStruct(rawTc);
                const index = typeof tc["index"] === "number" ? (tc["index"] as number) : 0;
                const entry = toolCallsByIndex.get(index) ?? {};
                const declaredId = tc["id"];
                if (typeof declaredId === "string" && declaredId.trim().length > 0) entry.id = declaredId.trim();
                const fn = (tc["function"] ?? {}) as Record<string, unknown>;
                const name = fn["name"];
                if (typeof name === "string" && name.trim().length > 0) entry.name = name.trim();
                const args = fn["arguments"];
                if (typeof args === "string" && args.length > 0) {
                  entry.arguments = ((entry.arguments ?? "") + args).slice(0, MAX_TOOL_ARGS_CHARS);
                }
                toolCallsByIndex.set(index, entry);
              }
            }
            const finish = choice["finish_reason"];
            if (typeof finish === "string" && finish.length > 0) summary["stop_reason"] = finish;
          }
        };
        const flushToolCalls = () => {
          const entries = [...toolCallsByIndex.entries()]
            .sort((a, b) => a[0] - b[0])
            .slice(0, MAX_TOOL_CALLS)
            .map(([index, entry]) => ({ index, ...entry }));
          if (entries.length > 0) summary["toolCalls"] = entries;
        };
        stream.on("data", onData);
        stream.on("status", (s: { code?: number; details?: string }) => {
          summary["status_code"] = s.code ?? 0;
          summary["grpc_message"] = s.details ?? "";
        });
        stream.on("error", (err: Error) => {
          summary["error"] = err.message;
          flushToolCalls();
          resolve(summary);
        });
        stream.on("end", () => {
          flushToolCalls();
          resolve(summary);
        });
      });
    }

    const abortHandler = () => {
      aborted = true;
      stream.cancel();
    };
    signal.addEventListener("abort", abortHandler, { once: true });

    try {
      let echoedModel: string | undefined;
      // Tool-call deltas arrive as fragments on `delta.tool_calls` (same
      // OpenAI shape as the HTTP surfaces). Each decoded element maps to one
      // canonical `tool_call_delta` immediately, pass-through — the donor
      // forwards fragments verbatim and the client stitches them by
      // `index`/`id` itself.
      const toolCallBuffer = new QoderToolCallBuffer();
      /** Stitching state for continuation fragments. */
      const fragmentState: QoderToolFragmentState = {};
      for await (const chunk of stream) {
        if (aborted || signal.aborted) break;
        // The upstream names the model it actually ran in the chunk's `model`
        // field. Surface it once as `response_start` so probes and telemetry
        // can report the real echoed model (the gRPC surface has no HTTP body
        // for `readReportedModel` to inspect).
        if (echoedModel === undefined) {
          if (typeof chunk.model === "string" && chunk.model.trim().length > 0) {
            echoedModel = chunk.model.trim();
          }
          yield {
            type: "response_start",
            sequence_number: nextSeq(),
            ...(echoedModel === undefined ? {} : { model: echoedModel }),
          } satisfies CanonicalEvent as CanonicalEvent;
        }
        const choices = chunk.choices ?? [];
        for (const choice of choices) {
          const delta = choice.delta ?? {};
          if (!finished && typeof delta.content === "string" && delta.content.length > 0) {
            yield {
              type: "content_delta",
              sequence_number: nextSeq(),
              content: { kind: "text", text: delta.content },
            };
          }
          if (!finished && typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) {
            yield {
              type: "content_delta",
              sequence_number: nextSeq(),
              content: { kind: "reasoning", payload: delta.reasoning_content },
            };
          }
          // `delta.tool_calls` is a repeated `google.protobuf.Struct` — each
          // element arrives as a Struct-wrapped Value union (`{fields: {k:
          // {stringValue/numberValue/...}}}`), NOT the plain OpenAI shape.
          // Convert each element back to `{id, index, type, function}` before
          // applying the same empty-id/continuation semantics as the HTTP
          // surfaces: `id` only appears on the first chunk, so fragments
          // rejoin the first-seen id per wire `index`.
          const toolCalls = delta.tool_calls;
          if (!finished && Array.isArray(toolCalls) && toolCalls.length > 0) {
            for (const rawTc of toolCalls) {
              const tc = fromProtoStruct(rawTc);
              const fn = (tc["function"] ?? {}) as Record<string, unknown>;
              const index = typeof tc["index"] === "number" ? (tc["index"] as number) : undefined;
              const declaredId =
                typeof tc["id"] === "string" && (tc["id"] as string).trim().length > 0
                  ? (tc["id"] as string).trim()
                  : undefined;
              const fragName =
                typeof fn["name"] === "string" && fn["name"].trim().length > 0
                  ? (fn["name"] as string).trim()
                  : undefined;
              const fragArgs =
                typeof fn["arguments"] === "string"
                  ? (fn["arguments"] as string)
                  : fn["arguments"] !== undefined && fn["arguments"] !== null
                    ? JSON.stringify(fn["arguments"])
                    : undefined;
              // Continuation fragments (`id: ""`) attach to the current active
              // call — the upstream announces one call at a time (id + empty
              // args) and then streams that call's arguments as several small
              // fragments, with the index always 0. Without this, each
              // fragment gets a fresh fallback id and the client sees an
              // empty-arguments call plus orphaned fragments.
              const pinnedId = resolveQoderToolFragmentId(fragmentState, declaredId);
              const call = toolCallBuffer.consume({
                ...(pinnedId !== undefined ? { id: pinnedId } : {}),
                ...(index !== undefined ? { index } : {}),
                ...(fragName !== undefined ? { name: fragName } : {}),
                ...(fragArgs !== undefined && fragArgs.length > 0 ? { args: fragArgs } : {}),
              });
              yield {
                type: "tool_call_delta",
                sequence_number: nextSeq(),
                call_id: call.callId,
                index: call.index,
                ...(call.name === undefined ? {} : { name: call.name }),
                arguments_delta: call.arguments,
              } satisfies CanonicalEvent as CanonicalEvent;
            }
          }
          if (!finished && typeof choice.finish_reason === "string" && choice.finish_reason.length > 0) {
            const stop = mapFinishReason(choice.finish_reason);
            if (stop !== undefined) {
              // The terminal verdict follows the tool-call deltas, which were
              // already yielded as they arrived — the client must see the
              // calls before the finish reason, or it records
              // `finish_reason=tool_calls` with zero tool calls.
              finished = true;
              // `tool_use` is a *successful* terminal verdict — the model
              // decided to call a tool — so the terminal state is `complete`
              // (same as `stop`), never `failed`. A `failed` state here made
              // attempt-finalize treat a healthy tool turn as an upstream
              // failure ("empty-handed") and replay it.
              yield {
                type: "terminal",
                sequence_number: nextSeq(),
                state: stop === "stop" || stop === "tool_use" ? "complete" : "failed",
                stop_reason: stop,
                provider_stop_reason: choice.finish_reason,
                // The upstream streams `usage` in a trailing chunk *after* the
                // finish-reason chunk. A separate `usage` event after the
                // terminal is rejected by strict Anthropic Messages encoders
                // (the 2.7.8 regression), so the usage is carried here on the
                // terminal instead — exactly like the IDE surface does.
                ...(pendingUsage === undefined ? {} : { usage: pendingUsage }),
              };
              if (pendingUsage !== undefined) terminalEmitted = true;
            }
          }
        }
        if (chunk.usage) {
          const usage = usageFromProvider(chunk.usage);
          if (usage !== undefined) {
            // Keep the last usage chunk; it is attached to the terminal above
            // (and only if no terminal ever arrives, emitted as a standalone
            // event at stream end).
            pendingUsage = usage;
          }
        }
      }
      // Tool-call deltas are emitted as they arrive — there is no end-of-stream
      // buffer to flush; the terminal event is yielded by the finish-reason
      // branch above (or synthesized by the caller if the stream ends without
      // one). If no terminal carried the pending usage (the stream ended
      // without a finish reason), emit it as a standalone event so telemetry
      // still sees the upstream's numbers.
      if (!terminalEmitted && pendingUsage !== undefined) {
        yield { type: "usage", sequence_number: nextSeq(), usage: pendingUsage };
      }
    } catch (err: any) {
      const status = err?.code;
      const details = err?.details ?? err?.message ?? "";
      if (typeof status === "number" && status !== 0) {
        if (status === 16) {
          throw new GatewayError(
            "authentication_failed",
            401,
            "Qoder gRPC rejected the credential (request {requestId}). Wrong key, right door — check the credential 🔑",
            {},
            "upstream",
          );
        }
        if (details.includes("413")) {
          throw new GatewayError(
            "context_length_exceeded",
            413,
            "The request exceeds the upstream context cap (request {requestId}). Trim the conversation and retry ✂️",
            {},
            "upstream",
          );
        }
        if (status === 13 && details.includes("quota")) {
          throw new GatewayError(
            "quota_exceeded",
            429,
            "Qoder quota exhausted on the gRPC surface (request {requestId})",
            { providerCode: "quota_exceeded" },
            "upstream",
          );
        }
        throw new GatewayError(
          "platform_unavailable",
          502,
          `Qoder gRPC stream failed (${details}) (request {requestId})`,
          {},
          "upstream",
        );
      }
      throw err;
    } finally {
      signal.removeEventListener("abort", abortHandler);
      stream.destroy();
    }
  } finally {
    client.close();
  }
}
