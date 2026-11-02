import { isBundledProviderId } from "../../providers/provider-contracts";
import type { ProviderDispatchContext, ProviderId, ProviderAdapter } from "../../providers/provider-contracts";
import { GatewayError } from "../../protocol/gateway-error";
import { isWrappedInjectionProvider } from "../../console/system-prompt/contracts";
import { resolveTenantSystemPrompt } from "../request/system-prompt-injection";
import { readTenantSystemPromptsForDispatch } from "../request/tenant-preferences";
import type { CanonicalEvent } from "../../protocol/canonical-model";
import { resolveCredentialForAccount } from "../../providers/operations/provider-credential-service";
import type { ByokUpstreamHost } from "../../providers/operations/provider-catalog-service";
import { chatAdapter } from "../surface/chat/adapter";
import { responsesAdapter } from "../surface/responses/adapter";
import { messagesAdapter } from "../surface/messages/adapter";
import { completionAdapter } from "../surface/completion";
import { forwardedRequestHeaders, proxySuccessHeaders, buildUpstreamDispatchContext, reportedModelFrom } from "./upstream";
import { resolvePromptCacheKey } from "../../providers/operations/session-resolution";
import {
  applyTenantPreferences,
  applyTenantDeadlineOverride,
  resolveTenantImageClampMaxBytes,
} from "../request/tenant-preferences";
import { metrics } from "../../observability/metrics";
import { repriceUsage } from "../../providers/provider-usage";
import {
  captureProviderExchange,
  completeAttempt,
  completionContext,
  estimatedUsage,
  parseCapturedBody,
  terminalFailure,
} from "./attempt-finalize";
import {
  providerCaptureMaxBytes,
  resolveCaptureDepthForRequest,
  shouldCaptureProviderBodyForRequest,
} from "./capture-policy";
import { runAttemptLoop } from "./attempt-loop";
import { projectForRoute, routeCapabilitiesFor } from "../../protocol/translation/capabilities";
import { dispatchStreamingAttempt } from "./streaming/stream";
import type { ProviderContinuationScope } from "../../providers/provider-contracts";
import type { PreparedProxyRequest } from "../request/preparer";

import type { GatewayHandlerDeps } from "./handler-deps";

export type ProviderProxyHandlerDeps = GatewayHandlerDeps & {
  /** Live lookup of a provider's SSRF-validated upstream host. */
  readonly byokUpstreamHosts?: { readonly get: (providerId: string) => ByokUpstreamHost | undefined };
};

/**
 * The continuation scope one dispatch carries.
 *
 * Present only for a route that has an account: a provider session held across
 * requests is authorized by tenant + API key + provider + account, and a route
 * with no account cannot be scoped — so it must not hold a session open at all.
 */
function continuationScopeFor(prepared: PreparedProxyRequest): ProviderContinuationScope | undefined {
  const accountId = prepared.candidate.provider_account_id;
  if (accountId === undefined) return undefined;
  return {
    tenantId: prepared.authorization.tenantId,
    apiKeyId: prepared.authorization.id,
    providerId: prepared.candidate.provider_id,
    providerAccountId: accountId,
  };
}

/**
 * First-token latency for one attempt, in the spread shape `completeAttempt`
 * takes: `{}` when there is nothing to measure — no first byte arrived (a
 * pre-stream failure) or the attempt never started upstream — and
 * `{ ttfbMs }` otherwise. A stream reports whichever of the first byte or the
 * first content delta landed first; a non-streaming call has only the delta.
 */
function ttfbFields(
  firstByteAt: number | undefined,
  firstContentDeltaAtMs: number | undefined,
  startedAtMs: number | undefined,
): { ttfbMs?: number } {
  const firstAt = firstByteAt ?? firstContentDeltaAtMs;
  if (firstAt === undefined || startedAtMs === undefined) return {};
  return { ttfbMs: Math.max(0, firstAt - startedAtMs) };
}

