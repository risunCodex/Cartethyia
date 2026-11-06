/**
 * Factory Droid adapter.
 *
 * Factory's LLM proxy multiplexes several wire protocols behind one WorkOS
 * bearer, and the path prefix differs per protocol, so a single declarative
 * `ApiKeyProviderSpec` cannot describe it:
 *
 * | wire family | path |
 * |---|---|
 * | `chat` | `/api/llm/o/v1/chat/completions` |
 * | `responses` | `/api/llm/o/v1/responses` |
 * | `messages` | `/api/llm/a/v1/messages` |
 *
 * Three more things sit outside the shared factory:
 *
 * 1. **The credential is an envelope.** The console stores one opaque string,
 *    and this provider's secret is `{ accessToken, orgId }` — the org id comes
 *    from the token's `external_org_id` claim and is required as
 *    `X-Factory-Org-Id`, because Factory scopes every call to the approving
 *    user's organization.
 * 2. **The host is per-account.** Residency is resolved at login
 *    (`/api/cli/whoami`) and recorded in account `auth_state`; EU accounts are
 *    served from `api.eu.factory.ai` and everything else from `api.factory.ai`.
 *    Dispatching an EU credential to the global host is a 404 that names
 *    neither cause, so the host is resolved from stored state at transport time.
 * 3. **Client identity is required.** Factory's own headers (`X-Factory-Client`,
 *    `X-Client-Version`) identify a first-party client; the request is refused
 *    without them.
 */
import type {
  ProviderAdapter,
  ProviderDispatchContext,
  ProviderDispatchTarget,
} from "../../provider-contracts";
import type { CanonicalEvent, CanonicalRequest } from "../../../protocol/canonical-model";
import { GatewayError } from "../../../protocol/gateway-error";
import { decodeSseEvents } from "../../../protocol/sse-decoder";
import { buildGeminiPayload } from "../../../protocol/request/gemini";
import {
  decodeGeminiStreamEvent,
  geminiCandidate,
  mapGeminiUsage,
  responseParts,
  toCanonicalStopReason,
} from "../../../protocol/response/gemini";
import { endpointUrl } from "../../../protocol/codecs";
import { usageFromProvider } from "../../provider-usage";
import { createUpstreamDeadlineLifecycle, abortGatewayError } from "../../operations/upstream-deadline";
import { mapUpstreamHttpError } from "../../../transport/failure-policy";
import { buildClaudeMessagesRequest, filterClaudeCustomHeaders } from "../shared/claude-messages";
import { sendClaudeMessagesRequest } from "../../../protocol/upstream/send-claude-messages";
import { applyParamQuirks } from "../../../protocol/translation/quirks";
import { createApiKeyAdapter } from "../../configured-provider";
import type { ApiKeyProviderSpec } from "../../configured-provider";
import { decodeFactoryDroidCredential } from "../../../security/credential-codec";
import { log } from "../../../observability/logger";

import { FACTORY_GEMINI_ENDPOINT_PATH, FACTORY_MODELS, FACTORY_PROVIDER_ID } from "./factory-models";

export { FACTORY_MODELS, FACTORY_PROVIDER_ID };

/** Default host; an EU account resolves to {@link FACTORY_DROID_EU_BASE_URL} instead. */
export const FACTORY_DROID_BASE_URL = "https://api.factory.ai";
export const FACTORY_DROID_EU_BASE_URL = "https://api.eu.factory.ai";

/**
 * Path prefixes Factory multiplexes per wire protocol, relative to the host.
 *
 * These go in the endpoint path, not the base URL: `ProviderDispatchTarget`
 * carries the endpoint path from the model row, and `joinUrl` concatenates
 * both verbatim, so a prefix present in each would dispatch to
 * `…/api/llm/a/api/llm/a/v1/messages`.
 */
const OPENAI_WIRE_BASE = "/api/llm/o/v1";

/**
 * Client identity Factory expects on every call.
 *
 * Pinned to the version Factory's own CLI reports. A version the proxy does not
 * recognise is still a first-party-shaped request; inventing a new number per
 * release would claim compatibility this build has not tested.
 */
const FACTORY_DROID_CLIENT_VERSION = "1.0.0";

