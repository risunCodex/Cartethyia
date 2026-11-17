/**
 * Cursor model discovery: the three RPCs that describe what an account can
 * run, and the model-id pairing rule that keeps `BAD_MODEL_NAME` away.
 *
 * Cursor answers three unary Connect RPCs, issued in parallel:
 *
 * - `GetUsableModels` — the account-usable roster (`agent.v1.ModelDetails`),
 *   i.e. the legacy slugs a Run's `model_details.model_id` accepts.
 * - `AvailableModels` — the rich catalog: one row per family with
 *   `ModelVariantConfig` entries carrying the exact parameter tuple
 *   (effort/thinking/fast/context), the variant's `legacy_slug`, and max-mode
 *   markers. The request pins `use_model_parameters` so variants arrive as
 *   parameters instead of exploded ids.
 * - `GetDefaultModelForCli` — the account's default (`auto`) model.
 *
 * **The id pairing rule** (encoded in {@link resolveCursorModelPair}): a Run
 * request carries TWO model identities and they must not be the same string.
 * `model_details.model_id` is the variant's `legacy_slug` — the only shape the
 * account's roster accepts. `requested_model.model_id` is the rich base id
 * (`ModelDetails.name`) plus the variant's parameter tuple and max-mode flag.
 * Sending the base id in both fields answers `BAD_MODEL_NAME` (error 5);
 * sending an OpenAI-style effort sibling in both answers resource exhaustion
 * (errorId 528384). The pair is therefore built from the variant row, never
 * from a folded or aliased id.
 */
import type { FetchLike } from "../../authentication/oauth-client";
import {
  AUTH_REQUEST_TIMEOUT_MS,
  CURSOR_API_BASE_URL,
  CURSOR_AVAILABLE_MODELS_PATH,
  CURSOR_GET_DEFAULT_MODEL_PATH,
  CURSOR_GET_USABLE_MODELS_PATH,
  cursorClientHeaders,
} from "./cursor-wire";
import { decodeMessage, encodeMessage } from "./cursor-protocol/messages";
import { stripConnectEnvelope } from "../shared/connect";
import type {
  AvailableModelsResponse,
  AvailableModelsResponse_ModelDetails,
  AvailableModelsResponse_ModelVariantConfig,
  GetDefaultModelForCliResponse,
  GetUsableModelsResponse,
  ModelParameterValue,
} from "./cursor-protocol/generated";

/** Context window assumed when neither the catalog nor the name says otherwise. */
export const CURSOR_DEFAULT_CONTEXT_TOKENS = 200_000;
/** Long-context label seen in display names ("Claude Opus 5.5 1M"). */
const ONE_M_LABEL = /(?:^|\s)1M(?:\s|$)/;

/** One routable model: exactly the pair a Run request must carry. */
export interface CursorModelRoute {
  /**
   * The id this route is listed under (the variant's legacy slug — the shape
   * `cursor-agent models` prints and the account's roster accepts).
   */
  readonly routeId: string;
  /** `model_details.model_id`: the account-usable legacy slug. */
  readonly legacySlug: string;
  /** `requested_model.model_id`: the rich base id (catalog row name). */
  readonly wireModelId: string;
  /** `requested_model.parameters`: the variant's string parameter tuple. */
  readonly parameters: ReadonlyArray<{ readonly id: string; readonly value: string }>;
  /** `requested_model.max_mode`. */
  readonly maxMode: boolean;
  /** Display name (variant display name when present, else the family name). */
  readonly displayName: string;
  /** Context window in tokens (1M rows recovered from the display-name label). */
  readonly contextTokens: number;
  /** True when `GetUsableModels` lists this route's legacy slug for the account. */
  readonly accountUsable: boolean;
  /** True when this is the account's default (`auto`) model. */
  readonly isDefault: boolean;
}

