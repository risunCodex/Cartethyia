// Qoder virtual models.
//
// Qoder's roster keys are opaque slots (`dfmodel`, `cmodel`, `smodel`) rather
// than model names, so what the UI offers and what a caller would ask for are
// two different vocabularies. A virtual id is the caller-facing name; it
// resolves to a roster key before the request is built.
//
// This mirrors the Copilot Auto seam: a virtual id is a catalog row that
// dispatch rewrites to a real `model_id` before the upstream call. The mapping
// is deliberately static — Qoder publishes no endpoint that resolves a name to
// a slot the way Copilot's `/auto` does, so there is nothing to ask at runtime.

/** A virtual id and the roster key it stands for. */
export interface QoderVirtualModel {
  /** The id a caller sends and the catalog publishes. */
  readonly id: string;
  /** The roster key actually dispatched upstream. */
  readonly target: string;
  /** Name shown where a human picks a model. */
  readonly displayName: string;
  /**
   * Tier/limit overrides for a virtual row whose upstream slot reports
   * different numbers than the caller-facing card should show. `lite` is a
   * free plan package over `qmodel` (Qwen3.7-Plus): same model, smaller
   * output ceiling, free tier, and the full multimodal input set.
   */
  readonly free?: boolean;
  readonly outputLimit?: number;
  readonly vision?: boolean;
}

/**
 * Virtual ids for every Qoder slot.
 *
 * `target` values are roster keys, so a virtual id is only valid while that key
 * stays in the realm's roster. Discovery replaces the roster, and rows it drops
 * would leave a virtual id pointing at nothing — dispatch surfaces that as an
 * explicit error rather than sending an unknown key upstream.
 */
export const QODER_VIRTUAL_MODELS: readonly QoderVirtualModel[] = [
  { id: "deepseek-v4.1-flash", target: "dfmodel", displayName: "DeepSeek-V4.1-Flash" },
  { id: "deepseek-v4-pro", target: "dmodel", displayName: "DeepSeek-V4-Pro" },
  { id: "cantus", target: "cmodel", displayName: "Cantus" },
  { id: "sonus", target: "smodel", displayName: "Sonus" },
  { id: "qwen3.8-max", target: "qmodel_38max", displayName: "Qwen3.8-Max" },
  { id: "qwen3.8-flash", target: "qfmodel", displayName: "Qwen3.8-Flash" },
  { id: "qwen3.7-max", target: "qmodel_latest", displayName: "Qwen3.7-Max" },
  { id: "qwen3.7-plus", target: "qmodel", displayName: "Qwen3.7-Plus" },
  { id: "kimi-k3", target: "kmodel_latest", displayName: "Kimi-K3.1-Pro" },
  { id: "kimi-k2.8-preview", target: "kmodel", displayName: "Kimi-K2.8-Preview" },
  { id: "glm-5.3", target: "gmodel", displayName: "GLM-5.3" },
  { id: "glm-5.3-flash", target: "gfmodel", displayName: "GLM-5.3-Flash" },
  { id: "minimax-m3", target: "mmodel", displayName: "MiniMax-M3.1-Flash" },
  // `lite` is the free-tier plan package over `qmodel` (Qwen3.7-Plus):
  // same 1M window and multimodal input, capped at 64k output, free tier.
  { id: "lite-qwen-3.7-plus", target: "lite", displayName: "Lite-Qwen-3.7-Plus", free: true, outputLimit: 65536, vision: true },
];

/** Virtual id → roster key. */
const VIRTUAL_TARGETS: ReadonlyMap<string, string> = new Map(
  QODER_VIRTUAL_MODELS.map((entry) => [entry.id, entry.target]),
);

/** Roster key → virtual id, for labelling a discovered row. */
const VIRTUAL_BY_TARGET: ReadonlyMap<string, string> = new Map(
  QODER_VIRTUAL_MODELS.map((entry) => [entry.target, entry.id]),
);

/**
 * Resolves a caller-supplied model id to the roster key to dispatch.
 *
 * A non-virtual id is returned unchanged, so every existing caller and every
 * discovered row keeps working: this is a translation of the new vocabulary,
 * not a gate on the old one.
 */
export function qoderDispatchModelId(modelId: string): string {
  const trimmed = modelId.trim();
  return VIRTUAL_TARGETS.get(trimmed) ?? trimmed;
}

/** True when the id is a virtual name rather than a roster key. */
export function isQoderVirtualModel(modelId: string): boolean {
  return VIRTUAL_TARGETS.has(modelId.trim());
}

/** The virtual name for a roster key, when one exists. */
export function qoderVirtualIdFor(target: string): string | undefined {
  return VIRTUAL_BY_TARGET.get(target.trim());
}
