/**
 * Vision-handoff sub-dispatch: describes the images of a canonical request by
 * calling a configured vision model, then returns the description text so the
 * caller can fold it back into the original request as text.
 *
 * The sub-request is a plain non-streaming chat request built from only the
 * user turns that carried images (no history, no tools, no system prompt) and
 * is dispatched through the shared attempt loop — admission, pool slot,
 * retry, cooldown, health, and accounting all ride the same policy as any
 * other route. Each model on the configured list is tried in order; the first
 * that produces non-empty text wins. This is what makes the fallback "if
 * vision model 1 is unhealthy, drop to the next one" work without a new
 * failover engine.
 */
import { createHash } from "node:crypto";
import { GatewayError } from "../protocol/gateway-error";
import { log } from "../observability/logger";
import type { CanonicalEvent, CanonicalMessage, CanonicalRequest, ContentPart } from "../protocol/canonical-model";
import type { ResolvedApiKey } from "../security/api-key-auth";
import type { ProviderAdapter } from "../providers/provider-contracts";
import { resolveCredentialForAccount } from "../providers/operations/provider-credential-service";
import { runAttemptLoop } from "./dispatch/attempt-loop";
import { completeAttempt, completionContext, estimatedUsage, terminalFailure } from "./dispatch/attempt-finalize";
import { repriceUsage } from "../providers/provider-usage";
import { projectForRoute, routeCapabilitiesFor } from "../protocol/translation/capabilities";
import { buildUpstreamDispatchContext } from "./dispatch/upstream";
import type { GatewayHandlerDeps } from "./dispatch/handler-deps";
import type { ByokUpstreamHost } from "../providers/operations/provider-catalog-service";
import type { PreparedProxyRequest } from "./request/preparer";
import { getCachedVisionDescription, hashImagePart, setCachedVisionDescription } from "./vision-handoff-cache";

/** Dependency surface needed to run a vision handoff (a gateway-handler deps). */
export interface VisionHandoffDeps extends GatewayHandlerDeps {
  /** Live lookup of a provider's SSRF-validated upstream host. */
  readonly byokUpstreamHosts?: { readonly get: (providerId: string) => ByokUpstreamHost | undefined };
}

/** Instruction prepended to the first image-carrying user turn. */
const VISION_HANDOFF_INSTRUCTION =
  "Describe the contents of the image(s) attached to this message. Be factual, " +
  "concise, and specific: mention visible text, people, objects, layout, colors, " +
  "and anything else notable.";

/** Minimum remaining deadline before we attempt a handoff at all. */
const VISION_HANDOFF_MIN_BUDGET_MS = 2_000;

/** Per-model budget cap so one slow vision model cannot eat the whole deadline. */
const VISION_HANDOFF_PER_MODEL_TIMEOUT_MS = 12_000;

/** The result of one successful handoff. */
export interface VisionHandoffResult {
  readonly description: string;
  readonly model: string;
}

/** Inputs for running the handoff across an ordered model list. */
export interface VisionHandoffInput {
  /** The canonical request that still carries image parts. */
  readonly canonicalRequest: CanonicalRequest;
  /** Ordered vision-model ids (`provider/model`), priority first. */
  readonly models: readonly string[];
  readonly authorization: ResolvedApiKey;
  readonly deadlineMs: number;
  readonly signal?: AbortSignal;
  readonly clientUserAgent?: string;
}

/** The shape the preparer calls; matches `runVisionHandoff` in preparer deps. */
export interface VisionHandoffCall {
  readonly canonicalRequest: CanonicalRequest;
  readonly authorization: ResolvedApiKey;
  readonly deadlineMs: number;
  readonly signal?: AbortSignal;
  readonly clientUserAgent?: string;
}

/**
 * True when a content part is an image or the legacy `[image]` placeholder
 * that a degraded (non-image-capable) route substitutes for one.
 */
export function isImageOrPlaceholderPart(part: ContentPart): boolean {
  return part.kind === "image" || (part.kind === "text" && part.text === "[image]");
}

/**
 * Index of the last user turn that carries images (or their `[image]`
 * placeholders). The handoff describes only this turn; older image-carrying
 * turns are history and are dropped by the caller's replacement pass (they
 * are not sent to the vision model either).
 */
export function lastImageCarryingUserTurnIndex(request: CanonicalRequest): number {
  for (let i = request.messages.length - 1; i >= 0; i -= 1) {
    const message = request.messages[i]!;
    if (message.role === "user" && message.content.some(isImageOrPlaceholderPart)) {
      return i;
    }
  }
  return -1;
}

/** Index of the last user turn that carries a real image (not a placeholder). */
function lastRealImageCarryingUserTurnIndex(request: CanonicalRequest): number {
  for (let i = request.messages.length - 1; i >= 0; i -= 1) {
    const message = request.messages[i]!;
    if (message.role === "user" && message.content.some((part) => part.kind === "image")) {
      return i;
    }
  }
  return -1;
}