function factoryClientHeaders(orgId: string): Record<string, string> {
  return {
    "X-Client-Version": FACTORY_DROID_CLIENT_VERSION,
    "X-Factory-Client": "cli",
    "X-Factory-Org-Id": orgId,
    "user-agent": `factory-cli/${FACTORY_DROID_CLIENT_VERSION}`,
  };
}

/**
 * Upstream routers Factory dispatches to, sent as `x-api-provider`.
 *
 * Copied verbatim from the donor's registry vocabulary
 * (`packages/catalog/src/wire/factory-droid.ts:30-45`, `FACTORY_DROID_UPSTREAMS`),
 * which is also the set the KDL compiler validates the rotation and region axes
 * against. Cross-checked against every `upstream-rotation` and
 * `region-upstreams-*` value in
 * `packages/catalog/src/compat/rules/providers/factory-droid.kdl`: the two sets
 * are identical, so no KDL row names an upstream outside this list.
 *
 * The donor's provider pins the header from that same vocabulary
 * (`packages/ai/src/providers/factory-droid.ts:271` — `"x-api-provider":
 * input.upstream`), so a value outside it has no meaning on this wire.
 */
const FACTORY_DROID_UPSTREAMS = [
  "fireworks",
  "baseten",
  "mistral",
  "anthropic",
  "azure_anthropic",
  "vertex_anthropic",
  "bedrock_anthropic",
  "openai",
  "azure_openai",
  "bedrock_openai",
  "google",
  "xai",
  "snowflake",
  "databricks",
] as const;

type FactoryDroidUpstream = (typeof FACTORY_DROID_UPSTREAMS)[number];

const FACTORY_DROID_UPSTREAM_SET: ReadonlySet<string> = new Set(FACTORY_DROID_UPSTREAMS);

/** Narrows a raw string to the declared vocabulary, or `undefined` when outside it. */
function factoryDroidUpstream(value: string): FactoryDroidUpstream | undefined {
  return FACTORY_DROID_UPSTREAM_SET.has(value) ? (value as FactoryDroidUpstream) : undefined;
}

/** Logs the rejected token truncated: enough to name it, never enough to smuggle a payload. */
function logDroppedUpstream(reason: string, value: string): void {
  log.warn(`factory: dropping x-api-provider value (${reason})`, {
    providerId: FACTORY_PROVIDER_ID,
    rejected: value.slice(0, 64),
  });
}

/**
 * Names the upstream provider Factory should route this request to.
 *
 * Without it every request takes Factory's default routing. The value is a
 * token from {@link FACTORY_DROID_UPSTREAMS}, read from the caller's
 * `factory_api_provider` provider_options key.
 *
 * A value outside the vocabulary is **omitted**, not forwarded. The donor only
 * ever sends a declared upstream, so an undeclared token is not "a routing hint
 * Factory may understand" — it is a value this gateway has no evidence for, and
 * sending it would make Factory's refusal (or its silent fallthrough) our own
 * unmapped failure. Omitting falls back to Factory's default routing, which is
 * the behavior a request that names no upstream already gets.
 */
function factoryApiProviderHeader(
  options: Readonly<Record<string, unknown>> | undefined,
): Record<string, string> {
  const value = options?.["factory_api_provider"];
  if (typeof value !== "string" || value.length === 0) return {};
  // A header value carrying a newline would let a caller inject one; the
  // selector is a token, not free text.
  if (/[\r\n\0]/.test(value)) {
    logDroppedUpstream("header injection", value);
    return {};
  }
  if (factoryDroidUpstream(value) === undefined) {
    logDroppedUpstream("not a declared upstream", value);
    return {};
  }
  return { "x-api-provider": value };
}

/**
 * The API host for this account.
 *
 * Residency is read from account `auth_state`, where the login recorded what
 * `/api/cli/whoami` reported. An account with no recorded residency is the
 * global host, which is Factory's default.
 */
function factoryBaseUrl(context: ProviderDispatchContext): string {
  const region = context.credential.auth_state?.["region"];
  return region === "eu" ? FACTORY_DROID_EU_BASE_URL : FACTORY_DROID_BASE_URL;
}

