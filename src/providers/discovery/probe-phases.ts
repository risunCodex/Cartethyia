/**
 * Phase helpers extracted from `ProviderProbingService.probeModel`.
 *
 * `probeModel` stays the orchestrator: it loads the provider snapshot once and
 * then runs these phases in order — resolve the wire target, select a
 * health-filtered account, resolve an adapter, load the tenant's probe
 * preferences, build the canonical request, dispatch (still inline: it owns the
 * `events`/`ttfbMs`/`capturedRequest` mutations), record account health, and
 * compute the verdict. The pure stream helpers (`extractSample`,
 * `hasMeaningfulOutput`) and the provider-row → wire-context mapping live here
 * too; the mapping is shared with `syncModels`.
 */
import { and, eq } from "drizzle-orm";
import { globalOrOwnedBy } from "../../persistence/tenant-scope";
import type { CartethyiaDatabase } from "../../persistence/db-handle";
import { consoleSettings, models, providerAccounts } from "../../persistence/schema";
import type {
  CanonicalEvent,
  CanonicalRequest,
  ServiceKind,
  SourceSurface,
  UsageRecord,
  WireFamily,
} from "../../protocol/canonical-model";
import type { CompatibilityProfile } from "../provider-metadata";
import type { ProbeModelRequest, ProbeMode } from "./discovery-types";
import type { ModelProbeMode } from "../../console/settings/contracts";
import {
  constrainWireFamily,
  discoveryPathsFor,
  resolveDiscoveredWire,
  staticEndpointForWire,
  supportedWireFamiliesForProvider,
  type ProviderWireContext,
} from "./probe-wire";
import { OpenAICompatibleAdapter } from "../adapters/compatible-adapter";
import { resolveByokWireProfile } from "../operations/byok-wire-profile";
import { recordAccountFailure, recordAccountSuccess } from "../operations/account-health-service";
import { buildCapabilityProfile } from "../../transport/routing/route-catalog";
import { payloadRetentionMs, resolvePayloadCapture } from "../../observability/payload-capture";
import type { TelemetryPayloadDepth } from "../../console/settings/contracts";
import { classifyUpstreamFailure } from "../../transport/failure-policy";
import { terminalFailure } from "../../transport/dispatch/attempt-finalize";
import { GatewayError } from "../../protocol/gateway-error";
import type { ModelDefinition } from "../provider-model-definition";
import type { ProviderAdapter, ProviderId } from "../provider-contracts";
import type { ProviderRegistry } from "../provider-registry";

/**
 * The provider row columns `loadProviderWireRow` selects, shared by the phases
 * so one row shape serves wire resolution, the account gate, and the
 * custom-adapter fallback.
 */
export interface ProbeProviderRow {
  readonly baseUrl: string | null;
  readonly wireFamilyDefault: WireFamily | null;
  readonly compatibilityProfile: unknown;
  readonly requiresAccount: boolean;
}

/**
 * Maps a provider row onto the wire-resolution context. Nullable columns
 * normalize to `undefined` so the resolver's `??` layering applies.
 */
export function wireContextFrom(
  row: { wireFamilyDefault: WireFamily | null; compatibilityProfile: unknown } | undefined,
): ProviderWireContext {
  return {
    wireFamilyDefault: (row?.wireFamilyDefault as WireFamily | undefined) ?? undefined,
    endpointPathsByWireFamily: (row?.compatibilityProfile as CompatibilityProfile | null)
      ?.endpoint_paths_by_wire_family as Partial<Record<WireFamily, string>> | undefined,
    modelWireFamilies: (row?.compatibilityProfile as CompatibilityProfile | null)
      ?.model_wire_families as
      ReadonlyArray<{ pattern: string; wire_family: WireFamily }> | undefined,
  };
}

/**
 * Grok's account feature probe intentionally uses the same Responses request as
 * live traffic.
 *
 * The prompt must make the model actually reply `407` — that literal is the
 * healthy-account signal the probe verdict keys on. Naive phrasing refused by
 * the model ("I can't reply with only a specific number", "I won't comply
 * with a demand to output only an exact phrase") are listed above; verified
 * live 2026-11-02 (grok-4.7) that this prompt returns exactly `407`:
 *
 *   "Type the number 407."      → "407"
 *   "Echo the diagnostic code 407." → "407"
 *   "Print the number 407 and nothing else." → "407"
 *
 * The verdict normalizes away Grok's trailing confidence annotation
 * (`407 \confidence{100}`), so the match is on the bare number.
 */
