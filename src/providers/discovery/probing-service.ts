import {
  captureProviderExchange,
  providerRequestMetadataOnly,
  type ProviderExchangeCapture,
} from "../../transport/dispatch/attempt-finalize";
import {
  captureDepthMaxBytes,
  providerCaptureMaxBytes,
} from "../../transport/dispatch/capture-policy";
import { globalOrOwnedBy } from "../../persistence/tenant-scope";
/**
 * Provider probing and model-discovery orchestration.
 *
 * Network probes and `/v1/models` discovery stay separate from the Drizzle
 * catalog repository while sharing the provider catalog contract.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import type { CartethyiaDatabase } from "../../persistence/db-handle";
import { models, providerAccounts, providers } from "../../persistence/schema";
import type { CanonicalEvent, CanonicalRequest, WireFamily } from "../../protocol/canonical-model";
import { WIRE_FAMILIES } from "../../protocol/canonical-model";
import { isRecord } from "../../protocol/codecs";
import type { FetchLike } from "../quota/quota-contracts";
import type { CompatibilityProfile } from "../provider-metadata";
import {
  type ByokConnectionTestRequest,
  type ByokConnectionTestResult,
  type ProbeAllAccountsResult,
  type ProbeAllModelsResult,
  type ProbeModelRequest,
  type ProbeModelResult,
} from "./discovery-types";
import { modelsDevCatalog } from "./models-dev-catalog";
import { fetchOpenAICompatibleModels } from "./openai-model-discovery";
import {
  applyDiscoveredWire,
  resolveDiscoveredWire,
  staticEndpointForWire,
  type DiscoveredModelWire,
} from "./probe-wire";
import {
  buildProbeCanonicalRequest,
  computeProbeVerdict,
  extractSample,
  modelFromEvents,
  GROK_407_PROBE_PROMPT,
  grok407ProbeFailure,
  hasMeaningfulOutput,
  loadProbePreferences,
  PROBE_FAST_SAMPLE_MAX_CHARS,
  recordProbeHealth,
  resolveProbeAdapter,
  resolveProbeTarget,
  selectProbeAccount,
  selectUsableAccount,
  wireContextFrom,
  type ProbeProviderRow,
} from "./probe-phases";
import { createProbeFetch } from "../operations/probe-fetch";
import { authHeaders } from "../adapters/compatible-adapter";
import {
  byokAuthHeaderShape,
  modelDiscoveryBaseUrl,
  modelListUrl,
  resolveByokWireProfile,
  splitEndpointBaseUrl,
} from "../operations/byok-wire-profile";
import { resolveCustomCliHeaders } from "../operations/custom-cli-headers";
import { resolveCredentialForAccount } from "../operations/provider-credential-service";
import { decryptCredentialToString } from "../../security/crypto";
import { GatewayError } from "../../protocol/gateway-error";
import type { TelemetryBatchBuffer } from "../../observability/telemetry-buffer";
import { computeTokensPerSec } from "../../observability/token-speed";
import { TelemetryPayloadCapture } from "../../observability/payload-capture";
import { providerBaseUrl } from "../provider-metadata";
import { isBundledProviderId, parseProviderId, type ProviderDispatchTarget as AdapterDispatchTarget, type ValidatedOutboundFetch } from "../provider-contracts";
import type { ValidatedOutboundHttp2Bidi } from "../provider-contracts";
import type { ModelDefinition } from "../provider-model-definition";
import type { ProviderRegistry } from "../provider-registry";

/** Max models probed concurrently per batch (outside the sequential warm-up). */
const PROBE_CONCURRENCY = 5;
/** Max accounts probed concurrently; batches wait before starting the next ten. */
const PROBE_ACCOUNT_CONCURRENCY = 10;

export interface ProbeOutboundBinding {
  readonly fetch: ValidatedOutboundFetch;
  /**
   * Validated bidirectional HTTP/2 egress for the same pool/tenant. A provider
   * whose only transport is a bidi stream (Cursor's Connect-RPC Run) has no
   * `fetch` path to fall back to, so a probe without this binding reports a
   * healthy account as broken.
   */
  readonly http2Bidi?: ValidatedOutboundHttp2Bidi;
  readonly networkPoolId?: string;
  readonly release?: () => void;
}

export type ProbeOutboundResolver = (
  tenantId: string,
  providerId?: string,
) => Promise<ValidatedOutboundFetch | ProbeOutboundBinding> | ValidatedOutboundFetch | ProbeOutboundBinding;

interface ProviderProbingDeps {
  readonly db: CartethyiaDatabase;
  readonly telemetryBuffer: TelemetryBatchBuffer | undefined;
  readonly defaultEndpoints: Record<WireFamily, string>;
  readonly bundledModelCatalog: ReadonlyMap<string, readonly ModelDefinition[]>;
  readonly outboundFetchFor: ProbeOutboundResolver;
  readonly snapshotInvalidator: { invalidate(): unknown };
  readonly providerRegistry: ProviderRegistry;
}

/**
 * Adapts a validated outbound fetch to the `FetchLike` shape discovery
 * helpers expect. Only the call signature is consumed downstream.
 */
function asFetchLike(fetchFn: ValidatedOutboundFetch): FetchLike {
  const wrapped = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
    fetchFn(input, init);
  return Object.assign(wrapped, { preconnect: () => undefined });
}

function asOutboundBinding(
  resolved: ValidatedOutboundFetch | ProbeOutboundBinding,
): ProbeOutboundBinding {
  return typeof resolved === "function" ? { fetch: resolved } : resolved;
}
export class ProviderProbingService {
  private readonly db: CartethyiaDatabase;
  private readonly telemetryBuffer: TelemetryBatchBuffer | undefined;
  private readonly payloadCapture: TelemetryPayloadCapture;
  private readonly defaultEndpoints: Record<WireFamily, string>;
  private readonly bundledModelCatalog: ReadonlyMap<string, readonly ModelDefinition[]>;
  private readonly outboundFetchFor: ProbeOutboundResolver;
  private readonly snapshotInvalidator: { invalidate(): unknown };
  private readonly providerRegistry: ProviderRegistry;

  constructor(deps: ProviderProbingDeps) {
    this.db = deps.db;
    this.telemetryBuffer = deps.telemetryBuffer;
    this.payloadCapture = new TelemetryPayloadCapture(this.db);
    this.defaultEndpoints = deps.defaultEndpoints;
    this.bundledModelCatalog = deps.bundledModelCatalog;
    this.outboundFetchFor = deps.outboundFetchFor;
    this.snapshotInvalidator = deps.snapshotInvalidator;
    this.providerRegistry = deps.providerRegistry;
  }