/**
 * The inference region that decides which upstreams may serve an account.
 *
 * The donor keeps residency (which chooses the API host) and inference region
 * (which chooses eligible upstreams) as separate axes, and an EU-host account
 * can legitimately have global inference
 * (`packages/catalog/src/wire/factory-droid.ts:50-67`):
 * `inferenceRegion` wins when recorded, EU residency infers EU, everything else
 * is global.
 *
 * NOTE: our login records residency only (`factory-oauth.ts:128-132` writes
 * `orgId`, `email`, `userId` and no `region`), so the inference axis is always
 * the global one today and `region` here comes from whatever the console/or
 * operator wrote into `auth_state`. The two-axis read is kept because the donor
 * needs it, not because we currently populate the second axis.
 */
function factoryInferenceRegion(
  context: ProviderDispatchContext,
): "global" | "us" | "eu" {
  const state = context.credential.auth_state;
  const inference = state?.["inference_region"] ?? state?.["inferenceRegion"];
  // An explicit axis wins, including an explicit `global`: that is the case the
  // donor calls out, an EU-host account with global inference. Only its absence
  // falls back to inferring from residency.
  if (inference === "global" || inference === "us" || inference === "eu") return inference;
  return state?.["region"] === "eu" ? "eu" : "global";
}

/**
 * Upstreams Factory's registry serves for a region.
 *
 * Transcribed from
 * `packages/catalog/src/compat/rules/providers/factory-droid.kdl:402-406`,
 * where a bare `region-upstreams-<region>` directive means the region does not
 * serve the model at all.
 */
const REGION_UPSTREAMS: Readonly<Record<"global" | "us" | "eu", readonly FactoryDroidUpstream[]>> =
  {
    global: [
      "fireworks",
      "baseten",
      "mistral",
      "anthropic",
      "azure_anthropic",
      "vertex_anthropic",
      "bedrock_anthropic",
      "openai",
      "azure_openai",
      "bedrock_openai",
      "google",
      "xai",
      "snowflake",
      "databricks",
    ],
    us: [
      "baseten",
      "anthropic",
      "vertex_anthropic",
      "bedrock_anthropic",
      "openai",
      "bedrock_openai",
      "google",
      "xai",
    ],
    eu: ["vertex_anthropic", "bedrock_anthropic", "openai", "bedrock_openai"],
  };

/**
 * The region-unavailable rejection, typed instead of opaque.
 *
 * The donor raises exactly this when no upstream is eligible for the account's
 * region — `requireUpstream`
 * (`packages/ai/src/providers/factory-droid.ts:100-103`) throws
 * `AIError.ConfigurationError("Factory Droid model is unavailable in this
 * account region.")`, reached from both the no-identity and the
 * narrowed-rotation arms (`factory-droid.ts:131,148`).
 *
 * `capability_unsupported` is the closest code in our vocabulary
 * (`gateway-error.ts:6`): the account cannot be served this model from where it
 * is, which is a property of the route rather than of the request. The donor's
 * own message text is preserved as the `reason` so the mapping is traceable.
 */
function factoryRegionUnavailable(modelId: string, region: string): GatewayError {
  return new GatewayError(
    "capability_unsupported",
    400,
    `factory: ${modelId} is unavailable in this account region (${region}) (request {requestId}). Know your tools — this one just isn't in the box 🧰`,
    { model: modelId, region, reason: "Factory Droid model is unavailable in this account region." },
  );
}

/**
 * Declares how this request's upstream was chosen (research Factory #3).
 *
 * The donor sends `x-provider-routing-source` on every inference call
 * (`packages/ai/src/providers/factory-droid.ts:272`), computed at
 * `factory-droid.ts:586-593`:
 *
 * - `session_lock` once the session has a locked upstream — any continuation
 *   (a prior assistant turn), or from the start on routes whose policy locks it;
 * - `configured_order` when live routing chose the rotation;
 * - `registry_default` when it did not.
 *
 * The `configured_order` arm needs live routing discovery
 * (`packages/catalog/src/discovery/factory-droid.ts:204` sets
 * `factoryDroidRoutingSource` only there), which this gateway does not do, so
 * the only rungs reachable here are `session_lock` and `registry_default`.
 * Sending `configured_order` without that discovery would claim a rotation we
 * never resolved.
 */
function factoryRoutingSourceHeader(request: CanonicalRequest): Record<string, string> {
  const continuing = request.messages.some((message) => message.role === "assistant");
  return { "x-provider-routing-source": continuing ? "session_lock" : "registry_default" };
}