/** Hash of the active image set (the last image-carrying user turn's images). */
function hashActiveImageSet(request: CanonicalRequest): string {
  const index = lastRealImageCarryingUserTurnIndex(request);
  if (index < 0) return "";
  const images = request.messages[index]!.content.filter(
    (part): part is { kind: "image"; payload: unknown } => part.kind === "image",
  );
  const hashes = images.map(hashImagePart).sort();
  return createHash("sha256").update(hashes.join("|")).digest("hex");
}

/**
 * Builds the sub-request sent to one vision model: only the *last*
 * image-carrying user turn, keeping its sibling text parts, prefixed by a
 * short describe-the-image instruction. No history, no tools, no system
 * prompt. The sub-request streams internally (`stream = true`) so the parent
 * keeps its own streaming reply once the description is folded in; the
 * description itself must still be whole before the parent is dispatched.
 */
export function buildVisionSubRequest(parent: CanonicalRequest, model: string): CanonicalRequest {
  const index = lastRealImageCarryingUserTurnIndex(parent);
  if (index < 0) {
    throw new GatewayError(
      "invalid_request",
      400,
      "vision handoff cannot build a sub-request from a request with no image-carrying user turns (request {requestId})",
    );
  }
  const message = parent.messages[index]!;
  const kept = message.content.filter((part) => part.kind === "text" || part.kind === "image");
  const messages: CanonicalMessage[] = [
    { role: "user", content: [{ kind: "text", text: VISION_HANDOFF_INSTRUCTION }, ...kept] },
  ];
  return {
    model,
    messages,
    generation_controls: {},
    stream: true,
    source_surface: "chat",
  };
}

/**
 * Tries the ordered vision-model list and returns every description produced
 * (one per model that answered). Each model gets its own attempt-loop
 * sub-dispatch with its own admission/pool slot (isolated from the parent
 * request) and its own child request state. Any failure — an unroutable or
 * unauthorized model, an upstream error, an empty reply — falls through to
 * the next entry.
 */
export async function tryVisionHandoff(
  deps: VisionHandoffDeps,
  input: VisionHandoffCall,
  models: readonly string[],
): Promise<readonly VisionHandoffResult[]> {
  // Reusing the exact same active image set (same image, same conversation
  // replay) skips the vision call entirely.
  const cacheHash = hashActiveImageSet(input.canonicalRequest);
  const cached = cacheHash.length > 0 ? getCachedVisionDescription(cacheHash) : undefined;
  if (cached !== undefined && cached.trim().length > 0) {
    return [{ description: cached.trim(), model: models[0] ?? "cache" }];
  }

  const results: readonly VisionHandoffResult[] = await trialModelsInParallel(deps, input, models);
  if (cacheHash.length > 0 && results.length > 0) {
    setCachedVisionDescription(cacheHash, results[0]!.description);
  }
  return results;
}

/** Tries the ordered vision-model list, in parallel, with a per-model budget. */
async function trialModelsInParallel(
  deps: VisionHandoffDeps,
  input: VisionHandoffCall,
  models: readonly string[],
): Promise<readonly VisionHandoffResult[]> {
  if (models.length === 0) return [];
  const remaining = input.deadlineMs - Date.now();
  if (remaining <= VISION_HANDOFF_MIN_BUDGET_MS) return [];

  const perModelBudget = Math.min(
    remaining,
    VISION_HANDOFF_PER_MODEL_TIMEOUT_MS,
  );
  const decided = await Promise.all(
    models.map((model) => trialOneModel(deps, input, model, perModelBudget)),
  );
  return decided.filter(
    (result): result is VisionHandoffResult => result !== null,
  );
}

