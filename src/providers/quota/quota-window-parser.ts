/**
 * Generic quota parser for providers whose responses are simple object trees
 * of percentage/usage windows.
 *
 * Providers with genuinely bespoke shapes (Tencent billing envelopes, WorkOS
 * usage arrays, duration-derived labels) keep their own parser; this module
 * only covers the declarative cases so the window-assembly boilerplate lives
 * in one place.
 */
import {
  isoDate,
  number,
  percentWindow,
  quotaRecord,
  text,
} from "./quota-contracts";
import type { ProviderQuotaResult, ProviderQuotaWindow } from "./quota-contracts";

/** How to locate a single value inside a nested object. */
export type ValuePath = readonly string[];

/** Mapping from a response shape to a provider quota window. */
export interface QuotaWindowMapping {
  readonly kind: string;
  readonly label: string;
  /** Paths (in priority order) for the used-percent value. */
  readonly usedPercentPaths?: readonly ValuePath[];
  /** Paths (in priority order) for the remaining-percent value. */
  readonly remainingPercentPaths?: readonly ValuePath[];
  /** Paths (in priority order) for the reset timestamp. */
  readonly resetPaths?: readonly ValuePath[];
  /** Fixed fallback reset timestamp. */
  readonly resetFallback?: string;
  /** Paths (in priority order) for the absolute used value. */
  readonly usedPaths?: readonly ValuePath[];
  /** Paths (in priority order) for the absolute limit value. */
  readonly limitPaths?: readonly ValuePath[];
  /** Multiplier applied to the final percentage (e.g., 100 for a 0-1 ratio). */
  readonly valueMultiplier?: number;
  /**
   * Provider-specific percentage derivation evaluated before the declarative
   * paths. Return `null` to fall through to the paths.
   */
  readonly derivePercent?: (payload: unknown) => number | null;
  /**
   * When true, a window is still emitted with a `null` percentage if a reset
   * timestamp is present (used for countdown-only windows).
   */
  readonly emitWithoutPercent?: boolean;
}

/** Options for the generic quota parser. */
export interface QuotaParserOptions {
  readonly source: string;
  /** Where to read the plan name from the payload. */
  readonly planPaths?: readonly ValuePath[];
  readonly planFallback?: string;
  /** Custom transform applied to the raw payload before parsing. */
  readonly transform?: (body: unknown) => unknown;
  /** Extra provider-specific windows appended after the declarative ones. */
  readonly extraWindows?: (payload: unknown) => readonly ProviderQuotaWindow[];
}

