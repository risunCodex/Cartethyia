/**
 * Probe phases 4–5 — load the tenant's probe preferences and build the
 * canonical probe request.
 */
import { eq } from "drizzle-orm";
import type { CartethyiaDatabase } from "../../persistence/db-handle";
import { consoleSettings } from "../../persistence/schema";
import type { CanonicalRequest, WireFamily } from "../../protocol/canonical-model";
import type { ProbeModelRequest, ProbeMode } from "./discovery-types";
import type { ModelProbeMode } from "../../config/settings-vocabulary";
import type { SourceSurface } from "../../protocol/canonical-model";
import { payloadRetentionMs, resolvePayloadCapture } from "../../observability/payload-capture";
import type { TelemetryPayloadDepth } from "../../config/settings-vocabulary";

/** The reasoning shape a Responses-wire probe carries. */
export interface ProbeReasoning {
  effort: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  summary_mode: "auto" | "concise" | "detailed";
}

/** Default fast-probe timeout, in seconds (D39/D40). */
export const PROBE_FAST_DEFAULT_TIMEOUT_SECONDS = 10;
/** Default fast-probe output allowance, in tokens (D40). */
export const PROBE_FAST_MAX_OUTPUT_TOKENS = 64;
/** Fast-probe default prompt: a neutral greeting, not an identity question. */
export const PROBE_FAST_DEFAULT_PROMPT = "ping";
/** Fast-probe sample bound, in characters (D40). */
export const PROBE_FAST_SAMPLE_MAX_CHARS = 80;

/** Tenant probe preferences that shape the request and telemetry. */
export interface ProbePreferences {
  readonly probeReasoning: ProbeReasoning | undefined;
  /** Effective probe mode: an explicit request wins over the tenant default. */
  readonly mode: ProbeMode;
  /** Timeout in ms for `fast`; `undefined` keeps `detail`'s 30s budget. */
  readonly timeoutMs: number | undefined;
  /** Token allowance for the canonical request; only `fast` overrides it. */
  readonly maxOutputTokens: number | undefined;
  /** `fast` suppresses payload-body capture and trims telemetry. */
  readonly compactTelemetry: boolean;
  /**
   * The tenant's resolved capture policy for the probe, through the same
   * `resolvePayloadCapture` path every dispatched request uses.
   *
   * `none` (and a failed preference read — capture fails closed) captures
   * nothing; `metadata` captures stage presence only; `full` keeps bodies at
   * the tenant's own depth and retention. The previous boolean collapsed all
   * three into "capture on", so a probe teed bodies at the flat deployment
   * cap for a tenant whose choice was `metadata` — and whose live requests
   * stored none.
   */
  readonly payloadCapture: {
    readonly enabled: boolean;
    readonly mode: "none" | "metadata" | "full";
    readonly depth: TelemetryPayloadDepth;
    readonly retentionMs: number;
  };
}

/**
 * Phase 4 — load the tenant's probe preferences. Global Responses reasoning
 * mode defaults to `detailed` (not hard-coded probe/v1). When the probed model
 * is a Responses wire (muse-spark etc) the summary is forced to the tenant's
 * preference.
 */
export async function loadProbePreferences(args: {
  readonly db: CartethyiaDatabase;
  readonly tenantId: string;
  readonly wireFamily: WireFamily;
  readonly request: ProbeModelRequest;
}): Promise<ProbePreferences> {
  const { db, tenantId, wireFamily, request } = args;
  let probeReasoning: ProbeReasoning | undefined;
  let configuredMode: ModelProbeMode = "detail";
  let configuredFastTimeoutSeconds = PROBE_FAST_DEFAULT_TIMEOUT_SECONDS;
  let payloadCapture: ProbePreferences["payloadCapture"] = {
    enabled: false,
    mode: "none",
    depth: "minimum",
    retentionMs: payloadRetentionMs(),
  };
  // `auto` (and an omitted effort) means "send no reasoning intent": the probe
  // must reflect what the route does by itself, and a model that does not
  // support reasoning would otherwise fail a probe that should have passed.
  const requestedEffort =
    request.reasoningEffort === undefined || request.reasoningEffort === "auto"
      ? undefined
      : request.reasoningEffort;
  try {
    const rows = await db
      .select({ preferences: consoleSettings.preferences })
      .from(consoleSettings)
      .where(eq(consoleSettings.tenantId, tenantId))
      .limit(1);
    const preferences = rows[0]?.preferences;
    const raw = preferences?.responsesReasoningSummary;
    const mode: "auto" | "concise" | "detailed" =
      raw === "auto" || raw === "concise" || raw === "detailed" ? raw : "detailed";
    // The tenant's settings default is `detail` when unset (D39); an explicit
    // per-request `mode` still wins below.
    configuredMode = preferences?.modelProbeMode === "fast" ? "fast" : "detail";
    const configuredTimeout = preferences?.modelProbeFastTimeoutSeconds;
    configuredFastTimeoutSeconds =
      typeof configuredTimeout === "number" && Number.isFinite(configuredTimeout)
        ? Math.min(Math.max(configuredTimeout, 1), 120)
        : PROBE_FAST_DEFAULT_TIMEOUT_SECONDS;
    // Unset matches the settings default: off. Only an explicit choice
    // captures, and at the tenant's own depth/retention — the same resolution
    // `resolvePayloadCapture` performs for dispatched requests, read from the
    // same preferences row this phase already loaded.
    const captureMode = preferences?.telemetryPayloads;
    if (captureMode === "full" || captureMode === "metadata") {
      const resolved = await resolvePayloadCapture(db, tenantId);
      payloadCapture = resolved.ok
        ? {
            enabled: true,
            mode: resolved.mode,
            depth: resolved.depth,
            retentionMs: resolved.retentionMs,
          }
        : // Failed preference read: capture fails closed.
          { enabled: false, mode: "none", depth: "minimum", retentionMs: payloadRetentionMs() };
    }
    if (wireFamily === "responses" && requestedEffort !== undefined) {
      probeReasoning = {
        effort: requestedEffort,
        summary_mode: mode,
      };
    }
  } catch {
    if (wireFamily === "responses" && requestedEffort !== undefined) {
      probeReasoning = {
        effort: requestedEffort,
        summary_mode: "detailed",
      };
    }
  }
  const effectiveMode: ProbeMode = request.mode ?? configuredMode;
  const fast = effectiveMode === "fast";
  return {
    probeReasoning,
    mode: effectiveMode,
    // `detail` keeps its exact 30s budget; `fast` uses the tenant's setting.
    ...(fast ? { timeoutMs: configuredFastTimeoutSeconds * 1000 } : { timeoutMs: undefined }),
    ...(fast ? { maxOutputTokens: PROBE_FAST_MAX_OUTPUT_TOKENS } : { maxOutputTokens: undefined }),
    compactTelemetry: fast,
    // `fast` never tees provider payload bodies (D40). The reported-model read
    // still needs the exchange wrapper, so capture mode, not the wrapper, is
    // what changes.
    payloadCapture: fast
      ? { enabled: false, mode: "none", depth: "minimum", retentionMs: payloadRetentionMs() }
      : payloadCapture,
  };
}

