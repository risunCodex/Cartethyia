import { join } from "node:path";
import { resolveDataDir } from "../persistence/db-mode";

/**
 * Per-request telemetry is mirrored to hourly JSONL files and the durable
 * `telemetry_events` table. This module is the shared home for the raw-file
 * directory constant and the raw record type; the canonical reader is
 * `event-query.ts` (SQL), and the reconciliation job (`telemetry-reconciliation.ts`)
 * replays the raw mirror. The file-based reader that once lived here is gone —
 * it was used only by tests and by this module itself.
 */

/**
 * Where raw hourly event files live.
 *
 * Resolved from the configured data directory, never relative to the working
 * directory: the gateway can be started from anywhere, and a relative path
 * makes the written history depend on where the operator happened to be —
 * start it from another folder and every past request reads as zero, because
 * the files were written somewhere else entirely.
 */
export const TELEMETRY_EVENT_DIR = join(resolveDataDir(), "telemetry-events");

export interface TelemetryEventRecord {
  readonly id: string;
  readonly createdAt: string;
  readonly tenantId?: string;
  readonly requestId: string;
  readonly sourceSurface: string | null;
  readonly requestedModel: string | null;
  /** The model the upstream named in its own response; null when it named none. */
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
  /**
   * True for a completed request whose output was far smaller than the model's
   * ceiling and which ended with an ordinary `stop` (a "degenerate stop").
   * NULL/unset for everything else.
   */
  readonly degenerateStop?: boolean;
}
