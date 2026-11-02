// Drizzle-backed console persistence for runtime settings.
import { eq, sql } from "drizzle-orm";
import { mergeJson } from "../../persistence/dialect";
import type { CartethyiaDatabase } from "../../persistence/db-handle";
import { consoleSettings, type ConsoleSettingsPreferences } from "../../persistence/schema";
import type { RedisBackend } from "../../persistence/redis";
import { bumpSettingsRevision } from "../../persistence/settings-revision";
import { resolveTelemetryRetentionDays } from "../../config/telemetry";
import { resolveUpstreamTimeoutMs } from "../../config/timeouts";
import { payloadRetentionMs } from "../../observability/payload-capture";
import { IMAGE_CLAMP_MAX_BYTES } from "../../protocol/image-clamp";
import {
  PONYTAIL_LEVELS,
  RESPONSES_REASONING_SUMMARIES,
  RTK_LEVELS,
  TELEMETRY_PAYLOAD_DEPTHS,
  TELEMETRY_PAYLOAD_MODES,
  VISION_HANDOFF_MAX_MODELS,
  type PonyTailLevel,
  type ResponsesReasoningSummary,
  type RtkLevel,
  type RuntimeSettingsResponse,
  type RuntimeSettingsStore,
  type TelemetryPayloadDepth,
  type TelemetryPayloadMode,
  type UpdateRuntimeSettingsRequest,
} from "./contracts";

function isResponsesReasoningSummary(
  value: unknown,
): value is ResponsesReasoningSummary {
  return (
    typeof value === "string" && (RESPONSES_REASONING_SUMMARIES as readonly string[]).includes(value)
  );
}

function normalizePonyTailLevel(value: unknown): PonyTailLevel {
  return typeof value === "string" && (PONYTAIL_LEVELS as readonly string[]).includes(value)
    ? (value as PonyTailLevel)
    : "full";
}

function normalizeRtkLevel(value: unknown): RtkLevel {
  return typeof value === "string" && (RTK_LEVELS as readonly string[]).includes(value)
    ? (value as RtkLevel)
    : "full";
}

export function normalizeTelemetryPayloadMode(value: unknown): TelemetryPayloadMode {
  if (
    typeof value === "string" &&
    (TELEMETRY_PAYLOAD_MODES as readonly string[]).includes(value)
  ) {
    return value as TelemetryPayloadMode;
  }
  // Unset preference bags default to off. Capture is opt-in: a fresh install
  // keeps no payload until an operator turns it on, and then at minimum depth.
  return "none";
}

function normalizeTelemetryPayloadDepth(value: unknown): TelemetryPayloadDepth {
  if (
    typeof value === "string" &&
    (TELEMETRY_PAYLOAD_DEPTHS as readonly string[]).includes(value)
  ) {
    return value as TelemetryPayloadDepth;
  }
  // Legacy tier names from the short-lived medium/high/full scheme map onto
  // the size tiers; anything else defaults to minimum (1 MiB, light).
  if (value === "medium") return "minimum";
  if (value === "high") return "moderate";
  if (value === "full") return "maximum";
  return "minimum";
}

/**
 * Bounds a per-tenant numeric override, or `null` for "use the default".
 *
 * Clamped rather than rejected: these are operational knobs an operator tunes
 * live, and a PATCH that throws on an out-of-range value leaves them stuck at
 * whatever was stored. Clamping keeps the value inside the range the request
 * path can actually honour — the same range the deployment env var accepts.
 *
 * `null` (and every non-finite value) means "no override", which is distinct
 * from "override with zero".
 */
function normalizeBoundedNumber(value: unknown, min: number, max: number): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return null;
  // A value at or below zero is not a setting, it is a typo: clamping it to
  // the floor would silently give the request a 5-second budget when the
  // operator meant "no override". Non-positive therefore reads as absent.
  if (parsed <= 0) return null;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

/** Upstream timeout in seconds: 5 s floor, 600 s ceiling, matching the env var. */
function normalizeUpstreamTimeoutSeconds(value: unknown): number | null {
  return normalizeBoundedNumber(value, 5, 600);
}

