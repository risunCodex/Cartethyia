import type { ConsoleAccessResolver } from "../auth/access";
import type { AuditSink } from "../audit/contracts";
// Runtime-settings control-plane contracts and routes.
import { ConsoleDomainError, errorResponse, requireTenantScope } from "../shared/errors";
import { literalUnion } from "../shared/elysia-schema";
import { t } from "elysia";
import type { AccessDecision } from "../../security/access-control";
import type { RedisBackend } from "../../persistence/redis";
import type { ConsoleSettingsPreferences } from "../../persistence/schema";
import { RTK_LEVELS } from "../../transport/request/rtk/rtk-constants";
import { PONYTAIL_LEVELS } from "../../transport/request/rtk/ponytail-prompt";

export { RTK_LEVELS, PONYTAIL_LEVELS };

export interface RuntimeSettingsResponse {
  readonly redisBackendActual: RedisBackend;

  readonly tenantConcurrencyLimit: number | null;
  readonly thinkingNormalizationEnabled: boolean;
  readonly responsesReasoningSummary: ResponsesReasoningSummary;
  readonly telemetryPayloads: TelemetryPayloadMode;
  /** Capture depth for `full` mode; `minimum` when unset. */
  readonly telemetryPayloadDepth: TelemetryPayloadDepth;
  readonly privacyMode: PrivacyMode;
  /** Compacts bulky tool-result text before dispatch (RTK prune). Default false. */
  readonly rtkPruneEnabled: boolean;
  /** RTK strength when enabled; `full` by default. */
  readonly rtkPruneLevel: RtkLevel;
  /** PonyTail directive appended to system content. Default false. */
  readonly ponyTailEnabled: boolean;
  /** PonyTail directive intensity; `full` by default. */
  readonly ponyTailLevel: PonyTailLevel;
  /**
   * Ignores an account-wide cooldown when building route candidates. Off by
   * default: dialing a cooled-down account reproduces the refusal that parked
   * it, and can exhaust the candidate list. Overrides nothing else — the
   * cooldown is still recorded and still recovered by the sweep.
   */
  readonly forceDisableCooldown: boolean;
  /**
   * Stops every invoke and route for this tenant while on. The console stays
   * reachable so the switch can be turned back off from the UI that set it.
   */
  readonly invokeDisabled: boolean;
  /**
   * Slack above every key's concurrency limit; `null` means none. The
   * effective ceiling is `maxConcurrentRequests + concurrencyTolerance`.
   */
  readonly concurrencyTolerance: number | null;
  /** Per-tenant upstream request timeout in seconds; null means deployment default. */
  readonly upstreamTimeoutSeconds: number | null;
  /** Captured payload detail lifetime in minutes; null means deployment default. */
  readonly telemetryWindowMinutes: number | null;
  /** Per-tenant inline attachment ceiling in bytes; null means deployment default. */
  readonly imageClampMaxBytes: number | null;
  /**
   * Ordered vision-model ids used to describe images when the selected model
   * is not image-capable. Empty means the legacy `[image]` placeholder is
   * used instead.
   */
  readonly visionHandoffModels: readonly string[];
  readonly updatedAt: string;
  /*
   * What each `null` actually resolves to, in the same units the row stores.
   *
   * A row that says "Deployment default" without the number makes the operator
   * guess, and the guess is the one thing they cannot check from here: the
   * value lives in an env var on a server they are not looking at. Sent in the
   * same response rather than mirrored in the client, because a copied number
   * is right until someone changes the deployment — then it lies quietly.
   */
  readonly defaults: RuntimeSettingsDefaults;
}

/** The deployment-level values a `null` runtime setting falls back to. */
export interface RuntimeSettingsDefaults {
  /** Seconds; from `CARTETHYIA_UPSTREAM_TIMEOUT_MS`. */
  readonly upstreamTimeoutSeconds: number;
  /** Minutes; what the payload store expires frames after. */
  readonly telemetryWindowMinutes: number;
  /** Bytes; the inline attachment ceiling. */
  readonly imageClampMaxBytes: number;
  /** Days; how long raw event files are kept. */
  readonly telemetryRetentionDays: number;
}

/**
 * The runtime-settings PATCH body is exactly the persisted preferences bag:
 * same optional fields, same literal unions, same `number | null` concurrency
 * ceiling. Deriving it from `ConsoleSettingsPreferences` keeps the HTTP schema,
 * the operations-layer validator, and the JSONB shape one declaration instead
 * of three that drift independently.
 */
export type UpdateRuntimeSettingsRequest = ConsoleSettingsPreferences;

