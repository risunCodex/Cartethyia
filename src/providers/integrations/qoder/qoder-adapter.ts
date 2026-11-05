/**
 * Qoder adapter — transport selection, credential resolution, dispatch.
 *
 * Surface contract (2026-11-05):
 * - `grpc` (default, production): `model.chat.ChatService/ChatCompletionStream`
 *   — the only proven carrier of real 1M-token context (HTTP IDE caps at
 *   ~256 KiB). Serves billed rows; a free-tier row (`lite`) is refused there
 *   (`quota exceeded` 116) and must use legacy COSY.
 * - `cosy` (free/lite + forced legacy): `/algo/.../agent_chat_generation` —
 *   the only surface that accepts free-tier rows. Signing is the COSY Bearer
 *   scheme (AES/RSA + alphabet-scrambled body).
 * - `ide` (`/model/v1/chat/completions`): **probe/testing only — never
 *   production.** It is the only surface that echoes strategy metadata
 *   (`raw_usage` → provider_model/target) and it streams immediately, but its
 *   ~256 KiB body cap cannot carry the 1M window the roster declares. Dispatch
 *   reaches it only when `probe_surface: "ide"` is set (discovery probes) or
 *   the option `surface: "ide"` is forced explicitly for local testing.
 */
import { randomUUID } from "node:crypto";
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
import { qoderMachineHostname, qoderMachineOs } from "../../operations/cli-platform";
import { mapUpstreamHttpError } from "../../../transport/failure-policy";
import { QODER_CN_MODEL_CONFIGS, QODER_INTL_MODEL_CONFIGS, qoderDiscoveredMaxContexts } from "./qoder-catalog";
import { isQoderVirtualModel, qoderDispatchModelId } from "./qoder-virtual";
import { isQoderPat, qoderOAuthAuth, qoderSessionId, resolveQoderAuth } from "./qoder-auth";
import { buildQoderRequest, callQoder } from "./qoder-chat";
import { buildQoderGrpcRequest, qoderGrpcMetadata, qoderGrpcToCanonicalEvents } from "./qoder-grpc";
import { buildQoderIdeRequest, qoderBodyToCanonicalEvents } from "./qoder-ide";
import {
  QODER_CHAT_PATH,
  QODER_PROVIDER_ID,
  qoderIdeChatUrl,
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
   * `grpc` (default) uses the gRPC model-server surface
   * (`model.chat.ChatService/ChatCompletionStream`) — the only proven carrier
   * of real 1M-token context (the HTTP IDE surface caps at ~256 KiB). gRPC
   * serves billed models; a free-tier row (`lite`) is refused there
   * (`quota exceeded` 116) and must use the legacy COSY surface.
   *
   * `cosy` forces only the legacy surface (`/algo/.../agent_chat_generation`)
   * — the free-tier path and the pre-gRPC behavior.
   *
   * `ide` forces the modern `/model/v1` surface — **probe/testing only, never
   * production** (see module doc).
   */
  readonly surface?: "grpc" | "cosy" | "ide";
}

/** Resolves the transport for one dispatch. Exported for tests. */
export function resolveQoderTransport(
  surface: "grpc" | "cosy" | "ide" | undefined,
  modelConfig: QoderModelConfig,
): "grpc" | "cosy" | "ide" {
  const chosen = surface ?? "grpc";
  // `ide` is an explicit testing override — never auto-selected, and it does
  // not apply the free-tier rule (a forced IDE call is a test call).
  if (chosen === "ide") return "ide";
  // Free-tier rows (`lite`) are refused on gRPC with `quota exceeded` (116);
  // they must use the legacy COSY surface.
  if (chosen === "grpc" && modelConfig.is_free === true) return "cosy";
  return chosen;
}

/**
 * The widest selectable context window for one model key (from the live list's
 * `context_config`; falls back to the static roster's stated window).
 */
function qoderMaxContextFor(modelId: string, modelConfig: QoderModelConfig, realm: QoderRealm): number {
  const discovered = qoderDiscoveredMaxContexts(realm).get(modelId);
  if (discovered !== undefined) return discovered;
  return modelConfig.max_input_tokens;
}

class QoderAdapter implements ProviderAdapter {
  readonly provider_id: ProviderId;
  private readonly realm: QoderRealm;
  private readonly surface: "grpc" | "cosy" | "ide";
  private readonly fetchFn: typeof fetch;

