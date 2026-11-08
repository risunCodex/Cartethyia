// Provider contracts: adapter boundary, dispatch context, credential shape,
// and provider identifier parsing. Pure types + leaf helpers with no registry
// or resolution state.

import type { CanonicalEvent, CanonicalRequest, WireFamily } from "../protocol/canonical-model";
import { GatewayError } from "../protocol/gateway-error";
import { BUNDLED_PROVIDER_METADATA, type BundledProviderId } from "./provider-metadata";
import type { ValidatedOutboundHttp2Bidi } from "../network/http2-bidi";

/** Closed union of every shipped provider ID. */
export const BUNDLED_PROVIDER_IDS = BUNDLED_PROVIDER_METADATA.map((definition) => definition.id) as readonly BundledProviderId[];

/** Normalized builtin or validated custom provider identifier. */
declare const customProviderIdBrand: unique symbol;
export type CustomProviderId = string & { readonly [customProviderIdBrand]: true };
export type ProviderId = BundledProviderId | CustomProviderId;

/** Credential alternatives supported by the control-plane resolver. */
export type CredentialKind =
  "none" | "api_key" | "oauth" | "scoped_access_token" | "workload_identity";

/** Credential returned by control-plane resolution and consumed by adapters. */
export interface ResolvedCredential {
  readonly provider_id: ProviderId;
  readonly account_id?: string | undefined;
  readonly credential_kind: CredentialKind;
  readonly secret?: Uint8Array | undefined;
  /** Operator-configured outbound headers, filtered by the owning adapter. */
  readonly custom_headers?: Readonly<Record<string, string>> | undefined;
  /**
   * Per-account upstream auth configuration that is not a secret — auth method,
   * region, profile ARN, OAuth client id, token endpoint. Carried beside the
   * secret because the request an adapter builds depends on it and a single
   * opaque credential string cannot express both. Never holds secrets.
   */
  readonly auth_state?: Readonly<Record<string, unknown>> | undefined;
}

export function readCredentialSecret(credential: ResolvedCredential, errorMessage?: string): string {
  const raw = credential.secret ? new TextDecoder().decode(credential.secret).trim() : "";
  if (!raw) {
    throw new GatewayError(
      "authentication_failed",
      401,
      `${errorMessage ?? "Provider credential secret is missing or empty"} (request {requestId}). Wrong key, right door — check the credential 🔑`,
    );
  }
  return raw;
}

/**
 * Asserts a credential is of the required kind, throwing a typed rejection
 * otherwise. Providers disagree on the kind they accept (`oauth` vs
 * `api_key` vs `scoped_access_token`), and each hand-rolled its own check +
 * message. This centralizes the common pattern so a mis-bound credential reads
 * the same everywhere, preserving the existing `invalid_request`/400 wire
 * contract.
 */
export function assertCredentialKind(
  credential: ResolvedCredential,
  expected: CredentialKind | readonly CredentialKind[],
  providerLabel: string,
): void {
  const expectedKinds = Array.isArray(expected) ? expected : [expected];
  if (expectedKinds.includes(credential.credential_kind)) return;
  throw new GatewayError(
    "invalid_request",
    400,
    `${providerLabel}: ${expectedKinds.join(" or ")} credential required (got credential_kind=${credential.credential_kind}) (request {requestId}). Wrong key, right door — check the credential 🔑`,
    { expected_credential_kind: expectedKinds },
  );
}

/**
 * Asserts a candidate's wire family is one of the ones the provider serves,
 * throwing `capability_unsupported` otherwise. Every provider hand-rolled this
 * guard with the same shape; this centralizes the pattern so a mis-routed
 * candidate reads the same everywhere.
 */
