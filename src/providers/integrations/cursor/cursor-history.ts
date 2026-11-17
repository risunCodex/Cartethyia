/**
 * Cursor history: content-addressed blobs, the prompt record builder, and the
 * KV channel the server pulls them over.
 *
 * A Run's `conversation_state.root_prompt_messages_json` is a list of
 * **blob ids** — the SHA-256 (32 raw bytes) of each JSON message record in
 * Cursor's Vercel-AI-SDK-shaped format. The records themselves never ride in
 * the request: the server fetches what it needs over the same stream's KV
 * channel (`get_blob_args` → `get_blob_result`, `set_blob_args` →
 * `set_blob_result`). `turns[]` is display metadata built from the same blobs.
 *
 * Record shapes (one JSON object per blob):
 * - `{role:"system", content}` — one blob per system prompt (separate blobs
 *   let the server's blob cache hit per entry).
 * - `{role:"user", content:[{type:"text",text}|{type:"image",image,mediaType}]}`
 * - `{role:"assistant", content:[{type:"text",text}|{type:"tool-call",…}]}`
 * - `{role:"tool", id, content:[{type:"tool-result",toolName,toolCallId,
 *   result,isError}]}`
 *
 * The active user message is never in the history — it rides in the run
 * request's action. Every exec-dispatched call must leave exactly one tool
 * record ("an unpaired call is stripped from every rebuilt transcript"), so
 * the builder refuses a history with unmatched tool calls.
 *
 * `turns[]` is the upstream's rehydration format, not display-only metadata:
 * each entry is a protobuf-encoded `ConversationTurnStructure` blob whose
 * `user_message` names a `UserMessage` blob and whose steps name
 * `ConversationStep` blobs (assistant texts, and `toolCall` steps carrying the
 * MCP call plus its paired MCP result). A malformed turn blob crashes the
 * server mid-rehydration, so the shapes mirror the reference implementation's
 * live-verified builder exactly.
 *
 * **Server-record replay**: when a completed turn's final checkpoint covers
 * everything it produced, the server's own `rootPromptMessagesJson` records
 * (JSON text stamped with its `requestId`) can be captured and replayed
 * byte-for-byte on later turns — the strongest cache there is. Anything that
 * edits the conversation (pruning, compaction) invalidates the capture and
 * the next turn rebuilds from content.
 */
import { createHash } from "node:crypto";
import { encodeMessage } from "./cursor-protocol/messages";
import { encodeProtoJsonValue } from "./cursor-protocol/json-value";

/** A blob id is the raw SHA-256 of the blob's bytes (32 bytes). */
export type CursorBlobId = Uint8Array;

/** Computes a blob id the way Cursor's server does: SHA-256 of the content. */
export function cursorBlobId(data: Uint8Array): CursorBlobId {
  return new Uint8Array(createHash("sha256").update(data).digest());
}

/** Hex form of a blob id, for map keys and logs. */
export function cursorBlobIdHex(id: CursorBlobId): string {
  return Buffer.from(id).toString("hex");
}

/**
 * Per-conversation content-addressed blob store.
 *
 * The server pulls blobs over the KV channel, so the store is the authority
 * for what a run's history contains. Bounded by conversation lifetime: a
 * conversation's store dies with its cache entry.
 */
export class CursorBlobStore {
  readonly #blobs = new Map<string, Uint8Array>();

  /** Stores `data` under its content id and returns the id. */
  put(data: Uint8Array): CursorBlobId {
    const id = cursorBlobId(data);
    this.#blobs.set(cursorBlobIdHex(id), data);
    return id;
  }

  /** Stores a JSON record and returns its blob id. */
  putJson(record: unknown): CursorBlobId {
    return this.put(new TextEncoder().encode(JSON.stringify(record)));
  }

  get(id: CursorBlobId | string): Uint8Array | undefined {
    const key = typeof id === "string" ? id : cursorBlobIdHex(id);
    return this.#blobs.get(key);
  }

  get size(): number {
    return this.#blobs.size;
  }
}

// ── history message model ──

export type CursorHistoryPart =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image"; readonly mediaType: string; readonly data: string }
  | { readonly type: "tool-call"; readonly toolCallId: string; readonly toolName: string; readonly args: unknown };

