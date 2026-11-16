/**
 * Outbound fetch plumbing for probe execution.
 *
 * `ProbeRunner` and `ProbeDiscovery` share these adapters: a validated
 * outbound fetch (or a bidirectional HTTP/2 binding) reshaped into the
 * `FetchLike` surface discovery helpers expect. Kept separate so neither
 * engine imports the other's internals.
 */
import type { FetchLike } from "../quota/quota-contracts";
import type {
  ValidatedOutboundFetch,
  ValidatedOutboundHttp2Bidi,
} from "../provider-contracts";

export interface ProbeOutboundBinding {
  readonly fetch: ValidatedOutboundFetch;
  /**
   * Validated bidirectional HTTP/2 egress for the same pool/tenant. A provider
   * whose only transport is a bidi stream (a Connect-RPC run) has no
   * `fetch` path to fall back to, so a probe without this binding reports a
   * healthy account as broken.
   */
  readonly http2Bidi?: ValidatedOutboundHttp2Bidi;
  readonly networkPoolId?: string;
  readonly release?: () => void;
}

export type ProbeOutboundResolver = (
  tenantId: string,
  providerId?: string,
) => Promise<ValidatedOutboundFetch | ProbeOutboundBinding> | ValidatedOutboundFetch | ProbeOutboundBinding;

/**
 * Adapts a validated outbound fetch to the `FetchLike` shape discovery
 * helpers expect. Only the call signature is consumed downstream.
 */
export function asFetchLike(fetchFn: ValidatedOutboundFetch): FetchLike {
  const wrapped = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
    fetchFn(input, init);
  return Object.assign(wrapped, { preconnect: () => undefined });
}

export function asOutboundBinding(
  resolved: ValidatedOutboundFetch | ProbeOutboundBinding,
): ProbeOutboundBinding {
  return typeof resolved === "function" ? { fetch: resolved } : resolved;
}