export function assertWireFamily(
  candidate: ProviderDispatchTarget,
  allowed: WireFamily | readonly WireFamily[],
  providerLabel: string,
): void {
  const allowedFamilies = Array.isArray(allowed) ? allowed : [allowed];
  if (allowedFamilies.includes(candidate.wire_family)) return;
  throw new GatewayError(
    "capability_unsupported",
    400,
    `${providerLabel} supports ${allowedFamilies.join("/")} only, got ${candidate.wire_family} (request {requestId}). Know your tools — this one just isn't in the box 🧰`,
    { expected_wire_families: allowedFamilies, got_wire_family: candidate.wire_family },
  );
}

/**
 * Minimal fetch surface accepted by provider adapters, collectors, and
 * discovery paths. One canonical shape shared across modules that plug a
 * transport into a provider boundary.
 */
export type OutboundFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

/** Fetch capability that validates DNS answers and redirects before each request. */
export type ValidatedOutboundFetch = OutboundFetch;

/** Provider WebSocket session over validated WSS egress. */
export interface ProviderWebSocketSession {
  send(message: string): void;
  receive(signal: AbortSignal): Promise<string>;
  close(code?: number, reason?: string): void;
}

/** WSS connector bound to the request's selected network-pool slot. */
export type ValidatedOutboundWebSocket = (
  url: URL,
  headers: Readonly<Record<string, string>>,
  signal: AbortSignal,
) => Promise<ProviderWebSocketSession>;

/**
 * Validated bidirectional HTTP/2 egress, bound to the same selected network
 * pool as `outbound_fetch`.
 *
 * A Connect-RPC bidi Run is neither a `fetch` (the request body never ends)
 * nor a WebSocket (different protocol), so it gets its own capability — and it
 * goes through the same binding factory as every other egress, which is what
 * keeps SSRF validation, DNS pinning, and pool byte attribution intact. A
 * provider adapter receives this closure and never dials a socket itself.
 */
/**
 * The dialer contract handed to a provider adapter.
 *
 * Declared in `network/http2-bidi.ts` — the transport owns the contract — and
 * re-exported here so provider code keeps one import site.
 */
export type { ValidatedOutboundHttp2Bidi };

/**
 * A provider session that outlives the HTTP request that created it.
 *
 * Cursor's Run stays open between the client's separate HTTP requests: the
 * first request returns a tool call and the next submits that tool's result on
 * the *same* upstream Run. The account and network-pool slot that Run holds
 * must therefore stay held too, while the request-scoped accounting for the
 * first HTTP request is already settled. Ownership is transferred here so the
 * release is idempotent and belongs to exactly one owner.
 */
export interface AttemptLeaseOwnership {
  /**
   * Hands the selected account/network-pool lease to a provider session that
   * outlives this request. Returns the release to call exactly once when the
   * session terminates; returns `undefined` when there was nothing to transfer
   * (a credential-less or pool-less route), which is not an error.
   *
   * Idempotent: a second call returns `undefined` and releases nothing.
   */
  transferToProviderSession(): (() => void) | undefined;
}

/**
 * Identity that authorizes a later request to continue a provider session the
 * gateway is already holding.
 *
 * Cursor's tool loop spans two client HTTP requests on one upstream Run, so the
 * Run — and the account lease it holds — outlives the request that opened it. A
 * later request may only claim the Run by presenting the same tenant, API key,
 * provider, and account, all recorded server-side when the Run was created. A
 * call id alone is never sufficient: it is unguessable but it is still just a
 * string a client could carry into another key's request.
 */
export interface ProviderContinuationScope {
  readonly tenantId: string;
  readonly apiKeyId: string;
  readonly providerId: string;
  readonly providerAccountId: string;
}

