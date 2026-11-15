// Withdrawn-tool re-declaration (proposal F-23).
//
// A client that widens then narrows its tool set leaves history calling a
// tool the current request no longer declares. Strict wires reject the
// transcript outright (Anthropic: "tool names found in history but not in the
// tools list") or hallucinate against an undeclared name; either way the
// conversation dies on a request the client cannot fix, because the
// transcript replays the call on every later turn.
//
// oh-my-pi's harness solves this with a last-sent-definitions registry: a
// tool that was declared when the call was made stays declared for as long
// as the history references it. A stateless gateway cannot restore the
// original schema — it lived in an earlier request this process never saw —
// so the re-declaration here is an explicit, permissive stub
// (`{"type":"object"}`) under the history's exact name. That is the minimum
// that makes the transcript wire-valid and the name callable, and it is
// deliberately *not* a fabricated description or a guessed schema: the model
// sees a real declaration for a name the history proves it used.
//
// This runs on the canonical request before projection, so every wire
// builder (chat, messages, responses, codex) inherits it from
// `request.tools` — there is no per-wire re-declaration code.

import type { CanonicalRequest, ToolDefinition } from "../canonical-model";

const WITHDRAWN_TOOL_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {},
  required: [],
};

/**
 * Appends stub declarations for every tool the history calls but the request
 * no longer declares. Returns the same reference when nothing was withdrawn,
 * so the preparer's identity checks keep working. Never mutates the input.
 */
export function redeclareWithdrawnTools(request: CanonicalRequest): CanonicalRequest {
  const declared = new Set<string>();
  for (const tool of request.tools ?? []) declared.add(tool.name);
  const withdrawn: string[] = [];
  const seen = new Set<string>();
  for (const message of request.messages) {
    for (const part of message.content) {
      if (part.kind !== "toolCall") continue;
      const name = part.name;
      if (name.length === 0 || seen.has(name)) continue;
      seen.add(name);
      if (!declared.has(name)) withdrawn.push(name);
    }
  }
  if (withdrawn.length === 0) return request;
  const stubs: ToolDefinition[] = withdrawn.map((name) => ({
    name,
    jsonSchema: WITHDRAWN_TOOL_SCHEMA,
  }));
  return { ...request, tools: [...(request.tools ?? []), ...stubs] };
}
