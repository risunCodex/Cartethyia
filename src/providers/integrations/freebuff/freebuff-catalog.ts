// Freebuff static model catalog — TypeScript, Freebuff provider.
//
// Live catalog snapshot (2026-11-09, account risunCode_alt): 13 rows, keyed
// `m-<hex>`, with the server-published `contextWindow`, `multimodal`, and
// reasoning `efforts` taken verbatim from the live listing. The wire id
// (provider/model) is NOT the catalog key — routing sends the catalog handle
// (`fbm1.*`) which is resolved per dispatch from a fresh catalog fetch (see
// freebuff.ts `resolveCatalogHandle`). These rows describe the model set for
// admission/probing/UI; the actual dispatch model id is the `m-<hex>` key
// resolved through discovery.
//
// Rows with `access: "locked"` / premium require a plan (proOnly); open rows
// are the free tier. `contextWindow` is the server's own number (1M for
// DeepSeek-class, 500k Solar, 256k small, 100k Haiku).
//
// The published catalog is virtual-first: every `m-<hex>` key has a caller-
// facing name (see `freebuff-virtual.ts`), so the rows the UI offers and a
// caller types are the readable names, exactly like Qoder's virtual rows. The
// raw `m-<hex>` roster stays as the internal floor that virtual rows inherit
// limits and capabilities from.

import { defineModel, type ModelHelperRow } from "../../provider-model-definition";
import { FREEBUFF_CHAT_COMPLETIONS_PATH } from "./freebuff";
import { FREEBUFF_VIRTUAL_MODELS, freebuffVirtualIdFor } from "./freebuff-virtual";

const CHAT = FREEBUFF_CHAT_COMPLETIONS_PATH;

function fbModel(options: {
  readonly id: string;
  readonly ctx: number;
  readonly vision?: boolean;
  readonly reasoning?: boolean;
  readonly reasoningEfforts?: readonly string[];
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
    ctx: options.ctx,
    out: options.ctx > 131_072 ? 32_000 : 8_192,
    ...(options.vision !== undefined ? { vision: options.vision } : {}),
    ...(options.reasoning !== undefined ? { reasoning: options.reasoning } : {}),
    ...(options.reasoningEfforts !== undefined ? { reasoningEfforts: options.reasoningEfforts } : {}),
    ...(options.toolCall !== undefined ? { toolCall: options.toolCall } : {}),
    ...(options.free !== undefined ? { free: options.free } : {}),
    ...(options.freeTier !== undefined ? { freeTier: options.freeTier } : {}),
    ...(options.proOnly !== undefined ? { proOnly: options.proOnly } : {}),
  };
  return defineModel(row);
}

/** Raw `m-<hex>` roster floor seeded from the live catalog (13 rows, real context windows). */
const FREEBUFF_ROSTER: readonly ReturnType<typeof defineModel>[] = [
  fbModel({ id: "m-096e75164d", ctx: 1_048_576, vision: true, reasoning: true, reasoningEfforts: ["low", "high", "max"], toolCall: true, free: true, freeTier: true }),            // DeepSeek Fast
  fbModel({ id: "m-8db1ccbba6", ctx: 1_048_576, vision: true, reasoning: true, reasoningEfforts: ["low", "high"], toolCall: true, free: true, freeTier: true }),            // DeepSeek
  fbModel({ id: "m-61c26317cc", ctx: 1_048_576, vision: true, reasoning: true, toolCall: true, free: true, freeTier: true }),            // DeepSeek Slow
  fbModel({ id: "m-127314bb39", ctx: 1_048_576, vision: true, reasoning: true, reasoningEfforts: ["low", "high", "max"], toolCall: true, proOnly: true }),         // DeepSeek V4.1 Flash Fast (premium)
  fbModel({ id: "m-5a5d0e255e", ctx: 1_000_000, vision: true, reasoning: true, reasoningEfforts: ["low", "medium", "high", "xhigh"], toolCall: true, proOnly: true }),         // GPT-6 Luna (premium)
  fbModel({ id: "m-9a7e098cc1", ctx: 500_000, reasoning: true, toolCall: true, free: true, freeTier: true }),            // Solar Pro 4 (price 0)
  fbModel({ id: "m-69307952f8", ctx: 500_000, reasoning: true, toolCall: true, free: true, freeTier: true }),            // Solar Mini 4 (price 0)
  fbModel({ id: "m-ffcbc2bcf3", ctx: 1_000_000, reasoning: true, reasoningEfforts: ["low", "medium", "high"], toolCall: true, proOnly: true }),         // Muse Spark 1.3 (plan-locked)
  fbModel({ id: "m-7d6e1b3ae0", ctx: 1_000_000, vision: true, reasoning: true, reasoningEfforts: ["low", "medium", "high"], toolCall: true, proOnly: true }),         // GPT-6.1 Terra (premium)
  fbModel({ id: "m-0921d81ce7", ctx: 1_048_576, reasoning: true, toolCall: true, free: true, freeTier: true }),            // Crouton Alpha (price 0)
  fbModel({ id: "m-02244092cb", ctx: 256_000, reasoning: true, toolCall: true, free: true, freeTier: true }),            // Glyph Cluster (price 0)
  fbModel({ id: "m-ddc687c50f", ctx: 256_000, reasoning: true, toolCall: true, free: true, freeTier: true }),            // Nemotron 3.5 Lightning (price 0)
  fbModel({ id: "m-5b6a604eb6", ctx: 100_000, vision: true, reasoning: true, reasoningEfforts: ["low", "medium", "high"], toolCall: true, proOnly: true }),         // Claude Haiku 5.5 · 100k (premium)
];

/**
 * Virtual rows, one per roster key that has a caller-facing name.
 *
 * A virtual row inherits its target's limits and capabilities rather than
 * restating them: the two ids are the same upstream model, so a window, a
 * vision flag, or a tier that disagreed between them would be a lie in one of
 * the two places.
 */
function freebuffVirtualModels(
  roster: readonly ReturnType<typeof defineModel>[],
): readonly ReturnType<typeof defineModel>[] {
  const byId = new Map(roster.map((row) => [row.modelId, row]));
  const rows: ReturnType<typeof defineModel>[] = [];
  for (const virtual of FREEBUFF_VIRTUAL_MODELS) {
    const target = byId.get(virtual.target);
    if (target === undefined) continue;
    rows.push(
      fbModel({
        id: virtual.id,
        ctx: target.contextLimit ?? 0,
        ...(target.modalities.input.includes("image") ? { vision: true } : {}),
        reasoning: target.reasoning,
        ...(target.reasoningEfforts !== undefined ? { reasoningEfforts: target.reasoningEfforts } : {}),
        toolCall: target.toolCall,
        ...(target.freeTier === true ? { free: true, freeTier: true } : {}),
        ...(target.proOnly === true ? { proOnly: true } : {}),
      }),
    );
  }
  return rows;
}

/**
 * Static offline catalog.
 *
 * A roster key that has a caller-facing name is published under that name
 * only: upstream's keys are opaque (`m-<hex>`), and offering both the key and
 * its name shows one model twice under two ids nobody can tell apart. A key
 * with no known name is kept as-is — an unnamed slot is still reachable, and
 * inventing a name for it would assert what upstream never stated.
 *
 * The key remains what dispatch sends; see `freebuff-virtual.ts`.
 */
export const FREEBUFF_MODELS: readonly ReturnType<typeof defineModel>[] = [
  ...FREEBUFF_ROSTER.filter((row) => freebuffVirtualIdFor(row.modelId) === undefined),
  ...freebuffVirtualModels(FREEBUFF_ROSTER),
];