/**
 * The upstream this request is routed to, narrowed to the account's region.
 *
 * The donor narrows the caller's rotation to what the region serves and refuses
 * when the intersection is empty (`packages/ai/src/providers/factory-droid.ts:146-150`,
 * then `requireUpstream` at :100). This is the same decision with our inputs: the
 * caller's single `factory_api_provider` token instead of a discovered rotation.
 *
 * A caller that names no upstream gets no header — Factory's default routing,
 * which is what a request naming none already gets. Only a caller that *asked*
 * for an upstream this region does not serve is refused, and refused with the
 * donor's own region-unavailable error rather than an upstream 4xx this layer
 * cannot explain.
 */
function factoryRegionCheckedApiProviderHeader(
  request: CanonicalRequest,
  context: ProviderDispatchContext,
): Record<string, string> {
  const header = factoryApiProviderHeader(request.provider_options);
  const upstream = header["x-api-provider"];
  if (upstream === undefined) return header;
  // Narrows rather than casts: the header only carries a value that passed
  // `factoryDroidUpstream`, but the type is re-derived so the region lookup stays
  // a check on the vocabulary instead of a claim about a string.
  const declared = factoryDroidUpstream(upstream);
  const region = factoryInferenceRegion(context);
  if (declared !== undefined && REGION_UPSTREAMS[region].includes(declared)) return header;
  throw factoryRegionUnavailable(request.model, region);
}

/** The two routing headers together, as every Factory wire sends them. */
function factoryRoutingHeaders(
  request: CanonicalRequest,
  context: ProviderDispatchContext,
): Record<string, string> {
  return {
    ...factoryRegionCheckedApiProviderHeader(request, context),
    ...factoryRoutingSourceHeader(request),
  };
}

/**
 * Decodes the stored envelope, failing closed.
 *
 * Unlike a bare bearer there is no meaningful partial state here: without the
 * org claim Factory rejects the call as an unscoped identity, so a credential
 * that does not decode is an error the operator has to fix by signing in again,
 * not a request worth attempting against the default host.
 */
function factoryEnvelope(context: ProviderDispatchContext): { token: string; orgId: string } {
  const secret = context.credential.secret;
  if (secret === undefined || secret.length === 0) {
    throw new GatewayError("invalid_request", 400, "factory: credential is missing a secret value (request {requestId}). Wrong key, right door — check the credential 🔑");
  }
  try {
    const envelope = decodeFactoryDroidCredential(secret);
    return { token: envelope.accessToken, orgId: envelope.orgId };
  } catch (error) {
    throw new GatewayError(
      "invalid_request",
      400,
      `factory: ${error instanceof Error ? error.message : "stored credential is not a Factory Droid envelope"} (request {requestId}). Wrong key, right door — check the credential 🔑`,
    );
  }
}

/** Shared spec for the two OpenAI-family legs, with the envelope applied. */
function openAiWireSpec(
  context: ProviderDispatchContext,
  request: CanonicalRequest,
): ApiKeyProviderSpec {
  const { token, orgId } = factoryEnvelope(context);
  return {
    provider_id: FACTORY_PROVIDER_ID,
    endpoint_paths_by_wire_family: {
      chat: `${OPENAI_WIRE_BASE}/chat/completions`,
      responses: `${OPENAI_WIRE_BASE}/responses`,
    },
    resolveBaseUrl: () => factoryBaseUrl(context),
    extra_headers: {
      ...factoryClientHeaders(orgId),
      ...factoryRoutingHeaders(request, context),
      authorization: `Bearer ${token}`,
    },
  };
}

/**
 * Factory Droid dispatch: the OpenAI-shaped legs for chat/responses, and the
 * native Messages leg for `messages`.
 *
 * The Messages leg is built directly rather than through the shared factory
 * because Factory authenticates it with the same bearer but stamps its own
 * client identity headers, and `buildClaudeMessagesRequest` is where those
 * headers are assembled.
 */
class FactoryDroidAdapter implements ProviderAdapter {
  readonly provider_id = FACTORY_PROVIDER_ID;
  private readonly fetchFn: typeof fetch;

  constructor(fetchImpl?: typeof fetch) {
    this.fetchFn = fetchImpl ?? globalThis.fetch;
  }