/**
 * Phase 5 — build the canonical probe request. The probe prompt must pass every
 * provider's content-policy review (a bare "hi" trips CodeBuddy's 11140 safety
 * filter) AND produce a useful sample: ask the model to identify itself and
 * state its knowledge cutoff, which both proves a live text response and
 * surfaces a small diagnostic sample in the probe result.
 */
export function buildProbeCanonicalRequest(args: {
  readonly modelId: string;
  readonly request: ProbeModelRequest;
  readonly probeReasoning: ProbeReasoning | undefined;
  readonly sourceSurface: SourceSurface;
  /** `fast` overrides the token allowance without changing the prompt (D42). */
  readonly maxOutputTokens?: number;
  /**
   * Provider-mandated system prompt (adapter `systemPrompt()`), injected as
   * the probe's system turn so upstreams that fingerprint it accept the
   * probe.
   */
  readonly providerSystemPrompt?: string | undefined;
  /**
   * A provider-specific default probe prompt, used when the operator sent no
   * prompt. Lets a provider whose policy gate flags repeated identical probes
   * receive a minimal, per-model-varying probe instead of the shared identity
   * question every provider otherwise sends.
   */
  readonly defaultPromptOverride?: string | undefined;
}): CanonicalRequest {
  const { modelId, request, probeReasoning, sourceSurface, maxOutputTokens, providerSystemPrompt, defaultPromptOverride } = args;
  const fast = maxOutputTokens === PROBE_FAST_MAX_OUTPUT_TOKENS;
  return {
    model: modelId,
    ...(providerSystemPrompt && providerSystemPrompt.trim()
      ? { system: [{ kind: "text", text: providerSystemPrompt }] }
      : {}),
    messages: [
      {
        role: "user",
        content: [
          {
            kind: "text",
            text:
              request.prompt ??
              defaultPromptOverride ??
              (fast ? PROBE_FAST_DEFAULT_PROMPT : "What model are you, and what is your knowledge cutoff date? Answer in one sentence."),
          },
        ],
      },
    ],
    generation_controls: {
      // The probe asks for a sentence, not a page. A 1024-token allowance is
      // the shape a *batch* request takes, and several providers treat an
      // oversized allowance on a trivial prompt as a non-client request — the
      // class of refusal that answers `400 request illegal`. Matching the
      // caller's own small budget keeps the probe the same shape as the traffic
      // it is meant to predict.
      max_tokens: request.maxOutputTokens ?? maxOutputTokens ?? 256,
      max_output_tokens: request.maxOutputTokens ?? maxOutputTokens ?? 256,
      // No temperature. A real dispatch forwards whatever the client sent, and
      // the client rarely sends one; pinning 0.2 here made the probe a
      // different request from the traffic it is supposed to predict. The
      // prompt below is deterministic enough that sampling temperature buys
      // nothing.
      //
      // `include_usage` mirrors what the router attaches to a streamed
      // dispatch. Without it the probe's upstream body is missing a field the
      // real one carries, which is exactly the class of difference that made a
      // provider reject the share page and accept the probe.
      ...(request.stream === false ? {} : { "extension:include_usage": true }),
    },
    ...(probeReasoning ? { reasoning: probeReasoning as never } : {}),
    // Streaming by default. Every probe funnels through here, so one default
    // gives all three entry points (single model, all models, all accounts) the
    // same transport — and a streamed probe is the only one that observes
    // time-to-first-byte, which is what the dashboard reports. A caller that
    // explicitly asks for a non-streamed probe (`stream: false`) still gets one.
    stream: request.stream ?? true,
    source_surface: sourceSurface,
  };
}
