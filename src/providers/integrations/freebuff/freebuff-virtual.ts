// Freebuff virtual models — TypeScript, Freebuff provider.
//
// Freebuff's roster keys are opaque `m-<hex>` ids (the live catalog's wire
// keys), which is what a caller would have to type and what the UI would list.
// A virtual id is the caller-facing name — "DeepSeek Fast", "Solar Pro 4" —
// that resolves to its `m-<hex>` roster key before the request is built. The
// display name shown in a picker is the virtual id's own label, not the raw key.
//
// This mirrors the Copilot Auto seam and the Qoder virtual model: a virtual id
// is a catalog row that dispatch rewrites to a real `model_id` before the
// upstream call. The mapping is deliberately static — Freebuff publishes no
// endpoint that resolves a name to a key, but every key in the live catalog
// carries a displayName, so the pairing is fixed (snapshot 2026-11-09).

/** A virtual id, the roster key it stands for, and its display name. */
export interface FreebuffVirtualModel {
  /** The id a caller sends and the catalog publishes. */
  readonly id: string;
  /** The `m-<hex>` roster key actually dispatched upstream. */
  readonly target: string;
  /** Name shown where a human picks a model. */
  readonly displayName: string;
}

/**
 * Virtual ids for every Freebuff roster key.
 *
 * `target` values are catalog keys, so a virtual id is only valid while that key
 * stays in the live roster. Discovery replaces the roster, and rows it drops
 * would leave a virtual id pointing at nothing — dispatch surfaces that as an
 * explicit error rather than sending an unknown key upstream.
 */
export const FREEBUFF_VIRTUAL_MODELS: readonly FreebuffVirtualModel[] = [
  { id: "deepseek-fast", target: "m-096e75164d", displayName: "DeepSeek Fast" },
  { id: "deepseek", target: "m-8db1ccbba6", displayName: "DeepSeek" },
  { id: "deepseek-slow", target: "m-61c26317cc", displayName: "DeepSeek Slow" },
  { id: "deepseek-v4.1-flash-fast", target: "m-127314bb39", displayName: "DeepSeek V4.1 Flash Fast" },
  { id: "gpt-6-luna", target: "m-5a5d0e255e", displayName: "GPT-6 Luna" },
  { id: "solar-pro-4", target: "m-9a7e098cc1", displayName: "Solar Pro 4" },
  { id: "solar-mini-4", target: "m-69307952f8", displayName: "Solar Mini 4" },
  { id: "muse-spark-1.3", target: "m-ffcbc2bcf3", displayName: "Muse Spark 1.3" },
  { id: "gpt-6.1-terra", target: "m-7d6e1b3ae0", displayName: "GPT-6.1 Terra" },
  { id: "crouton-alpha", target: "m-0921d81ce7", displayName: "Crouton Alpha" },
  { id: "glyph-cluster", target: "m-02244092cb", displayName: "Glyph Cluster" },
  { id: "nemotron-3.5-lightning", target: "m-ddc687c50f", displayName: "Nemotron 3.5 Lightning" },
  { id: "claude-haiku-5.5", target: "m-5b6a604eb6", displayName: "Claude Haiku 5.5" },
];

/** Virtual id → roster key. */
const VIRTUAL_TARGETS: ReadonlyMap<string, string> = new Map(
  FREEBUFF_VIRTUAL_MODELS.map((entry) => [entry.id, entry.target]),
);

/** Roster key → virtual id, for labelling a discovered row. */
const VIRTUAL_BY_TARGET: ReadonlyMap<string, string> = new Map(
  FREEBUFF_VIRTUAL_MODELS.map((entry) => [entry.target, entry.id]),
);

/** Virtual id → display name. */
const DISPLAY_BY_ID: ReadonlyMap<string, string> = new Map(
  FREEBUFF_VIRTUAL_MODELS.map((entry) => [entry.id, entry.displayName]),
);

/**
 * Resolves a caller-supplied model id to the roster key to dispatch.
 *
 * A non-virtual id is returned unchanged, so every existing caller and every
 * discovered row keeps working: this is a translation of the new vocabulary,
 * not a gate on the old one.
 */
export function freebuffDispatchModelId(modelId: string): string {
  const trimmed = modelId.trim();
  return VIRTUAL_TARGETS.get(trimmed) ?? trimmed;
}

/** True when the id is a virtual name rather than a roster key. */
export function isFreebuffVirtualModel(modelId: string): boolean {
  return VIRTUAL_TARGETS.has(modelId.trim());
}

/** The virtual name for a roster key, when one exists. */
export function freebuffVirtualIdFor(target: string): string | undefined {
  return VIRTUAL_BY_TARGET.get(target.trim());
}

/** The display name for a virtual id, when one exists. */
export function freebuffDisplayNameFor(id: string): string | undefined {
  return DISPLAY_BY_ID.get(id.trim());
}
