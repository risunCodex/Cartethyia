// Cursor model catalog: the static offline floor plus the live per-account
// roster.
//
// The static floor is the fixed-settings trio every plan can run —
// live-verified 2026-11-17: `auto` (the account's default route) and the two
// included Grok variants. On the free plan every other variant refuses at Run
// time ("Model unavailable on Free … with fixed settings").
//
// Live discovery advertises the account's FULL roster, unfiltered: the
// upstream cannot separate models by plan (`GetUsableModels` lists the whole
// catalog regardless of membership), so a paid account's long tail is real
// entitlement and must stay visible. The Run is the authoritative gate — a
// plan-refused model fails with its own, actionable error.
//
// Nothing here invents a capability: `vision` is true because every model the
// Run wire serves today accepts image input, `reasoning` is true because
// every probed route produces reasoning deltas (auto reasons internally — its
// effort has no caller-facing parameter), and output is stated explicitly so
// admission does not reserve the whole context window as headroom.
import { defineModel, type ModelDefinition } from "../../provider-model-definition";
import { fetchCursorDiscovery, type CursorModelRoute } from "./cursor-discovery";
import { CURSOR_RUN_PATH } from "./cursor-wire";

function cursorModel(
  modelId: string,
  ctx?: number,
  options: { vision?: boolean; reasoning?: boolean; out?: number } = {},
): ModelDefinition {
  return defineModel({
    id: modelId,
    providerId: "cursor",
    wireFamily: "chat",
    endpoint: CURSOR_RUN_PATH,
    ...(ctx === undefined ? {} : { ctx }),
    ...(options.out === undefined ? {} : { out: options.out }),
    // Tools are served through Cursor's MCP exec channel, which the adapter
    // answers for every request that declares tools — so the row advertises
    // them and the adapter relays everything the caller declared.
    toolCall: true,
    vision: options.vision ?? true,
    reasoning: options.reasoning ?? false,
  });
}

/**
 * Static fallback catalog for Cursor.
 *
 * `auto` is the only id surfaced for Cursor's Auto model: the upstream wire id
 * is `default` and the two are the same model, not two entries, so seeding the
 * upstream id as well would list the same model twice. Dispatch maps `auto`
 * onto the account's discovered default route.
 */
export const CURSOR_MODELS: readonly ModelDefinition[] = [
  cursorModel("auto", 200_000, { vision: true, reasoning: true, out: 64_000 }),
  cursorModel("cursor-grok-4.6-medium", 256_000, { vision: true, reasoning: true, out: 64_000 }),
  cursorModel("grok-4.7-medium", 256_000, { vision: true, reasoning: true, out: 64_000 }),
];

/** One discovered route as a catalog row. */
function cursorRouteModel(route: CursorModelRoute): ModelDefinition {
  return cursorModel(route.routeId, route.contextTokens, {
    vision: true,
    reasoning: true,
    out: 64_000,
  });
}

export interface CursorDiscoveryInput {
  readonly credential: string;
  readonly fetcher?: typeof fetch;
}

/**
 * Live discovery: the account's full roster as catalog rows, unfiltered.
 *
 * Every discovered route is listed — the roster is the truth for the account,
 * and an entitlement gap should be visible rather than silently shrunken
 * (the upstream cannot separate models by plan; the Run's own refusal is the
 * gate). `null` on failure: the registry falls back to {@link CURSOR_MODELS}
 * so one unreachable account cannot fail a whole catalog refresh.
 */
export async function discoverCursorModels(
  input: CursorDiscoveryInput,
): Promise<readonly ModelDefinition[] | null> {
  const fetcher = input.fetcher ?? globalThis.fetch;
  if (input.credential.trim().length === 0) return null;
  try {
    const discovery = await fetchCursorDiscovery(input.credential, fetcher);
    if (discovery.routes.length === 0) return null;
    return discovery.routes.map(cursorRouteModel);
  } catch {
    return null;
  }
}
