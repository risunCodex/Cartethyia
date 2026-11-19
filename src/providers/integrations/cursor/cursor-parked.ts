/**
 * Parked Run state: a Run that handed its tool calls to the caller and waits,
 * stream open, for the results to come back with the next request.
 *
 * External-executor mode changes the turn shape: Cursor's model emits MCP
 * tool calls, the gateway surfaces them to the caller instead of answering
 * them, and the turn *ends for the caller* while the upstream Run stays alive
 * (heartbeats keep its counted tool batch open). The next request brings the
 * results; they are written into the held exec frames and the same Run
 * continues. Only when the parked run cannot be resumed — a different model,
 * a different conversation, or results that do not cover the held calls
 * exactly — does the turn fall back to a full rebuild from history.
 *
 * The resume contract (mirrored from the reference implementation) is
 * therefore three conditions, all mandatory:
 *
 * 1. same model and wire model id the run was opened with,
 * 2. same conversation key,
 * 3. exactly one tool result per held call — no missing, no extra.
 *
 * A parked run has an idle deadline (30 minutes, matching the reference):
 * only an abandoned session waits it out, since a request that does not
 * resume it and a transport that dies both release it sooner.
 */
import type { CursorFailure } from "./cursor-errors";
import type { CursorRunTransport } from "./cursor-run-transport";
import type { CursorToolRelay, RelayedToolCall } from "./cursor-relay";

/** How long a parked run stays alive waiting for its results. */
export const CURSOR_PARKED_IDLE_MS = 30 * 60 * 1000;

/** Token accounting carried by a `turn_ended` frame. */
export interface CursorTurnTokens {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly reasoningTokens: number;
}

/**
 * One item the parked pump hands the resuming consumer.
 *
 * Frame-level, not canonical: the pump sees the wire, the dispatch generator
 * owns sequence numbers and event shaping. `handoff` is the control signal
 * that parks a run — the held batch was handed to the caller and the consumer
 * must surface a tool-use terminal. A resumed turn can hand off again, so the
 * signal, not the transport event, is what bounds one dispatch.
 */
export type CursorParkedItem =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "thinking"; readonly text: string }
  | { readonly kind: "tool-call"; readonly call: RelayedToolCall }
  | { readonly kind: "turn-ended"; readonly tokens: CursorTurnTokens }
  | { readonly kind: "handoff"; readonly calls: ReadonlyArray<RelayedToolCall> }
  | { readonly kind: "failed"; readonly failure: CursorFailure };

/** A run held open between requests, waiting for its tool results. */
export interface CursorParkedRun {
  readonly conversationId: string;
  /** The wire model id the run was opened with (resume check #1). */
  readonly wireModelId: string;
  /** The routed model/variant identity the run was opened with. */
  readonly modelKey: string;
  /** The calls the caller must answer, in order. */
  readonly calls: ReadonlyArray<RelayedToolCall>;
  readonly transport: CursorRunTransport;
  /** The paused event iterator; resuming pulls from exactly here. */
  readonly iterator: AsyncIterator<CursorParkedItem>;
  readonly relay: CursorToolRelay;
  readonly parkedAt: number;
  /**
   * Called exactly once when the registry tears the run down (replaced,
   * expired, released). The dispatcher hands its routing lease to the parked
   * session via `AttemptLeaseOwnership.transferToProviderSession`; this is
   * where that release fires when the session dies without a resume.
   */
  readonly onReleased?: (() => void) | undefined;
}

/** What the next request brings: one result per held call. */
export interface ParkedRunResults {
  readonly conversationId: string;
  readonly wireModelId: string;
  readonly modelKey: string;
  readonly results: ReadonlyArray<{ readonly callId: string; readonly content: string; readonly isError: boolean }>;
}

/**
 * Whether the next request may resume this parked run in-band.
 *
 * The three conditions are conjunctive on purpose: a resume on a different
 * model would send results Cursor attributes to the wrong assistant turn, and
 * a partial result set would leave a call unpaired ("an unpaired call is
 * stripped from every rebuilt transcript").
 */
export function canResumeParkedRun(parked: CursorParkedRun, request: ParkedRunResults): boolean {
  if (request.conversationId !== parked.conversationId) return false;
  if (request.wireModelId !== parked.wireModelId) return false;
  if (request.modelKey !== parked.modelKey) return false;
  const held = new Set(parked.calls.map((call) => call.callId));
  const given = new Set(request.results.map((result) => result.callId));
  if (given.size !== request.results.length) return false; // duplicate results
  if (held.size !== given.size) return false; // missing or extra
  for (const callId of held) {
    if (!given.has(callId)) return false;
  }
  return true;
}

/**
 * Registry of parked runs keyed by conversation.
 *
 * Idle runs are released lazily: on access (a request that resumes a stale
 * entry finds it gone and rebuilds from history) and on every park, which
 * bounds the leak an expired entry would otherwise hold forever — its live
 * upstream stream, queue, and transferred routing lease — when its caller
 * never produces a same-key peek again.
 */
export class CursorParkedRegistry {
  readonly #runs = new Map<string, CursorParkedRun>();

  park(parked: CursorParkedRun, now: number = Date.now()): void {
    for (const [key, entry] of this.#runs) {
      if (now - entry.parkedAt <= CURSOR_PARKED_IDLE_MS) continue;
      entry.onReleased?.();
      entry.transport.abort("parked run idle deadline");
      this.#runs.delete(key);
    }
    const existing = this.#runs.get(parked.conversationId);
    if (existing !== undefined) {
      // A second park for one conversation means the previous run is
      // abandoned; tear it down rather than leak its stream.
      existing.onReleased?.();
      existing.transport.abort("replaced by a new parked run");
    }
    this.#runs.set(parked.conversationId, parked);
  }

  /** Returns the parked run for a conversation when it is live and resumable. */
  peek(conversationId: string, now: number = Date.now()): CursorParkedRun | undefined {
    const parked = this.#runs.get(conversationId);
    if (parked === undefined) return undefined;
    if (now - parked.parkedAt > CURSOR_PARKED_IDLE_MS) {
      parked.onReleased?.();
      parked.transport.abort("parked run idle deadline");
      this.#runs.delete(conversationId);
      return undefined;
    }
    return parked;
  }

  /** Removes and returns a parked run for resumption. */
  consume(conversationId: string): CursorParkedRun | undefined {
    const parked = this.#runs.get(conversationId);
    if (parked !== undefined) this.#runs.delete(conversationId);
    return parked;
  }

  /** Releases a parked run without resuming it (request rebuilt instead). */
  release(conversationId: string, reason: string): void {
    const parked = this.#runs.get(conversationId);
    if (parked === undefined) return;
    parked.onReleased?.();
    parked.transport.abort(reason);
    this.#runs.delete(conversationId);
  }

  get size(): number {
    return this.#runs.size;
  }
}
