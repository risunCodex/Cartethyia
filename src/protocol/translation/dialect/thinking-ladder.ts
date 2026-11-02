/**
 * Data-driven thinking/effort ladder for a model + wire family.
 *
 * Replaces the old `resolveSupportedReasoningEfforts` if-chain and
 * `claudeUsesAdaptiveThinking` string matching with a declarative rule table,
 * following the oh-my-pi pattern: a model's reasoning ladder is data (a
 * `ThinkingConfig`), not code. Adding a new model generation is a table row,
 * not another `if (id.includes(...))`.
 *
 * Precedence:
 *   1. explicit declared efforts (catalog `ModelDefinition.reasoningEfforts`)
 *   2. first matching rule in `THINKING_LADDER_RULES`
 *   3. family default (extended ladder, per-family transport mode)
 */
import type { WireFamily } from "../../canonical-model";
import {
  REASONING_EFFORT_LADDER,
  type ReasoningEffortLevel,
} from "../thinking";

/** How a reasoning effort is transported on the wire. */
export type ThinkingControlMode =
  | "effort" // OpenAI-style `reasoning_effort` / `reasoning.effort`
  | "budget" // Anthropic budget-era: `thinking.enabled` + `budget_tokens` (+ `output_config.effort`)
  | "anthropic-adaptive" // Anthropic adaptive-era: `thinking.adaptive` + `output_config.effort`
  | "google-level"; // Gemini: effort affects the output floor only

/**
 * Resolved reasoning config for one model + wire family. The codecs read this
 * instead of re-deriving ladders from model-id heuristics per request.
 */
export interface ThinkingConfig {
  /** Which wire field/transport the effort rides on. */
  readonly mode: ThinkingControlMode;
  /** Supported efforts, canonical ladder order, never empty. */
  readonly efforts: readonly ReasoningEffortLevel[];
  /** Default effort when the caller expresses none (e.g. DeepSeek forces high). */
  readonly defaultLevel?: ReasoningEffortLevel;
  /** True when the upstream rejects off/omitted efforts → clamp up to the floor. */
  readonly requiresEffort?: boolean;
}

/** Optional model-declared thinking override (compile-time, persisted catalog). */
export interface ThinkingModelDecl {
  readonly efforts?: readonly string[];
  readonly mode?: ThinkingControlMode;
}

/** DeepSeek's default effort, owned here so rule table and helpers agree. */
export const DEEPSEEK_DEFAULT_EFFORT = "high" as const;

/** Responses-wire default: no `max` tier (OpenAI/OpenCode/Azure). */
const RESPONSES_WIRE_SUPPORTED_EFFORTS: readonly ReasoningEffortLevel[] = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
];

/** Full 6-tier scale (Claude, MiMo, Kimi, DeepSeek). */
const EXTENDED_SUPPORTED_EFFORTS: readonly ReasoningEffortLevel[] = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/** Standard 4-tier scale (Gemini, Qwen). */
const BASE_SUPPORTED_EFFORTS: readonly ReasoningEffortLevel[] = [
  "minimal",
  "low",
  "medium",
  "high",
];

/** `mimo-v2.6` rejects every effort outside this set (live 500s). */
const MIMO_V26_SUPPORTED_EFFORTS: readonly ReasoningEffortLevel[] = ["low", "medium", "high"];

/** Mercury chat ladder: `{instant, low, medium, high}` (live 400s outside). */
const INCEPTION_SUPPORTED_EFFORTS: readonly ReasoningEffortLevel[] = [
  "instant",
  "low",
  "medium",
  "high",
];

/** OpenAI 5.6/6/daybreak + new-gen Claude adaptive: `low..max`, no `minimal`. */
const LOW_TO_MAX_SUPPORTED_EFFORTS: readonly ReasoningEffortLevel[] = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/** `gpt-5.5` rows: neither `minimal` nor `max`. */
const GPT55_SUPPORTED_EFFORTS: readonly ReasoningEffortLevel[] = [
  "low",
  "medium",
  "high",
  "xhigh",
];

/** Claude adaptive 4.6 pair: `low..high`. */
const CLAUDE_ADAPTIVE_46_SUPPORTED_EFFORTS: readonly ReasoningEffortLevel[] = [
  "low",
  "medium",
  "high",
];

interface ThinkingLadderRule {
  readonly id?: RegExp;
  readonly provider?: RegExp;
  readonly wireFamily?: WireFamily;
  readonly efforts: readonly ReasoningEffortLevel[];
  readonly mode?: ThinkingControlMode;
  readonly defaultLevel?: ReasoningEffortLevel;
  readonly requiresEffort?: boolean;
  /** True when `id` expects the dot → dash normalized id (Claude generations). */
  readonly normalizeClaudeId?: boolean;
}

