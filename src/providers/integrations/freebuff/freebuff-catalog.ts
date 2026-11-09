// Freebuff static model catalog — TypeScript, Freebuff provider.
//
// Live catalog snapshot (2026-11-09, account risunCode_alt): 13 rows, keyed
// `m-<hex>`. The wire id (provider/model) is NOT the catalog key — routing
// sends the catalog handle (`fbm1.*`) which is resolved per dispatch from a
// fresh catalog fetch (see freebuff.ts `resolveCatalogHandle`). These rows
// describe the model set for admission/probing/UI; the actual dispatch model id
// is the `m-<hex>` key resolved through discovery.
//
// Rows with `access: "locked"` / premium require a plan (proOnly); open rows
// are the free tier.

import { defineModel, type ModelHelperRow } from "../../provider-model-definition";
import { FREEBUFF_CHAT_COMPLETIONS_PATH } from "./freebuff";

const CHAT = FREEBUFF_CHAT_COMPLETIONS_PATH;

function fbModel(options: {
  readonly id: string;
  readonly ctx?: number;
  readonly out?: number;
  readonly vision?: boolean;
  readonly reasoning?: boolean;
  readonly toolCall?: boolean;
  readonly free?: boolean;
  readonly freeTier?: boolean;
  readonly proOnly?: boolean;
}): ReturnType<typeof defineModel> {
  const row: ModelHelperRow = {
    id: options.id,
    providerId: "freebuff",
    wireFamily: "chat",
    endpoint: CHAT,
    ...(options.ctx !== undefined ? { ctx: options.ctx } : {}),
    ...(options.out !== undefined ? { out: options.out } : {}),
    ...(options.vision !== undefined ? { vision: options.vision } : {}),
    ...(options.reasoning !== undefined ? { reasoning: options.reasoning } : {}),
    ...(options.toolCall !== undefined ? { toolCall: options.toolCall } : {}),
    ...(options.free !== undefined ? { free: options.free } : {}),
    ...(options.freeTier !== undefined ? { freeTier: options.freeTier } : {}),
    ...(options.proOnly !== undefined ? { proOnly: options.proOnly } : {}),
  };
  return defineModel(row);
}

/** Static floor seeded from the live catalog (13 rows). */
export const FREEBUFF_MODELS: readonly ReturnType<typeof defineModel>[] = [
  fbModel({ id: "m-096e75164d", ctx: 131_072, out: 8_192, reasoning: true, toolCall: true, free: true, freeTier: true }),            // DeepSeek Fast
  fbModel({ id: "m-8db1ccbba6", ctx: 131_072, out: 8_192, reasoning: true, toolCall: true, free: true, freeTier: true }),            // DeepSeek
  fbModel({ id: "m-61c26317cc", ctx: 131_072, out: 8_192, reasoning: true, toolCall: true, free: true, freeTier: true }),            // DeepSeek Slow
  fbModel({ id: "m-127314bb39", ctx: 131_072, out: 8_192, reasoning: true, toolCall: true, proOnly: true }),         // DeepSeek V4.1 Flash Fast (premium)
  fbModel({ id: "m-5a5d0e255e", ctx: 131_072, out: 8_192, reasoning: true, toolCall: true, proOnly: true }),         // GPT-6 Luna (premium)
  fbModel({ id: "m-9a7e098cc1", ctx: 131_072, out: 8_192, reasoning: true, toolCall: true, free: true, freeTier: true }),            // Solar Pro 4 (price 0)
  fbModel({ id: "m-69307952f8", ctx: 131_072, out: 8_192, reasoning: true, toolCall: true, free: true, freeTier: true }),            // Solar Mini 4 (price 0)
  fbModel({ id: "m-ffcbc2bcf3", ctx: 131_072, out: 8_192, reasoning: true, toolCall: true, proOnly: true }),         // Muse Spark 1.3 (plan-locked)
  fbModel({ id: "m-7d6e1b3ae0", ctx: 131_072, out: 8_192, reasoning: true, toolCall: true, proOnly: true }),         // GPT-6.1 Terra (premium)
  fbModel({ id: "m-0921d81ce7", ctx: 131_072, out: 8_192, reasoning: true, toolCall: true, free: true, freeTier: true }),            // Crouton Alpha (price 0)
  fbModel({ id: "m-02244092cb", ctx: 131_072, out: 8_192, reasoning: true, toolCall: true, free: true, freeTier: true }),            // Glyph Cluster (price 0)
  fbModel({ id: "m-ddc687c50f", ctx: 131_072, out: 8_192, reasoning: true, toolCall: true, free: true, freeTier: true }),            // Nemotron 3.5 Lightning (price 0)
  fbModel({ id: "m-5b6a604eb6", ctx: 131_072, out: 8_192, reasoning: true, toolCall: true, proOnly: true }),         // Claude Haiku 5.5 · 100k (premium)
];