/** The two model identities a Run request carries, in wire shape. */
export interface CursorModelPair {
  /** For `AgentRunRequest.model_details.model_id` (plus display ids). */
  readonly modelDetails: { readonly modelId: string };
  /**
   * For `AgentRunRequest.requested_model`. The three fields a Run must carry
   * are stated non-optional: the builder always sets them, and callers should
   * not have to defend against a pair that forgot its own model id.
   */
  readonly requestedModel: {
    readonly modelId: string;
    readonly maxMode: boolean;
    readonly parameters: ReadonlyArray<{ readonly id: string; readonly value: string }>;
  };
}

/**
 * Builds the Run-request identity pair for one route.
 *
 * This is the only sanctioned way to produce the pair: the legacy slug goes to
 * `model_details`, the rich base id + parameter tuple + max-mode flag go to
 * `requested_model`. Reusing one string for both is the upstream's
 * `BAD_MODEL_NAME`/errorId-528384 trap.
 */
export function resolveCursorModelPair(route: CursorModelRoute): CursorModelPair {
  return {
    modelDetails: { modelId: route.legacySlug },
    requestedModel: {
      modelId: route.wireModelId,
      maxMode: route.maxMode,
      parameters: route.parameters.map((p) => ({ id: p.id, value: p.value })),
    },
  };
}

// ── unary Connect plumbing ──

type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

async function fetchCursorUnary<T>(
  fetchFn: FetchFn,
  path: string,
  requestType: string,
  responseType: string,
  body: Record<string, unknown>,
  accessToken: string,
): Promise<T> {
  const payload = Buffer.from(encodeMessage(requestType, body));
  const response = await fetchFn(`${CURSOR_API_BASE_URL}${path}`, {
    method: "POST",
    headers: {
      ...cursorClientHeaders(accessToken, { contentType: "application/proto" }),
      "connect-protocol-version": "1",
      "x-request-id": crypto.randomUUID(),
    },
    body: payload,
    signal: AbortSignal.timeout(AUTH_REQUEST_TIMEOUT_MS),
  });
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!response.ok) {
    const text = new TextDecoder().decode(bytes.subarray(0, 200));
    throw new Error(`Cursor ${path} failed (${response.status}): ${text}`);
  }
  return decodeMessage<T>(responseType, stripConnectEnvelope(bytes));
}

// ── route assembly ──

function contextTokensFor(model: AvailableModelsResponse_ModelDetails): number {
  if (typeof model.contextTokenLimit === "number" && model.contextTokenLimit > 0) {
    return model.contextTokenLimit;
  }
  // 1M-context recovery: some rows carry no `context_token_limit` and the
  // display-name label is the only signal ("Claude Opus 5.5 1M").
  const label = model.clientDisplayName ?? model.name ?? "";
  return ONE_M_LABEL.test(label) ? 1_000_000 : CURSOR_DEFAULT_CONTEXT_TOKENS;
}

function variantParameters(
  variant: AvailableModelsResponse_ModelVariantConfig,
): Array<{ id: string; value: string }> {
  const parameters: Array<{ id: string; value: string }> = [];
  for (const p of variant.parameterValues ?? []) {
    const id = p.id?.trim();
    const value = p.value?.trim();
    if (id && value !== undefined && value !== "") parameters.push({ id, value });
  }
  return parameters;
}

function routesFromAvailableModels(
  response: AvailableModelsResponse,
  usableSlugs: ReadonlySet<string>,
  defaultWireId: string | undefined,
): CursorModelRoute[] {
  const routes: CursorModelRoute[] = [];
  for (const model of response.models ?? []) {
    const wireModelId = model.name?.trim();
    if (!wireModelId) continue;
    const contextTokens = contextTokensFor(model);
    const variants = model.variants ?? [];
    if (variants.length === 0) {
      // A catalog row without variants is its own route.
      const slug = model.legacySlugs?.[0] ?? wireModelId;
      routes.push({
        routeId: slug,
        legacySlug: slug,
        wireModelId,
        parameters: [],
        maxMode: false,
        displayName: model.clientDisplayName ?? wireModelId,
        contextTokens,
        accountUsable: usableSlugs.has(slug),
        isDefault: wireModelId === defaultWireId,
      });
      continue;
    }
    for (const variant of variants) {
      const slug = variant.legacySlug?.trim();
      if (!slug) continue; // a variant with no legacy slug cannot be requested
      routes.push({
        routeId: slug,
        legacySlug: slug,
        wireModelId,
        parameters: variantParameters(variant),
        maxMode: variant.isMaxMode === true,
        displayName: variant.displayName?.trim() || model.clientDisplayName?.trim() || wireModelId,
        contextTokens,
        accountUsable: usableSlugs.has(slug),
        isDefault: wireModelId === defaultWireId,
      });
    }
  }
  return routes;
}

