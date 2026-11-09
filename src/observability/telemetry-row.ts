// Shared telemetry insert-row mapping: the single column spelling for both the
// write path (telemetry-buffer.ts) and the reconciliation backfill
// (telemetry-reconciliation.ts). Before this module existed the two paths kept
// hand-maintained mirrors that drifted — the backfill dropped creditUsed,
// resolveMs, tokensPerSec, firstContentDeltaAtMs, lastEventAtMs,
// payloadCaptureState, and degenerateStop, so a recovered row read as if those
// events never happened. One mapper means a column change lands in both paths.
import { telemetryEvents } from "../persistence/schema";
import { clientNameFromUserAgent } from "./client-name";

/**
 * A normalized telemetry event, shaped like the raw `TelemetryEventRecord` the
 * reconciliation job parses off disk. The write path normalizes its
 * `TelemetryEventInput` (nested `usage`, token-count coercion) into this shape
 * before calling {@link telemetryInsertRow}; the reconciliation path passes its
 * parsed record directly.
 */
export interface TelemetryInsertRowSource {
  readonly id: string;
  readonly tenantId: string;
  readonly requestId: string;
  readonly createdAt: Date | string;
  readonly sourceSurface: string | null;
  readonly requestedModel: string | null;
  readonly reportedModel: string | null;
  readonly requestedEffort: string | null;
  readonly providerId: string | null;
  readonly accountId: string | null;
  readonly networkPoolId: string | null;
  readonly endpoint: string | null;
  readonly apiKeyId: string | null;
  readonly userAgent: string | null;
  readonly clientIp: string | null;
  readonly latencyMs: number | null;
  readonly ttfbMs: number | null;
  readonly stream: boolean | null;
  readonly status: string | null;
  readonly httpStatus: number | null;
  readonly errorOrigin: string | null;
  readonly errorCategory: string | null;
  readonly inputTokens: number | null;
  readonly cachedInputTokens: number | null;
  readonly outputTokens: number | null;
  readonly reasoningTokens: number | null;
  readonly estimatedCostUsd: number | null;
  readonly creditUsed: number | null;
  readonly resolveMs: number | null;
  readonly tokensPerSec: number | null;
  readonly firstContentDeltaAtMs: number | null;
  readonly lastEventAtMs: number | null;
  /** Why the drawer payloads are empty, or `captured`; absent when unrecorded. */
  readonly payloadCaptureState?: string | null;
  /** `true` for a degenerate-stop request; absent/null for everything else. */
  readonly degenerateStop?: boolean;
}

/** Coerces a token count to the integer the schema columns store; `undefined` for an unavailable count. */
export function tokenCountToInt(value: number | "unavailable" | undefined): number | undefined {
  return typeof value === "number" ? Math.round(value) : undefined;
}

/**
 * Maps a normalized event to its `telemetry_events` insert row.
 *
 * Every column below has a live producer on the write path, and the
 * reconciliation backfill relies on this exact spelling to recover the same
 * columns from a raw line. Contract details that are load-bearing:
 *
 * - `id = requestId` is what makes the unique index a working idempotency
 *   boundary: a retry of the same request carries the same id.
 * - `estimatedCostUsd` persists NULL when the route is unpriced, never the
 *   text `"null"` — the analytics `partial` flag counts completed rows with no
 *   persisted cost.
 * - `creditUsed`/`tokensPerSec` use `!= null` so a measured zero is preserved
 *   (numeric columns are string-typed in Drizzle).
 * - `clientName` is derived here, once, via `clientNameFromUserAgent`, so the
 *   write path and the backfill group the same client the same way.
 */
export function telemetryInsertRow(event: TelemetryInsertRowSource): typeof telemetryEvents.$inferInsert {
  return {
    id: event.requestId,
    tenantId: event.tenantId,
    requestId: event.requestId,
    // Stamped here, not by the reader. A row without it has no real time, and a
    // reader that invented one made every such row look like it happened just now.
    createdAt: new Date(event.createdAt),
    sourceSurface: event.sourceSurface as typeof telemetryEvents.$inferInsert.sourceSurface,
    requestedModel: event.requestedModel,
    reportedModel: event.reportedModel,
    requestedEffort: event.requestedEffort,
    endpoint: event.endpoint,
    apiKeyId: event.apiKeyId,
    userAgent: event.userAgent,
    // Canonical client grouping, stamped once so SQL breakdowns group by it.
    clientName: clientNameFromUserAgent(event.userAgent),
    clientIp: event.clientIp,
    providerId: event.providerId,
    accountId: event.accountId,
    networkPoolId: event.networkPoolId,
    latencyMs: event.latencyMs,
    ttfbMs: event.ttfbMs,
    stream: event.stream,
    httpStatus: event.httpStatus,
    status: event.status as typeof telemetryEvents.$inferInsert.status,
    errorCategory: event.errorCategory,
    errorOrigin: event.errorOrigin,
    inputTokens: event.inputTokens,
    cachedInputTokens: event.cachedInputTokens,
    outputTokens: event.outputTokens,
    reasoningTokens: event.reasoningTokens,
    // `estimated_cost` is `null` when the route is unpriced; persist NULL so
    // the analytics `partial` flag can count it. `String(null)` would store the
    // text "null", which the numeric column rejects.
    estimatedCostUsd: event.estimatedCostUsd === null ? null : String(event.estimatedCostUsd),
    // Provider-billed credit (Tencent buddy-meter `credit`, Qoder `credits`);
    // NULL when the upstream reported no credit field.
    creditUsed: event.creditUsed != null ? String(event.creditUsed) : null,
    resolveMs: event.resolveMs,
    tokensPerSec: event.tokensPerSec != null ? String(event.tokensPerSec) : null,
    firstContentDeltaAtMs: event.firstContentDeltaAtMs,
    lastEventAtMs: event.lastEventAtMs,
    payloadCaptureState: event.payloadCaptureState ?? null,
    degenerateStop: event.degenerateStop ?? null,
  };
}
