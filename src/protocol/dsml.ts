/**
 * Canonical DSML (DeepSeek Markup Language) tool-call recovery.
 *
 * DeepSeek-family models occasionally write their tool calls as XML-like DSML
 * markup inside the plain-text content stream instead of the structured
 * `tool_calls` field. The gateway sees it from one upstream family:
 *
 * - CodeBuddy emits strict blocks (`<｜DSML｜ calls>…</｜DSML｜ calls>`)
 *   that must be parsed exactly, with declared-tool allowlisting.
 */
import { MarkupStreamParser } from "./markup-stream-parser";
export interface DsmlToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: string;
}

interface DsmlRecovery {
  readonly calls: readonly DsmlToolCall[];
  readonly clean: string;
}

export interface DsmlParseOptions {
  /** Separator spellings a strict block may use (CodeBuddy dialect). */
  readonly separators?: readonly string[];
  /** Block names a strict opener may name. */
  readonly blockNames?: readonly string[];
  /** How parameter values decode: `json` (CodeBuddy) or `string`. */
  readonly params?: "json" | "string";
  /** Call id factory. Defaults to sequential. */
  readonly id?: (call: { readonly name: string }, index: number, seq: number) => string;
  /** Non-empty allowlist makes the strict dialect reject undeclared names. */
  readonly allowedNames?: ReadonlySet<string>;
  /**
   * When true, JSON stringifies argument objects with recursively sorted keys,
   * matching the reference bridge (`json.dumps(..., sort_keys=True)`).
   */
  readonly sortKeys?: boolean;
  /**
   * Character cap for an unclosed strict block. Past it, the block is treated
   * as plain text and passed through instead of buffered indefinitely — same
   * fail-open as `MAX_BLOCK_BYTES` in the reference bridge (256 KB).
   */
  readonly maxBlockBytes?: number;
}

const DEFAULT_SEPARATORS = ["｜｜", "｜", "|"] as const;
const DEFAULT_BLOCK_NAMES = ["calls", "function_calls"] as const;
const DEFAULT_MAX_BLOCK_BYTES = 256 * 1024;
const TOOL_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,63}$/;

/** Escapes regex metacharacters so a `|` separator is literal, not alternation. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function openers(separators: readonly string[], blockNames: readonly string[]): readonly string[] {
  return separators.flatMap((separator) => blockNames.map((name) => `<${separator}DSML${separator} ${name}>`));
}

function sequentialId(_call: { readonly name: string }, _index: number, seq: number): string {
  return `call_dsml_${seq}_${_call.name}`;
}

interface DsmlParseResult {
  readonly text: string;
  readonly calls: readonly DsmlToolCall[];
}

/**
 * Streaming strict-prefix parser (CodeBuddy dialect). Buffers text until a
 * complete block is seen, emits clean prose as it settles, and recovers calls
 * from complete blocks only. Incomplete blocks stay text; an unclosed block
 * past `maxBlockBytes` passes through as text instead of buffering forever.
 * With no allowlist the generic name rule applies; with one, undeclared names
 * reject the whole block. The caller feeds chunks with `push` and drains the
 * tail with `flush`.
 *
 * The stateful prefix-buffer loop is the shared {@link MarkupStreamParser}
 * scaffold; this class supplies the DSML grammar as a thin configuration.
 */
export class DsmlStreamParser {
  readonly #parser: MarkupStreamParser<DsmlToolCall>;

  constructor(options: DsmlParseOptions = {}) {
    const separators = options.separators ?? DEFAULT_SEPARATORS;
    const blockNames = options.blockNames ?? DEFAULT_BLOCK_NAMES;
    const allowedNames = options.allowedNames ?? new Set();
    const params = options.params ?? "json";
    const sortKeys = options.sortKeys ?? true;
    const maxBlockBytes = options.maxBlockBytes ?? DEFAULT_MAX_BLOCK_BYTES;
    const id = options.id ?? sequentialId;
    this.#parser = new MarkupStreamParser<DsmlToolCall>({
      openers: openers(separators, blockNames),
      classifyOpener: (_pending, _index, opener) => {
        const separator = separators.find((value) => opener.startsWith(`<${value}DSML`));
        const blockName = blockNames.find((value) => opener.endsWith(` ${value}>`));
        if (separator === undefined || blockName === undefined) return { kind: "literal" };
        const close = `</${separator}DSML${separator} ${blockName}>`;
        return {
          kind: "found",
          closer: close,
          parse: (block) =>
            parseStrictBlock(block, opener, close, separator, allowedNames, params, sortKeys),
          callId: (call, index, seq) => ({ ...call, id: id(call, index, seq) }),
        };
      },
      onUnclosed: (pending, openIndex) =>
        pending.length - openIndex > maxBlockBytes
          ? { kind: "passThrough" }
          : "hold",
    });
  }

  push(chunk: string): DsmlParseResult {
    return this.#parser.push(chunk);
  }

  flush(): DsmlParseResult {
    return this.#parser.flush();
  }
}

