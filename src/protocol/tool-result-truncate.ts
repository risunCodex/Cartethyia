// F-43: optional tool-result payload truncation.
//
// A `tool_result` text block can carry hundreds of KiB — the classic context
// killer that pushes a whole conversation over its window and poisons every
// replayed turn. The clamp is env-gated (`CARTETHYIA_TOOL_RESULT_MAX_KB`) and
// OFF by default: truncation rewrites client-visible content, so an operator
// turns it on deliberately, and every surface inherits it because it runs at
// the canonical prepare stage, after ingress and before projection.
//
// Only TEXT payloads are truncated — never a tool call, never a non-text
// result part — and the marker names the gateway and the limit, so the model
// (and the operator reading a capture) can tell a truncated result from a
// short one.

import type { CanonicalMessage, CanonicalRequest, ContentPart } from "./canonical-model";

/** Appended to a truncated result so the cut is visible, never silent. */
export const TOOL_RESULT_TRUNCATION_MARKER = "\n[truncated by gateway: tool result exceeded the configured size limit]";

/**
 * Truncates oversized tool-result text payloads to `maxKb` KiB per result.
 * `maxKb <= 0` disables the clamp and returns the input unchanged. Returns
 * the same reference when nothing needed truncation.
 */
export function truncateToolResults(
  request: CanonicalRequest,
  maxKb: number,
): CanonicalRequest {
  if (!Number.isFinite(maxKb) || maxKb <= 0) return request;
  const maxChars = maxKb * 1024;
  let changed = false;
  const messages: CanonicalMessage[] = request.messages.map((message) => {
    if (!message.content.some((part) => part.kind === "toolResult")) return message;
    const content: ContentPart[] = message.content.map((part) => {
      if (part.kind !== "toolResult") return part;
      if (typeof part.content === "string") {
        if (part.content.length <= maxChars) return part;
        changed = true;
        return {
          ...part,
          content: `${part.content.slice(0, maxChars)}${TOOL_RESULT_TRUNCATION_MARKER}`,
        };
      }
      let partChanged = false;
      const parts = part.content.map((inner) => {
        if (inner.kind !== "text" || inner.text.length <= maxChars) return inner;
        partChanged = true;
        return { kind: "text" as const, text: `${inner.text.slice(0, maxChars)}${TOOL_RESULT_TRUNCATION_MARKER}` };
      });
      if (!partChanged) return part;
      changed = true;
      return { ...part, content: parts };
    });
    return { ...message, content };
  });
  return changed ? { ...request, messages } : request;
}
