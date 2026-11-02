/**
 * Recovers the tool-call envelope some models occasionally emit as assistant
 * text instead of OpenAI `tool_calls`.
 *
 * The wire shape is the captured `<tool_calls:8hex>` / `<tool_call:8hex>` /
 * `<arg_key:8hex>` / `<arg_value:8hex>` form. Only complete envelopes are
 * interpreted. Calls are returned only when their names were declared on the
 * request; an undeclared name is never promoted into executable tool input.
 */
export interface OmpTextToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: string;
}

/** Text remaining after complete tool envelopes are removed. */
interface OmpTextToolCallResult {
  readonly text: string;
  readonly calls: readonly OmpTextToolCall[];
}

const OPEN_PREFIX = "<tool_calls:";
const OPEN_PATTERN = /^<tool_calls:([0-9a-f]{8})>/;
const TOOL_NAME_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,63}$/;

/**
 * Incrementally removes complete captured tool envelopes from text.
 *
 * The parser holds a possible envelope across SSE deltas, so a split opening
 * tag, argument tag, or closing tag is never emitted as visible prose. At
 * end-of-stream an unterminated envelope is dropped, not executed or leaked.
 */
export class OmpToolCallMarkupParser {
  readonly #allowedNames: ReadonlySet<string>;
  #pending = "";
  #callSequence = 0;

  constructor(allowedNames: ReadonlySet<string>) {
    this.#allowedNames = allowedNames;
  }

  /** Feeds one content or reasoning delta and returns only settled text. */
  push(chunk: string): OmpTextToolCallResult {
    this.#pending += chunk;
    let cursor = 0;
    let text = "";
    const calls: OmpTextToolCall[] = [];

    for (;;) {
      const openIndex = this.#pending.indexOf(OPEN_PREFIX, cursor);
      if (openIndex < 0) {
        const safeEnd = this.#settledEnd(cursor);
        text += this.#pending.slice(cursor, safeEnd);
        cursor = safeEnd;
        break;
      }

      text += this.#pending.slice(cursor, openIndex);
      const remainder = this.#pending.slice(openIndex);
      const opening = OPEN_PATTERN.exec(remainder);
      if (opening === null || opening[1] === undefined) {
        if (this.#couldBeOpening(remainder)) {
          cursor = openIndex;
          break;
        }
        text += "<";
        cursor = openIndex + 1;
        continue;
      }

      const marker = opening[1];
      const openTag = opening[0];
      const closeTag = `</tool_calls:${marker}>`;
      const closeIndex = this.#pending.indexOf(closeTag, openIndex + openTag.length);
      if (closeIndex < 0) {
        cursor = openIndex;
        break;
      }

      const envelopeEnd = closeIndex + closeTag.length;
      const block = this.#pending.slice(openIndex, envelopeEnd);
      const parsed = parseEnvelope(block, marker);
      if (parsed === undefined) {
        text += block;
      } else if (parsed.some((call) => !this.#allowedNames.has(call.name))) {
        // A syntactically valid call to an undeclared tool is model text, not
        // authority to invoke a tool the client did not offer.
        text += block;
      } else {
        for (const call of parsed) {
          calls.push({
            id: `call_omp_${marker}_${this.#callSequence++}`,
            name: call.name,
            arguments: call.arguments,
          });
        }
      }
      cursor = envelopeEnd;
    }

    this.#pending = this.#pending.slice(cursor);
    return { text, calls };
  }

  /**
   * Settles trailing text. A complete internal envelope cannot remain here;
   * an unfinished envelope is deliberately discarded rather than leaked.
   */
  flush(): OmpTextToolCallResult {
    const pending = this.#pending;
    this.#pending = "";
    if (this.#couldBeOpening(pending) || OPEN_PATTERN.test(pending)) {
      return { text: "", calls: [] };
    }
    return { text: pending, calls: [] };
  }

  #settledEnd(start: number): number {
    const remaining = this.#pending.slice(start);
    const maxPrefixLength = Math.min(OPEN_PREFIX.length - 1, remaining.length);
    for (let length = maxPrefixLength; length > 0; length -= 1) {
      if (OPEN_PREFIX.startsWith(remaining.slice(-length))) {
        return this.#pending.length - length;
      }
    }
    return this.#pending.length;
  }

