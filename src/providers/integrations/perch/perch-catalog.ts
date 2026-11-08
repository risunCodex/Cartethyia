// Perch model roster.
//
// Perch's hosted model layer ("Roost") exposes tier labels rather than raw
// model ids: `standard` and `standard 1m` are the tiers included in the free
// Starter plan — the only tiers this provider serves. The official CLI
// accepts these as `--model` values (`perch run --model standard ...`).
// Context windows are the client's own published claims; the actual model
// behind a tier is hidden ("never reveal underlying model names") and may
// vary per task — so no reasoning/toolCall capability claims are made here
// beyond what the tier surfaces guarantee (chat text).
//
// Probe evidence (2026-11-08, Starter account): `standard` and
// `standard 1m` answer. Paid tiers are deliberately absent from the roster:
// the Starter account cannot serve them, and hitting them is what gets an
// account suspended.

import { defineModel, type ModelDefinition } from "../../provider-model-definition";
import {
  PERCH_CONTEXT_STANDARD,
  PERCH_CONTEXT_STANDARD_1M,
  PERCH_PROVIDER_ID,
} from "./perch-realm";

interface PerchRow {
  readonly id: string;
  readonly displayName: string;
  readonly ctx: number;
}

const PERCH_ROWS: readonly PerchRow[] = [
  { id: "standard", displayName: "Roost Standard", ctx: PERCH_CONTEXT_STANDARD },
  { id: "standard 1m", displayName: "Roost Standard 1M", ctx: PERCH_CONTEXT_STANDARD_1M },
];

/**
 * Output cap per model, mirroring the CLI's own resolution (`sUr` in the
 * bundled `perch.mjs`): up to 8k context → 4096, up to 32k → 8192, above
 * 32k → 32768. Derive per model from its context window, never hardcode.
 */
function perchOutputTokens(contextWindow: number): number {
  if (contextWindow <= 8_000) return 4_096;
  if (contextWindow <= 32_000) return 8_192;
  return 32_768;
}

export const PERCH_MODELS: readonly ModelDefinition[] = PERCH_ROWS.map((row) =>
  defineModel({
    id: row.id,
    providerId: PERCH_PROVIDER_ID,
    wireFamily: "chat",
    endpoint: "/api/perch-terminal/model-call",
    ctx: row.ctx,
    out: perchOutputTokens(row.ctx),
    // The tier surfaces are chat-text; no modality claims beyond that. No
    // `free`/`freeTier` flag is set: the upstream does not expose a
    // per-model plan list (cli-plan only reports planRequired), and a free
    // claim would be an unverified assertion rather than upstream truth.
    vision: false,
    reasoning: false,
    toolCall: false,
  }),
);
