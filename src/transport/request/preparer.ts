import { GatewayError } from "../../protocol/gateway-error";
import type { CanonicalRequest, ServiceKind } from "../../protocol/canonical-model";
import type { ApiKeyAdmissionService } from "../../security/admission/service";
import type { VisionHandoffCall, VisionHandoffResult } from "../vision-handoff";
import type { CallerIdentity } from "../../security/access-control";
import type { RouteCandidate as RouteCandidate, InMemoryRouteSnapshotService, RoutePlan, RouteSnapshot } from "../routing/route-model";
import {
  resolveAliasTarget,
} from "../routing/alias-resolution"
import type {
  RoutingEngine,
} from "../routing/routing-engine";
import { projectForRoute, routeCapabilitiesFor, deriveRequiredCapabilities } from "../../protocol/translation/capabilities";
import type { RequiredCapability } from "../../protocol/translation/capabilities";
import { isModelAllowed, type ResolvedApiKey } from "../../security/api-key-auth";
import { allowsCliToolMappings } from "../../security/cli-client-fingerprint";
import { dropIncompleteToolRounds, repairRequestToolCalls } from "../../protocol/translation/tool-repair";
import { sanitizeRequestToolIds } from "../../protocol/translation/tool-id";
import { redeclareWithdrawnTools } from "../../protocol/request/sent-tools";
import { truncateToolResults } from "../../protocol/tool-result-truncate";
import { resolveToolResultMaxKb } from "../../config/runtime";
import { dropCorruptAttachments } from "../../protocol/translation/attachment-integrity";
import { parseThinkingSuffix, withThinkingSuffixIntent } from "../../protocol/translation/thinking";
import { nativeServicePathFor } from "../contracts";
import { log } from "../../observability/logger";
import { BUDDY_PROVIDER_IDS } from "../../providers/provider-metadata";
import {
  degradedRequestVariants,
  degradeEncryptedReasoning,
  shouldWarnDegradation,
} from "./degradation";
import { DEFAULT_ESTIMATED_OUTPUT_TOKENS, estimateInputTokens } from "./token-estimate";
import { condenseHandoffRequest, replaceImagePartsWithText } from "./vision-rewrite";

export { condenseHandoffRequest } from "./vision-rewrite";

/** True when the request carries tools or message parts that need repair/sanitize. */
function requestNeedsToolRepair(request: CanonicalRequest): boolean {
  if (request.tools !== undefined && request.tools.length > 0) return true;
  for (const message of request.messages) {
    for (const part of message.content) {
      if (part.kind === "toolCall" || part.kind === "toolResult") return true;
    }
  }
  return false;
}

export interface PreparedProxyRequest {
  readonly canonicalRequest: CanonicalRequest;
  readonly authorization: ResolvedApiKey;
  readonly candidate: RouteCandidate;
  /** Ordered fallback candidates already filtered for capability support (includes primary). */
  readonly eligibleRouteCandidates: readonly RouteCandidate[];
  /** Capabilities stripped from the original request to achieve eligibility. */
  readonly degradedCapabilities?: readonly RequiredCapability[];
  /** Snapshot-consistent plan used to reserve each individual attempt. */
  readonly plan: RoutePlan;
  /** Single "who is speaking" identity, derived at auth. */
  readonly caller: CallerIdentity;
  readonly estimatedInputTokens: number;
  readonly estimatedOutputTokens: number;
  readonly deadlineMs: number;
  readonly routingEngine: RoutingEngine;
  readonly admissionService: ApiKeyAdmissionService;
}

/** Routing and admission inputs for a native body that must not enter canonical translation. */
export interface PreparedNativeRequest {
  readonly authorization: ResolvedApiKey;
  readonly candidates: readonly RouteCandidate[];
  readonly plan: RoutePlan;
  readonly estimatedInputTokens: number;
  readonly estimatedOutputTokens: number;
  readonly routingEngine: RoutingEngine;
  readonly admissionService: ApiKeyAdmissionService;
}

