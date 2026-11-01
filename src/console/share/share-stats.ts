// Family-wide activity rollup for a public share link.
//
// The share page is the *recipient's* view, but the figures it needs are the
// template's: the quota is shared, so "how much has this link used" only means
// something as a total across every key the link has issued. This port answers
// that from telemetry, in one pass per shape, and never returns a raw client
// IP — the recipient is outside the tenant, so IPs leave masked regardless of
// the tenant's console privacy preference.
//
// Everything here is read-only and payload-free: token counts, model slugs,
// masked addresses. No request or response bodies cross this boundary.

import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { maskClientIp } from "../../observability/redaction";
import { type TelemetryEventRecord } from "../../observability/event-log";
import {
  queryTelemetryEvents as querySqlEvents,
  sumTelemetryTokens,
  familyUsageTotals,
  familyHourlyTelemetry,
  familyIpBreakdown,
} from "../../observability/event-query";
import type { CartethyiaDatabase } from "../../persistence/db-handle";
import { apiKeys } from "../../persistence/schema";
import { isGatewayError } from "../../observability/telemetry-status";
import type { RedisClient } from "../../persistence/redis";
import { cachedRead } from "../shared/read-through-cache";
import { utcDayStart, utcMonthStart } from "../shared/day";

/** Totals for the whole share family, all-time plus the windows the UI draws. */
export interface ShareFamilyTotals {
  readonly requests: number;
  readonly errors: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  /** Requests in the last 60 minutes. */
  readonly lastHourRequests: number;
  /** Tokens spent since 00:00 UTC — what the daily limit is compared against. */
  readonly todayTokens: number;
  /** Tokens spent since the 1st of the month UTC — the monthly limit's figure. */
  readonly monthTokens: number;
}

/** One hour bucket of the last 24 hours, oldest first. */
export interface ShareHourlyBucket {
  /** ISO instant at the top of the hour. */
  readonly hour: string;
  readonly requests: number;
  /** Input plus output tokens recorded in the hour. */
  readonly tokens: number;
}

export interface ShareTopModel {
  readonly modelId: string;
  readonly requests: number;
  readonly tokens: number;
  /** Mean tokens/sec across requests that reported a rate; null when none did. */
  readonly avgTokensPerSec: number | null;
  /** Mean time-to-first-byte in ms across requests that reported it; null when none did. */
  readonly avgTtfbMs: number | null;
}

export interface ShareTopClientIp {
  /** Always masked: this payload is served to the recipient, not the tenant. */
  readonly ip: string;
  readonly requests: number;
  readonly tokens: number;
  readonly lastSeenAt: string | null;
  /**
   * Client identity as the User-Agent named it (`claude-cli`, `node`, ...),
   * or null when no request from this address carried one. Shown instead of the
   * raw header: the full string is long, varies per patch release, and names
   * the tool rather than the machine.
   */
  readonly clientType: string | null;
  /**
   * True when this address made a request within {@link ACTIVE_IP_WINDOW_MS}.
   * A recipient watching the link can tell which addresses are still using it
   * versus ones that stopped days ago.
   */
  readonly active: boolean;
}

export interface ShareFamilyStats {
  readonly totals: ShareFamilyTotals;
  readonly recipients: { readonly total: number; readonly active: number };
  /** 24 buckets, oldest first, gaps filled with zero. */
  readonly hourly: readonly ShareHourlyBucket[];
  readonly models: readonly ShareTopModel[];
  readonly clientIps: readonly ShareTopClientIp[];
}