/** Context passed from routing to a provider adapter. */
export interface ProviderDispatchContext {
  readonly credential: ResolvedCredential;
  readonly deadline: number;
  readonly abort_signal: AbortSignal;
  readonly outbound_fetch?: ValidatedOutboundFetch | undefined;
  /** Validated image/attachment egress; deliberately excluded from payload capture. */
  readonly outbound_attachment_fetch?: ValidatedOutboundFetch | undefined;
  /** Validated bidirectional HTTP/2 egress bound to the same selected network pool. */
  readonly outbound_http2?: ValidatedOutboundHttp2Bidi | undefined;
  /**
   * Capture sink for one attempt's provider exchange, filled by HTTP fetch
   * wrapping. Adapters whose real upstream transport is not a `fetch`
   * (Qoder's gRPC) write it directly so Request Detail shows the actual
   * conversation call rather than an auth exchange or an empty panel.
   */
  readonly provider_capture?: ProviderCaptureExchange | undefined;
  /**
   * Route-selected fallback User-Agent from Routing Strategy; set when the
   * operator configured one (bundled API-key providers default to the Claude
   * CLI identity). Empty means the operator chose "None".
   */
  readonly user_agent?: string | undefined;
  /** Gateway request id, stable across provider retries for one logical request. */
  readonly request_id?: string | undefined;
  /** Original inbound headers needed only for provider-specific negotiation. */
  readonly request_headers?: Readonly<Record<string, string>> | undefined;
  /** Stable per-conversation cache affinity passed through dispatch. */
  readonly conversation_affinity?: string | undefined;
  /**
   * Per-tenant ceiling for one inline attachment, in bytes. `undefined` means
   * the deployment default. Read by wire encoders that clamp images, which
   * otherwise have no access to tenant preferences — they are pure translation
   * and hold no database handle.
   */
  readonly image_clamp_max_bytes?: number | undefined;
  /**
   * Tenant system-prompt text resolved once per request (append/override
   * injection). The buddy adapters fold it into their fixed system turn after
   * serialization, wrapped in the gateway's marker prefix/suffix, so the
   * upstream's channel-identity validation still sees its prompt as the
   * opener.
   */
  readonly tenant_system_prompt?: string | undefined;
  /** Opaque identity shared by retries of one logical gateway request. */
  readonly request_identity?: object | undefined;
  /**
   * Ownership of this attempt's account/network-pool lease. Present only when
   * the route holds a lease; a provider session that outlives the request
   * (Cursor's Run) takes it over so the slot is not released while the Run is
   * live, and not released twice when it ends.
   */
  readonly lease_ownership?: AttemptLeaseOwnership | undefined;
  /**
   * Identity of the caller, for a provider session that outlives this request.
   * Absent when the route cannot scope a continuation, in which case a session
   * must not be held open across requests at all.
   */
  readonly continuation_scope?: ProviderContinuationScope | undefined;
}

const USER_AGENT_HEADER_NAME = /^user-agent$/i;
const USER_AGENT_HEADER_LENGTH = "user-agent".length;

function hasUserAgentHeader(headers: Record<string, string>): boolean {
  for (const headerName in headers) {
    if (headerName.length !== USER_AGENT_HEADER_LENGTH) continue;
    if (Object.hasOwn(headers, headerName) && USER_AGENT_HEADER_NAME.test(headerName)) return true;
  }
  return false;
}

/** Uses the route identity as a fallback without replacing provider-supplied headers. */
export function applyRouteUserAgent(
  headers: Record<string, string>,
  credential: ResolvedCredential,
  userAgent: string | undefined,
): void {
  if (
    credential.credential_kind === "oauth" ||
    credential.credential_kind === "scoped_access_token" ||
    userAgent === undefined ||
    userAgent.trim().length === 0
  ) {
    return;
  }
  if (hasUserAgentHeader(headers)) return;
  headers["user-agent"] = userAgent;
}

/** ProviderDispatchTarget identity already resolved by routing before credential leasing. */
/**
 * Capture sink for one attempt's provider exchange.
 *
 * HTTP transports fill this automatically by wrapping `outbound_fetch` (see
 * `captureProviderExchange` in `transport/dispatch/attempt-finalize.ts`).
 * Adapters whose real upstream call is not a fetch — Qoder's gRPC surface —
 * write it directly so Request Detail shows the actual conversation call
 * instead of an auth exchange or nothing.
 */
