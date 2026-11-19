/**
 * Canonical inline-thinking split.
 *
 * Some upstream models write their reasoning into the *text* stream wrapped in
 * `<think>…</think>` (or `<thinking>…</thinking>`) instead of a dedicated
 * reasoning field. This module recovers that reasoning — statefully, so a tag
 * split across two chunks is still recognized — and lives in the canonical
 * protocol layer because it serves every wire: the chat decoder, provider
 * decoders (CommandCode, Xiaomi MiMo Studio), and nothing else is per-provider
 * about it.
 *
 * Two safety rules keep the classification honest (mirroring the DSML parser's
 * fail-open behavior):
 *
 * - Only a *paired* span — an opening tag followed by its matching closing tag,
 *   outside a code span — is treated as reasoning. An opening tag that never
 *   closes at end-of-stream is almost certainly literal output (docs, a code
 *   sample, a model reciting the syntax), so it is released as plain text
 *   rather than swallowing the tail of the answer into the thinking pane.
 * - A stray closing tag with no opener is likewise preserved verbatim.
 *
 * The splitter is stateful because a tag can straddle two SSE frames: the
 * `<thi` of one chunk and the `nk>` of the next are one opening tag, and a
 * stateless regex would emit the fragment as text. It therefore holds back a
 * trailing run that could still become a tag until the next chunk settles it.
 *
 * Two further quirks are handled here rather than at each call site:
 * - NUL bytes (`\u0000`) are injected by the MiMo Studio upstream between
 *   thought tokens; forwarded verbatim they break JSON encoders and terminal
 *   renderers.
 * - Text before an opening tag is the answer (some models answer first and
 *   reason afterwards), so it stays content; only the enclosed span becomes
 *   reasoning.
 */

/** Tags whose enclosed span is reasoning, longest-first so `</thinking>` is never split as `<t`. */
const OPEN_TAGS = ["<" + "thinking" + ">", "<" + "think" + ">"] as const;
const CLOSE_TAGS = ["<" + "/" + "thinking" + ">", "<" + "/" + "think" + ">"] as const;

/** An opening tag, with optional attributes between the name and the `>`. */
const THINK_OPEN_RE = /^<think(?:ing)?\b[^>]*>/;
/** A closing tag with optional whitespace before `>` (`</think >`). */
const THINK_CLOSE_RE = /^<\/(?:think|thinking)\s*>/;

/**
 * Fail-open cap for an unclosed thinking span. Past it the span is treated as
 * plain text instead of being buffered indefinitely — same rule as DSML's
 * `maxBlockBytes` reference guard.
 */
const MAX_THINK_BLOCK_BYTES = 64 * 1024;

/** Every tag spelling a dangling suffix may be a prefix of. */
const ALL_TAGS: readonly string[] = [...OPEN_TAGS, ...CLOSE_TAGS];

/**
 * The longest suffix of `text` that is a proper prefix of any entry in
 * `frontier` — the trailing run that could still grow into a tag on the next
 * chunk. One home for the hold-back rule shared by the think splitters and
 * the generic markup stream parser.
 */
export function longestDanglingPrefix(text: string, frontier: readonly string[]): string {
  const limit = Math.min(
    frontier.reduce((max, tag) => Math.max(max, tag.length - 1), 0),
    text.length,
  );
  for (let length = limit; length > 0; length -= 1) {
    const suffix = text.slice(-length);
    if (frontier.some((tag) => tag.startsWith(suffix))) return suffix;
  }
  return "";
}

/** The longest suffix of `text` that is a proper prefix of any think tag. */
function danglingTagPrefix(text: string): string {
  return longestDanglingPrefix(text, ALL_TAGS);
}

/** Length of the trailing backtick run of `text` (0 when it does not end in one). */
function trailingBacktickRun(text: string): number {
  let run = 0;
  while (run < text.length && text[text.length - 1 - run] === "`") run += 1;
  return run;
}

/**
 * Length of the longest suffix of `text` that a next append could still turn
 * into a think tag: a *proper* prefix of some tag spelling. Unlike the
 * hold-back rule (`danglingTagPrefix`), a complete trailing tag does not count
 * — no longer tag spelling starts with a shorter one's full spelling, so its
 * bytes are already settled and the scanner must cross them (a scan bound that
 * stopped at such a tag would defer its match to the next push).
 */
