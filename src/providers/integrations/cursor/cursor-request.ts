// Cartethyia-owned Cursor request builder.
//
// Translates a `CanonicalRequest` into Cursor's `AgentClientMessage` protobuf
// messages. Everything here is wire construction — no transport, no session
// state, no credentials — so it is testable against the schema without a socket.
//
// Two Cursor behaviours drive the shape:
//
// - **Nothing goes in `root_prompt_messages_json`.** A client-written entry
//   stands in for the conversation's rendered root prompt, and Cursor then stops
//   rendering RequestContext rules — including the host system-instructions rule
//   the system prompt travels in. Prior history therefore rides in an escaped
//   `<conversation_history>` prefix of the live user text instead.
// - **Tools are advertised through `mcp_meta_tool_options`.** `AgentRunRequest.mcp_tools`
//   stays empty on real turns; the model calls an advertised tool through the
//   MCP exec channel, which is the only path this gateway executes.
import type { CanonicalMessage, CanonicalRequest, ContentPart, ToolDefinition } from "../../../protocol/canonical-model";
import { encodeMessage } from "./protocol/messages";
import { encodeJsonAsValue } from "./protocol/struct";
// Inbound half of the tool surface. `toolDescriptorsFor` below is the outbound
// half — what this request advertises. Together they are the only two places a
// Cursor tool is named, so both live here rather than one in a protocol module
// a caller has to discover separately.
export {
  CURSOR_TOOL_VARIANTS,
  cursorToolArm,
  decodeCursorNativeToolCall,
} from "./protocol/tool-canonical";

/**
 * MCP namespace Cartethyia advertises client tools under.
 *
 * Cursor namespaces MCP tools by server, and an inbound `mcp_args` request
 * carries both the server and the function name. Advertising under one fixed
 * namespace is what makes "is this a tool the client declared?" decidable: a
 * Cursor-native tool (shell, read, edit, …) arrives under a different server or
 * with no server at all and is never executed by the gateway.
 */
export const CURSOR_MCP_NAMESPACE = "cartethyia";

/** One tools advertisement Cursor receives in `RequestContext.mcp_meta_tool_options`. */
export interface CursorToolDescriptor {
  /** Cursor composite `name`: `<namespace>-<tool name>`. */
  readonly name: string;
  readonly description: string;
  /** Server identifier every inbound call must echo to be executable. */
  readonly providerIdentifier: string;
  /** Bare function name the client declared. */
  readonly toolName: string;
  /** JSON Schema, encoded as a `google.protobuf.Value` on the wire. */
  readonly inputSchema: unknown;
}

/** One image accepted from a canonical request, ready for `selected_images`. */
export interface CursorImageInput {
  readonly data: Uint8Array;
  readonly mimeType: string;
  readonly filename?: string;
}

/** Prior turn carried in the escaped history prefix of a rebased Run. */
export interface CursorHistoryEntry {
  readonly role: "user" | "assistant";
  readonly content: string;
}

/** Closing tags that would let one history message end its own block early. */
const SEED_HISTORY_TAGS = /<\/(conversation_history|user|assistant)>/gi;

/**
 * Prior turns of a Run without a checkpoint, as a transcript ahead of the live
 * user text. `system` entries never appear: host system context travels as the
 * system-instructions rule in RequestContext.
 */
export function seedHistoryUserText(
  text: string,
  history: readonly CursorHistoryEntry[] | undefined,
): string {
  const entries = (history ?? []).filter((entry) => entry.content.length > 0);
  if (entries.length === 0) return text;
  const transcript = entries
    .map(
      (entry) =>
        `<${entry.role}>\n${entry.content.replace(SEED_HISTORY_TAGS, "<\\/$1>")}\n</${entry.role}>`,
    )
    .join("\n\n");
  return `<conversation_history>\n${transcript}\n</conversation_history>\n\n${text}`;
}

/** Empty `ConversationStateStructure` for a Run with no checkpoint. */
export function buildSeedConversationState(): Uint8Array {
  return encodeMessage("ConversationStateStructure", {});
}

