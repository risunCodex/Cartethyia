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
const OPEN_TAGS = ["<thinking>", "<think>"] as const;
const CLOSE_TAGS = ["</thinking>", "</think>"] as const;

/** An opening tag, with optional attributes between the name and the `>`. */
const THINK_OPEN_RE = /^<think(?:ing)?\b[^>]*>/;

/**
 * Fail-open cap for an unclosed thinking span. Past it the span is treated as
 * plain text instead of being buffered indefinitely — same rule as DSML's
 * `maxBlockBytes` reference guard.
 */
const MAX_THINK_BLOCK_BYTES = 64 * 1024;

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
 */
export function stripThinkingTags(value: string): string {
  if (!value.includes("<")) return value;
  let out = "";
  let i = 0;
  let ticks = 0;
  let fenced = false;
  while (i < value.length) {
    const char = value[i];
    if (char === "`") {
      let run = 1;
      while (value[i + run] === "`") run++;
      if (ticks === 0) {
        ticks = run;
        fenced = run >= 3;
      } else if (run === ticks) {
        ticks = 0;
        fenced = false;
      }
      out += value.slice(i, i + run);
      i += run;
      continue;
    }
    // A newline closes an inline span that never closed on its own line; a
    // fence runs to a closing line instead.
    if (char === "\n" && ticks > 0 && !fenced) ticks = 0;
    if (char !== "<" || ticks > 0) {
      out += char;
      i += 1;
      continue;
    }
    const opened = THINK_OPEN_RE.exec(value.slice(i))?.[0];
    if (opened === undefined) {
      out += char;
      i += 1;
      continue;
    }
    const innerStart = i + opened.length;
    const closed = pairedClose(value, innerStart, ticks, fenced);
    if (closed === undefined) {
      // No matching close: the opening tag is literal output, keep it.
      out += char;
      i += 1;
      continue;
    }
    // A complete paired span is reasoning markup: keep the inner text, drop
    // the tag bytes.
    out += value.slice(innerStart, closed.index);
    i = closed.index + closed.length;
  }
  return out;
}

interface PairedClose {
  readonly index: number;
  readonly length: number;
}

/** The first closing tag at or after `from`, outside any code span/fence. */
function pairedClose(
  value: string,
  from: number,
  ticksIn: number,
  fencedIn: boolean,
): PairedClose | undefined {
  let ticks = ticksIn;
  let fenced = fencedIn;
  for (let i = from; i < value.length; i++) {
    const char = value[i];
    if (char === "`") {
      let run = 1;
      while (value[i + run] === "`") run++;
      if (ticks === 0) {
        ticks = run;
        fenced = run >= 3;
      } else if (run === ticks) {
        ticks = 0;
        fenced = false;
      }
      i += run - 1;
      continue;
    }
    if (char === "\n" && ticks > 0 && !fenced) ticks = 0;
    if (char !== "<" || ticks > 0) continue;
    for (const tag of CLOSE_TAGS) {
      if (value.startsWith(tag, i)) return { index: i, length: tag.length };
    }
    // `</think >` / `</thinking >`: whitespace before the closing `>` is
    // accepted, same as the historical regex-backed strip.
    const relaxed = /^<\/(?:think|thinking)\s*>/.exec(value.slice(i));
    if (relaxed !== null) return { index: i, length: relaxed[0].length };
  }
  return undefined;
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

  /** Feeds a chunk; returns settled content with paired tags removed, in order. */
  push(chunk: string): string {
    this.#buffer += stripNul(chunk);
    let out = "";
    for (;;) {
      if (this.#inUnclosedSpan) {
        const closed = this.#findTag(CLOSE_TAGS);
        if (closed === undefined) break;
        out += this.#buffer.slice(0, closed.index);
        this.#buffer = this.#buffer.slice(closed.index + closed.length);
        this.#codeTicks = closed.codeTicks;
        this.#codeFenced = closed.codeFenced;
        this.#inUnclosedSpan = false;
        this.#openMarker = "";
        continue;
      }
      const opened = this.#findTag(OPEN_TAGS);
      if (opened === undefined) break;
      out += this.#buffer.slice(0, opened.index);
      this.#openMarker = this.#buffer.slice(opened.index, opened.index + opened.length);
      this.#buffer = this.#buffer.slice(opened.index + opened.length);
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
        this.#inUnclosedSpan = false;
        this.#openMarker = "";
      }
      return out;
    }
    const held = danglingTagPrefix(this.#buffer);
    const settled = held.length > 0 ? this.#buffer.slice(0, -held.length) : this.#buffer;
    this.#buffer = held;
    return out + settled;
  }

  /** Releases content held back for a tag that never completed. */
  flush(): string {
    const rest = this.#buffer;
    this.#buffer = "";
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

  #findTag(tags: readonly string[]): TagMatch | undefined {
    const buffer = this.#buffer;
    let ticks = this.#codeTicks;
    let fenced = this.#codeFenced;
    for (let i = 0; i < buffer.length; i++) {
      const char = buffer[i];
      if (char === "`") {
        let run = 1;
        while (buffer[i + run] === "`") run++;
        if (ticks === 0) {
          ticks = run;
          fenced = run >= 3;
        } else if (run === ticks) {
          ticks = 0;
          fenced = false;
        }
        i += run - 1;
        continue;
      }
      if (char === "\n" && ticks > 0 && !fenced) ticks = 0;
      if (char !== "<" || ticks > 0) continue;
      for (const tag of tags) {
        if (!buffer.startsWith(tag, i)) continue;
        return { index: i, length: tag.length, codeTicks: ticks, codeFenced: fenced };
      }
    }
    return undefined;
  }
}

