// Cursor provider facade: the `ProviderAdapter` boundary over the Agent
// Service Run wire.
//
// One dispatch maps to one turn. A turn is either:
//
// - **in-band resume** — the previous request's Run is still parked with held
//   tool calls, this request brings exactly one result per held call, and the
//   same stream continues (`canResumeParkedRun` gates every condition);
// - **a fresh Run** — history becomes SHA-256 blob records served over the KV
//   channel, the caller's tools are advertised through the requestContext
//   handshake, and `runCursorTurn` owns transport choice, heartbeats, and the
//   replay-safe retry policy.
//
// The external-executor relay means the gateway never answers a Cursor native
// tool: held `mcp_args` calls are surfaced to the caller, the dispatch ends
// with a tool-use terminal, and the Run stays parked (heartbeats keep its
// counted batch open) until the results arrive with the next request. The
// routing lease travels with the parked run via
// `AttemptLeaseOwnership.transferToProviderSession`, so the account slot is
// held exactly as long as the upstream stream is alive.
//
// Server-record replay is scoped to what this facade can verify: the
// checkpoint captured at a clean turn end is remembered byte-for-byte under
// the wire route plus the digest of the history that produced it, and a later
// request with the same digest replays those records instead of rebuilding.
// Any edit rebuilds from content, which is always correct.
import { randomUUID } from "node:crypto";
import { resolveCursorClientVersion, resolveCursorHeartbeatMs, resolveCursorWireTrace } from "../../../config/runtime";
import { log } from "../../../observability/logger";
import {
  canContainToolResult,
  joinTextParts,
  toolCallParts,
  toolResultParts,
  type CanonicalEvent,
  type CanonicalRequest,
  type ContentPart,
  type UsageRecord,
} from "../../../protocol/canonical-model";
import type { ValidatedOutboundHttp2Bidi } from "../../../network/bidi";
import {
  readCredentialSecret,
  type ProviderAdapter,
  type ProviderDispatchContext,
  type ProviderDispatchTarget,
} from "../../provider-contracts";
import { classifyCursorThrown } from "./cursor-errors";
import {
  CURSOR_DEFAULT_CONTEXT_TOKENS,
  resolveCursorModelPair,
  type CursorDiscoveryResult,
  type CursorModelRoute,
} from "./cursor-discovery";
import {
  answerKvRequest,
  buildRootPromptMessages,
  CursorBlobStore,
  CursorCheckpointCache,
  CursorServerRecordReplay,
  type CursorHistoryMessage,
} from "./cursor-history";
import { resolveCursorImageInput } from "./cursor-images";
import {
  canResumeParkedRun,
  CursorParkedRegistry,
  type CursorParkedItem,
  type CursorTurnTokens,
  type ParkedRunResults,
} from "./cursor-parked";
import { CursorRosterCache } from "./cursor-roster";
import { CursorToolRelay, type RelayToolDefinition, type RelayedToolCall } from "./cursor-relay";
import { runCursorTurn, type CursorTurnSink, type CursorTurnState } from "./cursor-run";
import type { CursorFetch, CursorRunTransport } from "./cursor-run-transport";
import type {
  AgentServerMessage,
  ConversationStateStructure,
  InteractionQuery,
  KvServerMessage,
} from "./cursor-protocol/generated";

// ── async queue ──

/**
 * Minimal single-consumer async queue joining the pump (which sees wire
 * frames) to the dispatch generator (which shapes canonical events). The
 * queue outlives the dispatch that created it: a parked run keeps queueing
 * until its results arrive.
 */
class AsyncQueue<T> {
  readonly #items: T[] = [];
  readonly #pending: Array<(result: IteratorResult<T>) => void> = [];
  #closed = false;

  push(item: T): void {
    const resolver = this.#pending.shift();
    if (resolver !== undefined) resolver({ value: item, done: false });
    else this.#items.push(item);
  }

