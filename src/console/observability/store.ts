import { loadavg, cpus, totalmem } from "node:os";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { CartethyiaDatabase } from "../../persistence/db-handle";
import type { RedisClient } from "../../persistence/redis";
import { apiKeys, networkPools, telemetryPayloads } from "../../persistence/schema";
import { type TelemetryEventRecord } from "../../observability/event-log";
import {
  breakdownTelemetry,
  chartTelemetry,
  queryTelemetryEvents as queryTelemetryEventPage,
  summarizeUsageWithPerformance,
} from "../../observability/event-query";
import { clientNameFromUserAgent } from "../../observability/client-name";

// Re-exported from the canonical module: ingestion (`telemetryEventRow`) and
// the backfill stamp the same value the console read side groups by, so the
// derivation cannot drift between writer and reader. Existing console
// imports of `clientNameFromUserAgent` keep working.
export { clientNameFromUserAgent };
import { cachedReadWithEtag, type CachedResult } from "../shared/read-through-cache";
import { decodeDatedCursor, encodeCursor, trimKeysetPage } from "../shared/cursor";
import { CARTETHYIA_VERSION } from "../../version";
import { CachedPreferencesReader, DrizzlePreferencesReader, type PreferencesReader } from "../../persistence/tenant-preferences";
import type {
  ObservabilityStore,
  UsageDimension,
  SystemHealthResponse,
  TelemetryEventView,
  TelemetryEventDetail,
  TelemetryEventListPage,
  UsageByResponse,
  UsageCacheResponse,
  UsageChartBucket,
  UsageChartResponse,
  UsageRequestDetail,
  UsageRequestItem,
  UsageRequestsResponse,
  UsageResponse,
  UsageSummaryResponse,
} from "./contracts";
import { maskClientIp } from "../../observability/redaction";
import { splitEndpointConfig } from "../../network/pool/agent";
import { resolveDbMode } from "../../persistence/db-mode";
import { payloadReferenceFromRow, readPayloadFrame } from "../../observability/payload-store";
import { shouldMaskClientIp } from "../shared/ip-privacy";

function mapTelemetryEventRow(event: TelemetryEventRecord): TelemetryEventView {
  return {
    id: event.id,
    createdAt: event.createdAt,
    tenantId: event.tenantId ?? "",
    requestId: event.requestId,
    ...(event.sourceSurface ? { sourceSurface: event.sourceSurface } : {}),
    ...(event.requestedModel ? { requestedModel: event.requestedModel } : {}),
    ...(event.reportedModel ? { reportedModel: event.reportedModel } : {}),
    ...(event.providerId ? { providerId: event.providerId } : {}),
    ...(event.latencyMs !== null ? { latencyMs: event.latencyMs ?? undefined } : {}),
    ...(event.status ? { status: event.status } : {}),
    ...(event.inputTokens !== null ? { inputTokens: event.inputTokens ?? undefined } : {}),
    ...(event.outputTokens !== null ? { outputTokens: event.outputTokens ?? undefined } : {}),
    ...(event.estimatedCostUsd !== null
      ? { estimatedCost: Number(event.estimatedCostUsd ?? 0) }
      : {}),
    ...(event.tokensPerSec !== null ? { tokensPerSec: Number(event.tokensPerSec) } : {}),
    ...(event.firstContentDeltaAtMs !== null ? { firstContentDeltaAtMs: event.firstContentDeltaAtMs } : {}),
    ...(event.lastEventAtMs !== null ? { lastEventAtMs: event.lastEventAtMs } : {}),
  };
}
/** The HTTP status a row renders as when the wire status was never recorded. */
function effectiveHttpStatus(event: TelemetryEventRecord): number {
  if (event.httpStatus !== null) return event.httpStatus;
  if (event.status === "completed") return 200;
  if (event.status === "cancelled") return 499;
  if (event.status === "truncated") return 502;
  return 500;
}

/**
 * Opaque, monotonic (createdAt, id) cursor. `createdAt` alone is not unique
 * — two telemetry events in the same millisecond would silently skip one
 * row across pages — so we tie-break on id and encode both, matching
 * `DrizzleAuditReadStore`'s cursor.
 */

/** Resolves a `usage` period token ("24h", "7d", "30d", "all") to its inclusive start date. */
function periodStartDate(period: string): Date | undefined {
  const match = /^(\d+)([hd])$/.exec(period);
  if (!match) return undefined;
  const amount = Number(match[1]);
  const unitMs = match[2] === "h" ? 3_600_000 : 86_400_000;
  return new Date(Date.now() - amount * unitMs);
}

/** Time-series bucket width for the usage chart, chosen from the window length. */
function chartBucketSeconds(period: string): number {
  const since = periodStartDate(period);
  if (!since) return 86_400;
  const windowMs = Date.now() - since.getTime();
  if (windowMs <= 2 * 3_600_000) return 300;
  if (windowMs <= 2 * 86_400_000) return 3_600;
  if (windowMs <= 10 * 86_400_000) return 21_600;
  return 86_400;
}