function unsafeTagPrefixLen(text: string): number {
  const limit = Math.min(
    ALL_TAGS.reduce((max, tag) => Math.max(max, tag.length - 1), 0),
    text.length,
  );
  for (let length = limit; length > 0; length -= 1) {
    const suffix = text.slice(-length);
    if (ALL_TAGS.some((tag) => tag.length > length && tag.startsWith(suffix))) return length;
  }
  return 0;
}

/**
 * Code-span state the scanner carries between positions. Backtick runs open
 * an inline span (a single backtick) or a fence (three or more); a newline
 * closes an inline span that never closed on its own line while a fence runs
 * to a closing line.
 */
interface CodeState {
  ticks: number;
  fenced: boolean;
}

/**
 * A tag match plus the code state at the match, so the caller can commit it.
 * `kind` is `"open"` or `"close"` — which frontier the tag came from.
 */
interface TagMatch {
  readonly index: number;
  readonly length: number;
  readonly kind: "open" | "close";
  readonly codeTicks: number;
  readonly codeFenced: boolean;
}

/**
 * Saved scan position for an open span's tag search: the buffer offset and the
 * code state a full rescan would stand at there. Valid only while the buffer
 * grows by appends; every other buffer change clears it.
 */
interface ScanBookmark {
  readonly from: number;
  readonly ticks: number;
  readonly fenced: boolean;
}

/**
 * A stream tag search: the first wanted tag, plus — when the search found none
 * — where the next scan of the same append-only buffer should resume.
 */
interface TagSearch {
  readonly match: TagMatch | undefined;
  readonly resume: ScanBookmark | undefined;
}

/**
 * Matches one tag spelling at `index`. `strict` selects the spelling set: the
 * stream splitters accept only the literal `OPEN_TAGS`/`CLOSE_TAGS` entries,
 * while the one-shot stripper also accepts the relaxed `</think >` whitespace
 * form and attribute-carrying openers — the historical regex-backed strip.
 * Only `<` positions reach here, and a think tag's second byte is always `t`
 * or `/`, so the match is a prefix test plus two anchored regexes — no slice
 * per candidate.
 */
function matchThinkTag(
  value: string,
  index: number,
  strict: boolean,
): { readonly kind: "open" | "close"; readonly length: number } | undefined {
  const second = value[index + 1];
  if (second === "/") {
    // Closing tags: `</thinking>` / `</think>`, longest first so `</thinking>`
    // is never split as `</think` + `ing>`.
    for (const tag of CLOSE_TAGS) {
      if (value.startsWith(tag, index)) return { kind: "close", length: tag.length };
    }
    if (!strict) {
      const relaxed = THINK_CLOSE_RE.exec(value.slice(index));
      if (relaxed !== null) return { kind: "close", length: relaxed[0].length };
    }
    return undefined;
  }
  if (second !== "t") return undefined;
  if (!strict) {
    const opened = THINK_OPEN_RE.exec(value.slice(index));
    return opened === null ? undefined : { kind: "open", length: opened[0].length };
  }
  for (const tag of OPEN_TAGS) {
    if (value.startsWith(tag, index)) return { kind: "open", length: tag.length };
  }
  return undefined;
}

/**
 * The first think tag at or after `from` and before `end` that is *not* inside
 * a code span or fence, scanning left to right so code state is tracked exactly
 * once per position. `state` carries the code position in from earlier scans
 * and is advanced through every byte examined — including the matched tag's own
 * bytes, which never carry code state — so it is exact for the next call.
 * Returns `undefined` when no tag exists in the range.
 */
