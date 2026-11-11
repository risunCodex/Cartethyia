/**
 * Qoder adapter — transport selection, credential resolution, dispatch.
 *
 * Surface contract (2026-11-07, verified live 2026-11-11):
 * - `cosy` (default, production): `/algo/.../agent_chat_generation` on
 *   `api1` → `api2` → `api3.qoder.sh` (legacy COSY) — the only surface
 *   verified alive. Accepts free-tier rows (`lite`).
 * - The gRPC surface (`model.chat.ChatService/ChatCompletionStream`) and the
 *   IDE surface (`/model/v1/chat/completions`) are dead on every host that
 *   resolves (gRPC: UNIMPLEMENTED; IDE: 404) since 2026-11-07 and are not
 *   dispatched anymore.
 */
import { GatewayError } from "../../../protocol/gateway-error";
import type { CanonicalEvent, CanonicalRequest } from "../../../protocol/canonical-model";
import {
  assertWireFamily,
  readCredentialSecret,
  type ProviderAdapter,
  type ProviderDispatchContext,
  type ProviderDispatchTarget,
  type ProviderId,
} from "../../provider-contracts";
import { abortGatewayError, createUpstreamDeadlineLifecycle } from "../../operations/upstream-deadline";
import { getQoderVersion } from "../../operations/client-versions";
import { mapUpstreamHttpError } from "../../../transport/failure-policy";
import { QODER_CN_MODEL_CONFIGS, QODER_INTL_MODEL_CONFIGS } from "./qoder-catalog";
import { isQoderVirtualModel, qoderDispatchModelId } from "./qoder-virtual";
import { isQoderPat, qoderOAuthAuth, qoderSessionId, resolveQoderAuth } from "./qoder-auth";
import { buildQoderRequest, callQoder } from "./qoder-chat";
import { qoderBodyToCanonicalEvents } from "./qoder-sse";
import { estimateQoderSessionCache } from "./qoder-cache";
import {
  QODER_CHAT_PATH,
  QODER_PROVIDER_ID,
  qoderInferenceCandidates,
  type QoderRealm,
} from "./qoder-realm";
import type { QoderModelConfig } from "./qoder-types";

interface QoderAdapterOptions {
  readonly fetch?: typeof fetch;
  /** Which deployment this adapter dispatches to. Defaults to intl. */
  readonly realm?: QoderRealm;
  /** Bundled provider id, so the adapter's own id matches the route's. */
  readonly providerId?: string;
  /**
   * Which chat transport to dispatch on.
   *
   * `cosy` (default) = legacy COSY (`/algo/.../agent_chat_generation`) on
   * `api1` → `api2` → `api3.qoder.sh` — the only surface verified alive
   * (2026-11-07; the `api2-v2` model-server host is NXDOMAIN, and the gRPC
   * service is UNIMPLEMENTED on every host that resolves). This path also
   * accepts free-tier rows (`lite`).
   */
  readonly surface?: "cosy";
}

/** Resolves the transport for one dispatch. Exported for tests. */
export function resolveQoderTransport(): "cosy" {
  return "cosy";
}

class QoderAdapter implements ProviderAdapter {
  readonly provider_id: ProviderId;
  private readonly realm: QoderRealm;
  private readonly fetchFn: typeof fetch;

  constructor(options: QoderAdapterOptions = {}) {
    this.provider_id = (options.providerId ?? QODER_PROVIDER_ID) as ProviderId;
    this.realm = options.realm ?? "intl";
    // The legacy COSY surface is the production default (2026-11-07): the
    // gRPC host is NXDOMAIN and the IDE surface is probe-only. The constructor
    // must default to it too, or every billed model dispatches to the dead
    // gRPC path while free-tier rows get cosy via the is_free rule — the
    // mismatch that made `deepseek-v4.1-flash` fail while `qwen3.8-flash`
    // passed. This is the same default `resolveQoderTransport(undefined)`
    // already returns.
    this.fetchFn = options.fetch ?? globalThis.fetch;
  }

