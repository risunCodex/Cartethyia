import type { CanonicalEvent } from "../../protocol/canonical-model";
import type { AttemptLeaseOwnership, ValidatedOutboundFetch, ValidatedOutboundHttp2Bidi } from "../../providers/provider-contracts";
import type { ProviderCaptureExchange, ProviderContinuationScope } from "../../providers/provider-contracts";
import { GATEWAY_SECURITY_HEADERS } from "../../security/outbound-headers";

const FORWARDED_REQUEST_HEADERS = new Set([
  "user-agent",
  "anthropic-beta",
  "x-claude-code-session-id",
  "x-conversation-id",
  "x-session-id",
  "x-session-affinity",
  "x-opencode-session",
  "x-opencode-session-id",
  "x-opencode-project",
  "prompt-cache-key",
  "prompt_cache_key",
  "session-id",
]);

export function forwardedRequestHeaders(request: Request): Record<string, string> {
  const forwarded: Record<string, string> = {};
  request.headers.forEach((value, name) => {
    if (FORWARDED_REQUEST_HEADERS.has(name.toLowerCase())) forwarded[name.toLowerCase()] = value;
  });
  return forwarded;
}

export function proxySuccessHeaders(state: { requestId: string }): Record<string, string> {
  return {
    "cache-control": "no-store",
    "x-request-id": state.requestId,
    ...GATEWAY_SECURITY_HEADERS,
  };
}

export function buildUpstreamDispatchContext(input: {
  readonly credential: unknown;
  readonly deadline: number;
  readonly signal: AbortSignal;
  readonly headers: Record<string, string>;
  readonly requestId?: string;
  readonly userAgent?: string;
  readonly outboundFetch?: ValidatedOutboundFetch;
  /** Capture sink for provider exchanges not visible to the HTTP fetch wrapper. */
  readonly providerCapture?: ProviderCaptureExchange;
  /** Validated attachment egress that must not be wrapped by provider payload capture. */
  readonly outboundAttachmentFetch?: ValidatedOutboundFetch;
  /** Validated bidirectional HTTP/2 egress bound to the same selected pool. */
  readonly outboundHttp2?: ValidatedOutboundHttp2Bidi;
  /**
   * Ownership of this attempt's account/network-pool lease; a provider session
   * that outlives the request takes it over.
   */
  readonly leaseOwnership?: AttemptLeaseOwnership;
  /** Caller identity authorizing a provider session held across requests. */
  readonly continuationScope?: ProviderContinuationScope;
  /** Stable per-conversation cache affinity (preferred over random ids). */
  readonly conversationAffinity?: string;
  /**
   * Per-tenant inline-attachment ceiling in bytes, resolved once per request.
   * Carried through dispatch because wire encoders clamp images but hold no
   * database handle.
   */
  readonly imageClampMaxBytes?: number;
  /**
   * Tenant system-prompt text resolved once per request (append/override
   * injection). Carried through dispatch because the buddy adapters fold it
   * into their fixed system turn after serialization — the canonical level
   * cannot reach that turn.
   */
  readonly tenantSystemPrompt?: string;
  /** Opaque identity shared by retries of one logical gateway request. */
  readonly requestIdentity?: object;
}): Record<string, unknown> {
  const credentialKind =
    typeof input.credential === "object" && input.credential !== null && "credential_kind" in input.credential
      ? input.credential.credential_kind
      : undefined;
  const userAgent = credentialKind === "oauth" || credentialKind === "scoped_access_token"
    ? undefined
    : input.userAgent;
  const sourceFetch = input.outboundFetch;
  const outboundFetch =
    sourceFetch && userAgent
      ? (request: RequestInfo | URL, init?: RequestInit) => {
          const requestHeaders =
            init?.headers ?? (request instanceof Request ? request.headers : undefined);
          const headers = new Headers(requestHeaders);
          // A route-level user agent is an explicit operator override: it
          // replaces whatever identity the provider would otherwise send.
          // Absent route identity leaves the provider's own header untouched.
          if (userAgent) headers.set("user-agent", userAgent);
          return sourceFetch(request, { ...init, headers });
        }
      : sourceFetch;
  return {
    credential: input.credential,
    deadline: input.deadline,
    abort_signal: input.signal,
    ...(input.requestId === undefined ? {} : { request_id: input.requestId }),
    ...(userAgent ? { user_agent: userAgent } : {}),
    ...(Object.keys(input.headers).length > 0 ? { request_headers: input.headers } : {}),
    ...(outboundFetch ? { outbound_fetch: outboundFetch } : {}),
    ...(input.providerCapture ? { provider_capture: input.providerCapture } : {}),
    ...(input.outboundAttachmentFetch
      ? { outbound_attachment_fetch: input.outboundAttachmentFetch }
      : {}),
    ...(input.outboundHttp2 ? { outbound_http2: input.outboundHttp2 } : {}),
    ...(input.leaseOwnership ? { lease_ownership: input.leaseOwnership } : {}),
    ...(input.continuationScope ? { continuation_scope: input.continuationScope } : {}),
    ...(input.conversationAffinity ? { conversation_affinity: input.conversationAffinity } : {}),
    ...(input.imageClampMaxBytes === undefined
      ? {}
      : { image_clamp_max_bytes: input.imageClampMaxBytes }),
    ...(input.tenantSystemPrompt === undefined
      ? {}
      : { tenant_system_prompt: input.tenantSystemPrompt }),
    ...(input.requestIdentity ? { request_identity: input.requestIdentity } : {}),
  } as Record<string, unknown>;
}

/**
 * The model id an upstream put in its own response, verbatim.
 *
 * `response_start` is the only event that carries it, and the wire parsers fill
 * it from the payload's own `model` field. Read as-is — no prefix stripping, no
 * comparison against the request, no fallback to the requested id. A provider
 * that answers a `muse-spark` request as `deepseek-v4.1-flash` is telling the
 * operator something the request cannot, and filling in the ask when the
 * response carried none would report the ask as if it were the answer.
 */
export function reportedModelFrom(events: readonly CanonicalEvent[]): string | undefined {
  for (const event of events) {
    if (event.type !== "response_start" && event.type !== "message_start") continue;
    const model = event.model;
    if (typeof model === "string" && model.trim().length > 0) return model;
  }
  return undefined;
}