export const GROK_407_PROBE_PROMPT = "Type the number 407.";

/**
 * Converts a failed/mismatched Grok feature probe into a quota-shaped upstream
 * error. The account health machine supplies the 24-hour Grok fallback while
 * retaining any reset duration already present in the provider detail.
 */
export function grok407ProbeFailure(args: {
  readonly providerId: string;
  readonly prompt: string | undefined;
  readonly events: readonly CanonicalEvent[];
  readonly dispatchError: unknown;
}): GatewayError | undefined {
  if (args.providerId !== "grok" || args.prompt !== GROK_407_PROBE_PROMPT) return undefined;
  const sample = extractSample(args.events);
  const normalizedSample = sample?.replace(/\\confidence\{\d+\}\s*$/i, "").trim();
  // A healthy account answers exactly `407` (optionally with Grok's trailing
  // confidence annotation). The model refuses some phrasings of the same ask,
  // but the probe prompt above is engineered to pass, so any other sample is a
  // failure — quota-shaped, not a payload bug.
  if (normalizedSample === "407") return undefined;
  const priorDetails = args.dispatchError instanceof GatewayError ? args.dispatchError.details : {};
  const providerStatus =
    typeof priorDetails.providerStatus === "number" ? priorDetails.providerStatus : undefined;
  const returned202 = normalizedSample === "202" || providerStatus === 202;
  const detail =
    returned202
      ? "Grok 407 feature probe returned 202 instead of 407"
      : args.dispatchError instanceof Error
        ? `Grok 407 feature probe failed: ${args.dispatchError.message}`
        : sample === undefined
          ? "Grok 407 feature probe returned no exact 407 response"
          : `Grok 407 feature probe returned ${sample}`;
  return new GatewayError(
    "quota_exceeded",
    429,
    `${detail} (request {requestId}). You've maxed this window — pace yourself ⏳`,
    {
      ...priorDetails,
      providerCode: "subscription:free-usage-exhausted",
      ...(providerStatus === undefined && returned202
        ? { providerStatus: 202, upstreamStatus: 202 }
        : {}),
    },
    "upstream",
  );
}

/** Best-effort visible text extracted from a probe's streamed content deltas, capped for display. */
export function extractSample(events: readonly CanonicalEvent[]): string | undefined {
  let text = "";
  for (const event of events) {
    if (event.type === "content_delta" && event.content.kind === "text")
      text += event.content.text;
  }
  const trimmed = text.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 200) : undefined;
}

/**
 * Reads the model an adapter reported in its canonical events.
 *
 * The HTTP-only `readReportedModel` inspects the raw response body, so it
 * cannot see the model on non-HTTP transports (Qoder gRPC). Adapters surface
 * the upstream echo as `response_start`/`message_start` with a `model` field;
 * this reads that as a fallback.
 */
export function modelFromEvents(events: readonly CanonicalEvent[]): string | undefined {
  for (const event of events) {
    if (
      (event.type === "response_start" || event.type === "message_start") &&
      typeof event.model === "string" &&
      event.model.trim().length > 0
    ) {
      return event.model.trim();
    }
  }
  return undefined;
}

export function hasMeaningfulOutput(events: readonly CanonicalEvent[]): boolean {
  return events.some((event) => {
    if (event.type === "tool_call_delta") return true;
    if (event.type !== "content_delta") return false;
    const content = event.content;
    if (content.kind === "text" || content.kind === "refusal")
      return content.text.trim().length > 0;
    if (content.kind === "reasoning")
      return typeof content.summary === "string" && content.summary.trim().length > 0;
    return false;
  });
}

