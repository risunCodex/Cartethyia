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
import { MarkupStreamParser } from "../../markup-stream-parser";

const OPEN_TAG = "<tool_call>";
const CLOSE_TAG = "</tool_call>";

export class QwenToolCallScanner implements InbandScanner {
  readonly #parser: MarkupStreamParser<InbandScanResult["calls"][number]>;

  constructor(allowedNames: ReadonlySet<string>) {
    this.#parser = new MarkupStreamParser<InbandScanResult["calls"][number]>({
      openers: [OPEN_TAG],
      classifyOpener: (_pending, _openIndex, opener) => {
        if (opener !== OPEN_TAG) return { kind: "literal" };
        return {
          kind: "found",
          closer: CLOSE_TAG,
          parse: (block) => {
            const inner = block.slice(OPEN_TAG.length, -CLOSE_TAG.length).trim();
            const parsed = parseToolCall(inner);
            if (parsed === undefined) return undefined;
            if (!allowedNames.has(parsed.name)) {
              // An undeclared tool is model text, not authority to invoke it.
              return undefined;
            }
            return [parsed];
          },
          callId: (call, _index, seq) => ({ ...call, id: `call_qwen_${seq}` }),
        };
      },
      flush: (pending) => (isPossibleOpener(pending) ? "" : pending),
    });
  }

  push(chunk: string): InbandScanResult {
    return this.#parser.push(chunk);
  }

  flush(): InbandScanResult {
    return this.#parser.flush();
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
