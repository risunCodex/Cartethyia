// Zro provider integration — TypeScript, Zro (moonmath).
//
// Zro exposes three wire formats: OpenAI Chat (`/v1/chat/completions`),
// OpenAI Responses (`/v1/responses`), and Anthropic Messages
// (`/v1/messages`). Claude Code talks to it through the Messages wire with a
// plain `Authorization: Bearer sk-...` key (no `x-api-key`, no CLI
// fingerprint) — verified live 2026-11-09 that the Anthropic envelope +
// bearer auth answers 200, and that the full Claude Code header set
// (`anthropic-version`, Stainless identity, official user-agent) is accepted
// but not required. Every model is served over Messages in this integration,
// matching how the provider's own Claude Code docs route traffic.
//
// Quota: Zro publishes no billing/quota endpoint (all probe guesses 404).
// The entitlement surface is `GET /v1/models` itself — a key only sees the
// models it is allowed to call (verified: a key with 3 models got 403
// `user_model_access_denied` for a 4th), and an invalid key answers 401 there.
// The quota collector probes that same `/v1/models` surface, and model
// discovery owns the entitlement truth.

import { assertCredentialKind, assertWireFamily } from "../../provider-contracts";
import type { ProviderAdapter, ProviderDispatchContext, ProviderDispatchTarget } from "../../provider-contracts";
import type { ModelDefinition } from "../../provider-model-definition";
import { defineModel } from "../../provider-model-definition";
import type { ProviderModelDiscovery } from "../../discovery/discovery-types";
import type { FetchLike, ProviderQuotaResult } from "../../quota/quota-contracts";
import type { CanonicalEvent, CanonicalRequest } from "../../../protocol/canonical-model";
import { GatewayError } from "../../../protocol/gateway-error";
import { applyParamQuirks } from "../../../protocol/translation/quirks";
import { buildClaudeMessagesRequest, filterClaudeCustomHeaders } from "../shared/claude-messages";
import { sendClaudeMessagesRequest } from "../../../protocol/upstream/send-claude-messages";

export const ZRO_PROVIDER_ID = "zro" as const;
export const ZRO_BASE_URL = "https://zro.moonmath.ai";

/**
 * Offline fallback for the models this key is entitled to, used when the live
 * `/v1/models` read fails or returns nothing. The three rows are exactly the
 * reachable set of the probe key (each also carries a `zro/` alias on the
 * wire); a live read may show more or fewer and replaces this seed entirely.
 */
const ZRO_MODELS_RAW: readonly {
  id: string;
  contextLimit: number;
  outputLimit: number;
}[] = [
  { id: "deepseek-v4-flash-0731", contextLimit: 1_048_576, outputLimit: 64_000 },
  { id: "deepseek-v4.1-flash", contextLimit: 1_048_576, outputLimit: 64_000 },
] as const;

export const ZRO_MODELS: readonly ModelDefinition[] = ZRO_MODELS_RAW.map((row) =>
  defineModel({
    id: row.id,
    providerId: ZRO_PROVIDER_ID,
    wireFamily: "messages",
    // The Messages wire root is `/v1/messages` on Zro's host, not the
    // family-conventional `/messages` path `defineModel` would otherwise pick.
    endpoint: "/v1/messages",
    ctx: row.contextLimit,
    out: row.outputLimit,
    vision: false,
    reasoning: true,
    toolCall: true,
    // The reachable rows are the free-limited allowance this key can call; the
    // dashboard groups them under "Free models (auto)".
    freeTier: true,
  }),
);

/**
 * Zro model discovery. The live `/v1/models` list is the *entitlement*
 * surface: it returns only the models a key may call (verified live
 * 2026-11-09 — a key with 3 models got 403 for a 4th; the public `/models`
 * catalog without the `/v1` prefix lists everything, including models the key
 * is refused). The `/v1` prefix is therefore mandatory. Each row appears
 * twice on the wire (bare id + `zro/` alias); the alias is folded onto the
 * bare id. Every listed row is forced onto the Messages wire, mirroring the
 * offline catalog.
 */