export interface ProviderCaptureExchange {
  request: unknown;
  response: Promise<unknown>;
}

export interface ProviderDispatchTarget {
  readonly provider_id: ProviderId;
  readonly model_id: string;
  readonly wire_family: WireFamily;
  readonly endpoint_path: string;
  readonly output_limit?: number | null;
  readonly capabilities: Readonly<Record<string, boolean>>;
  /** Explicit wire dialect (from `models.dialect`), when set. Absent = resolver fallback. */
  readonly dialect?: string;
  /**
   * Transport override for a one-shot probe, when the operator explicitly
   * asked for one. Live dispatch never sets this — it is a probe-only knob
   * that lets a provider expose a surface the production transports do not
   * use (Qoder's IDE surface is the only one that echoes strategy metadata).
   */
  readonly probe_surface?: "cosy" | "grpc" | "ide";
}

/** Provider adapter boundary: canonical request/events in, no public HTTP routes. */
export interface ProviderAdapter {
  readonly provider_id: ProviderId;
  dispatch(
    request: CanonicalRequest,
    candidate: ProviderDispatchTarget,
    context: ProviderDispatchContext,
  ): AsyncIterable<CanonicalEvent>;
  /**
   * Optional provider-mandated system prompt, returned for probes and any
   * caller that needs the upstream's required identity prompt. A provider
   * whose wire refuses requests without a specific system prompt (Perch's
   * Saffron fingerprint) declares it here so the probe path can carry it —
   * the probe builder otherwise sends only the user message.
   */
  systemPrompt?(): string | undefined;
  /**
   * Optional native-protocol capability for the public `POST /v1/systemone`
   * route (the dispatch leg of the System One service, alongside the probing
   * leg served by the discovery/probing-service). A provider whose catalog
   * serves a non-`llm` service kind (System One) implements the matching
   * method; the native route handler looks it up and dispatches the caller's
   * opaque body through it. The body is forwarded untouched — the method only
   * adds the provider's auth/identity headers and posts it to `endpoint_path`.
   *
   * An adapter without this method is simply not eligible for the route, which
   * is why it is optional rather than a required no-op.
   */
  systemone?(
    body: Record<string, unknown>,
    candidate: ProviderDispatchTarget,
    context: ProviderDispatchContext,
  ): Promise<Response>;
  /**
   * Optional native web-search capability, the analogue of {@link systemone}
   * for the `/v1/search` route. The caller's body is opaque (`{query,
   * max_results, …}`); the adapter maps it onto the provider's own search API
   * and returns the raw upstream `Response`, which the route normalizes into
   * the unified search envelope. The route performs the SSRF/credential work,
   * so an adapter without this method is simply not eligible.
   */
  websearch?(
    body: Record<string, unknown>,
    candidate: ProviderDispatchTarget,
    context: ProviderDispatchContext,
  ): Promise<WebSearchOutcome>;
  /**
   * Optional native image-generation capability for `POST
   * /v1/images/generations`. The caller's body is opaque (`{prompt, n, size,
   * …}`); the adapter maps it onto the provider's own image API and returns the
   * generated images.
   *
   * Optional rather than a required no-op: an adapter that does not implement
   * it is not eligible for the route, which is what lets a provider advertise
   * `imageGeneration` in its catalog without every adapter having to answer for
   * a surface it cannot serve. The route handles the endpoint POST itself when
   * this is absent, so the capability is reachable through the candidate's
   * `endpoint_path` either way.
   */
  generateImage?(
    body: Record<string, unknown>,
    candidate: ProviderDispatchTarget,
    context: ProviderDispatchContext,
  ): Promise<ImageGenerationOutcome>;
  /**
   * Optional native video-generation capability for `POST
   * `/v1/videos/generations``, the video analogue of {@link generateImage}.
   *
   * A video result is provider-defined — a finished clip URL, an async task the
   * adapter resolves to completion, or a task handle the caller polls — so the
   * return is an opaque record rather than the fixed {@link ImageGenerationOutcome}
   * shape. Optional for the same reason as {@link generateImage}: an adapter that
   * does not implement it falls back to posting the body to the candidate's
   * `endpoint_path` through {@link dispatchNativeService}.
   */
  generateVideo?(
    body: Record<string, unknown>,
    candidate: ProviderDispatchTarget,
    context: ProviderDispatchContext,
  ): Promise<Record<string, unknown>>;
  /**
   * Posts an opaque body to a candidate's own endpoint and returns the raw
   * upstream response.
   *
   * The shared escape hatch for a service the gateway does not model: the
   * candidate names the path, the adapter supplies the host, and the body is
   * forwarded untouched. `generateImage` uses it as its fallback so a provider
   * can serve images from its own path without a bespoke mapping, and it is
   * what lets `/v1/images/generations` work at all for an adapter that has not
   * written an image method.
   */
  dispatchNativeService?(
    body: Record<string, unknown>,
    candidate: ProviderDispatchTarget,
    context: ProviderDispatchContext,
  ): Promise<Response>;
}

