/**
 * Kilo Code adapter.
 *
 * Kilo Code resells the OpenRouter catalog behind a bearer device token on an
 * OpenAI-compatible chat surface, so this adapter reuses the shared factory for
 * payload translation, transport, and SSE decoding.
 *
 * One thing sits outside the declarative `ApiKeyProviderSpec`: the stored
 * credential is a JSON envelope (`{ accessToken, orgId }`) because the gateway
 * scopes every request to the account's organization and the console stores one
 * opaque string per account. The factory forwards that string as the bearer
 * verbatim, so the envelope is decoded at the auth boundary here — the same
 * arrangement `kimi/kimi.ts` uses for its own envelope credential.
 *
 * The base URL is the completions path itself, because that is the path Kilo
 * Code publishes (`/api/openrouter/chat/completions`) and it is not derivable
 * from an origin plus a wire-family suffix.
 */
import { defineModel } from "../../provider-model-definition";
import { openrouterFreeRoster } from "../../discovery/openrouter-free-roster";
import type { ModelDefinition } from "../../provider-model-definition";
import type { ProviderAdapter, ProviderDispatchContext, ProviderDispatchTarget } from "../../provider-contracts";
import type { CanonicalRequest } from "../../../protocol/canonical-model";
import { OpenAICompatibleAdapter, withBearerAuthentication } from "../../adapters/compatible-adapter";
import { providerBaseUrl } from "../../provider-metadata";
import { decodeKiloCredential } from "../../../security/credential-codec";
import { clineReasoningReplayPrepares } from "../buddy/chat";

export const KILO_PROVIDER_ID = "kilo" as const;
export const KILO_BASE_URL = providerBaseUrl("kilo");

/**
 * Endpoint path recorded on this provider's model rows and used by the adapter.
 *
 * The base URL carries Kilo Code's API prefix (`/api/openrouter`), so this is
 * the wire suffix that completes it — the same split Cline uses for
 * `/api/v1` + `/chat/completions`.
 */
export const KILO_ENDPOINT_PATH = "/chat/completions" as const;

interface KiloModelOptions {
  readonly vision?: boolean;
  readonly document?: boolean;
  readonly audio?: boolean;
  readonly reasoning?: boolean;
  readonly toolCall?: boolean;
}

function kiloModel(
  modelId: string,
  contextLimit: number,
  outputLimit: number,
  options: KiloModelOptions = {},
): ModelDefinition {
  return defineModel({
    id: modelId,
    providerId: KILO_PROVIDER_ID,
    wireFamily: "chat",
    endpoint: KILO_ENDPOINT_PATH,
    ctx: contextLimit,
    out: outputLimit,
    vision: options.vision ?? false,
    document: options.document ?? false,
    audio: options.audio ?? false,
    reasoning: options.reasoning ?? false,
    toolCall: options.toolCall ?? true,
  });
}

/**
 * Static fallback catalog, read from the live `/api/gateway/models` directory.
 *
 * Live discovery replaces this list whenever an account is available, so these
 * rows are the offline floor: the gateway's own routing aliases plus one
 * current model per family it resells. Limits and capability come from the
 * directory entry's own `top_provider` / `architecture` /
 * `supported_parameters` fields rather than from the base catalog, which prices
 * the underlying model and not this reseller's serving.
 */
export const KILO_MODELS: readonly ModelDefinition[] = [
  // Three routers, and nothing else. A committed catalog of specific ids was a
  // snapshot of one afternoon: this provider resells the OpenRouter catalog,
  // which adds and pulls models within days, so discovery is the authority and
  // every hand-kept row outside these drifts out of truth.
  //
  // `kilo-auto/free` bills zero and `kilo-auto/small` bills a fraction of a
  // cent; both route on the provider's own side, so their limits are the
  // window the router may select into rather than one model's.
  kiloModel("kilo-auto/free", 256_000, 32_768, { reasoning: true }),
  kiloModel("kilo-auto/small", 262_144, 32_768, { vision: true, reasoning: true }),
];

/**
 * The shared free roster, spelled for this provider's endpoint.
 *
 * The same 17 `:free` ids Cline and OpenRouter serve, because this is the same
 * catalog behind a different origin. Kept separate from `KILO_MODELS` so the
 * free tier is its own statement: those three rows are routers, these are the
 * zero-cost models, and the model list groups them differently.
 */
export const KILO_FREE_MODELS: readonly ModelDefinition[] = openrouterFreeRoster({
  providerId: KILO_PROVIDER_ID,
  endpoint: KILO_ENDPOINT_PATH,
});

/**
 * Adapter that decodes the credential envelope before the shared pipeline
 * authenticates the request.
 *
 * `prepareHeaders` is corrected rather than rebuilt: every other header the
 * factory contributes (content type, gateway identity, operator custom headers,
 * route user-agent) stays exactly as every other provider gets it.
 */
class KiloAdapter extends OpenAICompatibleAdapter {
  constructor(fetchImpl?: typeof fetch) {
    super(
      withBearerAuthentication({
        provider_id: KILO_PROVIDER_ID,
        base_url: KILO_BASE_URL,
        endpoint_paths_by_wire_family: { chat: KILO_ENDPOINT_PATH },
        prePayload: (payload) => {
          for (const prepare of clineReasoningReplayPrepares) prepare(payload);
        },
        ...(fetchImpl ? { fetchImpl } : {}),
      }),
    );
  }

  protected override async prepareHeaders(
    context: ProviderDispatchContext,
    request: CanonicalRequest,
    candidate: ProviderDispatchTarget,
  ): Promise<Record<string, string>> {
    const headers = await super.prepareHeaders(context, request, candidate);
    const secret = context.credential.secret;
    if (secret === undefined || secret.length === 0) return headers;
    // A credential that does not decode is left as the factory sent it: the
    // request then fails closed at the upstream auth boundary, and the parse
    // error belongs to the credential boundary rather than to this hook.
    let credential: ReturnType<typeof decodeKiloCredential>;
    try {
      credential = decodeKiloCredential(secret);
    } catch {
      return headers;
    }
    headers.authorization = `Bearer ${credential.accessToken}`;
    // The upstream's own header name, not ours: renaming the Cartethyia
    // provider id does not rename a field the upstream reads.
    if (credential.orgId !== undefined) headers["X-Kilocode-OrganizationID"] = credential.orgId;
    return headers;
  }
}

/** Kilo Code provider adapter. */
export const kiloAdapter: ProviderAdapter = new KiloAdapter();

