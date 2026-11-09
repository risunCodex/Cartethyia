/**
 * Shared helpers for the native dispatch handlers (web search, token count,
 * System One, responses-compact, generation). The handlers previously spelled
 * the same credential-resolution, outbound-fetch, body-validation, thinking-
 * suffix, response-serialization, and usage-clone blocks by hand, and the
 * copies could drift (generation's `jsonResponse` lost the `cache-control`
 * header). One home here keeps them in step.
 */
import { GatewayError } from "../../protocol/gateway-error";
import type { ProviderId, ResolvedCredential, ValidatedOutboundFetch } from "../../providers/provider-contracts";
import { resolveCredentialForAccount } from "../../providers/operations/provider-credential-service";
import { repriceUsage, usageFromProvider } from "../../providers/provider-usage";
import type { UsageRecord } from "../../protocol/canonical-model";
import { parseThinkingSuffix } from "../../protocol/translation/thinking";
import type { GatewayHandlerDeps } from "./handler-deps";

/**
 * Whether a scope list contains the named scope. The native handlers used to
 * force `scopes?.includes(name as never)` — a type-loop hole that bypassed
 * the `AccessScope` union only to compare runtime strings. The check is the
 * same, with a real `readonly string[]` receiver.
 */
export function hasScope(scopes: readonly string[] | undefined, name: string): boolean {
  return scopes?.includes(name) === true;
}

/**
 * Resolves the credential for one candidate: a real account credential when
 * the candidate carries an account, otherwise the credential-less `"none"`
 * credential. Shared by every native handler's `prepare`.
 */
export async function resolveAttemptCredential(
  deps: Pick<GatewayHandlerDeps, "db" | "oauthRefreshService" | "resolveOAuthRefresher">,
  candidate: { readonly provider_id: string; readonly provider_account_id?: string },
): Promise<ResolvedCredential> {
  if (!candidate.provider_account_id) {
    return {
      provider_id: candidate.provider_id as ProviderId,
      credential_kind: "none" as const,
    };
  }
  return resolveCredentialForAccount(
    deps.db,
    candidate.provider_id,
    candidate.provider_account_id,
    deps.oauthRefreshService && deps.resolveOAuthRefresher
      ? { refreshService: deps.oauthRefreshService, resolveRefresher: deps.resolveOAuthRefresher }
      : undefined,
  );
}

/** The outbound-fetch context fragment native handlers spread into the dispatch context. */
export function networkFetchContext(
  deps: { readonly networkBindingFactory?: GatewayHandlerDeps["networkBindingFactory"] },
  poolId: string | undefined,
  tenantId: string | null,
): { outbound_fetch?: ValidatedOutboundFetch } {
  if (!deps.networkBindingFactory) return {};
  return { outbound_fetch: deps.networkBindingFactory.fetch(poolId, tenantId ?? undefined) };
}

/** Serializes a JSON payload with the shared native-response header set. */
export function jsonResponse(payload: unknown, status: number, requestId: string): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "x-request-id": requestId,
    },
  });
}

/**
 * Forwards an upstream response body verbatim with the shared native-response
 * header set.
 *
 * The native handlers (System One, responses-compact, token-count,
 * generation's passThrough) each spelled the same three headers by hand; the
 * copies drifted at least once (generation's JSON builder lost `cache-control`).
 * Status and body come from the upstream untouched; only the content-type
 * default differs per route (SSE vs JSON) and is passed per call.
 */
export function forwardUpstreamResponse(
  response: Response,
  requestId: string,
  defaultContentType = "application/json",
): Response {
  return new Response(response.body, {
    status: response.status,
    headers: {
      "content-type": response.headers.get("content-type") ?? defaultContentType,
      "cache-control": "no-store",
      "x-request-id": requestId,
    },
  });
}

/**
 * Strips a thinking suffix (`model(high)`) from the model name and rebuilds
 * the body with the bare model when it changed. Returns the bare model and
 * the body to forward upstream.
 */
export function stripThinkingSuffix(
  model: string,
  body: Record<string, unknown>,
): { bareModel: string; body: Record<string, unknown> } {
  const { model: bareModel } = parseThinkingSuffix(model);
  return { bareModel, body: bareModel === model ? body : { ...body, model: bareModel } };
}

/**
 * Validates the ingress body is a non-null object and returns it as a record.
 * Throws the standard `invalid_request` with the caller's message (kept
 * per-route so the wire text is unchanged).
 */
export function requireRecordBody(
  state: { readonly authorization?: unknown; readonly ingressBody?: unknown },
  message: string,
): Record<string, unknown> {
  const { authorization, ingressBody } = state;
  if (!authorization || ingressBody === null || typeof ingressBody !== "object" || Array.isArray(ingressBody))
    throw new GatewayError("invalid_request", 400, message);
  return ingressBody as Record<string, unknown>;
}

/**
 * Reads usage from an upstream response clone, repricing the reported value (or
 * the caller's estimate) for the routed provider/model. Shared by the native
 * handlers that proxy an upstream JSON body verbatim.
 */
export async function usageFromUpstreamClone(
  response: Response,
  estimate: UsageRecord,
  providerId: string,
  modelId: string,
): Promise<UsageRecord> {
  let reportedUsage: ReturnType<typeof usageFromProvider>;
  try {
    const parsed: unknown = await response.clone().json();
    reportedUsage = usageFromProvider(
      typeof parsed === "object" && parsed !== null
        ? (parsed as Record<string, unknown>)["usage"]
        : undefined,
    );
  } catch {
    reportedUsage = undefined;
  }
  return repriceUsage(reportedUsage ?? estimate, providerId, modelId);
}


