/**
 * External-executor tool relay: every tool call reaches the caller, and
 * Cursor's built-in toolset never runs here.
 *
 * A gateway cannot answer Cursor's native host tools — a `shell`/`read` frame
 * can only be answered where the files live. The run therefore announces
 * itself as external-executor (`x-cursor-agent-allowed-tools:
 * mcp_tool_call,get_mcp_tools_tool_call`, set in cursor-wire.ts), which turns
 * Cursor's built-ins off server-side and leaves two channels:
 *
 * - **`request_context_args`** — the tool-catalog handshake. Answered with the
 *   caller's tools as `McpToolDefinition[]` (providerIdentifier + toolName +
 *   JSON input schema). Every caller tool is advertised verbatim — the
 *   allowed-tools header has already disabled the native toolset server-side,
 *   so even a caller tool named like a native (`read`, `todo`) routes through
 *   `mcp_tool_call` and must not be dropped from the catalog. There is no
 *   `mcp_meta_tool_options` field in this protocol: the catalog rides in
 *   `request_context`, not the run request.
 * - **`mcp_args`** — a tool call under the caller's own name and schema. The
 *   call is held open (the exec frame is not answered yet) and surfaced to the
 *   caller; the result comes back with the next request and is written into
 *   the held frame as `mcp_result`.
 *
 * **The declared-batch rules** (the quirks that break naive relays):
 * `ToolRequestsListedUpdate{call_count}` is the model's declared batch for the
 * step. Held calls are handed to the caller when `held + served + answered >=
 * listed`, where `served` counts calls Cursor resolved itself (they send no
 * exec frame). Calls answered before the listing still count toward it — the
 * arithmetic is `>=`, never `==`. And a heartbeat keeps a counted batch open:
 * only a non-heartbeat frame extends the quiet timer (1s), which hands off
 * held calls when Cursor goes silent even without a listing.
 *
 * **Pairing is mandatory**: every exec-dispatched call leaves exactly one
 * `toolResult` in the transcript ("an unpaired call is stripped from every
 * rebuilt transcript"), including interrupted and rejected ones. The flush
 * path pairs whatever is still open when the stream ends.
 */
import { decodeProtoJsonValue, encodeProtoJsonValue } from "./cursor-protocol/json-value";
import type {
  ExecServerMessage,
  McpArgs,
  McpToolDefinition,
  RequestContext,
} from "./cursor-protocol/generated";

/** One caller tool as advertised in the requestContext handshake. */
export interface RelayToolDefinition {
  readonly name: string;
  readonly description: string;
  /** JSON Schema for the arguments object. */
  readonly inputSchema: Record<string, unknown>;
}

/** One held tool call awaiting its result. */
export interface RelayedToolCall {
  /** Cursor's exec call id — the result must name it exactly. */
  readonly callId: string;
  /** The caller's tool name (never a Cursor native name). */
  readonly toolName: string;
  readonly args: Record<string, unknown>;
}

/** What the relay tells the caller and the stream layer. */
export interface RelaySink {
  /** A tool call is ready for the caller. Called once per call. */
  onToolCall(call: RelayedToolCall): void;
}

/** Answer frames the relay produces, in the transport's client-message shape. */
export type RelayAnswer = Record<string, unknown>;

/** How long held calls may sit unanswered before handoff (Cursor going quiet). */
export const CURSOR_RELAY_QUIET_MS = 1_000;

interface HeldCall {
  readonly id: number;
  readonly execId: string | undefined;
  readonly call: RelayedToolCall;
  answered: boolean;
}

/** The slice of `InteractionUpdate` the relay tracks. */
export interface RelayInteractionUpdate {
  readonly toolRequestsListed?: { readonly callCount?: number } | undefined;
  readonly toolCallStarted?: unknown;
  readonly heartbeat?: unknown;
}

/**
 * The per-run relay state machine.
 *
 * One instance per Run stream. The pump feeds exec/interaction frames in and
 * collects `RelayAnswer`s out; the transport writes them. Held calls are the
 * external-executor's open tool batch — the next request's results close them.
 */
export class CursorToolRelay {
  readonly #tools: RelayToolDefinition[];
  readonly #sink: RelaySink;
  readonly #held = new Map<string, HeldCall>();
  /** Calls answered before `toolRequestsListed` arrived. */
  #answeredCount = 0;
  /** Calls Cursor resolved itself (toolCallStarted with no exec frame). */
  #servedCount = 0;
  /** The model's declared batch for the step, when it declared one. */
  #listed: number | undefined;
  #lastSemanticAt = 0;
  /** False until a non-heartbeat frame arrives; quiet never fires before that. */
  #hasSemantics = false;