function parseStrictBlock(
  block: string,
  opener: string,
  close: string,
  separator: string,
  allowedNames: ReadonlySet<string>,
  params: "json" | "string",
  sortKeys: boolean,
): Omit<DsmlToolCall, "id">[] | undefined {
  const inner = block.slice(opener.length, -close.length);
  const pipe = escapeRegExp(separator);
  const invokePattern = new RegExp(`<${pipe}DSML${pipe}\\s+invoke\\s+name="([^"]*)"\\s*>`, "g");
  const calls: Omit<DsmlToolCall, "id">[] = [];
  // The allowlist is strict only when the caller knows the declared tools: a
  // caller without one (a direct parse) keeps the generic name rule, while a
  // dispatch that declared its tools must never execute a name it did not offer.
  const strict = allowedNames.size > 0;
  let cursor = 0;
  for (const invoke of inner.matchAll(invokePattern)) {
    const name = invoke[1] ?? "";
    if (!TOOL_NAME.test(name) || (strict && !allowedNames.has(name)) || invoke.index === undefined) return undefined;
    if (inner.slice(cursor, invoke.index).trim().length > 0) return undefined;
    const bodyStart = invoke.index + invoke[0].length;
    const invokeClose = `</${separator}DSML${separator} invoke>`;
    const invokeEnd = inner.indexOf(invokeClose, bodyStart);
    if (invokeEnd < 0) return undefined;
    const parameterPattern = new RegExp(`<${pipe}DSML${pipe}\\s+parameter\\s+name="([^"]*)"(?:\\s+string="(true|false)")?\\s*>`, "g");
    const body = inner.slice(bodyStart, invokeEnd);
    const args: Record<string, unknown> = {};
    let parameterCursor = 0;
    for (const parameter of body.matchAll(parameterPattern)) {
      const key = parameter[1] ?? "";
      if (key.length === 0 || parameter.index === undefined || body.slice(parameterCursor, parameter.index).trim().length > 0) return undefined;
      const valueStart = parameter.index + parameter[0].length;
      const parameterClose = `</${separator}DSML${separator} parameter>`;
      const valueEnd = body.indexOf(parameterClose, valueStart);
      if (valueEnd < 0) return undefined;
      const raw = body.slice(valueStart, valueEnd);
      if (params === "string") args[key] = raw;
      else if (parameter[2] === "true") args[key] = raw;
      else {
        try { args[key] = JSON.parse(raw); }
        catch { args[key] = raw; }
      }
      parameterCursor = valueEnd + parameterClose.length;
    }
    if (body.slice(parameterCursor).trim().length > 0) return undefined;
    calls.push({ name, arguments: JSON.stringify(sortKeys ? normalizeForSort(args) : args) });
    cursor = invokeEnd + invokeClose.length;
  }
  return calls.length > 0 && inner.slice(cursor).trim().length === 0 ? calls : undefined;
}

/**
 * Returns `value` with plain-object keys recursively sorted, mirroring the
 * reference bridge's `json.dumps(..., sort_keys=True)`. Arrays keep their
 * order — sorting applies to object keys only.
 */
function normalizeForSort(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) out[key] = normalizeForSort(record[key]);
  return out;
}

/**
 * Recovers DSML tool calls from one plain-text string.
 *
 * - strict (CodeBuddy): returns `{ text, calls }`, with `text` the clean
 *   prose; `undefined` when nothing was recovered.
 *
 * Callers that need the streaming strict parser use {@link DsmlStreamParser}.
 */
export function parseDsmlToolCalls(
  text: string,
  options: DsmlParseOptions = {},
): DsmlRecovery | DsmlParseResult | undefined {
  if (!text.includes("DSML")) return undefined;
  const parser = new DsmlStreamParser(options);
  const first = parser.push(text);
  const last = parser.flush();
  const recovered = [...first.calls, ...last.calls];
  return recovered.length === 0 ? undefined : { text: `${first.text}${last.text}`.trim(), calls: recovered };
}