/**
 * The proxy request hot path: dispatches one prepared, admitted request to
 * the best eligible provider candidate, with bounded failover.
 *
 * Lifecycle per request (state prepared earlier by the request planner):
 * tenant thinking/reasoning preferences are applied to the canonical request,
 * then `runAttemptLoop` walks the ordered candidate list. Each attempt:
 *
 * 1. **Prepare** — resolves the account credential (refreshing OAuth tokens
 *    through `oauthRefreshService` when needed) and the provider adapter;
 *    BYOK providers additionally require a validated network binding.
 * 2. **Lease** — `dispatch/leases` atomically takes the admission lease
 *    (RPM/token/concurrency), routing reservation, and network-pool slot;
 *    released in `finally` unless retained by a streaming response.
 * 3. **Dispatch** — the adapter call goes through the validated network
 *    binding (direct or pool-bound fetch) with per-attempt exchange capture;
 *    capability/quirk incompatibilities degrade via a bounded compatibility
 *    fallback plan before re-dispatching.
 * 4. **Settle** — `completeAttempt` commits usage, updates account health,
 *    finalizes telemetry; `dispatch/attempt-finalize` owns terminal bookkeeping.
 *
 * Error handling: a failed *intermediate* attempt is retried on the next
 * candidate after a bounded backoff (`failure-policy`); non-retryable
 * failures and exhaustion of the candidate list propagate as GatewayErrors.
 * Streaming responses prime the first upstream event before the 200 is
 * committed (so failover can still happen), then retain their leases until
 * stream completion/cancel via `releaseStreamResources`.
 */