/**
 * Advertises one request's declared function tools as Cursor MCP descriptors.
 *
 * A tool with no usable name is skipped rather than advertised under an
 * invented one: an unnameable tool cannot be matched back to an inbound call,
 * and advertising it would let the model call something the gateway cannot
 * execute or the client cannot answer.
 */
export function toolDescriptorsFor(
  tools: readonly ToolDefinition[] | undefined,
): CursorToolDescriptor[] {
  const descriptors: CursorToolDescriptor[] = [];
  const seen = new Set<string>();
  for (const tool of tools ?? []) {
    const name = tool.name?.trim();
    if (name === undefined || name.length === 0) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    descriptors.push({
      name: `${CURSOR_MCP_NAMESPACE}-${name}`,
      description: typeof tool.description === "string" ? tool.description : "",
      providerIdentifier: CURSOR_MCP_NAMESPACE,
      toolName: name,
      inputSchema: tool.jsonSchema ?? { type: "object", properties: {} },
    });
  }
  return descriptors;
}

/** `McpToolDefinition` protobuf messages for one descriptor set. */
function mcpToolDefinitions(
  descriptors: readonly CursorToolDescriptor[],
): Record<string, unknown>[] {
  return descriptors.map((descriptor) => ({
    name: descriptor.name,
    description: descriptor.description,
    input_schema: encodeJsonAsValue(descriptor.inputSchema),
    provider_identifier: descriptor.providerIdentifier,
    tool_name: descriptor.toolName,
  }));
}

/**
 * Builds the RequestContext Cartethyia sends.
 *
 * The system prompt is a `global` rule: an untyped Cursor rule is attachable
 * only on request, so its content would never reach the model on its own. Tools
 * are advertised both in `tools` (#7) and in `mcp_meta_tool_options` (#34) —
 * the meta-tool channel is the one Cursor's model actually draws its callable
 * catalog from on a live turn.
 */
export function buildCursorRequestContext(input: {
  readonly systemPrompt?: string;
  readonly descriptors: readonly CursorToolDescriptor[];
}): Record<string, unknown> {
  const tools = mcpToolDefinitions(input.descriptors);
  const rules =
    input.systemPrompt !== undefined && input.systemPrompt.trim().length > 0
      ? [
          {
            full_path: "cartethyia/system-instructions",
            content: input.systemPrompt,
            type: { global: {} },
          },
        ]
      : [];
  return {
    ...(rules.length > 0 ? { rules } : {}),
    ...(tools.length > 0 ? { tools } : {}),
    // The host's own filesystem/web/search surface. A headless gateway has
    // none; advertising none up front keeps Cursor from routing a tool call to
    // a channel the gateway must then refuse.
    mcp_file_system_options: { enabled: false },
    web_search_enabled: false,
    web_fetch_enabled: false,
    ...(tools.length > 0
      ? {
          mcp_meta_tool_options: {
            enabled: true,
            mcp_descriptors: [
              {
                server_name: CURSOR_MCP_NAMESPACE,
                server_identifier: CURSOR_MCP_NAMESPACE,
                tools: tools.map((tool) => ({
                  tool_name: tool["tool_name"],
                  ...(typeof tool["description"] === "string"
                    ? { description: tool["description"] }
                    : {}),
                  input_schema: tool["input_schema"],
                })),
              },
            ],
          },
        }
      : {}),
    // Every context section the gateway does not populate is marked complete so
    // Cursor does not wait for a follow-up the client will never send.
    mcp_info_complete: true,
    rules_info_complete: true,
    env_info_complete: true,
    repository_info_complete: true,
    custom_subagents_info_complete: true,
    agent_skills_info_complete: true,
    mcp_file_system_info_complete: true,
    git_status_info_complete: true,
  };
}

/** Joins a request's system and instruction content into one prompt. */
export function systemPromptFrom(request: CanonicalRequest): string | undefined {
  const parts = [...(request.system ?? []), ...(request.instructions ?? [])];
  const text = parts
    .map((part) => (part.kind === "text" ? part.text : ""))
    .filter((value) => value.length > 0)
    .join("\n\n");
  return text.length > 0 ? text : undefined;
}