/**
 * The model id with the client's requested reasoning effort as a display
 * suffix — only when the request actually carried one.
 */
function modelWithEffort(event: TelemetryEventRecord): string | undefined {
  const model = event.requestedModel;
  if (!model) return undefined;
  return event.requestedEffort ? `${model} (${event.requestedEffort})` : model;
}

function mapUsageRequestItem(
  event: TelemetryEventRecord,
  hideClientIp: boolean,
): UsageRequestItem {
  const input = event.inputTokens ?? 0;
  const output = event.outputTokens ?? 0;
  return {
    requestId: event.requestId,
    ...(event.sourceSurface ? { surface: event.sourceSurface } : {}),
    ...(event.providerId ? { providerId: event.providerId } : {}),
    ...(event.accountId ? { accountId: event.accountId } : {}),
    ...(modelWithEffort(event) === undefined ? {} : { model: modelWithEffort(event) as string }),
    ...(event.reportedModel ? { reportedModel: event.reportedModel } : {}),
    status: event.status ?? "unknown",
    ...(event.errorCategory ? { errorKind: event.errorCategory } : {}),
    ...(event.errorOrigin ? { errorOrigin: event.errorOrigin } : {}),
    httpStatus: effectiveHttpStatus(event),
    mode: event.stream ? "stream" : "non_stream",
    startedAt: event.createdAt,
    ...(event.latencyMs !== null ? { durationMs: event.latencyMs ?? undefined } : {}),
    ...(event.inputTokens !== null ? { inputTokens: event.inputTokens ?? undefined } : {}),
    ...(event.outputTokens !== null ? { outputTokens: event.outputTokens ?? undefined } : {}),
    ...(event.cachedInputTokens !== null
      ? { cachedTokens: event.cachedInputTokens ?? undefined }
      : {}),
    ...(event.reasoningTokens !== null
      ? { reasoningTokens: event.reasoningTokens ?? undefined }
      : {}),
    ...(event.endpoint ? { endpoint: event.endpoint } : {}),
    ...(event.apiKeyId ? { apiKeyId: event.apiKeyId } : {}),
    ...(event.networkPoolId ? { networkPoolId: event.networkPoolId } : {}),
    ...(event.userAgent ? { userAgent: event.userAgent } : {}),
    ...(event.userAgent ? { clientName: clientNameFromUserAgent(event.userAgent) } : {}),
    ...(event.clientIp
      ? { clientIp: hideClientIp ? maskClientIp(event.clientIp) : event.clientIp }
      : {}),
    ...(input + output > 0 ? { totalTokens: input + output } : {}),
    ...(event.ttfbMs !== null ? { ttfbMs: event.ttfbMs ?? undefined } : {}),
    ...(event.tokensPerSec !== null ? { tokensPerSec: Number(event.tokensPerSec) } : {}),
    ...(event.firstContentDeltaAtMs !== null ? { firstContentDeltaAtMs: event.firstContentDeltaAtMs } : {}),
    ...(event.lastEventAtMs !== null ? { lastEventAtMs: event.lastEventAtMs } : {}),
    ...(event.estimatedCostUsd !== null && event.estimatedCostUsd !== undefined
      ? { estimatedCost: Number(event.estimatedCostUsd) }
      : {}),
    ...(event.creditUsed !== null && event.creditUsed !== undefined
      ? { creditUsed: Number(event.creditUsed) }
      : {}),
    ...(event.resolveMs !== null && event.resolveMs !== undefined
      ? { resolveMs: event.resolveMs }
      : {}),
    // Why the drawer is empty for this request — see the contract field. This is
    // what makes the blank panels diagnosable without server logs.
    ...(event.payloadCaptureState ? { payloadCaptureState: event.payloadCaptureState } : {}),
  };
}
async function resolveProxyLabel(
  db: CartethyiaDatabase,
  tenantId: string,
  poolId: string,
): Promise<string> {
  const rows = await db
    .select({ id: networkPools.id, endpointConfig: networkPools.endpointConfig })
    .from(networkPools)
    .where(and(eq(networkPools.id, poolId), eq(networkPools.tenantId, tenantId)))
    .limit(1);
  const row = rows[0];
  if (!row) return `${poolId.slice(0, 8)}…`;
  const { endpoint, label } = splitEndpointConfig((row.endpointConfig ?? {}) as Record<string, unknown>);
  return label ?? endpoint ?? `${poolId.slice(0, 8)}…`;
}
const HEALTH_WINDOW_MS = 24 * 3_600_000;
const TOP_N = 50;
/**
 * TTL for the usage analytics read-through (summary, chart, breakdown, totals).
 * The dashboard polls these every 5–10s; a 30s TTL means the heavy telemetry
 * window scans run once per 30s and the polls in between are answered from
 * Redis (or the in-process fallback) with a `304`. Health stays on the
 * default 10s — it feeds the live status tile.
 */