interface ProxyRequestPreparerDeps {
  readonly snapshotService: InMemoryRouteSnapshotService;
  readonly routingEngine: RoutingEngine;
  readonly admissionService: ApiKeyAdmissionService;
}

export class ProxyRequestPreparer {
  /**
   * Vision-handoff runner, injected by boot once the request state store and
   * the full dispatch dependency surface exist. Absent (or when the feature is
   * not configured) means the legacy `[image]` placeholder path.
   */
  #runVisionHandoff: ((input: VisionHandoffCall) => Promise<readonly VisionHandoffResult[]>) | undefined;

  constructor(private readonly deps: ProxyRequestPreparerDeps) {}

  /**
   * The key's model-admission gate, shared by the canonical and native
   * preparation paths: CLI-mapping eligibility → alias resolution → the
   * model allowlist → the model-prefix gate, in that exact order. Rejects
   * with the same `model_not_allowed` 403s (same code, status, message, and
   * detail fields) on both paths, so a policy change here cannot silently
   * split admission between the chat and native surfaces. Returns the state
   * the gate computed that the caller still needs for routing: the resolved
   * alias target and whether CLI mappings were eligible.
   */
  #resolveAliasAndGateModel(
    model: string,
    authorization: ResolvedApiKey,
    clientUserAgent: string | undefined,
    snapshot: RouteSnapshot,
  ): { readonly resolvedTarget: string; readonly allowCliMappings: boolean } {
    // Scope opts the key into the mapping table; the User-Agent decides whether
    // *this* request may consume it. Without the UA gate, a Claude→DeepSeek
    // remap would also rewrite a non-Claude caller that named `opus`.
    const allowCliMappings = allowsCliToolMappings(authorization.scopes, {
      ...(clientUserAgent === undefined ? {} : { userAgent: clientUserAgent }),
    });
    // CLI source→target mappings are an explicit API-key capability. Ordinary
    // tenant aliases remain available to every key; only selected keys may
    // consume the CLI mapping table.
    const resolvedTarget = resolveAliasTarget(
      snapshot,
      authorization.tenantId,
      model,
      allowCliMappings,
      authorization.cliMappingOwnerId ?? authorization.id,
    );
    // Pass `model` as the requested name so an allowlisted alias / a CLI
    // remapping can authorize the resolved target (see modelRejectionReason).
    const allowedForKey = isModelAllowed(authorization.snapshot, resolvedTarget, undefined, model);
    if (
      authorization.modelPrefix &&
      !model.startsWith(authorization.modelPrefix) &&
      !resolvedTarget.startsWith(authorization.modelPrefix) &&
      !allowedForKey
    )
      throw new GatewayError(
        "model_not_allowed",
        403,
        `This key may only use models starting with '${authorization.modelPrefix}' (request {requestId}). Ask for one inside that prefix, or have an operator widen the key. The door's locked for this one — check the allowlist 🔒`,
        { model, required_prefix: authorization.modelPrefix },
      );
    if (!allowedForKey) {
      throw new GatewayError("model_not_allowed", 403, "model is not allowed for this API key (request {requestId}). The door's locked for this one — check the allowlist 🔒", {
        model,
      });
    }
    return { resolvedTarget, allowCliMappings };
  }

  /** Injects the vision-handoff runner (called once from boot wiring). */
  bindVisionHandoff(
    runner: (input: VisionHandoffCall) => Promise<readonly VisionHandoffResult[]>,
  ): void {
    this.#runVisionHandoff = runner;
  }

  async prepare(input: {
    readonly canonicalRequest: CanonicalRequest;
    readonly authorization: ResolvedApiKey;
    readonly deadlineMs: number;
    readonly signal?: AbortSignal;
    /** Inbound `User-Agent`; gates remote CLI remaps so short slots stay tool-local. */
    readonly clientUserAgent?: string;
    /** Suppresses nested vision handoff; internal sub-requests set this. */
    readonly disableVisionHandoff?: boolean;
  }): Promise<PreparedProxyRequest> {
    const { canonicalRequest: initialRequest, authorization, signal } = input;
    if (signal?.aborted)
      throw new GatewayError("transport_closed", 499, "The request was cancelled (request {requestId}). Send it again whenever ready 🙃");
    if (!initialRequest.model || initialRequest.model.trim().length === 0) {
      throw new GatewayError("invalid_request", 400, "Request requires a non-empty model identifier (request {requestId}). Check the shape of what you sent — then resend 🪞", {
        field: "model",
      });
    }
    // A thinking suffix (`model(high)`) is stripped here, before anything reads
    // the model name. Alias resolution, the allowlist, the prefix check, and
    // routing all match against registered ids, so a name carrying `(high)`
    // would fail every one of them — and alias resolution swallows its own
    // failure, so the symptom would be a silent miss rather than an error.
    //
    // Doing it on the canonical request (rather than in a provider adapter) is
    // what makes the syntax global: at this point the target provider is not
    // chosen yet, and the level is a statement about the request, not about any
    // one upstream. Each model's own ladder is applied later, after routing.
    const { model: bareModel, intent: thinkingIntent } = parseThinkingSuffix(initialRequest.model);
    const request =
      thinkingIntent === null
        ? initialRequest
        : withThinkingSuffixIntent({ ...initialRequest, model: bareModel }, thinkingIntent);
    const snapshot = await this.deps.snapshotService.getSnapshot();
    const { allowCliMappings } = this.#resolveAliasAndGateModel(
      request.model,
      authorization,
      input.clientUserAgent,
      snapshot,
    );
    // An inline image that cannot survive the upstream is dropped here rather
    // than dispatched: a provider rejects the whole request for one corrupt
    // attachment, and the buddy family reports it with no field named, so the
    // caller gets a 400 it cannot act on. Running this before capability
    // derivation also means a request whose only image was defective does not
    // require the `image` capability — it plans like the text request it has
    // become, instead of being routed to a vision route for nothing.
    const requestWithAttachments = dropCorruptAttachments(request).request;
    // Capability-aware routing: derive requirements BEFORE planning so the
    // router filters candidates against snapshot profiles. When nothing
    // supports the full request, degrade (same greedy order) and re-plan
    // each variant against the same snapshot; the first non-empty plan wins.
    let plan: RoutePlan | undefined;
    let variantRequest = requestWithAttachments;
    let degraded: readonly RequiredCapability[] = [];
    // Explicit caller opt-out wins over capability routing: dropping encrypted
    // reasoning is a lossy request the caller asked for, so it applies before
    // planning rather than as a fallback when no route supports the artifacts.
    if (requestWithAttachments.generation_controls["extension:omit_encrypted_reasoning"] === true) {
      const stripped = degradeEncryptedReasoning(requestWithAttachments);
      if (stripped) {
        variantRequest = stripped;
        degraded = ["reasoning.encrypted_content"];
      }
    }
    for (const variant of degradedRequestVariants(variantRequest)) {
      try {
        plan = await this.deps.routingEngine.plan(
          request.model,
          snapshot,
          authorization.tenantId,
          variant.required,
          allowCliMappings,
          authorization.cliMappingOwnerId ?? authorization.id,
          request.conversation_id ?? request.conversation?.conversation_id,
        );
      } catch (error) {
        // `plan()` collapses "no candidate supports this capability" into
        // `accounts_unavailable` (503), not `capability_unsupported` — a
        // candidate that exists but cannot carry the required capability is
        // evaluated ineligible, and an all-ineligible set reads as "no usable
        // account". Both mean "try the next, more degraded variant" here.
        // `accounts_unavailable` is swallowed on the pristine variant (so a
        // genuinely unhealthy pool falls through to a degraded plan) and on any
        // variant that still carries requirements (a capability the route
        // lacks, not a dead pool). Only a fully degraded variant — nothing left
        // to drop — that still refuses means the pool itself is unusable, and
        // that 503 must surface.
        if (
          error instanceof GatewayError &&
          (error.code === "capability_unsupported" ||
            (error.code === "accounts_unavailable" &&
              (variant.degraded.length === 0 || variant.required.length > 0)))
        ) {
          continue;
        }
        throw error;
      }
      // Vision handoff: when the winning route cannot carry images (the image
      // capability was degraded), try to describe the images with a configured
      // vision model and plan the resulting text-only request instead. This
      // only runs when the selected model is NOT image-capable — a vision route
      // that plans without degradation keeps the real image. The handoff is
      // best-effort; any failure keeps the legacy `[image]` placeholder plan.
      if (
        variant.degraded.includes("image") &&
        input.disableVisionHandoff !== true &&
        this.#runVisionHandoff !== undefined
      ) {
        try {
          const handedOff = await this.#runVisionHandoff({
            canonicalRequest: requestWithAttachments,
            authorization,
            deadlineMs: input.deadlineMs,
            ...(input.signal === undefined ? {} : { signal: input.signal }),
            ...(input.clientUserAgent === undefined ? {} : { clientUserAgent: input.clientUserAgent }),
          });
          if (handedOff.length > 0) {
            const description = handedOff.map((result) => result.description).join("\n");
            // Replace on the already-degraded variant so earlier degradations
            // (tools, reasoning, …) survive alongside the handoff — a chain
            // variant carries them, and rewriting from the pristine request
            // would reintroduce capabilities the winning route lacks.
            // Condense first (while the active turn still carries its image, so
            // it can be located): a session with hundreds of tool-result turns
            // forwards a multi-megabyte body that upstreams reset or reject
            // (502 / ECONNRESET) — the "broken on large sessions" report. The
            // handoff only needs to describe the attached image, so the giant
            // history is dropped entirely, leaving system + active turn.
            const condensedBase = condenseHandoffRequest(variant.request);
            const replaced = replaceImagePartsWithText(condensedBase, description);
            if (replaced !== null) {
              const requiredAfter = deriveRequiredCapabilities(replaced);
              try {
                const handoffPlan = await this.deps.routingEngine.plan(
                  request.model,
                  snapshot,
                  authorization.tenantId,
                  requiredAfter,
                  allowCliMappings,
                  authorization.cliMappingOwnerId ?? authorization.id,
                          request.conversation_id ?? request.conversation?.conversation_id,
                );
                plan = handoffPlan;
                variantRequest = replaced;
                degraded = [
                  ...degraded,
                  ...variant.degraded.filter(
                    (cap) => cap !== "image" && !degraded.includes(cap),
                  ),
                ];
                break;
              } catch (error) {
                if (
                  error instanceof GatewayError &&
                  (error.code === "capability_unsupported" ||
                    error.code === "accounts_unavailable")
                ) {
                  // Re-plan failed without the image requirement; keep the
                  // degraded `[image]` plan captured above. `accounts_unavailable`
                  // is also swallowed: the text-only re-plan can be refused for
                  // the same health/pool reasons the original plan was, and the
                  // parent request must never fail because a best-effort
                  // handoff could not be re-planned.
                } else {
                  throw error;
                }
              }
            }
          }
        } catch (error) {
          // Best-effort only: a handoff failure never fails the parent request.
          log.warn("[vision-handoff] handoff failed; falling back to [image] placeholder", {
            model: request.model,
            tenantId: authorization.tenantId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      variantRequest = variant.request;
      degraded = [...degraded, ...variant.degraded.filter((cap) => !degraded.includes(cap))];
      break;
    }
    if (!plan)
      throw new GatewayError(
        "capability_unsupported",
        400,
        "no eligible route supports this request's capabilities (request {requestId}). Drop the unsupported capability, or route to a model that accepts it. Know your tools — this one just isn't in the box 🧰",
        { model: request.model },
      );
    const policyCandidates = plan.candidates.filter((candidate) =>
      isModelAllowed(
        authorization.snapshot,
        candidate.model_id,
        candidate.provider_id,
        request.model,
      ),
    );
    if (policyCandidates.length === 0)
      throw new GatewayError("model_not_allowed", 403, "model is not allowed for this API key (request {requestId}). The door's locked for this one — check the allowlist 🔒", {
        model: request.model,
      });
    if (policyCandidates.length !== plan.candidates.length)
      plan = { ...plan, candidates: policyCandidates };
    // A canonical request is chat-shaped by definition, so only `llm` rows may
    // serve it. A non-`llm` row (System One) is dispatched by its native route
    // and its `wire_family` is an inert placeholder; without this filter the
    // chat pipeline would route to it and send a chat body to a decision
    // endpoint (upstream 400). The reverse direction is guarded by the native
    // route's own kind filter.
    const llmCandidates = plan.candidates.filter(
      (candidate) => (candidate.service_kind ?? "llm") === "llm",
    );
    if (llmCandidates.length === 0) {
      // Name the actual kind so the message stays correct as more native
      // services are added, and point at the route that can serve it.
      const kind = plan.candidates[0]?.service_kind ?? "native";
      const route = nativeServicePathFor(kind);
      throw new GatewayError(
        "capability_unsupported",
        400,
        `this model is not served on a chat wire — it is a '${kind}' service model${route === undefined ? "" : `; call it at POST ${route}`} (request {requestId}). Know your tools — this one just isn't in the box 🧰`,
        { model: request.model, service_kind: kind, ...(route === undefined ? {} : { route }) },
      );
    }
    if (llmCandidates.length !== plan.candidates.length) {
      plan = { ...plan, candidates: llmCandidates };
    }
    if (degraded.length > 0) {
      // Degradation is a last resort, never silent: the client asked for
      // semantics (tools/images/reasoning) the winning route cannot serve,
      // so they were stripped to keep the request dispatchable at all.
      // Surfacing it here puts it on the live console log next to the
      // request it affected, throttled so sustained degradation cannot
      // drown out everything else in the ring.
      const degradedList = [...degraded];
      const warnKey = `${request.model}|${degradedList.join(",")}`;
      if (shouldWarnDegradation(warnKey, Date.now())) {
        log.warn("[routing] degraded request capabilities", {
          model: request.model,
          degraded: degradedList,
          tenantId: authorization.tenantId,
        });
      }
    }
    if (signal?.aborted)
      throw new GatewayError("transport_closed", 499, "The request was cancelled (request {requestId}). Send it again whenever ready 🙃");
    const eligible = plan.candidates;
    // The buddy gateway rejects partial tool rounds outright (`11148`) where
    // the generic synthesis policy would insert a placeholder result, so a
    // request bound for CodeBuddy/WorkBuddy drops the incomplete round instead.
    // The winner is the first candidate — the whole plan shares its provider —
    // hence the repair is chosen from the winning provider.
    //
    // Order is load-bearing: `dropIncompleteToolRounds` MUST run before
    // `repairRequestToolCalls`. The generic repair synthesizes a
    // `<missing tool output>` result for every unanswered call, which makes
    // every partial batch look complete — so running it first silently
    // disabled the buddy policy and dispatched exactly the shape the upstream
    // rejects (`assistant[c1 c2] + tool[c1]` became a "complete" round with a
    // fabricated c2 result). Dropping first also removes the dangling results
    // that would otherwise be re-emitted as unpaired `role:"tool"` turns.
    // Fast path: chat/completions without tools skip the three full-message
    // clones (repair → sanitize → project). Only run the heavy path when the
    // request actually carries tools or tool-call/result parts.
    let effectiveRequest = variantRequest;
    if (requestNeedsToolRepair(variantRequest)) {
      const winningProvider = eligible[0]?.provider_id;
      const buddyFamily =
        winningProvider !== undefined && BUDDY_PROVIDER_IDS.has(winningProvider);
      // Order is load-bearing: dropIncompleteToolRounds MUST run before
      // repairRequestToolCalls (see comment above).
      effectiveRequest = buddyFamily
        ? repairRequestToolCalls({
            ...variantRequest,
            messages: dropIncompleteToolRounds(variantRequest.messages),
          })
        : repairRequestToolCalls(variantRequest);
      effectiveRequest = sanitizeRequestToolIds(effectiveRequest);
      // F-23: history may call a tool the current request no longer declares
      // (a client that widened then narrowed its tool set). The transcript
      // replays that call on every later turn and strict wires reject it —
      // re-declare the withdrawn names so the history stays dispatchable.
      effectiveRequest = redeclareWithdrawnTools(effectiveRequest);
      // F-43: the operator-opt-in tool-result ceiling applies at the same
      // canonical stage, so all three surfaces inherit one policy. Off (0)
      // returns the same reference.
      effectiveRequest = truncateToolResults(effectiveRequest, resolveToolResultMaxKb());
    }
    if (signal?.aborted)
      throw new GatewayError("transport_closed", 499, "The request was cancelled (request {requestId}). Send it again whenever ready 🙃");
    // Project against the chosen candidate, not the intersection of every
    // candidate in the plan. Still required for generation-control stripping
    // even on the no-tools path — keep it, but it is cheap vs message clones.
    effectiveRequest = projectForRoute(effectiveRequest, routeCapabilitiesFor(eligible[0]!));
    const estimatedInputTokens = estimateInputTokens(effectiveRequest);
    const estimatedOutputTokens =
      effectiveRequest.generation_controls.max_tokens ??
      effectiveRequest.generation_controls.max_output_tokens ??
      effectiveRequest.generation_controls.max_completion_tokens ??
      DEFAULT_ESTIMATED_OUTPUT_TOKENS;
    const chosen = eligible[0]!;
    // plan() guarantees a non-empty candidate list (it throws otherwise).
    return {
      canonicalRequest: effectiveRequest,
      authorization,
      candidate: chosen,
      eligibleRouteCandidates: eligible,
      degradedCapabilities: degraded,
      plan,
      caller: authorization.caller,
      estimatedInputTokens,
      estimatedOutputTokens,
      deadlineMs: input.deadlineMs,
      routingEngine: this.deps.routingEngine,
      admissionService: this.deps.admissionService,
    };
  }

  /**
   * Plans a native (non-canonical) body without parsing, projecting, or
   * mutating it. Shared by every native route: it applies the key's model-prefix
   * gate, plans the model, and keeps only the candidates the route's own
   * `eligible` predicate admits. Estimates intentionally reserve a conservative
   * fixed budget because native input is not canonicalized for token counting.
   */
  async #planNative(input: {
    readonly model: string;
    readonly authorization: ResolvedApiKey;
    readonly signal?: AbortSignal;
    /** Inbound `User-Agent`; gates remote CLI remaps to the matching tool. */
    readonly clientUserAgent?: string;
    readonly eligible: (candidate: RouteCandidate) => boolean;
    readonly emptyMessage: string;
    /** Session identity for sticky routing (conversation id when present). */
    readonly conversationId?: string;
  }): Promise<PreparedNativeRequest> {
    if (input.signal?.aborted)
      throw new GatewayError("transport_closed", 499, "The request was cancelled (request {requestId}). Send it again whenever ready 🙃");
    const snapshot = await this.deps.snapshotService.getSnapshot();
    const { allowCliMappings } = this.#resolveAliasAndGateModel(
      input.model,
      input.authorization,
      input.clientUserAgent,
      snapshot,
    );
    const plan = await this.deps.routingEngine.plan(
      input.model,
      snapshot,
      input.authorization.tenantId,
      undefined,
      allowCliMappings,
      input.authorization.cliMappingOwnerId ?? input.authorization.id,
      input.conversationId,
    );
    if (input.signal?.aborted)
      throw new GatewayError("transport_closed", 499, "The request was cancelled (request {requestId}). Send it again whenever ready 🙃");
    const policyCandidates = plan.candidates.filter((candidate) =>
      isModelAllowed(
        input.authorization.snapshot,
        candidate.model_id,
        candidate.provider_id,
        input.model,
      ),
    );
    if (policyCandidates.length === 0)
      throw new GatewayError("model_not_allowed", 403, "model is not allowed for this API key (request {requestId}). The door's locked for this one — check the allowlist 🔒", {
        model: input.model,
      });
    const candidates = policyCandidates.filter(input.eligible);
    if (candidates.length === 0)
      throw new GatewayError("capability_unsupported", 400, `${input.emptyMessage} (request {requestId}). Know your tools — this one just isn't in the box 🧰`, {
        model: input.model,
      });
    return {
      authorization: input.authorization,
      candidates,
      plan,
      estimatedInputTokens: DEFAULT_ESTIMATED_OUTPUT_TOKENS,
      estimatedOutputTokens: DEFAULT_ESTIMATED_OUTPUT_TOKENS,
      routingEngine: this.deps.routingEngine,
      admissionService: this.deps.admissionService,
    };
  }

  /**
   * Plans native Responses compaction. Compact is a Codex-only operation, so
   * the candidate set is filtered to the Codex provider.
   */
  async prepareNativeCompact(input: {
    readonly model: string;
    readonly authorization: ResolvedApiKey;
    readonly signal?: AbortSignal;
    readonly clientUserAgent?: string;
  }): Promise<PreparedNativeRequest> {
    return this.#planNative({
      model: input.model,
      authorization: input.authorization,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      ...(input.clientUserAgent === undefined ? {} : { clientUserAgent: input.clientUserAgent }),
      eligible: (candidate) => candidate.provider_id === "codex",
      emptyMessage: "no eligible Codex route supports Responses compact",
    });
  }

  /**
   * Plans a native service request (System One). Candidates are the routes whose
   * catalog classifies the model as this service kind — the model's own row is
   * what makes a provider eligible, so a chat model named on the systemone route
   * (or vice versa) finds no candidate and fails closed here rather than
   * dispatching a decision body to a chat endpoint.
   */
  async prepareNativeService(input: {
    readonly model: string;
    readonly serviceKind: Exclude<ServiceKind, "llm">;
    readonly authorization: ResolvedApiKey;
    readonly signal?: AbortSignal;
    readonly clientUserAgent?: string;
  }): Promise<PreparedNativeRequest> {
    return this.#planNative({
      model: input.model,
      authorization: input.authorization,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      ...(input.clientUserAgent === undefined ? {} : { clientUserAgent: input.clientUserAgent }),
      eligible: (candidate) => {
        const kind = candidate.service_kind ?? "llm";
        // A service route is served by a row that declares that service kind.
        // An `llm` row never is one, so `/v1/search` is answered only by a
        // `service_kind: "websearch"` row (Exa, Parallel, Gemini) — the same
        // set the chat fallback draws from.
        return kind === input.serviceKind;
      },
      emptyMessage: `no eligible route serves the '${input.serviceKind}' service for this model`,
    });
  }

  /**
   * Plans a token-count request: the same `llm` route that would serve the
   * message, restricted to providers that speak Anthropic Messages.
   *
   * Deliberately not a `serviceKind`. `/v1/messages/count_tokens` is a sibling
   * endpoint of `/v1/messages` on the *same* model, so the candidate is an
   * ordinary `llm` row — inventing a `tokenCounting` catalog kind would make it
   * selectable on a provider model that can then never serve chat, and would put
   * it in the console's picker for no reason. `wire_family` is the honest gate:
   * a count body is Anthropic-shaped, so a chat-completions or responses
   * provider has no equivalent endpoint and must not be dispatched to.
   */
  async prepareNativeTokenCount(input: {
    readonly model: string;
    readonly authorization: ResolvedApiKey;
    readonly signal?: AbortSignal;
    readonly clientUserAgent?: string;
  }): Promise<PreparedNativeRequest> {
    return this.#planNative({
      model: input.model,
      authorization: input.authorization,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      ...(input.clientUserAgent === undefined ? {} : { clientUserAgent: input.clientUserAgent }),
      eligible: (candidate) => candidate.wire_family === "messages",
      emptyMessage:
        "no eligible route can count tokens for this model — only an Anthropic Messages provider has /v1/messages/count_tokens",
    });
  }
}
