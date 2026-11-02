/**
 * In-band tool-call scanner interface + factory.
 *
 * Some model families emit tool calls as markup inside the text stream instead
 * of structured `tool_calls`: DeepSeek DSML, Qwen `<tool_call>` JSON, OMP
 * `<tool_calls:8hex>`. Each is a pluggable codec; the codecs select one by
 * dialect id.
 */
import { DsmlStreamParser } from "./deepseek";
import { QwenToolCallScanner } from "./qwen";
import type { DialectId } from "./types";

interface InbandToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: string;
}

export interface InbandScanResult {
  readonly text: string;
  readonly calls: readonly InbandToolCall[];
}

export interface InbandScanner {
  push(chunk: string): InbandScanResult;
  flush(): InbandScanResult;
}

/** Creates the scanner for a dialect, or undefined for structured-only dialects. */
export function createInbandScanner(
  dialect: DialectId | null | undefined,
  allowedNames: ReadonlySet<string>,
): InbandScanner | undefined {
  if (dialect === "qwen") return new QwenToolCallScanner(allowedNames);
  if (dialect === "deepseek") return new DsmlStreamParser({ allowedNames });
  return undefined;
}

export type { DsmlToolCall } from "../../dsml";