const USAGE_READ_THROUGH_TTL_SECONDS = 30;

/**
 * Nearest-rank percentile over a sorted array — kept for the JS-side
 * `summarizeUsagePerformance` (still used by callers that already hold a
 * bounded event list). The usage endpoints read percentiles from SQL via
 * `summarizeUsagePerformanceSql`, which is what the dashboard polls.
 */
function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return Math.round(sorted[index] ?? 0);
}

export interface UsagePerformanceSummary {
  avgResolveMs: number;
  avgDurationMs: number;
  latencyP50Ms: number;
  latencyP95Ms: number;
  latencyP99Ms: number;
  /** Events each series was computed from; see `UsageSummaryTotals`. */
  latencySampleCount: number;
  resolveSampleCount: number;
}

/** Summarizes routing delay and request latency for an already-filtered period. */
export function summarizeUsagePerformance(
  events: readonly Pick<TelemetryEventRecord, "latencyMs" | "resolveMs">[],
): UsagePerformanceSummary {
  const latencies: number[] = [];
  let latencySum = 0;
  let resolveSum = 0;
  let resolveCount = 0;
  for (const event of events) {
    if (event.latencyMs !== null) {
      latencies.push(event.latencyMs);
      latencySum += event.latencyMs;
    }
    if (event.resolveMs !== null) {
      resolveSum += event.resolveMs;
      resolveCount += 1;
    }
  }
  latencies.sort((a, b) => a - b);
  return {
    avgResolveMs: resolveCount > 0 ? resolveSum / resolveCount : 0,
    avgDurationMs: latencies.length > 0 ? latencySum / latencies.length : 0,
    latencyP50Ms: percentile(latencies, 0.5),
    latencyP95Ms: percentile(latencies, 0.95),
    latencyP99Ms: percentile(latencies, 0.99),
    latencySampleCount: latencies.length,
    resolveSampleCount: resolveCount,
  };
}

/**
 * The console dimension as the SQL reader's grouping key.
 *
 * `client` maps to `client_name` (stamped at ingestion) rather than
 * `user_agent`: the grouping is now a plain GROUP BY on a column the writer
 * filled, instead of a per-row `clientNameFromUserAgent` call in JavaScript.
 */
function breakdownDimension(dimension: UsageDimension): string {
  if (dimension === "model") return "model";
  if (dimension === "key") return "api_key";
  if (dimension === "client") return "client";
  if (dimension === "client_ip") return "client_ip";
  return "provider";
}

/** Real Drizzle-backed observability repository used by the production console. */
export class DrizzleObservabilityStore implements ObservabilityStore {
  constructor(
    private readonly db: CartethyiaDatabase,
    private readonly redis: RedisClient | undefined,
    /**
     * Tenant preferences, revision-cached. The Usage page reads the privacy
     * gate on the list, detail and breakdown paths, so a direct SELECT here
     * re-read the same row per request; the cache collapses that.
     */
    private readonly preferences: PreferencesReader = new CachedPreferencesReader(
      new DrizzlePreferencesReader(db),
    ),
  ) {}

  async health(tenantId: string): Promise<CachedResult<SystemHealthResponse>> {
    // Cached like its siblings: reading this directly re-parses 24 hourly files
    // every page load. Same 10 s TTL as `/system/usage`.
    return this.readThroughWithEtag(
      this.usageCacheKey(tenantId, "24h", "health"),
      () => this.computeHealth(tenantId),
    );
  }

  /**
   * Same two numbers `computeHealth` reports, read fresh.
   *
   * Deliberately not `computeHealth`: that also scans 24 h of telemetry files,
   * which is exactly the cost the cache exists to avoid, and a memory watcher
   * polling every 10 s must not pay it. Kept in the store so the percentage
   * has one definition rather than two.
   */
  async liveMemory(): Promise<{ memory_bytes: number; memory_percent: number }> {
    const memory = process.memoryUsage();
    return {
      memory_bytes: memory.rss,
      memory_percent: Math.round((memory.rss / Math.max(totalmem(), 1)) * 10000) / 100,
    };
  }