/**
 * Rule table — the declarative replacement for the previous if-chain.
 * First match wins; `wireFamily` rules must precede family-agnostic ones so
 * the Responses wire keeps its cap (`no max`) even over Claude-family model
 * ids, exactly like the old `wireFamily === "responses"` early return.
 *
 * Claude generation rules use `normalizeClaudeId` and match against the
 * dot-tolerant form (`claude-opus-4.6` → `claude-opus-4-6`), mirroring the
 * removed `claudeUsesAdaptiveThinking` behavior.
 */
export const THINKING_LADDER_RULES: readonly ThinkingLadderRule[] = [
  // --- Responses wire (cap at `xhigh` unless a generation ladder says otherwise) ---
  { wireFamily: "responses", id: /gpt-5\.5/, efforts: GPT55_SUPPORTED_EFFORTS },
  { wireFamily: "responses", id: /gpt-5\.6|gpt-6|daybreak/, efforts: LOW_TO_MAX_SUPPORTED_EFFORTS },
  { wireFamily: "responses", efforts: RESPONSES_WIRE_SUPPORTED_EFFORTS },
  // --- Family heuristics (chat/messages/gemini) ---
  { id: /muse/, efforts: RESPONSES_WIRE_SUPPORTED_EFFORTS },
  { id: /gemini/, efforts: BASE_SUPPORTED_EFFORTS, mode: "google-level" },
  { id: /mimo-v2\.6/, efforts: MIMO_V26_SUPPORTED_EFFORTS },
  {
    id: /mercury/,
    wireFamily: "chat",
    efforts: INCEPTION_SUPPORTED_EFFORTS,
  },
  // Claude adaptive 4.6 pair: `low..high`, no `xhigh`/`max`.
  {
    id: /opus-4-6|sonnet-4-6/,
    normalizeClaudeId: true,
    efforts: CLAUDE_ADAPTIVE_46_SUPPORTED_EFFORTS,
    mode: "anthropic-adaptive",
  },
  // New-gen Claude adaptive: `low..max`.
  {
    id: /fable|mythos|opus-5|sonnet-5|opus-4-7|opus-4-8/,
    normalizeClaudeId: true,
    efforts: LOW_TO_MAX_SUPPORTED_EFFORTS,
    mode: "anthropic-adaptive",
  },
  // Budget-era Claude rows: `minimal..xhigh`, no `max`.
  {
    id: /opus-4-5|sonnet-4-5|haiku-4-5|opus-4-1|opus-4-0|sonnet-4-0/,
    normalizeClaudeId: true,
    efforts: RESPONSES_WIRE_SUPPORTED_EFFORTS,
  },
  // Any other Claude row: extended ladder, budget-era transport.
  { id: /claude/, efforts: EXTENDED_SUPPORTED_EFFORTS },
];

function familyDefaultMode(wireFamily: WireFamily): ThinkingControlMode {
  if (wireFamily === "messages") return "budget";
  if (wireFamily === "gemini") return "google-level";
  return "effort";
}

/**
 * Resolves the thinking config for a model + wire family. Pure, never throws,
 * always returns a config (the family default is the floor).
 */
export function resolveThinkingForModel(
  modelId: string,
  providerId: string,
  wireFamily: WireFamily,
  declared?: ThinkingModelDecl,
): ThinkingConfig {
  const id = modelId.toLowerCase();

  // Declared efforts (catalog `reasoningEfforts`) win when present and valid.
  if (declared?.efforts !== undefined && declared.efforts.length > 0) {
    const filtered = declared.efforts.filter((e): e is ReasoningEffortLevel =>
      REASONING_EFFORT_LADDER.includes(e as ReasoningEffortLevel),
    );
    if (filtered.length > 0) {
      return {
        mode: declared.mode ?? familyDefaultMode(wireFamily),
        efforts: filtered,
      };
    }
  }

  for (const rule of THINKING_LADDER_RULES) {
    if (rule.wireFamily !== undefined && rule.wireFamily !== wireFamily) continue;
    if (rule.id !== undefined) {
      const source = rule.normalizeClaudeId === true ? id.replaceAll(".", "-") : id;
      if (!rule.id.test(source)) continue;
    }
    if (rule.provider !== undefined && !rule.provider.test(providerId)) continue;
    return {
      mode: rule.mode ?? familyDefaultMode(wireFamily),
      efforts: rule.efforts,
      ...(rule.defaultLevel === undefined ? {} : { defaultLevel: rule.defaultLevel }),
      ...(rule.requiresEffort === undefined ? {} : { requiresEffort: rule.requiresEffort }),
    };
  }

  return { mode: familyDefaultMode(wireFamily), efforts: EXTENDED_SUPPORTED_EFFORTS };
}