function readAt(root: unknown, path: ValuePath): unknown | undefined {
  let current: unknown = root;
  for (const key of path) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function findNumber(root: unknown, paths: readonly ValuePath[] | undefined): number | null {
  if (!paths) return null;
  for (const path of paths) {
    const parsed = number(readAt(root, path));
    if (parsed !== null) return parsed;
  }
  return null;
}

function findText(root: unknown, paths: readonly ValuePath[] | undefined): string | null {
  if (!paths) return null;
  for (const path of paths) {
    const parsed = text(readAt(root, path));
    if (parsed !== null) return parsed;
  }
  return null;
}

function findReset(root: unknown, mapping: QuotaWindowMapping): string | null {
  if (mapping.resetPaths) {
    for (const path of mapping.resetPaths) {
      const parsed = isoDate(readAt(root, path));
      if (parsed !== null) return parsed;
    }
  }
  return mapping.resetFallback ?? null;
}

/**
 * The raw per-window candidates the shared emission core resolves.
 *
 * Both quota walkers (`parseQuotaWindows` and `parseLimitWindows`) feed their
 * independently-read fields into one resolution so the percent fallback chain
 * and the skip rule cannot drift between them.
 */
export interface WindowFieldCandidates {
  /** Provider-preferred percent (e.g. a `derivePercent` result). */
  readonly explicitPercent: number | null;
  /** Raw used-percent read from the payload. */
  readonly usedPercent: number | null;
  /** Raw remaining-percent read from the payload. */
  readonly remainingPercent: number | null;
  /** Absolute used value. */
  readonly used: number | null;
  /** Absolute limit value. */
  readonly limit: number | null;
  /** Reset timestamp; required to emit a reset-only window. */
  readonly reset: string | null;
  /**
   * Whether percent may be derived from absolute used/limit when no percentage
   * was reported. Only `parseQuotaWindows` does this — `parseLimitWindows`
   * reports percentages and resets the upstream gave it, never ones it
   * invented, so Cline entries stay reset-only instead of gaining a derived
   * percent.
   */
  readonly deriveFromUsedLimit: boolean;
  /**
   * When true, a reset-only window (percent null, reset present) is still
   * emitted. When false/absent, an entry with neither percent nor reset is
   * dropped — never rendered as 0% — and a reset-only window is dropped too.
   */
  readonly emitWithoutPercent?: boolean;
}

/**
 * Shared per-window field resolution: the percent fallback chain plus the
 * "emit or skip" decision.
 *
 * Percent resolution order is exact: explicit percent, then used-percent, then
 * remaining-percent inverted (100 − remaining), then derived from absolute
 * used/limit (only when the limit is positive and `deriveFromUsedLimit` is
 * set). The result is never coerced to 0: a missing percentage stays `null`,
 * so a window can be omitted or rendered as a countdown depending on
 * `emitWithoutPercent`.
 */
export function resolveWindowEmission(candidates: WindowFieldCandidates): {
  readonly emit: boolean;
  readonly percent: number | null;
} {
  let percent = candidates.explicitPercent;
  if (percent === null && candidates.usedPercent !== null) percent = candidates.usedPercent;
  if (percent === null && candidates.remainingPercent !== null) {
    percent = Math.max(0, 100 - candidates.remainingPercent);
  }
  if (
    percent === null &&
    candidates.deriveFromUsedLimit &&
    candidates.used !== null &&
    candidates.limit !== null &&
    candidates.limit > 0
  ) {
    percent = (candidates.used / candidates.limit) * 100;
  }
  const emit = percent !== null || (candidates.emitWithoutPercent === true && candidates.reset !== null);
  return { emit, percent };
}

/** Parses a generic quota payload using the provided window mappings. */
export function parseQuotaWindows(
  body: unknown,
  windowMappings: readonly QuotaWindowMapping[],
  options: QuotaParserOptions,
): ProviderQuotaResult {
  const payload = options.transform ? options.transform(body) : quotaRecord(body);
  const windows: ProviderQuotaWindow[] = [];

  for (const mapping of windowMappings) {
    const used = findNumber(payload, mapping.usedPaths);
    const limit = findNumber(payload, mapping.limitPaths);
    const reset = findReset(payload, mapping);

    const { emit, percent } = resolveWindowEmission({
      explicitPercent: mapping.derivePercent ? mapping.derivePercent(payload) : null,
      usedPercent: findNumber(payload, mapping.usedPercentPaths),
      remainingPercent: findNumber(payload, mapping.remainingPercentPaths),
      used,
      limit,
      reset,
      deriveFromUsedLimit: true,
      ...(mapping.emitWithoutPercent === undefined ? {} : { emitWithoutPercent: mapping.emitWithoutPercent }),
    });
    if (!emit) continue;

    let resolvedPercent = percent;
    if (
      resolvedPercent !== null &&
      mapping.valueMultiplier !== undefined &&
      mapping.valueMultiplier !== 0
    ) {
      resolvedPercent = Math.min(100, Math.max(0, resolvedPercent * mapping.valueMultiplier));
    }

    windows.push(percentWindow(mapping.kind, mapping.label, resolvedPercent, reset, used, limit, "independent"));
  }

  if (options.extraWindows) windows.push(...options.extraWindows(payload));

  // Drop a window whose label a declarative mapping already produced.
  //
  // The two sources describe the same scopes in different vocabularies: the
  // declarative keys (`five_hour`, `seven_day`) and the payload's own `limits[]`
  // array (`kind: "session"`, `kind: "weekly_all"`). Nothing marked them as the
  // same window, so a payload carrying both rendered each one twice — the quota
  // card showed "5 Hour / 7 Day / 5 Hour / 7 Day". Identity is the label, not
  // the kind, because the kinds deliberately differ between the two
  // vocabularies; the label is also what the operator sees, and a per-model
  // window keeps a distinct label (`7 Day (Opus)`), so a genuinely different
  // window is never collapsed. Declarative windows come first, so they win —
  // but a payload that reports *only* `limits[]` still shows its windows,
  // because then there is no earlier label to match.
  const seenLabels = new Set<string>();
  const deduped: ProviderQuotaWindow[] = [];
  for (const window of windows) {
    if (seenLabels.has(window.label)) continue;
    seenLabels.add(window.label);
    deduped.push(window);
  }

  return {
    source: options.source,
    plan: findText(payload, options.planPaths) ?? options.planFallback ?? null,
    windows: deduped,
    error: null,
  };
}
