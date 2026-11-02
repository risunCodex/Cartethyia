/**
 * Canonical thinking clamp + output-floor helpers, shared by every wire codec.
 *
 * `clampThinkingLevelForModel` is the single clamp: it steps a requested
 * effort down to the highest supported level ≤ the request, or up to the
 * model's floor when the request is below it. It replaces the old
 * `clampReasoningEffort` with the same semantics, driven by the data-driven
 * `ThinkingConfig` from `thinking-ladder.ts`.
 *
 * `outputFloorFor` is the clamped-effort output floor (previously
 * `clampedEffortOutputFloor` in `protocol/reasoning.ts`): when the applied
 * effort differs from the requested one, the caller sized `max_tokens` for the
 * effort it asked for, and the applied level spends its budget on reasoning
 * before writing the answer — so raise the output budget to the model's
 * catalog ceiling rather than let the answer truncate.
 */
import {
  REASONING_EFFORT_LADDER,
  type ReasoningEffortLevel,
} from "../thinking";
import type { ThinkingConfig } from "./thinking-ladder";

/**
 * Clamps a requested reasoning effort against a model/wire's resolved
 * `ThinkingConfig`. Same semantics as the removed `clampReasoningEffort`:
 * synonyms normalize (`ultra` → `max`, `off` → `none`), unknown strings drop
 * (no invented fallback), and a request below the floor uses the floor.
 */
export function clampThinkingLevelForModel(
  thinking: ThinkingConfig | undefined,
  requested: string | undefined,
): ReasoningEffortLevel | undefined {
  if (requested === undefined || typeof requested !== "string") return undefined;
  const raw = requested.toLowerCase().trim();
  const normalized = raw === "ultra" ? "max" : raw === "off" ? "none" : raw;
  if (normalized === "none") return undefined;
  if (thinking === undefined) return normalized as ReasoningEffortLevel;

  const supported = thinking.efforts;
  if (supported.includes(normalized as ReasoningEffortLevel)) {
    return normalized as ReasoningEffortLevel;
  }
  const requestedIndex = REASONING_EFFORT_LADDER.indexOf(normalized as ReasoningEffortLevel);
  if (requestedIndex === -1) return undefined;

  let clamped: ReasoningEffortLevel | undefined;
  for (const level of supported) {
    if (REASONING_EFFORT_LADDER.indexOf(level) > requestedIndex) break;
    clamped = level;
  }
  // No smaller supported level exists (caller asked below floor): use floor.
  return clamped ?? supported[0];
}

const CLAMPED_EFFORT_MIN_OUTPUT_TOKENS = 16_384;

const EFFORT_LEVEL_RANK: Readonly<Record<string, number>> = {
  off: 0,
  none: 0,
  instant: 1,
  minimal: 2,
  low: 3,
  medium: 4,
  high: 5,
  xhigh: 6,
  max: 7,
};

/**
 * Minimum output budget for a caller whose requested effort the ladder could
 * not serve as asked. See the module doc for why both clamp directions need it.
 * Only ever raises, and only to the model's own catalog limit.
 */
export function outputFloorFor(
  requested: string | undefined,
  applied: string | undefined,
  modelOutputLimit: number | undefined,
): number | undefined {
  if (requested === undefined || applied === undefined) return undefined;
  const from = EFFORT_LEVEL_RANK[requested.trim().toLowerCase()];
  const to = EFFORT_LEVEL_RANK[applied.trim().toLowerCase()];
  if (from === undefined || to === undefined || from === to) return undefined;
  if (modelOutputLimit === undefined || !Number.isFinite(modelOutputLimit) || modelOutputLimit <= 0)
    return undefined;
  // Leave headroom instead of claiming the whole catalog limit: the caller's
  // number was a real preference about answer size, and the goal is to stop
  // truncating, not to spend the model's ceiling on every turn.
  return Math.max(CLAMPED_EFFORT_MIN_OUTPUT_TOKENS, Math.floor(modelOutputLimit / 2));
}
