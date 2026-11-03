/**
 * Usage input-token accounting mode.
 *
 * Providers disagree on whether `input_tokens` already includes cached tokens.
 * OpenAI/DeepSeek report the inclusive total with a cached subset; Anthropic
 * reports fresh-only with cache reads (and writes) separate. `normalizeUsage`
 * reads this mode to decide whether to fold cache into input so every provider
 * reads alike (`inclusive`, the default) or to keep the raw upstream semantics
 * (`as-is`).
 */

import { CONFIG_SPEC, readText } from "./spec";

export type UsageInputMode = "inclusive" | "as-is";

/** Resolves the operator's chosen accounting mode; defaults to inclusive. */
export function resolveUsageInputMode(): UsageInputMode {
  const raw = readText(
    "CARTETHYIA_USAGE_INPUT_MODE",
    CONFIG_SPEC.CARTETHYIA_USAGE_INPUT_MODE,
  )
    .trim()
    .toLowerCase();
  if (raw === "inclusive") return "inclusive";
  if (raw === "as-is") return "as-is";
  throw new Error('CARTETHYIA_USAGE_INPUT_MODE must be "inclusive" or "as-is"');
}