/** Persistence boundary for per-tenant runtime preferences. */
export interface RuntimeSettingsStore {
  get(tenantId: string): Promise<RuntimeSettingsResponse>;
  update(tenantId: string, patch: UpdateRuntimeSettingsRequest): Promise<RuntimeSettingsResponse>;
}



export interface RuntimeSettingsConfig {
  readonly store: RuntimeSettingsStore;
  readonly accessResolver: ConsoleAccessResolver;
  readonly auditSink?: AuditSink;
  /**
   * Structurally satisfied by `InMemoryRouteSnapshotService`.
   *
   * Two preferences here are read on the request path, not per request: the
   * route snapshot reads `forceDisableCooldown` when it builds candidates, and
   * the admission path reads `tenantConcurrencyLimit`. The snapshot is cached
   * until something invalidates it, so without this a saved setting stays
   * invisible to `/v1/*` until some unrelated console write happens to
   * invalidate — the toggle looks broken while the row is already correct.
   */
  readonly snapshotInvalidator?: { invalidate(): unknown };
}


export const RESPONSES_REASONING_SUMMARIES = ["auto", "concise", "detailed"] as const;
/** Reasoning-summary verbosity accepted for the Responses surface. */
export type ResponsesReasoningSummary = (typeof RESPONSES_REASONING_SUMMARIES)[number];
export const TELEMETRY_PAYLOAD_MODES = ["full", "metadata", "none"] as const;
/** Telemetry payload capture mode accepted by the runtime-settings PATCH. */
export type TelemetryPayloadMode = (typeof TELEMETRY_PAYLOAD_MODES)[number];
export const TELEMETRY_PAYLOAD_DEPTHS = ["minimum", "moderate", "maximum"] as const;
/** Capture depth for `full` mode accepted by the runtime-settings PATCH. */
export type TelemetryPayloadDepth = (typeof TELEMETRY_PAYLOAD_DEPTHS)[number];
export const PRIVACY_MODES = ["masked", "full"] as const;
/** Provider/model label privacy accepted by the runtime-settings PATCH. */
export type PrivacyMode = (typeof PRIVACY_MODES)[number];
/** PonyTail directive intensity accepted by the runtime-settings PATCH. */
export type PonyTailLevel = (typeof PONYTAIL_LEVELS)[number];
/** RTK prune strength accepted by the runtime-settings PATCH. */
export type RtkLevel = (typeof RTK_LEVELS)[number];

/** Upper bound on the number of ordered vision-handoff models. */
export const VISION_HANDOFF_MAX_MODELS = 8;

export function createRuntimeSettingsOperations(deps: RuntimeSettingsConfig) {
  const operations = {
    async get(access: AccessDecision | undefined): Promise<RuntimeSettingsResponse> {
        const a = requireTenantScope(access, "dashboard:read");
        return deps.store.get(a.tenantId);
      },
    async update(
        access: AccessDecision | undefined,
        patch: UpdateRuntimeSettingsRequest,
      ): Promise<RuntimeSettingsResponse> {
        const a = requireTenantScope(access, "dashboard:write");
        if (patch.tenantConcurrencyLimit !== undefined) {
          if (
            patch.tenantConcurrencyLimit !== null &&
            (!Number.isInteger(patch.tenantConcurrencyLimit) || patch.tenantConcurrencyLimit < 1)
          ) {
            throw new ConsoleDomainError(
              "invalid_request",
              400,
              "tenantConcurrencyLimit must be a positive integer or null",
            );
          }
        }
        if (
          patch.responsesReasoningSummary !== undefined &&
          !RESPONSES_REASONING_SUMMARIES.includes(patch.responsesReasoningSummary)
        ) {
          throw new ConsoleDomainError("invalid_request", 400, "Invalid responsesReasoningSummary");
        }
        if (patch.telemetryPayloads !== undefined && !TELEMETRY_PAYLOAD_MODES.includes(patch.telemetryPayloads)) {
          throw new ConsoleDomainError("invalid_request", 400, "Invalid telemetryPayloads");
        }
        if (patch.telemetryPayloadDepth !== undefined && !TELEMETRY_PAYLOAD_DEPTHS.includes(patch.telemetryPayloadDepth)) {
          throw new ConsoleDomainError("invalid_request", 400, "Invalid telemetryPayloadDepth");
        }
        if (patch.privacyMode !== undefined && !PRIVACY_MODES.includes(patch.privacyMode)) {
          throw new ConsoleDomainError("invalid_request", 400, "Invalid privacyMode");
        }
        if (
          patch.ponyTailLevel !== undefined &&
          patch.ponyTailLevel !== null &&
          !PONYTAIL_LEVELS.includes(patch.ponyTailLevel)
        ) {
          throw new ConsoleDomainError("invalid_request", 400, "Invalid ponyTailLevel");
        }
        if (patch.rtkPruneLevel !== undefined && !RTK_LEVELS.includes(patch.rtkPruneLevel)) {
          throw new ConsoleDomainError("invalid_request", 400, "Invalid rtkPruneLevel");
        }
        if (patch.visionHandoffModels !== undefined) {
          if (!Array.isArray(patch.visionHandoffModels)) {
            throw new ConsoleDomainError("invalid_request", 400, "visionHandoffModels must be an array of model ids");
          }
          if (patch.visionHandoffModels.length > VISION_HANDOFF_MAX_MODELS) {
            throw new ConsoleDomainError(
              "invalid_request",
              400,
              `visionHandoffModels may list at most ${VISION_HANDOFF_MAX_MODELS} models`,
            );
          }
          for (const model of patch.visionHandoffModels) {
            if (typeof model !== "string" || model.trim().length === 0) {
              throw new ConsoleDomainError("invalid_request", 400, "visionHandoffModels entries must be non-empty model ids");
            }
          }
        }
        const updated = await deps.store.update(a.tenantId, patch);
        await deps.auditSink?.record({
          access: a,
          action: "settings.runtime.updated",
          target: a.tenantId,
          detail: patch as Record<string, unknown>,
        });
        // Saved preferences are routing changes: `forceDisableCooldown` decides
        // candidate eligibility, `tenantConcurrencyLimit` decides admission, and
        // `invokeDisabled` decides whether the request is refused at all — all
        // three read from the cached route snapshot. Invalidate after the write
        // commits so the next `/v1/*` request uses them instead of the revision
        // that was built before the save. A failure here must not fail
        // the save — the row is already correct, and the snapshot rebuilds on
        // the next read anyway.
        await Promise.resolve(deps.snapshotInvalidator?.invalidate()).catch(() => undefined);
        return updated;
      },
  };
  return operations;
}