/** Read-only family rollup for one share link. */
export interface ShareStatsPort {
  /**
   * The family is addressed by its template key (`templateKeyId`) plus the
   * number of keys it covers at call time (`memberCount`), not by an id list:
   * a family grows with every key the link mints, and enumerating its ids to
   * build a query — or a cache key — scaled both with the family instead of
   * with the request. `memberCount` keeps the cache key sensitive to minting:
   * a newly issued child starts a fresh entry rather than being folded into
   * the previous one for a full TTL.
   *
   * `allowedModels`, when supplied, restricts the top-models table to the names
   * the link actually grants. A rejected request still writes a telemetry row
   * (with the requested name), so without this the table would rank models the
   * recipient can never use — every invalid name an abuser tries would show up
   * as if it were traffic. `undefined` means "no restriction" (an unrestricted
   * link); an empty array means "nothing allowed" and yields no rows.
   */
  getFamilyStats(
    tenantId: string,
    family: { readonly templateKeyId: string; readonly memberCount: number },
    recipients: { readonly total: number; readonly active: number },
    allowedModels?: readonly string[],
  ): Promise<ShareFamilyStats>;
}

const HOUR_MS = 3_600_000;

/**
 * How old an address's last request may be and still count as active on the
 * share page. 24 hours matches the page's own "last 24 hours" framing: an IP
 * that made a request since yesterday is "active", one that stopped before
 * that window is "inactive".
 */
const ACTIVE_IP_WINDOW_MS = 24 * HOUR_MS;

/**
 * Names the client behind a request from its User-Agent.
 *
 * The share page shows one label per client address, and the raw header is the
 * wrong thing to show: it runs to hundreds of characters, embeds a version that
 * changes every release, and identifies the tool rather than anything the
 * recipient can act on. The first token of the header is what clients actually
 * use as their name (`claude-cli/2.1.280`, `node`, `curl/8.7.1`), so take that,
 * drop the version, and normalise to lower case so one client's releases do not
 * read as separate clients.
 *
 * Returns null when there is nothing to name, so callers render a blank rather
 * than an empty chip.
 */
export function clientTypeFromUserAgent(userAgent: string | null | undefined): string | null {
  if (typeof userAgent !== "string") return null;
  const token = userAgent.trim().split(/[\s/]+/)[0]?.trim();
  if (!token) return null;
  return token.toLowerCase().slice(0, 32);
}

/**
 * Whether a requested model name is covered by one grant entry, mirroring
 * `modelRejectionReason`: a bare entry covers itself and any provider-qualified
 * spelling of it, while a qualified entry covers only itself.
 */
function modelAllowed(requested: string, allowed: ReadonlySet<string>): boolean {
  if (allowed.has(requested)) return true;
  const slash = requested.lastIndexOf("/");
  return slash > 0 && allowed.has(requested.slice(slash + 1));
}

/** Top of the hour containing `now`, in UTC. */
function utcHourStart(now: Date): Date {
  const start = new Date(now);
  start.setUTCMinutes(0, 0, 0);
  return start;
}

interface FamilyRollup {
  totals: ShareFamilyTotals;
  byHour: Map<string, { requests: number; tokens: number }>;
  models: Map<string, { modelId: string; requests: number; tokens: number; rateSum: number; rateCount: number; ttfbSum: number; ttfbCount: number }>;
  ips: Map<string, { ip: string; requests: number; tokens: number; lastSeenAt: string | null; userAgent: string | null; active: boolean }>;
}

/**
 * One pass over a share family's events. Model ranking excludes names the grant
 * does not authorize; everything else counts every event.
 */