  private async computeHealth(tenantId: string): Promise<SystemHealthResponse> {
    const memory = process.memoryUsage();
    // `loadavg()` is [0, 0, 0] on every Windows build — there is no such
    // syscall and Node reports a zeroed tuple rather than failing. Divided by
    // cores that is a confident-looking 0.0% on a busy gateway, which is worse
    // than saying nothing: an operator reads it as "idle" and stops looking.
    // Reported as null instead of as a measurement.
    //
    // A real zero load is *not* the same thing and is reported as zero: an
    // idle machine genuinely has nothing queued, and collapsing that into
    // "unavailable" would hide a number the platform did supply.
    const cpuPercent: number | null =
      process.platform === "win32"
        ? null
        : Math.round(((loadavg()[0] ?? 0) / Math.max(cpus().length, 1)) * 10000) / 100;

    let databaseHealthy = true;
    let total = 0;
    let errors = 0;
    let avg = 0;
    let p95 = 0;
    let p99 = 0;
    let cacheHitRate = 0;
    let avgTokensPerSec = 0;
    try {
      // Bounded 24h rolling window (matches the Overview copy), computed IN
      // SQL. The previous shape materialized every retained event into a
      // latency array and sorted it in JavaScript — the single largest read
      // cost on the dashboard. `healthTelemetry` returns the totals and the
      // database computes the percentiles.
      const since = new Date(Date.now() - HEALTH_WINDOW_MS);
      const { summary: totals, performance } = await summarizeUsageWithPerformance(this.db, tenantId, since);
      total = totals.requests;
      errors = totals.errors;
      avg = Math.round(performance.avgDurationMs ?? 0);
      p95 = performance.latencyP95Ms ?? 0;
      p99 = performance.latencyP99Ms ?? 0;
      const inputTokens = totals.inputTokens;
      const cachedTokens = totals.cachedInputTokens;
      // Cached share of the prompt: cached/input, the same honest definition
      // usageSummary uses, so the health card and the Usage page cannot
      // disagree. (Cached share, not prompt share: input/(input+output) reads
      // ~99% and mislabels it a cache hit rate.)
      cacheHitRate = inputTokens > 0 ? Math.round((cachedTokens / inputTokens) * 10000) / 100 : 0;
      avgTokensPerSec = performance.avgTokensPerSec;
    } catch {
      databaseHealthy = false;
    }

    // No client means the memory backend, which is healthy by construction.
    let redisHealthy = this.redis === undefined;
    if (this.redis !== undefined) {
      try {
        redisHealthy = (await this.redis.ping()) === "PONG";
      } catch {
        redisHealthy = false;
      }
    }

    const status: SystemHealthResponse["status"] = !databaseHealthy
      ? "unhealthy"
      : !redisHealthy
        ? "degraded"
        : "healthy";

    return {
      version: CARTETHYIA_VERSION,
      status,
      uptime_seconds: Math.floor(process.uptime()),
      database_healthy: databaseHealthy,
      redis_healthy: redisHealthy,
      redis_configured: this.redis !== undefined,
      memory_heap_bytes: memory.heapUsed,
      memory_external_bytes: memory.external,
      memory_bytes: memory.rss,
      memory_percent: Math.round((memory.rss / Math.max(totalmem(), 1)) * 10000) / 100,
      // Reported so the console can explain a large RSS instead of leaving the
      // operator to read it as the gateway alone. In lite mode this process
      // hosts the database too, so the resident set covers both.
      database_in_process: resolveDbMode() === "lite",
      cpu_percent: cpuPercent,
      cpu_cores: cpus().length,
      pid: process.pid,
      platform: `Bun ${Bun.version} · ${process.platform}`,
      request_count: total,
      error_count: errors,
      latency_avg_ms: avg,
      latency_p95_ms: p95,
      latency_p99_ms: p99,
      cache_hit_rate_percent: cacheHitRate,
      avg_tokens_per_sec: avgTokensPerSec,
    };
  }
  async usage(tenantId: string, period: string): Promise<CachedResult<UsageResponse>> {
    return this.readThroughWithEtag(this.usageCacheKey(tenantId, period, "usage"), () =>
      this.computeUsage(tenantId, period),
    USAGE_READ_THROUGH_TTL_SECONDS,
    );
  }

  /**
   * Cache key for one usage response. Versioned so a shape change can never be
   * read back from a deployment that still holds the old one.
   */
  private usageCacheKey(tenantId: string, period: string, shape: string): string {
    return `cartethyia:usage:v1:${shape}:${tenantId}:${period}`;
  }

  /**
   * Reads a usage response through Redis — computing when no cache is
   * configured — and returns the strong validator alongside it, so a repeated
   * poll can be answered with a `304` instead of the whole payload.
   */
  private readThroughWithEtag<T>(
    key: string,
    compute: () => Promise<T>,
    ttlSeconds?: number,
  ): Promise<CachedResult<T>> {
    return cachedReadWithEtag(this.redis, key, compute, ttlSeconds);
  }

  private async computeUsage(tenantId: string, period: string): Promise<UsageResponse> {
    const since = this.periodSince(period);
    // Totals AND the top-model/top-provider counts come from SQL: the old
    // shape parsed the whole retained window into an array to count two
    // dimensions in JavaScript.
    const [{ summary }, models, providers] = await Promise.all([
      summarizeUsageWithPerformance(this.db, tenantId, since),
      breakdownTelemetry(this.db, tenantId, "model", since),
      breakdownTelemetry(this.db, tenantId, "provider", since),
    ]);
    const requestsTotal = summary.requests;
    // `completed` is a lifecycle status, not the gateway-error predicate: it
    // is derived as requests minus the errors and the non-completed states the
    // summary already counts.
    const requestsFailed = summary.errors;
    const requestsSucceeded = Math.max(0, requestsTotal - requestsFailed - summary.cancelled - summary.truncated);
    const tokensUsed = summary.inputTokens + summary.outputTokens;
    const estimatedCost = summary.estimatedCostUsd;
    return {
      tenantId,
      period,
      requestsTotal,
      requestsSucceeded,
      requestsFailed,
      tokensUsed,
      estimatedCost,
      topModels: models
        .slice(0, TOP_N)
        .map((group) => ({ modelId: group.key, count: group.requests })),
      topProviders: providers
        .slice(0, TOP_N)
        .map((group) => ({ providerId: group.key, count: group.requests })),
    };
  }

