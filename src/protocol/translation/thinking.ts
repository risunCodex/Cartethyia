// Thinking-config normalization on canonical requests.
//
// Provider-native extended thinking (Anthropic `thinking` object) is only
// honored on a fresh user turn. On a tool-result turn the upstream rejects it,
// so the native config (`thinking_type` + `budget_tokens`) is dropped while the
// request-level effort intent (OpenAI `reasoning_effort`) survives — that field
// is a property of the request, not of the turn.
import type { CanonicalRequest, ReasoningIntent } from "../canonical-model";
import type { ThinkingConfig } from "./dialect/thinking-ladder";
import { clampThinkingLevelForModel } from "./dialect/model-thinking";

/**
 * Canonical reasoning effort ladder, ordered least to most intensive.
 * Provides a unified effort scale across OpenAI, Anthropic, and open-weight models.
 */
export const REASONING_EFFORT_LADDER = [
  "instant",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type ReasoningEffortLevel = (typeof REASONING_EFFORT_LADDER)[number];

/**
 * A client-requested thinking level written onto the model name as
 * `model(level)` or `model(budget)`.
 *
 * `mode: "auto"` means "let the provider decide" and `mode: "none"` means
 * "reasoning off" — both are distinct from an absent suffix, which means the
 * caller expressed no opinion at all.
 */
export type ThinkingSuffixIntent =
  | { readonly mode: "level"; readonly level: ReasoningEffortLevel }
  | { readonly mode: "budget"; readonly budget: number }
  | { readonly mode: "none" }
  | { readonly mode: "auto" };

/**
 * A parsed model name: the bare id the router and upstream must see, plus the
 * thinking level the caller asked for (or null when they asked for none).
 */
interface ParsedThinkingSuffix {
  readonly model: string;
  readonly intent: ThinkingSuffixIntent | null;
}

/**
 * Level → thinking budget in tokens.
 *
 * The ladder is the published Anthropic/Gemini scale, kept here as the single
 * source of truth for both directions. `none` is 0 because "off" is the one
 * value the ladder cannot express as a positive budget.
 */
export const LEVEL_TO_BUDGET: Readonly<Record<ReasoningEffortLevel | "none", number>> = {
  none: 0,
  instant: 256,
  minimal: 512,
  low: 1_024,
  medium: 8_192,
  high: 24_576,
  xhigh: 32_768,
  max: 128_000,
};

/**
 * Upper bound (inclusive) for each tier when reading a budget back as a level.
 *
 * These are the reference implementation's thresholds, kept verbatim so the two
 * cannot drift. They are the midpoints between adjacent `LEVEL_TO_BUDGET`
 * values, except `low`/`medium`, which the reference pins at the round 4_096
 * rather than the midpoint 4_608.
 */
const BUDGET_LEVEL_CEILINGS: readonly (readonly [ReasoningEffortLevel, number])[] = [
  ["minimal", 768],
  ["low", 4_096],
  ["medium", 16_384],
  ["high", 28_672],
  ["xhigh", 80_384],
];

/**
 * Nearest ladder level for a token budget.
 *
 * The previous heuristic here bucketed everything from 4_096 up as `high`, so a
 * deliberate 4_096-token budget read as a bigger ask than it was — the same
 * input the reference calls `low`. Reading through one shared table keeps a
 * budget expressed as tokens and the same request expressed as a level
 * agreeing.
 *
 * Returns null for a non-positive budget (no reasoning).
 */
export function budgetToLevel(budget: number): ReasoningEffortLevel | null {
  if (!Number.isFinite(budget) || budget <= 0) return null;
  for (const [level, ceiling] of BUDGET_LEVEL_CEILINGS) {
    if (budget <= ceiling) return level;
  }
  return "max";
}

/**
 * Splits a thinking suffix off a model name.
 *
 * The syntax is `model(level)` — parentheses, deliberately, not a dash. A dash
 * suffix would be ambiguous: this catalog contains 73 ids that end in a level
 * word, and for 22 of them the truncated prefix is itself a real model
 * (`gemini-3.1-pro-high` → `gemini-3.1-pro`, `gpt-5.1-codex-max` →
 * `gpt-5.1-codex`, `o3-mini-high` → `o3-mini`). Stripping those would silently
 * redirect a request to a different model. No model id in the catalog contains
 * a parenthesis, so this form is unambiguous without consulting any catalog.
 *
 * An unrecognized or empty value leaves the model untouched: a typo must not
 * fail an otherwise valid request.
 */
export function parseThinkingSuffix(model: string): ParsedThinkingSuffix {
  const match = /^(.*)\(([^()]*)\)\s*$/.exec(model);
  if (match === null) return { model, intent: null };
  const bare = match[1]!.trim();
  // A name that is nothing but a suffix (`(high)`) is not a model we can route;
  // leave it alone so the caller gets a normal model-not-found rather than a
  // confusing empty-name error.
  if (bare.length === 0) return { model, intent: null };
  const raw = match[2]!.trim().toLowerCase();
  if (raw === "none" || raw === "off") return { model: bare, intent: { mode: "none" } };
  if (raw === "auto") return { model: bare, intent: { mode: "auto" } };
  // `ultra` is a vendor synonym for the top tier, matching `clampReasoningEffort`.
  if (raw === "ultra") return { model: bare, intent: { mode: "level", level: "max" } };
  if (/^\d+$/.test(raw)) {
    const budget = Number(raw);
    return budget > 0
      ? { model: bare, intent: { mode: "budget", budget } }
      : { model, intent: null };
  }
  if (REASONING_EFFORT_LADDER.includes(raw as ReasoningEffortLevel)) {
    return { model: bare, intent: { mode: "level", level: raw as ReasoningEffortLevel } };
  }
  return { model, intent: null };
}

/**
 * The model name a client would write to request `level`, i.e. the inverse of
 * {@link parseThinkingSuffix}: `claude-sonnet-4-5` + `low` → `claude-sonnet-4-5(low)`.
 *
 * Exists so the naming rule lives in one place: the dashboard renders the
 * routable id an operator should copy, and a hand-written `(level)` string there
 * would drift from the parser the moment either side changes. `auto` and `none`
 * are real suffix values the parser accepts, so they round-trip too; an absent
 * level (no opinion) leaves the bare id.
 */
export function formatThinkingSuffix(model: string, level: ReasoningEffortLevel | "auto" | "none" | null): string {
  if (level === null) return model;
  return `${model}(${level})`;
}

/**
 * Writes a parsed suffix intent onto a request's reasoning state.
 *
 * The suffix wins over whatever the body said: it is the more specific,
 * per-request statement of intent, and a caller who writes both is asking for
 * the model name to decide.
 *
 * A numeric budget is normalized to its nearest ladder tier rather than carried
 * through as a token count. That is deliberate — the tier is what the per-model
 * clamp understands, so `model(128000)` on a model that tops out at `high`
 * lands on `high` instead of leaving a 128k budget next to a clamped effort.
 * Normalizing to the tier is what makes one suffix mean the same thing on every
 * model.
 */
export function withThinkingSuffixIntent(
  request: CanonicalRequest,
  intent: ThinkingSuffixIntent,
): CanonicalRequest {
  const reasoning: ReasoningIntent = { ...(request.reasoning ?? {}) };

  if (intent.mode === "none") {
    // `disabled` is the explicit switch: clearing `effort` alone leaves the
    // upstream free to reason, because absence means "no opinion", not "off".
    reasoning.thinking_type = "disabled";
    delete reasoning.effort;
    delete reasoning.budget_tokens;
  } else if (intent.mode === "auto") {
    delete reasoning.effort;
    delete reasoning.budget_tokens;
    if (reasoning.thinking_type === "disabled") delete reasoning.thinking_type;
  } else {
    const level = intent.mode === "budget" ? budgetToLevel(intent.budget) : intent.level;
    if (level === null) return request;
    reasoning.effort = level;
    delete reasoning.budget_tokens;
    if (reasoning.thinking_type === "disabled") delete reasoning.thinking_type;
  }

  if (Object.keys(reasoning).length === 0) {
    const next = { ...request };
    delete next.reasoning;
    return next;
  }
  return { ...request, reasoning };
}

/** Standard OpenAI Responses wire supported efforts (OpenAI, OpenCode, Azure). Responses API has no 'max' tier. */


interface ThinkingNormalizationOptions {
  /** Resolved thinking config (from `resolveThinkingForModel`). Absent = no clamp. */
  readonly thinking?: ThinkingConfig;
}

/**
 * True when there are no messages or the last message is a user turn. A request
 * with no history is treated as user-originated.
 */
function isLastMessageFromUser(request: CanonicalRequest): boolean {
  const last = request.messages[request.messages.length - 1];
  return last === undefined || last.role === "user";
}

/**
 * True when the conversation replays provider thinking blocks (signed,
 * opaque, or encrypted). Anthropic rejects those blocks unless the matching
 * `thinking` config is also present, so a config drop must never leave them
 * orphaned.
 */
function hasReplayedThinkingBlocks(request: CanonicalRequest): boolean {
  for (const message of request.messages) {
    for (const part of message.content) {
      if (part.kind !== "reasoning") continue;
      if (
        part.opaque === true ||
        part.encrypted_content !== undefined ||
        part.signature !== undefined
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Drops provider-native thinking config when the last message is not a user
 * turn. `effort` is request-level intent and is preserved.
 *
 * The drop is suppressed when the conversation replays thinking blocks: a
 * config-less request carrying signed/encrypted blocks is rejected upstream
 * ("thinking is not enabled"), so the two must stay in sync. Returns the same
 * reference when there is nothing to change; never mutates the input.
 */
export function normalizeThinkingConfig(
  request: CanonicalRequest,
  options?: ThinkingNormalizationOptions,
): CanonicalRequest {
  let reasoning = request.reasoning;
  let changed = false;

  // Step 1: Normalize turn-based native thinking blocks (drop on non-user turns unless replaying blocks)
  if (!isLastMessageFromUser(request) && reasoning !== undefined) {
    if (
      (reasoning.thinking_type !== undefined || reasoning.budget_tokens !== undefined) &&
      !hasReplayedThinkingBlocks(request)
    ) {
      reasoning = { ...reasoning };
      delete reasoning.thinking_type;
      delete reasoning.budget_tokens;
      changed = true;
    }
  }

  // Only clamp when caller actually set an effort AND a thinking config is
  // resolved (ladder known). Without one, don't invent a clamp — pass through.
  if (reasoning?.effort !== undefined && options?.thinking !== undefined) {
    const clamped = clampThinkingLevelForModel(options.thinking, reasoning.effort);
    if (clamped !== reasoning.effort) {
      reasoning = { ...reasoning };
      if (clamped === undefined) delete reasoning.effort;
      else reasoning.effort = clamped;
      changed = true;
    }
  }

  if (!changed) return request;
  if (reasoning === undefined) {
    const next = { ...request };
    delete next.reasoning;
    return next;
  }
  return { ...request, reasoning };
}