/**
 * The normalized result of one image-generation dispatch.
 *
 * Deliberately open: images arrive as URLs or base64 depending on the
 * provider, and the gateway must not transcode between them. `data` is passed
 * through exactly as the upstream produced it so a caller that asked for
 * `b64_json` still receives base64.
 */
export interface ImageGenerationOutcome {
  readonly created?: number;
  readonly data: readonly Record<string, unknown>[];
  readonly usage?: Record<string, unknown> | null;
}

/** One provider-independent web-search hit, normalized from a provider's own response shape. */
export interface WebSearchResult {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
  readonly published_at?: string | null;
  /** Provider relevance score, clamped to `[0, 1]`; absent when the provider reports none. */
  readonly score?: number | null;
}

/**
 * The normalized result of one web-search dispatch. The adapter owns both the
 * request mapping onto its provider's search API and the normalization of that
 * provider's response shape into this vocabulary, so the `/v1/search` route
 * never learns any provider's wire. A failed upstream throws a `GatewayError`
 * carrying the upstream status — the same contract as `systemone` — so the
 * attempt loop's retry classifier sees it; a success returns this.
 */
export interface WebSearchOutcome {
  readonly results: readonly WebSearchResult[];
  readonly total_results?: number | null;
}

/**
 * Normalizes a provider slug, rejecting anything that is not one. Persisted
 * IDs are already canonical, so no alias mapping is applied: an unknown or
 * misspelled slug is a caller error.
 */
function normalizeProviderSlug(id: string): string {
  const trimmed = id.trim().toLowerCase();
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(trimmed)) {
    throw new GatewayError("invalid_request", 400, "Provider ID must be a lowercase slug (request {requestId}). Check the shape of what you sent — then resend 🪞");
  }
  return trimmed;
}

/** Returns true for one of Cartethyia's reserved builtin IDs, case-insensitively. */
export function isBundledProviderId(value: string): value is BundledProviderId {
  const normalized = value.trim().toLowerCase();
  return (BUNDLED_PROVIDER_IDS as readonly string[]).includes(normalized);
}

/** Normalizes a provider identifier before persistence or registry lookup. */
export function parseProviderId(value: string): ProviderId {
  const normalized = normalizeProviderSlug(value);
  return isBundledProviderId(normalized) ? normalized : normalized as CustomProviderId;
}

/**
 * Validates a custom/BYOK slug before any provider row is written.
 * Builtin collisions are case-insensitive and fail with typed `slug_reserved`.
 */
export function parseCustomProviderId(value: string): CustomProviderId {
  const normalized = parseProviderId(value);
  if (isBundledProviderId(normalized)) {
    throw new GatewayError(
      "slug_reserved",
      409,
      "The provider ID is reserved for a builtin provider (request {requestId}). This name's taken — pick another alias ✨",
      { provider_id: normalized },
    );
  }
  return normalized as CustomProviderId;
}
