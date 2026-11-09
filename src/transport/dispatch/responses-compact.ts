import { GatewayError } from "../../protocol/gateway-error";
import { metrics } from "../../observability/metrics";
import type { CodexCompactAdapter } from "../../providers/integrations/codex/codex";
import { completeAttempt, estimatedUsage, nativeCompletionBase } from "./attempt-finalize";
import { runAttemptLoop } from "./attempt-loop";
import {
  forwardUpstreamResponse,
  networkFetchContext,
  requireRecordBody,
  resolveAttemptCredential,
  stripThinkingSuffix,
  usageFromUpstreamClone,
} from "./native-shared";

/**
 * The native Codex compaction route (`POST /v1/responses/compact`) and the
 * dependency surface it needs to drive `runAttemptLoop`.
 */
import type { GatewayHandlerDeps } from "./handler-deps";

type ResponsesCompactHandlerDeps = GatewayHandlerDeps;

/**
 * Handles `POST /v1/responses/compact`: the native Codex compaction proxy. The
 * wire body stays opaque — it is neither parsed nor projected — but routing,
 * admission, retry, accounting, and telemetry run through the same attempt
 * loop as the canonical proxy routes.
 */
export function createResponsesCompactHandler(deps: ResponsesCompactHandlerDeps) {
  return async ({ request }: { request: Request }): Promise<Response> => {
    const state = deps.stateStore.require(request);
    const authorization = state.authorization;
    const compact = requireRecordBody(
      state,
      "compact request body must be a JSON object (request {requestId}). Check the shape of what you sent — then resend 🪞",
    );
    if (typeof compact.model !== "string" || compact.model.trim().length === 0)
      throw new GatewayError("invalid_request", 400, "model is required (request {requestId}). Check the shape of what you sent — then resend 🪞");
    // A thinking suffix (`model(high)`) is stripped here for the same reason the
    // canonical preparer strips it: this route matches the model name against
    // the allowlist and the route plan, and `(high)` is not part of any
    // registered id. The level itself is dropped rather than applied —
    // compaction is a context operation, not a generation, so there is no
    // reasoning effort to shape, and the body is passed upstream verbatim.
    // Stripping keeps a client that appends the suffix to every request working
    // here instead of failing with a misleading model-not-found.
    const { bareModel: compactModel, body: compactBody } = stripThinkingSuffix(compact.model, compact);
    if (!(typeof compact.input === "string" || Array.isArray(compact.input)))
      throw new GatewayError("invalid_request", 400, "input must be a string or array (request {requestId}). Check the shape of what you sent — then resend 🪞");
    if ("instructions" in compact && typeof compact.instructions !== "string")
      throw new GatewayError("invalid_request", 400, "instructions must be a string (request {requestId}). Check the shape of what you sent — then resend 🪞");
    if (compact.stream === true)
      throw new GatewayError(
        "capability_unsupported",
        400,
        "Responses compact does not support streaming (request {requestId}). Know your tools — this one just isn't in the box 🧰",
      );
    const adapter = (await deps.resolveProviderAdapter?.("codex")) as CodexCompactAdapter | undefined;
    if (!adapter || typeof adapter.compact !== "function")
      throw new GatewayError("admission_unavailable", 503, "Codex compact transport unavailable (request {requestId}). The bouncer stepped out — come back shortly 🚪");
    const prepared = await deps.proxyPreparer.prepareNativeCompact({
      model: compactModel,
      authorization: authorization!,
      signal: state.abortController.signal,
      ...(state.clientUserAgent === undefined ? {} : { clientUserAgent: state.clientUserAgent }),
    });
    return runAttemptLoop<Response, CodexCompactAdapter>({
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
      // Lenient pool semantics: a missing slot tolerates direct egress.
      strictPoolSelection: false,
      exhaustedError: new GatewayError(
        "route_unavailable",
        503,
        "no eligible Codex route (request {requestId}). The bouncer stepped out — come back shortly 🚪",
      ),
      prepare: async (candidate) => {
        if (!candidate.provider_account_id)
          throw new GatewayError(
            "route_unavailable",
            503,
            "Codex compact requires an OAuth account (request {requestId}). Wrong key, right door — check the credential 🔑",
          );
        const credential = await resolveAttemptCredential(deps, {
          ...candidate,
          provider_id: "codex",
        });
        if (credential.credential_kind !== "oauth")
          throw new GatewayError(
            "capability_unsupported",
            400,
            "Responses compact requires a Codex ChatGPT OAuth account (request {requestId}). Wrong key, right door — check the credential 🔑",
          );
        return { credential, adapter };
      },
      attempt: async (context) => {
        const { candidate, credential, leases, providerCapture } = context;
        const response = await adapter.compact(compactBody, {
          credential,
          deadline: state.deadlineMs,
          abort_signal: state.abortController.signal,
          ...networkFetchContext(deps, leases.proxySlot?.poolId, authorization!.tenantId),
        });
        // Prefer the usage the compaction endpoint actually reported. The
        // estimate is a fixed 1024+1024 reserve, and compaction is by
        // construction a large-input operation, so charging it unconditionally
        // let real spend run far past the counter. `usageFromUpstreamClone`
        // falls back to the estimate when the body reported nothing, and
        // `response.clone()` leaves the body readable for the client.
        const usage = await usageFromUpstreamClone(
          response,
          estimatedUsage(prepared.estimatedInputTokens, prepared.estimatedOutputTokens),
          candidate.provider_id,
          candidate.model_id,
        );
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
          responseBody: null,
        });
        metrics.proxy_requests_total.inc(1, { status: "completed" });
        return forwardUpstreamResponse(response, state.requestId);
      },
    });
  };
}
