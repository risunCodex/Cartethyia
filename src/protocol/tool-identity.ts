/** Accumulated arguments + pinned index for one in-progress tool call. */
export interface ToolCallState {
  id: string;
  name?: string;
  arguments: string;
  index: number;
}

/**
 * Per-state argument fragments and their joined snapshot.
 *
 * The snapshot is cached on the CHUNK ARRAY, not on the state, because the
 * array is deliberately handed forward from a superseded state to its
 * replacement and mutated in place — so a reader holding the older
 * `ToolCallState` still observes the newest total. Caching per state would
 * freeze each state at the value it had when created and silently break that
 * invariant (pinned by test/protocol/tool-identity.test.ts).
 *
 * The cache is dropped on push, so N deltas cost O(N) total: without it each
 * read re-joined the whole array, and a reader that slices the string per
 * delta — as the Messages stream does — re-joined and re-sliced once per
 * fragment, which is O(n²) over a large tool argument.
 */
const argumentChunks = new WeakMap<ToolCallState, string[]>();
const argumentJoined = new WeakMap<string[], string>();

/** The accumulated arguments, joining only when a fragment has been added. */
function joinedArguments(state: ToolCallState): string {
  const chunks = argumentChunks.get(state);
  if (chunks === undefined) return "";
  const cached = argumentJoined.get(chunks);
  if (cached !== undefined) return cached;
  const value = chunks.join("");
  argumentJoined.set(chunks, value);
  return value;
}

/**
 * Single tool-call tracking home: id/index/arguments-accumulation keyed by
 * call id with index fallback. Shared by the chat surface (explicit wire
 * indexes) and the Messages ledger (ledger-global indexes via
 * `fallbackIndex`) so every encoder agrees on index pinning instead of
 * reimplementing the same maps.
 */
export interface ToolCallTracker {
  readonly indexById: Map<string, number>;
  readonly states: Map<string, ToolCallState>;
  nextIndex: number;
}

export function createToolCallTracker(): ToolCallTracker {
  return { indexById: new Map(), states: new Map(), nextIndex: 0 };
}

/** Clears all tracked calls and resets index assignment (per-turn reset). */
export function resetToolCallTracker(tracker: ToolCallTracker): void {
  tracker.indexById.clear();
  tracker.states.clear();
  tracker.nextIndex = 0;
}

/**
 * Pins a stable per-tool index and accumulates streamed `arguments`.
 * Index precedence: explicit non-negative wire index, then the pinned index
 * for a known id, then `fallbackIndex` (callers sharing one counter across
 * tool and non-tool blocks, e.g. the Messages ledger), then the tracker's
 * own counter. Names are sticky (first defined wins); `isFirst` marks the
 * first sighting of an id.
 */
export function trackToolCall(
  tracker: ToolCallTracker,
  tool: { id: string; name?: string | undefined; args?: string | undefined; index?: number | undefined },
  fallbackIndex?: number,
): { index: number; isFirst: boolean; state: ToolCallState } {
  const priorIndex = tracker.indexById.get(tool.id);
  // A wire index is only honored when this id already owns it, or when it is
  // not yet claimed by another call. Upstream Qoder parallel calls frequently
  // repeat the same wire index (0,0) for different ids, which would otherwise
  // collapse two calls into one at the encoder (`Map` keyed by index). When
  // the wire index collides with another id, synthesize a fresh index so every
  // logical call keeps a distinct wire position.
  const index =
    tool.index !== undefined && Number.isInteger(tool.index) && tool.index >= 0
      ? (() => {
          if (priorIndex !== undefined) return priorIndex;
          for (const [id, assigned] of tracker.indexById) {
            if (id !== tool.id && assigned === tool.index) {
              return tracker.nextIndex++;
            }
          }
          return tool.index;
        })()
      : (priorIndex ?? fallbackIndex ?? tracker.nextIndex++);
  tracker.indexById.set(tool.id, index);
  tracker.nextIndex = Math.max(tracker.nextIndex, index + 1);
  const prior = tracker.states.get(tool.id);
  const name = tool.name ?? prior?.name;
  // Append the fragment in O(1) amortized. The chunk array is shared forward
  // along one call id, so the joined cache is keyed on the array and dropped
  // here: the next read re-joins once and re-caches.
  const chunks =
    prior !== undefined ? (argumentChunks.get(prior) ?? [prior.arguments]) : [];
  chunks.push(tool.args ?? "");
  argumentJoined.delete(chunks);
  const state: ToolCallState = {
    id: tool.id || prior?.id || "",
    get arguments() {
      return joinedArguments(state);
    },
    index,
  };
  argumentChunks.set(state, chunks);
  if (name !== undefined) state.name = name;
  tracker.states.set(tool.id, state);
  return { index, isFirst: prior === undefined, state };
}