export function runtimeSettingsErrorResponse(error: unknown, set: { status?: number | string }) {
  return errorResponse(error, set, "Runtime settings operation failed", {
    detailsPolicy: "omit",
  });
}

export const runtimeUpdateBody = t.Object({
  responsesReasoningSummary: t.Optional(literalUnion(RESPONSES_REASONING_SUMMARIES)),
  telemetryPayloads: t.Optional(literalUnion(TELEMETRY_PAYLOAD_MODES)),
  telemetryPayloadDepth: t.Optional(literalUnion(TELEMETRY_PAYLOAD_DEPTHS)),
  privacyMode: t.Optional(literalUnion(PRIVACY_MODES)),
  tenantConcurrencyLimit: t.Optional(t.Union([t.Null(), t.Number()])),
  thinkingNormalizationEnabled: t.Optional(t.Boolean()),
  rtkPruneEnabled: t.Optional(t.Boolean()),
  rtkPruneLevel: t.Optional(literalUnion(RTK_LEVELS)),
  ponyTailEnabled: t.Optional(t.Boolean()),
  ponyTailLevel: t.Optional(literalUnion(PONYTAIL_LEVELS)),
  /*
   * Operational overrides. Every field a caller may patch must appear here:
   * this schema is what the route parses the body against, and a key it does
   * not name is dropped before the store sees it. These four were added to the
   * request type and the store but never to this object, so a save returned
   * 200 and changed nothing — the mutation's toast fired while the stored
   * value stayed put.
   *
   * `t.Null()` is what "Deployment default" sends, and it must survive:
   * clearing an override is a real edit, not an absent one.
   *
   * The bounds mirror the store's own normalizers, so an out-of-range value is
   * rejected here rather than silently clamped on the way in.
   */
  forceDisableCooldown: t.Optional(t.Boolean()),
  invokeDisabled: t.Optional(t.Boolean()),
  concurrencyTolerance: t.Optional(
    t.Union([t.Null(), t.Number({ minimum: 0, maximum: 1024 })]),
  ),
  upstreamTimeoutSeconds: t.Optional(
    t.Union([t.Null(), t.Number({ minimum: 5, maximum: 600 })]),
  ),
  telemetryWindowMinutes: t.Optional(
    t.Union([t.Null(), t.Number({ minimum: 1, maximum: 1440 })]),
  ),
  imageClampMaxBytes: t.Optional(
    t.Union([t.Null(), t.Number({ minimum: 64 * 1024, maximum: 100 * 1024 * 1024 })]),
  ),
  visionHandoffModels: t.Optional(t.Array(t.String())),
});
