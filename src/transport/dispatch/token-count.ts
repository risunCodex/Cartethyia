/**
 * `POST /v1/messages/count_tokens`.
 *
 * Anthropic's token counter: the caller sends a Messages-shaped body and gets
 * `{input_tokens}` back, with no generation and no billing. Claude Code calls it
 * before a turn to decide whether the context still fits, so the number has to be
 * the one the provider itself would report — an estimate would move the
 * compaction threshold to the wrong place, and being wrong in either direction is
 * a visible failure: too low and the follow-up request is rejected for length,
 * too high and the client compacts early for no reason.
 *
 * So the count is **forwarded** when the route can be asked, and only then.
 * The body is Anthropic's and the answer is Anthropic's, which is also why this
 * does not go through the canonical surface codecs: `CanonicalRequest`/
 * `CanonicalEvent` model a chat turn, and a count is not one.
 *
 * Most providers have no counter to ask. Chat Completions and Responses simply
 * have no `count_tokens` endpoint, so a Messages client pointed at one of them
 * (a combo of buddy-family models, say) has nowhere to forward to — and a 400
 * there is worse than an approximation, because the client asked "does this
 * still fit", not "can you count". When no route speaks Messages, the gateway
 * estimates instead; that estimate is what the reference gateways answer on a
 * provider without a counter, so the client sees the same magnitude it would
 * behind one of them.
 *
 * The upstream response is returned **verbatim** — status, headers, and body.
 * Anthropic answers an unusable body with its own error envelope, and the client
 * is entitled to read that error rather than a gateway paraphrase of it.
 *
 * The shape follows `generation.ts`: validate the trust boundary, drive
 * `runAttemptLoop`, hand back what the upstream produced. Candidate eligibility
 * is the provider's wire family, decided in
 * `ProxyRequestPreparer.prepareNativeTokenCount`; the estimate is the fallback
 * when that gate leaves no candidate.
 */
import type { ProviderAdapter, ProviderDispatchTarget } from "../../providers/provider-contracts";
import { GatewayError } from "../../protocol/gateway-error";
import { isRecord } from "../../protocol/codecs";
import { metrics } from "../../observability/metrics";
import type { TelemetryBatchBuffer } from "../../observability/telemetry-buffer";
import type { ProxyRequestState } from "../request/state";
import type { PreparedNativeRequest } from "../request/preparer";
import { completeAttempt, estimatedUsage, nativeCompletionBase } from "./attempt-finalize";
import { finalizeRequestTelemetry } from "../guards/error-lifecycle";
import { runAttemptLoop } from "./attempt-loop";
import { hasScope, networkFetchContext, requireRecordBody, resolveAttemptCredential } from "./native-shared";

import type { GatewayHandlerDeps } from "./handler-deps";

type TokenCountHandlerDeps = GatewayHandlerDeps;

