/**
 * The native generation routes: `POST /v1/images/generations` and `POST
 * /v1/videos/generations`.
 *
 * A generation request is not chat-shaped — the caller sends `{model, prompt,
 * n, …}` and receives media — so routing it through the canonical chat codec
 * would either invent fields or drop the ones that matter. Both surfaces take
 * the shape of the web-search handler: validate the trust boundary, drive
 * `runAttemptLoop`, then hand back what the upstream produced.
 *
 * One handler serves both kinds because the only difference is the
 * `serviceKind` the route filters candidates by and the word used in errors.
 * Duplicating this for video would mean two copies of the same streaming,
 * accounting, and credential logic to keep in step.
 *
 * The video route is deliberately mounted with no model behind it: the operator
 * wants the surface present so it can be finished when an upstream is known,
 * and a missing route answers 404 in a way that looks like a typo rather than
 * an unfinished capability.
 */
import type { ImageGenerationOutcome, ProviderAdapter, ProviderDispatchTarget } from "../../providers/provider-contracts";
import { GatewayError } from "../../protocol/gateway-error";
import type { ServiceKind } from "../../protocol/canonical-model";
import { metrics } from "../../observability/metrics";
import type { ProxyRequestState } from "../request/state";
import { completeAttempt, estimatedUsage, nativeCompletionBase } from "./attempt-finalize";
import { runAttemptLoop } from "./attempt-loop";
import { captureProviderRateLimit } from "./ratelimit-capture";
import {
  hasScope,
  jsonResponse,
  networkFetchContext,
  requireRecordBody,
  resolveAttemptCredential,
} from "./native-shared";

import type { GatewayHandlerDeps } from "./handler-deps";

type GenerationHandlerDeps = GatewayHandlerDeps;

/** Which surface a handler serves. Drives candidate filtering and error copy. */
type GenerationKind = Extract<ServiceKind, "imageGeneration" | "videoGeneration">;

/**
 * Surfaces the gateway routes but does not model.
 *
 * Embeddings and audio have no adapter method and no media shape — there is
 * nothing for this repo to translate — so they exist purely so a caller can
 * reach a compatible upstream through the normal pipeline. Opening the route
 * is the whole feature: routing, admission, failover, and accounting still
 * apply, and the upstream's own bytes come back untouched.
 */
type PassthroughKind = Extract<ServiceKind, "embedding" | "audioTranscription" | "audioSpeech">;

/** Error-copy noun per surface, so a refusal names what the caller asked for. */
const SURFACE_NOUNS: Record<GenerationKind | PassthroughKind, string> = {
  imageGeneration: "image",
  videoGeneration: "video",
  embedding: "embedding",
  audioTranscription: "transcription",
  audioSpeech: "speech",
};

/**
 * Only the two media surfaces carry `prompt`/`n`.
 *
 * An embedding body is `{model, input}` and a transcription is multipart —
 * neither has a prompt, so validating one here would reject every legitimate
 * request to a surface the gateway just opened.
 */
function isMediaKind(kind: GenerationKind | PassthroughKind): kind is GenerationKind {
  return kind === "imageGeneration" || kind === "videoGeneration";
}

/**
 * Maximum items one request may ask for.
 *
 * A bound on upstream fan-out, not a product limit: every item is billed to the
 * caller, so an unbounded `n` is an easy way to spend someone else's quota.
 */
const MAX_ITEMS_PER_REQUEST = 10;

/**
 * Forwards a streaming upstream response to the client and accounts for it.
 *
 * A generated result can arrive as SSE, and the frames are the client's to
 * read: parsing them here fails on the first `data:` frame, and buffering the
 * whole stream would hold a multi-megabyte response in memory the caller is
 * waiting to consume. The attempt is still finalized first, so telemetry and
 * accounting behave the same as on the JSON path.
 */
