import { GatewayError } from "../../protocol/gateway-error";
import type { CanonicalEvent, CanonicalRequest, WireFamily } from "../../protocol/canonical-model";
import { isRecord } from "../../protocol/codecs";
import {
  classifyUpstreamError,
  isContextLengthFailure,
  throwIfHtmlResponse,
  mapUpstreamHttpError,
  extractHtmlTitle,
  upstreamErrorIdentifier,
  upstreamMessageAsIs,
} from "../../transport/failure-policy";
import { applyRouteUserAgent, type ProviderDispatchTarget, type ProviderId, type ProviderDispatchContext } from "../provider-contracts";
import { BaseProviderAdapter } from "./base-adapter";
import { encodeWireRequest, decodeWireResponse, decodeWireStream } from "../../protocol/registry";
import { resolveDialect } from "../../protocol/translation/dialect/resolver";
import { resolveThinkingForModel } from "../../protocol/translation/dialect/thinking-ladder";
import type { DialectPolicy } from "../../protocol/translation/dialect/types";
import { postUpstreamJson } from "../../protocol/upstream/post-json";
import { gzipSync } from "node:zlib";
import { GATEWAY_USER_AGENT } from "../operations/gateway-user-agent";
import { resolvePromptCacheKey } from "../operations/session-resolution";
import {
  BUILTIN_DEFAULT_ENDPOINTS,
  filterProviderCustomHeaders,
  joinUrl,
  normalizeBearerToken,
  type AuthHeaderShape,
} from "../../protocol/codecs";
const TEXT_DECODER = new TextDecoder("utf-8", { fatal: false });

/**
 * Whether an upstream error body is the channel-check rejection the CodeBuddy
 * console fallback recovers from. Ported from the donor gateway
 * (`codebuddy2api/upstream_compat.is_channel_check_error`): it requires both
 * a channel-check business code (`11128` / `11-128`) and one of the
 * explanatory texts. A bare code match swept unrelated failures into a retry.
 */