export type CursorHistoryMessage =
  | { readonly role: "system"; readonly content: string }
  | { readonly role: "user"; readonly content: ReadonlyArray<Extract<CursorHistoryPart, { type: "text" | "image" }>> }
  | { readonly role: "assistant"; readonly content: ReadonlyArray<CursorHistoryPart> }
  | {
      readonly role: "tool";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly result: unknown;
      readonly isError: boolean;
    };

/** The built root-prompt blob ids plus the blob payloads they name. */
export interface CursorHistoryBuild {
  /** Blob ids in order, for `conversation_state.root_prompt_messages_json`. */
  readonly rootPromptMessageIds: CursorBlobId[];
  /** Display metadata blob ids, for `conversation_state.turns`. */
  readonly turnIds: CursorBlobId[];
}

/**
 * Builds the root-prompt blob ids for one conversation history.
 *
 * Each record becomes its own blob (per-entry cache hits on the server).
 * A history with a tool record whose call id never appeared as a tool-call
 * is refused: the transcript would rebuild with an orphan result and the
 * server strips it, silently corrupting the next turn.
 */
export function buildRootPromptMessages(
  history: readonly CursorHistoryMessage[],
  store: CursorBlobStore,
): CursorHistoryBuild {
  const openCalls = new Set<string>();
  for (const message of history) {
    if (message.role === "assistant") {
      for (const part of message.content) {
        if (part.type === "tool-call") openCalls.add(normalizeCursorToolCallId(part.toolCallId));
      }
    } else if (message.role === "tool") {
      if (!openCalls.delete(normalizeCursorToolCallId(message.toolCallId))) {
        throw new Error(
          `cursor history: tool result ${message.toolCallId} has no matching tool call (an unpaired call is stripped from every rebuilt transcript)`,
        );
      }
    }
  }
  if (openCalls.size > 0) {
    throw new Error(
      `cursor history: ${openCalls.size} tool call(s) have no result (${[...openCalls].join(", ")})`,
    );
  }

  const rootPromptMessageIds: CursorBlobId[] = [];
  for (const message of history) {
    rootPromptMessageIds.push(store.putJson(recordFor(message)));
  }
  return { rootPromptMessageIds, turnIds: buildConversationTurns(history, store) };
}

/**
 * Builds the `turns` blobs: one `ConversationTurnStructure` per user turn.
 *
 * The shape is the upstream's own rehydration format and every member is a
 * protobuf-encoded blob, not JSON: `user_message` names a `UserMessage`
 * message, and each step names a `ConversationStep` (an assistant text, or a
 * `toolCall` step carrying the MCP call and — when history already holds the
 * result — its paired MCP result). A turn blob that does not decode, or one
 * whose `user_message` is not a blob id, crashes the server mid-rehydration
 * ("premature EOF"), which is what the previous JSON-placeholder shape did.
 * Shapes mirror the reference implementation's live-verified builder.
 */
