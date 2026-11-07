import type { CanonicalRequest, ReasoningEffort, ReasoningIntent } from "./canonical-model";
import { budgetToLevel } from "./translation/thinking";
import { isRecord } from "./codecs";
import { DEEPSEEK_DEFAULT_EFFORT } from "./translation/dialect/thinking-ladder";

/**
 * The effective reasoning effort for a canonical intent, deriving one from an
 * Anthropic-shaped `thinking` block when no explicit effort is set.
 *
 * An Anthropic client states reasoning as `thinking: { type, budget_tokens }`,
 * which the canonical model keeps as `thinking_type`/`budget_tokens` — fields
 * the OpenAI-family wires do not define. Every OpenAI-style consumer therefore
 * needs the same translation, and two of them deriving it independently is how
 * a wire ends up with an unmappable reasoning object. Returns `undefined` when
 * the intent carries no reasoning at all (or explicitly disables it).
 */
export function reasoningEffortFromIntent(reasoning: ReasoningIntent | undefined): ReasoningEffort | undefined {
  if (reasoning === undefined) return undefined;
  if (reasoning.thinking_type === "disabled") return "none";
  if (reasoning.effort !== undefined) return reasoning.effort;
  if (reasoning.thinking_type !== "enabled" && reasoning.thinking_type !== "adaptive") return undefined;
  const budget = reasoning.budget_tokens;
  // No budget means the caller enabled thinking without sizing it — the
  // ladder's default ask. A sized budget maps to the nearest tier.
  if (budget === undefined) return "high";
  return budgetToLevel(budget) ?? "high";
}

/** Projects canonical reasoning intent onto OpenAI-style effort controls. */
export function applyOpenAIReasoning(payload: Record<string, unknown>, request: CanonicalRequest | undefined): void {
  if (request === undefined || payload["reasoning_effort"] !== undefined) return;
  const effort = reasoningEffortFromIntent(request.reasoning);
  if (effort === undefined) return;
  payload["reasoning_effort"] = effort;
}

/** Applies the DeepSeek chat contract shared by CodeBuddy. */
export function applyDeepSeekReasoning(payload: Record<string, unknown>): void {
  const model = typeof payload["model"] === "string" ? payload["model"].trim().toLowerCase() : "";
  if (!model.startsWith("deepseek")) return;
  const thinking = isRecord(payload["thinking"]) ? payload["thinking"] : undefined;
  const type = typeof thinking?.["type"] === "string" ? thinking["type"].trim().toLowerCase() : "";
  if (type === "disabled") {
    delete payload["reasoning_effort"];
    delete payload["reasoningEffort"];
    return;
  }
  if (thinking === undefined) payload["thinking"] = { type: "enabled" };
  else if (type.length === 0) thinking["type"] = "enabled";
  if (typeof payload["reasoning_effort"] !== "string" || payload["reasoning_effort"].length === 0)
    payload["reasoning_effort"] = DEEPSEEK_DEFAULT_EFFORT;
}

/**
 * Model families whose Chat-compatible upstream enforces the DeepSeek replay
 * rule: every prior assistant turn must carry `reasoning_content`, or the
 * upstream refuses the whole request with
 * `Missing required parameter: 'messages[N].reasoning_content'`. Seen on
 * Cline's resold `reflection/beam-free` (2026-10-30) and on the buddy
 * DeepSeek family. Cline, OpenRouter, Hermes, and Kilo share one chat wire,
 * so the rule is stated once, keyed on the model family.
 */
const REASONING_REPLAY_MODEL_RE = /(?:deepseek|reflection\/beam)/i;

/**
 * Ensures every assistant turn carries `reasoning_content` for model families
 * whose upstream enforces the DeepSeek replay rule. The rule demands the field
 * on *every* earlier assistant message — presence, not content — and the
 * upstream rejects an absent field with
 * `Missing required parameter: 'messages[N].reasoning_content'` even when the
 * turn genuinely has no trace to replay. Clients that already learned the rule
 * send `reasoning_content: ""` for exactly those turns (see the chat surface
 * parser), so an empty string is the honest value for a turn with nothing to
 * replay. Existing values are never overwritten.
 *
 * Unlike `backfillDeepSeekReasoningContent`, this runs only for the
 * OpenAI-compatible resellers (Cline/OpenRouter/Hermes/Kilo), not the buddy
 * family, whose upstream rejects empty reasoning as "stripped" and drops it.
 */