  constructor(tools: RelayToolDefinition[], sink: RelaySink) {
    this.#tools = tools;
    this.#sink = sink;
  }

  /** Held calls awaiting their results (keyed by Cursor call id). */
  get pending(): ReadonlyMap<string, HeldCall> {
    return this.#held;
  }

  get pendingCount(): number {
    return this.#held.size;
  }

  /**
   * The calls currently held open, in the order they were held.
   *
   * This is the park payload — the batch the caller must answer. It is NOT
   * the lifetime history of surfaced calls: a pump that relayed earlier
   * rounds keeps those answered and closed, and parking with them included
   * would make every later resume mismatch and rebuild.
   */
  heldCalls(): RelayedToolCall[] {
    return [...this.#held.values()].map((held) => held.call);
  }

  /**
   * The requestContext handshake answer: the caller's tools as MCP
   * definitions, advertised verbatim.
   */
  buildRequestContextResult(id: number, execId: string | undefined): RelayAnswer {
    const tools: McpToolDefinition[] = this.#tools
      .map((tool) => ({
        name: tool.name,
        // The provider identifier is ours to choose and is echoed back on
        // every `mcp_args` call. "pi-agent" is the reference client's
        // live-verified literal; a reserved-looking value stalled the turn.
        providerIdentifier: "pi-agent",
        toolName: tool.name,
        description: tool.description,
        // `inputSchema` carries `google.protobuf.Value` bytes, not JSON text —
        // a text-encoded schema hangs the turn before the model starts
        // (verified live 2026-11-17).
        inputSchema: encodeProtoJsonValue(tool.inputSchema ?? {}),
      }));
    const requestContext: RequestContext = {
      rules: [],
      tools,
    };
    // `requestContextResult` is a oneof (`success` | `error` | `rejected`);
    // the context rides `success`. Setting the bare `requestContext` field
    // leaves the oneof unset, which the server reads as a failed handshake
    // ("Failed to get request context") — verified live 2026-11-17.
    return {
      execClientMessage: {
        id,
        ...(execId === undefined ? {} : { execId }),
        requestContextResult: { success: { requestContext } },
      },
    };
  }

  /**
   * Feeds one exec frame. Returns the answer frames to write now (the
   * requestContext handshake, approval probes, rejected shapes) and holds
   * `mcp_args` calls for the caller.
   */
  handleExecServerMessage(message: ExecServerMessage, now: number = Date.now()): RelayAnswer[] {
    // Any exec frame is semantic activity: only heartbeats leave the quiet
    // timer running (a heartbeat keeps a counted batch open, never extends it).
    this.#lastSemanticAt = now;
    this.#hasSemantics = true;
    const id = message.id ?? 0;
    const execId = message.execId;
    const answers: RelayAnswer[] = [];

    if (message.requestContextArgs !== undefined) {
      answers.push(this.buildRequestContextResult(id, execId));
      return answers;
    }

    const mcp = message.mcpArgs;
    if (mcp !== undefined) {
      // A smart-mode approval-only frame is a gate probe, not a call: Cursor
      // waits for the answer before emitting the real call, so an unanswered
      // or blanket-rejected probe strands the tool turn before it starts.
      // The caller declared the catalog, so an advertised tool is approved;
      // anything unresolvable is rejected (reference behavior, and the
      // pre-deletion provider's allowlist precheck rule).
      if (mcp.smartModeApprovalOnly === true) {
        const probe = decodeMcpCall(mcp);
        const declared = probe !== undefined && this.#tools.some((tool) => tool.name === probe.toolName);
        answers.push(
          this.#mcpAnswer(
            id,
            execId,
            declared
              ? { approved: {} }
              : { rejected: { reason: "tool not declared by the caller" } },
          ),
        );
        return answers;
      }
      const call = decodeMcpCall(mcp);
      if (call === undefined) {
        answers.push(
          this.#mcpAnswer(id, execId, {
            toolNotFound: { name: mcp.name ?? "", availableTools: this.#tools.map((tool) => tool.name) },
          }),
        );
        return answers;
      }
      // A real call that also carries the approval oneof still holds: the
      // caller's own declaration is the approval, and its result arrives
      // with the next request.
      this.#held.set(call.callId, { id, execId, call, answered: false });
      this.#sink.onToolCall(call);
      return answers; // held open: the result comes with the next request
    }

