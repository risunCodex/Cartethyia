/**
 * Cursor external-executor tool relay.
 *
 * The invariants under test:
 * 1. The tool catalog the model sees is the CALLER's: native names are
 *    filtered out so there is one way to call each thing, and the gateway
 *    never executes a Cursor host tool (a `shell` frame can only be answered
 *    where the files live).
 * 2. Every exec-dispatched call leaves exactly one paired result — including
 *    interrupted ones — because "an unpaired call is stripped from every
 *    rebuilt transcript" and a quiet failure corrupts the next turn.
 * 3. The declared batch reconciles with `>=` counting answered and self-served
 *    calls; heartbeats keep the batch open (they never extend the quiet
 *    timer that hands held calls off).
 */
import { describe, expect, test } from "bun:test";
import {
  CursorToolRelay,
  CURSOR_NATIVE_TOOL_NAMES,
  decodeMcpCall,
  throwAnswer,
  type RelayedToolCall,
  type RelayToolDefinition,
} from "../../src/providers/integrations/cursor/cursor-relay";
import type { ExecServerMessage } from "../../src/providers/integrations/cursor/cursor-protocol/generated";

const CALLER_TOOLS: RelayToolDefinition[] = [
  { name: "bash", description: "run a command", inputSchema: { type: "object" } }, // native name: hidden
  { name: "deploy", description: "deploy the app", inputSchema: { type: "object" } },
  { name: "read", description: "read a file", inputSchema: { type: "object" } }, // native name: hidden
];

function relay(): { relay: CursorToolRelay; calls: RelayedToolCall[] } {
  const calls: RelayedToolCall[] = [];
  return { relay: new CursorToolRelay(CALLER_TOOLS, { onToolCall: (call) => calls.push(call) }), calls };
}

function execFrame(message: Partial<ExecServerMessage>): ExecServerMessage {
  return { id: 1, ...message };
}

describe("Cursor relay — requestContext handshake", () => {
  test("advertises caller tools under neutral names, native names filtered", () => {
    const { relay: r } = relay();
    const answer = r.buildRequestContextResult(1, undefined) as {
      execClientMessage: {
        requestContextResult: {
          success: { requestContext: { tools: Array<{ name?: string; providerIdentifier?: string }> } },
        },
      };
    };
    const tools =
      answer.execClientMessage.requestContextResult.success?.requestContext.tools ?? [];
    const names = tools.map((tool) => tool.name);
    expect(names).toContain("deploy");
    expect(names).not.toContain("bash"); // native
    expect(names).not.toContain("read"); // native
    // Nothing sent upstream names the gateway.
    for (const tool of tools) {
      expect(tool.providerIdentifier).toBe("pi-agent");
    }
    // The filter is the single source of native-name truth.
    expect(CURSOR_NATIVE_TOOL_NAMES.has("bash")).toBe(true);
    expect(CURSOR_NATIVE_TOOL_NAMES.has("deploy")).toBe(false);
  });

  test("the requestContext frame is answered in-band, never held", () => {
    const { relay: r, calls } = relay();
    const answers = r.handleExecServerMessage(
      execFrame({ requestContextArgs: {} }),
    );
    expect(answers.length).toBe(1);
    expect(calls.length).toBe(0); // handshake is not a tool call
  });
});

describe("Cursor relay — MCP call relay", () => {
  function mcpFrame(toolName: string, callId: string): ExecServerMessage {
    return execFrame({
      mcpArgs: {
        name: toolName,
        toolName,
        toolCallId: callId,
        args: { path: new TextEncoder().encode(JSON.stringify("/srv")) },
      },
    });
  }

  test("a tool call is held open and surfaced to the caller exactly once", () => {
    const { relay: r, calls } = relay();
    const answers = r.handleExecServerMessage(mcpFrame("deploy", "call-1"));
    expect(answers.length).toBe(0); // held open: no answer yet
    expect(r.pendingCount).toBe(1);
    expect(calls.length).toBe(1);
    expect(calls[0]?.toolName).toBe("deploy");
    expect(calls[0]?.args["path"]).toBe("/srv");
  });

  test("the result closes exactly the held frame it names", () => {
    const { relay: r } = relay();
    r.handleExecServerMessage(mcpFrame("deploy", "call-1"));
    const answers = r.collectResults([{ callId: "call-1", content: "ok", isError: false }]);
    expect(answers.length).toBe(1);
    expect(r.pendingCount).toBe(0);
    const answer = answers[0] as {
      execClientMessage: { id?: number; mcpResult: { success?: { content?: unknown[]; isError?: boolean } } };
    };
    expect(answer.execClientMessage.id).toBe(1);
    expect(answer.execClientMessage.mcpResult.success?.isError).toBe(false);
  });

  test("a result naming an unknown call is refused (no frame written)", () => {
    const { relay: r } = relay();
    r.handleExecServerMessage(mcpFrame("deploy", "call-1"));
    const answers = r.collectResults([{ callId: "call-999", content: "ok", isError: false }]);
    expect(answers.length).toBe(0);
    expect(r.pendingCount).toBe(1); // still open
  });

  test("an interrupted call is paired at flush — never left unpaired", () => {
    const { relay: r } = relay();
    r.handleExecServerMessage(mcpFrame("deploy", "call-1"));
    r.handleExecServerMessage(mcpFrame("deploy", "call-2"));
    const answers = r.flushOpenToolCalls();
    expect(answers.length).toBe(2);
    expect(r.pendingCount).toBe(0);
    for (const answer of answers) {
      const typed = answer as { execClientMessage: { mcpResult: { error?: { error?: string } } } };
      expect(typed.execClientMessage.mcpResult.error?.error).toContain("closed before this call completed");
    }
  });

  test("an approval probe is answered here and never executed", () => {
    const { relay: r, calls } = relay();
    const answers = r.handleExecServerMessage(
      execFrame({
        mcpArgs: {
          name: "deploy",
          toolName: "deploy",
          toolCallId: "call-1",
          smartModeApproval: {},
        },
      }),
    );
    expect(answers.length).toBe(1);
    expect(calls.length).toBe(0); // never surfaced: nothing to execute
  });

  test("a frame with no resolvable call id is refused as tool-not-found", () => {
    const { relay: r, calls } = relay();
    const answers = r.handleExecServerMessage(
      execFrame({ mcpArgs: { name: "deploy" } }), // no toolCallId
    );
    expect(answers.length).toBe(1);
    expect(calls.length).toBe(0);
  });

  test("a native frame the gateway cannot answer throws + stream-close", () => {
    const { relay: r } = relay();
    const answers = r.handleExecServerMessage(execFrame({ shellArgs: { command: "rm -rf /" } }));
    expect(answers.length).toBe(1);
    const answer = answers[0] as {
      execClientControlMessage: { throw: { error?: string; errorCode?: string } };
    };
    expect(answer.execClientControlMessage.throw.error).toBe("Tool not available");
    expect(answer.execClientControlMessage.throw.errorCode).toBe("exec_variant_unsupported");
  });
});

