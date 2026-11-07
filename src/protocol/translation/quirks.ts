// Declarative provider parameter quirks.
//
// Some upstreams reject combinations the OpenAI/Anthropic contracts permit
// (e.g. Anthropic rejects `temperature` alongside extended thinking). Instead
// of scattering ad-hoc `delete payload.x` fixes through adapters, each quirk
// lives in one table row: the provider it applies to, an optional model
// matcher, and the strip/clamp to apply.
//
// Add a row ONLY when a concrete upstream 400/422 proves the quirk; do not
// speculate. The table is applied on the dispatch path before wire translation.

import type { CanonicalRequest, GenerationControls } from "../canonical-model";
import {
  THINKING_STRIPPED_SAMPLING_CONTROLS,
  isThinkingEnabled,
} from "./capabilities";

export interface ParamQuirk {
  /** Provider id the quirk applies to (matches `candidate.provider_id`). */
  readonly provider: string;
  /**
   * Optional model matcher; when absent the quirk applies to every model.
   * A predicate is allowed because some quirks turn on a model *generation*
   * (`claude-opus-4-7` vs `claude-opus-4-6`), which no literal pattern can
   * express without enumerating every future id.
   */
  readonly matchModel?: RegExp | ((modelId: string) => boolean);
  /** Canonical `generation_controls` keys to strip before dispatch. */
  readonly stripControls?: readonly (keyof GenerationControls)[];
  /** Upper bound applied to `generation_controls.max_tokens` when exceeded. */
  readonly clampMaxOutput?: number;
}

/** Per-wire output-token policy, in one table instead of per-builder branches. */
interface WireTokenBound {
  /** Default when the caller sent no limit (undefined = leave absent). */
  readonly defaultMaxTokens?: number;
  /** Floor applied to any positive caller value below it (wire minimum). */
  readonly minTokens?: number;
  /** Floor applied when tools are present and the value is narrower. */
  readonly toolCallFloor?: number;
  /** Hard ceiling; values above are clamped down. */
  readonly ceiling?: number;
  /** OAuth ceiling applied after floor/default. */
  readonly oauthCeiling?: number;
}

/**
 * The output limit assumed when the caller states none, for wires that need
 * the field present.
 *
 * PROVEN, not assumed: a 3.16M-char prompt to CodeBuddy
 * (`bansos/deepseek-v4.1-flash`) answered `400 model_param_invalid` whenever
 * `max_tokens` was absent, and answered 200 with the *same* body plus any
 * explicit value — `1`, `16`, `1000`, `8000`, `64000`, `384000` all passed.
 * So the upstream rejects the *absence* of the field, not its magnitude, and
 * the default only has to be a real limit the wire already permits.
 *
 * It equals the chat wire's existing ceiling, so it introduces no number the
 * wire did not already clamp to: "the caller set no limit" now means "the most
 * this wire allows", which is what an omitted limit is asking for.
 */
const DEFAULT_OUTPUT_TOKENS = 32_000;

/**
 * Output-token bounds per wire family. Chat has no global ceiling: a model's
 * catalog output limit is the ceiling, and an unknown model passes the
 * caller's value through. Messages keeps its Anthropic floors and OAuth cap.
 *
 * The ceiling only ever comes from `options.maxOutputTokens` (the model's
 * catalog output limit, supplied by the compatible adapter from
 * `candidate.output_limit`). When it is omitted there is nothing to clamp to,
 * which is intentional pass-through: a direct codec caller without a catalog
 * limit is unbounded, and an unknown model passes the caller's value through by
 * design — the bound table supplies floors/defaults, never an invented ceiling.
 */
export const WIRE_TOKEN_BOUNDS: Readonly<Record<string, WireTokenBound>> = {
  chat: { minTokens: 16, defaultMaxTokens: DEFAULT_OUTPUT_TOKENS },
  messages: { minTokens: 16, defaultMaxTokens: 4_096, toolCallFloor: 32_000, oauthCeiling: 64_000 },
  responses: { minTokens: 16, defaultMaxTokens: DEFAULT_OUTPUT_TOKENS },
};

/**
 * Resolves the output-token value for one wire from caller controls.
 *
 * Clamping to a ceiling happens only when `options.maxOutputTokens` (the
 * model's catalog limit) is present. An omitted `maxOutputTokens` means
 * pass-through by design: a direct codec caller without a catalog limit is
 * unbounded, and this function never fabricates a ceiling on its own.
 */
