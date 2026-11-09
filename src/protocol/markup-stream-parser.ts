/**
 * Generic streaming prefix-buffer parser for in-band tool-call markup.
 *
 * Three grammars (DSML blocks, OMP `<tool_calls:8hex>` envelopes, Qwen
 * `<tool_call>` JSON blocks) share one stateful loop: append chunks to a
 * pending buffer, scan for the earliest opener, settle visible text up to a
 * safe end that holds back a possible trailing opener fragment, parse a
 * complete block when its closer appears, fail open past a block-size cap, and
 * flush the tail. The grammar-specific parts are supplied as configuration:
 * opener strings, an opener classifier (some grammars must validate beyond the
 * bare prefix, e.g. OMP's hex marker), closer/parse functions, an unclosed
 * block policy (hold vs fail-open pass-through), a flush policy (pass through
 * vs discard an unterminated envelope), and a call-id factory. Each parser
 * instance keeps its own buffer; nothing is shared.
 */

/** Result of one push/flush pass: text that settled plus recovered calls. */
export interface MarkupStreamParseResult<Call extends { readonly id: string }> {
  readonly text: string;
  readonly calls: readonly Call[];
}

/** Raw call shape produced by a grammar's block parser, without its id. */
export type MarkupRawCall<Call extends { readonly id: string }> = Omit<Call, "id">;

/** Builds a complete call (id included) from a parsed raw call. */
export type MarkupCallFactory<Call extends { readonly id: string }> = (
  call: MarkupRawCall<Call>,
  index: number,
  seq: number,
) => Call;

/** Classification of one opener candidate occurrence. */
export type MarkupOpenerClassification<Call extends { readonly id: string }> =
  | {
      /**
       * The candidate may be the start of a real opener (e.g. a partial hex
       * marker): hold everything from the candidate until a later chunk
       * completes or disproves it.
       */
      readonly kind: "hold";
    }
  | {
      /**
       * The candidate is definitely not an opener: emit it as literal text
       * (one character) and rescan after it.
       */
      readonly kind: "literal";
    }
  | {
      readonly kind: "found";
      /** Tag that closes the block opened at this position. */
      readonly closer: string;
      /**
       * Parses one complete block (opener through closer). `undefined` means
       * the block is not valid markup and is passed through as text verbatim.
       */
      readonly parse: (block: string) => readonly MarkupRawCall<Call>[] | undefined;
      /**
       * Call factory for the calls recovered from this block; defaults to the
       * parser-level `callId`. Some grammars derive ids from block-local state
       * (e.g. OMP embeds the envelope marker).
       */
      readonly callId?: MarkupCallFactory<Call>;
    };

export interface MarkupStreamParserOptions<Call extends { readonly id: string }> {
  /**
   * Opener frontier. The earliest occurrence wins; trailing fragments that
   * could start one are held back from settled text.
   */
  readonly openers: readonly string[];
  /** Classifies an opener candidate found at a scan position. */
  readonly classifyOpener: (
    pending: string,
    index: number,
    opener: string,
  ) => MarkupOpenerClassification<Call>;
  /**
   * Policy when a block's closer has not arrived yet. Default `"hold"`: keep
   * the whole pending buffer from the opener until a later chunk completes or
   * disproves the block. Returning `{ kind: "passThrough" }` fails open:
   * everything from the opener is emitted as text immediately (the DSML
   * block-size cap).
   */
  readonly onUnclosed?: (
    pending: string,
    openIndex: number,
  ) => "hold" | { readonly kind: "passThrough" };
  /**
   * Tail policy at flush. Returns the text to emit for whatever remains in the
   * buffer (default: everything, i.e. pass through). A grammar that discards
   * unterminated envelopes returns `""` when the tail looks like an opener.
   */
  readonly flush?: (pending: string) => string;
  /** Call factory for recovered calls, unless a block overrides it. */
  readonly callId?: MarkupCallFactory<Call>;
}

export class MarkupStreamParser<Call extends { readonly id: string }> {
  readonly #options: MarkupStreamParserOptions<Call>;
  #pending = "";
  #callSequence = 0;

  constructor(options: MarkupStreamParserOptions<Call>) {
    this.#options = options;
  }

  /** Feeds one chunk and returns only settled text and complete calls. */
  push(chunk: string): MarkupStreamParseResult<Call> {
    this.#pending += chunk;
    let cursor = 0;
    let visible = "";
    const calls: Call[] = [];
    for (;;) {
      let openIndex = -1;
      let opener = "";
      for (const candidate of this.#options.openers) {
        const index = this.#pending.indexOf(candidate, cursor);
        if (index >= 0 && (openIndex < 0 || index < openIndex)) {
          openIndex = index;
          opener = candidate;
        }
      }
      if (openIndex < 0) {
        const safeEnd = this.#settledEnd(cursor);
        visible += this.#pending.slice(cursor, safeEnd);
        cursor = safeEnd;
        break;
      }
      visible += this.#pending.slice(cursor, openIndex);
      const classified = this.#options.classifyOpener(this.#pending, openIndex, opener);
      if (classified.kind === "literal") {
        visible += "<";
        cursor = openIndex + 1;
        continue;
      }
      if (classified.kind === "hold") {
        cursor = openIndex;
        break;
      }
      const closeIndex = this.#pending.indexOf(classified.closer, openIndex + opener.length);
      if (closeIndex < 0) {
        const decision = this.#options.onUnclosed?.(this.#pending, openIndex) ?? "hold";
        if (decision === "hold") {
          cursor = openIndex;
          break;
        }
        visible += this.#pending.slice(openIndex);
        cursor = this.#pending.length;
        break;
      }
      const end = closeIndex + classified.closer.length;
      const block = this.#pending.slice(openIndex, end);
      const parsed = classified.parse(block);
      if (parsed === undefined) {
        visible += block;
      } else {
        const callFor = classified.callId ?? this.#options.callId;
        if (callFor === undefined) {
          throw new Error("MarkupStreamParser: no call factory configured");
        }
        parsed.forEach((call, index) => {
          calls.push(callFor(call, index, this.#callSequence++));
        });
      }
      cursor = end;
    }
    this.#pending = this.#pending.slice(cursor);
    return { text: visible, calls };
  }

  /** Settles trailing text per the configured flush policy. */
  flush(): MarkupStreamParseResult<Call> {
    const text = this.#options.flush?.(this.#pending) ?? this.#pending;
    this.#pending = "";
    return { text, calls: [] };
  }

  /** Holds back a trailing fragment that could be the start of an opener. */
  #settledEnd(start: number): number {
    const remaining = this.#pending.slice(start);
    const maxOpener = this.#options.openers.reduce(
      (max, open) => Math.max(max, open.length - 1),
      0,
    );
    for (let length = Math.min(maxOpener, remaining.length); length > 0; length -= 1) {
      const suffix = remaining.slice(-length);
      if (this.#options.openers.some((open) => open.startsWith(suffix))) {
        return this.#pending.length - length;
      }
    }
    return this.#pending.length;
  }
}