function scanThinkTag(
  value: string,
  from: number,
  state: CodeState,
  strict: boolean,
  end: number,
): TagMatch | undefined {
  for (let i = from; i < end; i++) {
    const char = value[i]!;
    if (char === "`") {
      let run = 1;
      while (value[i + run] === "`") run++;
      if (state.ticks === 0) {
        state.ticks = run;
        state.fenced = run >= 3;
      } else if (run === state.ticks) {
        state.ticks = 0;
        state.fenced = false;
      }
      i += run - 1;
      continue;
    }
    // A newline closes an inline span that never closed on its own line; a
    // fence runs to a closing line instead.
    if (char === "\n" && state.ticks > 0 && !state.fenced) state.ticks = 0;
    if (char !== "<" || state.ticks > 0) continue;
    const tag = matchThinkTag(value, i, strict);
    if (tag === undefined) continue;
    const match: TagMatch = {
      index: i,
      length: tag.length,
      kind: tag.kind,
      codeTicks: state.ticks,
      codeFenced: state.fenced,
    };
    // Tag spellings hold no backtick or newline, so the code state at the
    // match is the state the scan carried in — but the scan position must
    // move past the tag or the next call would refind it.
    i += tag.length - 1;
    return match;
  }
  return undefined;
}

/**
 * The earliest occurrence of any of `tags` in `buffer` outside a code span or
 * fence — the one tag search both stream splitters run. Scanning left to right
 * tracks the code state exactly once per position; a tag of the other frontier
 * is literal content and skipped, matching the historical per-tag scan.
 *
 * `bookmark` resumes a previous search of the same append-only buffer instead
 * of rewalking bytes already examined; the outcome is identical to a scan from
 * the start because the skipped prefix is unchanged and holds no match for
 * `tags`. When no wanted tag is found, the search also returns the next resume
 * point: the start of the buffer's unsafe tail — the trailing backtick run or
 * an uncompleted tag prefix, whose bytes can still grow into a run or a tag on
 * the next append, so no complete tag can start or end inside it — together
 * with the code state at that offset. The caller persists it across pushes and
 * clears it on any non-append buffer change; a found match clears it too,
 * since the caller consumes the tag and rewrites the buffer next.
 */
function findTagInBuffer(
  buffer: string,
  tags: readonly string[],
  codeTicks: number,
  codeFenced: boolean,
  bookmark?: ScanBookmark | undefined,
): TagSearch {
  const state: CodeState =
    bookmark === undefined
      ? { ticks: codeTicks, fenced: codeFenced }
      : { ticks: bookmark.ticks, fenced: bookmark.fenced };
  // No complete tag can start or end inside the unsafe tail, so the scan stops
  // at its start; the tail is rewalked — with the state carried to it — once
  // the next append has settled it.
  const tail = Math.max(trailingBacktickRun(buffer), unsafeTagPrefixLen(buffer));
  const safe = buffer.length - tail;
  let from = bookmark === undefined ? 0 : bookmark.from;
  for (;;) {
    const match = scanThinkTag(buffer, from, state, true, safe);
    if (match === undefined) {
      // `state` now stands exactly at `safe`.
      return {
        match: undefined,
        resume: { from: safe, ticks: state.ticks, fenced: state.fenced },
      };
    }
    if (tags.includes(buffer.slice(match.index, match.index + match.length))) {
      return { match, resume: undefined };
    }
    // A tag of the other frontier: skip it and keep scanning. `state` already
    // sits just past its bytes, and the tag cannot end past `safe`.
    from = match.index + match.length;
  }
}

/**
 * Removes visible thinking tags, leaving any that sit inside a code span or
 * fence alone — and leaving any tag that is not part of a complete pair alone
 * too, since an unpaired tag is the subject of the answer rather than markup
 * the upstream leaked.
 *
 * A tag inside backticks is the *subject* of the answer — documentation or a
 * code sample showing the tag — not markup the upstream leaked, so stripping it
 * would silently rewrite the answer. The same goes for an opening tag whose
 * closing tag never arrived or a closing tag with no opener.
 *
 * Single pass: the code-span state is tracked once per position and both the
 * opening tag and its paired close are found by the same scanner, so a string
 * full of unclosed `<think>` openers costs one walk, not one walk per opener.
 */
