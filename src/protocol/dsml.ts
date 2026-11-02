/**
 * Canonical DSML (DeepSeek Markup Language) tool-call recovery.
 *
 * DeepSeek-family models occasionally write their tool calls as XML-like DSML
 * markup inside the plain-text content stream instead of the structured
 * `tool_calls` field. Two upstream families in this gateway see it:
 *
 * - CodeBuddy/WorkBuddy emit strict blocks (`<｜DSML｜ calls>…</｜DSML｜ calls>`)
 *   that must be parsed exactly, with declared-tool allowlisting.
 * - Qoder emits looser blocks (`<[^>]*DSML[^>]*calls>…`) that tolerate any
 *   intermediate characters in the tag, and its parameter values are plain
 *   strings.
 *
 * The two share the same recovery idea, so the mechanics live here once and
 * each caller picks its dialect through options. The defaults reproduce the
 * CodeBuddy dialect exactly (`app/dsml.py` in codebuddy2api); Qoder passes
 * `fuzzy: true` and its id factory, mirroring `qoder_proxy.py`.
 */
import { randomUUID } from "node:crypto";

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
  /** When true, match the Qoder fuzzy form (`<[^>]*DSML[^>]*…`). */
  readonly fuzzy?: boolean;
  /** How parameter values decode: `json` (CodeBuddy) or `string` (Qoder). */
  readonly params?: "json" | "string";
  /** Call id factory. Defaults to sequential for strict, uuid for fuzzy. */
  readonly id?: (call: { readonly name: string }, index: number, seq: number) => string;
  /** Non-empty allowlist makes the strict dialect reject undeclared names. */
  readonly allowedNames?: ReadonlySet<string>;
  /**
   * When true, JSON stringifies argument objects with recursively sorted keys,
   * matching the reference bridge (`json.dumps(..., sort_keys=True)`). The
   * strict dialect defaults to true; the fuzzy dialect never sorts, matching
   * its reference's `json.dumps(params)`.
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

function uuidId(_call: { readonly name: string }, _index: number, _seq: number): string {
  return `call_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
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
 */
export class DsmlStreamParser {
  readonly #separators: readonly string[];
  readonly #blockNames: readonly string[];
  readonly #openers: readonly string[];
  readonly #allowedNames: ReadonlySet<string>;
  readonly #params: "json" | "string";
  readonly #sortKeys: boolean;
  readonly #maxBlockBytes: number;
  readonly #id: (call: { readonly name: string }, index: number, seq: number) => string;
  #pending = "";
  #callSequence = 0;

  constructor(options: DsmlParseOptions = {}) {
    this.#separators = options.separators ?? DEFAULT_SEPARATORS;
    this.#blockNames = options.blockNames ?? DEFAULT_BLOCK_NAMES;
    this.#openers = openers(this.#separators, this.#blockNames);
    this.#allowedNames = options.allowedNames ?? new Set();
    this.#params = options.params ?? "json";
    this.#sortKeys = options.sortKeys ?? true;
    this.#maxBlockBytes = options.maxBlockBytes ?? DEFAULT_MAX_BLOCK_BYTES;
    this.#id = options.id ?? sequentialId;
  }