export async function handleProviderProxyRequest(
  request: Request,
  deps: ProviderProxyHandlerDeps,
): Promise<Response> {
  const state = deps.stateStore.require(request);
  const prepared = state.preparedRequest;
  if (!prepared)
    throw new GatewayError("route_unavailable", 503, "The request was not prepared, so no route can be dialed (request {requestId}). Resend the request. The bouncer stepped out — resend shortly 🚪");
  const canonicalRequest = await applyTenantPreferences(prepared, deps.db);
  // Tenant system-prompt injection, resolved once per request. For providers
  // whose upstream validates the fixed system prompt as a channel identity
  // (the buddy family), the text cannot ride the canonical `system` array —
  // the adapter replaces it — so it travels through dispatch context and the
  // adapter folds it into its fixed turn, wrapped in the gateway's markers.
  // `override` degrades to wrapped append there: stripping the identity would
  // have the upstream refuse the request outright.
  const candidateForPrompt = prepared.candidate;
  const tenantSystemPromptText = isWrappedInjectionProvider(candidateForPrompt.provider_id)
    ? resolveTenantSystemPrompt(
        await readTenantSystemPromptsForDispatch(
          deps.db,
          prepared.authorization.snapshot.tenant_id,
        ),
        {
          providerId: candidateForPrompt.provider_id,
          modelId: candidateForPrompt.model_id,
          requestedModel: prepared.plan?.requested_model ?? candidateForPrompt.model_id,
        },
      )?.text
    : undefined;
  // Per-tenant timeout, applied as soon as the tenant is known. The deadline
  // was armed at admission with the deployment default; this re-arms it.
  await applyTenantDeadlineOverride(
    prepared.authorization.snapshot.tenant_id,
    deps.db,
    (ms) => state.extendDeadline(ms),
  );
  // Memoized on the request: the ceiling is a tenant setting, so it cannot
  // change between failover attempts, and each wire encoder that clamps an
  // image reads it from here instead of paying for a preference read per
  // attempt.
  const imageClampMaxBytes = await resolveTenantImageClampMaxBytes(
    deps.db,
    prepared.authorization.snapshot.tenant_id,
  );
  if (imageClampMaxBytes !== undefined) state.imageClampMaxBytes = imageClampMaxBytes;
  const candidates =
    prepared.eligibleRouteCandidates.length > 0 ? prepared.eligibleRouteCandidates : [prepared.candidate];
  const attemptCandidates = candidates;
  const dispatchRequest = canonicalRequest;
  const inboundHeaders = forwardedRequestHeaders(request);
  // Stable per-conversation affinity for every attempt on every wire: caller
  // key first, then inbound session headers, then a hash of the opening turn.
  // The stub carries only the fields the resolver reads (request_headers).
  const conversationAffinity = resolvePromptCacheKey(canonicalRequest, {
    request_headers: inboundHeaders,
  } as ProviderDispatchContext);
  return runAttemptLoop<Response, ProviderAdapter>({
    state,
    deps,
    leaseSource: {
      admissionService: prepared.admissionService,
      routingEngine: prepared.routingEngine,
      plan: prepared.plan,
      estimatedInputTokens: prepared.estimatedInputTokens,
      estimatedOutputTokens: prepared.estimatedOutputTokens,
      authorizationSnapshot: prepared.authorization.snapshot,
      // A continuation borrows the held Cursor Run: one upstream turn must not
      // occupy two account/pool concurrency slots. A rebaseable continuation
      // (complete history, pinned account no longer routable) does NOT borrow —
      // it starts a fresh Run on a newly selected account, so it leases like a
      // normal request.
      ...(prepared.continuationAffinity === undefined || prepared.continuationAffinity.rebaseable
        ? {}
        : { borrowsHeldSession: true }),
    },
    candidates: attemptCandidates,
    tenantId: prepared.authorization.tenantId,
    strictPoolSelection: true,
    resolveHost: (candidate) => deps.byokUpstreamHosts?.get(candidate.provider_id),
    exhaustedError: new GatewayError("route_unavailable", 503, "No account could be leased for this request (request {requestId}). Retry shortly; if it persists, add an account or check that one is healthy. The bouncer stepped out — come back shortly 🚪"),
    prepare: async (candidate) => {
      if (!candidate.provider_account_id && candidate.requires_account !== false)
        throw new GatewayError(
          "route_unavailable",
          503,
          "This route has no usable credential (request {requestId}). Save one on the account, or route to a provider whose account is configured. Wrong key, right door — check the credential 🔑",
        );
      const credential = candidate.provider_account_id
        ? await resolveCredentialForAccount(
            deps.db,
            candidate.provider_id,
            candidate.provider_account_id,
            deps.oauthRefreshService && deps.resolveOAuthRefresher
              ? { refreshService: deps.oauthRefreshService, resolveRefresher: deps.resolveOAuthRefresher }
              : undefined,
          )
        : {
            provider_id: candidate.provider_id as ProviderId,
            credential_kind: "none" as const,
          };
      const adapter = await deps.resolveProviderAdapter?.(candidate.provider_id);
      if (!adapter)
        throw new GatewayError("route_unavailable", 503, "provider adapter not registered (request {requestId}). Even we have bad days — check the registry wiring 🐻");
      if (!isBundledProviderId(candidate.provider_id)) {
        if (!deps.byokUpstreamHosts?.get(candidate.provider_id) || !deps.networkBindingFactory)
          throw new GatewayError(
            "route_unavailable",
            503,
            "validated network binding is required for configurable upstreams (request {requestId}). No bridge to cross — configure a pool first 🏗️",
          );
      }
      return { credential, adapter };
    },
    attempt: async (context) => {
      const { candidate, credential, adapter } = context;
      const networkPoolId = context.leases.networkPoolId;
      const providerCapture = context.providerCapture;
      const lease = context.leases.lease;
      const reservation = context.leases.reservation;
      const proxySlot = context.leases.proxySlot;
      const leaseOwnership = context.leases.ownership;
      const continuationScope = continuationScopeFor(prepared);
      const providerRouteCandidate = {
        provider_id: candidate.provider_id,
        model_id: candidate.model_id,
        wire_family: candidate.wire_family,
        endpoint_path: candidate.endpoint,
        ...(candidate.output_limit == null ? {} : { output_limit: candidate.output_limit }),
        capabilities: candidate.capability_profile,
        user_agent: candidate.user_agent,
      };
      const candidateRequest =
        candidate.model_id === dispatchRequest.model
          ? dispatchRequest
          : { ...dispatchRequest, model: candidate.model_id };
      const attemptRequest = projectForRoute(
        candidateRequest,
        routeCapabilitiesFor(candidate),
      );
      const dispatchContextBase = buildUpstreamDispatchContext({
        credential,
        deadline: state.deadlineMs,
        signal: state.abortController.signal,
        headers: inboundHeaders,
        requestId: state.requestId,
        requestIdentity: state,
        ...(state.imageClampMaxBytes === undefined
          ? {}
          : { imageClampMaxBytes: state.imageClampMaxBytes }),
        ...(conversationAffinity ? { conversationAffinity } : {}),
        ...(tenantSystemPromptText === undefined ? {} : { tenantSystemPrompt: tenantSystemPromptText }),
        ...(candidate.user_agent === undefined ? {} : { userAgent: candidate.user_agent }),
        ...(deps.networkBindingFactory
          ? {
              outboundFetch: captureProviderExchange(
                deps.networkBindingFactory.fetch(
                  networkPoolId,
                  prepared.authorization.snapshot.tenant_id,
                ),
                providerCapture,
                await shouldCaptureProviderBodyForRequest(
                  deps.db,
                  prepared.authorization.snapshot.tenant_id,
                  state,
                ),
                providerCaptureMaxBytes(
                  await resolveCaptureDepthForRequest(
                    deps.db,
                    prepared.authorization.snapshot.tenant_id,
                    state,
                  ),
                ),
              ),
            }
          : {}),
        ...(deps.networkBindingFactory
          ? {
              outboundAttachmentFetch: deps.networkBindingFactory.fetch(
                networkPoolId,
                prepared.authorization.snapshot.tenant_id,
              ),
            }
          : {}),
        ...(deps.networkBindingFactory
          ? {
              outboundHttp2: deps.networkBindingFactory.http2Bidi(
                networkPoolId,
                prepared.authorization.snapshot.tenant_id,
              ),
            }
          : {}),
        ...(leaseOwnership === undefined ? {} : { leaseOwnership }),
        ...(continuationScope === undefined ? {} : { continuationScope }),
      });
      if (dispatchRequest.stream) {
        return dispatchStreamingAttempt({
          state,
          deps,
          prepared,
          canonicalRequest: dispatchRequest,
          candidate,
          credential,
          adapter,
          dispatchRequest: attemptRequest,
          providerRouteCandidate,
          inboundHeaders,
          conversationAffinity,
          lease,
          reservation,
          proxySlot,
          networkPoolId,
          providerCapture,
          retainLeases: context.retainLeases,
          ttfbFields,
          ...(leaseOwnership === undefined ? {} : { leaseOwnership }),
          ...(continuationScope === undefined ? {} : { continuationScope }),
        });
      }
      // Pool slot ownership belongs to the candidate attempt: the slot was
      // acquired atomically with selection above, and `proxySlot` is
      // released in the `finally` below. Acquiring again here (including
      // inside the compatibility-fallback `dispatch` callback, which may run
      // twice) would overwrite `proxySlot` and leak the first handle.
      // First-content timing is stamped during iteration: spreading a
      // timestamp onto every event just to scan for it afterwards allocated
      // one object per event for a single number. The streaming path keeps
      // its own timing where the timestamps are actually consumed.
      const dispatch = async (input: typeof attemptRequest): Promise<{ events: CanonicalEvent[]; firstContentDeltaAtMs: number | undefined }> => {
        const events: CanonicalEvent[] = [];
        let firstContentDeltaAtMs: number | undefined;
        for await (const event of adapter.dispatch(
          input,
          providerRouteCandidate as never,
          dispatchContextBase as never,
        )) {
          if (firstContentDeltaAtMs === undefined && event.type === "content_delta") {
            firstContentDeltaAtMs = Date.now();
          }
          events.push(event);
        }
        return { events, firstContentDeltaAtMs };
      };
      state.upstreamDispatchStartedAtMs = Date.now();
      const { events, firstContentDeltaAtMs } = await dispatch(attemptRequest);
      const terminal = events.find((event) => event.type === "terminal");
      if (terminal === undefined) throw terminalFailure(undefined);
      const terminalError = terminalFailure(terminal);
      if (terminalError !== undefined) throw terminalError;
      // An interim `tool_use` terminal defers usage: the provider's turn is not
      // over, so its authoritative usage arrives with the *next* request that
      // continues the same upstream turn. Charging an estimate here would bill
      // the turn twice — the estimate now and the real usage later.
      const deferredUsage = terminal.usage_deferred === true;
      const usage =
        terminal.usage ??
        estimatedUsage(prepared.estimatedInputTokens, prepared.estimatedOutputTokens);
      const pricedUsage = repriceUsage(usage, candidate.provider_id, candidate.model_id);
      const options = {
        created: Date.now() / 1000,
        include_usage: dispatchRequest.generation_controls["extension:include_usage"] === true,
      };
      const output =
        dispatchRequest.source_surface === "chat"
          ? chatAdapter.encode(events, options)
          : dispatchRequest.source_surface === "responses"
            ? responsesAdapter.encodeOutput(events, { ...options, model: dispatchRequest.model })
            : dispatchRequest.source_surface === "messages"
              ? messagesAdapter.encodeOutput(events, options as never)
              : completionAdapter.encodeOutput(events, {
                  ...options,
                  prompt: dispatchRequest.generation_controls["extension:completion.prompt"],
                  echo: dispatchRequest.generation_controls["extension:completion.echo"] === true,
                  suffix: dispatchRequest.generation_controls["extension:completion.suffix"],
                });
      // Single decode shared by both telemetry panels and the client bytes
      // below; decoding twice doubled the copy on every non-stream response.
      const decodedClientText = new TextDecoder().decode(output.bytes);
      await completeAttempt(state, {
        status: "completed",
        ...completionContext({
          providerId: candidate.provider_id,
          modelId: candidate.model_id,
          tenantId: prepared.authorization.tenantId,
          ingressBody: state.ingressBody,
          providerCapture,
          db: deps.db,
          ...(candidate.provider_account_id ? { accountId: candidate.provider_account_id } : {}),
          ...(candidate.provider_account_label ? { accountLabel: candidate.provider_account_label } : {}),
          ...(networkPoolId ? { networkPoolId } : {}),
          ...(lease ? { lease } : {}),
          ...(deps.telemetryBuffer ? { telemetryBuffer: deps.telemetryBuffer } : {}),
          ...(deps.snapshotService ? { snapshotService: deps.snapshotService } : {}),
        }),
        ...ttfbFields(undefined, firstContentDeltaAtMs, state.upstreamDispatchStartedAtMs),
        ...(() => {
          // The model the upstream named in its own response, verbatim.
          const reported = reportedModelFrom(events);
          return reported === undefined ? {} : { reportedModel: reported };
        })(),
        usage: pricedUsage,
        // Deferred: the request consumed upstream resources (it is mid-turn), so
        // the *recorded* usage stays for the row, but nothing is committed —
        // the Run's own `turn_ended` commits once, on the final response.
        ...(deferredUsage ? {} : { commitUsage: pricedUsage }),
        // Decode once: `output.bytes` is a `Uint8Array`, which
        // `parseCapturedBody` returns untouched — the Server panel would store
        // a byte-index map (`{"0":123,…}`) after redaction instead of the
        // response. The client receives the same text we parse here, so both
        // panels stay in sync.
        responseBody: parseCapturedBody(decodedClientText),
        // Non-stream: client receives the exact same bytes we just encoded —
        // keep Server and Client panels in sync so the drawer never shows “—”.
        clientResponseText: decodedClientText,
      });
      metrics.proxy_requests_total.inc(1, { status: "completed" });
      return new Response(output.bytes as unknown as BodyInit, {
        headers: { "content-type": output.content_type, ...proxySuccessHeaders(state) },
      });
    },
  });
}
