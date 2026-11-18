/**
 * Probe execution engine for `ProviderProbingService`.
 *
 * Owns the single-probe pipeline (`probeModel`). The batched provider/account
 * sweeps live in `probe-sweeps.ts`, the BYOK connection test in
 * `probe-byok-test.ts`, and the outbound binding adapters in
 * `probe-outbound.ts`; this module re-exports their public surface and the
 * class delegates to them with the same signatures, so the facade's behavior
 * and exports are unchanged.
 */
import {
  captureProviderExchange,
  providerRequestMetadataOnly,
  type ProviderExchangeCapture,
} from "../../transport/dispatch/attempt-finalize";
import {
  captureDepthMaxBytes,
  providerCaptureMaxBytes,
} from "../../transport/dispatch/capture-policy";
import type { CartethyiaDatabase } from "../../persistence/db-handle";
import type {
  CanonicalEvent,
  CanonicalRequest,
  WireFamily,
} from "../../protocol/canonical-model";
import type {
  ByokConnectionTestRequest,
  ByokConnectionTestResult,
  ProbeAllAccountsResult,
  ProbeAllModelsResult,
  ProbeModelRequest,
  ProbeModelResult,
} from "./discovery-types";
import {
  buildProbeCanonicalRequest,
  computeProbeVerdict,
  extractSample,
  modelFromEvents,
  GROK_407_PROBE_PROMPT,
  grok407ProbeFailure,
  hasMeaningfulOutput,
  loadProbePreferences,
  loadProviderWireRow,
  PROBE_FAST_SAMPLE_MAX_CHARS,
  recordProbeHealth,
  resolveProbeAdapter,
  resolveProbeTarget,
  selectProbeAccount,
} from "./probe-phases";
import { createProbeFetch } from "../provider-probe";
import { resolveCredentialForAccount } from "../operations/provider-credential-service";
import { GatewayError } from "../../protocol/gateway-error";
import type { TelemetryBatchBuffer } from "../../observability/telemetry-buffer";
import { computeTokensPerSec } from "../../observability/token-speed";
import type { TelemetryPayloadCapture } from "../../observability/payload-capture";
import {
  parseProviderId,
  type ProviderDispatchTarget as AdapterDispatchTarget,
} from "../provider-contracts";
import type { ModelDefinition } from "../provider-model-definition";
import type { ProviderRegistry } from "../provider-registry";
import type { ProbeEngineDeps } from "./probe-deps";
import {
  asOutboundBinding,
  type ProbeOutboundResolver,
} from "./probe-outbound";
import { probeAllModels, probeAllAccounts } from "./probe-sweeps";
import { testByokConnection } from "./probe-byok-test";

export {
  asFetchLike,
  asOutboundBinding,
  type ProbeOutboundBinding,
  type ProbeOutboundResolver,
} from "./probe-outbound";

/**
 * The execution half of `ProviderProbingService`. Stateless by construction:
 * all state comes from the injected deps, so the facade can hold one instance
 * for its whole lifetime and still be subclassed.
 */
export class ProbeRunner {
  private readonly db: CartethyiaDatabase;
  private readonly telemetryBuffer: TelemetryBatchBuffer | undefined;
  private readonly payloadCapture: TelemetryPayloadCapture;
  private readonly defaultEndpoints: Record<WireFamily, string>;
  private readonly bundledModelCatalog: ReadonlyMap<string, readonly ModelDefinition[]>;
  private readonly outboundFetchFor: ProbeOutboundResolver;
  private readonly snapshotInvalidator: { invalidate(): unknown };
  private readonly providerRegistry: ProviderRegistry;

  constructor(deps: ProbeEngineDeps, payloadCapture: TelemetryPayloadCapture) {
    this.db = deps.db;
    this.telemetryBuffer = deps.telemetryBuffer;
    this.payloadCapture = payloadCapture;
    this.defaultEndpoints = deps.defaultEndpoints;
    this.bundledModelCatalog = deps.bundledModelCatalog;
    this.outboundFetchFor = deps.outboundFetchFor;
    this.snapshotInvalidator = deps.snapshotInvalidator;
    this.providerRegistry = deps.providerRegistry;
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
    const normalizedRequest: ProbeModelRequest = request;
    const modelId = normalizedRequest.modelId;
    // One provider snapshot per probe: the contract gate, the account gate, the
    // custom-adapter fallback, and the wire context all read this same row, so a
    // concurrent edit cannot make two reads disagree.
    const providerWireRow = await loadProviderWireRow(this.db, providerId);
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
      ...(typeof adapter?.systemPrompt === "function"
        ? { providerSystemPrompt: adapter.systemPrompt() }
        : {}),
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
            // A bidi-only provider (a Connect-RPC run) has no `fetch`
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
      // error — still reaches the health machine. Without it, a terminal
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

  /** Ad-hoc connectivity test for a not-yet-persisted BYOK provider. */
  async testByokConnection(
    tenantId: string,
    request: ByokConnectionTestRequest,
  ): Promise<ByokConnectionTestResult> {
    return testByokConnection(this.outboundFetchFor, tenantId, request);
  }

  /**
   * Batched provider-wide probe. `probeModel` is passed through so a subclass
   * override stays the single dispatch point.
   */
  async probeAllModels(
    providerId: string,
    requests: readonly ProbeModelRequest[],
    probeOne: (request: ProbeModelRequest) => Promise<ProbeModelResult>,
  ): Promise<ProbeAllModelsResult> {
    return probeAllModels(providerId, requests, probeOne);
  }

  /**
   * Batched account-wide probe. `probeModel` is passed through so a subclass
   * override stays the single dispatch point.
   */
  async probeAllAccounts(
    tenantId: string,
    providerId: string,
    request: ProbeModelRequest,
    probeOne: (request: ProbeModelRequest) => Promise<ProbeModelResult>,
  ): Promise<ProbeAllAccountsResult> {
    return probeAllAccounts(this.db, tenantId, providerId, request, probeOne);
  }
}