function rollupFamily(
  events: readonly TelemetryEventRecord[],
  bounds: { dayStart: number; monthStart: number; lastHourStart: number; windowStart: number; activeIpCutoff: number; allowed: ReadonlySet<string> | null },
): FamilyRollup {
  const totals = { requests: 0, errors: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, lastHourRequests: 0, todayTokens: 0, monthTokens: 0 };
  const byHour = new Map<string, { requests: number; tokens: number }>();
  const models: FamilyRollup["models"] = new Map();
  const ips: FamilyRollup["ips"] = new Map();
  for (const event of events) {
    const at = new Date(event.createdAt).getTime();
    const tokens = (event.inputTokens ?? 0) + (event.outputTokens ?? 0);
    totals.requests += 1;
    if (isGatewayError(event.status, event.httpStatus)) totals.errors += 1;
    totals.inputTokens += event.inputTokens ?? 0;
    totals.outputTokens += event.outputTokens ?? 0;
    totals.totalTokens += tokens;
    if (at >= bounds.lastHourStart) totals.lastHourRequests += 1;
    if (at >= bounds.dayStart) totals.todayTokens += tokens;
    if (at >= bounds.monthStart) totals.monthTokens += tokens;
    if (at >= bounds.windowStart) {
      const hour = new Date(Math.floor(at / HOUR_MS) * HOUR_MS).toISOString();
      const bucket = byHour.get(hour) ?? { requests: 0, tokens: 0 };
      bucket.requests += 1;
      bucket.tokens += tokens;
      byHour.set(hour, bucket);
    }
    if (event.requestedModel !== null && (bounds.allowed === null || modelAllowed(event.requestedModel, bounds.allowed))) {
      const model = models.get(event.requestedModel) ?? { modelId: event.requestedModel, requests: 0, tokens: 0, rateSum: 0, rateCount: 0, ttfbSum: 0, ttfbCount: 0 };
      model.requests += 1;
      model.tokens += tokens;
      if (event.tokensPerSec !== null) { model.rateSum += event.tokensPerSec; model.rateCount += 1; }
      if (event.ttfbMs !== null) { model.ttfbSum += event.ttfbMs; model.ttfbCount += 1; }
      models.set(event.requestedModel, model);
    }
    if (event.clientIp !== null) {
      const ip = ips.get(event.clientIp) ?? { ip: event.clientIp, requests: 0, tokens: 0, lastSeenAt: null, userAgent: null, active: false };
      ip.requests += 1;
      ip.tokens += tokens;
      // Events arrive newest first, so the first one seen is the most recent.
      if (ip.lastSeenAt === null) {
        ip.lastSeenAt = event.createdAt;
        ip.userAgent = event.userAgent;
        ip.active = at >= bounds.activeIpCutoff;
      }
      ips.set(event.clientIp, ip);
    }
  }
  return { totals, byHour, models, ips };
}

function emptyStats(
  recipients: { readonly total: number; readonly active: number },
): ShareFamilyStats {
  return {
    totals: {
      requests: 0,
      errors: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      lastHourRequests: 0,
      todayTokens: 0,
      monthTokens: 0,
    },
    recipients,
    hourly: [],
    models: [],
    clientIps: [],
  };
}

/**
 * Row ceilings for the two ranked tables. The share page shows a fixed window
 * of rows and scrolls the rest, so the cap is a payload bound, not a display
 * one: high enough that an ordinary link shows everything, low enough that a
 * link with thousands of client addresses cannot return an unbounded payload.
 */
const TOP_MODELS_LIMIT = 50;
const TOP_IPS_LIMIT = 50;
const HOURS_WINDOW = 24;

/**
 * Cache lifetime for one family's rollup.
 *
 * Matched to the share page's SSE tick, which was the point of the old 2 s
 * value — but at 2 s the cache expired on every tick, so every single push was
 * a full parse of the retained telemetry window. A share page's numbers move
 * when a request does, not every 2 s; 10 s still reads as live, and cuts the
 * parse rate by five.
 *
 * Declared here rather than imported from the router so this port does not
 * depend on it. `SHARE_STATS_STREAM_INTERVAL_MS` must be raised with it, or
 * the two drift apart and the cache expires between ticks for no reason.
 */
export const SHARE_STATS_CACHE_TTL_SECONDS = 10;

/**
 * Cache key for one family's rollup. The family is named by its template key
 * and the number of keys it covers — both change the payload — and
 * `allowedModels` filters the model table, so all three are hashed in.
 * (The key used to hash the sorted list of every family id; on a family with
 * tens of thousands of minted children that built and sorted a multi-megabyte
 * string on every page view, before the cache could even answer.)
 */
function shareFamilyStatsKey(
  tenantId: string,
  family: { readonly templateKeyId: string; readonly memberCount: number },
  allowedModels: readonly string[] | undefined,
): string {
  const models = allowedModels === undefined ? "*" : [...allowedModels].sort().join(",");
  const hash = createHash("sha256")
    .update(`${family.templateKeyId}#${family.memberCount}|${models}`)
    .digest("hex");
  return `share:v1:stats:${tenantId}:${hash}`;
}

