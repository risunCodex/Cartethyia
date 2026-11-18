// dynamic-import-ok: lazy provider registry helpers. Every discovery builder
// below returns a closure that runs `await import("<integration module>")`
// on first use, so a provider's module graph is evaluated only when a request
// routes to it; static imports here would drag every integration into memory
// at process start.
import {
  GENERIC_API_KEY_SPECS,
  createApiKeyAdapter,
  type ApiKeyProviderSpec,
} from "../configured-provider";
import type { ProviderDispatchContext } from "../provider-contracts";
import type { ProviderModelDiscovery } from "../discovery/discovery-types";
import { createAnthropicCompatibleAdapter } from "../integrations/anthropic";
import type { QoderRealm } from "../integrations/qoder/qoder-realm";
import type { TraeRealm } from "../integrations/trae/trae-realm";
import { providerBaseUrl } from "../provider-metadata";
import type { ProviderModuleCapabilities } from "../provider-registry";
import type { CanonicalRequest, WireFamily } from "../../protocol/canonical-model";

export function configuredProvider(
  providerId: keyof typeof GENERIC_API_KEY_SPECS,
  loadModels?: ProviderModuleCapabilities["loadModels"],
): ProviderModuleCapabilities {
  return {
    loadAdapter: async () => createApiKeyAdapter(GENERIC_API_KEY_SPECS[providerId]),
    ...(loadModels === undefined ? {} : { loadModels }),
  };
}

/**
 * Extracts a bearer token from a JSON credential object when the stored secret
 * is a JSON account export, falling back to the raw secret otherwise. Several
 * discovery paths accept both a bare token and a JSON export, and each used to
 * re-implement this same parse + key-pick; this keeps the reading in one place.
 *
 * Preserves the exact fallback semantics: an unparseable secret, or a JSON
 * object with none of the recognized token keys, yields the raw secret.
 */
export function extractJsonCredentialToken(secret: string): string {
  if (!secret.startsWith("{")) return secret;
  try {
    const parsed = JSON.parse(secret) as Record<string, unknown>;
    const found = ["accessToken", "access_token", "token"].find(
      (key) => typeof parsed[key] === "string" && (parsed[key] as string).length > 0,
    );
    if (found !== undefined) return parsed[found] as string;
  } catch {
    // Use the raw secret as the token.
  }
  return secret;
}

/**
 * Trae model discovery for one realm.
 *
 * The listing is per account region: it answers on CN and on the intl region
 * host that serves the account. This returns the static roster when the live
 * call yields nothing, rather than raising, so one unsupported account cannot
 * fail the whole catalog refresh.
 */
export function traeDiscovery(
  realm: TraeRealm,
  providerId: string,
): NonNullable<ProviderModuleCapabilities["loadModelDiscovery"]> {
  return async () => async (request: Parameters<ProviderModelDiscovery>[0]) => {
    const { discoverTraeModels } = await import("../integrations/trae/trae");
    const { TRAE_INTL_MODELS, TRAE_CN_MODELS } = await import("../integrations/trae/trae-catalog");
    const secret = request.credential.trim();
    const fetcher = request.fetcher as unknown as typeof fetch | undefined;
    if (secret.length === 0 || fetcher === undefined) {
      return realm === "cn" ? TRAE_CN_MODELS : TRAE_INTL_MODELS;
    }
    const token = extractJsonCredentialToken(secret);
    const region = request.authState?.["region"];
    const rows = await discoverTraeModels({
      realm,
      token,
      uid: request.authState?.["accountId"] as string | undefined ?? "",
      fetcher,
      providerId,
      ...(typeof region === "string" ? { region } : {}),
    });
    if (rows.length === 0) return realm === "cn" ? TRAE_CN_MODELS : TRAE_INTL_MODELS;
    const fallback = realm === "cn" ? TRAE_CN_MODELS : TRAE_INTL_MODELS;
    const byId = new Map(fallback.map((model) => [model.modelId, model]));
    // Return everything the upstream picker reports — the live listing is the
    // truth for the account, including configs absent from the static roster.
    // The static roster is only the fallback when discovery fails. A config
    // discovered upstream gets the realm's first row as a template so it is
    // routable with the shape this provider serves, carrying the window
    // upstream reported.
    return rows.map((row) => {
      const existing = byId.get(row.id);
      if (existing === undefined) {
        const template = fallback[0];
        if (template === undefined) return undefined;
        return { ...template, modelId: row.id, contextLimit: row.ctx ?? null };
      }
      return row.ctx === undefined ? existing : { ...existing, contextLimit: row.ctx };
    }).filter((model): model is NonNullable<typeof model> => model !== undefined);
  };
}

/**
 * Qoder model discovery for one realm.
 *
 * A single live call, `get_quota_config` on the account's `x-openapi-auth` JWT,
 * returns per-model `model_config` and per-bucket `quota_config`. Both realms
 * answer the same shape, just on their own gateway hosts.
 */