  async *dispatch(
    request: CanonicalRequest,
    candidate: ProviderDispatchTarget,
    context: ProviderDispatchContext,
  ): AsyncIterable<CanonicalEvent> {
    const { token, orgId } = factoryEnvelope(context);
    const baseUrl = factoryBaseUrl(context);

    if (candidate.wire_family === "messages") {
      const outbound = buildClaudeMessagesRequest({
        request: applyParamQuirks(request, candidate.provider_id),
        authHeader: "bearer",
        credential: {
          secret: token,
          customHeaders: {
            ...factoryClientHeaders(orgId),
            ...factoryRoutingHeaders(request, context),
            ...filterClaudeCustomHeaders({ ...context.credential.custom_headers }),
          },
        },
        baseUrl,
        endpointPath: candidate.endpoint_path,
      });
      yield* sendClaudeMessagesRequest(
        outbound.url,
        outbound.headers,
        outbound.body,
        context,
        request,
        this.fetchFn,
      );
      return;
    }

    // Factory's native Gemini wire: generateContent at `/api/llm/g/v1/generate`
    // with `x-api-provider: google` (donor `packages/catalog/src/wire/
    // factory-droid.ts:83-84`, `factory-droid/gemini.ts:28`, and
    // `packages/ai/test/factory-droid-gemini.test.ts:25`). Posting this to the
    // OpenAI leg would send a chat body to an endpoint that speaks neither.
    if (candidate.wire_family === "gemini") {
      yield* this.dispatchGeminiWire(request, candidate, context, {
        token,
        orgId,
        baseUrl,
      });
      return;
    }

    // The OpenAI-shaped legs are built per dispatch: the bearer and the org id
    // are read from the credential then, not captured when the registry
    // resolved this adapter. One spec carries both paths.
    yield* createApiKeyAdapter(openAiWireSpec(context, request), this.fetchFn).dispatch(
      request,
      candidate,
      context,
    );
  }

