/**
 * Thinking-loop guard for streamed reasoning.
 *
 * A model that falls into a degenerate reasoning loop re-emits the same
 * paragraph — byte-identical or with cosmetic wording drift — until it burns
 * the whole output budget without ever answering. The stream never goes silent,
 * so the only protection this codebase had (`streamStallTimeoutMs`) cannot fire:
 * it watches for *absence* of bytes, and a runaway emits them continuously.
 *
 * This is a narrow port of the donor `ThinkingLoopDetector`
 * (`Public/oh-my-pi/packages/ai/src/utils/thinking-loop.ts`). Ported:
 * 1. **Exact suffix cycles** — a byte-identical unit repeated back-to-back.
 *    Model-independent and calibration-free.
 * 2. **Near-duplicate segments** — paragraphs that normalize to the same
 *    word-trigram fingerprint.
 *
 * Deliberately NOT ported: the donor's progress-lexicon novelty detector (its
 * constants were calibrated against a 536k-block corpus we do not have) and its
 * Gemini-specific summary-header runaway. Both would be uncalibrated guesses
 * here and are better added later, with their corpora, if the shapes are
 * actually observed.
 *
 * The detector is fed one reasoning delta at a time and returns a
 * human-readable reason the first time a loop shape is recognized; every later
 * call returns the same reason so a caller that does not stop stays harmless.
 * Ported constants are copied verbatim — they are calibration values, not
 * design choices.
 */

/** Stable lead phrase of the guard's reason; exported for tests and for the
 *  terminal event's `provider_stop_reason`. */
export const THINKING_LOOP_MARKER = "Thinking loop detected";

/** Rolling tail retained for exact suffix-cycle detection. */
const EXACT_TAIL_WINDOW = 4096;
/** Longest exact cycle length considered. */
const EXACT_MAX_UNIT = 1024;
/** New characters between scans. Large deltas are scanned immediately. */
const EXACT_CHECK_STRIDE = 128;
/** Short cycles need four repeats covering at least this many characters. */
const EXACT_SHORT_MAX_UNIT = 60;
const EXACT_SHORT_MIN_REPEATED_CHARS = 180;
/** Long cycles need at least three repeats covering at least this many chars. */
const EXACT_LONG_MIN_REPEATED_CHARS = 1024;
/** Repeated characters before a punctuation-only run counts as a loop. Matches
 *  {@link EXACT_LONG_MIN_REPEATED_CHARS}: a kilobyte of one punctuation cycle
 *  back-to-back is degenerate, while the short separators real output produces
 *  (table rules, dividers) never reach it. */
const EXACT_PUNCTUATION_MIN_REPEATED_CHARS = EXACT_LONG_MIN_REPEATED_CHARS;

/** Char cap for an unterminated segment; forces a flush so a wall-of-text loop
 *  (no blank lines / headings) still segments. */
const SEGMENT_CHAR_CAP = 700;
/** Normalized-length floor below which a segment is ignored (too short to be a
 *  meaningful paragraph; bare headings must not trip detection). */
const SEGMENT_MIN_NORM_CHARS = 60;
/** How many recent substantial segments are kept for similarity comparison. */
const SEGMENT_WINDOW = 16;
/** Word-trigram Jaccard at/above which two segments count as near-duplicates. */
const SEGMENT_SIMILARITY = 0.8;
/** Substantial segments required before detection may fire (warm-up). */
const SEGMENT_MIN_COUNT = 8;
/** Near-duplicate cluster size (current + matches) that trips the loop. */
const SEGMENT_MIN_CLUSTER = 4;

/** A whole line shaped like code rather than prose: a fence marker, an indented
 *  line that is not a nested list item, or a line ending in a block, statement,
 *  or markup delimiter. Classified per line rather than by fence state because
 *  thought summaries routinely end inside an unclosed fence; tracking fences
 *  would hide every later prose paragraph from the heuristics. */