describe("Cursor relay — declared batch reconciliation", () => {
  function mcpFrame(toolName: string, callId: string): ExecServerMessage {
    return execFrame({
      mcpArgs: { name: toolName, toolName, toolCallId: callId },
    });
  }

  test("held calls hand off when the declared count is covered (>=, not ==)", () => {
    const { relay: r } = relay();
    r.handleExecServerMessage(mcpFrame("deploy", "call-1"));
    r.handleExecServerMessage(mcpFrame("deploy", "call-2"));
    // Declared 2, held 2: covered.
    r.handleInteractionUpdate({ toolRequestsListed: { callCount: 2 } }, 1_000);
    expect(r.readyToHandOff(1_500)).toBe(true);
  });

  test("calls answered before the listing still count toward it", () => {
    const { relay: r } = relay();
    // One call answered before any listing arrives.
    r.handleExecServerMessage(mcpFrame("deploy", "call-1"));
    r.collectResults([{ callId: "call-1", content: "ok", isError: false }]);
    r.handleExecServerMessage(mcpFrame("deploy", "call-2"));
    // Declared 2: answered(1) + held(1) covers it.
    r.handleInteractionUpdate({ toolRequestsListed: { callCount: 2 } }, 1_000);
    expect(r.readyToHandOff(1_500)).toBe(true);
  });

  test("self-served calls count toward the declared batch", () => {
    const { relay: r } = relay();
    r.handleExecServerMessage(mcpFrame("deploy", "call-1"));
    // A call Cursor resolved itself sends no exec frame but counts as served.
    r.handleInteractionUpdate({ toolCallStarted: {} }, 1_000);
    r.handleInteractionUpdate({ toolRequestsListed: { callCount: 2 } }, 1_000);
    expect(r.readyToHandOff(1_500)).toBe(true);
  });

  test("heartbeats keep the batch open: they never extend the quiet timer", () => {
    const { relay: r } = relay();
    r.handleExecServerMessage(mcpFrame("deploy", "call-1"));
    r.handleInteractionUpdate({ toolRequestsListed: { callCount: 5 } }, 0);
    // A stream of heartbeats: none of them is semantic progress.
    r.handleInteractionUpdate({ heartbeat: {} }, 900);
    r.handleInteractionUpdate({ heartbeat: {} }, 1_800);
    // Quiet since t=0 → handoff fires at 1s even though heartbeats continued.
    expect(r.readyToHandOff(1_100)).toBe(true);
  });

  test("a semantic frame resets the quiet window", () => {
    const { relay: r } = relay();
    r.handleExecServerMessage(mcpFrame("deploy", "call-1"));
    r.handleInteractionUpdate({ toolRequestsListed: { callCount: 5 } }, 0);
    r.handleInteractionUpdate({ toolCallStarted: {} }, 900); // semantic: resets
    expect(r.readyToHandOff(1_100)).toBe(false); // quiet only since t=900
  });
});

describe("Cursor relay — wire helpers", () => {
  test("decodeMcpCall merges JSON-bytes args and keeps the caller's name", () => {
    const call = decodeMcpCall({
      name: "deploy",
      toolName: "deploy",
      toolCallId: "call-1",
      args: {
        path: new TextEncoder().encode('"/srv"'),
        dryRun: new TextEncoder().encode("true"),
      },
    });
    expect(call?.callId).toBe("call-1");
    expect(call?.toolName).toBe("deploy");
    expect(call?.args["path"]).toBe("/srv");
    expect(call?.args["dryRun"]).toBe(true);
  });

  test("throwAnswer carries the id pair the exec channel needs", () => {
    const answer = throwAnswer(7, "exec-7", "Tool not available", "unknown_exec_variant") as {
      execClientControlMessage: { throw: { id?: number; execId?: string } };
    };
    expect(answer.execClientControlMessage.throw.id).toBe(7);
    expect(answer.execClientControlMessage.throw.execId).toBe("exec-7");
  });
});
