// Perch model roster.
//
// Perch's hosted model layer ("Roost") exposes tier labels rather than raw
// model ids: `standard` and `standard_max` are the tiers included in the free
// Starter plan. In addition, the plan pins a small "Starter" model pool
// (`PERCH_STARTER_PINS`) whose pins are verified live 2026-11-08:
// `glm-5.3-flash-starter`, `deepseek-flash-starter`, and `crouton-alpha`
// answer 200 and the server reports the pinned backing model; `beam` was not
// verified (turn rate limit). Paid `pro` tiers are deliberately absent.
//
// Model ids here are the gateway-facing ids; the adapter maps them to the
// upstream wire (Roost tier + backing pin) via `PERCH_STARTER_PINS` /
// `roostModelChoice` — the upstream itself hides real model names.

import { defineModel, type ModelDefinition } from "../../provider-model-definition";
import {
  PERCH_CONTEXT_STANDARD,
  PERCH_CONTEXT_STANDARD_1M,
  PERCH_PROVIDER_ID,
  PERCH_STARTER_PINS,
} from "./perch-realm";

interface PerchRow {
  readonly id: string;
  readonly displayName: string;
  readonly ctx: number;
  /**
   * Output ceiling. When absent it falls back to the CLI's `sUr` resolution
   * (`perchOutputTokens`); starter-pool rows carry the client card's own
   * `maxOutputTokens` (2.4.125) so a big request is not clamped below what
   * the upstream actually serves.
   */
  readonly out?: number;
  /** `undefined` = plain Roost tier; else starter-pool pin id. */
  readonly pin?: string;
}

/** Roost tier sent for the plain tier rows (CLI canonical tier ids). */
const TIER_ROOST_TIERS: Readonly<Record<string, string>> = {
  standard: "standard",
  "standard 1m": "standard_max",
};

const PERCH_ROWS: readonly PerchRow[] = [
  { id: "standard", displayName: "Roost Standard", ctx: PERCH_CONTEXT_STANDARD },
  { id: "standard 1m", displayName: "Roost Standard 1M", ctx: PERCH_CONTEXT_STANDARD_1M },
  // Starter-pool pins — context/output per the client's published cards
  // (2.4.125): glm-5.3-flash 1048576, crouton-alpha 1048576 / 943718,
  // beam-1.0 1048576 / 131072, deepseek-v4.1-flash-1017-starter 1048576 /
  // 131072.
  { id: "glm-5.3-flash-starter", displayName: "GLM 5.3 Flash (Starter)", ctx: PERCH_CONTEXT_STANDARD_1M, out: 131_072, pin: "glm-5.3-flash-starter" },
  { id: "deepseek-flash-starter", displayName: "DeepSeek V4.1 Flash 1017 (Starter)", ctx: PERCH_CONTEXT_STANDARD_1M, out: 131_072, pin: "deepseek-flash-starter" },
  { id: "crouton-alpha", displayName: "Crouton Alpha (Stealth)", ctx: PERCH_CONTEXT_STANDARD_1M, out: 943_718, pin: "crouton-alpha" },
  { id: "beam-1.0-starter", displayName: "Beam 1.0 (Starter)", ctx: PERCH_CONTEXT_STANDARD_1M, out: 131_072, pin: "beam-1.0-starter" },
  // Pinned 1M tier: the CLI normalizes `standard 1m` → `standard_max`; the
  // adapter keys `roostModelChoice` off the catalog id so the right tier is
  // sent even though the id is a label.
  { id: "standard 1m", displayName: "Roost Standard 1M", ctx: PERCH_CONTEXT_STANDARD_1M, pin: "standard-max" },
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
    out: row.out ?? perchOutputTokens(row.ctx),
    // The tier surfaces are chat-text; no modality claims beyond that. No
    // `free`/`freeTier` flag is set: the upstream does not expose a
    // per-model plan list (cli-plan only reports planRequired), and a free
    // claim would be an unverified assertion rather than upstream truth.
    vision: false,
    reasoning: false,
    toolCall: false,
  }),
);

/** Model-id → starter pin, for the adapter's dispatch-time lookup. */
export const PERCH_MODEL_PINS: Readonly<Record<string, string | undefined>> = Object.fromEntries(
  PERCH_ROWS.map((row) => [row.id, row.pin]),
);

/** Model-id → Roost tier, for the adapter's dispatch-time lookup. */
export const PERCH_MODEL_ROOST_TIERS: Readonly<Record<string, string>> = Object.fromEntries(
  PERCH_ROWS.map((row) => [
    row.id,
    row.pin === undefined
      ? TIER_ROOST_TIERS[row.id] ?? "standard"
      : row.pin === "standard-max"
        ? "standard_max"
        : PERCH_STARTER_PINS[row.pin]?.roostTier ?? "standard",
  ]),
);
