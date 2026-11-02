import { and, eq, sql } from "drizzle-orm";
import type { CartethyiaDatabase } from "../../persistence/db-handle";
import type { ApiKeyRecord } from "../../persistence/stores/api-key-store";
import { CachedPreferencesReader, DrizzlePreferencesReader } from "../../persistence/tenant-preferences";
import { maskClientIp } from "../../observability/redaction";
import { type TelemetryEventRecord } from "../../observability/event-log";
import { queryTelemetryEvents as querySqlEvents } from "../../observability/event-query";
import { isGatewayError } from "../../observability/telemetry-status";
import type { RedisClient } from "../../persistence/redis";
import { cachedRead } from "../shared/read-through-cache";
import { SHARE_STATS_CACHE_TTL_SECONDS } from "./share-stats";
import { apiKeys, telemetryUsageTotals } from "../../persistence/schema";
import { shouldMaskClientIp } from "../shared/ip-privacy";
import { utcDayStart } from "../shared/day";

interface SharedKeyTokenUsage {
  readonly requests: number;
  readonly errors: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

export interface SharedKeySummary {
  readonly id: string;
  readonly label: string;
  readonly keyPrefix: string | null;
  readonly issuedClientIp: string | null;
  readonly createdAt: string;
  readonly revokedAt: string | null;
  readonly allTime: SharedKeyTokenUsage;
  readonly today: SharedKeyTokenUsage;
  readonly lastUsedAt: string | null;
}

export interface SharedKeyModelUsage {
  readonly providerId: string | null;
  readonly modelId: string;
  readonly retainedRequests: number;
  readonly retainedErrors: number;
  readonly retainedTokens: number;
  readonly todayRequests: number;
  readonly todayErrors: number;
  readonly todayTokens: number;
}

export interface SharedKeyRequestEvent {
  readonly requestId: string;
  readonly startedAt: string;
  readonly providerId?: string;
  readonly modelId?: string;
  readonly status: string;
  readonly httpStatus?: number;
  readonly errorCategory?: string;
  readonly errorOrigin?: string;
  readonly clientIp?: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

export interface SharedKeyActivityDetail {
  readonly models: readonly SharedKeyModelUsage[];
  readonly requests: readonly SharedKeyRequestEvent[];
}

/** Read-only share-recipient telemetry; payloads and credential material never cross this boundary. */
export interface ShareActivityPort {
  /**
   * `familyTemplateKeyId` is the share template the children were issued from:
   * the telemetry reads scope to the whole family through it (an `EXISTS`
   * against `api_keys`, constant-wire) rather than through an id list, so the
   * read is the same no matter how many keys the template has minted.
   */
  getSharedKeySummaries(
    tenantId: string,
    children: readonly ApiKeyRecord[],
    familyTemplateKeyId: string,
  ): Promise<readonly SharedKeySummary[]>;
  getSharedKeyDetail(tenantId: string, childKeyId: string): Promise<SharedKeyActivityDetail>;
}

/** Folds one event into a per-key usage bucket. */
function addEventUsage(bucket: SharedKeyTokenUsage, event: TelemetryEventRecord): SharedKeyTokenUsage {
  const inputTokens = bucket.inputTokens + (event.inputTokens ?? 0);
  const outputTokens = bucket.outputTokens + (event.outputTokens ?? 0);
  return {
    requests: bucket.requests + 1,
    errors: bucket.errors + (isGatewayError(event.status, event.httpStatus) ? 1 : 0),
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
  };
}

function tokenUsage(row: {
  readonly requests: number | string | null;
  readonly errors: number | string | null;
  readonly inputTokens: number | string | null;
  readonly outputTokens: number | string | null;
} | undefined): SharedKeyTokenUsage {
  const inputTokens = Number(row?.inputTokens ?? 0);
  const outputTokens = Number(row?.outputTokens ?? 0);
  return {
    requests: Number(row?.requests ?? 0),
    errors: Number(row?.errors ?? 0),
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
  };
}

/**
 * Cache key for one child key's activity detail.
 *
 * The masked/unmasked choice is part of the key: caching a payload computed
 * while the tenant's privacy switch was off, then serving it after the switch
 * turned on, would leak a raw client address for the TTL. Splitting the key by
 * that flag keeps a privacy change effective on the next read.
 */
function shareKeyDetailCacheKey(tenantId: string, childKeyId: string, hideClientIp: boolean): string {
  return `share:v1:detail:${tenantId}:${childKeyId}:${hideClientIp ? "m" : "r"}`;
}

/**
 * Caps on the two SQL event reads a share page performs.
 *
 * Both pages render a bounded list (a rolling window of recent requests), so
 * reading past the cap would fetch rows no element of the response shows.
 */
const MAX_SUMMARY_EVENTS = 2_000;
const MAX_ACTIVITY_EVENTS = 2_000;

interface ShareUsagePortDeps {
  readonly db: CartethyiaDatabase;
  readonly redis?: RedisClient | undefined;
}

export function createShareUsagePort(deps: ShareUsagePortDeps): ShareActivityPort {
  const { db, redis } = deps;
  const preferences = new CachedPreferencesReader(new DrizzlePreferencesReader(db));
  return {
    async getSharedKeySummaries(tenantId, children, familyTemplateKeyId) {
      if (children.length === 0) return [];
      const todayStart = utcDayStart(new Date());
      /**
       * Family membership of the entity the totals/events row is attributed to.
       * Primary predicate is the denormalized template column (so history
       * survives key deletion); the `EXISTS` fallback covers rows written
       * before the column existed.
       */
      const familyMembership = (entityId: typeof apiKeys.id | typeof telemetryUsageTotals.entityId) =>
        sql`(${telemetryUsageTotals.familyTemplateKeyId} = ${familyTemplateKeyId} or (${telemetryUsageTotals.familyTemplateKeyId} is null and exists (select 1 from ${apiKeys} where ${apiKeys.id} = ${entityId} and (${apiKeys.id} = ${familyTemplateKeyId} or ${apiKeys.parentKeyId} = ${familyTemplateKeyId}))))`;
      const [todayEvents, lifetimeRows, hideClientIp] = await Promise.all([
        // Today's per-key totals as one GROUP BY instead of reading every
        // event of the family. `addEventUsage` needs per-event fields, so the
        // groups are projected into the same shape the loop consumes. The
        // family filter is the template key, not an id list: a family with
        // tens of thousands of minted children must not expand them into bind
        // parameters on every dashboard poll.
        querySqlEvents(db, { tenantId, familyApiKeyId: familyTemplateKeyId, since: todayStart, limit: MAX_SUMMARY_EVENTS }).then(
          (page) => page.events,
        ),
        db
          .select({
            apiKeyId: telemetryUsageTotals.entityId,
            requests: telemetryUsageTotals.requests,
            errors: telemetryUsageTotals.errors,
            inputTokens: telemetryUsageTotals.inputTokens,
            outputTokens: telemetryUsageTotals.outputTokens,
            lastUsedAt: telemetryUsageTotals.lastUsedAt,
          })
          .from(telemetryUsageTotals)
          .where(
            and(
              eq(telemetryUsageTotals.tenantId, tenantId),
              eq(telemetryUsageTotals.identityType, "api_key"),
              familyMembership(telemetryUsageTotals.entityId),
            ),
          ),
        shouldMaskClientIp(preferences, tenantId),
      ]);
      const todayByKey = new Map<string, SharedKeyTokenUsage>();
      for (const event of todayEvents) {
        if (event.apiKeyId === null) continue;
        const bucket = todayByKey.get(event.apiKeyId) ?? tokenUsage(undefined);
        todayByKey.set(event.apiKeyId, addEventUsage(bucket, event));
      }
      const lifetimeByKey = new Map(lifetimeRows.map((row) => [row.apiKeyId, row]));
      return children.map((child) => {
        const allTime = tokenUsage(lifetimeByKey.get(child.id));
        const today = todayByKey.get(child.id) ?? tokenUsage(undefined);
        const issuedClientIp = child.issuedClientIp;
        const lastUsedAt = lifetimeByKey.get(child.id)?.lastUsedAt;
        return {
          id: child.id,
          label: child.label,
          keyPrefix: child.keyPrefix ?? null,
          issuedClientIp:
            issuedClientIp === undefined
              ? null
              : hideClientIp
                ? maskClientIp(issuedClientIp)
                : issuedClientIp,
          createdAt: child.createdAt.toISOString(),
          revokedAt: child.revokedAt?.toISOString() ?? null,
          allTime,
          today,
          lastUsedAt: lastUsedAt?.toISOString() ?? null,
        };
      });
    },

    async getSharedKeyDetail(tenantId, childKeyId) {
      const hideClientIp = await shouldMaskClientIp(preferences, tenantId);
      return cachedRead<SharedKeyActivityDetail>(
        redis,
        shareKeyDetailCacheKey(tenantId, childKeyId, hideClientIp),
        () => computeSharedKeyDetail(db, tenantId, childKeyId, hideClientIp),
        SHARE_STATS_CACHE_TTL_SECONDS,
      );
    },
  };
}

/**
 * Telemetry-derived detail for one child key: its model table and its most
 * recent requests. `hideClientIp` decides whether an address is masked; it is
 * resolved by the caller so the cache key can separate the two variants.
 */
async function computeSharedKeyDetail(
  db: CartethyiaDatabase,
  tenantId: string,
  childKeyId: string,
  hideClientIp: boolean,
): Promise<SharedKeyActivityDetail> {
  const todayStart = utcDayStart(new Date()).getTime();
  // Bounded SQL read: this page shows a 24-hour chart plus today's counters,
  // so anything older than the hourly window contributes nothing. The old
  // shape read the whole retained window for one child key.
  const windowStart = new Date(todayStart - 24 * 60 * 60_000);
  const page = await querySqlEvents(db, {
    tenantId,
    apiKeyIds: [childKeyId],
    since: windowStart,
    limit: MAX_ACTIVITY_EVENTS,
  });
  const events = page.events;
  const models = new Map<string, {
    providerId: string | null;
    modelId: string;
    retainedRequests: number;
    retainedErrors: number;
    retainedTokens: number;
    todayRequests: number;
    todayErrors: number;
    todayTokens: number;
  }>();
  for (const event of events) {
    if (event.requestedModel === null) continue;
    const key = `${event.providerId ?? ""}\u0000${event.requestedModel}`;
    const bucket = models.get(key) ?? {
      providerId: event.providerId,
      modelId: event.requestedModel,
      retainedRequests: 0,
      retainedErrors: 0,
      retainedTokens: 0,
      todayRequests: 0,
      todayErrors: 0,
      todayTokens: 0,
    };
    const tokens = (event.inputTokens ?? 0) + (event.outputTokens ?? 0);
    const error = isGatewayError(event.status, event.httpStatus);
    bucket.retainedRequests += 1;
    if (error) bucket.retainedErrors += 1;
    bucket.retainedTokens += tokens;
    if (new Date(event.createdAt).getTime() >= todayStart) {
      bucket.todayRequests += 1;
      if (error) bucket.todayErrors += 1;
      bucket.todayTokens += tokens;
    }
    models.set(key, bucket);
  }
  return {
    models: [...models.values()]
      .sort((a, b) => b.retainedRequests - a.retainedRequests)
      .slice(0, 10),
    requests: events.slice(0, 20).map((event) => {
      const inputTokens = event.inputTokens ?? 0;
      const outputTokens = event.outputTokens ?? 0;
      return {
        requestId: event.requestId,
        startedAt: event.createdAt,
        ...(event.providerId ? { providerId: event.providerId } : {}),
        ...(event.requestedModel ? { modelId: event.requestedModel } : {}),
        status: event.status ?? "unknown",
        ...(event.httpStatus === null ? {} : { httpStatus: event.httpStatus }),
        ...(event.errorCategory ? { errorCategory: event.errorCategory } : {}),
        ...(event.errorOrigin ? { errorOrigin: event.errorOrigin } : {}),
        ...(event.clientIp
          ? { clientIp: hideClientIp ? maskClientIp(event.clientIp) : event.clientIp }
          : {}),
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
      };
    }),
  };
}
