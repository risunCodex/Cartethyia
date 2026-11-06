// Cursor-native tool calls, unified into one canonical shape.
//
// Cursor's `agent.v1.ToolCall` is a oneof of ~30 variants spanning three
// unrelated generations: the legacy natives (`ReadToolCall` 8, `ShellToolCall`
// 1, `EditToolCall` 12, …), the modern exec family (`PiReadToolCall` 61 …
// `PiLsToolCall` 67), and MCP (`McpToolCall` 15). Each carries its own args
// message and its own `*ToolResult` oneof of `success`/`error`, so handling
// them individually meant a decoder and a builder per variant — most of them
// saying the same thing.
//
// This module is the single join point. One table maps a wire variant to a
// canonical tool identity, and the decode/encode paths below are written once
// against that table rather than once per variant.
//
// **Variants stay separate.** `ReadToolCall` and `PiReadToolCall` are two tools,
// not one tool seen twice: their args and their result shapes genuinely differ,
// and folding them would mean picking one shape and lying about the other. A
// new variant is one table row, not a new converter.
//
// **Cursor-scoped on purpose.** Nothing here is shared with the other provider
// integrations. The canonical vocabulary is Cursor's own (`read`, `pi_read`,
// `shell`, …), so a tool named `read` on Cursor and a `read` on some other
// provider are unrelated and cannot collide through a shared registry.
import type { ToolDefinition } from "../../../../protocol/canonical-model";

/**
 * One `ToolCall` oneof arm, as it exists on the wire.
 *
 * `field` is the oneof number from `agent.proto` — the only stable identity a
 * variant has. `wireType` and `argsType` name the protobuf messages so a
 * decoder can resolve them against the type registry without this file
 * importing the registry (and without the registry growing a second notion of
 * which variants exist).
 */
export interface CursorToolVariant {
  readonly field: number;
  readonly wireType: string;
  readonly argsType: string;
  /** Result message carrying the `success`/`error` oneof. */
  readonly resultType: string;
  /**
   * Canonical tool name for this variant.
   *
   * Deliberately not shared across generations: `read` and `pi_read` are two
   * names because they are two tools. A caller that wants both treats them as
   * both; a caller that wants one filters on one.
   */
  readonly name: string;
}

const VARIANT = (
  field: number,
  wireType: string,
  argsType: string,
  resultType: string,
  name: string,
): CursorToolVariant => ({ field, wireType, argsType, resultType, name });

/**
 * Every Cursor-native tool variant this layer speaks, keyed by oneof field.
 *
 * `McpToolCall` is absent on purpose: client-declared tools have no native
 * slot anywhere in `agent.proto` — `RequestContext.tools` (#7) is
 * `repeated McpToolDefinition` and `AgentRunRequest.mcp_tools` (#4) is the only
 * other place tools travel — so those stay on the MCP meta-tool path. This
 * table is for the arms Cursor itself owns.
 */
