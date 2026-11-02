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
 * Parameterized cache-breakpoint marker that works across wire formats.
 * Finds the latest user/developer input, then scans backwards to mark the first
 * cacheable block with an explicit prompt_cache_breakpoint.
 */
export function markLatestBreakpoint(
  items: Array<Record<string, unknown>>,
  predicates: CacheBreakpointPredicates,
): void {
  let latestInput = -1;
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item && predicates.isInputItem(item)) {
      latestInput = i;
      break;
    }
  }
  if (latestInput <= 0) return;

  for (let i = latestInput - 1; i >= 0; i--) {
    const item = items[i];
    if (!item || !predicates.isInputItem(item)) continue;

    const role = item["role"];
    if (!predicates.isCacheableRole(role)) continue;

    const content = item["content"];
    if (typeof content === "string") {
      items[i] = {
        ...item,
        content: [{ type: "text", text: content, prompt_cache_breakpoint: { mode: "explicit" } }],
      };
      return;
    }
    if (!Array.isArray(content)) continue;

    for (let j = content.length - 1; j >= 0; j--) {
      const block = content[j];
      if (
        typeof block === "object" &&
        block !== null &&
        predicates.isCacheableBlock(block as Record<string, unknown>)
      ) {
        predicates.writeMarker(block as Record<string, unknown>);
        return;
      }
    }
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