export function stripThinkingTags(value: string): string {
  if (!value.includes("<")) return value;
  let out = "";
  const state: CodeState = { ticks: 0, fenced: false };
  let i = 0;
  while (i < value.length) {
    const match = scanThinkTag(value, i, state, false, value.length);
    if (match === undefined) {
      out += value.slice(i);
      break;
    }
    out += value.slice(i, match.index);
    const tagEnd = match.index + match.length;
    if (match.kind === "close") {
      // A closing tag with no opener is literal output.
      out += value.slice(match.index, tagEnd);
      i = tagEnd;
      continue;
    }
    // Look for the paired close, resuming code state where the open left it.
    // The state object already reflects every byte through the opener; the
    // inner text cannot contain a tag (the close is the first one found), but
    // it can contain backticks that change code state — the shared scan
    // tracks them exactly once.
    let close: TagMatch | undefined;
    let from = tagEnd;
    for (;;) {
      const next = scanThinkTag(value, from, state, false, value.length);
      if (next === undefined) break;
      if (next.kind === "close") {
        close = next;
        break;
      }
      // An opening tag inside the span is literal content, not a nested span:
      // resume after it. `state` already sits past its bytes.
      from = next.index + next.length;
    }
    if (close === undefined) {
      // No matching close: the opening tag is literal output, keep it and
      // resume scanning after it. `state` already reflects every byte the
      // failed close scan examined, so continuing from `tagEnd` is exact.
      out += value.slice(match.index, tagEnd);
      i = tagEnd;
      continue;
    }
    // A complete paired span is reasoning markup: keep the inner text, drop
    // the tag bytes. `state` carries the code position at the close because
    // the shared scan tracked it through the inner text.
    out += value.slice(tagEnd, close.index);
    i = close.index + close.length;
  }
  return out;
}

/** Strips the NUL padding MiMo Studio injects into thought streams. */
function stripNul(text: string): string {
  return text.includes("\u0000") ? text.replace(/\u0000/g, "") : text;
}

/**
 * Stateful strip of paired thinking tags that preserves source order.
 *
 * The reasoning channel (e.g. Chat `reasoning_content`) is one stream where
 * every byte — tagged or not — is thought. The two-bucket split used by
 * `ThinkSplitter` (`{ text, reasoning }`) cannot express interleaving, so a
 * call site that joins `${reasoning}${text}` reorders the stream: untagged
 * prose that preceded a `<think>` span lands after it. This stripper instead
 * emits the whole settled content with paired tags removed, in source order,
 * while keeping `ThinkSplitter`'s stateful guarantees: a tag split across two
 * deltas is recognized, code spans are left alone, and an unclosed span fails
 * open at the cap.
 */
export class ThinkingTagStripper {
  #buffer = "";
  #codeTicks = 0;
  #codeFenced = false;
  /** True once an opening tag has been seen and its close has not arrived yet. */
  #inUnclosedSpan = false;
  /** The opening tag currently held, restored verbatim on fail-open/flush. */
  #openMarker = "";
  /** Saved close-scan position while the span is unclosed; see `ScanBookmark`. */
  #scanBookmark: ScanBookmark | undefined;