async function passThrough(
  state: ProxyRequestState,
  upstream: Response,
  args: {
    readonly candidate: {
      provider_id: string;
      model_id: string;
      provider_account_id?: string;
      provider_account_label?: string;
    };
    readonly lease: unknown;
    readonly networkPoolId?: string;
    readonly tenantId: string;
    readonly providerCapture: unknown;
    readonly deps: GenerationHandlerDeps;
  },
): Promise<Response> {
  const usage = estimatedUsage(0, 0);
  // The CLI bucket comes back on every upstream response, so this is the free
  // place to learn it: the quota surface then reads the stored value instead of
  // spending a request of its own. Both the manual account test and automatic
  // routing land here, so a captured reading follows real traffic.
  captureProviderRateLimit(args.candidate.provider_id, args.candidate.provider_account_id, upstream.headers);
  await completeAttempt(state, {
    status: "completed",
    ...nativeCompletionBase({
      providerId: args.candidate.provider_id,
      ...(args.candidate.provider_account_id ? { accountId: args.candidate.provider_account_id } : {}),
      ...(args.candidate.provider_account_label ? { accountLabel: args.candidate.provider_account_label } : {}),
      ...(args.networkPoolId ? { networkPoolId: args.networkPoolId } : {}),
      usage,
      modelId: args.candidate.model_id,
      lease: args.lease as never,
      commitUsage: usage,
      tenantId: args.tenantId,
      ingressBody: state.ingressBody,
      providerCapture: args.providerCapture as never,
      db: args.deps.db,
      ...(args.deps.telemetryBuffer ? { telemetryBuffer: args.deps.telemetryBuffer } : {}),
      ...(args.deps.snapshotService ? { snapshotService: args.deps.snapshotService } : {}),
    }),
    responseBody: null,
  });
  metrics.proxy_requests_total.inc(1, { status: "completed" });
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      "content-type": upstream.headers.get("content-type") ?? "text/event-stream",
      "cache-control": "no-store",
      "x-request-id": state.requestId,
    },
  });
}

/** Builds the handler for one generation surface. */
function createGenerationHandler(kind: GenerationKind, deps: GenerationHandlerDeps) {
  return createNativeSurfaceHandler(kind, deps);
}