/** Captured payload detail lifetime in minutes: 1 floor, one-day ceiling. */
function normalizeTelemetryWindowMinutes(value: unknown): number | null {
  return normalizeBoundedNumber(value, 1, 1440);
}

/** Inline attachment ceiling in bytes: 64 KB floor, 100 MB ceiling. */
function normalizeImageClampMaxBytes(value: unknown): number | null {
  return normalizeBoundedNumber(value, 64 * 1024, 100 * 1024 * 1024);
}

/** Concurrency slack: 0–1024, and `null`/absent means no allowance. */
function normalizeConcurrencyTolerance(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  return normalizeBoundedNumber(value, 0, 1024);
}

/** Ordered vision-handoff models: non-empty strings, trimmed, de-duplicated. */
function normalizeVisionHandoffModels(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const model = entry.trim();
    if (model.length === 0 || seen.has(model)) continue;
    seen.add(model);
    out.push(model);
    if (out.length >= VISION_HANDOFF_MAX_MODELS) break;
  }
  return out;
}

function mapRuntimeSettingsRow(
  row: typeof consoleSettings.$inferSelect | undefined,
  redisBackend: RedisBackend,
): RuntimeSettingsResponse {
  const updatedAt = row?.updatedAt.toISOString() ?? new Date(0).toISOString();
  const prefs = row?.preferences ?? {};
  return {
    redisBackendActual: redisBackend,
    tenantConcurrencyLimit: prefs.tenantConcurrencyLimit ?? null,
    thinkingNormalizationEnabled: prefs.thinkingNormalizationEnabled === true,
    responsesReasoningSummary: isResponsesReasoningSummary(prefs.responsesReasoningSummary)
      ? prefs.responsesReasoningSummary
      : "detailed",
    telemetryPayloads: normalizeTelemetryPayloadMode(prefs.telemetryPayloads),
    telemetryPayloadDepth: normalizeTelemetryPayloadDepth(prefs.telemetryPayloadDepth),
    privacyMode: prefs.privacyMode === "full" ? "full" : "masked",
    rtkPruneEnabled: prefs.rtkPruneEnabled === true,
    rtkPruneLevel: normalizeRtkLevel(prefs.rtkPruneLevel),
    // The enable flag is the only thing that turns the directive on, exactly as
    // RTK above works. `ponyTailLevel` selects the intensity and is kept while
    // the feature is off so a re-enable restores it, but a stored level is NOT
    // consent: the dashboard lets an operator choose a strength with the toggle
    // still off, which writes a level and no flag. Reading that as enabled
    // would report the directive as on while the dispatch gate — which requires
    // the flag — never injects it.
    ponyTailEnabled: prefs.ponyTailEnabled === true,
    ponyTailLevel: normalizePonyTailLevel(prefs.ponyTailLevel),
    forceDisableCooldown: prefs.forceDisableCooldown === true,
    invokeDisabled: prefs.invokeDisabled === true,
    concurrencyTolerance: normalizeConcurrencyTolerance(prefs.concurrencyTolerance),
    upstreamTimeoutSeconds: normalizeUpstreamTimeoutSeconds(prefs.upstreamTimeoutSeconds),
    telemetryWindowMinutes: normalizeTelemetryWindowMinutes(prefs.telemetryWindowMinutes),
    imageClampMaxBytes: normalizeImageClampMaxBytes(prefs.imageClampMaxBytes),
    visionHandoffModels: normalizeVisionHandoffModels(prefs.visionHandoffModels),
    updatedAt,
    /*
     * Resolved at request time, not at module load: all four come from env the
     * operator can change without rebuilding, and a cached value would keep
     * quoting a default the deployment no longer has.
     */
    defaults: {
      upstreamTimeoutSeconds: Math.round(resolveUpstreamTimeoutMs() / 1000),
      telemetryWindowMinutes: Math.round(payloadRetentionMs() / 60_000),
      imageClampMaxBytes: IMAGE_CLAMP_MAX_BYTES,
      telemetryRetentionDays: resolveTelemetryRetentionDays(),
    },
  };
}