/** Resolved wire target for one probe: family, endpoint path, canonical surface. */
export interface ProbeTarget {
  readonly wireFamily: WireFamily;
  /**
   * Protocol shape of the probed row. A non-`llm` row (System One) is probed
   * through its native endpoint with a decision body, not the canonical chat
   * pipeline — the same split routing uses.
   */
  readonly serviceKind: ServiceKind;
  readonly endpointPath: string;
  readonly sourceSurface: SourceSurface;
  /**
   * The capability profile the probe dispatches under.
   *
   * A probe runs the real adapter, and a real adapter gates on capabilities
   * (`ClaudeAdapter` rejects every request whose required capabilities the
   * target does not declare). An empty profile therefore rejected the probe on
   * capabilities the route actually has — `prompt_caching`, `tools`,
   * `reasoning` — reporting a provider as broken over a gate the provider
   * passes for live traffic. Resolved from the same model row the router reads
   * so the probe tests the route, not an empty stand-in.
   */
  readonly capabilityProfile: Readonly<Record<string, boolean>>;
  /** The model row's output ceiling, when it declares one. */
  readonly outputLimit?: number | null;
}

/**
 * Phase 1 — resolve which wire family and endpoint path the probe dispatches
 * to. The provider's own contract decides which wires are reachable at all (the
 * adapter rejects anything else with `capability_unsupported`), so a stored
 * row, a bundled catalog row, or a discovery guess naming an unserved family
 * can only produce a 400; the resolved family is constrained to the contract
 * and a corrected family recomputes its endpoint.
 */