export function zroModelDiscovery(): () => Promise<ProviderModelDiscovery> {
  return async () => async (input) => {
    const { fetchOpenAICompatibleModels } = await import("../../discovery/openai-model-discovery");
    const base = input.baseUrl.replace(/\/+$/, "");
    const models = await fetchOpenAICompatibleModels({
      // `/v1` is the entitlement surface; the bare `/models` path is the
      // public full catalog and would advertise models the key cannot call.
      baseUrl: `${base}/v1`,
      providerId: ZRO_PROVIDER_ID,
      headers: { authorization: `Bearer ${input.credential}` },
      ...(input.fetcher ? { fetcher: input.fetcher } : {}),
    });
    const source: readonly ModelDefinition[] =
      models === null || models.length === 0 ? ZRO_MODELS : models;
    const byId = new Map<string, ModelDefinition>();
    for (const model of source) {
      const raw = model.modelId;
      const bare = raw.toLowerCase().startsWith("zro/") ? raw.slice("zro/".length) : raw;
      byId.set(bare, { ...model, modelId: bare });
    }
    return [...byId.values()].map((model) => ({
      ...model,
      wireFamily: "messages" as const,
      endpointPath: "/v1/messages",
      // The `/v1/models` list is by definition the set this key may call on
      // the free-limited allowance, so every discovered row is free-tier.
      freeTier: true,
    }));
  };
}

/**
 * Messages-wire adapter. Same Claude pipeline as the plain Anthropic adapter,
 * but Zro authenticates with a Bearer key instead of `x-api-key` — the same
 * shape as InferHub's Claude leg.
 */
export class ZroMessagesAdapter implements ProviderAdapter {
  readonly provider_id = ZRO_PROVIDER_ID;
  private readonly fetchFn: typeof fetch;
  private readonly baseUrl: string;

  constructor(fetchImpl?: typeof fetch, baseUrl?: string) {
    this.fetchFn = fetchImpl ?? globalThis.fetch;
    this.baseUrl = (baseUrl ?? ZRO_BASE_URL).replace(/\/+$/, "");
  }

  async *dispatch(
    request: CanonicalRequest,
    candidate: ProviderDispatchTarget,
    context: ProviderDispatchContext,
  ): AsyncIterable<CanonicalEvent> {
    if (candidate.wire_family !== "messages") {
      assertWireFamily(candidate, "messages", "zro messages leg");
    }
    if (context.credential.credential_kind !== "api_key") {
      assertCredentialKind(context.credential, "api_key", "zro");
    }
    if (context.credential.secret === undefined || context.credential.secret.length === 0) {
      throw new GatewayError(
        "invalid_request",
        400,
        "zro: API key is missing a secret value (request {requestId}). Wrong key, right door — check the key 🔑",
      );
    }
    const apiKey = new TextDecoder().decode(context.credential.secret);
    const customHeaders = filterClaudeCustomHeaders({
      ...context.credential.custom_headers,
    });
    const outbound = buildClaudeMessagesRequest({
      request: applyParamQuirks(request, candidate.provider_id),
      authHeader: "bearer",
      credential: { secret: apiKey, customHeaders },
      baseUrl: this.baseUrl,
      endpointPath: candidate.endpoint_path,
    });
    yield* sendClaudeMessagesRequest(
      outbound.url,
      outbound.headers,
      outbound.body,
      context,
      request,
      this.fetchFn,
    );
  }
}

export function createZroAdapter(fetchImpl?: typeof fetch): ProviderAdapter {
  return new ZroMessagesAdapter(fetchImpl);
}

/**
 * Zro quota collector. Zro publishes no billing/quota endpoint; the
 * entitlement surface is `GET /v1/models` — a key only sees the models it may
 * call, and an invalid key answers 401/403 (verified live 2026-11-09). The
 * bare `/models` path is the public full catalog and does NOT authenticate, so
 * the `/v1` prefix is mandatory here.
 */
export async function fetchZroQuota(
  credential: string,
  fetcher: FetchLike,
): Promise<ProviderQuotaResult> {
  const fetchFn = fetcher ?? globalThis.fetch;
  let response: Response;
  try {
    response = await fetchFn(`${ZRO_BASE_URL}/v1/models`, {
      headers: { accept: "application/json", authorization: `Bearer ${credential.trim()}` },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    return {
      source: ZRO_PROVIDER_ID,
      plan: null,
      windows: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
  if (response.status === 401 || response.status === 403) {
    return { source: ZRO_PROVIDER_ID, plan: null, windows: [], error: "API key is invalid or revoked." };
  }
  if (!response.ok) {
    return { source: ZRO_PROVIDER_ID, plan: null, windows: [], error: `Connectivity check failed: HTTP ${response.status}.` };
  }
  await response.text().catch(() => "");
  return { source: ZRO_PROVIDER_ID, plan: "limited", windows: [], error: null };
}