function buildConversationTurns(
  history: readonly CursorHistoryMessage[],
  store: CursorBlobStore,
): CursorBlobId[] {
  const toolResults = new Map<string, Extract<CursorHistoryMessage, { role: "tool" }>>();
  for (const message of history) {
    if (message.role === "tool") toolResults.set(message.toolCallId, message);
  }

  const turnIds: CursorBlobId[] = [];
  let index = 0;
  while (index < history.length) {
    const message = history[index]!;
    if (message.role !== "user") {
      index += 1;
      continue;
    }
    const text = message.content
      .map((part) => (part.type === "text" ? part.text.trim() : ""))
      .filter((part) => part.length > 0)
      .join("\n");
    const images = message.content.filter((part) => part.type === "image");
    if (text.length === 0 && images.length === 0) {
      index += 1;
      continue;
    }

    const seed = `u:${turnIds.length}:${text}`;
    const userMessage: Record<string, unknown> = {
      text,
      messageId: deterministicUuid(seed),
    };
    if (images.length > 0) {
      userMessage["selectedContext"] = {
        selectedImages: images.map((part, imageIndex) => ({
          uuid: deterministicUuid(`${seed}:${imageIndex}`),
          mimeType: part.mediaType,
          data: Buffer.from(part.data, "base64"),
        })),
      };
    }

    const stepBlobIds: CursorBlobId[] = [];
    index += 1;
    while (index < history.length && history[index]!.role !== "user") {
      const stepMessage = history[index]!;
      if (stepMessage.role === "assistant") {
        for (const part of stepMessage.content) {
          if (part.type === "text") {
            if (part.text.length === 0) continue;
            stepBlobIds.push(
              store.put(encodeMessage("agent.v1.ConversationStep", { assistantMessage: { text: part.text } })),
            );
          } else if (part.type === "tool-call") {
            const callId = normalizeCursorToolCallId(part.toolCallId);
            const toolRecord = toolResults.get(part.toolCallId);
            stepBlobIds.push(
              store.put(
                encodeMessage("agent.v1.ConversationStep", {
                  toolCall: {
                    toolCallId: callId,
                    tool: {
                      mcpToolCall: {
                        args: {
                          name: part.toolName,
                          args: mcpArgumentsFor(part.args),
                          toolCallId: callId,
                          providerIdentifier: "pi-agent",
                          toolName: part.toolName,
                        },
                        ...(toolRecord === undefined ? {} : { result: mcpResultFor(toolRecord) }),
                      },
                    },
                  },
                }),
              ),
            );
          }
        }
      }
      index += 1;
    }

    turnIds.push(
      store.put(
        encodeMessage("agent.v1.ConversationTurnStructure", {
          agentConversationTurn: {
            userMessage: store.put(encodeMessage("agent.v1.UserMessage", userMessage)),
            steps: stepBlobIds,
          },
        }),
      ),
    );
  }
  return turnIds;
}