export async function resolveProbeTarget(args: {
  readonly db: CartethyiaDatabase;
  readonly bundledModelCatalog: ReadonlyMap<string, readonly ModelDefinition[]>;
  readonly defaultEndpoints: Record<WireFamily, string>;
  readonly providerId: string;
  readonly modelId: string;
  readonly request: ProbeModelRequest;
  readonly providerWireRow: ProbeProviderRow | undefined;
}): Promise<ProbeTarget> {
  const { db, bundledModelCatalog, defaultEndpoints, providerId, modelId, request, providerWireRow } =
    args;
  const requestedServiceKind: ServiceKind = request.serviceKind ?? "llm";
  const declaredFamilies = supportedWireFamiliesForProvider(
    providerId,
    providerWireRow?.wireFamilyDefault,
    providerWireRow?.compatibilityProfile,
  );
  // Operator profile > the provider's own bundled catalog (cline serves chat
  // from `/chat/completions`; the generic `/v1/…` default would join into an
  // unreachable path and surface as upstream 404) > probe map > generic
  // default. A custom provider's operator-entered base may already carry
  // `/v1`, so the resolved path is stripped to avoid `/v1/v1/messages`.
  const endpointForFamily = (family: WireFamily): string => {
    const profile = providerWireRow?.compatibilityProfile as CompatibilityProfile | null;
    const ep =
      profile?.endpoint_paths_by_wire_family?.[family] ??
      staticEndpointForWire(bundledModelCatalog, providerId, family) ??
      discoveryPathsFor(providerId)?.[family];
    return ep ?? defaultEndpoints[family] ?? "/v1/chat/completions";
  };

  let wireFamily: WireFamily;
  let endpointPath: string;
  // A native-service row (System One) probes through its native endpoint, not a
  // chat wire. Read from the same row the wire came from; an explicit
  // `request.wireFamily` never carries it (the operator is naming a chat wire).
  let serviceKind: ServiceKind = requestedServiceKind;
  // Capability columns for the row the probe lands on. Resolved alongside the
  // wire so the profile describes the same row the probe dispatches to.
  let capabilitySource: { modalities: unknown; reasoning: boolean; toolCall: boolean; outputLimit: number | null } = {
    modalities: null,
    reasoning: false,
    toolCall: false,
    outputLimit: null,
  };
  if (request.wireFamily) {
    wireFamily = request.wireFamily as WireFamily;
    endpointPath = endpointForFamily(wireFamily);
  } else {
    const staticDef = bundledModelCatalog
      .get(providerId)
      ?.find(
        (def) =>
          def.modelId === modelId &&
          (def.serviceKind ?? "llm") === requestedServiceKind &&
          (!request.route || def.endpointPath === request.route),
      );
    if (staticDef) {
      wireFamily = staticDef.wireFamily;
      endpointPath = staticDef.endpointPath;
      serviceKind = staticDef.serviceKind ?? "llm";
      capabilitySource = {
        modalities: staticDef.modalities,
        reasoning: staticDef.reasoning,
        toolCall: staticDef.toolCall,
        outputLimit: staticDef.outputLimit ?? null,
      };
    } else {
      const existing = await db
        .select({
          wireFamily: models.wireFamily,
          serviceKind: models.serviceKind,
          endpointPath: models.endpointPath,
          modalities: models.modalities,
          reasoning: models.reasoning,
          toolCall: models.toolCall,
          outputLimit: models.outputLimit,
        })
        .from(models)
        .where(
          request.route
            ? and(
                eq(models.providerId, providerId),
                eq(models.modelId, modelId),
                eq(models.serviceKind, requestedServiceKind),
                eq(models.endpointPath, request.route),
              )
            : and(
                eq(models.providerId, providerId),
                eq(models.modelId, modelId),
                eq(models.serviceKind, requestedServiceKind),
              ),
        )
        .limit(1);
      if (existing[0]) {
        wireFamily = existing[0].wireFamily as WireFamily;
        endpointPath = existing[0].endpointPath;
        serviceKind = existing[0].serviceKind as ServiceKind;
        capabilitySource = {
          modalities: existing[0].modalities,
          reasoning: existing[0].reasoning,
          toolCall: existing[0].toolCall,
          outputLimit: existing[0].outputLimit ?? null,
        };
      } else {
        if (requestedServiceKind !== "llm") {
          throw new GatewayError(
            "model_not_found",
            404,
            `No ${requestedServiceKind} model ${modelId} is registered for provider ${providerId} (request {requestId}). Try another model — this one's off the menu 📚`,
          );
        }
        const ctx = wireContextFrom(providerWireRow);
        const resolved = resolveDiscoveredWire(
          modelId,
          ctx,
          discoveryPathsFor(providerId),
          defaultEndpoints,
        );
        wireFamily = resolved.wireFamily;
        endpointPath = resolved.endpointPath;
      }
    }
  }
  // A stored row, a bundled catalog row, or a discovery guess is a cache of the
  // derivation, not an authority: it can name a wire the provider's own
  // declaration does not list, and dispatch would then answer
  // `capability_unsupported` for a probe the operator never asked for. The
  // contract wins for those derived sources and the endpoint is recomputed for
  // the family it selected, so the probe reports the provider's real shape.
  //
  // An explicit `request.wireFamily` is deliberately exempt: that is the
  // operator naming the wire themselves, not a derivation to be corrected. The
  // wire selector exists to reach an upstream protocol this gateway carries no
  // bundled knowledge of, so silently swapping the choice would probe a
  // different wire than the one requested — the failure this exemption fixes.
  if (!request.wireFamily) {
    const contracted = constrainWireFamily(wireFamily, declaredFamilies);
    if (contracted.corrected) {
      wireFamily = contracted.wireFamily;
      endpointPath = endpointForFamily(wireFamily);
    }
  }
  // Wire family and source surface are not the same vocabulary, so this cannot
  // be a plain assignment: `gemini` names a wire (native generateContent) but
  // has no canonical request surface of its own, while `completion` is a
  // surface with no matching wire.
  // Probing a Gemini wire therefore has to name the surface whose codec builds
  // the request, rather than pretending the wire is a surface.
  const sourceSurface: SourceSurface = wireFamily === "gemini" ? "chat" : wireFamily;
  // Built from the row the probe resolves to, so the adapter's capability gate
  // sees the same profile live traffic would. `providerId` is part of the
  // profile because a bespoke-wire provider has no canonical codec and must not
  // inherit a codec's modality grants.
  const capabilityProfile = buildCapabilityProfile({
    modalities: capabilitySource.modalities,
    reasoning: capabilitySource.reasoning,
    toolCall: capabilitySource.toolCall,
    providerId,
  });
  return { wireFamily, serviceKind, endpointPath, sourceSurface, capabilityProfile, outputLimit: capabilitySource.outputLimit };
}

/** The account a probe selected, or the operator-facing reason it could not. */
export type ProbeAccountSelection =
  | { readonly ok: true; readonly accountId: string | undefined }
  | { readonly ok: false; readonly error: string };

