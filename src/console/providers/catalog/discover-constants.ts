/**
 * Pure discovery constants, kept free of any `node:*` imports so the
 * dashboard can import them without dragging Node crypto into the browser
 * bundle — the same reason `ban-constants.ts` and `usage-dimensions.ts` exist.
 */
export const DISCOVER_MODEL_COMMIT_MAX = 100;