/** Tool-call ids must stay within the upstream's `^[a-zA-Z0-9_-]+$` charset. */
function normalizeCursorToolCallId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/** A uuid-shaped id derived from content, stable across rebuilds. */
function deterministicUuid(seed: string): string {
  const digest = createHash("sha256").update(seed).digest();
  const bytes = digest.subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Encodes one tool call's arguments as `google.protobuf.Value` bytes per key. */
function mcpArgumentsFor(args: unknown): Record<string, Uint8Array> {
  const source = typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {};
  const encoded: Record<string, Uint8Array> = {};
  for (const [key, value] of Object.entries(source)) {
    encoded[key] = encodeProtoJsonValue(value);
  }
  return encoded;
}

/** The paired MCP result for one tool record (the error branch when isError). */
function mcpResultFor(record: Extract<CursorHistoryMessage, { role: "tool" }>): Record<string, unknown> {
  const text = typeof record.result === "string" ? record.result : JSON.stringify(record.result ?? "");
  return record.isError
    ? { error: { error: text } }
    : { success: { content: [{ text: { text } }] } };
}

function recordFor(message: CursorHistoryMessage): unknown {
  switch (message.role) {
    case "system":
      return { role: "system", content: message.content };
    case "user":
      return {
        role: "user",
        content: message.content.map((part) =>
          part.type === "text"
            ? { type: "text", text: part.text }
            : { type: "image", image: `data:${part.mediaType};base64,${part.data}`, mediaType: part.mediaType },
        ),
      };
    case "assistant":
      return {
        role: "assistant",
        content: message.content.flatMap(
          (
            part,
          ): Array<
            | { type: "text"; text: string }
            | { type: "tool-call"; toolCallId: string; toolName: string; args: unknown }
          > => {
            if (part.type === "text") return part.text.length > 0 ? [{ type: "text", text: part.text }] : [];
            if (part.type === "tool-call") {
              return [
                {
                  type: "tool-call",
                  toolCallId: normalizeCursorToolCallId(part.toolCallId),
                  toolName: part.toolName,
                  args: part.args,
                },
              ];
            }
            return [];
          },
        ),
      };
    case "tool": {
      // The result field is the transcript's text form; `isError` is sent
      // only when true (the reference client omits it otherwise).
      const text = typeof message.result === "string" ? message.result : JSON.stringify(message.result ?? "");
      return {
        role: "tool",
        id: normalizeCursorToolCallId(message.toolCallId),
        content: [
          {
            type: "tool-result",
            toolName: message.toolName,
            toolCallId: normalizeCursorToolCallId(message.toolCallId),
            result: text,
            ...(message.isError ? { isError: true } : {}),
          },
        ],
      };
    }
  }
}

// ── KV channel ──

/** One KV server frame asking for or pushing a blob. */
export type CursorKvRequest =
  | { readonly kind: "get"; readonly id: number; readonly blobId: Uint8Array }
  | { readonly kind: "set"; readonly id: number; readonly blobId: Uint8Array; readonly blobData: Uint8Array };

/** The client answer for one KV request, ready to wrap in a KvClientMessage. */
export interface CursorKvAnswer {
  readonly id: number;
  readonly getBlobResult?: { readonly blobData: Uint8Array | undefined };
  readonly setBlobResult?: Record<string, never>;
}

/**
 * Answers one KV request from the blob store.
 *
 * A `get` for an unknown blob answers with no data — the server treats an
 * empty `get_blob_result` as "rebuild that record", which is the correct
 * degradation for a store that lost an entry. A `set` stores and acks.
 */
export function answerKvRequest(request: CursorKvRequest, store: CursorBlobStore): CursorKvAnswer {
  if (request.kind === "get") {
    return { id: request.id, getBlobResult: { blobData: store.get(request.blobId) } };
  }
  store.put(request.blobData);
  return { id: request.id, setBlobResult: {} };
}

// ── checkpoint cache ──

/**
 * The latest conversation checkpoint seen on a stream.
 *
 * `conversation_checkpoint_update` carries the server's authoritative
 * `ConversationStateStructure`; the next request replays it verbatim ("its
 * turns hold the partial turn the server resumes from, which context.messages
 * cannot rebuild"). A checkpoint is also the replay-safety marker for the
 * retry loop: a checkpoint arriving after every decoded side effect means the
 * attempt can be replayed from the checkpoint instead of the caller's view.
 */
export class CursorCheckpointCache {
  #state: object | undefined;
  /** Blob ids the checkpoint references (the server may pull them again). */
  #blobIds: CursorBlobId[] = [];

  update(state: object, blobIds: readonly CursorBlobId[] = []): void {
    this.#state = state;
    this.#blobIds = [...blobIds];
  }

  get state(): object | undefined {
    return this.#state;
  }

  get blobIds(): readonly CursorBlobId[] {
    return this.#blobIds;
  }

  clear(): void {
    this.#state = undefined;
    this.#blobIds = [];
  }
}

// ── server-record replay ──

/**
 * Captures the server's own history records for byte-for-byte replay.
 *
 * When a completed turn's final checkpoint covers everything it produced, the
 * server's `rootPromptMessagesJson` records can be stored exactly as the
 * server wrote them (JSON text stamped with its `requestId`) and replayed on
 * the next turn — no rebuild drift possible. The capture is keyed by the wire
 * route (model + parameters + max-mode) and a content digest: anything that
 * edits the conversation invalidates both and the next turn rebuilds.
 */
export class CursorServerRecordReplay {
  #records: string[] | undefined;
  #wireRoute = "";
  #digest = "";

  /**
   * Captures records from a completed turn. `digest` must cover the full
   * conversation content (the caller hashes its history) so an edit is
   * detected rather than silently replayed.
   */
  capture(records: readonly string[], wireRoute: string, digest: string): void {
    this.#records = [...records];
    this.#wireRoute = wireRoute;
    this.#digest = digest;
  }

  /**
   * Returns the captured records when the route and digest still match —
   * i.e. the conversation is unedited and the same variant is running.
   */
  resolve(wireRoute: string, digest: string): readonly string[] | undefined {
    if (this.#records === undefined) return undefined;
    if (this.#wireRoute !== wireRoute || this.#digest !== digest) return undefined;
    return this.#records;
  }

  /** Content digest over history parts — the edit detector. */
  static digest(history: readonly CursorHistoryMessage[]): string {
    const hash = createHash("sha256");
    for (const message of history) {
      hash.update(JSON.stringify(message));
    }
    return hash.digest("hex");
  }

  clear(): void {
    this.#records = undefined;
    this.#wireRoute = "";
    this.#digest = "";
  }
}