export function isBuddyChannelCheckError(raw: string): boolean {
  if (!/code["']?\s*:\s*["']?(?:11128|11-128)/i.test(raw)) return false;
  const lower = raw.toLowerCase();
  return (
    lower.includes("渠道校验") || // 渠道校验
    lower.includes("channel verification") ||
    lower.includes("official client") ||
    lower.includes("illegal api invocation from an unapproved channel")
  );
}

/**
 * Provider ids that understand the OpenAI-style `service_tier` control. Only
 * these upstreams accept the field; every other OpenAI-compatible provider
 * either ignores it or rejects the whole request with `unsupported_value`
 * (measured: GitHub Copilot returns 400). `service_tier` is advisory on the
 * providers that do support it, so dropping it elsewhere is lossless.
 */
const SERVICE_TIER_SUPPORTED_PROVIDERS: ReadonlySet<string> = new Set([
  "openai",
  "codex",
  "anthropic",
]);

/**
 * The subset of a canonical request a native-service header hook may read.
 *
 * `prepareHeaders` takes a full `CanonicalRequest`, but a native route has no
 * canonical request — its body is opaque. The header hooks that run on that
 * path (OpenCode's fingerprint builder, OpenRouter's static headers) read only
 * `stream`, so a native call supplies this minimal stand-in rather than a
 * fabricated chat request.
 */
const NATIVE_HEADER_REQUEST: CanonicalRequest = {
  model: "",
  messages: [],
  generation_controls: {},
  stream: false,
  source_surface: "chat",
};

export interface OpenAICompatibleAdapterConfig {
  readonly provider_id: ProviderId;
  readonly base_url: string;
  /**
   * Credential-derived origin override, applied at transport time.
   *
   * A few upstreams put per-account state in the path *prefix* rather than in a
   * header — Alibaba's plan region, Factory's residency host — so the origin
   * cannot live in `base_url`, which is fixed when the adapter is built. The
   * resolver returns the origin to use instead; returning `undefined` keeps
   * `base_url`. Throwing is how a credential that cannot be decoded fails
   * closed: dispatching to the default host would be a silent wrong-region call.
   */
  readonly resolveBaseUrl?: (context: ProviderDispatchContext) => string | undefined;
  readonly authentication_header_shape: AuthHeaderShape;
  readonly endpoint_paths_by_wire_family?: Partial<Record<WireFamily, string>>;
  readonly extra_headers?: Readonly<Record<string, string>>;
  readonly extra_query_params?: Readonly<Record<string, string>>;
  readonly streaming_usage_mode?: "include_usage" | "none";
  readonly structured_output?: { readonly mode: "json_object" | "json_schema"; readonly enabled: boolean; readonly schema?: Record<string, unknown> };
  /** Whether this provider accepts OpenAI prompt cache controls on its wire. */
  readonly supports_prompt_caching?: boolean;
  /** Chat wire field used for the maximum completion token limit. */
  readonly chat_token_limit_field?: "max_tokens" | "max_completion_tokens";
  /** Final payload mutation hook — runs after canonical translation, before serialization. Lets a provider promote extension-namespaced `generation_controls` fields (e.g. Cerebras `extra_body`) without a fetch-wrapping hack. */
  /**
   * Per-dispatch dynamic header hook, applied after `extra_headers` (so it
   * can layer on top of static config). Unlike `extra_headers`, this runs
   * once per request — for providers that need fresh per-request values
   * (e.g. OpenCode's session aliases and trace headers) rather than a fixed
   * header set.
   */
  readonly buildExtraHeaders?: (
    context: ProviderDispatchContext,
    request?: CanonicalRequest,
    candidate?: ProviderDispatchTarget,
  ) => Record<string, string> | Promise<Record<string, string>>;
  /**
   * "account" (default) forwards whatever `credential_kind` the dispatched
   * account declares. "never" unconditionally withholds `Authorization`
   * regardless of account configuration — for providers with a genuinely
   * public/unauthenticated endpoint (e.g. OpenCode Free) where sending a
   * stray key would be actively wrong, not merely unnecessary. Console
   * account creation still allows any `credentialKind` for these providers;
   * this is the enforcement boundary, not account-creation validation.
   */
  readonly credential_forwarding?: "account" | "never";
  /**
   * Body encoding for the upstream POST. `"json"` (default) sends the plain
   * JSON string. `"zstd"` compresses the JSON with `Bun.zstdCompressSync` and
   * stamps `Content-Encoding: zstd` — the Grok Build CLI does this via its
   * sampler (`request_compression.rs`), and the proxy accepts it (verified
   * live 2026-11-02). Falls back to plain JSON if the runtime lacks zstd.
   * `"gzip"` compresses with `gzipSync` and stamps `Content-Encoding: gzip`
   * — the CodeBuddy CLI contract (donor `codebuddy2api`): the CLI profiles
   * always compress; the CN desktop profile compresses requests >= 1024 B.
   * The caller must also send `Accept-Encoding: identity` (the compressed
   * body and the uncompressed response are independent choices).
   */
  readonly request_compression?: "json" | "zstd" | "gzip";
  /**
   * One retry against this path when the primary chat endpoint answers a
   * channel-check 400 (`11128` / `11-128`). Matches the donor gateway's
   * `/console/chat/completions` fallback for the international profile: the
   * primary `v2` endpoint rejects requests that do not carry the channel
   * marker, and a single console retry is the reference's recovery.
   */
  readonly channel_fallback_path?: string;
  /**
   * Stamps `user-agent: Cartethyia/<version>` on every dispatch. Explicit
   * opt-in per provider spec — never a default — so first-party cloaking
   * (Codex, Claude Code) is untouched.
   */
  readonly gateway_user_agent?: boolean;
  /** Canonical request hook, applied before wire translation. Narrower than
   * `prePayload`: the returned request is what every wire codec serializes. */
  readonly prepareRequest?: (request: CanonicalRequest) => CanonicalRequest;
  readonly prePayload?: (
    payload: Record<string, unknown>,
    request: CanonicalRequest,
    candidate: ProviderDispatchTarget,
    context: ProviderDispatchContext,
  ) => void;
  /** Transport injection for tests; defaults to global fetch. */
  readonly fetch?: typeof fetch;
}

export function withBearerAuthentication(
  decl: Omit<OpenAICompatibleAdapterConfig, "authentication_header_shape" | "fetch"> & {
    fetchImpl?: typeof fetch;
  },
): OpenAICompatibleAdapterConfig {
  const { fetchImpl, ...rest } = decl;
  return {
    ...rest,
    authentication_header_shape: "authorization_bearer",
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  };
}

function resolveEndpoint(
  wireFamily: WireFamily,
  overrides?: Partial<Record<WireFamily, string>>,
): string {
  return overrides?.[wireFamily] ?? BUILTIN_DEFAULT_ENDPOINTS[wireFamily] ?? "/v1/chat/completions";
}

/**
 * Builds the credential header for one wire family's auth shape. Exported so
 * the BYOK ad-hoc connection test stamps the exact same header the adapter
 * will send at dispatch time, instead of a hand-rolled copy that can drift.
 */
export function authHeaders(
  shape: AuthHeaderShape,
  secret: Uint8Array | undefined,
  credentialKind: string,
): Record<string, string> {
  if (credentialKind === "none" || !secret || secret.length === 0) return {};
  const token = normalizeBearerToken(TEXT_DECODER.decode(secret));
  if (token.length === 0) return {};
  if (shape === "x_api_key") {
    return { "x-api-key": token };
  }
  return { authorization: `Bearer ${token}` };
}

/**
 * Concrete provider adapter implementation for the OpenAI-compatible family,
 * extending BaseProviderAdapter and implementing both /chat/completions and /v1/responses.
 */
export class OpenAICompatibleAdapter extends BaseProviderAdapter {
  readonly provider_id: ProviderId;
  private readonly config: OpenAICompatibleAdapterConfig;

  constructor(config: OpenAICompatibleAdapterConfig) {
    super();
    this.config = config;
    this.provider_id = config.provider_id;
  }

  protected async prepareHeaders(
    context: ProviderDispatchContext,
    request: CanonicalRequest,
    candidate: ProviderDispatchTarget,
  ): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      // Explicit opt-in only (`gateway_user_agent: true` on the spec): the
      // default Bun/undici agent stays for everyone else, and first-party
      // cloaking paths never pass through here.
      ...(this.config.gateway_user_agent === true ? { "user-agent": GATEWAY_USER_AGENT } : {}),
    };
    Object.assign(
      headers,
      authHeaders(
        this.config.authentication_header_shape,
        context.credential.secret,
        this.config.credential_forwarding === "never" ? "none" : context.credential.credential_kind,
      ),
    );
    if (this.config.extra_headers) Object.assign(headers, this.config.extra_headers);
    if (this.config.buildExtraHeaders) {
      // Await the hook so version-discovery-backed header builders block on
      // resolving the true latest client version instead of racing it and
      // serving the stale pinned fallback on the first dispatch.
      Object.assign(headers, await this.config.buildExtraHeaders(context, request, candidate));
    }
    // The compression header must match the body actually sent. It is stamped
    // here — alongside the other request headers — so auth/proxy layers see the
    // final shape before the transport runs.
    if (this.config.request_compression === "zstd") headers["content-encoding"] = "zstd";
    else if (this.config.request_compression === "gzip") {
      headers["content-encoding"] = "gzip";
      // The compressed request and the response encoding are independent; the
      // reference requests the identity response encoding so the stream arrives
      // uncompressed (matching `Accept-Encoding: identity` in the donor).
      headers["accept-encoding"] = "identity";
    }
    Object.assign(headers, filterProviderCustomHeaders(context.credential.custom_headers));
    applyRouteUserAgent(headers, context.credential, context.user_agent);
    return headers;
  }

  protected async preparePayload(
    request: CanonicalRequest,
    candidate: ProviderDispatchTarget,
    context: ProviderDispatchContext,
  ): Promise<unknown> {
    const wireFamily = candidate.wire_family;
    const effectiveRequest = this.config.prepareRequest?.(request) ?? request;
    const promptCacheKey = resolvePromptCacheKey(effectiveRequest, context);
    const dialectPolicy: DialectPolicy = resolveDialect(
      candidate.model_id,
      candidate.provider_id,
      wireFamily,
      candidate.dialect,
    );
    const thinking = resolveThinkingForModel(
      candidate.model_id,
      candidate.provider_id,
      wireFamily,
    );
    const payload = await encodeWireRequest(wireFamily, effectiveRequest, {
      supportsPromptCaching: this.config.supports_prompt_caching !== false,
      ...(promptCacheKey === undefined ? {} : { promptCacheKey }),
      ...(candidate.output_limit == null ? {} : { maxOutputTokens: candidate.output_limit }),
      ...(this.config.chat_token_limit_field === undefined
        ? {}
        : { chatTokenLimitField: this.config.chat_token_limit_field }),
      ...(context.image_clamp_max_bytes === undefined
        ? {}
        : { maxBytesOverride: context.image_clamp_max_bytes }),
      dialectPolicy,
      thinking,
    });
    if (
      wireFamily !== "messages" &&
      this.config.streaming_usage_mode !== "none" &&
      effectiveRequest.stream
    ) {
      // OpenAI-compatible bridges only report token usage on a stream when the
      // caller asks for it. Without this, a custom provider's streamed
      // requests record input 0 / output 0 because the upstream never sends a
      // usage frame. "none" is the explicit opt-out for bridges that reject
      // the field.
      //
      // Excluded for the `messages` wire: `stream_options` is an OpenAI field,
      // and a strict Anthropic-compatible upstream rejects the whole body
      // (`stream_options: Extra inputs are not permitted`). The native Messages
      // protocol reports usage without an opt-in — `message_start.message.usage`
      // plus `message_delta.usage` — so nothing is lost by omitting it.
      const existing = payload["stream_options"] as Record<string, unknown> | undefined;
      payload["stream_options"] = { ...(existing ?? {}), include_usage: true };
    } else if (!effectiveRequest.stream && payload["stream_options"] !== undefined) {
      // A non-streaming request must not carry `stream_options`: several
      // OpenAI-compatible upstreams (NVIDIA NIM, DeepSeek) reject the body
      // with 400 "Stream options can only be defined when stream=True".
      delete payload["stream_options"];
    }
    // Apply structured_output configuration
    if (this.config.structured_output?.enabled) {
      if (this.config.structured_output.mode === "json_object") {
        payload["response_format"] = { type: "json_object" };
      } else if (this.config.structured_output.mode === "json_schema" && this.config.structured_output.schema) {
        // Only emit strict:true when a real schema was supplied by the caller
        payload["response_format"] = {
          type: "json_schema",
          json_schema: { 
            name: "response", 
            strict: true, 
            schema: this.config.structured_output.schema 
          },
        };
      } else {
        // Default to json_object for generic case without a real schema
        payload["response_format"] = { type: "json_object" };
      }
    }
    this.config.prePayload?.(payload, effectiveRequest, candidate, context);
    // `service_tier` is an OpenAI-style control that only a small set of
    // upstreams understand. Every other OpenAI-compatible provider either
    // ignores it silently or rejects the whole request with
    // `unsupported_value` (measured: GitHub Copilot returns 400). Since the
    // field is purely advisory on the providers that support it, dropping it
    // everywhere else is safe and prevents avoidable upstream 400s.
    if (
      payload["service_tier"] !== undefined &&
      !SERVICE_TIER_SUPPORTED_PROVIDERS.has(candidate.provider_id)
    ) {
      delete payload["service_tier"];
    }
    return payload;
  }

  protected async executeTransport(
    headers: Record<string, string>,
    payload: unknown,
    context: ProviderDispatchContext,
    _request?: CanonicalRequest,
    candidate?: ProviderDispatchTarget,
  ): Promise<Response> {
    const wireFamily = candidate?.wire_family ?? "chat";
    const endpointPath =
      candidate?.endpoint_path && candidate.endpoint_path.length > 0
        ? candidate.endpoint_path
        : resolveEndpoint(wireFamily, this.config.endpoint_paths_by_wire_family);
    const baseEndpointUrl = joinUrl(this.config.resolveBaseUrl?.(context) ?? this.config.base_url, endpointPath);
    const fetchUrl = (() => {
      if (!this.config.extra_query_params || Object.keys(this.config.extra_query_params).length === 0)
        return baseEndpointUrl;
      const u = new URL(baseEndpointUrl);
      for (const [key, value] of Object.entries(this.config.extra_query_params)) {
        u.searchParams.set(key, value);
      }
      return u.toString();
    })();
    const outboundFetch = context.outbound_fetch ?? this.config.fetch ?? globalThis.fetch;
    const bodyEncoder =
      this.config.request_compression === "zstd" && typeof Bun?.zstdCompressSync === "function"
        ? (p: Record<string, unknown>) => Bun.zstdCompressSync(Buffer.from(JSON.stringify(p))) as Uint8Array<ArrayBuffer>
        : this.config.request_compression === "gzip"
          ? (p: Record<string, unknown>) => gzipSync(Buffer.from(JSON.stringify(p)), { level: 6 })
          : undefined;
    const channelFallback =
      this.config.channel_fallback_path !== undefined &&
      endpointPath !== this.config.channel_fallback_path
        ? joinUrl(this.config.resolveBaseUrl?.(context) ?? this.config.base_url, this.config.channel_fallback_path)
        : undefined;
    const upstream = await postUpstreamJson(fetchUrl, headers, payload as Record<string, unknown>, context, outboundFetch, bodyEncoder);
    if (channelFallback !== undefined && upstream.res.status === 400) {
      // Read the body only for a 400 that could still be retried. The channel
      // check is the one refusal the console endpoint recovers from; a rejected
      // body is consumed here so the fallback attempt carries a fresh stream.
      const raw = await upstream.res.text().catch(() => "");
      upstream.release();
      if (isBuddyChannelCheckError(raw)) {
        const retry = await postUpstreamJson(channelFallback, headers, payload as Record<string, unknown>, context, outboundFetch, bodyEncoder);
        retry.release();
        return retry.res;
      }
      // Not a channel check — reconstruct the 400 response so downstream error
      // classification still sees the upstream's body. A `Response` body can be
      // consumed once, so rebuild it from the captured text.
      return new Response(raw, {
        status: 400,
        statusText: upstream.res.statusText,
        headers: { "content-type": "application/json" },
      });
    }
    upstream.release();
    return upstream.res;
  }

  /**
   * Posts an opaque body to the candidate's own endpoint with this provider's
   * auth/identity headers.
   *
   * The shared escape hatch for any service the gateway does not model —
   * System One decisions, image generation, anything a provider serves from its
   * own path. Deliberately not routed through `preparePayload`/
   * `transformStream`: those encode a `CanonicalRequest` and decode canonical
   * events, and these bodies are neither. The body arrives already-shaped from
   * the caller (the route handler validates only the trust boundary), so this
   * method only stamps headers and posts.
   *
   * `systemone` is kept as a named alias because both names are live: the
   * transport dispatch handler for `POST /v1/systemone`
   * (transport/dispatch/systemone.ts) and the discovery probing service
   * (discovery/probing-service.ts) read it directly; both names are the same
   * behavior.
   */
  async dispatchNativeService(
    body: Record<string, unknown>,
    candidate: ProviderDispatchTarget,
    context: ProviderDispatchContext,
  ): Promise<Response> {
    const headers = await this.prepareHeaders(context, NATIVE_HEADER_REQUEST, candidate);
    const endpointPath =
      candidate.endpoint_path && candidate.endpoint_path.length > 0
        ? candidate.endpoint_path
        : "/v1/systemone";
    const fetchUrl = joinUrl(this.config.base_url, endpointPath);
    const outboundFetch = context.outbound_fetch ?? this.config.fetch ?? globalThis.fetch;
    const upstream = await postUpstreamJson(fetchUrl, headers, body, context, outboundFetch);
    upstream.release();
    return upstream.res;
  }

  /** `/v1/systemone` route entry point; see {@link dispatchNativeService}. */
  async systemone(
    body: Record<string, unknown>,
    candidate: ProviderDispatchTarget,
    context: ProviderDispatchContext,
  ): Promise<Response> {
    return this.dispatchNativeService(body, candidate, context);
  }

  protected async *transformStream(
    res: Response,
    request: CanonicalRequest,
    candidate: ProviderDispatchTarget,
    context: ProviderDispatchContext,
  ): AsyncIterable<CanonicalEvent> {
    if (!res.ok) {
      await throwIfHtmlResponse(res);
      await mapUpstreamHttpError(res, this.provider_id);
    }
    // Edge proxies (Cloudflare etc.) can return an HTML error page with a
    // 2xx/3xx status when the origin is unreachable — surface it as a typed
    // 502 instead of a cryptic SSE/JSON decode failure.
    await throwIfHtmlResponse(res);

    const contentType = res.headers.get("content-type") ?? "";
    const wireFamily = candidate.wire_family;
    if (contentType.includes("text/event-stream")) {
      if (!res.body) {
        throw new GatewayError(
          "platform_unavailable",
          502,
          `${wireFamily === "responses" ? "Responses returned empty stream" : "Chat returned empty stream"} (request {requestId}). The upstream came back empty-handed — retry 🌙`,
          {},
          "upstream",
        );
      }
      yield* decodeWireStream(wireFamily, res.body, request, {
        signal: context.abort_signal,
        dialectPolicy: resolveDialect(candidate.model_id, candidate.provider_id, wireFamily, candidate.dialect),
      });
    } else {
      // A streaming request answered with a non-SSE body is a provider
      // protocol violation, and the body is often an error envelope or a
      // plain-text/HTML page. `res.json()` on that threw a bare `SyntaxError`,
      // which no classifier recognizes: it reached telemetry as
      // `unknown_error` and the client as a 500 "the upstream failure could
      // not be classified" — a gateway-blaming 500 for a perfectly
      // identifiable upstream response. Parse defensively and raise a typed
      // upstream error carrying the provider's own message when there is one.
      const raw = await res.text().catch(() => "");
      let json: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(raw);
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("body is not a JSON object");
        }
        json = parsed as Record<string, unknown>;
      } catch {
        const fallback = `Upstream returned a non-JSON response: ${extractHtmlTitle(raw) || raw.trim() || `HTTP ${res.status}`} (request {requestId}). The connection ghosted us — come back in a moment 👻`;
        const upstreamText = upstreamMessageAsIs(raw, "");
        throw new GatewayError(
          "transport_unavailable",
          502,
          `${upstreamText.message || fallback}`.slice(0, 500),
          { upstreamStatus: res.status, contentType },
          "upstream",
        );
      }
      // A JSON error envelope on a 2xx is still an upstream failure: surface
      // the provider's own code/message instead of decoding it as a normal
      // completion (which would silently yield an empty response). Gated on
      // the absence of every completion shape so a provider that merely
      // echoes an `error` field alongside real output is not misread.
      const envelopeError = json["error"];
      const startPlanError = this.provider_id === "zcode-start" &&
        (json["success"] === false || (json["code"] !== undefined &&
          ![0, 200, "0", "200"].includes(json["code"] as string | number)));
      const hasCompletionShape =
        json["choices"] !== undefined ||
        json["output"] !== undefined ||
        json["content"] !== undefined ||
        json["candidates"] !== undefined;
      if (((envelopeError !== undefined && envelopeError !== null) || startPlanError) && !hasCompletionShape) {
        const errorObject = isRecord(envelopeError) ? envelopeError : json;
        const identifier = upstreamErrorIdentifier(json);
        const providerStatus = [
          errorObject["status"],
          errorObject["statusCode"],
          errorObject["code"],
        ].find(
          (value): value is number =>
            typeof value === "number" &&
            Number.isFinite(value) &&
            value >= 400 &&
            value < 600,
        );
        // A context-window overflow arrives here on the streaming path with a
        // numeric code that says nothing (`11115`) and the real cause in
        // `extError.message`. The status table alone classifies it as a generic
        // refusal, so the one thing a client acts on — the measured prompt size
        // against the window — never reached it. The prose/identifier check
        // mirrors the non-streaming path's pre-table branch.
        const classification = isContextLengthFailure(json)
          ? { code: "context_length_exceeded" as const, status: 413, origin: "upstream" as const, credentialEvidence: false, rateLimitScope: undefined }
          : classifyUpstreamError(providerStatus, identifier);
        const upstreamText = upstreamMessageAsIs(json, "");
        throw new GatewayError(
          classification.code,
          classification.status,
          upstreamText.message || "Upstream reported an error",
          {
            providerId: this.provider_id,
            ...(providerStatus === undefined ? {} : { providerStatus }),
            ...(identifier === undefined ? {} : { providerCode: identifier }),
            ...(upstreamText.hadUpstreamText ? { upstreamMessageAsIs: true } : {}),
            ...(classification.credentialEvidence ? { credentialEvidence: true } : {}),
            ...(classification.rateLimitScope
              ? { rateLimitScope: classification.rateLimitScope }
              : {}),
          },
          classification.origin,
        );
      }
      for (const ev of await decodeWireResponse(wireFamily, json, request)) yield ev;
    }
  }
}