/** Builds the handler for one routed surface, media or passthrough. */
function createNativeSurfaceHandler(
  kind: GenerationKind | PassthroughKind,
  deps: GenerationHandlerDeps,
) {
  const noun = SURFACE_NOUNS[kind];
  return async ({ request }: { request: Request }): Promise<Response> => {
    const state = deps.stateStore.require(request);
    const authorization = state.authorization;
    const generation = requireRecordBody(
      state,
      `The ${noun} body must be a JSON object (request {requestId}). Send one with at least a model and a prompt. Check the shape of what you sent — then resend 🪞`,
    );
    if (typeof generation.model !== "string" || generation.model.trim().length === 0) {
      throw new GatewayError("invalid_request", 400, `A model is required (request {requestId}): it names the ${noun} provider to use. Check the shape of what you sent — then resend 🪞`);
    }
    if (!hasScope(authorization?.snapshot.scopes, "routing:invoke")) {
      throw new GatewayError(
        "policy_rejected",
        403,
        `${noun} generation not allowed for this key (request {requestId}) — enable routing:invoke on the API key. Not allowed by policy — no hard feelings 🫂`,
      );
    }
    // Trust boundary only. Keep accepting `messages` for chat-backed providers
    // while native image/video endpoints can use the simpler `prompt` field.
    if (isMediaKind(kind)) {
      const hasPrompt = typeof generation.prompt === "string" && generation.prompt.trim().length > 0;
      const hasMessages = Array.isArray(generation.messages) && generation.messages.length > 0;
      if (!hasPrompt && !hasMessages) {
        throw new GatewayError("invalid_request", 400, "prompt is required (request {requestId}). Check the shape of what you sent — then resend 🪞");
      }
      if (generation.n !== undefined) {
        const n = generation.n;
        if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > MAX_ITEMS_PER_REQUEST) {
          throw new GatewayError(
            "invalid_request",
            400,
            `n must be an integer between 1 and ${MAX_ITEMS_PER_REQUEST} (request {requestId}). Check the shape of what you sent — then resend 🪞`,
          );
        }
      }
    }

    const prepared = await deps.proxyPreparer.prepareNativeService({
      model: generation.model,
      serviceKind: kind,
      // `requireRecordBody` already refused a missing authorization; this guard
      // exists only to narrow the type for the code below.
      authorization: authorization!,
      ...(state.abortController.signal ? { signal: state.abortController.signal } : {}),
      ...(state.clientUserAgent === undefined ? {} : { clientUserAgent: state.clientUserAgent }),
    });
    if (!authorization) {
      throw new GatewayError("invalid_request", 400, "authentication required (request {requestId})");
    }

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
      },
      candidates: prepared.candidates,
      tenantId: prepared.authorization.tenantId,
      strictPoolSelection: false,
      exhaustedError: new GatewayError("route_unavailable", 503, `no eligible ${noun} generation route (request {requestId}). The bouncer stepped out — come back shortly 🚪`),
      prepare: async (candidate) => {
        const credential = await resolveAttemptCredential(deps, candidate);
        const adapter = await deps.resolveProviderAdapter?.(candidate.provider_id);
        if (!adapter) {
          throw new GatewayError(
            "capability_unsupported",
            400,
            `${noun} generation is unavailable for this provider (request {requestId}). Know your tools — this one just isn't in the box 🧰`,
          );
        }
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
        // Name the model the route actually resolved to: a caller may address a
        // model through an alias, and the upstream must see the real id.
        const upstreamBody =
          generation.model === candidate.model_id
            ? generation
            : { ...generation, model: candidate.model_id };

        const adapter = context.adapter;
        const finish = async (
          response: Record<string, unknown> | ImageGenerationOutcome,
        ): Promise<Response> => {
          const payload = {
            provider: candidate.provider_id,
            model: candidate.model_id,
            ...response,
          };
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
        };

        const inboundHeaders: Record<string, string> = {};
        request.headers.forEach((value, name) => {
          inboundHeaders[name.toLowerCase()] = value;
        });
        // Dispatch context shared by every media path below. The inbound
        // headers ride along so a buddy probe carries the same conversation
        // family a chat request does — without them the upstream answers
        // `400 · 11-128 "conversation id missing"`.
        const mediaContext = {
          credential,
          deadline: state.deadlineMs,
          abort_signal: state.abortController.signal,
          request_headers: inboundHeaders,
          ...(candidate.user_agent === undefined ? {} : { user_agent: candidate.user_agent }),
          ...networkFetchContext(deps, leases.proxySlot?.poolId, authorization.tenantId),
        };
        // Prefer the provider's own method for this kind; otherwise post the
        // body to the candidate's endpoint through the adapter, which owns the
        // upstream base URL. Either way the gateway does not interpret the
        // media — it returns what the upstream produced.
        //
        // A passthrough surface has no media method to prefer: the whole point
        // is that this repo does not model it, so it goes straight to the
        // adapter's native dispatch, which is plain forwarding.
        const media =
          !isMediaKind(kind)
            ? undefined
            : kind === "videoGeneration"
              ? typeof adapter.generateVideo === "function"
                ? adapter.generateVideo(upstreamBody, target, mediaContext).then((outcome) => finish(outcome))
                : undefined
              : typeof adapter.generateImage === "function"
                ? adapter.generateImage(upstreamBody, target, mediaContext).then((outcome) => finish(outcome))
                : undefined;
        const upstream =
          media !== undefined
            ? await media
            : typeof adapter.dispatchNativeService !== "function"
              ? Promise.reject(
                  new GatewayError(
                    "capability_unsupported",
                    400,
                    `${noun} generation is unavailable for this provider (request {requestId}). Know your tools — this one just isn't in the box 🧰`,
                  ),
                )
              : adapter
                  .dispatchNativeService(upstreamBody, target, mediaContext)
                  .then(async (res) => {
                    const contentType = res.headers.get("content-type") ?? "";
                    if (contentType.includes("text/event-stream")) {
                      return passThrough(state, res, {
                        candidate,
                        lease: leases.lease,
                        ...(leases.proxySlot ? { networkPoolId: leases.proxySlot.poolId } : {}),
                        tenantId: prepared.authorization.tenantId,
                        providerCapture,
                        deps,
                      });
                    }
                    const parsed: unknown = await res.json();
                    return finish(
                      typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
                        ? (parsed as Record<string, unknown>)
                        : { data: [parsed] },
                    );
                  });
        return upstream;
      },
    });
  };
}

/** `POST /v1/images/generations`. */
export function createImageGenerationHandler(deps: GenerationHandlerDeps) {
  return createGenerationHandler("imageGeneration", deps);
}

/** `POST /v1/videos/generations`. */
export function createVideoGenerationHandler(deps: GenerationHandlerDeps) {
  return createGenerationHandler("videoGeneration", deps);
}

/**
 * `POST /v1/embeddings`.
 *
 * Routed with no provider implementation behind it: a model row carrying the
 * `embedding` kind is enough, and the adapter forwards the body as-is.
 */
export function createEmbeddingHandler(deps: GenerationHandlerDeps) {
  return createNativeSurfaceHandler("embedding", deps);
}

/** `POST /v1/audio/transcriptions`. Same passthrough shape as embeddings. */
export function createAudioTranscriptionHandler(deps: GenerationHandlerDeps) {
  return createNativeSurfaceHandler("audioTranscription", deps);
}

/** `POST /v1/audio/speech`. Same passthrough shape as embeddings. */
export function createAudioSpeechHandler(deps: GenerationHandlerDeps) {
  return createNativeSurfaceHandler("audioSpeech", deps);
}