  /**
   * The provider row columns that decide wire-family/endpoint resolution.
   * `probeModel` loads this once and reuses it for the contract gate, the
   * custom-adapter fallback, and the wire context.
   */
  private async loadProviderWireRow(providerId: string): Promise<ProbeProviderRow | undefined> {
    const rows = await this.db
      .select({
        baseUrl: providers.baseUrl,
        wireFamilyDefault: providers.wireFamilyDefault,
        compatibilityProfile: providers.compatibilityProfile,
        requiresAccount: providers.requiresAccount,
      })
      .from(providers)
      .where(eq(providers.id, providerId))
      .limit(1);
    return rows[0];
  }

  /**
   * Static endpoint for one provider + wire family, if the bundled catalog
   * ships a static definition for it. Used by manual registration (via the
   * console store) so it resolves the same provider-truth endpoints as probes.
   */
  async resolveStaticEndpoint(
    providerId: string,
    wireFamily: WireFamily,
  ): Promise<string | undefined> {
    return staticEndpointForWire(this.bundledModelCatalog, providerId, wireFamily);
  }

  /** One-shot connectivity test: resolves a usable account + the real per-provider
   * adapter, dispatches a minimal canonical request through the model's own wire
   * family/endpoint (never a hardcoded `/v1/chat/completions`), and records the
   * outcome into `telemetry_events` via the same writer live traffic uses. */
  async probeModel(
    tenantId: string,
    providerId: string,
    request: ProbeModelRequest,
  ): Promise<ProbeModelResult> {
    const startedAt = Date.now();
    // Qoder's legacy COSY surface is the only live chat transport since
    // 2026-11-07 (the gRPC host is NXDOMAIN and the IDE `/model/v1` surface
    // answers 404 on every alive host). Probes for Qoder default to it unless
    // the operator picked a surface explicitly. The IDE surface also echoes
    // provider metadata, but that is worthless when the surface itself is
    // dead — a probe must report what live traffic would do.
    const normalizedRequest: ProbeModelRequest =
      (providerId === "qoder" || providerId === "qodercn") &&
      (request.surface === undefined || request.surface === "default")
        ? { ...request, surface: "cosy" }
        : request;
    const modelId = normalizedRequest.modelId;
    // One provider snapshot per probe: the contract gate, the account gate, the
    // custom-adapter fallback, and the wire context all read this same row, so a
    // concurrent edit cannot make two reads disagree.
    const providerWireRow = await this.loadProviderWireRow(providerId);
    const requiresAccount = providerWireRow?.requiresAccount ?? true;

    const { wireFamily, serviceKind, endpointPath, sourceSurface, capabilityProfile, outputLimit } = await resolveProbeTarget({
      db: this.db,
      bundledModelCatalog: this.bundledModelCatalog,
      defaultEndpoints: this.defaultEndpoints,
      providerId,
      modelId,
      request,
      providerWireRow,
    });

    const account = await selectProbeAccount({
      db: this.db,
      tenantId,
      providerId,
      requestedAccountId: normalizedRequest.accountId,
      requiresAccount,
      allowCoolingAccount:
        providerId === "grok" && normalizedRequest.prompt === GROK_407_PROBE_PROMPT,
    });
    if (!account.ok) {
      return { ok: false, latencyMs: Date.now() - startedAt, error: account.error };
    }
    const accountId = account.accountId;

    const adapter = await resolveProbeAdapter({
      providerRegistry: this.providerRegistry,
      providerId,
      providerWireRow,
    });
    if (!adapter) {
      return {
        ok: false,
        latencyMs: Date.now() - startedAt,
        error: `No adapter registered for provider ${providerId}`,
      };
    }

    const preferences = await loadProbePreferences({
      db: this.db,
      tenantId,
      wireFamily,
      request,
    });
    const { probeReasoning, payloadCapture } = preferences;
    // `detail` is the exact pre-existing behaviour; only `fast` changes any
    // budget. The identity prompt itself is shared by both modes (D42).
    const fast = preferences.mode === "fast";
    const probeTimeoutMs = preferences.timeoutMs ?? 30_000;
    const probeSignal = AbortSignal.timeout(probeTimeoutMs);
    const canonicalRequest = buildProbeCanonicalRequest({
      modelId,
      request: normalizedRequest,
      probeReasoning,
      sourceSurface,
      ...(preferences.maxOutputTokens === undefined
        ? {}
        : { maxOutputTokens: preferences.maxOutputTokens }),
    });
    let capturedRequest = canonicalRequest;
    const parsedProviderId = parseProviderId(providerId);
    const candidate: AdapterDispatchTarget = {
      provider_id: parsedProviderId,
      model_id: modelId,
      wire_family: wireFamily,
      endpoint_path: endpointPath,
      // The route's real profile, not `{}`. A probe runs the production adapter,
      // which gates on capabilities — an empty profile made it reject the probe
      // over capabilities the route actually has (`prompt_caching`, `tools`,
      // `reasoning`), reporting a healthy provider as broken.
      capabilities: capabilityProfile,
      // The model row's own output ceiling, so a probe with a max-output
      // ceiling (OpenCode free) shapes with the model's limit, not a guess.
      ...(outputLimit == null ? {} : { output_limit: outputLimit }),
      // Probe-only transport override, when the operator asked for one. Live
      // dispatch never sets this.
      ...(normalizedRequest.surface === undefined || normalizedRequest.surface === "default"
        ? {}
        : { probe_surface: normalizedRequest.surface }),
    };

    const events: CanonicalEvent[] = [];
    /**
     * Populated when the probe dials. Declared here, not inside the try, so the
     * model the upstream named is still readable after the block unwinds — the
     * result is assembled outside it.
     */
    let probeCapture: ProviderExchangeCapture | undefined;
    let ttfbMs: number | undefined;
    let dispatchError: unknown;
    /** Hits a `websearch` probe returned; surfaced to the console verbatim. */
    let searchResults: ProbeModelResult["searchResults"];
    let networkPoolId: string | undefined;
    try {
      // Public providers (`requires_account: false`) probe credential-free;
      const credential = accountId
        ? await resolveCredentialForAccount(this.db, providerId, accountId)
        : { provider_id: parsedProviderId, credential_kind: "none" as const };
      const outbound = asOutboundBinding(await this.outboundFetchFor(tenantId, providerId));
      networkPoolId = outbound.networkPoolId;
      probeCapture = {
        request: null,
        response: Promise.resolve(null),
      };
      // The same wrapper a real dispatch uses, so the probe reads the model the
      // upstream named from the raw bytes rather than from a synthesized event.
      // Body capture follows the tenant's mode: `metadata` tees the request
      // line and stage presence without slicing bodies (the same
      // `captureBody=false` path a live metadata-mode dispatch uses), `full`
      // tees bodies at the tenant's own depth cap. `none` still wraps — the
      // reported-model read is dispatch metadata, not payload retention, and
      // runs regardless of capture mode.
      const probeFetch = createProbeFetch(
        captureProviderExchange(
          outbound.fetch,
          probeCapture,
          payloadCapture.mode === "full",
          providerCaptureMaxBytes(payloadCapture.depth),
        ),
      );
      try {
        if (serviceKind === "websearch") {
          if (typeof adapter.websearch !== "function") {
            throw new GatewayError(
              "capability_unsupported",
              400,
              `Provider ${providerId} has no web search transport (request {requestId}). Know your tools — this one just isn't in the box 🧰`,
            );
          }
          const searchProbeQuery = normalizedRequest.prompt?.trim() || "Cartethyia gateway probe";
          const response = await adapter.websearch(
            { model: modelId, query: searchProbeQuery, max_results: 3 },
            candidate,
            {
              credential,
              deadline: startedAt + probeTimeoutMs,
              abort_signal: probeSignal,
              outbound_fetch: probeFetch,
            },
          );
          if (ttfbMs === undefined) ttfbMs = Date.now() - startedAt;
          searchResults = response.results.map((hit) => ({
            title: hit.title,
            url: hit.url,
            snippet: hit.snippet,
          }));
          if (!response.results || response.results.length === 0) {
            dispatchError = new GatewayError("platform_unavailable", 502, "web search returned no results (request {requestId}). The upstream came back empty-handed — retry 🌙");
          }
        } else if (serviceKind === "systemone") {
          if (typeof adapter.systemone !== "function") {
            throw new GatewayError(
              "capability_unsupported",
              400,
              `Provider ${providerId} has no System One transport (request {requestId}). Know your tools — this one just isn't in the box 🧰`,
            );
          }
          const response = await adapter.systemone(
            {
              model: modelId,
              state: "Customer: I was charged twice for my order this morning.",
              questions: {
                probe: {
                  type: "noul",
                  instructions: "Is the customer reporting a billing problem?",
                },
              },
            },
            candidate,
            {
              credential,
              deadline: startedAt + probeTimeoutMs,
              abort_signal: probeSignal,
              outbound_fetch: probeFetch,
            },
          );
          if (ttfbMs === undefined) ttfbMs = Date.now() - startedAt;
          const raw = await response.text().catch(() => "");
          if (!response.ok) {
            dispatchError = new GatewayError(
              response.status >= 500 ? "platform_unavailable" : "invalid_request",
              response.status,
              `System One upstream error (request {requestId}): ${raw.slice(0, 240)}`,
            );
          } else {
            let parsed: unknown;
            try {
              parsed = raw ? JSON.parse(raw) : null;
            } catch {
              dispatchError = new GatewayError("platform_unavailable", 502, "System One returned invalid JSON (request {requestId}). The upstream came back empty-handed — retry 🌙");
            }
            if (parsed !== null && parsed !== undefined) {
              const answers =
                typeof parsed === "object" ? (parsed as Record<string, unknown>).answers : undefined;
              const hasAnswers =
                answers !== undefined &&
                answers !== null &&
                typeof answers === "object" &&
                Object.keys(answers as Record<string, unknown>).length > 0;
              if (!hasAnswers) {
                dispatchError = new GatewayError(
                  "platform_unavailable",
                  502,
                  "System One returned no answers (request {requestId}). The upstream came back empty-handed — retry 🌙",
                );
              }
            }
          }
        } else {
        const dispatchProbe = async (request: CanonicalRequest): Promise<void> => {
          capturedRequest = request;
          for await (const event of adapter.dispatch(request, candidate, {
            credential,
            deadline: startedAt + probeTimeoutMs,
            abort_signal: probeSignal,
            outbound_fetch: probeFetch,
            // A bidi-only provider (Cursor's Connect-RPC Run) has no `fetch`
            // transport at all: without the HTTP/2 binding the probe fails with
            // "requires validated HTTP/2 egress" while live dispatch — which
            // always supplies it — succeeds.
            ...(outbound.http2Bidi === undefined ? {} : { outbound_http2: outbound.http2Bidi }),
          })) {
            if (ttfbMs === undefined) ttfbMs = Date.now() - startedAt;
            events.push(event);
          }
        };
        try {
          await dispatchProbe(canonicalRequest);
          if (!hasMeaningfulOutput(events)) throw new Error("probe response content empty");
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          // `fast` is deliberately single-shot: no 1024-token streamed retry.
          if (fast || !/empty\s+(?:response\s+)?content|response\s+content\s+empty/i.test(message)) {
            throw error;
          }
          // Some reasoning models spend the short probe budget before producing
          // visible text. Retry with a larger output allowance, and stream when
          // the first attempt did not — a streamed probe keeps the connection
          // open while the model reasons instead of waiting for a complete body.
          // Generic: no provider/model id special case is needed.
          events.length = 0;
          ttfbMs = undefined;
          await dispatchProbe({
            ...canonicalRequest,
            stream: true,
            generation_controls: {
              ...canonicalRequest.generation_controls,
              max_tokens: 1024,
              max_output_tokens: 1024,
            },
          });
        }
        }
      } finally {
        outbound.release?.();
      }
    } catch (error) {
      dispatchError = error;
    }
    const featureFailure = grok407ProbeFailure({
      providerId,
      prompt: request.prompt,
      events,
      dispatchError,
    });
    if (featureFailure !== undefined) dispatchError = featureFailure;

    const upstreamStatusCode =
      dispatchError instanceof GatewayError
        ? typeof dispatchError.details.upstreamStatus === "number"
          ? dispatchError.details.upstreamStatus
          : typeof dispatchError.details.providerStatus === "number"
            ? dispatchError.details.providerStatus
            : undefined
        : undefined;
    await recordProbeHealth({
      db: this.db,
      invalidator: this.snapshotInvalidator,
      accountId,
      dispatchError,
      // Passed so a refusal delivered as a terminal event — not as a thrown
      // error — still reaches the health machine. Without it, Cursor's
      // `resource_exhausted` left `dispatchError` undefined and the probe
      // recovered an exhausted account.
      ...(events === undefined ? {} : { events }),
      modelId,
      upstreamStatusCode,
    });

    const latencyMs = Date.now() - startedAt;
    // A native-service probe carries no canonical events: its verdict is the
    // decision response itself (no dispatch error + answers present), which the
    // branch above already encoded into `dispatchError`. Web search is a
    // native service too — routing it through the LLM verdict demanded a
    // `terminal` event the search transport never emits, so a search that
    // returned hits was reported as a failure with an empty message.
    const { ok, errorMessage, usage } =
      serviceKind === "systemone" || serviceKind === "websearch"
        ? {
            ok: dispatchError === undefined,
            errorMessage:
              dispatchError === undefined
                ? undefined
                : dispatchError instanceof GatewayError
                  ? `Search provider ${providerId}/${modelId} — ${dispatchError.message} (HTTP ${dispatchError.status})`
                  : dispatchError instanceof Error
                    ? `${providerId}/${modelId} — ${dispatchError.message}`
                    : String(dispatchError),
            usage: undefined,
          }
        : computeProbeVerdict({
            events,
            dispatchError,
            wireFamily,
          });

    const requestId = crypto.randomUUID();

    // Token speed shared with live traffic (`computeTokensPerSec`): probes
    // record TTFT+latency only, so they report end-to-end effective speed.
    const tokensPerSec = computeTokensPerSec({
      outputTokens: usage?.output_tokens,
      latencyMs,
    });

    // Probe telemetry rides the same batch buffer as live traffic. `fast`
    // keeps only the liveness row — no token-speed/usage/TTFB detail — so a
    // "test all models" run stays cheap; `detail` is unchanged.
    if (fast) {
      this.telemetryBuffer?.enqueue({
        tenantId,
        requestId,
        sourceSurface,
        requestedModel: modelId,
        endpoint: endpointPath,
        providerId,
        latencyMs,
        stream: false,
        status: ok ? "completed" : "failed",
      });
    } else {
      this.telemetryBuffer?.enqueue({
        tenantId,
        requestId,
        sourceSurface,
        requestedModel: modelId,
        endpoint: endpointPath,
        providerId,
        ...(accountId ? { accountId } : {}),
        ...(networkPoolId ? { networkPoolId } : {}),
        latencyMs,
        ...(ttfbMs !== undefined ? { ttfbMs } : {}),
        stream: capturedRequest.stream,
        status: ok ? "completed" : "failed",
        ...(ok ? {} : { errorCategory: errorMessage ?? "probe_failed" }),
        ...(usage ? { usage } : {}),
        ...(tokensPerSec !== undefined ? { tokensPerSec } : {}),
      });
    }
    if (this.telemetryBuffer && payloadCapture.enabled) {
      if (payloadCapture.mode === "metadata") {
        // Stage presence only: the provider request line (method, URL,
        // headers, body_present/body_bytes) is exactly what `metadata` mode
        // keeps for a live request. No bodies anywhere.
        const providerRequest = providerRequestMetadataOnly(probeCapture?.request ?? null);
        if (providerRequest !== null) {
          await this.payloadCapture
            .capture({
              tenantId,
              requestId,
              requestBody: null,
              responseBody: null,
              providerRequestBody: providerRequest,
              retentionMs: payloadCapture.retentionMs,
              scope: "tenant",
              tenantOptIn: true,
            })
            .catch(() => undefined);
        }
      } else {
        // All four surfaces, so the row's stage markers mean the same thing
        // here as they do on a live request: which hop actually produced bytes.
        // Depth and retention are the tenant's own, resolved through the same
        // preference path a dispatched request uses.
        const providerRequest = probeCapture?.request ?? null;
        const providerResponse = await probeCapture?.response.catch(() => null) ?? null;
        await this.payloadCapture
          .capture({
            tenantId,
            requestId,
            requestBody: capturedRequest,
            // `events` is what the *client* receives, so it belongs in the
            // client surface. Passing it as `responseBody` lit the client bit
            // on probes whose event list was empty, over a body that was never
            // captured. The legacy alias is explicitly absent here; `null`
            // leaves bit 8 to be decided by the real client body alone.
            responseBody: null,
            ...(events === undefined ? {} : { clientResponseBody: events }),
            ...(providerRequest === null ? {} : { providerRequestBody: providerRequest }),
            ...(providerResponse === null ? {} : { providerResponseBody: providerResponse }),
            maxBytes: captureDepthMaxBytes(payloadCapture.depth),
            retentionMs: payloadCapture.retentionMs,
            scope: "tenant",
            tenantOptIn: true,
          })
          .catch(() => undefined);
      }
    }

    const rawSample = extractSample(events);
    // `fast` answers one question — did the model talk back? — so an 80-char
    // excerpt is enough; `detail` keeps the full sample verbatim (D40).
    const sample =
      rawSample === undefined || !fast
        ? rawSample
        : rawSample.slice(0, PROBE_FAST_SAMPLE_MAX_CHARS);
    // The HTTP-only `readReportedModel` covers response-body transports; a
    // non-HTTP transport (Qoder gRPC) reports the upstream echo as a
    // `response_start` event instead — fall back to that when the body read
    // came up empty.
    const reportedModel =
      (await probeCapture?.reportedModel?.catch(() => undefined)) ?? modelFromEvents(events);
    // Provider-specific upstream model metadata (Qoder IDE surface raw_usage):
    // carried on the terminal event by the adapter, surfaced verbatim.
    const terminal = events.find((event) => event.type === "terminal");
    const providerMetadata = terminal?.type === "terminal" ? terminal.provider_metadata : undefined;
    return {
      ...(accountId ? { accountId } : {}),
      ok,
      latencyMs,
      ...(fast || ttfbMs === undefined ? {} : { ttfbMs }),
      ...(upstreamStatusCode === undefined ? {} : { statusCode: upstreamStatusCode }),
      ...(sample ? { sample } : {}),
      ...(fast || reportedModel === undefined ? {} : { reportedModel }),
      ...(fast || providerMetadata === undefined || Object.keys(providerMetadata).length === 0
        ? {}
        : { providerMetadata }),
      ...(searchResults !== undefined && searchResults.length > 0 ? { searchResults } : {}),
      ...(errorMessage ? { error: errorMessage } : {}),
    };
  }