/**
 * The not-yet-emitted tail of a call's arguments, from `offset`.
 *
 * Reads the cached joined string rather than re-joining the chunk array, so a
 * caller that asks once per delta — as the Messages stream does — stays
 * linear in the total argument length instead of quadratic. The `slice` itself
 * is unavoidable: the caller needs the tail, and its own length is the output.
 */
export function argumentsFrom(state: ToolCallState, offset: number): string {
  const all = joinedArguments(state);
  return offset <= 0 ? all : all.slice(offset);
}

// ===== Emission ledger =====

/**
 * Collapses provider-specific duplicate spellings of one logical call id.
 * Some backends deliver a single call under two ids that differ only by
 * prefix (`call_<suffix>` vs `fc_<suffix>`); both must resolve to one call so
 * an agent does not perform the same action twice. This is the ONLY place
 * that prefix is interpreted.
 */
export function toolIdentityKey(callId: string): string {
  return callId.replace(/^(?:call|fc)_/, "");
}

interface LedgerEntry {
  name?: string;
  arguments?: string;
  streamedArguments: boolean;
}

/**
 * Per-stream tool-call emission ledger: one entry per logical call.
 *
 * `claimFirstEmission` is the single gate for call-defining events, so a
 * duplicate reaches the client zero times by construction instead of being
 * filtered after the fact by independently maintained per-path sets.
 */
export interface ToolEmitLedger {
  /** True when this call has not been defined yet; marks it seen. */
  claimFirstEmission(callId: string, name?: string, args?: string): boolean;
  /** True when this call already streamed at least one arguments delta. */
  hasStreamedArguments(callId: string): boolean;
  /**
   * True when a different call already claimed the same name + arguments.
   *
   * Only *substantive* arguments count as evidence of duplication. A call whose
   * arguments are still empty is indistinguishable from any other call to the
   * same tool, so collapsing on that basis suppresses the second of two
   * legitimate parallel calls — and with it the call's name, which the client
   * then replays upstream as `name: ""` (the Muse
   * `` `name` must be non-empty `` failure).
   */
  isDuplicateDefinition(callId: string, name: string, args: string): boolean;
  markStreamedArguments(callId: string): void;
  /** Unique id for an item carrying no identity, so parallel calls never merge. */
  nextOrphanId(prefix: string): string;
  reset(): void;
}

/** One entry per tool call in one response; the ledger dies with the stream. */
export function createToolEmitLedger(): ToolEmitLedger {
  // Keyed by identity key, so a differently-prefixed id for an already
  // claimed call resolves to the same entry without a scan.
  const entries = new Map<string, LedgerEntry>();
  let orphanSeq = 0;

  return {
    claimFirstEmission(callId: string, name?: string, args?: string): boolean {
      const key = toolIdentityKey(callId);
      if (entries.has(key)) return false;
      entries.set(key, {
        streamedArguments: false,
        ...(name === undefined ? {} : { name }),
        ...(args === undefined ? {} : { arguments: args }),
      });
      return true;
    },
    hasStreamedArguments(callId: string): boolean {
      return entries.get(toolIdentityKey(callId))?.streamedArguments === true;
    },
    /**
     * True when a *different* logical call already claimed the same name and
     * arguments — a backend delivering one call under two ids. Same-id
     * repeats are continuations, never duplicates.
     */
    isDuplicateDefinition(callId: string, name: string, args: string): boolean {
      // An empty argument list carries no identity: two parallel calls to the
      // same tool both start at `arguments: ""`, and treating that as a
      // duplicate drops the second call's name. The client then stores
      // `function.name: ""` in its transcript and every later request is
      // rejected upstream with "`name` must be non-empty".
      if (args.trim().length === 0) return false;
      // Known Codex/Responses spellings are normalized by toolIdentityKey.
      // Name+arguments fallback is only for unknown provider prefixes; applying
      // it to known ids would suppress two legitimate identical parallel calls.
      if (/^(?:call|fc)_/.test(callId)) return false;
      const key = toolIdentityKey(callId);
      for (const [id, entry] of entries) {
        if (id === key) continue;
        if (entry.name === name && entry.arguments === args) return true;
      }
      return false;
    },
    markStreamedArguments(callId: string): void {
      // Creates the entry when the delta arrives before any defining frame,
      // so the terminal frame cannot re-emit the full `arguments`.
      const key = toolIdentityKey(callId);
      const entry = entries.get(key);
      if (entry !== undefined) entry.streamedArguments = true;
      else entries.set(key, { streamedArguments: true });
    },
    nextOrphanId(prefix: string): string {
      orphanSeq += 1;
      return `${prefix}-orphan-${orphanSeq}`;
    },
    reset(): void {
      entries.clear();
    },
  };
}