const CODE_LINE = /^(?:[ \t]*```.*|(?: {2,}|\t)(?![ \t]*(?:[-*+]|\d+[.)])[ \t]).*|.*[{}[\](;,>][ \t]*)$/gm;

interface ThinkingLoopConfig {
  readonly enabled?: boolean;
}

/**
 * Stateful detector fed the streamed reasoning deltas of one stream. `push`
 * returns a human-readable reason the first time a loop shape is recognized and
 * the same reason on every later call, so a caller that keeps feeding after the
 * first hit cannot double-report.
 */
export class ThinkingLoopDetector {
  /** Rolling char tail for exact suffix-cycle detection. */
  #tail = "";
  /** Total characters received when the exact detector last scanned. */
  #exactScannedAt = 0;
  /** Pending reasoning text not yet split into completed segments. */
  #pending = "";
  /** Fingerprints of the most recent substantial segments (≤ SEGMENT_WINDOW). */
  #window: Set<string>[] = [];
  /** Count of substantial segments seen so far (warm-up gate). */
  #count = 0;
  /** The reason produced by the first hit; latched for idempotent re-reporting. */
  #reason: string | undefined;

  constructor(private readonly config: ThinkingLoopConfig = {}) {}

  /** Whether a loop has already been detected. */
  get detected(): boolean {
    return this.#reason !== undefined;
  }

  /** Feeds one reasoning delta. Returns the reason on and after the first hit. */
  push(delta: string): string | undefined {
    if (this.#reason !== undefined) return this.#reason;
    if (this.config.enabled === false) return undefined;
    if (delta.length === 0) return undefined;

    // 1. Exact suffix cycles. Scan at a bounded cadence rather than doing
    // quadratic work for every token-sized delta.
    this.#tail += delta;
    if (this.#tail.length > EXACT_TAIL_WINDOW) this.#tail = this.#tail.slice(-EXACT_TAIL_WINDOW);
    this.#exactScannedAt += delta.length;
    if (this.#exactScannedAt >= EXACT_CHECK_STRIDE || delta.length >= EXACT_CHECK_STRIDE) {
      this.#exactScannedAt = 0;
      const exact = detectExactSuffixCycle(this.#tail);
      if (exact) {
        const [unit, times] = exact;
        this.#reason = `repeated an exact ${unit.length}-character cycle ${times}× back-to-back`;
        return this.#reason;
      }
    }

    // 2. Near-duplicate paragraph loop. Append, then drain completed segments.
    this.#pending += delta;
    for (;;) {
      const boundary = /\n\s*\n/.exec(this.#pending);
      let raw: string;
      if (boundary) {
        raw = this.#pending.slice(0, boundary.index);
        this.#pending = this.#pending.slice(boundary.index + boundary[0].length);
      } else if (this.#pending.length > SEGMENT_CHAR_CAP) {
        // No boundary yet but the segment is runaway-long: force a flush.
        raw = this.#pending.slice(0, SEGMENT_CHAR_CAP);
        this.#pending = this.#pending.slice(SEGMENT_CHAR_CAP);
      } else {
        return undefined;
      }
      // An over-long segment is chunked so each piece stays comparable.
      for (let rest = raw; rest.length > 0; ) {
        const chunk = rest.length > SEGMENT_CHAR_CAP ? rest.slice(0, SEGMENT_CHAR_CAP) : rest;
        rest = rest.slice(chunk.length);
        const hit = this.#consumeSegment(chunk);
        if (hit) {
          this.#reason = hit;
          return this.#reason;
        }
      }
    }
  }

  /** Process the buffered trailing paragraph (one with no blank-line / heading
   *  terminator). Called when the reasoning block ends so the final segment —
   *  which may be the one that completes a duplicate cluster — is not dropped. */
  flush(): string | undefined {
    if (this.#reason !== undefined) return this.#reason;
    if (this.config.enabled === false) return undefined;
    // A stream can end before the next cadence boundary: force one final exact
    // check even when nothing is pending.
    const exact = detectExactSuffixCycle(this.#tail);
    if (exact) {
      const [unit, times] = exact;
      this.#reason = `repeated an exact ${unit.length}-character cycle ${times}× back-to-back`;
      return this.#reason;
    }
    if (this.#pending.length === 0) return undefined;
    let rest = this.#pending;
    this.#pending = "";
    while (rest.length > 0) {
      const chunk = rest.length > SEGMENT_CHAR_CAP ? rest.slice(0, SEGMENT_CHAR_CAP) : rest;
      rest = rest.slice(chunk.length);
      const hit = this.#consumeSegment(chunk);
      if (hit) {
        this.#reason = hit;
        return this.#reason;
      }
    }
    return undefined;
  }

  #consumeSegment(raw: string): string | undefined {
    // Reasoning-summarizer titles ("**Maintaining Momentum**", "## Heading")
    // are per-thought formatting, not chain-of-thought; their ever-changing
    // wording would otherwise mask a loop by inflating novelty. Strip them and
    // code lines before analysis (a title- or code-only segment then falls below
    // the length gate).
    const segment = raw
      .replace(CODE_LINE, "")
      .replace(/^[ \t]*#{1,6}[ \t].*$/gm, "")
      .replace(/^[ \t]*\*{2,3}.+?\*{2,3}[ \t]*$/gm, "");
    const normalized = normalizeSegment(segment);
    if (normalized.length < SEGMENT_MIN_NORM_CHARS) return undefined;

    // Near-duplicate trigram cluster: the same paragraph reused with cosmetic
    // wording drift (high word-trigram overlap).
    const fingerprint = trigramShingles(normalized);
    let cluster = 1;
    for (const prev of this.#window) {
      if (jaccard(fingerprint, prev) >= SEGMENT_SIMILARITY) cluster++;
    }

    this.#window.push(fingerprint);
    if (this.#window.length > SEGMENT_WINDOW) this.#window.shift();
    this.#count++;

    if (this.#count >= SEGMENT_MIN_COUNT && cluster >= SEGMENT_MIN_CLUSTER) {
      return `${cluster} near-identical segments within the last ${SEGMENT_WINDOW}`;
    }
    return undefined;
  }
}

/** Reused Z-array scratch; scans are synchronous, so one buffer suffices. */
const exactZ = new Uint16Array(EXACT_MAX_UNIT + 1);

/**
 * Detect an exact cycle at the text suffix. A Z-array over the reversed tail
 * finds every possible suffix period in linear time without substring churn.
 * The reversal is virtual (indexed from the end) and only `z[1..maxUnit]` is
 * computed — the period check reads nothing past it, and each `z[i]` reads
 * only `z[i - left]` with `i - left < i`, which is already filled. Short
 * cycles retain the original 180-character/four-repeat sensitivity; long
 * cycles require at least three repeats and 1024 repeated characters.
 *
 * A unit carrying a letter or an emoji matches at those thresholds. A unit with
 * neither, such as the `?!?!` run a stuck model emits, matches only once it has
 * repeated for {@link EXACT_PUNCTUATION_MIN_REPEATED_CHARS} characters, and never
 * when it holds only digits and whitespace: padding, indentation and zero-filled
 * hexdumps or literals are ordinary output at any length.
 */
function detectExactSuffixCycle(text: string): [unit: string, count: number] | undefined {
  const n = text.length;
  if (n < EXACT_SHORT_MIN_REPEATED_CHARS) return undefined;
  const last = n - 1;
  const maxUnit = Math.min(EXACT_MAX_UNIT, Math.floor(n / 3));
  const z = exactZ;
  let left = 0;
  let right = 0;
  for (let i = 1; i <= maxUnit; i++) {
    let zi = i <= right ? Math.min(right - i + 1, z[i - left]!) : 0;
    // `z[i - left]` is always filled: `i - left < i` and `left >= 0`.
    while (i + zi < n && text.charCodeAt(last - zi) === text.charCodeAt(last - i - zi)) zi++;
    z[i] = zi;
    if (i + zi - 1 > right) {
      left = i;
      right = i + zi - 1;
    }
  }

  for (let len = 2; len <= maxUnit; len++) {
    // Every `z[len]` in this range was written by the loop above.
    const count = 1 + Math.floor(z[len]! / len);
    const minCount = len <= EXACT_SHORT_MAX_UNIT ? 4 : 3;
    if (count < minCount) continue;
    const unit = text.slice(-len);
    if (/\p{L}|\p{Extended_Pictographic}/u.test(unit)) {
      const minChars = len <= EXACT_SHORT_MAX_UNIT ? EXACT_SHORT_MIN_REPEATED_CHARS : EXACT_LONG_MIN_REPEATED_CHARS;
      if (len * count >= minChars) return [unit, count];
      continue;
    }
    if (/^[\p{N}\s]*$/u.test(unit)) continue;
    if (len * count >= EXACT_PUNCTUATION_MIN_REPEATED_CHARS) return [unit, count];
  }
  return undefined;
}

/** Lowercase and tokenize prose plus code/path payloads, dropping pure numbers. */
function normalizeSegment(segment: string): string {
  return segment
    .toLowerCase()
    .replace(/`([^`]*)`/g, " $1 ")
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((token) => /[a-z]/.test(token))
    .join(" ")
    .trim();
}

/** Word-trigram shingle set of a normalized segment. */
function trigramShingles(normalized: string): Set<string> {
  const words = normalized.split(" ").filter(Boolean);
  if (words.length < 3) return new Set(words.length > 0 ? [words.join(" ")] : []);
  const shingles = new Set<string>();
  for (let i = 0; i + 3 <= words.length; i++) {
    shingles.add(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
  }
  return shingles;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  const [small, large] = a.size < b.size ? [a, b] : [b, a];
  let intersection = 0;
  for (const x of small) {
    if (large.has(x)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}