  /**
   * Ad-hoc connectivity test for a not-yet-persisted BYOK provider.
   *
   * Dispatches a real `GET <base>/models` through the same SSRF-validated
   * outbound fetch live traffic uses, stamping the credential with the auth
   * header the chosen wire family actually reads (`x-api-key` for Messages,
   * `Authorization: Bearer` otherwise) plus that wire's CLI identity headers.
   * Reachability is the contract: any HTTP response proves the operator's base
   * URL, credential, and egress path work — a 4xx is reported with its status
   * rather than disguised as a transport failure.
   */
  async testByokConnection(
    tenantId: string,
    request: ByokConnectionTestRequest,
  ): Promise<ByokConnectionTestResult> {
    const startedAt = Date.now();
    const requestedWire = request.wireFamily;
    const wireFamily: WireFamily = (WIRE_FAMILIES as readonly string[]).includes(requestedWire)
      ? (requestedWire as WireFamily)
      : "chat";
    // An operator who pasted a full endpoint (`…/anthropic/v1/messages`) gets it
    // stripped before the model list is derived, and told so. Probing the
    // corrected root is what makes the result actionable: the alternative is a
    // bare 404 against a path the gateway built from their own typo.
    const submitted = splitEndpointBaseUrl(request.baseUrl);
    const warning =
      submitted.stripped === ""
        ? undefined
        : `Base URL pointed at the endpoint "${submitted.stripped}". Cartethyia derives the model list from the root, so it tested "${submitted.baseUrl}" instead. Save that root as the Base URL.`;
    const url = modelListUrl(request.baseUrl);
    const outbound = asOutboundBinding(await this.outboundFetchFor(tenantId));
    const probeFetch = createProbeFetch(outbound.fetch);
    try {
      const headers: Record<string, string> = {
        accept: "application/json",
        ...authHeaders(
          byokAuthHeaderShape([wireFamily]),
          new TextEncoder().encode(request.apiKey),
          request.apiKey.trim().length > 0 ? "api_key" : "none",
        ),
        ...(request.cliIdentity === false ? {} : resolveCustomCliHeaders(wireFamily)),
        ...(request.extraHeaders ?? {}),
      };
      const response = await probeFetch(url, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(15_000),
      });
      const latencyMs = Date.now() - startedAt;
      if (!response.ok) {
        return {
          ok: false,
          latencyMs,
          statusCode: response.status,
          error: `Upstream rejected the connection test with HTTP ${response.status}`,
          ...(warning === undefined ? {} : { warning }),
        };
      }
      // A body is nice to have but not required: some gateways answer `/models`
      // with an empty envelope. Read it defensively so a non-JSON body cannot
      // turn a successful reachability check into a failure.
      let modelCount: number | undefined;
      try {
        const payload = (await response.json()) as unknown;
        const entries = Array.isArray(payload)
          ? payload
          : isRecord(payload) && Array.isArray(payload["data"])
            ? payload["data"]
            : isRecord(payload) && Array.isArray(payload["models"])
              ? payload["models"]
              : undefined;
        if (entries) modelCount = entries.length;
      } catch {
        // Non-JSON success body: reachability already proven by the 2xx.
      }
      return {
        ok: true,
        latencyMs,
        statusCode: response.status,
        ...(modelCount === undefined ? {} : { modelCount }),
        ...(warning === undefined ? {} : { warning }),
      };
    } catch (error) {
      return {
        ok: false,
        latencyMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : "Connection test failed",
        ...(warning === undefined ? {} : { warning }),
      };
    } finally {
      outbound.release?.();
    }
  }

  /**
   * Fetches one provider's model listing through the exact same two branches
   * `syncModels` uses — a registry resolver, or the generic OpenAI-compatible
   * `/models` fetch for BYOK — without writing anything. `supported:false`
   * names a provider with no listing path so the Add-Model UI can offer its
   * manual fallback instead of reporting a transport failure.
   *
   * The account is the first usable one (`selectUsableAccount`), the same
   * selection sync uses (D27); its label is returned when available so the
   * surface can say whose roster it is showing.
   */
  async discoverModels(
    tenantId: string,
    providerId: string,
  ): Promise<{
    readonly supported: boolean;
    readonly models: readonly ModelDefinition[];
    readonly accountLabel?: string;
    /** Wire resolution context + BYOK family constraints for a later commit. */
    readonly wire: {
      readonly providerRow: ProbeProviderRow | undefined;
      readonly supportedWireFamilies: readonly WireFamily[] | undefined;
      readonly baseUrl: string | undefined;
    };
  }> {
    const outbound = asOutboundBinding(await this.outboundFetchFor(tenantId, providerId));
    try {
      const discoveryFetch = asFetchLike(outbound.fetch);
      const resolver = await this.providerRegistry.resolveModelDiscovery(providerId);
      const account = await this.usableAccount(tenantId, providerId);
      const providerRow = await this.loadProviderWireRow(providerId);
      if (resolver) {
        // `providerBaseUrl` throws for a non-bundled id; a custom provider can
        // still register a discovery resolver, and its own row's base URL is
        // the authority. Only a bundled provider falls back to metadata.
        const effectiveBaseUrl =
          providerRow?.baseUrl ??
          (isBundledProviderId(providerId) ? providerBaseUrl(providerId) : "");
        let discovered: readonly ModelDefinition[] | null;
        try {
          discovered = await resolver({
            baseUrl: effectiveBaseUrl,
            credential: account?.secret ?? "",
            ...(discoveryFetch ? { fetcher: discoveryFetch } : {}),
            ...(account?.authState === undefined ? {} : { authState: account.authState }),
          });
        } catch (error) {
          throw this.discoveryFailure(providerId, error);
        }
        if (!discovered) {
          throw new GatewayError(
            "transport_unavailable",
            502,
            `Model discovery failed for ${providerId}: endpoint returned no usable models (request {requestId}). The upstream came back empty-handed — retry 🌙`,
            {},
            "upstream",
          );
        }
        return {
          supported: true,
          models: discovered,
          ...(account?.label === undefined ? {} : { accountLabel: account.label }),
          wire: { providerRow, supportedWireFamilies: undefined, baseUrl: effectiveBaseUrl },
        };
      }
      if (providerRow?.baseUrl) {
        const wireProfile = resolveByokWireProfile(
          providerRow.wireFamilyDefault,
          providerRow.compatibilityProfile as CompatibilityProfile | null,
        );
        const modelsBaseUrl = modelDiscoveryBaseUrl(providerRow.baseUrl);
        let discovered: readonly ModelDefinition[] | null;
        try {
          discovered = await fetchOpenAICompatibleModels({
            baseUrl: modelsBaseUrl,
            providerId,
            headers: {
              ...authHeaders(
                wireProfile.authHeaderShape,
                new TextEncoder().encode(account?.secret ?? ""),
                "api_key",
              ),
            },
            ...(discoveryFetch ? { fetcher: discoveryFetch as typeof fetch } : {}),
          });
        } catch (error) {
          throw this.discoveryFailure(providerId, error);
        }
        if (discovered && discovered.length > 0) {
          return {
            supported: true,
            models: discovered,
            ...(account?.label === undefined ? {} : { accountLabel: account.label }),
            wire: {
              providerRow,
              supportedWireFamilies: wireProfile.supportedWireFamilies,
              baseUrl: providerRow.baseUrl ?? undefined,
            },
          };
        }
      }
      return {
        supported: false,
        models: [],
        ...(account?.label === undefined ? {} : { accountLabel: account.label }),
        wire: { providerRow, supportedWireFamilies: undefined, baseUrl: undefined },
      };
    } finally {
      outbound.release?.();
    }
  }

  /** One upstream-shaped error for both discovery branches. */
  private discoveryFailure(providerId: string, error: unknown): GatewayError {
    return new GatewayError(
      "transport_unavailable",
      502,
      `Model discovery failed for ${providerId}: ${error instanceof Error ? error.message : "unknown error"} (request {requestId}). The connection ghosted us — come back in a moment 👻`,
      {},
      "upstream",
    );
  }

  /**
   * The single write path for every discovery result: one fresh fetch, one
   * subset, one source. Sync passes the whole roster as `discovered`; the
   * Add-Model commit passes the operator's selected definitions as `manual`.
   * `definitionsFrom` is applied to the fresh fetch so a stale client-side
   * `ModelDefinition` can never decide what gets stored.
   */
  private async persistRoster(
    tenantId: string,
    providerId: string,
    definitionsFrom: (
      fresh: readonly ModelDefinition[],
    ) => readonly ModelDefinition[],
    source?: "manual",
    unsupportedError?: (accountExists: boolean) => GatewayError,
  ): Promise<{ synced: number }> {
    const fresh = await this.discoverModels(tenantId, providerId);
    if (!fresh.supported) {
      if (unsupportedError) {
        throw unsupportedError((await this.usableAccount(tenantId, providerId)) !== undefined);
      }
      throw new GatewayError(
        "capability_unsupported",
        400,
        `${providerId} publishes no model-listing endpoint (request {requestId}). Its catalog ships with Cartethyia; new models appear with an update. Know your tools — this one just isn't in the box 🧰`,
        {},
        "cartethyia",
      );
    }
    const ctx = wireContextFrom(fresh.wire.providerRow);
    return this.persistDiscoveredModels(
      providerId,
      definitionsFrom(fresh.models),
      (modelId) => resolveDiscoveredWire(modelId, ctx, undefined, this.defaultEndpoints),
      ctx.endpointPathsByWireFamily,
      fresh.wire.baseUrl,
      fresh.wire.supportedWireFamilies,
      source,
    );
  }

  /**
   * Full sync: one fetch, upsert every id as `discovered` (or `auto_free`).
   * Its original prerequisite diagnostics are preserved: a custom provider
   * with no account is told to add one, a bundled provider with no listing
   * endpoint is told its catalog ships with the release.
   */
  async syncModels(tenantId: string, providerId: string): Promise<{ synced: number }> {
    return this.persistRoster(
      tenantId,
      providerId,
      (fresh) => fresh,
      undefined,
      (accountExists) => {
        if (!isBundledProviderId(providerId) || !accountExists) {
          const prefix = isBundledProviderId(providerId)
            ? `Add an account for ${providerId} before fetching its models`
            : `Add an account for ${providerId} first — model listing needs a credential`;
          return new GatewayError(
            "invalid_request",
            400,
            `${prefix} (request {requestId}). Wrong key, right door — check the credential 🔑`,
            {},
            "cartethyia",
          );
        }
        return new GatewayError(
          "capability_unsupported",
          400,
          `${providerId} publishes no model-listing endpoint (request {requestId}). Its catalog ships with Cartethyia; new models appear with an update. Know your tools — this one just isn't in the box 🧰`,
          {},
          "cartethyia",
        );
      },
    );
  }

  /**
   * Persists an operator-selected subset of a freshly fetched roster as
   * `source="manual"` (D28). The store has already intersected the requested
   * ids against its own fetch; this second fetch is the anti-forgery boundary
   * and the source of every stored `ModelDefinition`.
   */
  async commitDiscoveredModels(
    tenantId: string,
    providerId: string,
    selectedIds: readonly string[],
  ): Promise<{ synced: number }> {
    return this.persistRoster(
      tenantId,
      providerId,
      (fresh) => {
        const wanted = new Set(selectedIds);
        return fresh.filter((definition) => wanted.has(definition.modelId));
      },
      "manual",
    );
  }

  private async persistDiscoveredModels(
    providerId: string,
    discoveredModels: readonly (string | ModelDefinition)[],
    resolve: (modelId: string) => DiscoveredModelWire,
    endpointOverrides?: Partial<Record<WireFamily, string>>,
    baseUrl?: string,
    supportedWireFamilies?: readonly WireFamily[],
    source?: "manual",
  ): Promise<{ synced: number }> {
    // Static definitions are the injected bundled catalog; the probing service
    // and the console store are both handed the same startup-built map.
    const staticDefinitions: readonly ModelDefinition[] =
      this.bundledModelCatalog.get(providerId) ?? [];
    const staticEndpoints: Partial<Record<WireFamily, string>> = {};
    for (const definition of staticDefinitions) {
      staticEndpoints[definition.wireFamily] ??= definition.endpointPath;
    }
    // Fetch only adds genuinely new models: an id the builtin catalog
    // already owns stays exactly one (builtin) row instead of gaining a
    // discovered shadow that confuses pickers and deletes.
    const builtinIds = new Set(staticDefinitions.map((definition) => definition.modelId));
    // `(modelId, endpointPath)` is the row identity, so a corrected wire family
    // lands on a *new* row and would leave the old one behind as a dead route.
    // Collect this run's pairs and drop the provider's superseded discovered
    // rows for the same ids afterwards.
    const resolvedPairs: Array<{ modelId: string; endpointPath: string }> = [];
    const rows: Array<typeof models.$inferInsert> = [];
    // A `manual` commit is an operator's subset, not a full roster. The
    // builtin-id skip that protects sync from creating shadow rows would hide
    // a legitimately selected operator row, so only sync applies it.
    const skipBuiltinIds = source === undefined;
    // `(modelId, endpointPath)` is the row identity and the upsert's conflict
    // target, so a listing that repeats a pair (the bespoke discoveries return
    // raw upstream ids) would make a multi-row `ON CONFLICT DO UPDATE` fail with
    // "cannot affect row a second time". Keep the first row per pair, as the
    // builtin seeder does, so one statement can carry a whole chunk.
    const seenPairs = new Set<string>();
    for (const item of discoveredModels) {
      const modelId = typeof item === "string" ? item : item.modelId;
      if (skipBuiltinIds && builtinIds.has(modelId)) continue;
      const resolved = resolve(modelId);
      const discDef = typeof item === "string" ? undefined : item;
      const { wireFamily, endpointPath } = applyDiscoveredWire({
        resolvedWireFamily: resolved.wireFamily,
        resolvedEndpointPath: resolved.endpointPath,
        ...(discDef !== undefined
          ? { discoveredWireFamily: discDef.wireFamily, discoveredEndpointPath: discDef.endpointPath }
          : {}),
        staticEndpoints,
        ...(endpointOverrides !== undefined ? { endpointOverrides } : {}),
        ...(supportedWireFamilies !== undefined ? { supportedWireFamilies } : {}),
        ...(baseUrl !== undefined ? { baseUrl } : {}),
      });
      resolvedPairs.push({ modelId, endpointPath });
      const pairKey = `${modelId}\u0000${endpointPath}`;
      if (seenPairs.has(pairKey)) continue;
      seenPairs.add(pairKey);
      const knownDefinition = staticDefinitions.find((definition) => definition.modelId === modelId);
      const sourceUpdatedAt = new Date();
      const metadata = {
        contextLimit: knownDefinition?.contextLimit ?? discDef?.contextLimit ?? null,
        outputLimit: knownDefinition?.outputLimit ?? discDef?.outputLimit ?? null,
        modalities: knownDefinition?.modalities ?? discDef?.modalities ?? null,
        reasoning: knownDefinition?.reasoning ?? discDef?.reasoning ?? false,
        toolCall: knownDefinition?.toolCall ?? discDef?.toolCall ?? false,
        cost: modelsDevCatalog.costFor(providerId, modelId),
        // R-E: fetched warnings win, a matching static definition is the
        // fallback, and an unknown id stores `NULL` (operator-editable).
        warningMetadata:
          discDef?.warnings ?? knownDefinition?.warnings ?? null,
        // Discovery builds its rows from the same static catalog, so a fetched
        // row carries the same answer a seeded one does. Null when neither
        // source marked it, which reads as "unknown" rather than "free".
        proOnly: (discDef?.proOnly ?? knownDefinition?.proOnly ?? null),
        // Same shape for the tier the provider states itself (Qoder `is_free`).
        freeTier: (discDef?.freeTier ?? knownDefinition?.freeTier ?? null),
      };
      rows.push({
        providerId,
        modelId,
        wireFamily,
        // A discovery module that classifies an id as a non-chat service (the
        // System One decision API) states it on its own definition; otherwise the
        // static catalog's classification wins, and an unclassified id is `llm`.
        serviceKind: discDef?.serviceKind ?? knownDefinition?.serviceKind ?? "llm",
        endpointPath,
        ...metadata,
        // A discovery module that marks its rows as a free tier gets its own
        // source, because the model list groups on it: a free-tier row is not
        // an ordinary fetched one, and collapsing both into `discovered` lost
        // that distinction at the only point where it is still known.
        source:
          source ?? (discDef?.freeTier === true ? "auto_free" : "discovered"),
        sourceUpdatedAt,
        enabled: true,
        ...(discDef?.dialect === undefined && knownDefinition?.dialect === undefined
          ? {}
          : { dialect: discDef?.dialect ?? knownDefinition?.dialect }),
      });
    }
    // One statement per chunk (500, the account-health batch step) instead of
    // one round-trip per row. `excluded.*` reads the proposed row, so the update
    // set is the same columns the per-row upsert wrote.
    for (let offset = 0; offset < rows.length; offset += 500) {
      await this.db
        .insert(models)
        .values(rows.slice(offset, offset + 500))
        .onConflictDoUpdate({
          target: [models.providerId, models.modelId, models.endpointPath],
          set: {
            serviceKind: sql`excluded.service_kind`,
            contextLimit: sql`excluded.context_limit`,
            outputLimit: sql`excluded.output_limit`,
            modalities: sql`excluded.modalities`,
            reasoning: sql`excluded.reasoning`,
            toolCall: sql`excluded.tool_call`,
            cost: sql`excluded.cost`,
            proOnly: sql`excluded.pro_only`,
            freeTier: sql`excluded.free_tier`,
            warningMetadata: sql`excluded.warning_metadata`,
            dialect: sql`excluded.dialect`,
            // The proposed row's own source, not a constant: a free-tier
            // discovery and an ordinary one write the same upsert, and pinning
            // this to `discovered` would relabel every free-tier row on the
            // next sync.
            source: sql`excluded.source`,
            sourceUpdatedAt: sql`excluded.source_updated_at`,
          },
        });
    }
    const synced = rows.length;
    // A manual commit is an operator's selection, not a roster replacement:
    // pruning would delete unrelated discovered rows with the same ids.
    if (source === "manual") return { synced };
    // Drop this provider's discovered rows for the synced ids that are no
    // longer part of the resolved set — the stale `(model, endpoint)` pair left
    // behind when a corrected wire family moved a model to a new path. Rows the
    // operator added by hand (`manual`) and ids outside this run are untouched.
    // `auto_free` is included: it is written by this same sync, so leaving it
    // out would make a free-tier row the one kind of synced row that never gets
    // pruned when its id moves.
    if (resolvedPairs.length > 0) {
      const pairs = resolvedPairs.map(
        (pair) => sql`(${pair.modelId}, ${pair.endpointPath})`,
      );
      const ids = resolvedPairs.map((pair) => pair.modelId);
      await this.db
        .delete(models)
        .where(
          and(
            eq(models.providerId, providerId),
            inArray(models.source, ["discovered", "auto_free"]),
            sql`${models.modelId} IN (${sql.join(
              ids.map((id) => sql`${id}`),
              sql`, `,
            )})`,
            sql`(${models.modelId}, ${models.endpointPath}) NOT IN (${sql.join(pairs, sql`, `)})`,
          ),
        );
    }
    return { synced };
  }

  /**
   * The account a credential-scoped discovery will use, with its non-secret
   * auth configuration. Selection is unchanged — first usable row, preferring a
   * tenant-owned one — so discovery and dispatch agree on which account answered.
   */
  private async usableAccount(
    tenantId: string,
    providerId: string,
  ): Promise<{
    readonly secret: string;
    readonly label?: string;
    readonly authState?: Readonly<Record<string, unknown>>;
  } | undefined> {
    const rows = await this.db
      .select()
      .from(providerAccounts)
      .where(
        and(
          eq(providerAccounts.providerId, providerId),
          globalOrOwnedBy(providerAccounts.tenantId, tenantId),
        ),
      );
    const usable = selectUsableAccount(rows);
    if (!usable?.credentialCiphertext) return undefined;
    const authState = isRecord(usable.authState) ? usable.authState as Readonly<Record<string, unknown>> : undefined;
    return {
      secret: decryptCredentialToString(usable.credentialCiphertext),
      ...(typeof usable.label === "string" ? { label: usable.label } : {}),
      ...(authState === undefined ? {} : { authState }),
    };
  }

  /**
   * Batched provider-wide probe: the first request runs sequentially (it warms
   * OAuth token caches and connection pools for the provider), the rest run
   * through a sliding worker pool bounded to `PROBE_CONCURRENCY`. Each request
   * carries its model route and service kind so native services never fall
   * through to an LLM probe.
   *
   * `mode` flows through every request, so "Test all models" (D43) can use
   * the cheap `fast` path end to end.
   *
   * Sliding window beats barrel-batching here: the historical pattern waited
   * for the slowest probe in each group of `N` before starting the next group,
   * so one slow route stalled nine others. With the worker loop, a worker
   * picks up the next request as soon as its current one settles, which keeps
   * the full window of `PROBE_CONCURRENCY` in flight across the whole batch.
   */
  async probeAllModels(
    tenantId: string,
    providerId: string,
    requests: readonly ProbeModelRequest[],
  ): Promise<ProbeAllModelsResult> {
    const [firstRequest, ...restRequests] = requests;
    if (firstRequest === undefined) return { providerId, results: [] };

    // Position the warm-up at index 0 and the rest at their original indices
    // so a caller inspecting `results` sees them in the same order they were
    // requested. Pre-sized `Array` means workers assign by index rather than
    // racing to `push`.
    const results: ProbeAllModelsResult["results"][number][] = new Array(requests.length);

    const runOne = async (probeRequest: ProbeModelRequest, slot: number): Promise<void> => {
      const outcome = await this.probeModel(tenantId, providerId, probeRequest);
      results[slot] = {
        modelId: probeRequest.modelId,
        ok: outcome.ok,
        latencyMs: outcome.latencyMs,
        ...(outcome.error ? { error: outcome.error } : {}),
      };
    };

    // Warm-up stays sequential: it primes OAuth token caches and connection
    // pools so the parallel workers do not each pay the first-call tax.
    await runOne(firstRequest, 0);

    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (true) {
        const index = cursor++;
        if (index >= restRequests.length) return;
        const request = restRequests[index]!;
        // Swallow per-probe errors to the array shape: `probeModel` is
        // supposed to return an `outcome` object even on failure, but a
        // throw here (unexpected shape, aborted socket) must not fail the
        // whole batch — the operator still needs to see which models passed.
        try {
          await runOne(request, index + 1);
        } catch (error) {
          results[index + 1] = {
            modelId: request.modelId,
            ok: false,
            latencyMs: 0,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }
    };

    const workerCount = Math.min(PROBE_CONCURRENCY, restRequests.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    // Drop any gaps left by a `requests.length` of 1 (no rest) or an array
    // that was somehow sparser than planned — defensive, not expected.
    return { providerId, results: results.filter((entry) => entry !== undefined) };
  }
  async probeAllAccounts(
    tenantId: string,
    providerId: string,
    request: ProbeModelRequest,
  ): Promise<ProbeAllAccountsResult> {
    const accounts = await this.db
      .select({ id: providerAccounts.id })
      .from(providerAccounts)
      .where(
        and(
          eq(providerAccounts.providerId, providerId),
          globalOrOwnedBy(providerAccounts.tenantId, tenantId),
        ),
      );
    // Sliding worker pool: workers claim the next account as soon as their
    // current probe settles, so one slow account cannot stall the rest of the
    // window the way `Promise.all` on fixed-size batches did. Order of
    // completion is irrelevant to the caller (each result carries its own
    // `accountId`), but we still assign by slot to keep the output stable
    // for golden-file tests and operator audit replay.
    //
    // Fault tolerance: the old `Promise.all` meant a single thrown probe
    // aborted the entire batch and the operator lost the status of every
    // other account they clicked "test all" on. Catching per-account turns a
    // thrown probe into a failed result for that account only — matching the
    // dashboard's existing per-account expectation.
    const results: ProbeAllAccountsResult["results"][number][] = new Array(accounts.length);
    if (accounts.length === 0) return { providerId, modelId: request.modelId, results: [] };

    const runOne = async (account: { id: string }, slot: number): Promise<void> => {
      try {
        const result = await this.probeModel(tenantId, providerId, {
          ...request,
          accountId: account.id,
        });
        // No health write here: a probe that genuinely fails already reports
        // through `recordAccountFailure`, which classifies the real status;
        // matching answer text is not a health signal.
        results[slot] = { ...result, accountId: account.id };
      } catch (error) {
        results[slot] = {
          ok: false,
          latencyMs: 0,
          accountId: account.id,
          error: error instanceof Error ? error.message : String(error),
        } as ProbeAllAccountsResult["results"][number];
      }
    };

    // As in probeAllModels, the first probe primes OAuth token caches and
    // connection pools before concurrent workers start. Ten simultaneous cold
    // refreshes could otherwise trip provider rate limits and mark healthy
    // accounts as broken during a "test all" run.
    await runOne(accounts[0]!, 0);
    const restAccounts = accounts.slice(1);
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (true) {
        const index = cursor++;
        if (index >= restAccounts.length) return;
        await runOne(restAccounts[index]!, index + 1);
      }
    };
    const workerCount = Math.min(PROBE_ACCOUNT_CONCURRENCY, restAccounts.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    return { providerId, modelId: request.modelId, results };
  }
}