  /**
   * The retained window for one usage period.
   *
   * `all` means the retained SQL window (the database's own retention), not
   * "read every file ever written": `telemetry_events` is pruned by the same
   * retention rule as the raw files, so the SQL store already holds exactly
   * what a period can show.
   */
  private periodSince(period: string): Date {
    return periodStartDate(period) ?? new Date(0);
  }

  async usageSummary(tenantId: string, period: string): Promise<CachedResult<UsageSummaryResponse>> {
    return this.readThroughWithEtag(this.usageCacheKey(tenantId, period, "summary"), () =>
      this.computeSummary(tenantId, period),
    USAGE_READ_THROUGH_TTL_SECONDS,
    );
  }

  private async computeSummary(tenantId: string, period: string): Promise<UsageSummaryResponse> {
    const since = this.periodSince(period);
    // Totals, status breakdown, and latency percentiles all computed in SQL.
    // The summary totals and performance figures come from ONE combined window
    // scan (one percentile pass), not two independent scans.
    const [{ summary, performance }, statuses] = await Promise.all([
      summarizeUsageWithPerformance(this.db, tenantId, since),
      breakdownTelemetry(this.db, tenantId, "status", since),
    ]);
    const inputTokens = summary.inputTokens;
    const cachedTokens = summary.cachedInputTokens;
    return {
      period,
      totals: {
        statusCounts: statuses
          .map((group) => ({ status: Number(group.key), count: group.requests }))
          .filter((entry) => Number.isFinite(entry.status))
          .sort((a, b) => a.status - b.status),
        requests: summary.requests,
        inputTokens,
        cachedTokens,
        outputTokens: summary.outputTokens,
        errors: summary.errors,
        cancelled: summary.cancelled,
        truncated: summary.truncated,
        ...performance,
        estimatedCostUsd: summary.estimatedCostUsd,
        partial: summary.unpriced > 0,
        cacheHitRate: inputTokens > 0 ? (cachedTokens / inputTokens) * 100 : 0,
        avgTokensPerSec: performance.avgTokensPerSec,
      },
    };
  }

  async usageChart(tenantId: string, period: string): Promise<CachedResult<UsageChartResponse>> {
    return this.readThroughWithEtag(this.usageCacheKey(tenantId, period, "chart"), () =>
      this.computeChart(tenantId, period),
    USAGE_READ_THROUGH_TTL_SECONDS,
    );
  }

  private async computeChart(tenantId: string, period: string): Promise<UsageChartResponse> {
    const since = periodStartDate(period);
    const bucketSeconds = chartBucketSeconds(period);
    const stepMs = bucketSeconds * 1000;
    // Bucketing happens in SQL. The old shape parsed the retained window to
    // floor every event's timestamp into a JS Map.
    const buckets = await chartTelemetry(
      this.db,
      tenantId,
      this.periodSince(period),
      bucketSeconds,
      );
    const byTime = new Map<number, UsageChartBucket>();
    for (const bucket of buckets) {
      byTime.set(bucket.at, {
        t: new Date(bucket.at).toISOString(),
        requests: bucket.requests,
        input: bucket.inputTokens,
        // `cached` is the cached share of the prompt: the SQL reader sums
        // cached_input_tokens, which is the same number the old JS loop used.
        cached: bucket.inputTokens,
        output: bucket.outputTokens,
      });
    }
    const first = buckets.length > 0 ? buckets[0]!.at : undefined;
    const startMs = since ? since.getTime() : first;
    if (startMs === undefined) return { buckets: [] };
    const aligned = Math.floor(startMs / stepMs) * stepMs;
    const out: UsageChartBucket[] = [];
    for (let at = aligned; at <= Date.now(); at += stepMs) {
      out.push(
        byTime.get(at) ?? { t: new Date(at).toISOString(), requests: 0, input: 0, cached: 0, output: 0 },
      );
    }
    return { buckets: out };
  }

  async usageBy(
    tenantId: string,
    dimension: UsageDimension,
    period: string,
  ): Promise<CachedResult<UsageByResponse>> {
    return this.readThroughWithEtag(this.usageCacheKey(tenantId, `${dimension}:${period}`, "by"), () =>
      this.computeBy(tenantId, dimension, period),
    USAGE_READ_THROUGH_TTL_SECONDS,
    );
  }