/** The three-RPC answer, assembled into routes plus the account's default. */
export interface CursorDiscoveryResult {
  readonly routes: CursorModelRoute[];
  /** The account's default (`auto`) route when it can be identified. */
  readonly defaultRoute: CursorModelRoute | undefined;
  /** Display name of the account's default model, for the `auto` alias. */
  readonly defaultDisplayName: string | undefined;
  /**
   * The slugs `GetUsableModels` lists for THIS account, verbatim — the
   * entitlement signal the Run actually enforces (a plan can include a
   * family with fixed settings while every parameterized variant refuses).
   */
  readonly usableSlugs: readonly string[];
}

/**
 * Fetches the account's model roster.
 *
 * The three RPCs are independent and issued in parallel; `GetUsableModels`
 * and `GetDefaultModelForCli` refine the rich catalog rather than gating it —
 * a route the account cannot use is still listed (`accountUsable: false`) so
 * callers can see entitlement gaps instead of a silently shrunken roster.
 */
export async function fetchCursorDiscovery(
  accessToken: string,
  fetchFn: FetchLike,
): Promise<CursorDiscoveryResult> {
  const fetchImpl = fetchFn as FetchFn;
  const [usable, available, fallback] = await Promise.all([
    fetchCursorUnary<GetUsableModelsResponse>(
      fetchImpl,
      CURSOR_GET_USABLE_MODELS_PATH,
      "agent.v1.GetUsableModelsRequest",
      "agent.v1.GetUsableModelsResponse",
      {},
      accessToken,
    ),
    fetchCursorUnary<AvailableModelsResponse>(
      fetchImpl,
      CURSOR_AVAILABLE_MODELS_PATH,
      "aiserver.v1.AvailableModelsRequest",
      "aiserver.v1.AvailableModelsResponse",
      {
        includeLongContextModels: true,
        useModelParameters: true,
        doNotUseMarkdown: true,
        useCloudAgentEffortModes: true,
      },
      accessToken,
    ),
    fetchCursorUnary<GetDefaultModelForCliResponse>(
      fetchImpl,
      CURSOR_GET_DEFAULT_MODEL_PATH,
      "agent.v1.GetDefaultModelForCliRequest",
      "agent.v1.GetDefaultModelForCliResponse",
      {},
      accessToken,
    ).catch(() => undefined), // the default is an enrichment, not a requirement
  ]);

  const usableSlugs = new Set<string>();
  for (const model of usable.models ?? []) {
    const slug = model.modelId?.trim();
    if (slug) usableSlugs.add(slug);
    for (const alias of model.aliases ?? []) {
      const trimmed = alias.trim();
      if (trimmed) usableSlugs.add(trimmed);
    }
  }

  const defaultWireId = fallback?.model?.modelId?.trim();
  const routes = routesFromAvailableModels(available, usableSlugs, defaultWireId);

  let defaultRoute = routes.find((r) => r.isDefault);
  if (defaultRoute === undefined && defaultWireId) {
    defaultRoute = routes.find((r) => r.wireModelId === defaultWireId);
  }
  return {
    routes,
    defaultRoute,
    defaultDisplayName: fallback?.model?.displayName?.trim(),
    usableSlugs: [...usableSlugs],
  };
}

export type { AvailableModelsResponse_ModelVariantConfig, ModelParameterValue };