/**
 * Prior turns of a rebased Run, as escaped history entries.
 *
 * `system` turns never appear: host system context travels as the
 * system-instructions rule, and `tool` turns become `user` entries because
 * Cursor's seed transcript has no tool role.
 */
export function historyFromRequest(request: CanonicalRequest): CursorHistoryEntry[] {
  const entries: CursorHistoryEntry[] = [];
  for (const message of request.messages) {
    const text = messageText(message);
    if (text.trim().length === 0) continue;
    if (message.role === "assistant") entries.push({ role: "assistant", content: text });
    else if (message.role === "user" || message.role === "tool") {
      entries.push({ role: "user", content: text });
    }
  }
  return entries;
}

/** Builds `AgentClientMessage{run_request}` for one Cursor Run. */
export function buildRunRequest(input: {
  readonly text: string;
  readonly modelId: string;
  readonly conversationId: string;
  /** Stable parent group; unlike the conversation id it survives a rebase. */
  readonly conversationGroupId?: string;
  readonly runId?: string;
  readonly messageId?: string;
  readonly history?: readonly CursorHistoryEntry[];
  /** Cursor-declared parameter tuple (effort/context/fast) for this model. */
  readonly parameterValues?: readonly { id: string; value: string }[];
  readonly maxMode?: boolean;
  readonly images?: readonly CursorImageInput[];
  readonly descriptors?: readonly CursorToolDescriptor[];
  readonly systemPrompt?: string;
  /** Opaque checkpoint bytes; absent sends an empty seed state. */
  readonly conversationState?: Uint8Array;
  /** Resume a held Run instead of submitting another user turn. */
  readonly action?: "user" | "resume";
}): Uint8Array {
  const messageId = input.messageId ?? crypto.randomUUID();
  const seeded = !(input.conversationState && input.conversationState.length > 0);
  const userMessage: Record<string, unknown> = {
    text: seeded ? seedHistoryUserText(input.text, input.history) : input.text,
    message_id: messageId,
    // AGENT_MODE_AGENT: the default agent turn, as Cursor CLI sends it.
    mode: 1,
  };
  if (input.images !== undefined && input.images.length > 0) {
    userMessage["selected_context"] = {
      selected_images: input.images.map((image) => ({
        data: image.data,
        uuid: crypto.randomUUID(),
        ...(image.filename === undefined ? {} : { path: image.filename }),
        mime_type: image.mimeType,
      })),
    };
  }
  const userMessageAction: Record<string, unknown> = { user_message: userMessage };
  const requestContext = buildCursorRequestContext({
    ...(input.systemPrompt === undefined ? {} : { systemPrompt: input.systemPrompt }),
    descriptors: input.descriptors ?? [],
  });
  userMessageAction["request_context"] = requestContext;
  const runRequest: Record<string, unknown> = {
    conversation_id: input.conversationId,
    conversation_group_id: input.conversationGroupId ?? input.conversationId,
    run_id: input.runId ?? messageId,
    action:
      input.action === "resume"
        ? { resume_action: { request_context: requestContext } }
        : { user_message_action: userMessageAction },
    requested_model: {
      model_id: input.modelId,
      max_mode: input.maxMode ?? false,
      parameters: (input.parameterValues ?? []).map((parameter) => ({ ...parameter })),
    },
    conversation_state: seeded ? buildSeedConversationState() : input.conversationState,
    mcp_tools: { mcp_tools: [] },
    unknown_flag: 0,
    field_12: 0,
  };
  return encodeMessage("AgentClientMessage", { run_request: runRequest });
}

/** `AgentClientMessage{client_heartbeat}`. */
export function buildHeartbeat(): Uint8Array {
  return encodeMessage("AgentClientMessage", { client_heartbeat: {} });
}

/** `ACM#5 exec_client_control_message.stream_close{id}` after an exec result. */
export function buildExecStreamClose(execId: number, execIdString?: string): Uint8Array {
  return encodeMessage("AgentClientMessage", {
    exec_client_control_message: { stream_close: { id: execId, ...(execIdString === undefined ? {} : { exec_id: execIdString }) } },
  });
}