  /** Feeds a chunk; returns settled content with paired tags removed, in order. */
  push(chunk: string): string {
    this.#buffer += stripNul(chunk);
    let out = "";
    for (;;) {
      if (this.#inUnclosedSpan) {
        const closed = this.#findClose();
        if (closed === undefined) break;
        out += this.#buffer.slice(0, closed.index);
        this.#buffer = this.#buffer.slice(closed.index + closed.length);
        this.#scanBookmark = undefined;
        this.#codeTicks = closed.codeTicks;
        this.#codeFenced = closed.codeFenced;
        this.#inUnclosedSpan = false;
        this.#openMarker = "";
        continue;
      }
      const opened = this.#findOpen();
      if (opened === undefined) break;
      out += this.#buffer.slice(0, opened.index);
      this.#openMarker = this.#buffer.slice(opened.index, opened.index + opened.length);
      this.#buffer = this.#buffer.slice(opened.index + opened.length);
      this.#scanBookmark = undefined;
      this.#codeTicks = opened.codeTicks;
      this.#codeFenced = opened.codeFenced;
      this.#inUnclosedSpan = true;
    }
    if (this.#inUnclosedSpan) {
      // No close yet: hold the whole span content — including any text after it
      // — until a later close or `flush()`. Streaming it now would release the
      // span content before its opening tag on fail-open.
      if (this.#buffer.length > MAX_THINK_BLOCK_BYTES) {
        out += this.#openMarker + this.#buffer;
        this.#buffer = "";
        this.#scanBookmark = undefined;
        this.#inUnclosedSpan = false;
        this.#openMarker = "";
      }
      return out;
    }
    const held = danglingTagPrefix(this.#buffer);
    const settled = held.length > 0 ? this.#buffer.slice(0, -held.length) : this.#buffer;
    this.#buffer = held;
    this.#scanBookmark = undefined;
    return out + settled;
  }

  /** Releases content held back for a tag that never completed. */
  flush(): string {
    const rest = this.#buffer;
    this.#buffer = "";
    this.#scanBookmark = undefined;
    this.#codeTicks = 0;
    this.#codeFenced = false;
    if (this.#inUnclosedSpan) {
      // An open tag that never closed is not evidence of reasoning — restore it
      // byte-for-byte and release the whole tail as-is.
      const marker = this.#openMarker;
      this.#inUnclosedSpan = false;
      this.#openMarker = "";
      return marker + rest;
    }
    return rest;
  }

  /**
   * The first open tag outside code. The open search never resumes: outside an
   * unclosed span each push ends by trimming the buffer to a dangling tag
   * prefix, so a fresh scan from the start is cheap.
   */
  #findOpen(): TagMatch | undefined {
    return findTagInBuffer(this.#buffer, OPEN_TAGS, this.#codeTicks, this.#codeFenced).match;
  }

  /** The first close tag outside code, resuming from the saved scan position. */
  #findClose(): TagMatch | undefined {
    const search = findTagInBuffer(
      this.#buffer,
      CLOSE_TAGS,
      this.#codeTicks,
      this.#codeFenced,
      this.#scanBookmark,
    );
    // Persist the resume point after a scan that found nothing; a found match
    // clears it — the caller consumes the tag and rewrites the buffer next.
    this.#scanBookmark = search.resume;
    return search.match;
  }
}

export interface ThinkSplit {
  /** Answer text, with all reasoning spans removed. */
  readonly text: string;
  /** Reasoning text, tag-free. Empty when the chunk carried no thought. */
  readonly reasoning: string;
  /**
   * Content that landed inside a span that is still open at the end of this
   * chunk. It is not yet classified — the span has not closed — so callers
   * that render must not emit it; a loop guard may still watch it.
   */
  readonly pendingReasoning: string;
}

/**
 * Splits one upstream text chunk into answer text and reasoning text.
 *
 * Only a pair of matching tags resolves to reasoning: the text inside stays
 * buffered until the closing tag arrives, so the split is never decided before
 * the span is known to be complete. If the stream ends (or the buffer exceeds
 * `MAX_THINK_BLOCK_BYTES`) with the span still open, the whole thing is
 * released as plain text.
 *
 * Call `flush()` once the upstream stream ends to release any text the splitter
 * held back while it waited for a possible tag to complete.
 */
export class ThinkSplitter {
  #buffer = "";
  #inReasoning = false;
  /** The opening tag of the span currently being scanned; restored on fail-open. */
  #openMarker = "";
  /** Backtick run that opened the code span/fence we are inside; 0 when not in
   *  code. A tag inside a code span is the *subject* of the answer — a doc or a
   *  code sample mentioning `<think>` — not a delimiter, so it must survive
   *  verbatim instead of splitting the stream. */
  #codeTicks = 0;
  /** Whether `#codeTicks` opened a fenced block (closes on its own line) rather
   *  than an inline span. */
  #codeFenced = false;
  /** Saved close-scan position while the span is open; see `ScanBookmark`. */
  #scanBookmark: ScanBookmark | undefined;
  /** Span characters already reported as `pendingReasoning`; only the fresh
   *  tail of the open span is reported per chunk. */
  #reportedSpanLen = 0;