export function ensureChatReasoningReplayPresence(payload: Record<string, unknown>): void {
  const model = typeof payload["model"] === "string" ? payload["model"] : "";
  if (!REASONING_REPLAY_MODEL_RE.test(model)) return;
  const messages = payload["messages"];
  if (!Array.isArray(messages)) return;
  const thinking = payload["thinking"];
  const thinkingEnabled = isRecord(thinking) && thinking["type"] === "enabled";
  const hasTrace = messages.some(
    (message) =>
      isRecord(message) &&
      ((typeof message["reasoning"] === "string" && message["reasoning"].length > 0) ||
        "reasoning_content" in message),
  );
  // Same gate as the backfill: a request that never entered thinking mode and
  // carries no reasoning anywhere has nothing the model could demand, so do
  // not start marking its turns as thinking turns.
  if (!thinkingEnabled && !hasTrace) return;
  for (const message of messages) {
    if (!isRecord(message) || message["role"] !== "assistant") continue;
    if (typeof message["reasoning_content"] === "string") continue;
    message["reasoning_content"] = "";
  }
}

/** Backfills DeepSeek assistant reasoning_content required for replayed turns. */
export function backfillDeepSeekReasoningContent(payload: Record<string, unknown>): void {
  const model = typeof payload["model"] === "string" ? payload["model"] : "";
  const thinking = payload["thinking"];
  const thinkingEnabled = isRecord(thinking) && thinking["type"] === "enabled";
  const messages = payload["messages"];
  if (!Array.isArray(messages)) return;
  const requiresReplay = REASONING_REPLAY_MODEL_RE.test(model);
  const hasTrace = messages.some(
    (message) =>
      isRecord(message) &&
      ((typeof message["reasoning"] === "string" && message["reasoning"].length > 0) ||
        "reasoning_content" in message),
  );
  if (!thinkingEnabled && !requiresReplay && !hasTrace) return;
  // As an *input* (a caller replays a prior turn), the model's own `reasoning`
  // key is the canonical record of a thinking turn. Without it there is no
  // trace to replay, so an assistant turn stays bare even under the hard rule;
  // fabricating `""` would be read by the upstream as "thinking mode with the
  // reasoning stripped" and reject the request anyway.
  const hasModelReasoning = messages.some(
    (message) =>
      isRecord(message) &&
      typeof message["reasoning"] === "string" &&
      message["reasoning"].length > 0,
  );
  if (requiresReplay && !thinkingEnabled && !hasModelReasoning && !hasTrace) return;
  for (const message of messages) {
    if (!isRecord(message) || message["role"] !== "assistant") continue;
    if (typeof message["reasoning_content"] === "string") continue;
    // Only a real trace is backfilled. Writing `""` onto every assistant turn
    // made the payload claim reasoning it did not have: the upstream reads the
    // empty field as "thinking mode with the reasoning stripped", and rejects
    // the next turn with "the reasoning content from the previous turn must be
    // passed back in thinking mode". A turn with nothing to replay stays
    // without the field so the provider sees a normal assistant turn.
    if (typeof message["reasoning"] !== "string" || message["reasoning"].length === 0) continue;
    message["reasoning_content"] = message["reasoning"];
  }
}

/** Returns Gemini's minimum output budget for a canonical reasoning intent. */
export function geminiThinkingOutputFloor(reasoning: CanonicalRequest["reasoning"]): number | undefined {
  if (reasoning === undefined || reasoning.thinking_type === "disabled") return undefined;
  if (reasoning.budget_tokens !== undefined) return geminiBudgetOutputFloor(reasoning.budget_tokens);
  if (reasoning.effort !== undefined && reasoning.effort !== "none") return geminiLevelOutputFloor(reasoning.effort);
  return undefined;
}

/**
 * Minimum output budget for a caller whose requested effort the ladder could
 * not serve as asked. See the module doc for why both clamp directions need it.
 * Only ever raises, and only to the model's own catalog limit.
 *
 * Re-exported from `translation/dialect/model-thinking` (the canonical helper);
 * this shim keeps existing importers (e.g. buddy-chat-shared) stable.
 */
export { outputFloorFor as clampedEffortOutputFloor } from "./translation/dialect/model-thinking";

/** Builds the Anthropic thinking block from canonical reasoning intent. */
export function buildAnthropicThinkingPayload(reasoning: ReasoningIntent): Record<string, unknown> {
  const blockBinding =
    reasoning.prefix_mismatch_behavior === undefined
      ? undefined
      : { prefix_mismatch_behavior: reasoning.prefix_mismatch_behavior };
  return {
    type: reasoning.thinking_type ?? "adaptive",
    ...(reasoning.budget_tokens === undefined ? {} : { budget_tokens: reasoning.budget_tokens }),
    ...(reasoning.display === undefined ? {} : { display: reasoning.display }),
    ...(blockBinding === undefined ? {} : { block_binding: blockBinding }),
  };
}

function geminiBudgetOutputFloor(budget: number): number {
  if (!Number.isFinite(budget)) return 32768;
  if (budget <= 1024) return 8192;
  if (budget <= 8192) return 16384;
  if (budget <= 24576) return 32768;
  return 65535;
}

function geminiLevelOutputFloor(level: string): number {
  switch (level) {
    case "minimal":
      return 4096;
    case "low":
      return 8192;
    case "medium":
      return 16384;
    case "high":
    case "xhigh":
    case "max":
      return 65535;
    default:
      return 65535;
  }
}

