/**
 * Antigravity live model discovery (`v1internal:fetchAvailableModels`).
 *
 * Split out of `antigravity-protocol.ts`, which re-exports this module's
 * public surface so no importer changes. Imports only the client fingerprint
 * and the tier-suffix vocabulary from the protocol module — a one-way edge.
 */
import { providerBaseUrl } from "../../provider-metadata";
import { defineModel, FREE_TIER_COST, type ModelDefinition } from "../../provider-model-definition";
import { isRecord } from "../../../protocol/codecs";
import {
  antigravityTierSuffix,
  getAntigravityUserAgent,
} from "./antigravity-protocol";

const ANTIGRAVITY_DISCOVERY_PATH = "/v1internal:fetchAvailableModels";
/** Sandbox twin of the production Antigravity host (only the prod host has one). */
export const ANTIGRAVITY_SANDBOX_BASE = "https://daily-cloudcode-pa.sandbox.googleapis.com";
const ANTIGRAVITY_DEFAULT_CONTEXT_WINDOW = 200_000;
const ANTIGRAVITY_DEFAULT_MAX_OUTPUT_TOKENS = 64_000;
const ANTIGRAVITY_GENERATE_PATH = "/v1internal:generateContent";

/** Internal/dead wire ids excluded from the discovered catalog. */
const ANTIGRAVITY_DISCOVERY_DENYLIST: Readonly<Record<string, true>> = {
  chat_20706: true,
  chat_23310: true,
  "gemini-2.5-pro": true,
};

/**
 * Collapses effort-routed wire ids back to their logical catalog id so the
 * console shows one friendly name per effort family. `antigravityWireModelId`
 * is the inverse: it resolves the logical id to a live wire deployment at
 * dispatch time. Unmapped ids are already logical ids and pass through.
 */
export function collapseAntigravityVariant(modelId: string): string {
  if (modelId === "claude-opus-4-6-thinking") return "claude-opus-4-6";
  if (modelId === "gemini-pro-agent") return "gemini-3.1-pro";
  const suffix = antigravityTierSuffix(modelId);
  return suffix === undefined ? modelId : modelId.slice(0, -(suffix.length + 1));
}

interface AntigravityDiscoveryModel {
  readonly displayName?: unknown;
  readonly maxTokens?: unknown;
  readonly maxOutputTokens?: unknown;
  readonly supportsThinking?: unknown;
  readonly supportsImages?: unknown;
  readonly isInternal?: unknown;
}

function positiveAntigravityInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : fallback;
}

function normalizeAntigravityDiscoveryModels(
  value: unknown,
): readonly ModelDefinition[] | null {
  if (!isRecord(value) || !isRecord(value["models"])) return null;
  const byId = new Map<string, ModelDefinition>();
  for (const [wireId, raw] of Object.entries(value["models"])) {
    if (
      ANTIGRAVITY_DISCOVERY_DENYLIST[wireId] === true ||
      !isRecord(raw) ||
      raw["isInternal"] === true
    ) {
      continue;
    }
    const model = raw as AntigravityDiscoveryModel;
    const logicalId = collapseAntigravityVariant(wireId);
    const definition: ModelDefinition = {
      modelId: logicalId,
      wireFamily: "chat",
      endpointPath: ANTIGRAVITY_GENERATE_PATH,
      contextLimit: positiveAntigravityInt(
        model.maxTokens,
        ANTIGRAVITY_DEFAULT_CONTEXT_WINDOW,
      ),
      outputLimit: positiveAntigravityInt(
        model.maxOutputTokens,
        ANTIGRAVITY_DEFAULT_MAX_OUTPUT_TOKENS,
      ),
      modalities: { input: ["text", "image"], output: ["text"] },
      reasoning: model.supportsThinking === true,
      toolCall: true,
      // Antigravity serves its whole catalog on the upstream `free-tier` plan
      // (confirmed by `loadCodeAssist`); live-discovered rows carry the same
      // zero cost and Free Limited marker as the static roster.
      freeTier: true,
      cost: FREE_TIER_COST,
    };
    const existing = byId.get(logicalId);
    if (
      existing === undefined ||
      (definition.contextLimit ?? 0) > (existing.contextLimit ?? 0)
    ) {
      byId.set(logicalId, definition);
    }
  }
  return [...byId.values()].sort((left, right) =>
    left.modelId.localeCompare(right.modelId),
  );
}

/**
 * Fetches and normalizes Antigravity's live model catalog. Returns `null`
 * when the catalog is unreachable so routing keeps serving the static
 * `ANTIGRAVITY_MODELS` fallback.
 */
export async function discoverAntigravityModels(
  accessToken: string,
  options: {
    readonly baseUrl?: string;
    readonly fetcher?: typeof fetch;
    readonly signal?: AbortSignal;
    readonly projectId?: string;
  } = {},
): Promise<readonly ModelDefinition[] | null> {
  const fetcher = options.fetcher ?? fetch;
  const primary = (options.baseUrl ?? providerBaseUrl("antigravity")).replace(
    /\/+$/,
    "",
  );
  for (const endpoint of [primary, ANTIGRAVITY_SANDBOX_BASE]) {
    try {
      const timeoutSignal = AbortSignal.timeout(3_000);
      const signal =
        options.signal === undefined
          ? timeoutSignal
          : AbortSignal.any([options.signal, timeoutSignal]);
      const response = await fetcher(`${endpoint}${ANTIGRAVITY_DISCOVERY_PATH}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
          "user-agent": getAntigravityUserAgent(),
        },
        // The reference client always sends the resolved project
        // (`cloudCodeMainService.js`); the live backend accepts both, but the
        // project is required for billing-gated endpoints.
        body: JSON.stringify(options.projectId === undefined ? {} : { project: options.projectId }),
        signal,
      });
      if (!response.ok) continue;
      const models = normalizeAntigravityDiscoveryModels(
        (await response.json()) as unknown,
      );
      if (models === null) continue;
      // Keep the static websearch row on top of discovered rows: the live
      // catalog does not publish search SKUs, and `/v1/search` needs a
      // `service_kind: "websearch"` row to route.
      return [
        ...models,
        defineModel({
          id: "gemini-2.5-flash",
          providerId: "antigravity",
          serviceKind: "websearch",
          wireFamily: "chat",
          // Empty endpoint — see `ANTIGRAVITY_SEARCH_MODELS`.
          endpoint: "",
          ctx: 1_000_000,
          out: 65_535,
          vision: true,
          reasoning: true,
          toolCall: false,
        }),
      ];
    } catch {
      // Best-effort: a failed live catalog must never break static routing.
    }
  }
  return null;
}
