/**
 * Cursor protocol codec + wire constants.
 *
 * The invariants under test:
 * 1. The generated schema and the vendored `.proto` sources agree — the
 *    generator is the only writer of `generated.ts`, and a hand-edit (or a
 *    proto change without regeneration) fails the drift gate.
 * 2. Frame round-trips are byte-exact for representative shapes (oneof
 *    discrimination, maps, 64-bit counters), so a descriptor regression shows
 *    up as a wire mismatch rather than a mysterious upstream error.
 * 3. Caller headers cannot collide with the fixed request headers — a
 *    duplicate `authorization` in any casing would make node throw
 *    `ERR_HTTP2_HEADER_SINGLE_VALUE` and kill the request before it goes out.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import protobuf from "protobufjs";
import { generateCursorProtoModule, buildCursorProtoRoot } from "../../scripts/tools/generate-cursor-proto";
import { CURSOR_PROTO_DESCRIPTOR_JSON } from "../../src/providers/integrations/cursor/cursor-protocol/generated";
import type {
  AgentClientMessage,
  AgentRunRequest,
  BidiAppendRequest,
  ConversationStateStructure,
  ExecClientMessage,
} from "../../src/providers/integrations/cursor/cursor-protocol/generated";
import {
  decodeMessage,
  encodeMessage,
} from "../../src/providers/integrations/cursor/cursor-protocol/messages";
import {
  CURSOR_CLIENT_VERSION,
  CURSOR_EXTERNAL_EXECUTOR_ALLOWED_TOOLS,
  cursorClientHeaders,
  sanitizeCursorCallerHeaders,
} from "../../src/providers/integrations/cursor/cursor-wire";

describe("Cursor protocol — generated schema", () => {
  test("the committed generated module matches the vendored protos (regeneration gate)", () => {
    // Re-deriving the module from the `.proto` sources must reproduce the
    // committed file exactly; a hand-edit of generated.ts or a proto change
    // without `bun run scripts/tools/generate-cursor-proto.ts` fails here.
    const fresh = generateCursorProtoModule();
    const committed = readFileSync(
      join(import.meta.dir, "..", "..", "src", "providers", "integrations", "cursor", "cursor-protocol", "generated.ts"),
      "utf8",
    );
    expect(fresh).toBe(committed);
  });

  test("descriptor round-trips through protobuf.Root.fromJSON", () => {
    const rebuilt = protobuf.Root.fromJSON(JSON.parse(CURSOR_PROTO_DESCRIPTOR_JSON));
    rebuilt.resolveAll();
    const t = rebuilt.lookupType("agent.v1.AgentRunRequest");
    expect(t.fieldsArray.length).toBe(
      buildCursorProtoRoot().lookupType("agent.v1.AgentRunRequest").fieldsArray.length,
    );
    // Map fields must survive the JSON descriptor round-trip.
    const state = rebuilt.lookupType("agent.v1.ConversationStateStructure");
    const mapField = state.fieldsArray.find((f) => f.name === "fileStates");
    expect(mapField).toBeDefined();
    expect(mapField instanceof protobuf.MapField).toBe(true);
  });
});

describe("Cursor protocol — frame round-trips", () => {
  test("run request encodes with camelCase input and round-trips", () => {
    const request: AgentRunRequest = {
      conversationId: "conv-1",
      modelDetails: { modelId: "claude-opus-5-high" },
      requestedModel: {
        modelId: "claude-opus-5-high",
        parameters: [{ id: "reasoning", value: "high" }],
      },
    };
    const bytes = encodeMessage("agent.v1.AgentRunRequest", request as Record<string, unknown>);
    const back = decodeMessage<AgentRunRequest>("agent.v1.AgentRunRequest", bytes);
    expect(back.conversationId).toBe("conv-1");
    expect(back.modelDetails?.modelId).toBe("claude-opus-5-high");
    expect(back.requestedModel?.parameters).toEqual([{ id: "reasoning", value: "high" }]);
  });

  test("oneof discrimination: only the set member materialises", () => {
    const clientMessage: AgentClientMessage = { clientHeartbeat: {} };
    const bytes = encodeMessage("agent.v1.AgentClientMessage", clientMessage as Record<string, unknown>);
    const back = decodeMessage<AgentClientMessage>("agent.v1.AgentClientMessage", bytes);
    expect(back.clientHeartbeat).toBeDefined();
    // A decoded oneof leaves the other members absent — pump code branches on
    // presence, so defaults must not fabricate them.
    expect(back.runRequest).toBeUndefined();
    expect(back.execClientMessage).toBeUndefined();
  });

  test("nested exec result round-trips through the oneof", () => {
    const exec: ExecClientMessage = {
      id: 7,
      execId: "exec-7",
      shellResult: { success: { command: "ls", exitCode: 0, stdout: "ok" } },
    };
    const bytes = encodeMessage("agent.v1.ExecClientMessage", exec as Record<string, unknown>);
    const back = decodeMessage<ExecClientMessage>("agent.v1.ExecClientMessage", bytes);
    expect(back.id).toBe(7);
    expect(back.execId).toBe("exec-7");
    expect(back.shellResult?.success?.stdout).toBe("ok");
    expect(back.readResult).toBeUndefined();
  });

  test("map fields round-trip (KV args style map<string, bytes>)", () => {
    const state: ConversationStateStructure = {
      fileStates: {
        "a.txt": new Uint8Array([1, 2, 3]) as unknown as string,
      },
    };
    const bytes = encodeMessage(
      "agent.v1.ConversationStateStructure",
      state as Record<string, unknown>,
    );
    const back = decodeMessage<ConversationStateStructure>(
      "agent.v1.ConversationStateStructure",
      bytes,
    );
    expect(back.fileStates?.["a.txt"]).toEqual(new Uint8Array([1, 2, 3]));
  });

  test("BidiAppendRequest carries a monotonic seqno and binary frame payload", () => {
    const append: BidiAppendRequest = {
      requestId: { requestId: "req-1" },
      appendSeqno: 3,
      dataBinary: new Uint8Array([0x0a, 0x00]) as unknown as string,
    };
    const bytes = encodeMessage("aiserver.v1.BidiAppendRequest", append as Record<string, unknown>);
    const back = decodeMessage<BidiAppendRequest>("aiserver.v1.BidiAppendRequest", bytes);
    expect(back.requestId?.requestId).toBe("req-1");
    expect(back.appendSeqno).toBe(3);
    expect(back.dataBinary).toEqual(new Uint8Array([0x0a, 0x00]));
  });
});

describe("Cursor wire — header policy", () => {
  test("client headers announce the CLI identity exactly once", () => {
    const headers = cursorClientHeaders("token-1");
    expect(headers["authorization"]).toBe("Bearer token-1");
    expect(headers["x-cursor-client-type"]).toBe("cli");
    expect(headers["x-cursor-client-version"]).toBe(CURSOR_CLIENT_VERSION);
    expect(headers["x-ghost-mode"]).toBe("true");
    expect(headers["content-type"]).toBe("application/proto");
  });

  test("caller headers cannot shadow fixed request headers (any casing)", () => {
    const sanitized = sanitizeCursorCallerHeaders({
      Authorization: "Bearer attacker",
      "X-Cursor-Client-Version": "spoof",
      TE: "trailers",
      Connection: "keep-alive",
      ":authority": "evil.example",
      "content-length": "999",
      "x-trace-id": "keep-me",
    });
    expect(sanitized["authorization"]).toBeUndefined();
    expect(sanitized["x-cursor-client-version"]).toBeUndefined();
    expect(sanitized["te"]).toBeUndefined();
    expect(sanitized["connection"]).toBeUndefined();
    expect(sanitized[":authority"]).toBeUndefined();
    expect(sanitized["content-length"]).toBeUndefined();
    // Unrelated headers pass through, lower-cased.
    expect(sanitized["x-trace-id"]).toBe("keep-me");
  });

  test("external-executor toolset disables every native tool server-side", () => {
    // Only MCP calls + Cursor's own catalog lookup may run; native tools
    // (shell/read/write/...) would require local file access the gateway
    // does not have.
    expect(CURSOR_EXTERNAL_EXECUTOR_ALLOWED_TOOLS).toBe("mcp_tool_call,get_mcp_tools_tool_call");
  });
});