/** Builds the `POST /v1/messages/count_tokens` handler. */
export function createTokenCountHandler(deps: TokenCountHandlerDeps) {
  return async ({ request }: { request: Request }): Promise<Response> => {
    const state = deps.stateStore.require(request);
    const authorization = state.authorization;
    const countBody = requireRecordBody(
      state,
      "The count_tokens body must be a JSON object (request {requestId}), the same shape POST /v1/messages accepts. Check the shape of what you sent — then resend 🪞",
    );
    // `requireRecordBody` already refused a missing authorization; this guard
    // exists only to narrow the type for the code below.
    if (!authorization) {
      throw new GatewayError("invalid_request", 400, "authentication required (request {requestId})");
    }

    // `model` names the route and `messages` is what gets counted; both are the
    // upstream's own required fields, so the gateway does not restate its own
    // narrower rule and risk rejecting a body the provider would accept.
    if (typeof countBody.model !== "string" || countBody.model.trim().length === 0) {
      throw new GatewayError("invalid_request", 400, "A model is required (request {requestId}): it names the provider to count with. Check the shape of what you sent — then resend 🪞");
    }
    if (!Array.isArray(countBody.messages)) {
      throw new GatewayError("invalid_request", 400, "messages must be an array (request {requestId}) — there is nothing to count without it. Check the shape of what you sent — then resend 🪞");
    }
    if (!hasScope(authorization?.snapshot.scopes, "routing:invoke")) {
      throw new GatewayError(
        "policy_rejected",
        403,
        "token counting not allowed for this key (request {requestId}) — enable routing:invoke on the API key. Not allowed by policy — no hard feelings 🫂",
      );
    }

    let prepared: PreparedNativeRequest;
    try {
      prepared = await deps.proxyPreparer.prepareNativeTokenCount({
        model: countBody.model,
        authorization,
        ...(state.abortController.signal ? { signal: state.abortController.signal } : {}),
        ...(state.clientUserAgent === undefined ? {} : { clientUserAgent: state.clientUserAgent }),
      });
    } catch (error) {
      // Only "this model has no Messages route" falls back to estimating. A
      // model whose accounts are cooling or saturated must still answer its
      // real 429/503 — a fabricated count would tell the client its context
      // fits when nothing is there to serve the turn that follows.
      if (!(error instanceof GatewayError) || error.code !== "capability_unsupported") throw error;
      return estimatedCountResponse(state, countBody, deps.telemetryBuffer, deps.db);
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
      exhaustedError: new GatewayError(
        "route_unavailable",
        503,
        "no eligible route can count tokens for this model (request {requestId}). The bouncer stepped out — come back shortly 🚪",
      ),
      prepare: async (candidate) => {
        const credential = await resolveAttemptCredential(deps, candidate);
        const adapter = await deps.resolveProviderAdapter?.(candidate.provider_id);
        if (!adapter) {
          throw new GatewayError("capability_unsupported", 400, "token counting is unavailable for this provider (request {requestId}). Know your tools — this one just isn't in the box 🧰");
        }
        return { credential, adapter };
      },
      attempt: async (context) => {
        const { candidate, credential, leases, providerCapture } = context;
        // Name the model the route actually resolved to: a caller may address it
        // through an alias, and the upstream must count the real model's tokens.
        const upstreamBody =
          countBody.model === candidate.model_id
            ? countBody
            : { ...countBody, model: candidate.model_id };

        const adapter = context.adapter;
        if (typeof adapter.dispatchNativeService !== "function") {
          throw new GatewayError("capability_unsupported", 400, "token counting is unavailable for this provider (request {requestId}). Know your tools — this one just isn't in the box 🧰");
        }

        const target: ProviderDispatchTarget = {
          provider_id: candidate.provider_id as ProviderAdapter["provider_id"],
          model_id: candidate.model_id,
          ...(candidate.output_limit == null ? {} : { output_limit: candidate.output_limit }),
          wire_family: candidate.wire_family,
          // Always supplied. `dispatchNativeService` falls back to
          // `/v1/systemone` on an empty path, which would post a Messages body to
          // a decision endpoint and answer with an error that names the wrong
          // service entirely.
          endpoint_path: joinCountTokensPath(candidate.endpoint),
          capabilities: candidate.capability_profile,
        };

        const upstream = await adapter.dispatchNativeService(upstreamBody, target, {
          credential,
          deadline: state.deadlineMs,
          abort_signal: state.abortController.signal,
          ...(candidate.user_agent === undefined ? {} : { user_agent: candidate.user_agent }),
          ...networkFetchContext(deps, leases.proxySlot?.poolId, authorization.tenantId),
        });

        // A count is free and generates nothing, so nothing is reserved or
        // committed. The attempt is still finalized: telemetry, the health
        // outcome, and the lease release have to happen exactly as they do on a
        // billed route, or a free endpoint becomes the one place those invariants
        // quietly stop holding.
        await completeAttempt(state, {
          status: upstream.ok ? "completed" : "failed",
          ...nativeCompletionBase({
            providerId: candidate.provider_id,
            ...(candidate.provider_account_id ? { accountId: candidate.provider_account_id } : {}),
            ...(candidate.provider_account_label ? { accountLabel: candidate.provider_account_label } : {}),
            ...(leases.proxySlot ? { networkPoolId: leases.proxySlot.poolId } : {}),
            usage: estimatedUsage(0, 0),
            modelId: candidate.model_id,
            lease: leases.lease,
            commitUsage: estimatedUsage(0, 0),
            tenantId: prepared.authorization.tenantId,
            ingressBody: state.ingressBody,
            providerCapture,
            db: deps.db,
            ...(deps.telemetryBuffer ? { telemetryBuffer: deps.telemetryBuffer } : {}),
            ...(deps.snapshotService ? { snapshotService: deps.snapshotService } : {}),
          }),
          responseBody: null,
        });
        metrics.proxy_requests_total.inc(1, { status: upstream.ok ? "completed" : "failed" });

        // Verbatim: the client reads the provider's own number, and the
        // provider's own error when it refuses to produce one.
        const contentType = upstream.headers.get("content-type") ?? "application/json";
        return new Response(upstream.body, {
          status: upstream.status,
          headers: { "content-type": contentType, "cache-control": "no-store", "x-request-id": state.requestId },
        });
      },
    });
  };
}