export function qoderDiscovery(
  realm: QoderRealm,
  providerId: string,
): NonNullable<ProviderModuleCapabilities["loadModelDiscovery"]> {
  return async () => async (request: Parameters<ProviderModelDiscovery>[0]) => {
    const { discoverQoderModels } = await import("../integrations/qoder/qoder-catalog");
    const { resolveQoderAuth, qoderSignerFor, qoderEncodeBody } = await import("../integrations/qoder/qoder");
    const secret = request.credential.trim();
    if (secret.length === 0) throw new Error("Qoder credential is required");
    const fetcher = request.fetcher as unknown as typeof fetch | undefined;
    // The discovery context carries only the secret plus the non-secret
    // `authState` an OAuth login persisted; the account id lives there too, so
    // an OAuth credential resolves to the same identity dispatch would use.
    const auth = await resolveQoderAuth({
      secret,
      authState: request.authState,
      signal: AbortSignal.timeout(15_000),
      fetcher: (url: string, init: RequestInit) => (fetcher ?? globalThis.fetch)(url, init),
    });
    const signer = qoderSignerFor(auth);
    return discoverQoderModels({
      realm,
      providerId,
      credential: secret,
      headers: (url: string, body: string) => Promise.resolve(signer(url, body)),
      ...(fetcher === undefined ? {} : { fetcher }),
      encode: qoderEncodeBody,
    });
  };
}


export function openAIModelDiscovery(
  providerId: string,
  options?: {
    readonly transformBaseUrl?: (baseUrl: string) => string;
    readonly headers?: (credential: string) => Readonly<Record<string, string>>;
  },
): () => Promise<ProviderModelDiscovery> {
  return async () => async ({ baseUrl, credential, fetcher }) => {
    const { fetchOpenAICompatibleModels } = await import("../discovery/openai-model-discovery");
    return fetchOpenAICompatibleModels({
      baseUrl: options?.transformBaseUrl?.(baseUrl) ?? baseUrl,
      providerId,
      ...(options?.headers ? { headers: options.headers(credential) } : {}),
      ...(fetcher ? { fetcher } : {}),
    });
  };
}

/**
 * Joins every system part into one, for providers whose chat template rejects
 * more than one system message.
 *
 * Qwen Portal answers a 500 from its default template when a request carries
 * several system blocks, so the parts are merged before serialization rather
 * than after — the split happens in `canonicalToChatPayload`, below this hook,
 * so coalescing the request is the only seam that reaches it.
 *
 * Non-text parts are dropped rather than stringified: they carry data the chat
 * wire has no representation for, and this provider's chat surface does not
 * accept them. A single part is returned untouched, so a request that was
 * already well-formed is byte-identical to what it would have been.
 */
export function coalesceSystemParts(request: CanonicalRequest): CanonicalRequest {
  const parts = request.system ?? [];
  if (parts.length < 2) return request;
  const text = parts
    .map((part) => (part.kind === "text" ? part.text : ""))
    .filter((value) => value.length > 0);
  if (text.length === 0) return { ...request, system: [] };
  if (text.length === 1) return { ...request, system: [{ kind: "text", text: text[0]! }] };
  return { ...request, system: [{ kind: "text", text: text.join("\n\n") }] };
}

/**
 * An Anthropic-Messages provider authenticated with a plain key.
 *
 * Discovery is the one wrinkle: the dispatch base carries the `/anthropic`
 * root, and `/v1/models` is published at the host root above it, so the
 * discovery call strips the suffix rather than asking the Messages surface for
 * a listing it does not serve. Without the strip every model lookup 404s and the
 * provider lists nothing.
 */
export function anthropicWireProvider(
  providerId: "minimax" | "minimaxcode" | "minimaxcodecn" | "umans",
): ProviderModuleCapabilities {
  return {
    endpointPathsByWireFamily: { messages: "/v1/messages" },
    loadAdapter: async () =>
      createAnthropicCompatibleAdapter({
        provider_id: providerId,
        base_url: providerBaseUrl(providerId),
      }),
    loadModelDiscovery: openAIModelDiscovery(providerId, {
      transformBaseUrl: (baseUrl) => baseUrl.replace(/\/anthropic$/, ""),
      headers: (credential) => ({
        "x-api-key": credential,
        "anthropic-version": "2023-06-01",
      }),
    }),
  };
}

/**
 * The registry map form of a spec's endpoint paths, or nothing when the spec
 * declares none. `exactOptionalPropertyTypes` forbids assigning `undefined` to
 * an optional property, so the spread is the way to say "omit this key".
 */
export function endpointPathsOf(spec: ApiKeyProviderSpec): {
  endpointPathsByWireFamily?: Readonly<Partial<Record<WireFamily, string>>>;
} {
  return spec.endpoint_paths_by_wire_family === undefined
    ? {}
    : { endpointPathsByWireFamily: spec.endpoint_paths_by_wire_family };
}

/**
 * The CoreWeave project this account is bound to, or `undefined` when it has
 * none.
 *
 * Reads `auth_state` first because that is where the console persists it when
 * an account is created, then falls back to the account's custom headers so an
 * operator who set the header on the account instead still dispatches. A
 * missing value is not an error here: the upstream answers 401 with a message
 * naming the header, and failing closed here with our own prose would replace
 * a precise upstream answer with a vaguer one.
 */
export function readCoreWeaveProject(context: ProviderDispatchContext): string | undefined {
  const fromAuthState = context.credential.auth_state?.["coreweaveProject"];
  if (typeof fromAuthState === "string" && fromAuthState.trim().length > 0) {
    return fromAuthState.trim();
  }
  const fromHeaders = context.credential.custom_headers?.["openai-project"];
  return typeof fromHeaders === "string" && fromHeaders.trim().length > 0
    ? fromHeaders.trim()
    : undefined;
}
