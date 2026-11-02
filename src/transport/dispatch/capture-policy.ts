// Tenant payload-capture policy resolved once and shared by dispatch attempts.
import type { CartethyiaDatabase } from "../../persistence/db-handle";
import { resolvePayloadCapture } from "../../observability/payload-capture";
import type { TelemetryPayloadDepth, TelemetryPayloadMode } from "../../console/settings/contracts";

/** The resolved payload-capture preference, memoized on the request state. */
export type PayloadCapturePreference =
  | {
      readonly ok: true;
      readonly mode: TelemetryPayloadMode;
      readonly depth: TelemetryPayloadDepth;
      readonly retentionMs: number;
    }
  | { readonly ok: false };

/** The slice of request state that memoizes the capture preference. */
export type CapturePreferenceState = { payloadCapturePreference?: PayloadCapturePreference };

/** Resolves the tenant's capture preference once, memoized on the request state. */
async function resolveCapturePreference(
  db: CartethyiaDatabase,
  tenantId: string | null,
  state: CapturePreferenceState,
): Promise<PayloadCapturePreference> {
  let preference = state.payloadCapturePreference;
  if (preference === undefined) {
    preference = await resolvePayloadCapture(db, tenantId);
    state.payloadCapturePreference = preference;
  }
  return preference;
}

/** Per-stage body cap for the provider request/response tee. */
export function providerCaptureMaxBytes(depth?: TelemetryPayloadDepth): number {
  if (depth === "moderate") return 2 * 1024 * 1024;
  if (depth === "maximum") return 4 * 1024 * 1024;
  return 1024 * 1024;
}

/** Resolve whether provider bodies should be retained, memoized on this request. */
export async function shouldCaptureProviderBodyForRequest(
  db: CartethyiaDatabase,
  tenantId: string | null,
  state: CapturePreferenceState,
): Promise<boolean> {
  const resolved = await resolveCapturePreference(db, tenantId, state);
  return resolved.ok === true && resolved.mode === "full";
}

/** Resolve the tenant's capture mode once per request; failed reads fail closed. */
export async function resolveCaptureModeForRequest(
  db: CartethyiaDatabase,
  tenantId: string | null,
  state: CapturePreferenceState,
): Promise<TelemetryPayloadMode> {
  const resolved = await resolveCapturePreference(db, tenantId, state);
  return resolved.ok === true ? resolved.mode : "none";
}

/** Resolve the tenant's capture depth once per request. */
export async function resolveCaptureDepthForRequest(
  db: CartethyiaDatabase,
  tenantId: string | null,
  state: CapturePreferenceState,
): Promise<TelemetryPayloadDepth> {
  const resolved = await resolveCapturePreference(db, tenantId, state);
  return resolved.ok === true ? resolved.depth : "minimum";
}

/** Combined body cap for the four payload panels at one configured depth. */
export function captureDepthMaxBytes(depth: TelemetryPayloadDepth): number {
  if (depth === "moderate") return 8 * 1024 * 1024;
  if (depth === "maximum") return 16 * 1024 * 1024;
  return 1 * 1024 * 1024;
}