/**
 * Selects the first usable account row: status ≠ disabled, cooldown elapsed
 * (unless `allowCoolingAccount`), preferring a tenant-owned account over a
 * shared global one. Shared by the discovery and probing paths so both
 * agree on which account a provider answers as.
 */
export function selectUsableAccount<T extends {
  readonly tenantId: string | null;
  readonly status: string;
  readonly cooldownUntil: Date | null;
}>(
  rows: readonly T[],
  allowCoolingAccount = false,
  now = Date.now(),
): T | undefined {
  return rows
    .filter(
      (row) =>
        row.status !== "disabled" &&
        (allowCoolingAccount || row.cooldownUntil === null || row.cooldownUntil.getTime() <= now),
    )
    .sort((left, right) => Number(right.tenantId !== null) - Number(left.tenantId !== null))[0];
}

/**
 * Phase 2 — pick the account the probe runs as. Snapshot-equivalent health
 * filtering: disabled accounts and live cooldowns never route, so probes must
 * not select them either. Tenant-owned accounts win over shared global ones.
 */
export async function selectProbeAccount(args: {
  readonly db: CartethyiaDatabase;
  readonly tenantId: string;
  readonly providerId: string;
  readonly requestedAccountId: string | undefined;
  readonly requiresAccount: boolean;
  /** Explicit Grok 407 feature tests may verify a cooling account to recover it. */
  readonly allowCoolingAccount?: boolean;
}): Promise<ProbeAccountSelection> {
  const {
    db,
    tenantId,
    providerId,
    requestedAccountId,
    requiresAccount,
    allowCoolingAccount = false,
  } = args;
  const accountRows = requiresAccount
    ? await db
        .select({
          id: providerAccounts.id,
          tenantId: providerAccounts.tenantId,
          credentialKind: providerAccounts.credentialKind,
          status: providerAccounts.status,
          cooldownUntil: providerAccounts.cooldownUntil,
        })
        .from(providerAccounts)
        .where(
          and(
            eq(providerAccounts.providerId, providerId),
            globalOrOwnedBy(providerAccounts.tenantId, tenantId),
            ...(requestedAccountId ? [eq(providerAccounts.id, requestedAccountId)] : []),
          ),
        )
    : [];
  const usableAccount = selectUsableAccount(accountRows, allowCoolingAccount);
  const accountId = requestedAccountId ?? usableAccount?.id;
  if (!accountId && requiresAccount) {
    return {
      ok: false,
      error:
        accountRows.length > 0
          ? "All configured accounts for this provider are disabled or cooling down."
          : "No account configured for this provider yet — add one before probing a model.",
    };
  }
  return { ok: true, accountId };
}

/**
 * Phase 3 — resolve the adapter that dispatches the probe. Custom/BYOK
 * providers (e.g. infercrot) have no bundled adapter but carry a baseUrl; fall
 * back to the generic OpenAI-compatible adapter so probe/dispatch still works.
 * The low-level compatible adapter is used directly to avoid importing concrete
 * integrations from discovery (which would violate the provider-architecture
 * layering test). `loadOne` returning `undefined` means "no bundled adapter";
 * a throw is a registry failure and propagates rather than being reported as
 * "no adapter registered".
 */