export const CURSOR_TOOL_VARIANTS: ReadonlyMap<number, CursorToolVariant> = new Map([
  VARIANT(1, "ShellToolCall", "ShellArgs", "ShellResult", "shell"),
  // Legacy write has no ToolCall oneof arm — it arrives only as
  // `ExecServerMessage.write_args` (field 3). The variant is registered with
  // a dedicated field number so `cursorVariantForExecArgs` can resolve it
  // without colliding with `DeleteToolCall` (which also owns field 3); the
  // field is otherwise unused by the ToolCall path.
  VARIANT(0, "WriteToolCall", "WriteArgs", "WriteResult", "write"),
  VARIANT(3, "DeleteToolCall", "DeleteArgs", "DeleteResult", "delete"),
  VARIANT(4, "GlobToolCall", "GlobArgs", "GlobResult", "glob"),
  VARIANT(5, "GrepToolCall", "GrepArgs", "GrepResult", "grep"),
  VARIANT(8, "ReadToolCall", "ReadToolArgs", "ReadToolResult", "read"),
  VARIANT(9, "UpdateTodosToolCall", "UpdateTodosArgs", "UpdateTodosResult", "update_todos"),
  VARIANT(10, "ReadTodosToolCall", "ReadTodosArgs", "ReadTodosResult", "read_todos"),
  VARIANT(12, "EditToolCall", "EditToolArgs", "EditToolResult", "edit"),
  VARIANT(13, "LsToolCall", "LsArgs", "LsResult", "ls"),
  VARIANT(14, "ReadLintsToolCall", "ReadLintsToolArgs", "ReadLintsToolResult", "read_lints"),
  VARIANT(16, "SemSearchToolCall", "SemSearchToolArgs", "SemSearchToolResult", "sem_search"),
  VARIANT(17, "CreatePlanToolCall", "CreatePlanArgs", "CreatePlanResult", "create_plan"),
  VARIANT(18, "WebSearchToolCall", "WebSearchToolArgs", "WebSearchToolResult", "web_search"),
  VARIANT(19, "TaskToolCall", "TaskToolArgs", "TaskToolResult", "task"),
  VARIANT(22, "ApplyAgentDiffToolCall", "ApplyAgentDiffArgs", "ApplyAgentDiffResult", "apply_agent_diff"),
  VARIANT(23, "AskQuestionToolCall", "AskQuestionArgs", "AskQuestionResult", "ask_question"),
  VARIANT(24, "FetchToolCall", "FetchToolArgs", "FetchToolResult", "fetch"),
  VARIANT(25, "SwitchModeToolCall", "SwitchModeArgs", "SwitchModeResult", "switch_mode"),
  VARIANT(26, "ExaSearchToolCall", "ExaSearchArgs", "ExaSearchResult", "exa_search"),
  VARIANT(27, "ExaFetchToolCall", "ExaFetchArgs", "ExaFetchResult", "exa_fetch"),
  VARIANT(28, "GenerateImageToolCall", "GenerateImageArgs", "GenerateImageResult", "generate_image"),
  VARIANT(29, "RecordScreenToolCall", "RecordScreenArgs", "RecordScreenResult", "record_screen"),
  VARIANT(30, "ComputerUseToolCall", "ComputerUseArgs", "ComputerUseResult", "computer_use"),
  VARIANT(31, "WriteShellStdinToolCall", "WriteShellStdinArgs", "WriteShellStdinResult", "write_shell_stdin"),
  VARIANT(32, "ReflectToolCall", "ReflectArgs", "ReflectResult", "reflect"),
  VARIANT(33, "SetupVmEnvironmentToolCall", "SetupVmEnvironmentArgs", "SetupVmEnvironmentResult", "setup_vm_environment"),
  VARIANT(34, "TruncatedToolCall", "TruncatedArgs", "TruncatedResult", "truncated"),
  // The modern exec family. Same join point, separate identities.
  VARIANT(61, "PiReadToolCall", "PiReadToolArgs", "PiReadExecResult", "pi_read"),
  VARIANT(62, "PiBashToolCall", "PiBashToolArgs", "PiBashExecResult", "pi_bash"),
  VARIANT(63, "PiEditToolCall", "PiEditToolArgs", "PiEditExecResult", "pi_edit"),
  VARIANT(64, "PiWriteToolCall", "PiWriteToolArgs", "PiWriteExecResult", "pi_write"),
  VARIANT(65, "PiGrepToolCall", "PiGrepToolArgs", "PiGrepExecResult", "pi_grep"),
  VARIANT(66, "PiFindToolCall", "PiFindToolArgs", "PiFindExecResult", "pi_find"),
  VARIANT(67, "PiLsToolCall", "PiLsToolArgs", "PiLsExecResult", "pi_ls"),
].map((entry) => [entry.field, entry]));

/**
 * A decoded Cursor-native tool call, in the same shape the rest of the gateway
 * already reasons about.
 *
 * `variant` is carried rather than discarded so a result can be encoded back
 * into the wire arm it came from. Dropping it would mean `pi_read` in and
 * `read` out, which silently breaks the client's own tool loop.
 */
export interface CursorNativeToolCall {
  readonly variant: CursorToolVariant;
  readonly name: string;
  readonly callId: string;
  readonly arguments: Record<string, unknown>;
}

/** Which oneof arm a `ToolCall` message carries, as `(field, message)`. */
type OneofArm = { readonly field: number; readonly payload: Record<string, unknown> };

/**
 * Reads the single arm a `ToolCall` is holding.
 *
 * A oneof has exactly one populated field; a message with none is not a tool
 * call at all and is reported as `undefined` rather than guessed at. An arm
 * this layer does not know is also `undefined` — that is what leaves room for
 * MCP to claim it.
 */
export function cursorToolArm(
  toolCall: Record<string, unknown>,
): OneofArm | undefined {
  for (const [key, value] of Object.entries(toolCall)) {
    if (value === null || value === undefined) continue;
    const variant = [...CURSOR_TOOL_VARIANTS.values()].find(
      (entry) => entry.wireType.toLowerCase() === key.toLowerCase(),
    );
    if (variant === undefined) continue;
    return { field: variant.field, payload: value as Record<string, unknown> };
  }
  return undefined;
}

