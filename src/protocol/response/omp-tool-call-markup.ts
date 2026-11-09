/**
 * Recovers the tool-call envelope some models occasionally emit as assistant
 * text instead of OpenAI `tool_calls`.
 *
 * The wire shape is the captured `<tool_calls:8hex>` / `<tool_call:8hex>` /
 * `<arg_key:8hex>` / `<arg_value:8hex>` form. Only complete envelopes are
 * interpreted. Calls are returned only when their names were declared on the
 * request; an undeclared name is never promoted into executable tool input.
 */
import { MarkupStreamParser } from "../markup-stream-parser";
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
 *
 * The stateful prefix-buffer loop is the shared {@link MarkupStreamParser}
 * scaffold; this class supplies the OMP grammar as a thin configuration.
 */
export class OmpToolCallMarkupParser {
  readonly #parser: MarkupStreamParser<OmpTextToolCall>;

  constructor(allowedNames: ReadonlySet<string>) {
    this.#parser = new MarkupStreamParser<OmpTextToolCall>({
      openers: [OPEN_PREFIX],
      classifyOpener: (pending, openIndex) => {
        const remainder = pending.slice(openIndex);
        const opening = OPEN_PATTERN.exec(remainder);
        if (opening === null || opening[1] === undefined) {
          if (couldBeOpening(remainder)) return { kind: "hold" };
          return { kind: "literal" };
        }
        const marker = opening[1];
        const closeTag = `</tool_calls:${marker}>`;
        return {
          kind: "found",
          closer: closeTag,
          parse: (block) => {
            const parsed = parseEnvelope(block, marker);
            if (parsed === undefined) return undefined;
            if (parsed.some((call) => !allowedNames.has(call.name))) {
              // A syntactically valid call to an undeclared tool is model
              // text, not authority to invoke a tool the client did not offer.
              return undefined;
            }
            return parsed;
          },
          callId: (call, _index, seq) => ({ ...call, id: `call_omp_${marker}_${seq}` }),
        };
      },
      flush: (pending) =>
        couldBeOpening(pending) || OPEN_PATTERN.test(pending) ? "" : pending,
    });
  }

  /** Feeds one content or reasoning delta and returns only settled text. */
  push(chunk: string): OmpTextToolCallResult {
    return this.#parser.push(chunk);
  }

  /**
   * Settles trailing text. A complete internal envelope cannot remain here;
   * an unfinished envelope is deliberately discarded rather than leaked.
   */
  flush(): OmpTextToolCallResult {
    return this.#parser.flush();
  }
}

function couldBeOpening(value: string): boolean {
  if (value.length < OPEN_PREFIX.length) return OPEN_PREFIX.startsWith(value);
  if (!value.startsWith(OPEN_PREFIX)) return false;
  const suffix = value.slice(OPEN_PREFIX.length);
  return /^[0-9a-f]{0,8}$/.test(suffix) || /^[0-9a-f]{8}$/.test(suffix) && !value.endsWith(">");
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