  /**
   * The static roster for this adapter's realm.
   *
   * A single merged table advertised CN-only keys to global accounts and vice
   * versa, so a request was routed to a deployment that refuses it.
   */
  #modelConfigs(): Record<string, QoderModelConfig> {
    return (this.realm === "cn" ? QODER_CN_MODEL_CONFIGS : QODER_INTL_MODEL_CONFIGS) as Record<
      string,
      QoderModelConfig
    >;
  }

  /**
   * Wraps an upstream event stream and applies the local session-cache
   * estimate to every `usage` record (and terminal-carried usage).
   *
   * Qoder's upstream never reports prompt-cache hits (verified live on both
   * gRPC and IDE HTTP surfaces), so the gap is closed the same way Trae and
   * Kiro do: estimate the cached prefix from this session's request history.
   */
  async *#withSessionCacheEstimate(
    events: AsyncIterable<CanonicalEvent>,
    request: CanonicalRequest,
    sessionId: string | undefined,
  ): AsyncGenerator<CanonicalEvent> {
    for await (const event of events) {
      if (event.type === "usage") {
        yield { ...event, usage: estimateQoderSessionCache(event.usage, sessionId, request.messages) };
      } else if (event.type === "terminal" && event.usage !== undefined) {
        yield { ...event, usage: estimateQoderSessionCache(event.usage, sessionId, request.messages) };
      } else {
        yield event;
      }
    }
  }

  async *dispatch(
    request: CanonicalRequest,
    candidate: ProviderDispatchTarget,
    context: ProviderDispatchContext,
  ): AsyncIterable<CanonicalEvent> {
    if (candidate.wire_family !== "chat") {
      assertWireFamily(candidate, "chat", "qoder");
    }
    const secret = readCredentialSecret(context.credential, "Qoder credential is required");

    /**
     * A caller-facing virtual name is translated to its roster key here.
     *
     * The translation has to happen before the config lookup and before the
     * request body: the body carries the roster key, and looking up the
     * virtual id in the config table would fall through to the synthetic
     * default and silently dispatch under-declared capabilities.
     */
    const requestedModelId = candidate.model_id || request.model;
    if (isQoderVirtualModel(requestedModelId) && !this.#modelConfigs()[qoderDispatchModelId(requestedModelId)]) {
      throw new GatewayError(
        "model_not_found",
        404,
        `Qoder virtual model ${requestedModelId} resolves to a roster key this realm does not serve (request {requestId}). Try another model — this one's off the menu 📚`,
        { virtual_model: requestedModelId, target: qoderDispatchModelId(requestedModelId) },
        "upstream",
      );
    }
    const modelId = qoderDispatchModelId(requestedModelId);
    const modelConfig = this.#modelConfigs()[modelId] ?? {
      id: modelId,
      display_name: modelId,
      max_input_tokens: 180_000,
      is_vl: true,
      is_reasoning: false,
    };

    const lifecycle = createUpstreamDeadlineLifecycle(context);

    // Outbound fetch respects SSRF binding when provided. When the dispatch
    // context carries a profile-fetch (TLS ClientHello mirror), prefer it for
    // COSY chat: this is what makes the outbound dial look like the Qoder
    // desktop app (Bun worker) at the TLS layer — the same fingerprint the
    // upstream saw when the donor app made the identical request.
    const profileFetcher =
      typeof context.outbound_profile_fetch === "function"
        ? (url: string, init: RequestInit) =>
            context.outbound_profile_fetch!("qoder-app", url, init)
        : undefined;
    const outboundFetch: typeof fetch = (profileFetcher ??
      ((context.outbound_fetch as unknown as typeof fetch) ?? this.fetchFn)) as typeof fetch;

    const fetcher: (url: string, init: RequestInit) => Promise<Response> = (url, init) =>
      outboundFetch(url, { ...init, signal: lifecycle.signal } as RequestInit) as Promise<Response>;

    try {
      const version = getQoderVersion();
      // Dual mode like Cline: a pasted PAT is exchanged for a job token per
      // request, while an OAuth device token is used directly with the
      // identity the login persisted.
      const auth = isQoderPat(secret)
        ? await resolveQoderAuth({ secret, authState: context.credential.auth_state, signal: lifecycle.signal, fetcher, realm: this.realm })
        : qoderOAuthAuth(secret, context.credential.auth_state, context.credential.account_id);

      // Transport selection — see module doc for the surface contract.
      const cosyCandidates = candidate.endpoint_path?.startsWith("http")
        ? [candidate.endpoint_path]
        : qoderInferenceCandidates(this.realm, auth.securityOauthToken).map(
            (host) => `${host}${QODER_CHAT_PATH}`,
          );
      let response: Response | undefined;
      let lastError: unknown;
      for (const cosyUrl of cosyCandidates) {
        try {
          const attempt = () =>
            callQoder(cosyUrl, buildQoderRequest(modelId, request, modelConfig, auth, this.realm), modelId, auth, lifecycle.signal, fetcher, version);
          response = await attempt();
          break;
        } catch (err: unknown) {
          lastError = err;
        }
      }
      if (response === undefined) {
        throw lastError instanceof Error
          ? lastError
          : new GatewayError("transport_unavailable", 502, "Qoder legacy COSY hosts are unreachable (request {requestId}). The connection ghosted us — come back in a moment 👻", {}, "upstream");
      }
      if (!response.ok) throw await mapUpstreamHttpError(response, "qoder");
      if (!response.body) throw new GatewayError("platform_unavailable", 502, "Qoder returned empty body (request {requestId}). The upstream came back empty-handed — retry 🌙", {}, "upstream");
      // Headers arrived: the pre-stream deadline has served its purpose.
      // From here the gateway stall/first-chunk watchdog (propagated via
      // context.abort_signal) governs the body. Keeping this timer armed
      // would kill healthy long streams at the stale pre-stream deadline.
      lifecycle.release();
      yield* this.#withSessionCacheEstimate(
        qoderBodyToCanonicalEvents(response.body as ReadableStream<Uint8Array>, lifecycle.signal, request.model),
        request,
        qoderSessionId(auth.userId, modelId),
      );
    } catch (err: unknown) {
      const abortError = abortGatewayError(lifecycle, err, context.abort_signal);
      if (abortError) throw abortError;
      throw err;
    } finally {
      lifecycle.release();
    }
  }
}

export function createQoderAdapter(options: QoderAdapterOptions = {}): ProviderAdapter {
  return new QoderAdapter(options);
}

/**
 * Adapter for the China deployment.
 *
 * Same wire, different gateway host and roster — see `qoder-realm.ts`.
 */
export function createQoderCnAdapter(options: QoderAdapterOptions = {}): ProviderAdapter {
  return new QoderAdapter({ ...options, realm: "cn", providerId: "qodercn" });
}