  /** Feeds a chunk; returns the text/reasoning split for everything settled. */
  push(chunk: string): ThinkSplit {
    this.#buffer += stripNul(chunk);
    let text = "";
    let reasoning = "";

    for (;;) {
      if (!this.#inReasoning) {
        const opened = this.#findOpen();
        if (opened === undefined) break;
        text += this.#consumeUpTo(opened);
        const openTag = this.#buffer.slice(opened.index, opened.index + opened.length);
        this.#buffer = this.#buffer.slice(opened.index + opened.length);
        this.#scanBookmark = undefined;
        this.#inReasoning = true;
        this.#openMarker = openTag;
        continue;
      }
      const closed = this.#findClose();
      if (closed === undefined) break;
      reasoning += this.#consumeUpTo(closed);
      this.#buffer = this.#buffer.slice(closed.index + closed.length);
      this.#scanBookmark = undefined;
      this.#inReasoning = false;
      this.#openMarker = "";
      this.#reportedSpanLen = 0;
    }

    // Hold back a suffix that could still grow into a tag; the rest is settled.
    const held = danglingTagPrefix(this.#buffer);
    const settled = held.length > 0 ? this.#buffer.slice(0, -held.length) : this.#buffer;
    let pendingReasoning = "";
    if (this.#inReasoning) {
      // The closing tag has not arrived: do not classify any of this as
      // reasoning yet. Keep it buffered so a later close can resolve it, but
      // fail open past the cap so a runaway cannot buffer forever.
      if (settled.length > MAX_THINK_BLOCK_BYTES) {
        text += this.#openMarker + settled;
        this.#buffer = held;
        this.#scanBookmark = undefined;
        this.#inReasoning = false;
        this.#openMarker = "";
        this.#reportedSpanLen = 0;
      } else {
        // Content-identical reassembly: the saved scan position stays valid.
        this.#buffer = settled + held;
        // Fresh span content this chunk added — visible to a loop guard, never
        // to a renderer (the span has not closed).
        pendingReasoning = this.#buffer.slice(this.#reportedSpanLen);
        this.#reportedSpanLen = this.#buffer.length;
        return { text, reasoning, pendingReasoning };
      }
    } else {
      text += stripThinkingTags(settled);
      this.#buffer = held;
      this.#scanBookmark = undefined;
    }
    return { text, reasoning, pendingReasoning };
  }

  /** Releases text held back for a tag that never completed. */
  flush(): ThinkSplit {
    const rest = this.#buffer;
    this.#buffer = "";
    this.#scanBookmark = undefined;
    this.#codeTicks = 0;
    this.#codeFenced = false;
    this.#reportedSpanLen = 0;
    if (this.#inReasoning) {
      // An open tag that never closed is not evidence of reasoning — restore it
      // byte-for-byte and release the whole tail as text.
      this.#inReasoning = false;
      const marker = this.#openMarker;
      this.#openMarker = "";
      return { text: marker + stripThinkingTags(rest), reasoning: "", pendingReasoning: "" };
    }
    return { text: stripThinkingTags(rest), reasoning: "", pendingReasoning: "" };
  }

  /** Returns the text before a tag and commits the code state at it. */
  #consumeUpTo(match: TagMatch): string {
    this.#codeTicks = match.codeTicks;
    this.#codeFenced = match.codeFenced;
    return this.#buffer.slice(0, match.index);
  }

  /**
   * The first open tag outside code. The open search never resumes: outside a
   * span each push ends by trimming the buffer to a dangling tag prefix, so a
   * fresh scan from the start stays cheap.
   */
  #findOpen(): TagMatch | undefined {
    return findTagInBuffer(this.#buffer, OPEN_TAGS, this.#codeTicks, this.#codeFenced).match;
  }

  /** The first close tag outside code, resuming from the saved scan position. */
  #findClose(): TagMatch | undefined {
    const search = findTagInBuffer(
      this.#buffer,
      CLOSE_TAGS,
      this.#codeTicks,
      this.#codeFenced,
      this.#scanBookmark,
    );
    // Persist the resume point after a scan that found nothing; a found match
    // clears it — the caller consumes the tag and rewrites the buffer next.
    this.#scanBookmark = search.resume;
    return search.match;
  }
}
