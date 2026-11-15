// Shared tool pairing ledger (proposal F-5).
//
// One scan answers "does this conversation's tool history pair up?" for every
// surface. Before this module the rule lived only on the Messages ingress
// (`applyMessagesToolLedger`), so the same broken transcript produced a typed
// 400 on the Messages wire and silent garbage-forwarding on Chat/Responses —
// three verdicts for one transcript.
//
// Verdict policy, owned here:
// - **Messages ingress** validates strictly (throws): an Anthropic client that
//   sends an unpaired `tool_result` has a client-side bug its own wire would
//   reject, and inventing a repair would hide it.
// - **Chat/Responses ingress** repairs: orphan and duplicate results are
//   dropped (first result wins). Real clients in the wild persist a result
//   whose call was lost, and the dispatch-level repair
//   (`translation/tool-repair.ts`) would drop them anyway — doing it at
//   ingress keeps every downstream consumer (captures, replay, the console)
//   seeing the same clean history. Positional sequencing rules (a result must
//   FOLLOW its call, batches must be contiguous) stay at dispatch where the
//   route's strictness is known.

import type { CanonicalMessage } from "./canonical-model";
import { canContainToolResult, toolCallParts } from "./canonical-model";

/** One unpaired structural fact about a conversation's tool history. */
export interface ToolPairingIssue {
  code: "invalid_call" | "duplicate_call" | "orphan_result" | "duplicate_result";
  /** The call id involved, when the issue is about one. */
  callId?: string;
  /** Message index the issue was found at. */
  messageIndex: number;
}

export interface ToolPairingScanOptions {
  /**
   * Result ids that are exempt from pairing — hosted/server tool results the
   * client answers without a declared call (Anthropic `server_tool_use` /
   * `search_result`). The Messages ledger registers these ids as calls, so
   * results answering them are neither orphaned nor duplicated.
   */
  exemptResultId?: (callId: string) => boolean;
}

/**
 * One forward sweep collecting every unpaired structural fact, in wire order.
 *
 * Uses the shared `canContainToolResult` rule: results live in `tool` turns or
 * in `user` turns (the Messages ledger re-homes them there), so a
 * `role === "tool"`-only scan misreads every Messages-origin history.
 */
export function scanToolPairingIssues(
  messages: readonly CanonicalMessage[],
  options: ToolPairingScanOptions = {},
): ToolPairingIssue[] {
  const exempt = options.exemptResultId;
  const issues: ToolPairingIssue[] = [];
  const calls = new Set<string>();
  const results = new Map<string, number>();
  messages.forEach((message, messageIndex) => {
    for (const part of message.content) {
      if (part.kind === "toolCall") {
        if (part.call_id.length === 0 || part.name.length === 0) {
          issues.push({ code: "invalid_call", callId: part.call_id, messageIndex });
          continue;
        }
        if (calls.has(part.call_id)) {
          issues.push({ code: "duplicate_call", callId: part.call_id, messageIndex });
          continue;
        }
        calls.add(part.call_id);
        continue;
      }
      if (part.kind === "toolResult" && canContainToolResult(message)) {
        if (exempt !== undefined && exempt(part.call_id)) continue;
        if (!calls.has(part.call_id)) {
          issues.push({ code: "orphan_result", callId: part.call_id, messageIndex });
          continue;
        }
        if (results.has(part.call_id)) {
          issues.push({ code: "duplicate_result", callId: part.call_id, messageIndex });
          continue;
        }
        results.set(part.call_id, messageIndex);
      }
    }
  });
  return issues;
}

/**
 * Repair mode: drops unpaired results from a parsed history.
 *
 * - **Orphan results** — no matching call anywhere — are dropped with their
 *   now-empty turns. Dropping loses one round of tool context; keeping the
   * orphan loses the whole conversation, because the client replays the
 *   broken transcript on every later turn and strict wires reject it each time.
 * - **Duplicate results** — a second answer for an already-answered call —
 *   are dropped (first result wins), matching how a retry-after-partial-write
 *   produces two results for one call.
 *
 * Calls are never touched here: a call without a result is repaired by
 * synthesizing one at dispatch (`repairMissingToolResponses`), which is a
 * route-strictness decision, not a surface one. Returns the input reference
 * when nothing needed repair so callers can skip cloning.
 */
export function dropUnpairedToolResults(
  messages: readonly CanonicalMessage[],
  options: ToolPairingScanOptions = {},
): readonly CanonicalMessage[] {
  const exempt = options.exemptResultId;
  const calls = new Set<string>();
  for (const message of messages) {
    for (const part of toolCallParts(message)) {
      if (part.call_id.length > 0) calls.add(part.call_id);
    }
  }
  let changed = false;
  const out: CanonicalMessage[] = [];
  const answered = new Set<string>();
  for (const message of messages) {
    if (!canContainToolResult(message)) {
      out.push(message);
      continue;
    }
    const kept = message.content.filter((part) => {
      if (part.kind !== "toolResult") return true;
      if (exempt !== undefined && exempt(part.call_id)) return true;
      if (!calls.has(part.call_id)) {
        changed = true;
        return false;
      }
      if (answered.has(part.call_id)) {
        changed = true;
        return false;
      }
      answered.add(part.call_id);
      return true;
    });
    if (kept.length === message.content.length) {
      out.push(message);
      continue;
    }
    // A turn that carried only unpaired results has nothing left to say.
    if (kept.length > 0) out.push({ ...message, content: kept });
  }
  return changed ? out : messages;
}