  constructor(options: QoderAdapterOptions = {}) {
    this.provider_id = (options.providerId ?? QODER_PROVIDER_ID) as ProviderId;
    this.realm = options.realm ?? "intl";
    this.surface = options.surface ?? "grpc";
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

    // Outbound fetch respects SSRF binding when provided
    const outboundFetch: typeof fetch = (context.outbound_fetch as unknown as typeof fetch) ?? this.fetchFn;

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
      const forceIde = this.surface === "ide" || candidate.probe_surface === "ide";
      const useGrpc = !forceIde && resolveQoderTransport(this.surface, modelConfig) === "grpc";

      if (forceIde) {
        const ideUrl = qoderIdeChatUrl(this.realm);
        const ideBody = buildQoderIdeRequest(modelId, request, modelConfig, auth, this.realm, version);
        // Header fingerprint mirrors the desktop client's IDE surface (`PFn` /
        // `Hc`): X-Request-ID normalized to uppercase, Cosy-Version, real
        // machine OS, and the sanitized hostname on infer SSE requests. The
        // User-Agent is the real IDE client's (`Bun/1.4.4`, live capture) and
        // `X-Session-ID` matches the body's session id (sha256 userId:model).
        const ideHostname = qoderMachineHostname();
        const res = await fetcher(ideUrl, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${auth.securityOauthToken}`,
            "Content-Type": "application/json",
            Accept: "text/event-stream",
            "User-Agent": "Bun/1.4.4",
            "X-Request-ID": randomUUID().toUpperCase(),
            "X-Session-ID": qoderSessionId(auth.userId, modelId),
            "Cosy-Version": version,
            "Cosy-ClientType": "5",
            "Cosy-MachineOS": qoderMachineOs(),
            ...(ideHostname.length > 0 ? { "Cosy-MachineHostname": ideHostname } : {}),
          },
          body: JSON.stringify(ideBody),
        });
        if (!res.ok) throw await mapUpstreamHttpError(res, "qoder");
        if (!res.body) throw new GatewayError("platform_unavailable", 502, "Qoder returned empty body (request {requestId}). The upstream came back empty-handed — retry 🌙", {}, "upstream");
        lifecycle.release();
        yield* qoderBodyToCanonicalEvents(res.body as ReadableStream<Uint8Array>, lifecycle.signal, modelId);
        return;
      }

      if (useGrpc) {
        // The gRPC request mirrors the HTTP surfaces' OpenAI-shaped body, so
        // the shared builder supplies the messages, tool declarations, and
        // tool-choice knobs both surfaces expect. Without the `tools` array
        // the upstream sees no toolset and answers with a DSML text block (or
        // claims no tool exists) instead of a structured `tool_calls`.
        const legacy = buildQoderRequest(modelId, request, modelConfig, auth, this.realm);
        const grpcRequest = buildQoderGrpcRequest(
          modelId,
          request,
          auth.userId,
          qoderMaxContextFor(modelId, modelConfig, this.realm),
          {
            messages: legacy.messages as Array<Record<string, unknown>>,
            tools: legacy.tools as Array<Record<string, unknown>>,
            ...(legacy.parameters === undefined
              ? {}
              : { parameters: legacy.parameters as Record<string, unknown> }),
          },
        );
        const grpcMetadata = qoderGrpcMetadata(auth);
        lifecycle.release();
        yield* qoderGrpcToCanonicalEvents(grpcRequest, grpcMetadata, this.realm, lifecycle.signal);
        return;
      }

      const cosyUrl = candidate.endpoint_path?.startsWith("http")
        ? candidate.endpoint_path
        : `${qoderInferenceCandidates(this.realm, auth.securityOauthToken)[0] ?? ""}${QODER_CHAT_PATH}`;
      const cosyRequest = () =>
        callQoder(cosyUrl, buildQoderRequest(modelId, request, modelConfig, auth, this.realm), modelId, auth, lifecycle.signal, fetcher, version);
      const response = await cosyRequest();
      if (!response.ok) throw await mapUpstreamHttpError(response, "qoder");
      if (!response.body) throw new GatewayError("platform_unavailable", 502, "Qoder returned empty body (request {requestId}). The upstream came back empty-handed — retry 🌙", {}, "upstream");
      // Headers arrived: the pre-stream deadline has served its purpose.
      // From here the gateway stall/first-chunk watchdog (propagated via
      // context.abort_signal) governs the body. Keeping this timer armed
      // would kill healthy long streams at the stale pre-stream deadline.
      lifecycle.release();
      yield* qoderBodyToCanonicalEvents(response.body as ReadableStream<Uint8Array>, lifecycle.signal, request.model);
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
