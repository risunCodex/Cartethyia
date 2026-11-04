/**
 * Shared canonical→Qoder message helpers.
 *
 * Kept in a separate module so both transports (`qoder.ts` HTTP and
 * `qoder-grpc.ts`) flatten message content the same way.
 */
import type { ContentPart } from "../../../protocol/canonical-model";

/** Joins text/tool-result content of one canonical message into plain text. */
export function flattenCanonicalContent(content: readonly ContentPart[]): string {
  return content
    .filter((b) => b.kind === "text" || b.kind === "toolResult")
    .map((b) => {
      if (b.kind === "text") return b.text;
      if (b.kind === "toolResult") return typeof b.content === "string" ? b.content : JSON.stringify(b.content);
      return "";
    })
    .join("\n");
}
