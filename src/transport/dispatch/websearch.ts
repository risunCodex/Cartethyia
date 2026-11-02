/**
 * The native web-search route (`POST /v1/search`) and the dependency surface it
 * needs to drive `runAttemptLoop`.
 *
 * A search request is not chat-shaped: the caller sends `{model, query,
 * max_results, …}` and receives a normalized list of hits. Routing, admission,
 * retry, accounting, and telemetry still run through the shared attempt loop —
 * the caller's `model` resolves through the same routing engine (so aliases and
 * combos of search providers work), and failover to a sibling search provider
 * is the same policy as any other route.
 *
 * The adapter owns the per-provider request mapping and response normalization
 * (`ProviderAdapter.websearch`), so this handler never learns a provider's wire;
 * it only validates the trust boundary, drives the loop, and serializes the
 * normalized envelope.
 */
import type { ProviderAdapter, ProviderDispatchTarget } from "../../providers/provider-contracts";
import { GatewayError } from "../../protocol/gateway-error";
import { metrics } from "../../observability/metrics";
import { completeAttempt, estimatedUsage, nativeCompletionBase } from "./attempt-finalize";
import { runAttemptLoop } from "./attempt-loop";
import {
  hasScope,
  jsonResponse,
  networkFetchContext,
  requireRecordBody,
  resolveAttemptCredential,
  stripThinkingSuffix,
} from "./native-shared";

import type { GatewayHandlerDeps } from "./handler-deps";

type WebsearchHandlerDeps = GatewayHandlerDeps;

/** Adapter that can serve a web-search request. */
type WebsearchAdapter = ProviderAdapter & {
  websearch: NonNullable<ProviderAdapter["websearch"]>;
};

export function createWebsearchHandler(deps: WebsearchHandlerDeps) {
  return async ({ request }: { request: Request }): Promise<Response> => {
    const state = deps.stateStore.require(request);
    const authorization = state.authorization;
    const search = requireRecordBody(state, "The search body must be a JSON object (request {requestId}). Send one with at least a model and a query. Check the shape of what you sent — then resend 🪞");
    // `requireRecordBody` already refused a missing authorization; this guard
    // exists only to narrow the type for the code below.
    if (!authorization) {
      throw new GatewayError("invalid_request", 400, "authentication required (request {requestId})");
    }
    if (typeof search.model !== "string" || search.model.trim().length === 0)
      throw new GatewayError("invalid_request", 400, "A model is required (request {requestId}): it names the search provider to use. Check the shape of what you sent — then resend 🪞");
    // The search "model" names the provider (or an alias/combo of one). A
    // thinking suffix is stripped for the same reason the canonical preparer
    // strips it: it is not part of any registered id.
    const { bareModel, body: searchBody } = stripThinkingSuffix(search.model, search);
    if (!hasScope(authorization?.snapshot.scopes, "search:invoke")) {
      throw new GatewayError("policy_rejected", 403, "search not allowed for this key (request {requestId}) — enable search:invoke on the API key. Not allowed by policy — no hard feelings 🫂");
    }
    // Trust boundary only: the query must be a non-empty string. The adapter
    // validates the remaining shape when it maps the body onto its provider.
    if (typeof search.query !== "string" || search.query.trim().length === 0)
      throw new GatewayError("invalid_request", 400, "query is required (request {requestId}). Check the shape of what you sent — then resend 🪞");

    const prepared = await deps.proxyPreparer.prepareNativeService({
      model: bareModel,
      serviceKind: "websearch",
      authorization,
      ...(state.abortController.signal ? { signal: state.abortController.signal } : {}),
      ...(state.clientUserAgent === undefined ? {} : { clientUserAgent: state.clientUserAgent }),
    });
    return runAttemptLoop<Response, WebsearchAdapter>({
      state,
      deps,
      leaseSource: {
        admissionService: prepared.admissionService,
        routingEngine: prepared.routingEngine,
        plan: prepared.plan,
        estimatedInputTokens: prepared.estimatedInputTokens,
        estimatedOutputTokens: prepared.estimatedOutputTokens,
        authorizationSnapshot: prepared.authorization.snapshot,
      },
      candidates: prepared.candidates,
      tenantId: prepared.authorization.tenantId,
      strictPoolSelection: false,
      exhaustedError: new GatewayError("route_unavailable", 503, "no eligible search route (request {requestId}). The bouncer stepped out — come back shortly 🚪"),
      prepare: async (candidate) => {
        const credential = await resolveAttemptCredential(deps, candidate);
        const adapter = (await deps.resolveProviderAdapter?.(candidate.provider_id)) as WebsearchAdapter | undefined;
        if (!adapter || typeof adapter.websearch !== "function")
          throw new GatewayError(
            "capability_unsupported",
            400,
            "web search is unavailable for this provider (request {requestId}). Know your tools — this one just isn't in the box 🧰",
          );
        return { credential, adapter };
      },
      attempt: async (context) => {
        const { candidate, credential, leases, providerCapture } = context;
        const target: ProviderDispatchTarget = {
          provider_id: candidate.provider_id as ProviderAdapter["provider_id"],
          model_id: candidate.model_id,
          wire_family: candidate.wire_family,
          ...(candidate.output_limit == null ? {} : { output_limit: candidate.output_limit }),
          endpoint_path: candidate.endpoint,
          capabilities: candidate.capability_profile,
        };
        const upstreamBody =
          searchBody.model === candidate.model_id
            ? searchBody
            : { ...searchBody, model: candidate.model_id };
        const outcome = await context.adapter.websearch(upstreamBody, target, {
          credential,
          deadline: state.deadlineMs,
          abort_signal: state.abortController.signal,
          ...(candidate.user_agent === undefined ? {} : { user_agent: candidate.user_agent }),
          ...networkFetchContext(deps, leases.proxySlot?.poolId, authorization.tenantId),
        });
        const payload = {
          provider: candidate.provider_id,
          model: candidate.model_id,
          query: typeof upstreamBody.query === "string" ? upstreamBody.query : "",
          results: outcome.results,
          total_results: outcome.total_results ?? outcome.results.length,
          usage: { queries_used: 1 },
        };
        // Search consumes no model tokens; commit a zero-token usage so the
        // attempt is accounted and telemetry emits exactly once.
        const usage = estimatedUsage(0, 0);
        await completeAttempt(state, {
          status: "completed",
          ...nativeCompletionBase({
            providerId: candidate.provider_id,
            ...(candidate.provider_account_id ? { accountId: candidate.provider_account_id } : {}),
            ...(candidate.provider_account_label ? { accountLabel: candidate.provider_account_label } : {}),
            ...(leases.proxySlot ? { networkPoolId: leases.proxySlot.poolId } : {}),
            usage,
            modelId: candidate.model_id,
            lease: leases.lease,
            commitUsage: usage,
            tenantId: prepared.authorization.tenantId,
            ingressBody: state.ingressBody,
            providerCapture,
            db: deps.db,
            ...(deps.telemetryBuffer ? { telemetryBuffer: deps.telemetryBuffer } : {}),
            ...(deps.snapshotService ? { snapshotService: deps.snapshotService } : {}),
          }),
          responseBody: payload,
        });
        metrics.proxy_requests_total.inc(1, { status: "completed" });
        return jsonResponse(payload, 200, state.requestId);
      },
    });
  };
}