/** Cap on the bounded SQL read a family rollup performs. */
const MAX_FAMILY_EVENTS = 5_000;

interface ShareStatsPortDeps {
  readonly db: CartethyiaDatabase;
  readonly redis?: RedisClient | undefined;
}

export function createShareStatsPort(deps: ShareStatsPortDeps): ShareStatsPort {
  return {
    async getFamilyStats(tenantId, family, recipients, allowedModels) {
      if (family.templateKeyId.length === 0) return emptyStats(recipients);
      const cached = await cachedRead<Omit<ShareFamilyStats, "recipients">>(
        deps.redis,
        shareFamilyStatsKey(tenantId, family, allowedModels),
        () => computeFamilyStatsBody(deps.db, tenantId, family.templateKeyId, allowedModels),
        SHARE_STATS_CACHE_TTL_SECONDS,
      );
      return { ...cached, recipients };
    },
  };
}

/** The telemetry-derived remainder of a family rollup; `recipients` is Postgres-derived. */
async function computeFamilyStatsBody(
  db: CartethyiaDatabase,
  tenantId: string,
  templateKeyId: string,
  allowedModels: readonly string[] | undefined,
): Promise<Omit<ShareFamilyStats, "recipients">> {
  // A share that grants a fixed set ranks only that set. Telemetry keeps the
  // requested name even when the request was refused for naming a model the
  // key may not use, so an unfiltered table would list exactly the invalid
  // names an abuser probed. `null` means the link is unrestricted.
  const allowedSet = allowedModels === undefined ? null : new Set(allowedModels);

  const now = new Date();
  const dayStart = utcDayStart(now);
  const monthStart = utcMonthStart(now);
  const hourStart = utcHourStart(now);
  const lastHourStart = new Date(now.getTime() - HOUR_MS);
  const windowStart = new Date(hourStart.getTime() - (HOURS_WINDOW - 1) * HOUR_MS);

  // All-time and today's/month's spend come from SQL aggregates, not from the
  // bounded page below. The page is capped so a very large family cannot pull
  // the whole table, which means it cannot carry the all-time total. Lifetime,
  // daily, and monthly are therefore separate bounded sums over the retained
  // SQL window (each is a single `SUM` aggregate, not a row materialization).
  // The page's events feed only the two ranked tables.
  //
  // Requests/errors/last-hour are likewise SQL counts: the page read is capped
  // at 500 events, so deriving them from it would freeze a busy family's KPI
  // at 500 no matter how much traffic actually flowed.
  const [totalTokens, todayTokens, monthTokens, template, usage] = await Promise.all([
    sumTelemetryTokens(db, tenantId, { familyKeyId: templateKeyId, since: new Date(0) }),
    sumTelemetryTokens(db, tenantId, { familyKeyId: templateKeyId, since: dayStart }),
    sumTelemetryTokens(db, tenantId, { familyKeyId: templateKeyId, since: monthStart }),
    db
      .select({ lifetime: apiKeys.lifetimeTokensConsumed })
      .from(apiKeys)
      .where(eq(apiKeys.id, templateKeyId))
      .limit(1),
    familyUsageTotals(db, tenantId, templateKeyId, now),
  ]);
  // Cumulative family spend: the template's own counter plus the telemetry
  // total. The counter is a manually-configured seed (an operator limit), not
  // traffic, and it is never reset; azmetry rows for revoked/deleted children
  // likewise stay counted, so the running total is monotonic and consistent
  // across the overview, the share dialog, and this page.
  const templateLifetime = Number(template[0]?.lifetime ?? 0);

  // The ranked tables need real events, bounded to the 24-hour window. The
  // totals and hourly chart are computed in SQL, so the page cap here only
  // shapes the model/IP rankings — never the KPI numbers.
  const page = await querySqlEvents(db, {
    tenantId,
    familyApiKeyId: templateKeyId,
    since: windowStart,
    limit: MAX_FAMILY_EVENTS,
  });
  const events = page.events;
  const rollup = rollupFamily(events, {
    dayStart: dayStart.getTime(),
    monthStart: monthStart.getTime(),
    lastHourStart: lastHourStart.getTime(),
    windowStart: windowStart.getTime(),
    activeIpCutoff: now.getTime() - ACTIVE_IP_WINDOW_MS,
    allowed: allowedSet,
  });
  rollup.totals = {
    ...rollup.totals,
    // The template counter is the seed on the running total, not a distinct
    // bucket: daily/monthly windows are telemetry-only (the counter has no
    // time axis), so those keep their own sums.
    totalTokens: templateLifetime + totalTokens,
    todayTokens,
    monthTokens,
    // SQL counts replace the page-derived ones: a family busier than the page
    // cap must not freeze at 500 requests/errors.
    requests: usage.requests,
    errors: usage.errors,
    lastHourRequests: usage.lastHourRequests,
  };

  // The hourly chart is a SQL aggregate over the whole family window, so a
  // busy family's bars stay true. Buckets are filled in JS because only hours
  // that saw traffic are present; a chart drawn from sparse rows would
  // silently compress the axis.
  const bucketSeconds = HOUR_MS / 1000;
  const sqlHourly = await familyHourlyTelemetry(db, tenantId, templateKeyId, windowStart, bucketSeconds);
  const byHour = new Map(
    sqlHourly.map((bucket) => [
      new Date(bucket.at).toISOString(),
      { requests: bucket.requests, tokens: bucket.inputTokens + bucket.outputTokens },
    ]),
  );
  const hourly: ShareHourlyBucket[] = [];
  for (let index = 0; index < HOURS_WINDOW; index += 1) {
    const hour = new Date(windowStart.getTime() + index * HOUR_MS).toISOString();
    const bucket = byHour.get(hour);
    hourly.push({ hour, requests: bucket?.requests ?? 0, tokens: bucket?.tokens ?? 0 });
  }

  // Client IPs come from a SQL aggregate over the whole retained window, so an
  // address that stopped before the 24-hour chart window still appears —
  // marked inactive. `clientType` is best-effort from the page's events (the
  // most recent 24 hours), which carry the User-Agent.
  const ipRows = await familyIpBreakdown(db, tenantId, templateKeyId, TOP_IPS_LIMIT);
  const clientTypeByIp = new Map<string, string | null>();
  for (const event of events) {
    if (event.clientIp !== null && !clientTypeByIp.has(event.clientIp)) {
      clientTypeByIp.set(event.clientIp, clientTypeFromUserAgent(event.userAgent));
    }
  }
  const activeIpCutoff = now.getTime() - ACTIVE_IP_WINDOW_MS;
  const clientIps = ipRows.map((row) => {
    const lastSeenAt =
      row.lastSeenAt instanceof Date ? row.lastSeenAt : new Date(String(row.lastSeenAt ?? ""));
    const lastSeenMs = Number.isFinite(lastSeenAt.getTime()) ? lastSeenAt.getTime() : 0;
    return {
      ip: maskClientIp(row.ip),
      requests: row.requests,
      tokens: row.tokens,
      lastSeenAt: lastSeenMs > 0 ? lastSeenAt.toISOString() : null,
      clientType: clientTypeByIp.get(row.ip) ?? null,
      active: lastSeenMs >= activeIpCutoff,
    };
  });

  return {
    totals: rollup.totals,
    hourly,
    models: [...rollup.models.values()]
      .sort((a, b) => b.requests - a.requests)
      .slice(0, TOP_MODELS_LIMIT)
      .map((row) => ({
        modelId: row.modelId,
        requests: row.requests,
        tokens: row.tokens,
        avgTokensPerSec: row.rateCount > 0 ? row.rateSum / row.rateCount : null,
        avgTtfbMs: row.ttfbCount > 0 ? Math.round(row.ttfbSum / row.ttfbCount) : null,
      })),
    clientIps,
  };
}
