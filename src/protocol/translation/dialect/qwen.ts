/**
 * Qwen chat-template in-band tool calls.
 *
 * Qwen3-family models emit tool calls as JSON blocks inside the text stream
 * when the server's structured tool parser is not in use:
 *
 *   <tool_call>
 *   {"name": "web_search", "arguments": {"query": "..."}}
 *   </tool_call>
 *
 * The scanner recovers complete blocks into canonical tool calls and leaves the
 * rest as text, mirroring the DSML/OMP scanners used for other families.
 */
import type { InbandScanner, InbandScanResult } from "./inband";

const OPEN_TAG = "<tool_call>";
const CLOSE_TAG = "</tool_call>";

export class QwenToolCallScanner implements InbandScanner {
  readonly #allowedNames: ReadonlySet<string>;
  #pending = "";
  #sequence = 0;

  constructor(allowedNames: ReadonlySet<string>) {
    this.#allowedNames = allowedNames;
  }

  push(chunk: string): InbandScanResult {
    this.#pending += chunk;
    let cursor = 0;
    let text = "";
    const calls: Array<InbandScanResult["calls"][number]> = [];
    for (;;) {
      const open = this.#pending.indexOf(OPEN_TAG, cursor);
      if (open < 0) {
        // Hold a possible pending opener at the tail; settle everything before it.
        text += this.#pending.slice(cursor, this.#settledEnd(this.#pending.length));
        cursor = this.#settledEnd(this.#pending.length);
        break;
      }
      text += this.#pending.slice(cursor, open);
      const bodyStart = open + OPEN_TAG.length;
      const close = this.#pending.indexOf(CLOSE_TAG, bodyStart);
      if (close < 0) {
        // Unterminated block: hold from the opener on and settle what preceded it.
        cursor = open;
        break;
      }
      const inner = this.#pending.slice(bodyStart, close).trim();
      const parsed = parseToolCall(inner);
      if (parsed !== undefined) {
        if (this.#allowedNames.has(parsed.name)) {
          calls.push({
            id: `call_qwen_${this.#sequence++}`,
            name: parsed.name,
            arguments: parsed.arguments,
          });
        } else {
          // An undeclared tool is model text, not authority to invoke it.
          text += this.#pending.slice(open, close + CLOSE_TAG.length);
        }
      } else {
        text += this.#pending.slice(open, close + CLOSE_TAG.length);
      }
      cursor = close + CLOSE_TAG.length;
    }
    this.#pending = this.#pending.slice(cursor);
    return { text, calls };
  }

  flush(): InbandScanResult {
    const pending = this.#pending;
    this.#pending = "";
    if (isPossibleOpener(pending)) return { text: "", calls: [] };
    return { text: pending, calls: [] };
  }

  #settledEnd(end: number): number {
    // Keep a trailing fragment that could be the start of an opener.
    const tail = this.#pending.slice(0, end);
    const maxPrefix = Math.min(OPEN_TAG.length - 1, tail.length);
    for (let len = maxPrefix; len > 0; len -= 1) {
      if (OPEN_TAG.startsWith(tail.slice(-len))) return end - len;
    }
    return end;
  }
}

function parseToolCall(inner: string): { readonly name: string; readonly arguments: string } | undefined {
  if (inner.length === 0) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(inner);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const name = typeof record["name"] === "string" ? record["name"] : undefined;
  if (name === undefined || name.length === 0) return undefined;
  const args = record["arguments"] ?? record["parameters"] ?? {};
  let argsText: string;
  try {
    argsText = typeof args === "string" ? args : JSON.stringify(args);
  } catch {
    argsText = "{}";
  }
  return { name, arguments: argsText };
}

function isPossibleOpener(value: string): boolean {
  if (value.length < OPEN_TAG.length) return OPEN_TAG.startsWith(value);
  return value.startsWith(OPEN_TAG) && !value.includes(CLOSE_TAG);
}