export class DrizzleRuntimeSettingsStore implements RuntimeSettingsStore {
  constructor(
    private readonly db: CartethyiaDatabase,
    private readonly redisBackend: RedisBackend,
  ) {}

  async get(tenantId: string): Promise<RuntimeSettingsResponse> {
    const rows = await this.db
      .select()
      .from(consoleSettings)
      .where(eq(consoleSettings.tenantId, tenantId))
      .limit(1);
    return mapRuntimeSettingsRow(rows[0], this.redisBackend);
  }

  async update(
    tenantId: string,
    patch: UpdateRuntimeSettingsRequest,
  ): Promise<RuntimeSettingsResponse> {
    const now = new Date();
    const patchPrefs: ConsoleSettingsPreferences = {};
    if (patch.tenantConcurrencyLimit !== undefined)
      patchPrefs.tenantConcurrencyLimit = patch.tenantConcurrencyLimit;
    if (patch.thinkingNormalizationEnabled !== undefined)
      patchPrefs.thinkingNormalizationEnabled = patch.thinkingNormalizationEnabled;
    if (patch.responsesReasoningSummary !== undefined)
      patchPrefs.responsesReasoningSummary = patch.responsesReasoningSummary;
    if (patch.telemetryPayloads !== undefined) patchPrefs.telemetryPayloads = patch.telemetryPayloads;
    if (patch.telemetryPayloadDepth !== undefined) patchPrefs.telemetryPayloadDepth = patch.telemetryPayloadDepth;
    if (patch.privacyMode !== undefined) patchPrefs.privacyMode = patch.privacyMode;
    if (patch.rtkPruneEnabled !== undefined) patchPrefs.rtkPruneEnabled = patch.rtkPruneEnabled;
    if (patch.rtkPruneLevel !== undefined) patchPrefs.rtkPruneLevel = patch.rtkPruneLevel;
    if (patch.ponyTailEnabled !== undefined) patchPrefs.ponyTailEnabled = patch.ponyTailEnabled;
    if (patch.ponyTailLevel !== undefined) patchPrefs.ponyTailLevel = patch.ponyTailLevel;
    if (patch.forceDisableCooldown !== undefined)
      patchPrefs.forceDisableCooldown = patch.forceDisableCooldown === true;
    if (patch.invokeDisabled !== undefined)
      patchPrefs.invokeDisabled = patch.invokeDisabled === true;
    if (patch.concurrencyTolerance !== undefined)
      patchPrefs.concurrencyTolerance = normalizeConcurrencyTolerance(patch.concurrencyTolerance);
    if (patch.upstreamTimeoutSeconds !== undefined)
      patchPrefs.upstreamTimeoutSeconds = normalizeUpstreamTimeoutSeconds(patch.upstreamTimeoutSeconds);
    if (patch.telemetryWindowMinutes !== undefined)
      patchPrefs.telemetryWindowMinutes = normalizeTelemetryWindowMinutes(
        patch.telemetryWindowMinutes,
      );
    if (patch.imageClampMaxBytes !== undefined)
      patchPrefs.imageClampMaxBytes = normalizeImageClampMaxBytes(patch.imageClampMaxBytes);
    if (patch.visionHandoffModels !== undefined)
      patchPrefs.visionHandoffModels = normalizeVisionHandoffModels(patch.visionHandoffModels);

    const rows = await this.db
      .insert(consoleSettings)
      .values({ tenantId, preferences: patchPrefs, updatedAt: now })
      .onConflictDoUpdate({
        target: consoleSettings.tenantId,
        set: {
          // preferences, everything else on the row is left untouched.
          preferences: mergeJson(sql`${consoleSettings.preferences}`, sql`${JSON.stringify(patchPrefs)}`, this.db),
          updatedAt: now,
        },
      })
      .returning();
    bumpSettingsRevision();
    return mapRuntimeSettingsRow(rows[0], this.redisBackend);
  }
}