  /**
   * The `gemini` wire: native generateContent over SSE.
   *
   * The envelope is the shared Gemini builder this gateway already uses for
   * Antigravity, so Gemini encoding has one owner. What is Factory-specific is
   * the path, the upstream selector, and the auth/client headers.
   */
  private async *dispatchGeminiWire(
    request: CanonicalRequest,
    candidate: ProviderDispatchTarget,
    context: ProviderDispatchContext,
    identity: { readonly token: string; readonly orgId: string; readonly baseUrl: string },
  ): AsyncIterable<CanonicalEvent> {
    const url = endpointUrl(
      identity.baseUrl,
      candidate.endpoint_path || FACTORY_GEMINI_ENDPOINT_PATH,
    );
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: request.stream ? "text/event-stream" : "application/json",
      authorization: `Bearer ${identity.token}`,
      ...factoryClientHeaders(identity.orgId),
      ...factoryRoutingHeaders(request, context),
      // The upstream selector is what routes this to Google rather than to
      // Factory's default router.
      "x-api-provider": "google",
    };
    const outboundFetch: typeof fetch =
      (context.outbound_fetch as unknown as typeof fetch) ?? this.fetchFn;
    const lifecycle = createUpstreamDeadlineLifecycle(context);
    let response: Response;
    try {
      response = await outboundFetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(
          buildGeminiPayload(
            request,
            ...(context.image_clamp_max_bytes === undefined
              ? []
              : [{ maxBytesOverride: context.image_clamp_max_bytes }]),
          ),
        ),
        signal: lifecycle.signal,
      });
    } catch (error: unknown) {
      const abortError = abortGatewayError(lifecycle, error, context.abort_signal);
      lifecycle.release();
      if (abortError) throw abortError;
      throw error;
    }
    lifecycle.release();
    if (!response.ok) throw await mapUpstreamHttpError(response, "factory");
    if (!request.stream) {
      const json = (await response.json()) as Record<string, unknown>;
      yield* this.geminiBodyToEvents(json, request);
      return;
    }
    if (response.body === null)
      throw new GatewayError(
        "platform_unavailable",
        502,
        "factory gemini returned empty stream (request {requestId}). The upstream came back empty-handed — retry 🌙",
        {},
        "upstream",
      );
    yield* this.geminiStreamToEvents(
      response.body as ReadableStream<Uint8Array>,
      request,
      lifecycle.signal,
    );
  }

  /**
   * One full (non-streaming) generateContent body as canonical events.
   *
   * Uses the shared Gemini response helpers so Gemini decoding has one owner
   * rather than a second copy here. `finishReason` maps by the donor's table
   * (`factory-droid/gemini.ts:84-107`): STOP → stop, MAX_TOKENS → length, and
   * anything else is an error rather than a clean stop — an unknown terminator
   * must not masquerade as success.
   */
  private async *geminiBodyToEvents(
    json: Record<string, unknown>,
    request: CanonicalRequest,
  ): AsyncIterable<CanonicalEvent> {
    const { response: decoded, candidate: cand, parts } = geminiCandidate(json);
    const output = responseParts(parts);
    let seq = 1;
    yield { type: "response_start", sequence_number: seq++, model: request.model } as CanonicalEvent;
    if (output.thought) {
      yield {
        type: "content_delta",
        sequence_number: seq++,
        content: { kind: "reasoning", payload: null, summary: output.thought, ...(output.thoughtSignature ? { signature: output.thoughtSignature } : {}) },
      } as CanonicalEvent;
    }
    if (output.text) {
      yield {
        type: "content_delta",
        sequence_number: seq++,
        content: { kind: "text", text: output.text },
      } as CanonicalEvent;
    }
    for (const call of output.calls) {
      yield {
        type: "tool_call_delta",
        sequence_number: seq++,
        call_id: call.id,
        name: call.name,
        arguments_delta: JSON.stringify(call.args),
      } as CanonicalEvent;
    }
    const finishReason = typeof cand["finishReason"] === "string" ? cand["finishReason"] : undefined;
    yield {
      type: "terminal",
      sequence_number: seq++,
      // No finishReason on a full body means the upstream response was
      // truncated: never complete.
      state: finishReason === undefined ? "failed" : "complete",
      stop_reason: toCanonicalStopReason(cand, output.calls.length),
      ...(finishReason ? { provider_stop_reason: finishReason } : {}),
      usage: usageFromProvider(mapGeminiUsage(decoded)),
    } as CanonicalEvent;
  }

  /** Streaming generateContent: one canonical event per decoded SSE chunk. */
  private async *geminiStreamToEvents(
    body: ReadableStream<Uint8Array>,
    request: CanonicalRequest,
    signal: AbortSignal,
  ): AsyncIterable<CanonicalEvent> {
    let seq = 1;
    yield { type: "response_start", sequence_number: seq++, model: request.model } as CanonicalEvent;
    for await (const sse of decodeSseEvents(body, { signal })) {
      const data = sse.data.trim();
      if (data === "[DONE]") break;
      const parsed = decodeGeminiStreamEvent(data, "factory gemini stream error");
      if (parsed === undefined) continue;
      const { candidate: cand, parts } = geminiCandidate(parsed);
      const output = responseParts(parts);
      if (output.thought) {
        yield {
          type: "content_delta",
          sequence_number: seq++,
          content: { kind: "reasoning", payload: null, summary: output.thought, ...(output.thoughtSignature ? { signature: output.thoughtSignature } : {}) },
        } as CanonicalEvent;
      }
      if (output.text) {
        yield {
          type: "content_delta",
          sequence_number: seq++,
          content: { kind: "text", text: output.text },
        } as CanonicalEvent;
      }
      for (const call of output.calls) {
        yield {
          type: "tool_call_delta",
          sequence_number: seq++,
          call_id: call.id,
          name: call.name,
          arguments_delta: JSON.stringify(call.args),
        } as CanonicalEvent;
      }
      const finishReason = typeof cand["finishReason"] === "string" ? cand["finishReason"] : undefined;
      if (finishReason !== undefined) {
        yield {
          type: "terminal",
          sequence_number: seq++,
          state: "complete",
          stop_reason: toCanonicalStopReason(cand, output.calls.length),
          provider_stop_reason: finishReason,
        } as CanonicalEvent;
      }
    }
  }
}

export function createFactoryDroidAdapter(fetchImpl?: typeof fetch): ProviderAdapter {
  return new FactoryDroidAdapter(fetchImpl);
}

export const factoryAdapter: ProviderAdapter = new FactoryDroidAdapter();