/** Stops the live Run, as Cursor CLI does before closing the stream. */
export function buildCancelAction(reason: string): Uint8Array {
  return encodeMessage("AgentClientMessage", {
    conversation_action: { cancel_action: { reason } },
  });
}

/** `ACM#3 kv_client_message` reply to a server `set_blob`. */
export function buildKvSetBlobResult(id: number): Uint8Array {
  return encodeMessage("AgentClientMessage", {
    kv_client_message: { id, set_blob_result: {} },
  });
}

/** `ACM#3 kv_client_message` reply to a server `get_blob`. */
export function buildKvGetBlobResult(id: number, blobData: Uint8Array): Uint8Array {
  return encodeMessage("AgentClientMessage", {
    kv_client_message: { id, get_blob_result: { blob_data: blobData } },
  });
}

/** `ACM#2 exec_client_message{request_context_result}` reply to a context probe. */
export function buildRequestContextResult(
  execId: number,
  requestContext: Record<string, unknown>,
  execIdString?: string,
): Uint8Array {
  return encodeMessage("AgentClientMessage", {
    exec_client_message: {
      id: execId,
      exec_id: execIdString ?? "",
      request_context_result: { success: { request_context: requestContext } },
    },
  });
}

/**
 * `ACM#2 exec_client_message{mcp_state_exec_result}` reply to Cursor's MCP
 * availability probe.
 *
 * Cursor probes the servers behind an advertised tool before it emits a call,
 * and a Run that never gets an answer stalls on heartbeats. Answering from the
 * descriptors this Run advertised is what keeps the model's catalog intact.
 */
export function buildMcpStateResult(
  execId: number,
  descriptors: readonly CursorToolDescriptor[],
  execIdString?: string,
): Uint8Array {
  return encodeMessage("AgentClientMessage", {
    exec_client_message: {
      id: execId,
      exec_id: execIdString ?? "",
      mcp_state_exec_result: {
        success: {
          servers: [
            {
              server_name: CURSOR_MCP_NAMESPACE,
              server_identifier: CURSOR_MCP_NAMESPACE,
              status: "connected",
              tools: mcpToolDefinitions(descriptors),
            },
          ],
        },
      },
    },
  });
}

/** One `McpToolResultContentItem` for an image-bearing tool result. */
function imageContentItem(data: Uint8Array, mimeType: string): Record<string, unknown> {
  return { image: { data, mime_type: mimeType } };
}

/**
 * `ACM#2 exec_client_message{mcp_result}` carrying one external tool result.
 *
 * `is_error` is set for a tool the client reported as failed: Cursor relays the
 * distinction to the model, so a failure is not silently recast as a successful
 * observation.
 */
export function buildMcpResult(input: {
  readonly execId: number;
  readonly execIdString?: string;
  readonly text: string;
  readonly isError: boolean;
  readonly images?: readonly { data: Uint8Array; mimeType: string }[];
}): Uint8Array {
  const content: Record<string, unknown>[] = [];
  if (input.text.length > 0) content.push({ text: { text: input.text } });
  for (const image of input.images ?? []) {
    content.push(imageContentItem(image.data, image.mimeType));
  }
  if (content.length === 0) content.push({ text: { text: "" } });
  return encodeMessage("AgentClientMessage", {
    exec_client_message: {
      id: input.execId,
      exec_id: input.execIdString ?? "",
      mcp_result: { success: { content, is_error: input.isError } },
    },
  });
}

/**
 * `ACM#2 exec_client_message{mcp_result}` rejecting a tool the client never
 * declared.
 *
 * A refusal is not an execution: Cursor asked for a host tool this gateway does
 * not run, and answering `rejected` (rather than executing it or stalling) is
 * what lets the model continue without the gateway ever touching a filesystem
 * or a shell on the caller's behalf.
 */
