/**
 * The canonical telemetry reader.
 *
 * `telemetry_events` is already written by the production path (the
 * transactional `insertEvents`), is indexed for keyset pagination and
 * tenant-scoped breakdowns, and carries exactly the bounded metadata fields
 * the console aggregates over — bodies live only in payload frame files. It
 * is therefore the analytics source: every function here runs its aggregate
 * IN SQL and returns only totals, groups, or buckets, so no read materializes
 * the retained window in JavaScript.
 *
 * Rules enforced here:
 * - every statement is tenant-scoped and `created_at >= since`;
 * - list/detail use `(created_at, id)` keyset pagination, newest first;
 * - latency percentiles are computed by the database (Postgres
 *   `percentile_cont`, SQLite nearest-rank via ordered OFFSET/LIMIT) —
 *   latency arrays are never returned to JavaScript;
 * - `isGatewayError()` semantics live in one shared SQL predicate.
 */
import { and, desc, eq, gte, inArray, isNotNull, or, sql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { resolveDbMode } from "../persistence/db-mode";
import type { CartethyiaDatabase } from "../persistence/db-handle";
import { apiKeys, telemetryEvents, telemetryUsageTotals } from "../persistence/schema";
import type { TelemetryEventRecord } from "./event-log";
import { gatewayErrorSql } from "./telemetry-status";

/**
 * The SQL predicate for "this request counts as a gateway error".
 *
 * `gatewayErrorSql` (telemetry-status.ts) is derived from the same constants
 * `isGatewayError` reads, so the row-level predicate, the console's error
 * totals, and the durable usage rollup cannot drift apart — an unknown status
 * must be classified identically in all three.
 */
export const IS_GATEWAY_ERROR_SQL = gatewayErrorSql(telemetryEvents.status, telemetryEvents.httpStatus);

/** One bounded page of events, newest first. */
export interface EventPage {
  readonly events: TelemetryEventRecord[];
  /** Cursor for the next (older) page; undefined when the window is exhausted. */
  readonly nextCursor?: string;
}

export interface EventListQuery {
  readonly tenantId: string;
  /**
   * Lower bound. Omitting it means "the whole retained window" — the SQL table
   * is pruned by the same retention rule as the raw files, so an unbounded
   * query is bounded by retention rather than unbounded in effect. (Backup
   * export is the one caller that needs the full window.)
   */
  readonly since?: Date;
  readonly until?: Date;
  readonly apiKeyIds?: readonly string[];
  readonly accountIds?: readonly string[];
  /**
   * The share-template key whose family (the template itself plus every child
   * key it issued) scopes the read. Rendered as an `EXISTS` subquery against
   * `api_keys` rather than an id list: a family is minted by the tenant and
   * can grow to whatever size the tenant drives it to, so enumerating its ids
   * in JavaScript to feed a bind list would scale the query's wire size with
   * the family instead of with the result. The subquery keeps the same
   * membership semantics — template id or any child of it — for any family
   * size.
   */
  readonly familyApiKeyId?: string;
  readonly requestId?: string;
  /** Several request ids at once — the backup restore's "already present" check. */
  readonly requestIds?: readonly string[];
  readonly id?: string;
  readonly httpStatus?: number;
  readonly limit?: number;
  /** Keyset cursor: `{createdAt}|{id}` of the last row of the previous page. */
  readonly cursor?: string;
}

export interface UsageSummary {
  readonly requests: number;
  readonly errors: number;
  /** Lifecycle breakdown: cancelled and truncated counts, for the summary card. */
  readonly cancelled: number;
  readonly truncated: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number;
  readonly reasoningTokens: number;
  readonly estimatedCostUsd: number;
  /** Requests whose latency was recorded — the denominator for `latencyMs`. */
  readonly sampled: number;
  readonly latencyMs: {
    readonly avg: number | null;
    readonly p50: number | null;
    readonly p95: number | null;
    readonly p99: number | null;
  };
  /** Requests whose usage carried no price; the analytics `partial` flag. */
  readonly unpriced: number;
}

export interface BreakdownGroup {
  readonly key: string;
  readonly requests: number;
  readonly errors: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Summed estimated cost; null when no row in the group carried a price. */
  readonly costUsd: number | null;
  /** Mean tokens/sec across rows that reported one; 0 when none did. */
  readonly avgTokensPerSec: number;
  /** Cached-input share of the prompt, summed for the group. */
  readonly cachedInputTokens: number;
}

export interface ChartBucket {
  readonly at: number;
  readonly requests: number;
  readonly errors: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface HealthTotals {
  readonly requests: number;
  readonly errors: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number;
  readonly latencyAvgMs: number | null;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

function numeric(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function numericNullable(value: unknown): number | null {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/** Maps one `telemetry_events` row to the console's record shape. */
export function eventRecordFromRow(row: {
  readonly id: string | null;
  readonly createdAt: Date;
  readonly tenantId: string;
  readonly requestId: string;
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
  readonly clientName: string | null;
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
  readonly estimatedCostUsd: string | number | null;
  readonly creditUsed: string | number | null;
  readonly resolveMs: number | null;
  readonly tokensPerSec: string | number | null;
  readonly firstContentDeltaAtMs: number | null;
  readonly lastEventAtMs: number | null;
  readonly payloadCaptureState: string | null;
}): TelemetryEventRecord {
  return {
    id: row.id ?? row.requestId,
    createdAt: new Date(row.createdAt).toISOString(),
    tenantId: row.tenantId,
    requestId: row.requestId,
    sourceSurface: row.sourceSurface,
    requestedModel: row.requestedModel,
    reportedModel: row.reportedModel,
    requestedEffort: row.requestedEffort,
    providerId: row.providerId,
    accountId: row.accountId,
    networkPoolId: row.networkPoolId,
    endpoint: row.endpoint,
    apiKeyId: row.apiKeyId,
    userAgent: row.userAgent,
    clientIp: row.clientIp,
    latencyMs: row.latencyMs,
    ttfbMs: row.ttfbMs,
    stream: row.stream,
    status: row.status,
    httpStatus: row.httpStatus,
    errorOrigin: row.errorOrigin,
    errorCategory: row.errorCategory,
    inputTokens: row.inputTokens,
    cachedInputTokens: row.cachedInputTokens,
    outputTokens: row.outputTokens,
    reasoningTokens: row.reasoningTokens,
    estimatedCostUsd: numericNullable(row.estimatedCostUsd),
    creditUsed: numericNullable(row.creditUsed),
    resolveMs: row.resolveMs,
    tokensPerSec: numericNullable(row.tokensPerSec),
    firstContentDeltaAtMs: row.firstContentDeltaAtMs,
    lastEventAtMs: row.lastEventAtMs,
    payloadCaptureState: row.payloadCaptureState,
  };
}

/**
 * True when this handle speaks PostgreSQL.
 *
 * Read off the live dialect rather than `resolveDbMode()`/`handle.kind`:
 * `CartethyiaDatabase` is the pg-typed builder on both backends (the SQLite
 * adapter shares the type), and a test can build a SQLite handle while the
 * process' mode is `full` — a mode-based guess then sends `percentile_cont`,
 * which SQLite lacks, to SQLite. The dialect is the thing that actually
 * renders the SQL, so it is the only answer that cannot disagree with it.
 */
function isPostgres(db: CartethyiaDatabase): boolean {
  const dialect = (db as unknown as { dialect?: unknown }).dialect;
  if (dialect instanceof PgDialect) return true;
  const name = (dialect as { constructor?: { name?: string } } | undefined)?.constructor?.name;
  if (name === "PostgresDialect" || name === "PgDialect") return true;
  return resolveDbMode() !== "lite";
}

/**
 * The tenant predicate — the scope every read shares — plus the window when
 * one is given.
 *
 * Tenant is NOT optional: every statement here is tenant-scoped, and a query
 * that forgot it would read another tenant's traffic.
 */
function scoped(tenantId: string, since?: Date) {
  const tenant = eq(telemetryEvents.tenantId, tenantId);
  return since === undefined ? tenant : and(tenant, gte(telemetryEvents.createdAt, since));
}

/**
 * Thrown when a membership filter outruns the guard below. This is a handled
 * query error, not a protocol fault: callers surface it as a request failure
 * instead of crashing the process with a PostgreSQL wire error that systemd
 * would only restart into.
 */
export class TelemetryQueryInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TelemetryQueryInputError";
  }
}

/**
 * The deduplicated id count a list membership filter accepts before refusing.
 *
 * `idMembershipFilter` binds the whole set as one array parameter, so even a
 * six-figure set is wire-safe; this guard is not a protocol necessity but a
 * runaway-collector tripwire — a bug elsewhere (an unbounded accumulator, a
 * vanished scope) must fail as a query error instead of materializing an
 * unbounded parameter. Families larger than this must use the `familyApiKeyId`
 * filter, which never materializes ids.
 */
const MAX_MEMBERSHIP_IDS = 200_000;

/**
 * The chunk size for the SQLite rendering of a list membership filter.
 *
 * SQLite has no array parameters, so the set has to come back as individual
 * placeholders; 500 per chunk sits far below every build's
 * SQLITE_MAX_VARIABLE_NUMBER while keeping the OR of chunks — semantically
 * the identical membership test — to a handful of clauses for realistic sets.
 */
const SQLITE_IDS_PER_CHUNK = 500;

/**
 * Membership of `column` in a caller-supplied id set, safe at any set size.
 *
 * Expanding the members into one bind placeholder each breaks the wire twice
 * over: PostgreSQL caps a Bind message at 65,535 parameters, and node-postgres
 * miscounts long placeholder lists anyway (`08P01 bind message has N parameter
 * formats but 0 parameters` — the shape that crash-looped the dev deployment,
 * whose share family carried ~90k minted child keys). Instead the set is
 * deduplicated and handed to the server as a single array parameter
 * (`= ANY(…::uuid[])`), or, on SQLite, to chunks of individual placeholders;
 * membership semantics are unchanged in both renderings.
 */
function idMembershipFilter(
  db: CartethyiaDatabase,
  column: typeof telemetryEvents.apiKeyId | typeof telemetryEvents.accountId | typeof telemetryEvents.requestId,
  values: readonly string[],
  cast: "uuid[]" | "text[]",
): SQL {
  const unique = [...new Set(values)];
  if (unique.length > MAX_MEMBERSHIP_IDS) {
    throw new TelemetryQueryInputError(
      `telemetry filter exceeds ${MAX_MEMBERSHIP_IDS} distinct ids (got ${unique.length}); scope the read by family or tenant instead`,
    );
  }
  if (unique.length === 0) return sql`false`;
  if (isPostgres(db)) {
    return sql`${column} = ANY(${unique}::${sql.raw(cast)})`;
  }
  if (unique.length <= SQLITE_IDS_PER_CHUNK) return inArray(column, unique);
  const chunks: SQL[] = [];
  for (let start = 0; start < unique.length; start += SQLITE_IDS_PER_CHUNK) {
    chunks.push(inArray(column, unique.slice(start, start + SQLITE_IDS_PER_CHUNK)));
  }
  return or(...chunks) as SQL;
}

/**
 * Membership of `api_key_id` in the family of one share template — the
 * template itself plus every key it issued.
 *
 * The primary predicate is the denormalized `family_template_key_id` column:
 * an event is in the family when it was stamped with the template at write
 * time. That makes the read independent of the key row surviving — a revoked
 * or removed key keeps its history. Events written before the column existed
 * (or whose key was hard-deleted before the backfill) fall back to an
 * `EXISTS` against `api_keys`, so the migration window is still counted when
 * the key row is present. The tenant predicate is carried by every read
 * already, so a child in another tenant still cannot match.
 */
function familyKeyCondition(templateKeyId: string): SQL {
  return sql`(${telemetryEvents.familyTemplateKeyId} = ${templateKeyId} or (${telemetryEvents.familyTemplateKeyId} is null and exists (select 1 from ${apiKeys} where ${apiKeys.id} = ${telemetryEvents.apiKeyId} and (${apiKeys.id} = ${templateKeyId} or ${apiKeys.parentKeyId} = ${templateKeyId}))))`;
}

/**
 * Bounded detail/list read — the only place rows are materialized.
 *
 * Keyset pagination on `(created_at DESC, id DESC)`: `created_at` has
 * second resolution, so a cursor on it alone could skip or repeat rows at a
 * boundary. The cursor is the last row of the page, encoded as
 * `{createdAtMs}|{id}`.
 */
export async function queryTelemetryEvents(
  db: CartethyiaDatabase,
  query: EventListQuery,
): Promise<EventPage> {
  const limit = Math.max(1, Math.min(MAX_LIMIT, Math.trunc(query.limit ?? DEFAULT_LIMIT)));
  const conditions = [scoped(query.tenantId, query.since)];
  if (query.until !== undefined) {
    conditions.push(sql`${telemetryEvents.createdAt} < ${query.until}`);
  }
  if (query.apiKeyIds !== undefined) {
    conditions.push(idMembershipFilter(db, telemetryEvents.apiKeyId, query.apiKeyIds, "uuid[]"));
  }
  if (query.familyApiKeyId !== undefined) {
    conditions.push(familyKeyCondition(query.familyApiKeyId));
  }
  if (query.accountIds !== undefined) {
    conditions.push(idMembershipFilter(db, telemetryEvents.accountId, query.accountIds, "uuid[]"));
  }
  if (query.requestId !== undefined) {
    conditions.push(eq(telemetryEvents.requestId, query.requestId));
  }
  if (query.requestIds !== undefined) {
    conditions.push(idMembershipFilter(db, telemetryEvents.requestId, query.requestIds, "text[]"));
  }
  if (query.id !== undefined) {
    conditions.push(eq(telemetryEvents.id, query.id));
  }
  if (query.httpStatus !== undefined) {
    conditions.push(eq(telemetryEvents.httpStatus, query.httpStatus));
  }
  if (query.cursor !== undefined) {
    const separator = query.cursor.indexOf("|");
    const at = Number(query.cursor.slice(0, separator));
    const id = query.cursor.slice(separator + 1);
    if (Number.isFinite(at) && id.length > 0) {
      conditions.push(
        sql`(${telemetryEvents.createdAt} < ${new Date(at)} OR (${telemetryEvents.createdAt} = ${new Date(at)} AND ${telemetryEvents.id} < ${id}))`,
      );
    }
  }

  const rows = await db
    .select()
    .from(telemetryEvents)
    .where(and(...conditions))
    .orderBy(desc(telemetryEvents.createdAt), desc(telemetryEvents.id))
    .limit(limit + 1);

  const page = rows.slice(0, limit);
  const hasMore = rows.length > limit;
  const last = page[page.length - 1];
  const events = page.map((row) => eventRecordFromRow(row as Parameters<typeof eventRecordFromRow>[0]));
  return {
    events,
    ...(hasMore && last
      ? {
          nextCursor: `${new Date(last.createdAt as unknown as Date).getTime()}|${last.id ?? last.requestId}`,
        }
      : {}),
  };
}

/** One event by request id — a single indexed row, never a window scan. */
export async function eventByRequestId(
  db: CartethyiaDatabase,
  tenantId: string,
  requestId: string,
): Promise<TelemetryEventRecord | undefined> {
  const [row] = await db
    .select()
    .from(telemetryEvents)
    .where(and(eq(telemetryEvents.tenantId, tenantId), eq(telemetryEvents.requestId, requestId)))
    .limit(1);
  if (!row) return undefined;
  return eventRecordFromRow(row as Parameters<typeof eventRecordFromRow>[0]);
}

/**
 * Totals plus latency percentiles for one tenant window.
 *
 * Percentiles are computed by the database. Postgres uses `percentile_cont`;
 * SQLite (no ordered-set aggregates) computes nearest-rank percentiles from
 * the ordered latency column via OFFSET/LIMIT. Either way, latency values are
 * never returned to JavaScript — the array that the old raw reader built to
 * sort in JS was the memory cost this replaces.
 */
export async function summarizeTelemetry(
  db: CartethyiaDatabase,
  tenantId: string,
  since: Date,
): Promise<UsageSummary> {
  const condition = scoped(tenantId, since);
  const [row] = await db
    .select({
      requests: sql<number>`count(*)`,
      errors: sql<number>`sum(case when ${IS_GATEWAY_ERROR_SQL} then 1 else 0 end)`,
      cancelled: sql<number>`sum(case when ${telemetryEvents.status} = 'cancelled' then 1 else 0 end)`,
      truncated: sql<number>`sum(case when ${telemetryEvents.status} = 'truncated' then 1 else 0 end)`,
      inputTokens: sql<number>`coalesce(sum(${telemetryEvents.inputTokens}), 0)`,
      outputTokens: sql<number>`coalesce(sum(${telemetryEvents.outputTokens}), 0)`,
      cachedInputTokens: sql<number>`coalesce(sum(${telemetryEvents.cachedInputTokens}), 0)`,
      reasoningTokens: sql<number>`coalesce(sum(${telemetryEvents.reasoningTokens}), 0)`,
      estimatedCostUsd: sql<number>`coalesce(sum(${telemetryEvents.estimatedCostUsd}), 0)`,
      sampled: sql<number>`count(${telemetryEvents.latencyMs})`,
      latencyAvg: sql<number>`avg(${telemetryEvents.latencyMs})`,
      unpriced: sql<number>`sum(case when ${telemetryEvents.estimatedCostUsd} is null then 1 else 0 end)`,
    })
    .from(telemetryEvents)
    .where(condition);
  if (!row) {
    return {
      requests: 0,
      errors: 0,
      cancelled: 0,
      truncated: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      estimatedCostUsd: 0,
      sampled: 0,
      latencyMs: { avg: null, p50: null, p95: null, p99: null },
      unpriced: 0,
    };
  }

  const sampled = numeric(row.sampled);
  const percentiles = await latencyPercentiles(db, tenantId, since, sampled);
  return {
    requests: numeric(row.requests),
    errors: numeric(row.errors),
    cancelled: numeric(row.cancelled),
    truncated: numeric(row.truncated),
    inputTokens: numeric(row.inputTokens),
    outputTokens: numeric(row.outputTokens),
    cachedInputTokens: numeric(row.cachedInputTokens),
    reasoningTokens: numeric(row.reasoningTokens),
    estimatedCostUsd: numeric(row.estimatedCostUsd),
    sampled,
    latencyMs: {
      avg: numericNullable(row.latencyAvg),
      ...percentiles,
    },
    unpriced: numeric(row.unpriced),
  };
}

type Percentiles = { p50: number | null; p95: number | null; p99: number | null };

async function latencyPercentiles(
  db: CartethyiaDatabase,
  tenantId: string,
  since: Date,
  sampled: number,
): Promise<Percentiles> {
  const empty: Percentiles = { p50: null, p95: null, p99: null };
  if (sampled <= 0) return empty;
  const base = [scoped(tenantId, since), isNotNull(telemetryEvents.latencyMs)];

  // Postgres: one statement computing all three continuous percentiles.
  if (isPostgres(db)) {
    const [row] = await db
      .select({
        p50: sql<number>`percentile_cont(0.50) within group (order by ${telemetryEvents.latencyMs})`,
        p95: sql<number>`percentile_cont(0.95) within group (order by ${telemetryEvents.latencyMs})`,
        p99: sql<number>`percentile_cont(0.99) within group (order by ${telemetryEvents.latencyMs})`,
      })
      .from(telemetryEvents)
      .where(and(...base));
    if (!row) return empty;
    return {
      p50: numericNullable(row.p50),
      p95: numericNullable(row.p95),
      p99: numericNullable(row.p99),
    };
  }

  // SQLite: nearest-rank percentile = the value at ceil(p * n) rows into the
  // ordered latency column. One query computes all three ranks via a window
  // function, instead of three separate OFFSET/LIMIT passes over the same
  // ordered column (one per percentile).
  const n = Math.max(1, sampled);
  const ranks = [
    Math.ceil(0.5 * n),
    Math.ceil(0.95 * n),
    Math.ceil(0.99 * n),
  ];
  const [row] = await db
    .select({
      p50: sql<number | null>`max(case when rn = ${ranks[0]} then value end)`,
      p95: sql<number | null>`max(case when rn = ${ranks[1]} then value end)`,
      p99: sql<number | null>`max(case when rn = ${ranks[2]} then value end)`,
    })
    .from(
      sql`(
        select ${telemetryEvents.latencyMs} as value,
               row_number() over (order by ${telemetryEvents.latencyMs}) as rn
        from ${telemetryEvents}
        where ${and(...base)}
      )`,
    );
  return {
    p50: numericNullable(row?.p50 ?? null),
    p95: numericNullable(row?.p95 ?? null),
    p99: numericNullable(row?.p99 ?? null),
  };
}

/**
 * The SQL column one breakdown dimension groups by.
 */
function dimensionColumn(dimension: string) {
  if (dimension === "model") return telemetryEvents.requestedModel;
  if (dimension === "provider") return telemetryEvents.providerId;
  if (dimension === "account") return telemetryEvents.accountId;
  if (dimension === "api_key" || dimension === "key") return telemetryEvents.apiKeyId;
  if (dimension === "client") return telemetryEvents.clientName;
  // `client_ip` groups on the raw address; masking stays a post-grouping
  // presentation step in the console, unchanged.
  if (dimension === "client_ip" || dimension === "ip") return telemetryEvents.clientIp;
  if (dimension === "status") return telemetryEvents.httpStatus;
  if (dimension === "endpoint") return telemetryEvents.endpoint;
  return telemetryEvents.requestedModel;
}

/** The dimension's raw value as a string, for the console's grouping step. */
function dimensionValue(raw: unknown): string {
  const value = raw === null || raw === undefined ? "" : String(raw);
  return value.length === 0 ? "unknown" : value;
}

/**
 * One dimension's groups, at most 100, ordered by request count.
 *
 * Grouping happens in SQL; only the groups come back. `client` groups on the
 * ingestion-stamped `client_name` rather than re-deriving a name per row in
 * JavaScript, and `client_ip` masking stays a post-grouping presentation step.
 */
export async function breakdownTelemetry(
  db: CartethyiaDatabase,
  tenantId: string,
  dimension: string,
  since: Date,
): Promise<BreakdownGroup[]> {
  const column = dimensionColumn(dimension);
  const rows = await db
    .select({
      key: column,
      requests: sql<number>`count(*)`,
      errors: sql<number>`sum(case when ${IS_GATEWAY_ERROR_SQL} then 1 else 0 end)`,
      inputTokens: sql<number>`coalesce(sum(${telemetryEvents.inputTokens}), 0)`,
      outputTokens: sql<number>`coalesce(sum(${telemetryEvents.outputTokens}), 0)`,
      cachedInputTokens: sql<number>`coalesce(sum(${telemetryEvents.cachedInputTokens}), 0)`,
      costUsd: sql<number>`coalesce(sum(${telemetryEvents.estimatedCostUsd}), 0)`,
      avgTokensPerSec: sql<number>`coalesce(avg(${telemetryEvents.tokensPerSec}), 0)`,
    })
    .from(telemetryEvents)
    .where(scoped(tenantId, since))
    .groupBy(column)
    .orderBy(desc(sql`count(*)`))
    .limit(100);
  return rows.map((row) => ({
    key: dimensionValue(row.key),
    requests: numeric(row.requests),
    errors: numeric(row.errors),
    inputTokens: numeric(row.inputTokens),
    outputTokens: numeric(row.outputTokens),
    cachedInputTokens: numeric(row.cachedInputTokens),
    // A group whose rows carried no price reports null, matching the console's
    // "cost is unknown" reading rather than a false zero.
    costUsd: numeric(row.costUsd) > 0 ? numeric(row.costUsd) : null,
    avgTokensPerSec: numeric(row.avgTokensPerSec),
  }));
}

/**
 * Time-series buckets, computed in SQL.
 *
 * Bucket width comes from the caller (the console's existing period rule); the
 * epoch bucketing is portable — `to_timestamp`/`unixepoch` differences are
 * handled per backend.
 */
export async function chartTelemetry(
  db: CartethyiaDatabase,
  tenantId: string,
  since: Date,
  bucketSeconds: number,
): Promise<ChartBucket[]> {
  const width = Math.max(1, Math.trunc(bucketSeconds));
  // Inlined (not parameterised) so Postgres sees the SELECT and GROUP BY
  // expressions as identical: parameter numbers differing between the two
  // clauses made Postgres treat them as unrelated expressions referencing
  // `created_at`, which 42803-rejected the query.
  const w = sql.raw(String(width));
  const bucketExpression = isPostgres(db)
    ? sql<number>`(cast(extract(epoch from ${telemetryEvents.createdAt}) as bigint) / ${w}) * ${w}`
    : sql<number>`(cast(strftime('%s', ${telemetryEvents.createdAt}) as integer) / ${w}) * ${w}`;
  const rows = await db
    .select({
      at: bucketExpression,
      requests: sql<number>`count(*)`,
      errors: sql<number>`sum(case when ${IS_GATEWAY_ERROR_SQL} then 1 else 0 end)`,
      inputTokens: sql<number>`coalesce(sum(${telemetryEvents.inputTokens}), 0)`,
      outputTokens: sql<number>`coalesce(sum(${telemetryEvents.outputTokens}), 0)`,
    })
    .from(telemetryEvents)
    .where(scoped(tenantId, since))
    .groupBy(bucketExpression);
  return rows.map((row) => ({
    at: numeric(row.at) * 1000,
    requests: numeric(row.requests),
    errors: numeric(row.errors),
    inputTokens: numeric(row.inputTokens),
    outputTokens: numeric(row.outputTokens),
  }));
}

/** One day × model usage cell for a single provider — the Activity Matrix feed. */
export interface ProviderUsageDayRow {
  /** UTC day, `YYYY-MM-DD` (epoch-day buckets, so the same key on both backends). */
  readonly day: string;
  /** What the client asked for; `null` when the event carried no model. */
  readonly model: string | null;
  readonly requests: number;
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
}

/**
 * Per-provider daily usage grouped by `requested_model`, day-bucketed like
 * {@link chartTelemetry} but with a second grouping dimension (requested
 * model) and the totals the tooltip/summary strip need. Provider rows carry
 * no catalog foreign keys, so an unknown or deleted provider id returns empty
 * rather than erroring.
 */
export async function providerUsageMatrix(
  db: CartethyiaDatabase,
  tenantId: string,
  providerId: string,
  since: Date,
): Promise<ProviderUsageDayRow[]> {
  // Same inlining rule as chartTelemetry: SELECT and GROUP BY must spell the
  // identical expression or Postgres 42803-rejects the grouped reference.
  const w = sql.raw(String(86400));
  const dayExpression = isPostgres(db)
    ? sql<number>`(cast(extract(epoch from ${telemetryEvents.createdAt}) as bigint) / ${w}) * ${w}`
    : sql<number>`(cast(strftime('%s', ${telemetryEvents.createdAt}) as integer) / ${w}) * ${w}`;
  const rows = await db
    .select({
      day: dayExpression,
      model: telemetryEvents.requestedModel,
      requests: sql<number>`count(*)`,
      inputTokens: sql<number>`coalesce(sum(${telemetryEvents.inputTokens}), 0)`,
      cachedInputTokens: sql<number>`coalesce(sum(${telemetryEvents.cachedInputTokens}), 0)`,
      outputTokens: sql<number>`coalesce(sum(${telemetryEvents.outputTokens}), 0)`,
      costUsd: sql<number>`coalesce(sum(${telemetryEvents.estimatedCostUsd}), 0)`,
    })
    .from(telemetryEvents)
    .where(and(scoped(tenantId, since), eq(telemetryEvents.providerId, providerId)))
    .groupBy(dayExpression, telemetryEvents.requestedModel)
    .orderBy(dayExpression);
  return rows.map((row) => ({
    day: new Date(numeric(row.day) * 1000).toISOString().slice(0, 10),
    model: row.model,
    requests: numeric(row.requests),
    inputTokens: numeric(row.inputTokens),
    cachedInputTokens: numeric(row.cachedInputTokens),
    outputTokens: numeric(row.outputTokens),
    costUsd: numeric(row.costUsd),
  }));
}

/** Overview/health totals for one tenant window. */
export async function healthTelemetry(
  db: CartethyiaDatabase,
  tenantId: string,
  since: Date,
): Promise<HealthTotals> {
  const [row] = await db
    .select({
      requests: sql<number>`count(*)`,
      errors: sql<number>`sum(case when ${IS_GATEWAY_ERROR_SQL} then 1 else 0 end)`,
      inputTokens: sql<number>`coalesce(sum(${telemetryEvents.inputTokens}), 0)`,
      outputTokens: sql<number>`coalesce(sum(${telemetryEvents.outputTokens}), 0)`,
      cachedInputTokens: sql<number>`coalesce(sum(${telemetryEvents.cachedInputTokens}), 0)`,
      latencyAvg: sql<number>`avg(${telemetryEvents.latencyMs})`,
    })
    .from(telemetryEvents)
    .where(scoped(tenantId, since));
  if (!row) {
    return {
      requests: 0,
      errors: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      latencyAvgMs: null,
    };
  }
  return {
    requests: numeric(row.requests),
    errors: numeric(row.errors),
    inputTokens: numeric(row.inputTokens),
    outputTokens: numeric(row.outputTokens),
    cachedInputTokens: numeric(row.cachedInputTokens),
    latencyAvgMs: numericNullable(row.latencyAvg),
  };
}

/**
 * Summed input+output tokens for a set of API keys over one window — the
 * family bucket spend query.
 */
export async function sumTelemetryTokens(
  db: CartethyiaDatabase,
  tenantId: string,
  filters: {
    readonly apiKeyIds?: readonly string[];
    /** The share-template family filter; see {@link EventListQuery.familyApiKeyId}. */
    readonly familyKeyId?: string;
    readonly since: Date;
    readonly until?: Date;
  },
): Promise<number> {
  const conditions = [scoped(tenantId, filters.since)];
  if (filters.until !== undefined) {
    conditions.push(sql`${telemetryEvents.createdAt} < ${filters.until}`);
  }
  if (filters.apiKeyIds !== undefined && filters.apiKeyIds.length > 0) {
    conditions.push(idMembershipFilter(db, telemetryEvents.apiKeyId, filters.apiKeyIds, "uuid[]"));
  }
  if (filters.familyKeyId !== undefined) {
    conditions.push(familyKeyCondition(filters.familyKeyId));
  }
  const [row] = await db
    .select({
      total: sql<number>`coalesce(sum(coalesce(${telemetryEvents.inputTokens}, 0) + coalesce(${telemetryEvents.outputTokens}, 0)), 0)`,
    })
    .from(telemetryEvents)
    .where(and(...conditions));
  return numeric(row?.total ?? 0);
}

/** One hour, in milliseconds — the share page's hourly bucket width. */
const HOUR_MS = 3_600_000;

/**
 * All-time family counts from the durable rollup, not from a scan of the
 * retained telemetry window.
 *
 * The share KPI cards need lifetime numbers. `telemetry_usage_totals` is
 * charged at write time and accumulates per identity, so a family's lifetime
 * requests/errors/tokens are a SUM over its rows (keyed by
 * `family_template_key_id`) — sub-millisecond on a small table, versus a
 * full-window aggregate over `telemetry_events` that reads every retained
 * event on every tick. The rollup is the same definition as the read-side
 * counts, so the two cannot drift.
 */
export interface FamilyKpiTotals {
  readonly requests: number;
  readonly errors: number;
  readonly tokens: number;
}

/** Sums one share family's durable lifetime totals. */
export async function familyKpiTotals(
  db: CartethyiaDatabase,
  tenantId: string,
  familyKeyId: string,
): Promise<FamilyKpiTotals> {
  const [row] = await db
    .select({
      requests: sql<number>`coalesce(sum(${telemetryUsageTotals.requests}), 0)`,
      errors: sql<number>`coalesce(sum(${telemetryUsageTotals.errors}), 0)`,
      tokens: sql<number>`coalesce(sum(coalesce(${telemetryUsageTotals.inputTokens}, 0) + coalesce(${telemetryUsageTotals.outputTokens}, 0)), 0)`,
    })
    .from(telemetryUsageTotals)
    .where(
      and(
        eq(telemetryUsageTotals.tenantId, tenantId),
        eq(telemetryUsageTotals.familyTemplateKeyId, familyKeyId),
      ),
    );
  return {
    requests: numeric(row?.requests ?? 0),
    errors: numeric(row?.errors ?? 0),
    tokens: numeric(row?.tokens ?? 0),
  };
}

/**
 * All-time family counts: the numbers a share page's KPI card shows.
 *
 * These must be computed in SQL, not derived from the bounded page read — the
 * page caps at {@link MAX_LIMIT}, so a busy family would freeze at 500
 * requests/errors/last-hour regardless of real traffic.
 */
export interface FamilyUsageTotals {
  readonly requests: number;
  readonly errors: number;
  readonly lastHourRequests: number;
}

/** Counts one share family's requests, errors, and last-hour traffic in SQL. */
export async function familyUsageTotals(
  db: CartethyiaDatabase,
  tenantId: string,
  familyKeyId: string,
  now: Date,
): Promise<FamilyUsageTotals> {
  const lastHourStart = new Date(now.getTime() - HOUR_MS);
  const conditions = [eq(telemetryEvents.tenantId, tenantId), familyKeyCondition(familyKeyId)];
  const [row] = await db
    .select({
      requests: sql<number>`count(*)`,
      errors: sql<number>`sum(case when ${IS_GATEWAY_ERROR_SQL} then 1 else 0 end)`,
      lastHourRequests: sql<number>`sum(case when ${telemetryEvents.createdAt} >= ${lastHourStart} then 1 else 0 end)`,
    })
    .from(telemetryEvents)
    .where(and(...conditions));
  return {
    requests: numeric(row?.requests ?? 0),
    errors: numeric(row?.errors ?? 0),
    lastHourRequests: numeric(row?.lastHourRequests ?? 0),
  };
}

/** Counts one share family's requests in a bounded window — a range scan, not a full-window aggregate. */
export async function familyWindowRequests(
  db: CartethyiaDatabase,
  tenantId: string,
  familyKeyId: string,
  since: Date,
): Promise<number> {
  const [row] = await db
    .select({
      requests: sql<number>`count(*)`,
    })
    .from(telemetryEvents)
    .where(
      and(
        eq(telemetryEvents.tenantId, tenantId),
        familyKeyCondition(familyKeyId),
        gte(telemetryEvents.createdAt, since),
      ),
    );
  return numeric(row?.requests ?? 0);
}

/**
 * One share family's client-IP breakdown, computed in SQL.
 *
 * Unlike the 24-hour page read, this covers a bounded history so an address
 * that stopped before the last day still appears — marked inactive. The
 * `active` flag is decided in the caller from `lastSeenAt` vs a cutoff; here
 * we only aggregate. The window is bounded (`since`, default the whole
 * retained window) so an unbounded scan is never the default for callers
 * that only need recent addresses.
 */
export async function familyIpBreakdown(
  db: CartethyiaDatabase,
  tenantId: string,
  familyKeyId: string,
  limit = 50,
  since?: Date,
): Promise<{ ip: string; requests: number; tokens: number; lastSeenAt: Date | null }[]> {
  const conditions = [
    eq(telemetryEvents.tenantId, tenantId),
    familyKeyCondition(familyKeyId),
    ...(since === undefined ? [] : [gte(telemetryEvents.createdAt, since)]),
  ];
  const rows = await db
    .select({
      ip: telemetryEvents.clientIp,
      requests: sql<number>`count(*)`,
      tokens: sql<number>`coalesce(sum(coalesce(${telemetryEvents.inputTokens}, 0) + coalesce(${telemetryEvents.outputTokens}, 0)), 0)`,
      lastSeenAt: sql<Date>`max(${telemetryEvents.createdAt})`,
    })
    .from(telemetryEvents)
    .where(and(...conditions))
    .groupBy(telemetryEvents.clientIp)
    // Highest volume first: the table answers "who has used the link most",
    // not just who is active right now.
    .orderBy(desc(sql`count(*)`))
    .limit(limit);
  return rows.flatMap((row) =>
    row.ip === null ? [] : [{ ip: row.ip, requests: numeric(row.requests), tokens: numeric(row.tokens), lastSeenAt: row.lastSeenAt }],
  );
}

/**
 * One share family's time-series buckets, computed in SQL with the family
 * membership filter.
 *
 * Mirrors {@link chartTelemetry} but scoped to a share family. The share page's
 * 24-hour strip must not be truncated to the bounded page (500 events), or a
 * busy family's chart undercounts every hour bucket.
 */
export async function familyHourlyTelemetry(
  db: CartethyiaDatabase,
  tenantId: string,
  familyKeyId: string,
  since: Date,
  bucketSeconds: number,
): Promise<ChartBucket[]> {
  const width = Math.max(1, Math.trunc(bucketSeconds));
  // Inlined (not parameterised) so Postgres sees the SELECT and GROUP BY
  // expressions as identical — see chartTelemetry for the failure this avoids.
  const w = sql.raw(String(width));
  const bucketExpression = isPostgres(db)
    ? sql<number>`(cast(extract(epoch from ${telemetryEvents.createdAt}) as bigint) / ${w}) * ${w}`
    : sql<number>`(cast(strftime('%s', ${telemetryEvents.createdAt}) as integer) / ${w}) * ${w}`;
  const conditions = [scoped(tenantId, since), familyKeyCondition(familyKeyId)];
  const rows = await db
    .select({
      at: bucketExpression,
      requests: sql<number>`count(*)`,
      errors: sql<number>`sum(case when ${IS_GATEWAY_ERROR_SQL} then 1 else 0 end)`,
      inputTokens: sql<number>`coalesce(sum(${telemetryEvents.inputTokens}), 0)`,
      outputTokens: sql<number>`coalesce(sum(${telemetryEvents.outputTokens}), 0)`,
    })
    .from(telemetryEvents)
    .where(and(...conditions))
    .groupBy(bucketExpression);
  return rows.map((row) => ({
    at: numeric(row.at) * 1000,
    requests: numeric(row.requests),
    errors: numeric(row.errors),
    inputTokens: numeric(row.inputTokens),
    outputTokens: numeric(row.outputTokens),
  }));
}

/**
 * The health card's latency and throughput figures for one window.
 *
 * Same principle as {@link summarizeTelemetry}: `avg(tokens_per_sec)` and the
 * latency percentiles are computed by the database. The console's health card
 * used to pull every retained event into an array to average `tokensPerSec`
 * and sort latencies in JavaScript.
 */
export interface HealthPerformance {
  readonly latencyAvgMs: number | null;
  readonly latencyP50Ms: number | null;
  readonly latencyP95Ms: number | null;
  readonly latencyP99Ms: number | null;
  readonly avgTokensPerSec: number;
}

export async function summarizeHealthPerformance(
  db: CartethyiaDatabase,
  tenantId: string,
  since: Date,
): Promise<HealthPerformance> {
  const [row] = await db
    .select({
      latencyAvg: sql<number>`avg(${telemetryEvents.latencyMs})`,
      sampled: sql<number>`count(${telemetryEvents.latencyMs})`,
      avgTokensPerSec: sql<number>`coalesce(avg(${telemetryEvents.tokensPerSec}), 0)`,
    })
    .from(telemetryEvents)
    .where(scoped(tenantId, since));
  const sampled = numeric(row?.sampled ?? 0);
  const percentiles = await latencyPercentiles(db, tenantId, since, sampled);
  return {
    latencyAvgMs: numericNullable(row?.latencyAvg ?? null),
    latencyP50Ms: percentiles.p50,
    latencyP95Ms: percentiles.p95,
    latencyP99Ms: percentiles.p99,
    avgTokensPerSec: numeric(row?.avgTokensPerSec ?? 0),
  };
}

/**
 * The Usage summary's performance block, computed in SQL.
 *
 * Replaces `summarizeUsagePerformance` (which sorted a latency array in
 * JavaScript): `avg(resolve_ms)` and `avg(tokens_per_sec)` are SQL averages,
 * and the latency percentiles come from the same database-side percentile
 * path {@link summarizeTelemetry} uses.
 */
export interface UsagePerformanceTotals {
  readonly avgResolveMs: number;
  readonly avgDurationMs: number;
  /**
   * Percentiles as plain numbers: an empty window reports 0, which is what the
   * JS-side `summarizeUsagePerformance` reported and what the summary card's
   * contract expects. (The health reader keeps null so "no samples" stays
   * distinguishable from a genuine near-zero latency.)
   */
  readonly latencyP50Ms: number;
  readonly latencyP95Ms: number;
  readonly latencyP99Ms: number;
  readonly latencySampleCount: number;
  readonly resolveSampleCount: number;
  readonly avgTokensPerSec: number;
}

export async function summarizeUsagePerformanceSql(
  db: CartethyiaDatabase,
  tenantId: string,
  since: Date,
): Promise<UsagePerformanceTotals> {
  const [row] = await db
    .select({
      sampled: sql<number>`count(${telemetryEvents.latencyMs})`,
      latencyAvg: sql<number>`avg(${telemetryEvents.latencyMs})`,
      resolveSum: sql<number>`coalesce(sum(${telemetryEvents.resolveMs}), 0)`,
      resolveCount: sql<number>`count(${telemetryEvents.resolveMs})`,
      avgTokensPerSec: sql<number>`coalesce(avg(${telemetryEvents.tokensPerSec}), 0)`,
    })
    .from(telemetryEvents)
    .where(scoped(tenantId, since));
  const sampled = numeric(row?.sampled ?? 0);
  const resolveCount = numeric(row?.resolveCount ?? 0);
  const percentiles = await latencyPercentiles(db, tenantId, since, sampled);
  return {
    avgResolveMs: resolveCount > 0 ? numeric(row?.resolveSum ?? 0) / resolveCount : 0,
    avgDurationMs: numericNullable(row?.latencyAvg ?? null) ?? 0,
    latencyP50Ms: percentiles.p50 ?? 0,
    latencyP95Ms: percentiles.p95 ?? 0,
    latencyP99Ms: percentiles.p99 ?? 0,
    latencySampleCount: sampled,
    resolveSampleCount: resolveCount,
    avgTokensPerSec: numeric(row?.avgTokensPerSec ?? 0),
  };
}

/**
 * Combined usage totals + performance in ONE window scan.
 *
 * `summarizeTelemetry` and `summarizeUsagePerformanceSql` both scan the same
 * tenant window and each additionally run the percentile path, so the Usage
 * summary endpoint paid two scans plus two percentile passes for one response.
 * This runs the combined SELECT once and one percentile pass, returning both
 * shapes so the caller needs no second query.
 */
export async function summarizeUsageWithPerformance(
  db: CartethyiaDatabase,
  tenantId: string,
  since: Date,
): Promise<{ summary: UsageSummary; performance: UsagePerformanceTotals }> {
  const condition = scoped(tenantId, since);
  const [row] = await db
    .select({
      requests: sql<number>`count(*)`,
      errors: sql<number>`sum(case when ${IS_GATEWAY_ERROR_SQL} then 1 else 0 end)`,
      cancelled: sql<number>`sum(case when ${telemetryEvents.status} = 'cancelled' then 1 else 0 end)`,
      truncated: sql<number>`sum(case when ${telemetryEvents.status} = 'truncated' then 1 else 0 end)`,
      inputTokens: sql<number>`coalesce(sum(${telemetryEvents.inputTokens}), 0)`,
      outputTokens: sql<number>`coalesce(sum(${telemetryEvents.outputTokens}), 0)`,
      cachedInputTokens: sql<number>`coalesce(sum(${telemetryEvents.cachedInputTokens}), 0)`,
      reasoningTokens: sql<number>`coalesce(sum(${telemetryEvents.reasoningTokens}), 0)`,
      estimatedCostUsd: sql<number>`coalesce(sum(${telemetryEvents.estimatedCostUsd}), 0)`,
      sampled: sql<number>`count(${telemetryEvents.latencyMs})`,
      latencyAvg: sql<number>`avg(${telemetryEvents.latencyMs})`,
      unpriced: sql<number>`sum(case when ${telemetryEvents.estimatedCostUsd} is null then 1 else 0 end)`,
      resolveSum: sql<number>`coalesce(sum(${telemetryEvents.resolveMs}), 0)`,
      resolveCount: sql<number>`count(${telemetryEvents.resolveMs})`,
      avgTokensPerSec: sql<number>`coalesce(avg(${telemetryEvents.tokensPerSec}), 0)`,
    })
    .from(telemetryEvents)
    .where(condition);

  if (!row) {
    const empty: UsageSummary = {
      requests: 0,
      errors: 0,
      cancelled: 0,
      truncated: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      estimatedCostUsd: 0,
      sampled: 0,
      latencyMs: { avg: null, p50: null, p95: null, p99: null },
      unpriced: 0,
    };
    const emptyPerformance: UsagePerformanceTotals = {
      avgResolveMs: 0,
      avgDurationMs: 0,
      latencyP50Ms: 0,
      latencyP95Ms: 0,
      latencyP99Ms: 0,
      latencySampleCount: 0,
      resolveSampleCount: 0,
      avgTokensPerSec: 0,
    };
    return { summary: empty, performance: emptyPerformance };
  }

  const sampled = numeric(row.sampled);
  const percentiles = await latencyPercentiles(db, tenantId, since, sampled);
  const resolveCount = numeric(row.resolveCount);
  return {
    summary: {
      requests: numeric(row.requests),
      errors: numeric(row.errors),
      cancelled: numeric(row.cancelled),
      truncated: numeric(row.truncated),
      inputTokens: numeric(row.inputTokens),
      outputTokens: numeric(row.outputTokens),
      cachedInputTokens: numeric(row.cachedInputTokens),
      reasoningTokens: numeric(row.reasoningTokens),
      estimatedCostUsd: numeric(row.estimatedCostUsd),
      sampled,
      latencyMs: {
        avg: numericNullable(row.latencyAvg),
        ...percentiles,
      },
      unpriced: numeric(row.unpriced),
    },
    performance: {
      avgResolveMs: resolveCount > 0 ? numeric(row.resolveSum) / resolveCount : 0,
      avgDurationMs: numericNullable(row.latencyAvg) ?? 0,
      latencyP50Ms: percentiles.p50 ?? 0,
      latencyP95Ms: percentiles.p95 ?? 0,
      latencyP99Ms: percentiles.p99 ?? 0,
      latencySampleCount: sampled,
      resolveSampleCount: resolveCount,
      avgTokensPerSec: numeric(row.avgTokensPerSec),
    },
  };
}