  private async computeBy(
    tenantId: string,
    dimension: UsageDimension,
    period: string,
  ): Promise<UsageByResponse> {
    // Grouping happens in SQL and only the (bounded) groups come back. The
    // old shape walked every retained event to accumulate a JS Map per
    // dimension; `client` now groups on the ingestion-stamped `client_name`
    // instead of re-deriving a name per row.
    const groups = await breakdownTelemetry(
      this.db,
      tenantId,
      breakdownDimension(dimension),
      this.periodSince(period),
    );
    const mapped = groups
      .map((group) => {
        const input = group.inputTokens;
        const output = group.outputTokens;
        return {
          name: group.key,
          requests: group.requests,
          input,
          output,
          cached: group.cachedInputTokens,
          total: input + output,
          errors: group.errors,
          costUsd: group.costUsd,
          cacheHitRate: input > 0 ? (group.cachedInputTokens / input) * 100 : 0,
          avgTokensPerSec: group.avgTokensPerSec,
        };
      })
      .sort((a, b) => b.requests - a.requests)
      .slice(0, 100);
    if (dimension === "client_ip") {
      // Same fail-closed gate as the request list: storage keeps the raw
      // address, only presentation masks it.
      const hideClientIp = await shouldMaskClientIp(this.preferences, tenantId);
      if (!hideClientIp) return { dimension, rows: mapped };
      // Grouping happened on the raw address, so masking can collapse distinct
      // hosts into one display name (`203.0.113.7` and `203.0.113.9` both become
      // `203.0.113.xxx`). Re-aggregate by the masked name: two rows the operator
      // cannot tell apart are one row, and the totals must not be understated.
      const merged = new Map<string, (typeof mapped)[number]>();
      for (const row of mapped) {
        const masked = maskClientIp(row.name);
        const existing = merged.get(masked);
        if (existing === undefined) {
          merged.set(masked, { ...row, name: masked });
          continue;
        }
        const input = existing.input + row.input;
        const output = existing.output + row.output;
        merged.set(masked, {
          ...existing,
          requests: existing.requests + row.requests,
          input,
          output,
          cached: existing.cached + row.cached,
          total: input + output,
          errors: existing.errors + row.errors,
          costUsd:
            existing.costUsd === null && row.costUsd === null
              ? null
              : (existing.costUsd ?? 0) + (row.costUsd ?? 0),
          cacheHitRate: input > 0 ? (existing.cached + row.cached) / input * 100 : 0,
        });
      }
      return {
        dimension,
        rows: [...merged.values()].sort((a, b) => b.requests - a.requests),
      };
    }
    if (dimension !== "key") return { dimension, rows: mapped };
    const ids = [...new Set(mapped.map((row) => row.name))];
    const labels = ids.length > 0 ? await this.apiKeyLabels(tenantId, ids) : new Map<string, string>();
    return {
      dimension,
      rows: mapped.map((row) => {
        const label = labels.get(row.name);
        return label === undefined ? row : { ...row, label };
      }),
    };
  }