/**
 * Answers a count the gateway worked out itself, on a route with no counter.
 *
 * No attempt is finalized: nothing was leased, nothing was sent upstream, and
 * no provider produced this number, so recording it against an account would
 * invent usage the account never served. The request is still finalized through
 * `finalizeRequestTelemetry` (the early-rejection pattern) — without it the
 * latency histogram, the `request_complete` console event, and the durable
 * telemetry row all miss this request — and `state.completed` prevents the
 * `afterResponse` fallback from finalizing it a second time.
 */
function estimatedCountResponse(
  state: ProxyRequestState,
  countBody: Record<string, unknown>,
  telemetryBuffer: TelemetryBatchBuffer | undefined,
  db: GatewayHandlerDeps["db"],
): Response {
  const inputTokens = estimateMessagesInputTokens(countBody);
  const payload = JSON.stringify({ input_tokens: inputTokens });
  // The request still gets an outcome — without one the `afterResponse` hook
  // would finalize it as a failure, and a count that answered 200 would show up
  // in Console Log as an error. `usage` is a zero-priced estimate: nothing was
  // leased and no provider produced this number, so recording a cost against an
  // account would invent usage the account never served (`estimated_cost: null`).
  state.outcome = {
    status: "completed",
    httpStatus: 200,
    usage: estimatedUsage(inputTokens, 0),
  };
  state.completed = true;
  state.clientResponseText = payload;
  metrics.proxy_requests_total.inc(1, { status: "completed" });
  // Finalize telemetry inline (the early-rejection pattern) instead of routing
  // through `completeAttempt`: there was no lease and no provider — but the
  // latency histogram, the `request_complete` console event, and the durable
  // row must still happen, exactly once. `completed = true` also disables the
  // `afterResponse` fallback, which is what used to make this request vanish
  // from telemetry entirely.
  if (telemetryBuffer) finalizeRequestTelemetry(state, telemetryBuffer, db);
  return new Response(payload, {
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "x-request-id": state.requestId,
    },
  });
}
/**
 * Appends `/count_tokens` to the candidate's Messages endpoint.
 *
 * The stored endpoint is the chat path (`/v1/messages`), and the counter is its
 * sibling rather than a separate service. A trailing slash is normalized so a
 * row stored as `/v1/messages/` does not become `/v1/messages//count_tokens`.
 *
 * A query string is moved back to the end rather than being appended to.
 * AgentRouter stores `/v1/messages?beta=true`, and appending naively produces
 * `/v1/messages?beta=true/count_tokens` — the counting segment lands inside the
 * query, so the upstream sees the chat path with junk after it and never counts.
 */
function joinCountTokensPath(endpoint: string): string {
  const queryAt = endpoint.indexOf("?");
  const path = queryAt === -1 ? endpoint : endpoint.slice(0, queryAt);
  const query = queryAt === -1 ? "" : endpoint.slice(queryAt);
  return `${path.replace(/\/+$/, "")}/count_tokens${query}`;
}

/**
 * Tokens credited to one image, and the characters that make one token.
 *
 * The same two constants the reference gateways use for this endpoint, so the
 * number a client reads here is the number those gateways would have answered.
 */