  /** Ends the stream; a waiting consumer observes `done`. */
  close(): void {
    this.#closed = true;
    for (const resolver of this.#pending.splice(0)) resolver({ value: undefined, done: true });
  }

  async next(): Promise<IteratorResult<T>> {
    const item = this.#items.shift();
    if (item !== undefined) return { value: item, done: false };
    if (this.#closed) return { value: undefined, done: true };
    return new Promise((resolve) => this.#pending.push(resolve));
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return { next: () => this.next() };
  }
}

// ── model resolution ──

/** A route built from the routed id when discovery could not confirm it. */
function fallbackRoute(modelId: string): CursorModelRoute {
  return {
    routeId: modelId,
    legacySlug: modelId,
    wireModelId: modelId,
    parameters: [],
    maxMode: false,
    displayName: modelId,
    contextTokens: CURSOR_DEFAULT_CONTEXT_TOKENS,
    accountUsable: false,
    isDefault: false,
  };
}

/**
 * Resolves the Run identity for the routed model id.
 *
 * Discovery is the authority; `auto` is the alias for the account's default
 * route (Cursor names it `default` on the wire). An id discovery does not
 * list still gets a route — the legacy slug and rich id are the same string —
 * so third-party rows stay routable and the `model_not_found` retry carries
 * the server's correction when the guess is wrong.
 */
function resolveRoute(discovery: CursorDiscoveryResult, modelId: string): CursorModelRoute {
  const id = modelId.trim();
  const direct = discovery.routes.find(
    (route) => route.routeId === id || route.legacySlug === id || route.wireModelId === id,
  );
  if (direct !== undefined) return direct;
  if (id === "auto" || id === "default") {
    return discovery.defaultRoute ?? fallbackRoute(id);
  }
  return fallbackRoute(id);
}

// ── history conversion ──

function resultText(part: Extract<ContentPart, { kind: "toolResult" }>): string {
  if (typeof part.content === "string") return part.content;
  return joinTextParts(part.content);
}

/** One resolved tool result, ready for the relay or the transcript. */
export interface CursorToolResult {
  readonly callId: string;
  readonly content: string;
  readonly isError: boolean;
}

/**
 * The trailing contiguous block of tool results on a request.
 *
 * Only the trailing block can resume a parked run: an exact-coverage check
 * against the held calls would otherwise trip over results from older turns
 * that ride the history.
 */
export function trailingToolResults(request: CanonicalRequest): CursorToolResult[] {
  const found: CursorToolResult[] = [];
  for (let index = request.messages.length - 1; index >= 0; index -= 1) {
    const message = request.messages[index]!;
    if (!canContainToolResult(message)) break;
    const parts = toolResultParts(message);
    if (parts.length === 0) break;
    for (const part of parts) {
      found.push({ callId: part.call_id, content: resultText(part), isError: part.is_error === true });
    }
  }
  return found.reverse();
}

/** The history transcription of one request, plus its active user turn. */
interface CursorHistoryBuildInput {
  readonly history: CursorHistoryMessage[];
  readonly active: { readonly text: string; readonly imageParts: Extract<ContentPart, { kind: "image" }>[] } | undefined;
}

/**
 * Converts a canonical request into Cursor history.
 *
 * System and instructions content becomes system records; the trailing user
 * turn (text or images, no tool results) is the active message that rides the
 * action; a request that instead ends in tool results keeps its full history
 * and resumes the run instead. Tool result names are recovered from the
 * assistant tool-call that precedes them — the canonical `toolResult` part
 * carries only the call id.
 */
async function toCursorHistory(request: CanonicalRequest, context: ProviderDispatchContext): Promise<CursorHistoryBuildInput> {
  const toolNames = new Map<string, string>();
  for (const message of request.messages) {
    for (const call of toolCallParts(message)) toolNames.set(call.call_id, call.name);
  }

  const last = request.messages.at(-1);
  const active =
    last !== undefined &&
    last.role === "user" &&
    last.content.some((part) => part.kind === "text" || part.kind === "image")
      ? last
      : undefined;
  const historyEnd = active === undefined ? request.messages.length : request.messages.length - 1;

  const history: CursorHistoryMessage[] = [];
  const systemText = [
    ...(request.system ?? []),
    ...(request.instructions ?? []),
  ];
  const system = joinTextParts(systemText);
  if (system.length > 0) history.push({ role: "system", content: system });

  for (const message of request.messages.slice(0, historyEnd)) {
    if (message.role === "assistant") {
      const content: Array<
        | { readonly type: "text"; readonly text: string }
        | { readonly type: "tool-call"; readonly toolCallId: string; readonly toolName: string; readonly args: unknown }
      > = [];
      const text = joinTextParts(message.content.filter((part): part is Extract<ContentPart, { kind: "text" }> => part.kind === "text"));
      if (text.length > 0) content.push({ type: "text", text });
      for (const call of toolCallParts(message)) {
        content.push({ type: "tool-call", toolCallId: call.call_id, toolName: call.name, args: call.arguments });
      }
      if (content.length > 0) history.push({ role: "assistant", content });
      continue;
    }
    const results = toolResultParts(message);
    if (results.length > 0) {
      for (const part of results) {
        history.push({
          role: "tool",
          toolCallId: part.call_id,
          toolName: toolNames.get(part.call_id) ?? "",
          result: resultText(part),
          isError: part.is_error === true,
        });
      }
      continue;
    }
    if (message.role === "user") {
      const content: Array<
        | { readonly type: "text"; readonly text: string }
        | { readonly type: "image"; readonly mediaType: string; readonly data: string }
      > = [];
      const text = joinTextParts(message.content.filter((part): part is Extract<ContentPart, { kind: "text" }> => part.kind === "text"));
      if (text.length > 0) content.push({ type: "text", text });
      for (const part of message.content) {
        if (part.kind !== "image") continue;
        const image = await resolveCursorImageInput(part, context);
        content.push({ type: "image", mediaType: image.mimeType, data: Buffer.from(image.data).toString("base64") });
      }
      if (content.length > 0) history.push({ role: "user", content });
    }
  }

  const activeInput = active === undefined
    ? undefined
    : {
        text: joinTextParts(active.content.filter((part): part is Extract<ContentPart, { kind: "text" }> => part.kind === "text")),
        imageParts: active.content.filter(
          (part): part is Extract<ContentPart, { kind: "image" }> => part.kind === "image",
        ),
      };

  return { history, active: activeInput };
}

// ── interaction queries ──

/**
 * Answers one `interaction_query` so the Run is not stranded.
 *
 * Hosted web search / Exa / permission gates block the turn until an
 * `interaction_response` arrives; dropping the frame leaves the stream alive
 * on non-semantic heartbeats until the idle watchdog kills it. The gateway
 * serves none of these hosted capabilities — the caller's tools are the
 * capability surface — so every answerable query is rejected explicitly.
 * VM setup stays unanswered rather than reporting a fake success.
 */
function rejectInteractionQuery(query: InteractionQuery, transport: CursorRunTransport): void {
  let response: Record<string, unknown> | undefined;
  if (query.webSearchRequestQuery !== undefined) response = { webSearchRequestResponse: { rejected: {} } };
  else if (query.webFetchRequestQuery !== undefined) response = { webFetchRequestResponse: { rejected: {} } };
  else if (query.exaSearchRequestQuery !== undefined) response = { exaSearchRequestResponse: { rejected: {} } };
  else if (query.exaFetchRequestQuery !== undefined) response = { exaFetchRequestResponse: { rejected: {} } };
  else if (query.switchModeRequestQuery !== undefined) response = { switchModeRequestResponse: { rejected: {} } };
  else if (query.askQuestionInteractionQuery !== undefined) {
    response = { askQuestionInteractionResponse: { result: { rejected: {} } } };
  } else if (query.createPlanRequestQuery !== undefined) {
    response = { createPlanRequestResponse: { result: { error: {} } } };
  }
  if (response === undefined) {
    log.warn("cursor: interaction query left unanswered", { id: query.id });
    return;
  }
  void transport.write({ interactionResponse: { id: query.id, ...response } }).catch(() => undefined);
}

// ── the pump ──

/**
 * Per-run protocol state: the relay, the blob store, the checkpoint cache,
 * and the queue joining wire frames to the dispatch generator.
 *
 * The pump implements `CursorTurnSink`, so `runCursorTurn` feeds it every
 * decoded frame including server heartbeats (which keep a counted batch's
 * quiet-timer honest without ever counting as progress). It outlives the
 * dispatch that created it — a parked run keeps pumping until its results
 * arrive or the registry tears it down.
 */
class CursorTurnPump {
  readonly queue = new AsyncQueue<CursorParkedItem>();
  readonly relay: CursorToolRelay;
  readonly checkpoint = new CursorCheckpointCache();
  /** Calls surfaced to the caller, in order — the handoff payload. */
  readonly surfacedCalls: RelayedToolCall[] = [];
  /** The live transport, captured from the first frame. */
  transport: CursorRunTransport | undefined;
  /** Route + digest the attempt actually sent, for server-record capture. */
  sentRoute = "";
  sentDigest = "";

  readonly #store: CursorBlobStore;
  readonly #replay: CursorServerRecordReplay;
  readonly #trace: boolean;
  #handoffFired = false;

  constructor(
    tools: RelayToolDefinition[],
    store: CursorBlobStore,
    replay: CursorServerRecordReplay,
    trace: boolean = false,
  ) {
    this.#store = store;
    this.#replay = replay;
    this.#trace = trace;
    this.relay = new CursorToolRelay(tools, {
      onToolCall: (call) => {
        this.surfacedCalls.push(call);
        this.queue.push({ kind: "tool-call", call });
      },
    });
  }

  readonly sink: CursorTurnSink = {
    onMessage: (message, transport) => this.onMessage(message, transport),
  };

  onMessage(message: AgentServerMessage, transport: CursorRunTransport): { progress: boolean } | void {
    this.transport ??= transport;
    if (this.#trace) {
      // Opt-in wire trace: one line per decoded frame, variant named. Values
      // are not logged — frames carry conversation content.
      log.debug("cursor: run frame", { frame: Object.keys(message)[0] ?? "unknown" });
    }

    if (message.kvServerMessage !== undefined) {
      this.#answerKv(message.kvServerMessage, transport);
      return { progress: false };
    }
    if (message.conversationCheckpointUpdate !== undefined) {
      this.checkpoint.update(message.conversationCheckpointUpdate);
      return { progress: false };
    }
    if (message.interactionQuery !== undefined) {
      rejectInteractionQuery(message.interactionQuery, transport);
      return { progress: false };
    }
    if (message.execServerMessage !== undefined) {
      const before = this.surfacedCalls.length;
      const answers = this.relay.handleExecServerMessage(message.execServerMessage);
      for (const answer of answers) void transport.write(answer).catch(() => undefined);
      this.#checkHandoff();
      return { progress: this.surfacedCalls.length > before };
    }
    if (message.interactionUpdate !== undefined) {
      const update = message.interactionUpdate;
      this.relay.handleInteractionUpdate(update);
      let progress = false;
      if (update.textDelta?.text) {
        this.queue.push({ kind: "text", text: update.textDelta.text });
        progress = true;
      }
      if (update.thinkingDelta?.text) {
        this.queue.push({ kind: "thinking", text: update.thinkingDelta.text });
        progress = true;
      }
      if (update.turnEnded !== undefined) {
        const ended = update.turnEnded;
        this.#captureServerRecords();
        this.queue.push({
          kind: "turn-ended",
          tokens: {
            inputTokens: ended.inputTokens ?? 0,
            outputTokens: ended.outputTokens ?? 0,
            cacheReadTokens: ended.cacheReadTokens ?? 0,
            cacheWriteTokens: ended.cacheWriteTokens ?? 0,
            reasoningTokens: ended.reasoningTokens ?? 0,
          },
        });
        return { progress };
      }
      this.#checkHandoff();
      return { progress };
    }
    return { progress: false };
  }

  /** Writes the next request's results into the held exec frames. */
  collectResults(results: ReadonlyArray<CursorToolResult>): void {
    const answers = this.relay.collectResults(results);
    for (const answer of answers) {
      void this.transport?.write(answer).catch(() => undefined);
    }
    // The held batch closed: a resumed turn may hand off again.
    this.#handoffFired = false;
  }

  /** Tears the pump down without a resume (transport abort included). */
  dispose(reason: string): void {
    this.queue.close();
    this.transport?.abort(reason);
  }

  #checkHandoff(): void {
    if (this.#handoffFired) return;
    if (this.relay.pendingCount === 0) return;
    if (!this.relay.readyToHandOff(Date.now())) return;
    this.#handoffFired = true;
    this.queue.push({ kind: "handoff", calls: this.relay.heldCalls() });
  }

  #answerKv(kv: KvServerMessage, transport: CursorRunTransport): void {
    // The generated interface types ids and bytes optional; the decode layer
    // materialises them, and a frame that somehow lost its payload is dropped
    // rather than answered with garbage.
    if (kv.getBlobArgs !== undefined) {
      const blobId = kv.getBlobArgs.blobId;
      if (!(blobId instanceof Uint8Array)) return;
      const answer = answerKvRequest({ kind: "get", id: kv.id ?? 0, blobId }, this.#store);
      void transport.write({ kvClientMessage: answer }).catch(() => undefined);
      return;
    }
    if (kv.setBlobArgs !== undefined) {
      const blobId = kv.setBlobArgs.blobId;
      const blobData = kv.setBlobArgs.blobData;
      if (!(blobId instanceof Uint8Array) || !(blobData instanceof Uint8Array)) return;
      const answer = answerKvRequest({ kind: "set", id: kv.id ?? 0, blobId, blobData }, this.#store);
      void transport.write({ kvClientMessage: answer }).catch(() => undefined);
    }
  }

  /**
   * Remembers the checkpoint's record list under the route and digest the
   * successful attempt sent. A later request with the same digest replays the
   * bytes verbatim; anything else rebuilds from content.
   */
  #captureServerRecords(): void {
    if (this.sentRoute === "" || this.sentDigest === "") return;
    const state = this.checkpoint.state as ConversationStateStructure | undefined;
    const raw: unknown = state?.rootPromptMessagesJson;
    // The decode layer materialises repeated bytes as an array of buffers;
    // the generated interface types the field as a lone buffer or string
    // array, so the records are read defensively off the runtime shape.
    const list: readonly unknown[] = Array.isArray(raw) ? raw : [];
    if (list.length === 0) return;
    const decoder = new TextDecoder();
    this.#replay.capture(
      list.map((record) => (record instanceof Uint8Array ? decoder.decode(record) : String(record))),
      this.sentRoute,
      this.sentDigest,
    );
  }
}

// ── session state ──

/** Live pumps keyed by session key; a parked run keeps its pump here. */
const cursorPumps = new Map<string, CursorTurnPump>();
/** Server-record replays keyed by session key (bounded, oldest dropped). */
const cursorReplays = new Map<string, CursorServerRecordReplay>();
const MAX_SESSION_REPLAYS = 256;

/** The account-scoped conversation key a parked run is parked under. */
function sessionKey(context: ProviderDispatchContext, conversationId: string): string {
  return `${context.credential.account_id ?? ""}:${conversationId}`;
}

function replayFor(key: string): CursorServerRecordReplay {
  let replay = cursorReplays.get(key);
  if (replay === undefined) {
    replay = new CursorServerRecordReplay();
    cursorReplays.set(key, replay);
    while (cursorReplays.size > MAX_SESSION_REPLAYS) {
      const oldest = cursorReplays.keys().next().value;
      if (oldest === undefined) break;
      cursorReplays.delete(oldest);
    }
  }
  return replay;
}

const parkedRegistry = new CursorParkedRegistry();
const rosterCache = new CursorRosterCache();

// ── event shaping ──

function usageFromTokens(tokens: CursorTurnTokens): UsageRecord {
  const cached = tokens.cacheReadTokens > 0 ? tokens.cacheReadTokens : 0;
  return {
    input_tokens: tokens.inputTokens,
    cached_input_tokens: cached,
    cache_write_tokens: tokens.cacheWriteTokens > 0 ? tokens.cacheWriteTokens : 0,
    uncached_input_tokens: Math.max(0, tokens.inputTokens - cached),
    output_tokens: tokens.outputTokens,
    reasoning_tokens: tokens.reasoningTokens > 0 ? tokens.reasoningTokens : 0,
    estimated_cost: null,
    total_tokens: tokens.inputTokens + tokens.outputTokens,
  };
}

function failureCategory(): string {
  // The classified failure carries the upstream's own taxonomy (policy, code,
  // name); the canonical error event keeps a coarse category and the failure
  // message preserves the specifics.
  return "upstream";
}

// ── the adapter ──

export class CursorAdapter implements ProviderAdapter {
  readonly provider_id = "cursor" as const;

  async *dispatch(
    request: CanonicalRequest,
    candidate: ProviderDispatchTarget,
    context: ProviderDispatchContext,
  ): AsyncGenerator<CanonicalEvent> {
    const accessToken = readCredentialSecret(context.credential, "Cursor credential secret is missing");
    const fetcher = (context.outbound_fetch ?? globalThis.fetch) as unknown as CursorFetch;
    const http2: ValidatedOutboundHttp2Bidi =
      context.outbound_http2 ??
      (async () => {
        throw new Error("HTTP/2 is not supported by this route (no validated h2 egress)");
      });

    // Model identity: discovery is the authority, the routed id is the hint.
    let discovery: CursorDiscoveryResult;
    try {
      discovery = (await rosterCache.lookup(accessToken, fetcher)).result;
    } catch (error) {
      log.warn("cursor: roster lookup failed; dispatching on the routed id", {
        error: error instanceof Error ? error.message : String(error),
      });
      discovery = { routes: [], defaultRoute: undefined, defaultDisplayName: undefined, usableSlugs: [] };
    }
    const route = resolveRoute(discovery, candidate.model_id);
    const pair = resolveCursorModelPair(route);
    const modelKey = candidate.model_id;

    const conversationId = request.conversation_id ?? request.session_id ?? randomUUID();
    const session = sessionKey(context, conversationId);
    const results = trailingToolResults(request);

    let seq = 0;
    const nextSeq = (): number => ++seq;
    const responseId = randomUUID();

    // Lease handling: transferred once, at the first park; released when the
    // session ends (clean completion) or the registry tears the run down.
    let leaseRelease: (() => void) | undefined;
    let leaseReleased = false;
    const releaseLeaseOnce = (): void => {
      if (leaseReleased) return;
      leaseReleased = true;
      leaseRelease?.();
    };

    const onAbort = (): void => {
      cursorPumps.get(session)?.transport?.abort("client aborted");
    };
    context.abort_signal.addEventListener("abort", onAbort, { once: true });

    try {
      yield { type: "response_start", sequence_number: nextSeq(), model: request.model, response_id: responseId };

      // ── in-band resume ──
      const parked = results.length > 0 ? parkedRegistry.peek(session) : undefined;
      if (parked !== undefined) {
        const resume: ParkedRunResults = {
          conversationId: session,
          wireModelId: pair.requestedModel.modelId,
          modelKey,
          results,
        };
        if (!canResumeParkedRun(parked, resume)) {
          parkedRegistry.release(session, "results do not resume the parked run");
        } else {
          const pump = cursorPumps.get(session);
          if (pump !== undefined) {
            parkedRegistry.consume(session);
            pump.collectResults(results);
            yield* consumePump(pump, {
              session,
              nextSeq,
              responseId,
              wireModelId: pair.requestedModel.modelId,
              modelKey,
              onSessionEnd: () => {
                cursorPumps.delete(session);
                releaseLeaseOnce();
              },
              onReleased: releaseLeaseOnce,
            });
            return;
          }
          // The pump is gone (failed while parked): rebuild below.
          parkedRegistry.release(session, "parked run has no live pump");
        }
      }

      // ── fresh run ──
      // A leftover pump means the previous run was parked and this request
      // did not resume it: tear it down before opening a new one.
      const stale = cursorPumps.get(session);
      if (stale !== undefined) {
        cursorPumps.delete(session);
        parkedRegistry.release(session, "superseded by a new request");
        stale.dispose("superseded by a new request");
      }

      const { history, active } = await toCursorHistory(request, context);
      const digest = CursorServerRecordReplay.digest(history);
      const replay = replayFor(session);
      const store = new CursorBlobStore();
      const built = buildRootPromptMessages(history, store);
      const tools: RelayToolDefinition[] = (request.tools ?? []).map((tool) => ({
        name: tool.name,
        description: tool.description ?? "",
        inputSchema:
          typeof tool.jsonSchema === "object" && tool.jsonSchema !== null
            ? (tool.jsonSchema as Record<string, unknown>)
            : {},
      }));

      const action = await buildAction(active, context);
      const pump = new CursorTurnPump(tools, store, replay, resolveCursorWireTrace());

      const turnOptions = {
        accessToken,
        clientVersion: resolveCursorClientVersion(),
        heartbeatMs: resolveCursorHeartbeatMs(),
        buildRequest: (state: CursorTurnState) => {
          const requestedModelId = state.wireModelOverride ?? pair.requestedModel.modelId;
          const sentRoute = JSON.stringify({
            requested: requestedModelId,
            details: pair.modelDetails.modelId,
            maxMode: pair.requestedModel.maxMode,
            parameters: pair.requestedModel.parameters,
          });
          const replayed = replay.resolve(sentRoute, digest);
          pump.sentRoute = sentRoute;
          pump.sentDigest = digest;
          // Repeated bytes go out either as 32-byte blob ids (fresh build) or
          // as the server's own record text (replay). The generated interface
          // mis-types the repeated field, so the shape is kept unannotated and
          // `encodeMessage`'s verify is the gate.
          const conversationState =
            replayed === undefined
              ? { rootPromptMessagesJson: built.rootPromptMessageIds, turns: built.turnIds }
              : {
                  rootPromptMessagesJson: replayed.map((record) => new TextEncoder().encode(record)),
                  turns: built.turnIds,
                };
          return {
            conversationState,
            action,
            modelDetails: {
              modelId: pair.modelDetails.modelId,
              displayModelId: route.routeId,
              displayName: route.displayName,
            },
            requestedModel: {
              modelId: requestedModelId,
              maxMode: pair.requestedModel.maxMode,
              parameters: pair.requestedModel.parameters,
            },
            conversationId: state.conversationId,
          };
        },
        sink: pump.sink,
        http2,
        fetch: fetcher,
        signal: context.abort_signal,
        conversationId,
      };

      // The turn runs while this generator streams: runCursorTurn resolves
      // only when the stream reaches a terminal state, which — for a parked
      // run — is long after this dispatch has returned.
      void runCursorTurn(turnOptions)
        .then((result) => {
          if (result.status === "failed") {
            pump.queue.push({ kind: "failed", failure: result.failure });
            // A dead run cannot be resumed: release the parked entry if one
            // exists (a no-op otherwise) so the lease travels home, and drop
            // the pump so the next request opens fresh.
            cursorPumps.delete(session);
            parkedRegistry.release(session, "cursor run failed while parked");
          }
        })
        .catch((error) => {
          pump.queue.push({ kind: "failed", failure: classifyCursorThrown(error) });
          cursorPumps.delete(session);
          pump.dispose("cursor turn crashed");
          parkedRegistry.release(session, "cursor run crashed while parked");
        });

      cursorPumps.set(session, pump);

      let sawTurnEnd = false;
      for (;;) {
        const next = await pump.queue.next();
        if (next.done) break;
        const item = next.value;
        if (item.kind === "text") {
          yield { type: "content_delta", sequence_number: nextSeq(), content: { kind: "text", text: item.text } };
          continue;
        }
        if (item.kind === "thinking") {
          yield {
            type: "content_delta",
            sequence_number: nextSeq(),
            content: { kind: "reasoning", payload: null, summary: item.text },
          };
          continue;
        }
        if (item.kind === "tool-call") {
          yield {
            type: "tool_call_delta",
            sequence_number: nextSeq(),
            call_id: item.call.callId,
            name: item.call.toolName,
            arguments_delta: JSON.stringify(item.call.args),
          };
          continue;
        }
        if (item.kind === "turn-ended") {
          sawTurnEnd = true;
          const usage = usageFromTokens(item.tokens);
          yield { type: "usage", sequence_number: nextSeq(), usage };
          yield {
            type: "terminal",
            sequence_number: nextSeq(),
            state: "complete",
            stop_reason: "stop",
            usage,
            response_id: responseId,
          };
          break;
        }
        if (item.kind === "handoff") {
          // Park: the Run stays open with its held batch; the lease travels
          // with it so the account slot is not freed while the stream lives.
          leaseRelease = context.lease_ownership?.transferToProviderSession() ?? undefined;
          parkedRegistry.park({
            conversationId: session,
            wireModelId: pair.requestedModel.modelId,
            modelKey,
            calls: item.calls,
            transport: pump.transport ?? {
              carrier: "http2",
              events: (async function* () {})(),
              async write(): Promise<void> {},
              end(): void {},
              abort(): void {},
            },
            iterator: pump.queue[Symbol.asyncIterator](),
            relay: pump.relay,
            parkedAt: Date.now(),
            onReleased: releaseLeaseOnce,
          });
          yield {
            type: "terminal",
            sequence_number: nextSeq(),
            state: "complete",
            stop_reason: "tool_use",
            response_id: responseId,
          };
          return;
        }
        // failed
        log.warn("cursor: run failed", {
          policy: item.failure.policy,
          name: item.failure.name ?? "",
          code: item.failure.code ?? "",
          message: item.failure.message,
        });
        yield {
          type: "error",
          sequence_number: nextSeq(),
          category: failureCategory(),
          message: item.failure.message,
          retryable: item.failure.upstreamRetryable,
        };
        yield {
          type: "terminal",
          sequence_number: nextSeq(),
          state: "failed",
          stop_reason: "error",
          response_id: responseId,
        };
        break;
      }

      if (!sawTurnEnd) return;
      // Clean completion: the provider session is over, release everything.
      cursorPumps.delete(session);
      releaseLeaseOnce();
    } finally {
      context.abort_signal.removeEventListener("abort", onAbort);
    }
  }
}

/** Maps pump items to canonical events until the dispatch ends. */
async function* consumePump(
  pump: CursorTurnPump,
  scope: {
    readonly session: string;
    readonly nextSeq: () => number;
    readonly responseId: string;
    readonly wireModelId: string;
    readonly modelKey: string;
    readonly onSessionEnd: () => void;
    readonly onReleased: () => void;
  },
): AsyncGenerator<CanonicalEvent> {
  for (;;) {
    const next = await pump.queue.next();
    if (next.done) {
      yield {
        type: "terminal",
        sequence_number: scope.nextSeq(),
        state: "failed",
        stop_reason: "error",
        response_id: scope.responseId,
      };
      scope.onSessionEnd();
      return;
    }
    const item = next.value;
    if (item.kind === "text") {
      yield { type: "content_delta", sequence_number: scope.nextSeq(), content: { kind: "text", text: item.text } };
      continue;
    }
    if (item.kind === "thinking") {
      yield {
        type: "content_delta",
        sequence_number: scope.nextSeq(),
        content: { kind: "reasoning", payload: null, summary: item.text },
      };
      continue;
    }
    if (item.kind === "tool-call") {
      yield {
        type: "tool_call_delta",
        sequence_number: scope.nextSeq(),
        call_id: item.call.callId,
        name: item.call.toolName,
        arguments_delta: JSON.stringify(item.call.args),
      };
      continue;
    }
    if (item.kind === "turn-ended") {
      const usage = usageFromTokens(item.tokens);
      yield { type: "usage", sequence_number: scope.nextSeq(), usage };
      yield {
        type: "terminal",
        sequence_number: scope.nextSeq(),
        state: "complete",
        stop_reason: "stop",
        usage,
        response_id: scope.responseId,
      };
      scope.onSessionEnd();
      return;
    }
    if (item.kind === "handoff") {
      // A resumed turn can call more tools: park again under the same
      // session, with the same lease release riding the entry.
      parkedRegistry.park({
        conversationId: scope.session,
        wireModelId: scope.wireModelId,
        modelKey: scope.modelKey,
        calls: item.calls,
        transport: pump.transport ?? {
          carrier: "http2",
          events: (async function* () {})(),
          async write(): Promise<void> {},
          end(): void {},
          abort(): void {},
        },
        iterator: pump.queue[Symbol.asyncIterator](),
        relay: pump.relay,
        parkedAt: Date.now(),
        onReleased: scope.onReleased,
      });
      yield {
        type: "terminal",
        sequence_number: scope.nextSeq(),
        state: "complete",
        stop_reason: "tool_use",
        response_id: scope.responseId,
      };
      return;
    }
    log.warn("cursor: run failed", {
      policy: item.failure.policy,
      name: item.failure.name ?? "",
      code: item.failure.code ?? "",
      message: item.failure.message,
    });
    yield {
      type: "error",
      sequence_number: scope.nextSeq(),
      category: failureCategory(),
      message: item.failure.message,
      retryable: item.failure.upstreamRetryable,
    };
    yield {
      type: "terminal",
      sequence_number: scope.nextSeq(),
      state: "failed",
      stop_reason: "error",
      response_id: scope.responseId,
    };
    scope.onSessionEnd();
    return;
  }
}

/** Builds the action: the active user turn, or a resume over full history. */
async function buildAction(
  active: { readonly text: string; readonly imageParts: Extract<ContentPart, { kind: "image" }>[] } | undefined,
  context: ProviderDispatchContext,
): Promise<Record<string, unknown>> {
  const text = active?.text ?? "";
  if (text.trim().length === 0 && (active?.imageParts.length ?? 0) === 0) {
    return { resumeAction: {} };
  }
  const images: Array<Record<string, unknown>> = [];
  for (const part of active?.imageParts ?? []) {
    const image = await resolveCursorImageInput(part, context);
    images.push({
      uuid: randomUUID(),
      mimeType: image.mimeType,
      data: image.data,
    });
  }
  return {
    userMessageAction: {
      userMessage: {
        text,
        messageId: randomUUID(),
        ...(images.length > 0 ? { selectedContext: { selectedImages: images } } : {}),
      },
    },
  };
}

/** The bundled adapter instance. */
export const cursorAdapter = new CursorAdapter();

export function createCursorAdapter(): CursorAdapter {
  return new CursorAdapter();
}