  push(chunk: string): DsmlParseResult {
    this.#pending += chunk;
    let cursor = 0;
    let visible = "";
    const calls: DsmlToolCall[] = [];
    for (;;) {
      let openIndex = -1;
      let opener = "";
      for (const candidate of this.#openers) {
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
      const separator = this.#separators.find((value) => opener.startsWith(`<${value}DSML`));
      const blockName = this.#blockNames.find((value) => opener.endsWith(` ${value}>`));
      if (separator === undefined || blockName === undefined) {
        visible += "<";
        cursor = openIndex + 1;
        continue;
      }
      const close = `</${separator}DSML${separator} ${blockName}>`;
      const closeIndex = this.#pending.indexOf(close, openIndex + opener.length);
      if (closeIndex < 0) {
        // An unclosed block past the cap is not markup — pass it through as
        // text instead of buffering it indefinitely. Same fail-open as
        // `feed()` in the reference bridge's `MAX_BLOCK_BYTES` guard.
        if (this.#pending.length - openIndex > this.#maxBlockBytes) {
          visible += this.#pending.slice(openIndex);
          cursor = this.#pending.length;
          break;
        }
        cursor = openIndex;
        break;
      }
      const end = closeIndex + close.length;
      const block = this.#pending.slice(openIndex, end);
      const parsed = parseStrictBlock(block, opener, close, separator, this.#allowedNames, this.#params, this.#sortKeys);
      if (parsed === undefined) visible += block;
      else {
        parsed.forEach((call, index) => {
          calls.push({ ...call, id: this.#id(call, index, this.#callSequence++) });
        });
      }
      cursor = end;
    }
    this.#pending = this.#pending.slice(cursor);
    return { text: visible, calls };
  }

  flush(): DsmlParseResult {
    const text = this.#pending;
    this.#pending = "";
    return { text, calls: [] };
  }

  #settledEnd(start: number): number {
    const remaining = this.#pending.slice(start);
    const maxOpener = this.#openers.reduce((max, opener) => Math.max(max, opener.length - 1), 0);
    for (let length = Math.min(maxOpener, remaining.length); length > 0; length -= 1) {
      const suffix = remaining.slice(-length);
      if (this.#openers.some((opener) => opener.startsWith(suffix))) return this.#pending.length - length;
    }
    return this.#pending.length;
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

/** The Qoder fuzzy block scanner, mirroring the reference bridge's regexes. */
const FUZZY_CALLS_RE = /<[^>]*DSML[^>]*calls>([\s\S]*?)<\/[^>]*DSML[^>]*calls>/;
const FUZZY_INVOKE_RE = /<[^>]*DSML[^>]*invoke\s+name=["']([^"']+)["']>([\s\S]*?)<\/[^>]*invoke>/g;
const FUZZY_PARAM_RE = /<[^>]*DSML[^>]*parameter\s+name=["']([^"']+)["'][^>]*>([\s\S]*?)<\/[^>]*parameter>/g;

function parseFuzzyDsml(text: string, options: DsmlParseOptions): DsmlRecovery {
  const id = options.id ?? uuidId;
  if (text.length === 0 || !text.includes("DSML")) return { calls: [], clean: text };

  const callsMatch = FUZZY_CALLS_RE.exec(text);
  let block: string;
  let clean: string;

  if (callsMatch) {
    block = callsMatch[1] ?? "";
    const before = text.slice(0, callsMatch.index).trimEnd();
    const after = text.slice(callsMatch.index + callsMatch[0].length).trimStart();
    clean = (before + " " + after).trim();
  } else {
    // No <calls> wrapper (issue #51): find bare <invoke> blocks in the whole
    // text, then cut the prose off at the last `<` before the first invoke —
    // exclusive of the invoke's own tag start, exactly like the reference's
    // `text.rfind("<", 0, first_index)`.
    FUZZY_INVOKE_RE.lastIndex = 0;
    const first = FUZZY_INVOKE_RE.exec(text);
    if (!first) return { calls: [], clean: text };
    block = text;
    const cut = text.lastIndexOf("<", first.index - 1);
    clean = text.slice(0, cut >= 0 ? cut : first.index).trim();
  }

  const calls: DsmlToolCall[] = [];
  FUZZY_INVOKE_RE.lastIndex = 0;
  let inv: RegExpExecArray | null;
  let seq = 0;
  while ((inv = FUZZY_INVOKE_RE.exec(block)) !== null) {
    const params: Record<string, string> = {};
    FUZZY_PARAM_RE.lastIndex = 0;
    let par: RegExpExecArray | null;
    while ((par = FUZZY_PARAM_RE.exec(inv[2] ?? "")) !== null) {
      params[par[1] ?? ""] = (par[2] ?? "").trim();
    }
    const call = { name: inv[1] ?? "", arguments: JSON.stringify(params) };
    calls.push({ ...call, id: id(call, calls.length, seq++) });
  }

  return { calls, clean };
}

/**
 * Recovers DSML tool calls from one plain-text string. The dialect is chosen
 * by `options.fuzzy`; each dialect keeps its exact public shape:
 *
 * - strict (CodeBuddy): returns `{ text, calls }`, with `text` the clean
 *   prose; `undefined` when nothing was recovered.
 * - fuzzy (Qoder): returns `{ clean, calls }`, with no-DSML input returning
 *   `{ calls: [], clean: text }`.
 *
 * Callers that need the streaming strict parser use {@link DsmlStreamParser}.
 */
export function parseDsmlToolCalls(
  text: string,
  options: DsmlParseOptions = {},
): DsmlRecovery | DsmlParseResult | undefined {
  if (options.fuzzy === true) return parseFuzzyDsml(text, options);
  if (!text.includes("DSML")) return undefined;
  const parser = new DsmlStreamParser(options);
  const first = parser.push(text);
  const last = parser.flush();
  const recovered = [...first.calls, ...last.calls];
  return recovered.length === 0 ? undefined : { text: `${first.text}${last.text}`.trim(), calls: recovered };
}