const IMAGE_TOKEN_ESTIMATE = 1_600;
const CHARS_PER_TOKEN = 4;

/** Accumulator for one body: priced characters, plus images priced flat. */
interface CharTally {
  chars: number;
  images: number;
}

/** Characters a scalar or deeply nested JSON value contributes. */
function tallyValue(value: unknown, tally: CharTally): void {
  if (value === null || value === undefined) return;
  if (typeof value === "string") {
    tally.chars += value.length;
    return;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    tally.chars += String(value).length;
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) tallyValue(item, tally);
    return;
  }
  if (typeof value === "object") {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      tally.chars += key.length;
      tallyValue(item, tally);
    }
  }
}

/**
 * Prices one Messages content block.
 *
 * `tool_use` arguments and `tool_result` content are what a later turn really
 * pays for, so they are priced from their payload — pricing a tool round at
 * zero is how a long agent transcript reads as far smaller than it is.
 */
function tallyBlock(block: unknown, tally: CharTally): void {
  if (typeof block === "string") {
    tally.chars += block.length;
    return;
  }
  if (!isRecord(block)) {
    tallyValue(block, tally);
    return;
  }
  switch (block["type"]) {
    case "text":
      tally.chars += typeof block["text"] === "string" ? block["text"].length : 0;
      return;
    case "thinking":
      tally.chars += typeof block["thinking"] === "string" ? block["thinking"].length : 0;
      return;
    case "tool_use":
      tallyValue(block["name"], tally);
      tallyValue(block["input"], tally);
      return;
    case "tool_result":
      tallyValue(block["content"], tally);
      return;
    case "image":
      // A binary payload has no honest character count, so it takes the flat
      // per-image reserve instead — the same treatment an image gets in
      // `estimateInputTokens`.
      tally.images += 1;
      return;
    case "document":
      // Base64 carries ~4 characters per 3 bytes; pricing the raw string as
      // text would overstate a large PDF by a third.
      tally.chars += Math.ceil((documentChars(block["source"]) * 3) / 4);
      return;
    default:
      tallyValue(block, tally);
  }
}

/** Raw characters in a document block's payload, base64 or URL. */
function documentChars(source: unknown): number {
  if (typeof source === "string") return source.length;
  if (!isRecord(source)) return 0;
  const data = source["data"];
  if (typeof data === "string") return data.length;
  const url = source["url"];
  return typeof url === "string" ? url.length : 0;
}

/** Prices `system`, whether the caller sent a string or text blocks. */
function tallySystem(system: unknown, tally: CharTally): void {
  if (typeof system === "string") {
    tally.chars += system.length;
    return;
  }
  if (Array.isArray(system)) {
    for (const block of system) tallyBlock(block, tally);
  }
}

/**
 * Estimates `input_tokens` for a Messages body, on a route with no counter.
 *
 * Deliberately `chars / 4` and not a weighted tokenizer: this is the number
 * every reference gateway answers for this endpoint, so Claude Code sees the
 * same magnitude here as it would behind one of them. Small in either
 * direction only moves when the client compacts; a tokenizer nobody else uses
 * would move it differently from every other deployment.
 *
 * `tools` is counted — Claude Code declares large tool schemas, and omitting
 * them is what makes a count read far below the request that follows it.
 */
export function estimateMessagesInputTokens(body: Record<string, unknown>): number {
  const tally: CharTally = { chars: 0, images: 0 };
  tallySystem(body["system"], tally);
  const messages = body["messages"];
  if (Array.isArray(messages)) {
    for (const message of messages) {
      if (!isRecord(message)) continue;
      const content = message["content"];
      if (typeof content === "string") tally.chars += content.length;
      else if (Array.isArray(content)) for (const block of content) tallyBlock(block, tally);
      else tallyValue(content, tally);
    }
  }
  if (body["tools"] !== undefined) tallyValue(body["tools"], tally);
  return Math.max(1, Math.ceil(tally.chars / CHARS_PER_TOKEN) + tally.images * IMAGE_TOKEN_ESTIMATE);
}
