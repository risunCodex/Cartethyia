// Free-pi model roster.
//
// The live roster is server-driven: `GET /client-version` returns the full
// model list (`models[]`, with `section` and `tier`). The static roster here
// is only the fallback when that call fails, mirroring the Trae pattern. All
// rows use the chat completions wire.
//
// Capability/funding facts (from the live 2026-11-08 sweep on a GitHub
// account): the four "Free Unlimited" rows (particle, deepseek-v4.1-flash,
// glm-5.3-flash, deepseek-v4-flash) stream for everyone; everything else is
// either premium (billed from the allowance) or defense (section "defense").
// Context is 200k and output 8k per the client bundle; these are the client's
// own claims, not upstream model truth.

import { defineModel, type ModelDefinition } from "../../provider-model-definition";
import {
  FREEPI_CHAT_PATH,
  FREEPI_CONTEXT_WINDOW,
  FREEPI_MAX_OUTPUT_TOKENS,
  FREEPI_PROVIDER_ID,
} from "./freepi-realm";

interface FreepiRow {
  readonly id: string;
  readonly displayName: string;
  readonly free?: boolean;
  readonly proOnly?: boolean;
}

const FREEPI_ROWS: readonly FreepiRow[] = [
  // Only the "Free Unlimited" rows ship in the static roster: they are the
  // ones the live sweep confirmed stream for every account type (guest +
  // GitHub). Paid/defense rows are left to live discovery, which keeps the
  // whole catalog; the fallback must never advertise a model the account
  // cannot serve.
  { id: "deepseek-v4.1-flash", displayName: "DeepSeek V4.1 Flash", free: true },
  { id: "glm-5.3-flash", displayName: "GLM 5.3 Flash", free: true },
  { id: "particle", displayName: "Particle · Free Unlimited", free: true },
];

export const FREEPI_MODELS: readonly ModelDefinition[] = FREEPI_ROWS.map((row) =>
  defineModel({
    id: row.id,
    providerId: FREEPI_PROVIDER_ID,
    wireFamily: "chat",
    endpoint: FREEPI_CHAT_PATH,
    ctx: FREEPI_CONTEXT_WINDOW,
    out: FREEPI_MAX_OUTPUT_TOKENS,
    // No vision/audio/document claims: the upstream `/client-version` catalog
    // publishes only id/name/section/tier, and the live sweep verified text
    // completions but no other modality. Everything streamed reasoning
    // content, and the agent wire carries tools, so reasoning + toolCall are
    // the only declared capabilities.
    vision: false,
    reasoning: true,
    toolCall: true,
    ...(row.free ? { free: true, freeTier: true } : {}),
    ...(row.proOnly ? { proOnly: true } : {}),
  }),
);