export function buildMcpRejected(
  execId: number,
  reason: string,
  execIdString?: string,
): Uint8Array {
  return encodeMessage("AgentClientMessage", {
    exec_client_message: {
      id: execId,
      exec_id: execIdString ?? "",
      mcp_result: { rejected: { reason, is_readonly: true } },
    },
  });
}

/**
 * `ACM#2 exec_client_message{*_allowlist_precheck_result}` for frames 41/42/43.
 *
 * Cursor asks whether a shell command, MCP tool, or web fetch would be
 * permitted *before* it emits the real call.
 *
 * - `shell` → `true`: the native executor runs shell locally.
 * - `mcp` → `true` only when the tool is client-declared (relayed); the
 *   caller decides on the `allowlisted` flag.
 * - `web_fetch` → `false`: web fetch is not executed by this gateway.
 */
export function buildAllowlistPrecheckResult(
  execId: number,
  kind: "shell" | "mcp" | "web_fetch",
  execIdString: string | undefined,
  allowlisted: boolean,
): Uint8Array {
  const frame =
    kind === "shell"
      ? "shell_allowlist_precheck_result"
      : kind === "mcp"
        ? "mcp_allowlist_precheck_result"
        : "web_fetch_allowlist_precheck_result";
  return encodeMessage("AgentClientMessage", {
    exec_client_message: { id: execId, exec_id: execIdString ?? "", [frame]: { allowlisted } },
  });
}

/**
 * `ACM#5 exec_client_control_message.throw{id}`: fails an exec frame in band.
 *
 * An unrecognized (or unimplementable) exec variant must still be answered —
 * silently returning strands the exec id and the server waits forever on a
 * reply that never comes. Cursor's own executor recovers exactly this way, so
 * the server surfaces the error to the model instead of blocking the turn.
 */
export function buildExecThrow(execId: number, error: string, execIdString?: string): Uint8Array {
  return encodeMessage("AgentClientMessage", {
    exec_client_control_message: {
      throw: { id: execId, error, ...(execIdString === undefined ? {} : { exec_id: execIdString }) },
    },
  });
}

/**
 * `ACM#6 interaction_response{id}` answering one permission gate.
 *
 * Result names must match the queried variant's response frame; bodies stay
 * opaque so every gate is answered as a policy object rather than a decoded
 * args blob.
 */
export function buildInteractionResponse(
  queryId: number,
  resultName: string,
  result: Record<string, unknown>,
): Uint8Array {
  return encodeMessage("AgentClientMessage", {
    interaction_response: { id: queryId, [resultName]: result },
  });
}

/** Text of one canonical message, for the escaped history prefix. */
export function messageText(message: CanonicalMessage): string {
  const parts: string[] = [];
  for (const part of message.content) {
    if (part.kind === "text") parts.push(part.text);
    else if (part.kind === "toolCall") parts.push(`[tool call ${part.name} ${stringifyArgs(part.arguments)}]`);
    else if (part.kind === "toolResult") parts.push(`[tool result ${part.call_id} ${toolResultText(part)}]`);
    else if (part.kind === "reasoning" && part.summary !== undefined) parts.push(part.summary);
  }
  return parts.join("\n");
}

function stringifyArgs(arguments_: unknown): string {
  if (typeof arguments_ === "string") return arguments_;
  try {
    return JSON.stringify(arguments_ ?? {});
  } catch {
    return "{}";
  }
}

function toolResultText(part: Extract<ContentPart, { kind: "toolResult" }>): string {
  if (typeof part.content === "string") return part.content;
  return part.content
    .map((child) => (child.kind === "text" ? child.text : `[${child.kind}]`))
    .join("\n");
}

/**
 * The live user text of one canonical request: the last user turn.
 *
 * Everything before it is history, and Cursor's own `user_message.text` carries
 * only the current prompt.
 */
export function liveUserText(request: CanonicalRequest): string {
  for (let index = request.messages.length - 1; index >= 0; index -= 1) {
    const message = request.messages[index];
    if (message === undefined) continue;
    if (message.role !== "user" && message.role !== "tool") continue;
    const text = messageText(message);
    if (text.trim().length > 0) return text;
  }
  return "";
}
