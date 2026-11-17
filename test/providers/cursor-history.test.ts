/**
 * Cursor history: blobs, prompt records, KV channel, and record replay.
 *
 * The invariants under test:
 * 1. Blob ids are SHA-256 of content and the KV channel serves them — a
 *    `get` for an unknown blob answers empty (the server rebuilds), never
 *    fails.
 * 2. The history builder REFUSES a transcript with unpaired tool calls: "an
 *    unpaired call is stripped from every rebuilt transcript", so accepting
 *    one would silently corrupt the next turn.
 * 3. Server-record replay is byte-for-byte and route+digest gated: an edited
 *    conversation (any digest change) or a different variant (wire route
 *    change) must rebuild instead of replaying stale records.
 */
import { describe, expect, test } from "bun:test";
import {
  answerKvRequest,
  buildRootPromptMessages,
  cursorBlobId,
  cursorBlobIdHex,
  CursorBlobStore,
  CursorCheckpointCache,
  CursorServerRecordReplay,
  type CursorHistoryMessage,
} from "../../src/providers/integrations/cursor/cursor-history";

describe("Cursor history — blob store", () => {
  test("blob ids are SHA-256 of content", () => {
    const store = new CursorBlobStore();
    const data = new TextEncoder().encode("hello");
    const id = store.put(data);
    expect(cursorBlobIdHex(id)).toBe(cursorBlobIdHex(cursorBlobId(data)));
    expect(id.byteLength).toBe(32);
    expect(store.get(id)).toEqual(data);
  });

  test("a get for an unknown blob answers empty, never fails", () => {
    const store = new CursorBlobStore();
    const answer = answerKvRequest(
      { kind: "get", id: 7, blobId: cursorBlobId(new TextEncoder().encode("missing")) },
      store,
    );
    expect(answer.id).toBe(7);
    expect(answer.getBlobResult?.blobData).toBeUndefined();
  });

  test("a set stores the blob and acks", () => {
    const store = new CursorBlobStore();
    const data = new TextEncoder().encode("payload");
    const answer = answerKvRequest(
      { kind: "set", id: 8, blobId: cursorBlobId(data), blobData: data },
      store,
    );
    expect(answer.setBlobResult).toBeDefined();
    expect(store.get(cursorBlobId(data))).toEqual(data);
  });
});

describe("Cursor history — prompt record builder", () => {
  const history: CursorHistoryMessage[] = [
    { role: "system", content: "be brief" },
    { role: "user", content: [{ type: "text", text: "deploy" }] },
    {
      role: "assistant",
      content: [
        { type: "text", text: "deploying" },
        { type: "tool-call", toolCallId: "call-1", toolName: "deploy", args: { target: "prod" } },
      ],
    },
    { role: "tool", toolCallId: "call-1", toolName: "deploy", result: "ok", isError: false },
  ];

  test("each record becomes its own content-addressed blob", () => {
    const store = new CursorBlobStore();
    const built = buildRootPromptMessages(history, store);
    expect(built.rootPromptMessageIds.length).toBe(4);
    // The tool record is retrievable by its id and parses back to the shape.
    const toolId = built.rootPromptMessageIds[3]!;
    const bytes = store.get(toolId)!;
    const record = JSON.parse(new TextDecoder().decode(bytes)) as { role?: string };
    expect(record.role).toBe("tool");
  });

  test("a tool result with no matching call is refused", () => {
    const store = new CursorBlobStore();
    const orphan: CursorHistoryMessage[] = [
      { role: "user", content: [{ type: "text", text: "deploy" }] },
      { role: "tool", toolCallId: "call-999", toolName: "deploy", result: "ok", isError: false },
    ];
    expect(() => buildRootPromptMessages(orphan, store)).toThrow(/no matching tool call/);
  });

  test("a tool call with no result is refused", () => {
    const store = new CursorBlobStore();
    const dangling: CursorHistoryMessage[] = [
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "call-1", toolName: "deploy", args: {} }],
      },
    ];
    expect(() => buildRootPromptMessages(dangling, store)).toThrow(/have no result/);
  });

  test("the active user message belongs to the action, not the history builder", () => {
    // The builder only sees what the caller passes; the turn's active user
    // message is excluded upstream. A history of only past turns builds clean.
    const store = new CursorBlobStore();
    const built = buildRootPromptMessages(
      [{ role: "user", content: [{ type: "text", text: "previous question" }] }],
      store,
    );
    expect(built.rootPromptMessageIds.length).toBe(1);
  });
});

describe("Cursor history — checkpoint cache", () => {
  test("the latest checkpoint replaces the previous one", () => {
    const cache = new CursorCheckpointCache();
    cache.update({ tokenDetails: { usedTokens: 10 } });
    cache.update({ tokenDetails: { usedTokens: 20 } });
    expect(cache.state).toEqual({ tokenDetails: { usedTokens: 20 } });
  });

  test("clear drops the checkpoint", () => {
    const cache = new CursorCheckpointCache();
    cache.update({ a: 1 });
    cache.clear();
    expect(cache.state).toBeUndefined();
  });
});

describe("Cursor history — server-record replay", () => {
  const records = ['{"role":"user","content":"a"}', '{"role":"assistant","content":"b"}'];
  const route = JSON.stringify(["claude-opus-5", "claude-opus-5-high", false, []]);

  test("an unedited conversation on the same route replays byte-for-byte", () => {
    const replay = new CursorServerRecordReplay();
    const digest = "digest-1";
    replay.capture(records, route, digest);
    const resolved = replay.resolve(route, digest);
    expect(resolved).toEqual(records);
    // Byte-for-byte: the exact JSON text, not a rebuild.
    expect(resolved?.[0]).toBe(records[0]);
  });

  test("an edited conversation (digest change) rebuilds instead of replaying", () => {
    const replay = new CursorServerRecordReplay();
    replay.capture(records, route, "digest-1");
    expect(replay.resolve(route, "digest-2")).toBeUndefined();
  });

  test("a different variant (wire route change) rebuilds", () => {
    const replay = new CursorServerRecordReplay();
    replay.capture(records, route, "digest-1");
    const otherRoute = JSON.stringify(["grok-4.7", "grok-4.7", false, []]);
    expect(replay.resolve(otherRoute, "digest-1")).toBeUndefined();
  });

  test("the digest changes when any history message changes", () => {
    const base: CursorHistoryMessage[] = [
      { role: "user", content: [{ type: "text", text: "deploy" }] },
    ];
    const edited: CursorHistoryMessage[] = [
      { role: "user", content: [{ type: "text", text: "deploy now" }] },
    ];
    expect(CursorServerRecordReplay.digest(base)).not.toBe(CursorServerRecordReplay.digest(edited));
  });
});
