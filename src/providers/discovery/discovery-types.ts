import type { FetchLike } from "../quota/quota-contracts";
import type { ModelDefinition } from "../provider-model-definition";
import type { ServiceKind } from "../../protocol/canonical-model";
/**
 * Credential-scoped model-discovery input.
 *
 * Every adapter's `discover*Models` entry point takes the same three fields, so
 * the shape lives here instead of being redeclared per adapter. `fetcher` is the
 * transport seam tests inject; an adapter that always uses the global `fetch`
 * simply ignores it.
 */
export interface DiscoveryInput {
  readonly credential: string;
  readonly signal?: AbortSignal | undefined;
  readonly fetcher?: FetchLike | undefined;
}

/** Inputs supplied by model-discovery orchestration to a provider capability. */
interface ModelDiscoveryContext {
  readonly baseUrl: string;
  readonly credential: string;
  readonly fetcher?: typeof fetch;
  /**
   * Non-secret per-account auth configuration of the account whose credential
   * is being used. A provider whose model catalog is region- or profile-scoped
   * needs it to build the request; most ignore it.
   */
  readonly authState?: Readonly<Record<string, unknown>> | undefined;
}

/** Provider-owned model discovery boundary. */
export type ProviderModelDiscovery = (
  context: ModelDiscoveryContext,
) => Promise<readonly ModelDefinition[] | null>;

/**
 * One-shot model connectivity probe contracts, shared by the provider
 * discovery orchestrator and the console catalog route layer. Lived here
 * (not in `console/`) so the lower discovery layer never imports console
 * presentation types.
 */

/**
 * Reasoning efforts a probe accepts, as a runtime tuple.
 *
 * Deliberately narrower than the canonical `REASONING_EFFORTS`: `none` says
 * nothing to probe and `max` is a provider-side ceiling the probe cannot
 * request usefully. Declared here beside `ProbeModelRequest` so the request
 * type and the route's Elysia schema project the same list.
 *
 * `auto` (the default) sends no reasoning intent at all, leaving the provider's
 * own default in place. That is the honest choice for a probe: the operator is
 * testing whether a route works, and the model may not support reasoning at all
 * — forcing an effort onto an unsupported model turns a working route into a
 * failure and hides what the route actually is.
 */
export const PROBE_REASONING_EFFORTS = ["auto", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
/** One accepted probe reasoning effort. `auto` means "send no reasoning intent". */
export type ProbeReasoningEffort = (typeof PROBE_REASONING_EFFORTS)[number];

/** Modelprobe modes as a runtime tuple, so the route schema projects one list. */
export const PROBE_MODES = ["fast", "detail"] as const;
/** `detail` is the default when `mode` is absent (D39). */
export type ProbeMode = (typeof PROBE_MODES)[number];

/** Request accepted for a one-shot model connectivity test. `route`
 * disambiguates when a model id is registered under multiple endpoint
 * paths; omit it to probe against the model's already-registered wire
 * shape, or provide `wireFamily` to test a not-yet-registered candidate. */
export interface ProbeModelRequest {
  modelId: string;
  /** Native service to probe; omitted means the ordinary LLM route. */
  serviceKind?: ServiceKind;
  route?: string;
  wireFamily?: string;
  accountId?: string;
  prompt?: string;
  /** Omit or `auto` to probe without any reasoning intent. */
  reasoningEffort?: ProbeReasoningEffort;
  maxOutputTokens?: number;
  stream?: boolean;
  /**
   * Provider-specific transport override for the probe.
   *
   * `undefined` (default) probes through the same transport live traffic
   * uses. A provider may expose extra surfaces that only a probe can force —
   * Qoder's IDE surface (`/model/v1`) is the only one that echoes strategy
   * metadata (`provider_model`, `target`, …) alongside the answer, while the
   * production transports (gRPC / COSY) do not. Forcing it makes the probe
   * result the richest available source of truth.
   */
  surface?: "default" | "cosy" | "grpc" | "ide";
  /**
   * `fast` is a cheap liveness check: 32 output tokens, a 10s timeout, no
   * retry, no payload-body capture, compact telemetry, and an 80-char sample.
   * `detail` (the default when absent) is the full diagnostic probe.
   * Health recording is identical in both modes.
   */
  mode?: ProbeMode;
}
export interface ProbeModelResult {
  accountId?: string;
  ok: boolean;
  latencyMs: number;
  ttfbMs?: number;
  sample?: string;
  /**
   * The `model` the upstream reported in its own response, verbatim.
   *
   * Not the model the probe asked for, and deliberately no fallback to it: a
   * probe that asked for `muse-spark-1.3` and was answered by
   * `deepseek-v4.1-flash` has found something, and filling in the requested id
   * when the response carried none would report the ask as if it were the
   * answer. Absent means the response said nothing.
   */
  reportedModel?: string;
  statusCode?: number;
  error?: string;
  /**
   * Provider-specific upstream metadata about the model that actually served
   * the turn (native model id, supply target, tier). Filled when the probed
   * transport exposes it — Qoder's IDE surface reports it in `raw_usage`;
   * the production transports do not.
   */
  providerMetadata?: Readonly<Record<string, unknown>>;
  /** Normalized hits a `websearch` probe returned, so the console can show them. */
  searchResults?: ReadonlyArray<{
    readonly title: string;
    readonly url: string;
    readonly snippet: string;
  }>;
}

/**
 * Ad-hoc connectivity test for an operator-entered BYOK provider that has not
 * been persisted yet. Carries exactly the fields the create-provider modal
 * collects, so the console route never has to invent defaults the runtime
 * would not use.
 */
export interface ByokConnectionTestRequest {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly wireFamily: string;
  /** Whether to stamp the wire family's official CLI identity headers. */
  readonly cliIdentity?: boolean;
  readonly extraHeaders?: Readonly<Record<string, string>>;
}

export interface ByokConnectionTestResult {
  readonly ok: boolean;
  readonly latencyMs: number;
  readonly statusCode?: number;
  /** Number of models the upstream advertised; absent when the body was not a list. */
  readonly modelCount?: number;
  readonly error?: string;
  /**
   * A non-blocking note about what was corrected or looks wrong in the submitted
   * base URL. Absent when the input was already a root. The test still reports
   * `ok` on its own terms; this is the operator-facing explanation.
   */
  readonly warning?: string;
}

/** One entry of a batched provider-wide probe (`probeAllModels`). */
export interface ProbeAllModelsResult {
  providerId: string;
  results: ReadonlyArray<{
    modelId: string;
    ok: boolean;
    latencyMs: number;
    error?: string;
  }>;
}
export interface ProbeAllAccountsResult {
  providerId: string;
  modelId: string;
  results: ReadonlyArray<ProbeModelResult>;
}