export function resolveWireMaxTokens(
  wire: string,
  controls: { max_tokens?: number | undefined },
  options: { hasTools?: boolean; isOAuth?: boolean; maxOutputTokens?: number } = {},
): number | undefined {
  const bound = WIRE_TOKEN_BOUNDS[wire];
  if (bound === undefined) return controls.max_tokens;
  let value = controls.max_tokens;
  if (value === undefined && bound.defaultMaxTokens !== undefined) value = bound.defaultMaxTokens;
  if (value !== undefined && bound.minTokens !== undefined && value < bound.minTokens)
    value = bound.minTokens;
  if (value !== undefined && bound.toolCallFloor !== undefined && options.hasTools === true && value < bound.toolCallFloor)
    value = bound.toolCallFloor;
  if (value !== undefined && bound.oauthCeiling !== undefined && options.isOAuth === true && value > bound.oauthCeiling)
    value = bound.oauthCeiling;
  const ceiling = options.maxOutputTokens ?? bound.ceiling;
  if (value !== undefined && ceiling !== undefined && value > ceiling) value = ceiling;
  return value;
}
/**
 * Model families whose newer generations reject non-default sampling
 * parameters outright.
 *
 * `claude-opus-4-7` and later, plus every `claude-sonnet`/`claude-fable`/
 * `claude-mythos` at generation 5 or later, answer
 * `` `temperature` is deprecated for this model `` with a 400. Older
 * generations accept sampling normally, so the strip cannot be applied to the
 * whole family: `claude-opus-4-6` and `claude-sonnet-4-6` take `temperature`
 * and must keep receiving it.
 *
 * Keyed on the generation rather than an id list so a new model id is covered
 * the day it ships. A name with no parseable generation (a dated snapshot such
 * as `claude-haiku-4-5-20251001`, or a reseller alias) reports no generation
 * and is left untouched — the same conservative default the reference takes.
 */
const SAMPLING_REJECTING_FAMILIES: readonly string[] = ["opus", "sonnet", "fable", "mythos"];

function modelGeneration(modelId: string): { family: string; major: number; minor: number } | undefined {
  const match = /claude-([a-z]+)-(\d+)(?:-(\d+))?/.exec(modelId.toLowerCase());
  if (match === null) return undefined;
  const family = match[1]!;
  if (!SAMPLING_REJECTING_FAMILIES.includes(family)) return undefined;
  return { family, major: Number(match[2]), minor: Number(match[3] ?? 0) };
}

/** True when the model rejects `temperature`/`top_p`/`top_k` at any thinking setting. */
function rejectsSamplingParams(modelId: string): boolean {
  const generation = modelGeneration(modelId);
  if (generation === undefined) return false;
  // Opus turns strict at 4.7; the other families at 5.0.
  return generation.family === "opus"
    ? generation.major > 4 || (generation.major === 4 && generation.minor >= 7)
    : generation.major >= 5;
}

/**
 * Confirmed quirks only.
 *
 * `anthropic`/`claude` carry the sampling-parameter row because both reach the
 * same Messages wire; `claude` (OAuth) is a distinct provider id from
 * `anthropic` (API key), and the deprecation is a model fact, not a
 * credential fact, so it applies to both.
 */
const PARAM_QUIRKS: readonly ParamQuirk[] = [
  {
    provider: "github",
    // Copilot Auto resolves a concrete model before dispatch; the model's 400
    // confirms that the selected-model request must not carry temperature.
    stripControls: ["temperature"],
  },
  {
    provider: "anthropic",
    matchModel: rejectsSamplingParams,
    stripControls: ["temperature", "top_p", "top_k"],
  },
  {
    provider: "claude",
    matchModel: rejectsSamplingParams,
    stripControls: ["temperature", "top_p", "top_k"],
  },
];

/** Finds the first quirk matching the provider/model pair, or undefined. */
function findParamQuirk(
  providerId: string,
  modelId: string,
): ParamQuirk | undefined {
  return PARAM_QUIRKS.find((quirk) => {
    if (quirk.provider !== providerId) return false;
    const matcher = quirk.matchModel;
    if (matcher === undefined) return true;
    return typeof matcher === "function" ? matcher(modelId) : matcher.test(modelId);
  });
}

/**
 * Applies the provider/model quirks to a canonical request, returning the
 * original reference when nothing matched (callers can compare identity).
 */
export function applyParamQuirks(
  request: CanonicalRequest,
  providerId: string,
): CanonicalRequest {
  const quirk = findParamQuirk(providerId, request.model);
  // The thinking-sampling strip is universal, not quirk-gated: extended
  // thinking rejects temperature/top_p/top_k on every Messages-wire upstream.
  // It runs before the early return below so a provider with no PARAM_QUIRKS
  // row still gets it — otherwise a strict upstream takes a 400 the strip
  // exists to prevent. Declarative rows still apply after.

  let controls = request.generation_controls;
  let changed = false;

  if (quirk?.stripControls !== undefined && quirk.stripControls.length > 0) {
    controls = { ...controls };
    for (const key of quirk.stripControls) {
      if (key in controls) {
        delete controls[key];
        changed = true;
      }
    }
  }

  // Extended thinking rejects sampling controls upstream. The stripped set is
  // owned by capabilities.ts (shared with the Messages payload builder, which
  // applies the same rule at translation time) — the quirks table itself
  // keeps only its declarative temperature row.
  if (isThinkingEnabled(request)) {
    for (const key of THINKING_STRIPPED_SAMPLING_CONTROLS) {
      if (key in controls) {
        if (!changed) controls = { ...controls };
        delete controls[key];
        changed = true;
      }
    }
  }

  if (quirk?.clampMaxOutput !== undefined) {
    const limit = quirk.clampMaxOutput;
    if (typeof controls.max_tokens === "number" && controls.max_tokens > limit) {
      if (!changed) controls = { ...controls };
      controls = { ...controls, max_tokens: limit };
      changed = true;
    }
  }

  return changed ? { ...request, generation_controls: controls } : request;
}
