/**
 * The free tier shared by the OpenRouter-backed providers.
 *
 * Cline, Kilo Code and OpenRouter serve one model catalog, and every id below
 * was verified to exist under `openrouter`, `kilo` and `cline` — so this
 * roster is a catalog fact, not a per-provider guess, and it lives in one
 * place rather than being restated three times. Dropping a row here unlists
 * it from all three providers' seeded catalog at the next boot; live
 * discovery will still find it, which is the intended prune.
 *
 * The limits, modalities and capability flags are read from OpenRouter's own
 * `/api/v1/models`, which states `context_length`,
 * `top_provider.max_completion_tokens`, `architecture.input_modalities` and
 * `supported_parameters`. That is the serving catalog's declaration, so these
 * are measurements rather than defaults.
 *
 * The set is curated: a 2.6B toy (`liquid/lfm-2.5-2.6b:free`) and the
 * upstream content-safety classifier (`nvidia/nemotron-3.5-content-safety:free`)
 * are deliberately not seeded — a prefill classifier is not a chat model.
 *
 * This is a floor, not the authority: each provider also discovers live, and a
 * row the listing carries that this roster does not is still found there. The
 * roster exists so a fresh install has a usable free tier before any fetch, and
 * so the free section is populated even when discovery is unavailable.
 */
import { defineModel } from "../provider-model-definition";
import type { ModelDefinition } from "../provider-model-definition";

export interface FreeRosterOptions {
  readonly providerId: string;
  /** The wire suffix that completes the provider's base URL. */
  readonly endpoint: string;
}

interface FreeRow {
  readonly id: string;
  readonly ctx: number;
  readonly out: number;
  readonly vision?: boolean;
  /** `false` only when `supported_parameters` omits `tools`. */
  readonly toolCall?: boolean;
}

/**
 * The shared `:free` ids still worth seeding, with the limits the catalog
 * states for each.
 *
 * Every row declares `reasoning`: `supported_parameters` lists it on every
 * entry. `toolCall` is `true` unless stated otherwise, because a row that
 * advertises tools must keep them — a false `toolCall` makes the preflight
 * strip `tools` from the request, which is a wrong capability rather than a
 * conservative one.
 */
const FREE_ROWS: readonly FreeRow[] = [
  { id: "cohere/north-mini-code:free", ctx: 256_000, out: 64_000 },
  { id: "dots-studio/dots-3-note-preview:free", ctx: 512_000, out: 460_800, vision: true },
  {
    id: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
    ctx: 256_000,
    out: 65_536,
    vision: true,
  },
  { id: "nvidia/nemotron-3-ultra-550b-a55b:free", ctx: 1_000_000, out: 65_536 },
  { id: "nvidia/nemotron-3.5-lightning:free", ctx: 1_000_000, out: 65_536 },
  { id: "nvidia/nemotron-3.5-super-vl:free", ctx: 1_000_000, out: 131_072, vision: true },
  // Last verified against OpenRouter's `/api/v1/models` 2026-11-18. All four
  // declare `tools` and reasoning in `supported_parameters`; `vision` mirrors
  // `architecture.input_modalities`.
  { id: "baidu/ernie-5.5-flash-preview:free", ctx: 1_024_000, out: 921_600 },
  { id: "inclusionai/ling-3.2-flash:free", ctx: 1_048_576, out: 262_144, vision: true },
  { id: "particle-ai/particle-1:free", ctx: 1_048_576, out: 131_072, vision: true },
  { id: "recursive/flint-v1.0:free", ctx: 262_144, out: 235_929 },
  // Added by operator request (id as spelled on kilo); limits are the roster's
  // common values, pending a re-probe against the serving catalog.
  { id: "reflection/beam-free", ctx: 1_048_576, out: 131_072 },
];

/** Builds this roster for one provider, since each spells its own endpoint. */
export function openrouterFreeRoster(options: FreeRosterOptions): readonly ModelDefinition[] {
  return FREE_ROWS.map((row) =>
    defineModel({
      id: row.id,
      providerId: options.providerId,
      wireFamily: "chat",
      endpoint: options.endpoint,
      ctx: row.ctx,
      out: row.out,
      vision: row.vision ?? false,
      reasoning: true,
      toolCall: row.toolCall ?? true,
      // `free` is the billing statement and `freeTier` the catalog one. The
      // `:free` suffix makes both true, and the model list groups on the tier.
      free: true,
      freeTier: true,
    }),
  );
}