  #couldBeOpening(value: string): boolean {
    if (value.length < OPEN_PREFIX.length) return OPEN_PREFIX.startsWith(value);
    if (!value.startsWith(OPEN_PREFIX)) return false;
    const suffix = value.slice(OPEN_PREFIX.length);
    return /^[0-9a-f]{0,8}$/.test(suffix) || /^[0-9a-f]{8}$/.test(suffix) && !value.endsWith(">");
  }
}

/**
 * Parses complete envelopes from one settled response field.
 *
 * The same parser backs JSON responses and streaming responses so recovery
 * semantics do not differ merely because the upstream selected `stream`.
 */
export function parseOmpToolCallMarkup(
  text: string,
  allowedNames: ReadonlySet<string>,
): OmpTextToolCallResult {
  const parser = new OmpToolCallMarkupParser(allowedNames);
  const first = parser.push(text);
  const last = parser.flush();
  return { text: first.text + last.text, calls: first.calls };
}

/**
 * Parses a complete captured tool envelope, returning undefined for malformed
 * structure. Argument values are JSON-decoded when they contain valid JSON;
 * otherwise their exact text is preserved as a string.
 */
function parseEnvelope(block: string, marker: string): readonly Omit<OmpTextToolCall, "id">[] | undefined {
  const openTag = `<tool_calls:${marker}>`;
  const closeTag = `</tool_calls:${marker}>`;
  if (!block.startsWith(openTag) || !block.endsWith(closeTag)) return undefined;

  const body = block.slice(openTag.length, -closeTag.length);
  const calls: Omit<OmpTextToolCall, "id">[] = [];
  const callPattern = new RegExp(`<tool_call:${marker}>([\\s\\S]*?)</tool_call:${marker}>`, "g");
  let cursor = 0;

  for (const match of body.matchAll(callPattern)) {
    const index = match.index;
    const full = match[0];
    const callBody = match[1];
    if (index === undefined || full === undefined || callBody === undefined) return undefined;
    if (body.slice(cursor, index).trim().length > 0) return undefined;

    const keyTag = `<arg_key:${marker}>`;
    const firstKey = callBody.indexOf(keyTag);
    const name = (firstKey < 0 ? callBody : callBody.slice(0, firstKey)).trim();
    if (!TOOL_NAME_PATTERN.test(name)) return undefined;

    const argumentBody = firstKey < 0 ? "" : callBody.slice(firstKey);
    const pairPattern = new RegExp(
      `<arg_key:${marker}>([\\s\\S]*?)</arg_key:${marker}>\\s*<arg_value:${marker}>([\\s\\S]*?)</arg_value:${marker}>`,
      "g",
    );
    const argumentsObject: Record<string, unknown> = {};
    let argumentCursor = 0;
    for (const pair of argumentBody.matchAll(pairPattern)) {
      const pairIndex = pair.index;
      const pairFull = pair[0];
      const key = pair[1]?.trim();
      const value = pair[2];
      if (
        pairIndex === undefined ||
        pairFull === undefined ||
        key === undefined ||
        key.length === 0 ||
        value === undefined ||
        argumentBody.slice(argumentCursor, pairIndex).trim().length > 0
      ) {
        return undefined;
      }
      argumentsObject[key] = parseArgumentValue(value);
      argumentCursor = pairIndex + pairFull.length;
    }
    if (argumentBody.slice(argumentCursor).trim().length > 0) return undefined;

    calls.push({ name, arguments: JSON.stringify(argumentsObject) });
    cursor = index + full.length;
  }

  if (calls.length === 0 || body.slice(cursor).trim().length > 0) return undefined;
  return calls;
}

function parseArgumentValue(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}