export async function resolveProbeAdapter(args: {
  readonly providerRegistry: ProviderRegistry;
  readonly providerId: string;
  readonly providerWireRow: ProbeProviderRow | undefined;
}): Promise<ProviderAdapter | undefined> {
  const { providerRegistry, providerId, providerWireRow } = args;
  let adapter = await providerRegistry.loadOne(providerId);
  if (!adapter) {
    try {
      if (providerWireRow?.baseUrl) {
        const wireProfile = resolveByokWireProfile(
          providerWireRow.wireFamilyDefault,
          providerWireRow.compatibilityProfile as CompatibilityProfile | null,
        );
        adapter = new OpenAICompatibleAdapter({
          provider_id: providerId as ProviderId,
          base_url: providerWireRow.baseUrl,
          authentication_header_shape: wireProfile.authHeaderShape,
          endpoint_paths_by_wire_family: wireProfile.endpointPathsByWireFamily,
        });
      }
    } catch {
      // Custom adapter resolution failures safely fall through to unconfigured provider response.
    }
  }
  return adapter;
}

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
export const PROBE_FAST_DEFAULT_PROMPT = "How are you?";
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
}): CanonicalRequest {
  const { modelId, request, probeReasoning, sourceSurface, maxOutputTokens } = args;
  const fast = maxOutputTokens === PROBE_FAST_MAX_OUTPUT_TOKENS;
  return {
    model: modelId,
    messages: [
      {
        role: "user",
        content: [
          {
            kind: "text",
            text:
              request.prompt ??
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

/**
 * Phase 7 — mirror the probe's outcome onto the account's health machine. A
 * probe that fails against a real account carries the same health signal as
 * live traffic (quota exhaustion, dead credentials): record it so the account
 * cools down / disables instead of staying green while every probe fails.
 * Non-mutating categories (unknown, policy) are no-ops inside
 * `recordAccountFailure`; this never throws. A successful probe proves the
 * account works, so recover it symmetrically (a cooling account flips back to
 * active instead of staying stale).
 */
export async function recordProbeHealth(args: {
  readonly db: CartethyiaDatabase;
  readonly invalidator: { invalidate(): unknown } | undefined;
  readonly accountId: string | undefined;
  readonly dispatchError: unknown;
  /**
   * The probe's canonical events, when there are any.
   *
   * Needed because some adapters deliver a refusal as a terminal event rather
   * than as a thrown error — Cursor's `resource_exhausted` is the case — so
   * `dispatchError` stays `undefined` for a Run the upstream refused. Without
   * the events, that account looked like a success and was recovered.
   */
  readonly events?: readonly CanonicalEvent[] | undefined;
  readonly modelId: string;
  readonly upstreamStatusCode: number | undefined;
}): Promise<void> {
  const { db, invalidator, accountId, dispatchError, modelId, upstreamStatusCode } = args;
  // A terminal `failed` state is written only by the upstream decoders, so it
  // is the upstream refusing — the same thing a thrown error would have meant.
  const terminal = args.events?.find((event) => event.type === "terminal");
  // Reconstructed through the very function the live dispatch path uses, so a
  // refusal carries the same code, status, and health classification in both.
  // Hand-rolling a category here is how the two paths drifted apart.
  const refusedUpstream =
    terminal?.type === "terminal" && terminal.state === "failed"
      ? terminalFailure(terminal)
      : undefined;
  const failure = dispatchError ?? refusedUpstream;
  if (failure !== undefined && accountId) {
    const failureEvidence = {
      ...classifyUpstreamFailure(failure),
      modelId,
      ...(upstreamStatusCode === undefined ? {} : { statusCode: upstreamStatusCode }),
    };
    // The health machine owns the outcome. A 202 that carries a rate limit is
    // already classified as `rate_limit_transient` with a real cooldown by
    // `classifyAccountError`, so writing a status here only clobbered that
    // cooldown with a state nothing recovers from.
    await recordAccountFailure(db, accountId, failure, failureEvidence)
      .then((classification) => {
        if (classification?.mutatesAccount) void invalidator?.invalidate();
      })
      .catch(() => {});
  }
  // Symmetric: a successful probe proves the account works, so recover it
  // (a cooling account flips back to active instead of staying stale).
  // recordAccountSuccess is a no-op write for already-healthy accounts and
  // never throws.
  if (failure === undefined && accountId) {
    await recordAccountSuccess(db, accountId)
      .then((recovered) => {
        if (recovered) void invalidator?.invalidate();
      })
      .catch(() => {});
  }
}

/** The connectivity verdict a probe's event stream and dispatch error yield. */
export interface ProbeVerdict {
  readonly ok: boolean;
  readonly errorMessage: string | undefined;
  readonly usage: UsageRecord | undefined;
}

/**
 * Phase 8 — turn the probe's event stream and any dispatch error into the
 * verdict. Reasoning-only models can exhaust the tiny probe budget before
 * emitting visible text: a `length`-capped run that still produced reasoning
 * content proves connectivity, so count it as a pass.
 */
export function computeProbeVerdict(args: {
  readonly events: readonly CanonicalEvent[];
  readonly dispatchError: unknown;
  readonly wireFamily: WireFamily;
}): ProbeVerdict {
  const { events, dispatchError, wireFamily } = args;
  const terminal = events.find((event) => event.type === "terminal");
  const producedReasoning = events.some(
    (event) => event.type === "content_delta" && event.content.kind === "reasoning",
  );
  const cappedButReasoning =
    terminal?.type === "terminal" &&
    terminal.state === "complete" &&
    terminal.stop_reason === "length" &&
    producedReasoning;
  const ok =
    dispatchError === undefined &&
    terminal?.type === "terminal" &&
    (terminal.state === "complete" || cappedButReasoning);
  let errorMessage: string | undefined;
  if (dispatchError !== undefined) {
    const base =
      dispatchError instanceof GatewayError
        ? dispatchError.message
        : dispatchError instanceof Error
          ? dispatchError.message
          : "Model probe failed";
    // Present upstream errors with provider/wire/status context instead of a
    // raw JSON blob like "{\"error\":\"Not Found\",\"success\":false}".
    // Try to unwrap a JSON-stringified error body first.
    let pretty = base;
    const trimmed = base.trim();
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>;
        const inner =
          typeof parsed.error === "string"
            ? parsed.error
            : typeof parsed.message === "string"
              ? parsed.message
              : undefined;
        if (inner) pretty = inner;
      } catch {
        // Malformed or non-standard JSON error payloads safely retain original error message.
      }
    }
    const details =
      dispatchError instanceof GatewayError
        ? (dispatchError.details as Record<string, unknown>)
        : undefined;
    const status =
      dispatchError instanceof GatewayError && typeof dispatchError.status === "number"
        ? dispatchError.status
        : undefined;
    const providerCode =
      typeof details?.providerCode === "string" ? String(details.providerCode) : undefined;
    const providerStatus =
      typeof details?.providerStatus === "number" ? Number(details.providerStatus) : undefined;
    const upstreamReq =
      typeof details?.upstreamRequestId === "string"
        ? String(details.upstreamRequestId)
        : undefined;
    const statusTag =
      providerCode !== undefined && providerStatus !== undefined
        ? `${providerCode} (upstream ${status ?? providerStatus})`
        : providerCode !== undefined
          ? providerCode
          : status !== undefined
            ? `upstream ${status}`
            : undefined;
    // A 429 that names a free-tier usage limit is upstream quota state, not a
    // payload or egress defect — label it as the throttle it is instead of a
    // generic probe failure.
    const throttled =
      status === 429 ||
      providerStatus === 429 ||
      /free usage limit|rate limit|throttl/i.test(base);
    // The toast title already names the model. Repeating `provider/model via
    // wire path` in the body made the operator read the same identity twice
    // and buried the upstream sentence. The wire family stays, because that is
    // the one fact the title does not carry; the path is noise next to it.
    const tagged = statusTag !== undefined ? `${pretty} (${statusTag})` : pretty;
    errorMessage = `${wireFamily} — ${throttled ? "Upstream rate limit (HTTP 429): " : ""}${tagged}${upstreamReq ? ` [req ${upstreamReq}]` : ""}`;

  } else if (terminal?.type === "terminal" && terminal.state !== "complete") {
    // Read the terminal's own detail before falling back to the stop reason.
    //
    // `stop_reason` is a canonical one-word label — "error" — so reporting it
    // alone turned a Cursor quota refusal into a toast whose entire body was
    // the word "error". The upstream sentence an operator needs is in
    // `stop_details`, which is where the adapter parks it and where the live
    // dispatch path already reads it (see `terminalFailure` in
    // `attempt-finalize.ts`). The probe path disagreed with the dispatch path
    // about the same provider response.
    const detail = terminal.stop_details;
    const message =
      typeof detail?.["message"] === "string" && detail["message"].trim().length > 0
        ? detail["message"].trim()
        : undefined;
    const code = typeof detail?.["code"] === "string" ? detail["code"] : undefined;
    const tag = code === undefined ? "" : ` (${code})`;
    errorMessage = `${message ?? terminal.stop_reason ?? "Model probe failed"}${tag}`;
  } else {
    errorMessage = undefined;
  }
  const usage = terminal?.type === "terminal" ? terminal.usage : undefined;
  return { ok, errorMessage, usage };
}