/**
 * Decodes one `ToolCall` into a canonical call, or `undefined` when the arm is
 * not a Cursor-native tool.
 *
 * Arguments come off the variant's `args` sub-message and are normalised to
 * canonical OpenAI-style tool arguments: snake_case keys, all the way down.
 * Cursor's own arms disagree with each other and with the OpenAI spelling, and
 * this is the gateway's translation boundary — the point where a Cursor call
 * becomes a tool call every other protocol can read. Leaving the keys as the
 * wire sent them would make the same tool mean different things depending on
 * which arm happened to carry it.
 */
export function decodeCursorNativeToolCall(
  callId: string,
  toolCall: Record<string, unknown>,
): CursorNativeToolCall | undefined {
  const arm = cursorToolArm(toolCall);
  if (arm === undefined) return undefined;
  const variant = CURSOR_TOOL_VARIANTS.get(arm.field);
  if (variant === undefined) return undefined;
  const args = arm.payload["args"];
  return {
    variant,
    name: variant.name,
    callId,
    arguments: canonicalToolArguments(args),
  };
}

/**
 * Recursive snake_case normalisation of a tool-argument value.
 *
 * OpenAI-style tool arguments are snake_case throughout, nested values
 * included, so the conversion has to walk the whole tree rather than the top
 * level — a Cursor `EditToolArgs` can carry nested objects whose keys would
 * otherwise stay camelCase and be invisible to a client reading the canonical
 * spelling. Array elements are walked for the same reason; a scalar is
 * returned untouched because there is no key to convert.
 */
export function canonicalToolArguments(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, child]) => [
      snakeCaseKey(key),
      canonicalToolValue(child),
    ]),
  );
}

function canonicalToolValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalToolValue);
  if (value !== null && typeof value === "object") return canonicalToolArguments(value);
  return value;
}

/** `someKeyName` → `some_key_name`; already-snake keys come back unchanged. */
function snakeCaseKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[\s-]+/g, "_")
    .toLowerCase();
}

/**
 * The variant whose args a host-exec frame is carrying.
 *
 * Exec frames name their payload after the args message — `read_args`,
 * `shell_args`, `pi_read_args` — not after the `ToolCall` arm, so the lookup
 * runs off `argsType`. Anything not ending in `_args` is not a tool payload
 * (`id`, `exec_id`, `request_context_args`, …) and is reported as `undefined`.
 */
export function cursorVariantForExecArgs(
  execServer: Record<string, unknown>,
): { readonly variant: CursorToolVariant; readonly args: Record<string, unknown> } | undefined {
  for (const [key, value] of Object.entries(execServer)) {
    if (value === null || value === undefined || !key.endsWith("_args")) continue;
    const wanted = key.slice(0, -"_args".length);
    const variant = [...CURSOR_TOOL_VARIANTS.values()].find((entry) =>
      entry.argsType.toLowerCase().startsWith(wanted.toLowerCase()),
    );
    if (variant === undefined) continue;
    return {
      variant,
      args: canonicalToolArguments(value),
    };
  }
  return undefined;
}

/**
 * The variant an inbound result must be encoded back into.
 *
 * Keyed by `call_id`, which is what the response carries and what the client
 * echoes on the result. Consulted before encoding so a result for a tool this
 * layer never decoded is not invented into some other variant's shape.
 */
export class CursorToolCallProvenance {
  readonly #byCallId = new Map<string, CursorToolVariant>();

  record(callId: string, variant: CursorToolVariant): void {
    this.#byCallId.set(callId, variant);
  }

  lookup(callId: string): CursorToolVariant | undefined {
    return this.#byCallId.get(callId);
  }

  /** Drops one call's provenance once its result has been encoded. */
  complete(callId: string): void {
    this.#byCallId.delete(callId);
  }
}

/**
 * A tool declaration the gateway can advertise for Cursor-native tools.
 *
 * Kept separate from `ToolDefinition`'s own name on purpose: the canonical name
 * (`pi_read`) is not the name a client's schema would use, so advertising one
 * under the other would make the call/result round trip undecidable.
 */
export function cursorNativeToolDeclaration(
  variant: CursorToolVariant,
  description: string,
): ToolDefinition {
  return {
    name: variant.name,
    description,
    jsonSchema: { type: "object", properties: {} },
  };
}