/** The longest suffix of `text` that is a proper prefix of any tag. */
function danglingTagPrefix(text: string): string {
  const tags = [...OPEN_TAGS, ...CLOSE_TAGS];
  const maxLength = Math.max(...tags.map((tag) => tag.length)) - 1;
  const limit = Math.min(maxLength, text.length);
  for (let length = limit; length > 0; length -= 1) {
    const suffix = text.slice(-length);
    if (tags.some((tag) => tag.startsWith(suffix))) return suffix;
  }
  return "";
}

/** Strips the NUL padding MiMo Studio injects into thought streams. */
function stripNul(text: string): string {
  return text.includes("\u0000") ? text.replace(/\u0000/g, "") : text;
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

/** A tag match plus the code state at the match, so the caller commits it. */
interface TagMatch {
  readonly index: number;
  readonly length: number;
  readonly codeTicks: number;
  readonly codeFenced: boolean;
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
        this.#inReasoning = true;
        this.#openMarker = openTag;
        continue;
      }
      const closed = this.#findClose();
      if (closed === undefined) break;
      reasoning += this.#consumeUpTo(closed);
      this.#buffer = this.#buffer.slice(closed.index + closed.length);
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
        this.#inReasoning = false;
        this.#openMarker = "";
        this.#reportedSpanLen = 0;
      } else {
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
    }
    return { text, reasoning, pendingReasoning };
  }

  /** Releases text held back for a tag that never completed. */
  flush(): ThinkSplit {
    const rest = this.#buffer;
    this.#buffer = "";
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

  #findOpen(): TagMatch | undefined {
    return this.#findTag(OPEN_TAGS);
  }

  #findClose(): TagMatch | undefined {
    return this.#findTag(CLOSE_TAGS);
  }

  /**
   * The earliest occurrence of any of `tags` that is *not* inside a code span
   * or fence, scanning left to right so code state is tracked exactly once per
   * position. Returns the match and the code state at it, so `push` can commit
   * that state when it consumes the tag.
   */
  #findTag(tags: readonly string[]): TagMatch | undefined {
    const buffer = this.#buffer;
    let ticks = this.#codeTicks;
    let fenced = this.#codeFenced;
    for (let i = 0; i < buffer.length; i++) {
      const char = buffer[i];
      if (char === "`") {
        let run = 1;
        while (buffer[i + run] === "`") run++;
        if (ticks === 0) {
          ticks = run;
          // Three or more backticks open a fence rather than an inline span.
          fenced = run >= 3;
        } else if (run === ticks) {
          ticks = 0;
          fenced = false;
        }
        i += run - 1;
        continue;
      }
      // A newline closes an inline span that never closed on its own line; a
      // fence runs to a closing line instead.
      if (char === "\n" && ticks > 0 && !fenced) ticks = 0;
      if (char !== "<" || ticks > 0) continue;
      for (const tag of tags) {
        if (!buffer.startsWith(tag, i)) continue;
        return { index: i, length: tag.length, codeTicks: ticks, codeFenced: fenced };
      }
    }
    return undefined;
  }
}