/** Runs one vision-model trial with its own attempt-loop. Null on any failure. */
async function trialOneModel(
  deps: VisionHandoffDeps,
  input: VisionHandoffCall,
  model: string,
  budgetMs: number,
): Promise<VisionHandoffResult | null> {
  const childRequest = new Request("http://cartethyia.invalid/vision-handoff", {
    method: "POST",
  });
  const childState = deps.stateStore.initialize(childRequest, Date.now(), budgetMs);
  childState.authorization = input.authorization;
  childState.ingressBody = null;
  try {
    let prepared: PreparedProxyRequest;
    try {
      prepared = await deps.proxyPreparer.prepare({
        canonicalRequest: buildVisionSubRequest(input.canonicalRequest, model),
        authorization: input.authorization,
        deadlineMs: budgetMs,
        // The sub-request itself must never trigger a nested handoff.
        disableVisionHandoff: true,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
        ...(input.clientUserAgent === undefined ? {} : { clientUserAgent: input.clientUserAgent }),
      });
    } catch (error) {
      // Unroutable / not allowed for this key / no account — try the next.
      log.warn("[vision-handoff] vision model skipped", {
        model,
        tenantId: input.authorization.tenantId,
        reason: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
    if (prepared.candidate.capability_profile.image !== true) return null;
    childState.canonicalRequest = prepared.canonicalRequest;
    childState.preparedRequest = prepared;

    const text = await runAttemptLoop<string, ProviderAdapter>({
      state: childState,
      deps,
      leaseSource: {
        admissionService: prepared.admissionService,
        routingEngine: prepared.routingEngine,
        plan: prepared.plan,
        estimatedInputTokens: prepared.estimatedInputTokens,
        estimatedOutputTokens: prepared.estimatedOutputTokens,
        authorizationSnapshot: prepared.authorization.snapshot,
      },
      candidates:
        prepared.eligibleRouteCandidates.length > 0
          ? prepared.eligibleRouteCandidates
          : [prepared.candidate],
      tenantId: prepared.authorization.tenantId,
      strictPoolSelection: true,
      resolveHost: (candidate) => deps.byokUpstreamHosts?.get(candidate.provider_id),
      exhaustedError: new GatewayError(
        "route_unavailable",
        503,
        "no eligible vision route (request {requestId}). The bouncer stepped out — come back shortly 🚪",
      ),
      prepare: async (candidate) => {
        if (!candidate.provider_account_id && candidate.requires_account !== false) {
          throw new GatewayError(
            "route_unavailable",
            503,
            "This route has no usable credential (request {requestId}). Save one on the account, or route to a provider whose account is configured. Wrong key, right door — check the credential 🔑",
          );
        }
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
              provider_id: candidate.provider_id as ProviderAdapter["provider_id"],
              credential_kind: "none" as const,
            };
        const adapter = await deps.resolveProviderAdapter?.(candidate.provider_id);
        if (!adapter) {
          throw new GatewayError(
            "route_unavailable",
            503,
            "provider adapter not registered (request {requestId}). Even we have bad days — check the registry wiring 🐻",
          );
        }
        return { credential, adapter };
      },
      attempt: async (context) => {
        const { candidate, credential, adapter, leases } = context;
        const candidateRequest =
          candidate.model_id === prepared.canonicalRequest.model
            ? prepared.canonicalRequest
            : { ...prepared.canonicalRequest, model: candidate.model_id };
        const attemptRequest = projectForRoute(candidateRequest, routeCapabilitiesFor(candidate));
        const providerRouteCandidate = {
          provider_id: candidate.provider_id,
          model_id: candidate.model_id,
          wire_family: candidate.wire_family,
          endpoint_path: candidate.endpoint,
          ...(candidate.output_limit == null ? {} : { output_limit: candidate.output_limit }),
          capabilities: candidate.capability_profile,
          user_agent: candidate.user_agent,
        };
        const dispatchContextBase = buildUpstreamDispatchContext({
          credential,
          deadline: childState.deadlineMs,
          signal: childState.abortController.signal,
          headers: {},
          requestId: childState.requestId,
          ...(candidate.user_agent === undefined ? {} : { userAgent: candidate.user_agent }),
          ...(deps.networkBindingFactory
            ? {
                outboundFetch: deps.networkBindingFactory.fetch(
                  leases.proxySlot?.poolId ?? "",
                  prepared.authorization.tenantId,
                ),
              }
            : {}),
        });
        const events: CanonicalEvent[] = [];
        for await (const event of adapter.dispatch(
          attemptRequest,
          providerRouteCandidate as never,
          dispatchContextBase as never,
        )) {
          events.push(event);
        }
        const terminal = events.find((event) => event.type === "terminal");
        if (terminal === undefined) throw terminalFailure(undefined);
        const terminalError = terminalFailure(terminal);
        if (terminalError !== undefined) throw terminalError;
        let text = "";
        for (const event of events) {
          if (event.type === "content_delta" && event.content.kind === "text") {
            text += event.content.text;
          }
        }
        const usage =
          terminal.usage ??
          estimatedUsage(prepared.estimatedInputTokens, prepared.estimatedOutputTokens);
        const pricedUsage = repriceUsage(usage, candidate.provider_id, candidate.model_id);
        await completeAttempt(childState, {
          status: "completed",
          ...completionContext({
            providerId: candidate.provider_id,
            modelId: candidate.model_id,
            tenantId: prepared.authorization.tenantId,
            ingressBody: null,
            db: deps.db,
            ...(candidate.provider_account_id ? { accountId: candidate.provider_account_id } : {}),
            ...(candidate.provider_account_label ? { accountLabel: candidate.provider_account_label } : {}),
            ...(leases.proxySlot ? { networkPoolId: leases.proxySlot.poolId } : {}),
            ...(leases.lease ? { lease: leases.lease } : {}),
            ...(deps.telemetryBuffer ? { telemetryBuffer: deps.telemetryBuffer } : {}),
            ...(deps.snapshotService ? { snapshotService: deps.snapshotService } : {}),
          }),
          usage: pricedUsage,
          commitUsage: pricedUsage,
          responseBody: null,
          clientResponseText: text,
        });
        return text;
      },
    });
    if (text.trim().length === 0) return null;
    return { description: text.trim(), model };
  } catch (error) {
    log.warn("[vision-handoff] vision model attempt failed", {
      model,
      tenantId: input.authorization.tenantId,
      reason: error instanceof Error ? error.message : String(error),
    });
    return null;
  } finally {
    childState.cleanup();
  }
}
