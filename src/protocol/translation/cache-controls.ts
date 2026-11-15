import type { CacheHint } from "../canonical-model";

/**
 * Provider-specific cache control translation from canonical cache hints.
 * Requirements 128-135: Anthropic Messages and OpenAI 5.6+ payload shapes.
 */

// ============================================================================
// Shared Cache Breakpoint Helper
// ============================================================================

interface CacheBreakpointPredicates {
  /** Returns true if the item represents a user/developer input */
  isInputItem: (item: Record<string, unknown>) => boolean;
  /** Returns true if the role is cacheable (user/developer/system) */
  isCacheableRole: (role: unknown) => boolean;
  /** Returns true if the block type is cacheable */
  isCacheableBlock: (block: Record<string, unknown>) => boolean;
  /** Writes the prompt_cache_breakpoint marker to a block */
  writeMarker: (block: Record<string, unknown>) => void;
}

/**
 * F-34: marks the Nth-from-last cacheable block for each position in `list`
 * (0 = the latest cacheable block, 1 = the one before it, ...) — the caller's
 * explicit breakpoint intent, instead of every builder collapsing the hint to
 * its single latest block. Positions are deduped and capped at four, the
 * breakpoint cap Anthropic and OpenAI 5.6+ both enforce.
 */
export function markBreakpointsAtPositions(
  items: Array<Record<string, unknown>>,
  predicates: CacheBreakpointPredicates,
  positions: readonly number[],
): void {
  const capped = [...new Set(positions.filter((n) => Number.isInteger(n) && n >= 0))].sort(
    (a, b) => a - b,
  );
  if (capped.length === 0 || capped.length > 4) return;

  let latestInput = -1;
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item && predicates.isInputItem(item)) {
      latestInput = i;
      break;
    }
  }
  if (latestInput <= 0) return;

  // One backward pass collects the cacheable candidates in wire order; each
  // requested position indexes into that collection from the end.
  const candidates: Array<() => void> = [];
  for (let i = latestInput - 1; i >= 0 && candidates.length <= capped[capped.length - 1]!; i--) {
    const item = items[i];
    if (!item || !predicates.isInputItem(item)) continue;

    const role = item["role"];
    if (!predicates.isCacheableRole(role)) continue;

    const content = item["content"];
    if (typeof content === "string") {
      const index = i;
      candidates.push(() => {
        items[index] = {
          ...items[index]!,
          content: [{ type: "text", text: content, prompt_cache_breakpoint: { mode: "explicit" } }],
        };
      });
      continue;
    }
    if (!Array.isArray(content)) continue;

    for (let j = content.length - 1; j >= 0; j--) {
      const block = content[j];
      if (
        typeof block === "object" &&
        block !== null &&
        predicates.isCacheableBlock(block as Record<string, unknown>)
      ) {
        const target = block as Record<string, unknown>;
        candidates.push(() => predicates.writeMarker(target));
      }
    }
  }
  for (const position of capped) {
    // Positions beyond the collected candidates are a hint for history the
    // request does not carry — skipped, not an error.
    const apply = candidates[candidates.length - 1 - position];
    apply?.();
  }
}

// ============================================================================
// Anthropic Cache Control (Messages API)
// ============================================================================

interface AnthropicCacheControl {
  type: "ephemeral";
  /** Real Anthropic Messages wire field — NOT `budget_tokens` (that belongs only to `thinking`). */
  ttl?: AnthropicCacheTtl;
}

type AnthropicCacheTtl = "5m" | "1h";

interface AnthropicCacheControlOptions {
  ttl?: AnthropicCacheTtl;
}

/**
 * Translates canonical cache hint to Anthropic top-level cache_control or
 * per-block cache controls. Moving breakpoint as history grows, per-content
 * cache controls for caller-marked breakpoints, 5m/1h TTL support.
 * No invented minimum prefix length.
 */
export function anthropicCacheControl(
  _hint: CacheHint | undefined,
  options: AnthropicCacheControlOptions = {},
): { cache_control: AnthropicCacheControl } {
  const control: AnthropicCacheControl = { type: "ephemeral" };
  if (options.ttl) control.ttl = options.ttl;

  // Every hint shape maps to the same top-level control: stable_prefix emits
  // it at the last cacheable block, breakpoint hints are handled per-block by
  // the surface adapter, and no hint still gets Anthropic's automatic cache
  // control. The (unused) hint parameter is kept so call sites document intent.
  return { cache_control: control };
}