    // Anything else is a native/unsupported frame the gateway cannot answer.
    answers.push(throwAnswer(id, execId, "Tool not available", "exec_variant_unsupported"));
    return answers;
  }

  /**
   * Feeds one interaction update; tracks the declared batch and the quiet
   * timer. Heartbeats never extend the quiet window.
   */
  handleInteractionUpdate(message: RelayInteractionUpdate, now: number = Date.now()): void {
    if (message.heartbeat !== undefined) return; // keeps a batch open, never progress
    this.#lastSemanticAt = now;
    this.#hasSemantics = true;
    if (message.toolRequestsListed?.callCount !== undefined) {
      this.#listed = message.toolRequestsListed.callCount;
    }
    // A call Cursor started without an exec frame is served by Cursor itself.
    if (message.toolCallStarted !== undefined) {
      this.#servedCount += 1;
    }
  }

  /**
   * Whether the held batch is ready to hand off: the declared count is
   * covered (`>=`, counting answered and self-served calls), or Cursor has
   * gone quiet on the held calls.
   */
  readyToHandOff(now: number = Date.now()): boolean {
    if (this.#held.size === 0) return false;
    const held = this.#held.size;
    const covered = held + this.#servedCount + this.#answeredCount;
    if (this.#listed !== undefined && covered >= this.#listed) return true;
    return this.#hasSemantics && now - this.#lastSemanticAt >= CURSOR_RELAY_QUIET_MS;
  }

  /**
   * Writes results for held calls into the stream. Each result closes exactly
   * one held frame; a result naming an unknown call is refused.
   */
  collectResults(
    results: ReadonlyArray<{ callId: string; content: string; isError: boolean }>,
  ): RelayAnswer[] {
    const answers: RelayAnswer[] = [];
    for (const result of results) {
      const held = this.#held.get(result.callId);
      if (held === undefined) continue; // unknown call: refuse the result, answer nothing
      answers.push(
        this.#mcpAnswer(held.id, held.execId, {
          success: {
            // Each content item wraps its payload in a text/image oneof
            // (`McpToolResultContentItem.text = McpTextContent{ text }`).
            content: [{ text: { text: result.content } }],
            isError: result.isError,
          },
        }),
      );
      held.answered = true;
      this.#held.delete(result.callId);
      this.#answeredCount += 1;
    }
    // The resumed turn starts a new step. When the handed-off step was
    // server-declared, its listing already accounted for the just-answered
    // calls, so the step counters reset — the next listing re-declares its
    // own count, and keeping the old totals would satisfy it immediately,
    // firing the next handoff before the whole new batch arrived. When the
    // step was never declared (quiet-timer handoff), the totals stay so a
    // late listing that still covers the same step reconciles.
    if (this.#listed !== undefined) {
      this.#listed = undefined;
      this.#servedCount = 0;
      this.#answeredCount = 0;
    }
    return answers;
  }

  /**
   * Pairs every call still open at stream end: an unpaired call is stripped
   * from every rebuilt transcript, so a quiet failure here would silently
   * corrupt the next turn's history.
   */
  flushOpenToolCalls(): RelayAnswer[] {
    const answers: RelayAnswer[] = [];
    for (const [callId, held] of this.#held) {
      answers.push(
        this.#mcpAnswer(held.id, held.execId, {
          error: { error: `The connection to Cursor closed before this call completed (${callId}).` },
        }),
      );
    }
    this.#held.clear();
    return answers;
  }

  #mcpAnswer(
    id: number,
    execId: string | undefined,
    result: Record<string, unknown>,
  ): RelayAnswer {
    return {
      execClientMessage: {
        id,
        ...(execId === undefined ? {} : { execId }),
        mcpResult: result,
      },
    };
  }
}

/** The exec-frame throw + stream-close pair for unanswerable frames. */
export function throwAnswer(
  id: number,
  execId: string | undefined,
  error: string,
  errorCode: string,
): RelayAnswer {
  return {
    execClientControlMessage: {
      throw: {
        id,
        ...(execId === undefined ? {} : { execId }),
        error,
        errorCode,
      },
    },
  };
}

/**
 * Decodes one `mcp_args` frame into a caller-facing tool call.
 *
 * The `args` map carries JSON bytes per key (the wire's
 * `map<string, bytes(JSON)>`); values are parsed and merged into one object
 * keyed by the original names. A call with no resolvable tool name is refused
 * by the caller of this function.
 */
export function decodeMcpCall(mcp: McpArgs): RelayedToolCall | undefined {
  const toolName = mcp.toolName?.trim() || mcp.name?.trim();
  const callId = mcp.toolCallId?.trim();
  if (!toolName || !callId) return undefined;
  const args: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(mcp.args ?? {})) {
    args[key] = typeof value === "string"
      ? tryJsonParse(value)
      : decodeProtoJsonValue(value as Uint8Array);
  }
  return { callId, toolName, args };
}

/** Parses a JSON string, returning the original text when it is not JSON. */
function tryJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}