  private async apiKeyLabels(tenantId: string, ids: readonly string[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map<string, string>();
    const keyRows = await this.db
      .select({ id: apiKeys.id, label: apiKeys.label })
      .from(apiKeys)
      .where(and(inArray(apiKeys.id, [...unique]), eq(apiKeys.tenantId, tenantId)));
    return new Map(keyRows.map((keyRow) => [keyRow.id, keyRow.label] as const));
  }

  async usageCache(tenantId: string, period: string): Promise<CachedResult<UsageCacheResponse>> {
    return this.readThroughWithEtag(this.usageCacheKey(tenantId, period, "cache"), () =>
      this.computeCache(tenantId, period),
    );
  }

  private async computeCache(tenantId: string, period: string): Promise<UsageCacheResponse> {
    const { summary } = await summarizeUsageWithPerformance(this.db, tenantId, this.periodSince(period));
    const inputTokens = summary.inputTokens;
    const outputTokens = summary.outputTokens;
    const cachedTokens = summary.cachedInputTokens;
    const tokenTotal = inputTokens + outputTokens;
    return {
      period,
      inputTokens,
      cachedTokens,
      cacheWriteTokens: 0,
      hitRate: tokenTotal > 0 ? (cachedTokens / tokenTotal) * 100 : 0,
    };
  }

  async usageRequests(
    tenantId: string,
    period: string,
    limit: number,
    httpStatus?: number,
  ): Promise<CachedResult<UsageRequestsResponse>> {
    const hideClientIp = await shouldMaskClientIp(this.preferences, tenantId);
    // Cached like its siblings, so a repeated poll costs a `304` instead of
    // another read. The mask flag is part of the key: it is a privacy setting,
    // so a page must never be served from an entry computed under the other
    // value.
    //
    // The telemetry read moved INSIDE the read-through: it used to run before
    // it, so every 304 still paid a query. Now a cache hit costs nothing at
    // all, and a miss pays one bounded SQL page (keyset, newest first) rather
    // than a scan of the raw window.
    return this.readThroughWithEtag(
      this.usageCacheKey(
        tenantId,
        `${period}:${limit}:${httpStatus ?? "*"}:${hideClientIp}`,
        "requests",
      ),
      async () => {
        const page = await queryTelemetryEventPage(this.db, {
          tenantId,
          since: this.periodSince(period),
          limit,
          ...(httpStatus === undefined ? {} : { httpStatus }),
        });
        const rows = page.events.slice(0, limit);
        const keyIds = [...new Set(rows.map((row) => row.apiKeyId).filter((id): id is string => id !== null))];
        const labels = await this.apiKeyLabels(tenantId, keyIds);
        // One indexed read for the whole page, not one per row: presence lives
        // on the payload row so the list can render it without inflating a
        // frame for every row it shows.
        const requestIds = [...new Set(rows.map((row) => row.requestId).filter((id): id is string => id !== null))];
        const stages = await this.payloadStages(tenantId, requestIds);
        return {
          items: rows.map((row) => {
            const item = mapUsageRequestItem(row, hideClientIp);
            const label = row.apiKeyId ? labels.get(row.apiKeyId) : undefined;
            const labeled = label === undefined ? item : { ...item, apiKeyLabel: label };
            const stage = stages.get(row.requestId);
            // Omitted rather than zero when the row is unknown: absence means
            // "no payload was captured", and 0 would say the same thing while
            // claiming it had been measured.
            return stage === undefined ? labeled : { ...labeled, payloadStages: stage };
          }),
        };
      },
    );
  }

  /**
   * Captured-stage bitmask per request, newest payload row winning.
   * One indexed read for a whole page. Presence is on the payload row
   * specifically so the list never has to inflate a frame to answer "does this
   * panel have content".
   */
  private async payloadStages(tenantId: string, requestIds: readonly string[]): Promise<Map<string, number>> {
    if (requestIds.length === 0) return new Map();
    const rows = await this.db
      .select({ requestId: telemetryPayloads.requestId, stages: telemetryPayloads.stages })
      .from(telemetryPayloads)
      .where(
        and(
          eq(telemetryPayloads.tenantId, tenantId),
          inArray(telemetryPayloads.requestId, [...requestIds]),
        ),
      )
      .orderBy(desc(telemetryPayloads.capturedAt));
    const byRequest = new Map<string, number>();
    for (const row of rows) {
      if (row.requestId === null || row.stages === null) continue;
      // Ordered newest-first, so the first hit is the one the drawer reads.
      if (!byRequest.has(row.requestId)) byRequest.set(row.requestId, row.stages);
    }
    return byRequest;
  }

  async usageRequestDetail(
    tenantId: string,
    requestId: string,
  ): Promise<UsageRequestDetail | undefined> {
    const page = await queryTelemetryEventPage(this.db, { tenantId, requestId });
    const event = page.events[0];
    if (!event) return undefined;
    // The label, proxy, and mask lookups are independent: run them together
    // instead of three sequential round trips.
    const [hideClientIp, keyLabels, proxy] = await Promise.all([
      shouldMaskClientIp(this.preferences, tenantId),
      event.apiKeyId ? this.apiKeyLabels(tenantId, [event.apiKeyId]) : undefined,
      event.networkPoolId ? resolveProxyLabel(this.db, tenantId, event.networkPoolId) : ("direct" as const),
    ]);
    const item = mapUsageRequestItem(event, hideClientIp);
    const keyLabel = event.apiKeyId ? keyLabels?.get(event.apiKeyId) : undefined;
    const labeled = keyLabel === undefined ? item : { ...item, apiKeyLabel: keyLabel };
    const presented = {
      ...labeled,
      proxy,
      ...(event.networkPoolId ? { networkPoolLabel: proxy } : {}),
    };
    // Filter the payload table directly instead of joining `telemetry_events`
    // only to re-apply the tenant predicate: `telemetry_payloads` carries
    // `tenant_id` itself, so the join added a second table's rows to filter for
    // no additional constraint. This matches `getEvent` above and uses
    // `telemetry_payloads_tenant_request_idx`.
    const linkedPayloadRows = await this.db
      .select({ payload: telemetryPayloads })
      .from(telemetryPayloads)
      .where(
        and(
          eq(telemetryPayloads.requestId, requestId),
          eq(telemetryPayloads.tenantId, tenantId),
        ),
      )
      .orderBy(desc(telemetryPayloads.capturedAt))
      .limit(1);
    const payloadRow = linkedPayloadRows[0]?.payload;
    const captured = await readCapturedBodies(payloadRow);
    if (!captured) {
      return { ...presented, payloads: null };
    }
    return {
      ...presented,
      payloads: {
        ...(captured.request !== undefined ? { request: captured.request } : {}),
        ...(captured.response !== undefined ? { response: captured.response } : {}),
        ...(captured.clientResponse !== undefined ? { clientResponse: captured.clientResponse } : {}),
        ...(captured.providerRequest !== undefined
          ? { providerRequest: captured.providerRequest }
          : {}),
        ...(captured.providerResponse !== undefined
          ? { providerResponse: captured.providerResponse }
          : {}),
      },
      ...(captured.signals === undefined ? {} : { payloadSignals: captured.signals }),
    };
  }

  async listEvents(
    tenantId: string,
    limit: number,
    cursor?: string,
  ): Promise<TelemetryEventListPage> {
    const before = decodeDatedCursor(cursor);
    // The cursor becomes an `until` bound inside the query, so `limit` applies
    // to every page and not only the first. Filtering after the read would force
    // a cursor page to fetch the whole window to know where it ended, dropping
    // `limit` the moment a cursor appears.
    //
    // `until` is inclusive while the cursor is exclusive, so rows at the exact
    // cursor timestamp are still compared by id here — the cheap part of the
    // predicate, now over one timestamp's worth of rows instead of the window.
    // Keyset page: the cursor is the last row of the previous page, and the
    // SQL reader pushes it into the WHERE clause instead of filtering a
    // materialized window in JS.
    const page = await queryTelemetryEventPage(this.db, {
      tenantId,
      limit: limit + 1,
      ...(before === undefined ? {} : { cursor: encodeCursor({ createdAt: before.createdAt, id: before.id }) }),
    });
    const { rows: trimmed, hasMore: overflow } = trimKeysetPage(page.events, limit);
    const entries = trimmed.map(mapTelemetryEventRow);
    const lastEntry = entries[entries.length - 1];
    const nextCursor =
      overflow && lastEntry !== undefined
        ? encodeCursor({ createdAt: lastEntry.createdAt, id: lastEntry.id })
        : undefined;
    return nextCursor ? { entries, nextCursor } : { entries };
  }

  async getEvent(
    tenantId: string,
    eventId: string,
    includePayload = false,
    createdAt?: string,
  ): Promise<TelemetryEventDetail | undefined> {
    // Matched by `id`, which is the field the list cursor encodes — not by
    // `requestId`, which is a different column that merely defaults to the
    // same value. Predicating on it lets the reader stop at the first hit
    // instead of parsing the retention window to find one row.
    const page = await queryTelemetryEventPage(this.db, { tenantId, id: eventId });
    const events = page.events;
    const event = events.find(
      (candidate) =>
        candidate.id === eventId && (createdAt === undefined || candidate.createdAt === createdAt),
    );
    if (!event) return undefined;
    const base = mapTelemetryEventRow(event);
    if (!includePayload) return base;
    const payloadRows = await this.db
      .select()
      .from(telemetryPayloads)
      .where(
        and(
          eq(telemetryPayloads.requestId, event.requestId),
          eq(telemetryPayloads.tenantId, tenantId),
        ),
      )
      .orderBy(desc(telemetryPayloads.capturedAt))
      .limit(1);
    const payloadRow = payloadRows[0];
    if (!payloadRow) return base;
    const captured = await readCapturedBodies(payloadRow);
    if (!captured) return base;
    return {
      ...base,
      payload: {
        ...(captured.request !== undefined ? { requestBody: captured.request } : {}),
        ...(captured.response !== undefined ? { responseBody: captured.response } : {}),
      },
    };
  }
}

/**
 * Reads the captured bodies behind one `telemetry_payloads` row.
 *
 * The row stores typed frame-reference columns only; every body lives in the
 * frame file those columns name. Returns `undefined` when there is no row, no
 * usable reference, or the frame cannot be read — all three mean "nothing to
 * show", and the caller renders the request without a payload section. The raw
 * reference is never returned to a caller, so it cannot reach the dashboard.
 */
async function readCapturedBodies(
  row:
    | {
        readonly storage: string;
        readonly file: string;
        readonly offset: number;
        readonly length: number;
        readonly checksum: string;
        readonly version: number;
      }
    | null
    | undefined,
): Promise<
  | {
      request: unknown;
      response: unknown;
      clientResponse: unknown;
      providerRequest: unknown;
      providerResponse: unknown;
      signals?: { toolCalls: number; images: number; attachments: number };
    }
  | undefined
> {
  if (!row) return undefined;
  const reference = payloadReferenceFromRow(row);
  if (!reference) return undefined;
  try {
    const stored = await readPayloadFrame(reference);
    if (!stored || typeof stored !== "object") return undefined;
    const record = stored as Record<string, unknown>;
    const bodies = {
      request: record["request_body"] ?? undefined,
      response: record["response_body"] ?? undefined,
      clientResponse: record["client_response_body"] ?? undefined,
      providerRequest: record["provider_request_body"] ?? undefined,
      providerResponse: record["provider_response_body"] ?? undefined,
    };
    const signals =
      typeof record["signals"] === "object" &&
      record["signals"] !== null &&
      !Array.isArray(record["signals"])
        ? (record["signals"] as { toolCalls: number; images: number; attachments: number })
        : undefined;
    return {
      ...bodies,
      ...(signals === undefined ? {} : { signals }),
    };
  } catch {
    return undefined;
  }
}
