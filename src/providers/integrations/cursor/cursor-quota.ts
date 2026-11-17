/**
 * Cursor quota: the two account surfaces and the plan-info weekly reset.
 *
 * Cursor reports usage on two surfaces and neither is authoritative alone:
 *
 * - `{api}/auth/usage` is the request-count API from before usage-based
 *   plans. Current plans answer it with an uncapped, always-zero `gpt-4`
 *   bucket, so a naive read reports "no usage" for an account that is in fact
 *   spending against a dollar cap. It remains the only surface a raw `crsr_`
 *   key is guaranteed to reach.
 * - `cursor.com/api/usage-summary` is the current surface: `individualUsage`
 *   with `overall`, `plan` and `onDemand` buckets in USD cents, reachable only
 *   through the session cookie `WorkosCursorSessionToken`.
 *
 * When the summary answers, its dollar windows ARE the reading and the legacy
 * buckets are dropped: the surfaces count different currencies (requests vs
 * dollars) and routing gates an account by the lowest remaining percent across
 * its windows, so one mixed list would cross-gate one currency with the other.
 * The legacy parse keeps its own empty-bucket suppression for the api-key
 * path, where it is the only reading there is.
 *
 * Two plan families split the summary differently (the reference
 * implementation's analysis of live dashboards):
 *
 * - `membershipType: "unified_*"` (X Subscription) bills as ONE weekly pool
 *   shared by the Cursor-owned models (Grok, Composer, Auto) plus prepaid
 *   credit for third-party models, metered by `onDemand` and charged from the
 *   first request. The weekly reset is not in the summary — only `GetPlanInfo`
 *   carries it.
 * - Classic Pro/Pro+/Ultra plans expose separate included rails:
 *   `autoPercentUsed` ("Cursor Models") and `apiPercentUsed` ("Other Models").
 *   Both stay PERCENTAGES — `plan.limit` is not the Other Models pool size, so
 *   percent × limit would report $193.76 of $400 for an account whose real
 *   third-party spend was $48.44 of a $100 pool.
 *
 * Summary amounts arrive in USD cents and are reported as USD. The two named
 * rails serve disjoint model families, which `filterCandidateQuotaWindows`
 * scopes by kind (`candidate-evaluation.ts`); a prepaid balance of zero must
 * not mark a Grok request exhausted.
 *
 * A surface that stays quiet is a downgrade, not a failure: the windows the
 * other surfaces produced are still the account's reading, and every consumer
 * reads a non-null `error` as *no usable reading at all* (the refresh endpoint
 * answers 502, the cache discards the fresh read, the console card shows
 * "error"). Quiet surfaces are therefore logged and `error` is only set when
 * no window was produced.
 */
import {
  cleanError,
  getJson,
  isoDate,
  number,
  percentWindow,
  quotaRecord,
  record,
  text,
  type FetchLike,
  type ProviderQuotaResult,
  type ProviderQuotaWindow,
} from "../../quota/quota-contracts";
import type { QuotaCollectionContext } from "../../quota/quota-support";
import { log } from "../../../observability/logger";
import { fnv1a32 } from "../shared/hash";
import { cursorAccountIdentity } from "./cursor-auth";
import {
  CURSOR_API_BASE_URL,
  CURSOR_AUTH_USAGE_PATH,
  CURSOR_GET_PLAN_INFO_PATH,
  CURSOR_USAGE_SUMMARY_PATH,
  CURSOR_WEBSITE_BASE_URL,
} from "./cursor-wire";

// ── window reset ──

/** Timestamp keys naming the end of the current window. */
const RESET_END_KEYS: readonly string[] = ["billingCycleEnd", "endOfMonth", "resetsAt", "nextReset"];

/** Timestamp keys naming the start, which imply a window one month long. */
const RESET_START_KEYS: readonly string[] = ["startOfMonth", "billingCycleStart", "startOfBillingCycle"];

/**
 * The window's reset, or `null`.
 *
 * A start timestamp implies a monthly window, so it is advanced by one month
 * rather than reported as-is — reporting the start as the reset would say the
 * window had already lapsed.
 */
function resetsAt(source: Record<string, unknown>): string | null {
  for (const key of RESET_END_KEYS) {
    const value = isoDate(source[key]);
    if (value) return value;
  }
  for (const key of RESET_START_KEYS) {
    const value = isoDate(source[key]);
    if (!value) continue;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) continue;
    date.setUTCMonth(date.getUTCMonth() + 1);
    return date.toISOString();
  }
  return null;
}

// ── bucket reading ──

/** A bucket's raw numbers in the unit the surface reports (cents or counts). */
interface BucketAmounts {
  readonly used: number | null;
  readonly limit: number | null;
  readonly remaining: number | null;
}

/** Reads one legacy bucket, accepting the historical key spellings. */
function readLegacyBucket(source: Record<string, unknown>): BucketAmounts {
  return {
    limit: number(source["limit"] ?? source["maxRequestUsage"] ?? source["amountLimit"] ?? source["usdLimit"]),
    used: number(source["used"] ?? source["numRequests"] ?? source["amountUsed"] ?? source["usdUsed"]),
    remaining: number(source["remaining"]),
  };
}

/** `used`, derived from `limit - remaining` when the surface omits it. */
function usedFrom(bucket: BucketAmounts): number | null {
  return bucket.used ?? (bucket.remaining !== null && bucket.limit !== null ? bucket.limit - bucket.remaining : null);
}

/**
 * A summary bucket in USD cents, reported as USD.
 *
 * A disabled bucket is absent, not empty. A bucket with no cap but recorded
 * usage is emitted used-only rather than dropped — dropping it would collapse
 * the account to "no usage data". A bucket with a defined non-positive limit
 * is malformed and skipped; the prepaid-off case is constructed explicitly
 * where it is meaningful (see {@link parseUnifiedUsage}).
 */
function usdWindow(
  kind: string,
  label: string,
  source: Record<string, unknown>,
  reset: string | null,
  accounting: "pooled" | "independent",
): ProviderQuotaWindow | null {
  if (source["enabled"] === false) return null;
  const rawLimit = source["limit"];
  const limitCents = number(rawLimit);
  const reportedUsed = number(source["used"]);
  const reportedRemaining = number(source["remaining"]);

  if (rawLimit === undefined || rawLimit === null) {
    if (reportedUsed === null || reportedUsed < 0) return null;
    return percentWindow(kind, label, null, reset, reportedUsed / 100, null, accounting);
  }
  if (limitCents === null || limitCents <= 0) return null;
  let usedCents: number;
  if (reportedUsed !== null && reportedUsed > 0) {
    usedCents = reportedUsed;
  } else if (reportedRemaining !== null && reportedRemaining >= 0 && reportedRemaining < limitCents) {
    usedCents = Math.max(0, limitCents - reportedRemaining);
  } else if (reportedUsed !== null && reportedUsed >= 0) {
    usedCents = reportedUsed;
  } else {
    return null;
  }
  const percent = (usedCents / limitCents) * 100;
  return percentWindow(kind, label, percent, reset, usedCents / 100, limitCents / 100, accounting);
}

/**
 * One legacy request-count bucket.
 *
 * The bucket names the model it meters, so the window carries that model id
 * and routing only lets it gate the matching candidate — a `gpt-4` bucket
 * cross-gating a Claude request would mark the account exhausted for Claude
 * when Claude capacity is untouched. Exact ids only: a bucket key that names
 * a family umbrella matches no route and stays display-only, which is the
 * safe direction (no wrong cross-model gating).
 */
function legacyWindow(key: string, source: Record<string, unknown>, reset: string | null): ProviderQuotaWindow | null {
  const bucket = readLegacyBucket(source);
  const limit = bucket.limit;
  const used = usedFrom(bucket);
  if (used === null && limit === null) return null;
  // A bucket with no cap and nothing used is not a balance. Usage-based plans
  // answer this surface with `gpt-4: {numRequests: 0, maxRequestUsage: null}`
  // while their real spend sits on the summary — showing the empty row would
  // put a meaningless "gpt-4 requests" window above the number that matters.
  if (limit === null && (used ?? 0) === 0) return null;

  const isUsd = key === "planUsage" || /usd|billing|stripe/i.test(key);
  const clean = key.toLowerCase().trim();
  const percent = used !== null && limit !== null && limit > 0 ? (used / limit) * 100 : null;
  const window = percentWindow(
    isUsd ? `cursor:usd:${clean}` : `cursor:requests:${clean}`,
    isUsd ? `${key} spend` : `${key} requests`,
    percent,
    reset,
    used,
    limit,
    "independent",
  );
  return isUsd ? window : { ...window, modelIds: [clean] };
}

/** The legacy `/auth/usage` shape: one object per request bucket. */
export function parseLegacyUsage(payload: unknown): readonly ProviderQuotaWindow[] {
  const root = quotaRecord(payload);
  const reset = resetsAt(root);
  const windows: ProviderQuotaWindow[] = [];
  for (const [key, value] of Object.entries(root)) {
    const bucket = record(value);
    if (!bucket) continue;
    const window = legacyWindow(key, bucket, reset);
    if (window) windows.push(window);
  }
  return windows;
}

// ── summary surface ──

/** A parsed summary: the windows plus the account's plan name. */
export interface CursorSummaryRead {
  readonly windows: readonly ProviderQuotaWindow[];
  readonly plan: string | null;
}

/** The X Subscription bills differently from legacy Cursor plans. */
function isUnifiedMembership(root: Record<string, unknown>): boolean {
  const membership = root["membershipType"];
  return typeof membership === "string" && membership.startsWith("unified_");
}

/**
 * The unified weekly pool: one included pool shared by the Cursor-owned
 * models (Grok, Composer, Auto).
 *
 * The pool is a weekly rate limit, so it stays `independent` — a weekly
 * budget must not be added to credit packs. Its reset comes from GetPlanInfo;
 * without one the window reports the balance and no deadline.
 */
function unifiedPool(plan: Record<string, unknown>, weeklyResetsAt: string | null): ProviderQuotaWindow | null {
  if (plan["enabled"] === false) return null;
  const limitCents = number(plan["limit"]);
  const usedCents = number(plan["used"]);
  const percent = number(plan["totalPercentUsed"]);
  if (limitCents === null || limitCents <= 0) {
    if (percent === null) return null;
    const value = Math.max(0, percent);
    return percentWindow("cursor:usd:individual-auto", "Cursor Models", value, weeklyResetsAt, null, null, "independent");
  }
  const limitUsd = limitCents / 100;
  // The dashboard's percent and the cents meter can disagree slightly; the
  // larger reading is the honest one for what has been consumed.
  const fraction = Math.max(percent !== null ? percent / 100 : 0, usedCents !== null ? usedCents / limitCents : 0, 0);
  return percentWindow(
    "cursor:usd:individual-auto",
    "Cursor Models",
    fraction * 100,
    weeklyResetsAt,
    Math.min(limitUsd, limitUsd * fraction),
    limitUsd,
    "independent",
  );
}

/**
 * Unified membership: the weekly pool plus the prepaid credit that funds
 * third-party models from the first request.
 *
 * Prepaid credit is real spendable value, so it is `pooled` (it contributes to
 * the account's remaining credit) and carries no calendar reset — pinning a
 * reset would keep an empty balance visible as "not yet reset" instead of
 * "top it up". Credit that is off or empty is emitted as a spent balance
 * (`0 / 0`, fully consumed): third-party models are refused until it is
 * topped up, and the family scoping in `filterCandidateQuotaWindows` keeps
 * that refusal away from the Cursor-owned models the weekly pool still funds.
 */
function parseUnifiedUsage(individual: Record<string, unknown>, weeklyResetsAt: string | null): readonly ProviderQuotaWindow[] {
  const windows: ProviderQuotaWindow[] = [];
  const plan = record(individual["plan"]);
  const pool = plan ? unifiedPool(plan, weeklyResetsAt) : null;
  if (pool) windows.push(pool);

  const onDemand = record(individual["onDemand"]);
  if (onDemand && (onDemand["enabled"] === false || number(onDemand["limit"]) === 0)) {
    windows.push(percentWindow("cursor:usd:individual-api", "Other Models (prepaid credit)", 100, null, 0, 0, "pooled"));
  } else if (onDemand) {
    const window = usdWindow("cursor:usd:individual-api", "Other Models (prepaid credit)", onDemand, null, "pooled");
    if (window) windows.push(window);
  }
  return windows;
}

/**
 * The classic plan rails.
 *
 * `autoPercentUsed` and `apiPercentUsed` stay percentages: `plan.limit` is the
 * plan's own cap, not the size of either included pool (Cursor no longer
 * publishes the pool sizes), so converting percent to dollars through it would
 * invent balances. The rails therefore report percent only and carry no
 * used/limit amounts, like every other percent-only window. Only the fallback
 * rail (`totalPercentUsed`, the whole plan) may use the cap, because there the
 * percent is a percent OF that cap.
 */
function classicRails(plan: Record<string, unknown>, reset: string | null): readonly ProviderQuotaWindow[] {
  if (plan["enabled"] === false) return [];
  const limitCents = number(plan["limit"]);
  const limitUsd = limitCents !== null && limitCents > 0 ? limitCents / 100 : null;
  const autoPct = number(plan["autoPercentUsed"]);
  const apiPct = number(plan["apiPercentUsed"]);
  const totalPct = number(plan["totalPercentUsed"]);
  const windows: ProviderQuotaWindow[] = [];

  if (autoPct !== null) {
    const value = Math.max(0, autoPct);
    windows.push(percentWindow("cursor:usd:individual-auto", "Cursor Models", value, reset, null, null, "independent"));
  }
  if (apiPct !== null) {
    const value = Math.max(0, apiPct);
    windows.push(percentWindow("cursor:usd:individual-api", "Other Models", value, reset, null, null, "independent"));
  }
  if (autoPct === null && apiPct === null) {
    if (totalPct !== null) {
      const value = Math.max(0, totalPct);
      windows.push(
        limitUsd !== null
          ? percentWindow("cursor:usd:individual-plan", "Personal Usage", value, reset, limitUsd * (value / 100), limitUsd, "independent")
          : percentWindow("cursor:usd:individual-plan", "Personal Usage", value, reset, null, null, "independent"),
      );
    } else {
      const window = usdWindow("cursor:usd:individual-plan", "Personal Usage", plan, reset, "independent");
      if (window) windows.push(window);
    }
  }
  return windows;
}

/**
 * Parses `/api/usage-summary`.
 *
 * Enterprise/team dashboards historically exposed `individualUsage.overall`;
 * current classic dashboards expose `plan` (plus optional `onDemand`). A
 * usable overall bucket wins over the plan rails; on-demand is kept either
 * way when it carries a real cap, because it is the part of the bill that
 * grows. Unified memberships take {@link parseUnifiedUsage} instead.
 *
 * `weeklyResetsAt` applies only to the unified weekly pool (from GetPlanInfo).
 */
export function parseUsageSummary(payload: unknown, weeklyResetsAt: string | null = null): CursorSummaryRead {
  const root = record(payload) ?? {};
  const individual = record(root["individualUsage"]);
  if (!individual) return { windows: [], plan: null };
  const planName = text(individual["planName"] ?? root["membershipType"]);

  if (isUnifiedMembership(root)) {
    return { windows: parseUnifiedUsage(individual, weeklyResetsAt), plan: planName };
  }

  const reset = resetsAt(root);
  const windows: ProviderQuotaWindow[] = [];
  const overall = record(individual["overall"]);
  let usedOverall = false;
  if (overall) {
    const window = usdWindow("cursor:usd:individual-overall", "Personal Usage", overall, reset, "independent");
    if (window) {
      windows.push(window);
      usedOverall = true;
    }
  }
  const plan = record(individual["plan"]);
  if (!usedOverall && plan) {
    windows.push(...classicRails(plan, reset));
  }
  const onDemand = record(individual["onDemand"]);
  if (onDemand) {
    const window = usdWindow("cursor:usd:individual-ondemand", "On-Demand Usage", onDemand, reset, "pooled");
    // Only a meter with a real cap is a balance; an uncapped spend count is
    // not a quota.
    if (window && typeof window.limit === "number" && window.limit > 0) windows.push(window);
  }
  return { windows, plan: planName };
}

// ── account identity ──

function authStateUserId(context: QuotaCollectionContext | undefined): string | undefined {
  const raw = context?.auth_state ?? {};
  for (const key of ["userId", "user_id", "uid", "sub"] as const) {
    const value = raw[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

/**
 * A stable display identity derived from the credential.
 *
 * Cursor's access token carries the account's real subject
 * (`google-oauth2|user_01K3…`), which is an identity, not a name. It is
 * reduced to a short opaque tag so the console can tell two Cursor accounts
 * apart without publishing either one's subject. Derived rather than random,
 * so the same account keeps the same tag across refreshes; a tag that changed
 * every read would be worse than showing the subject it replaces.
 */
function cursorAccountTag(credential: string): string {
  return `cursor-${fnv1a32(credential).toString(36).padStart(7, "0").slice(0, 7)}`;
}

// ── fetching ──

/**
 * The X Subscription weekly pool reset (`planInfo.includedUsageResetsAt`).
 *
 * The summary does not carry it; only GetPlanInfo does. The reference client
 * calls this unary with Connect's JSON encoding (empty request, one scalar
 * read back) — the DashboardService messages are not part of the vendored
 * Agent proto set, and inventing field numbers for them would pin this client
 * to a schema it cannot verify. A failed read degrades to a reset-less pool
 * window and is logged with the other quiet surfaces.
 */
async function fetchWeeklyResetsAt(
  baseUrl: string,
  credential: string,
  fetcher: FetchLike,
  errors: string[],
): Promise<string | null> {
  try {
    const payload = await getJson(
      `${baseUrl}${CURSOR_GET_PLAN_INFO_PATH}`,
      { authorization: `Bearer ${credential}`, "connect-protocol-version": "1" },
      fetcher,
      {},
    );
    const planInfo = record(record(payload)?.["planInfo"]);
    return isoDate(planInfo?.["includedUsageResetsAt"]);
  } catch (error) {
    errors.push(`plan-info: ${cleanError(error)}`);
    return null;
  }
}

/**
 * Reads one Cursor account's quota.
 *
 * The summary is preferred when it answers, because the legacy surface reports
 * a permanently-zero bucket on exactly the plans that have a dollar cap. The
 * legacy read is still attempted: it is the only surface an api-key account
 * can reach. The summary is attempted for every credential kind that resolves
 * a user id — gating it on `credential_kind` would leave api-key rows showing
 * only the zero `gpt-4` bucket on plans whose real spend sits in dollars.
 */
export async function fetchCursorQuota(
  credential: string,
  fetcher: FetchLike,
  context?: QuotaCollectionContext,
): Promise<ProviderQuotaResult> {
  const raw = context?.auth_state ?? {};
  const baseUrl =
    typeof raw["apiEndpoint"] === "string" && raw["apiEndpoint"].trim()
      ? raw["apiEndpoint"].trim().replace(/\/+$/, "")
      : CURSOR_API_BASE_URL;
  const errors: string[] = [];

  const legacy = await getJson(`${baseUrl}${CURSOR_AUTH_USAGE_PATH}`, { authorization: `Bearer ${credential}` }, fetcher).then(
    (payload) => parseLegacyUsage(payload),
    (error: unknown) => {
      errors.push(`auth/usage: ${cleanError(error)}`);
      return null;
    },
  );

  // The summary authenticates by session cookie, not bearer: it answers 401
  // `not_authenticated` for every Authorization header, including a valid one.
  // The cookie is the user id and the token joined by `::`. It only exists on
  // the default host, and it needs the user id out of the access token.
  const userId = cursorAccountIdentity(credential) ?? authStateUserId(context);
  let summary: CursorSummaryRead | null = null;
  if (userId && baseUrl === CURSOR_API_BASE_URL) {
    const payload = await getJson(
      `${CURSOR_WEBSITE_BASE_URL}${CURSOR_USAGE_SUMMARY_PATH}`,
      { cookie: `WorkosCursorSessionToken=${encodeURIComponent(`${userId}::${credential}`)}` },
      fetcher,
    ).then(
      (value) => value,
      (error: unknown) => {
        errors.push(`usage-summary: ${cleanError(error)}`);
        return null;
      },
    );
    if (payload !== null) {
      const root = record(payload) ?? {};
      // The X Subscription's weekly pool reset is not in the summary;
      // GetPlanInfo carries it, and only unified memberships have it.
      const weeklyResetsAt = isUnifiedMembership(root)
        ? await fetchWeeklyResetsAt(baseUrl, credential, fetcher, errors)
        : null;
      summary = parseUsageSummary(payload, weeklyResetsAt);
    }
  }

  const summaryWindows = summary?.windows ?? [];
  // Summary outranks legacy: it answers in the currency the plan bills, and
  // the two must not share one window list (routing gates by the lowest
  // remaining percent, which is meaningless across currencies). Legacy stays
  // the fallback when the summary is quiet.
  const windows = summaryWindows.length > 0 ? summaryWindows : (legacy ?? []);
  const accountLabel = cursorAccountTag(credential);

  if (windows.length === 0) {
    return {
      source: "cursor",
      plan: summary?.plan ?? null,
      windows: [],
      accountLabel,
      error: errors.join("; ") || "Cursor quota endpoints did not answer.",
    };
  }
  // A quiet surface is a downgrade, not a failure: the windows above are a
  // usable reading, and every consumer reads a non-null `error` as "no
  // reading at all" (the refresh endpoint answers 502, the cache discards
  // the fresh read, the console card shows "error"). Logged instead, so a
  // surface that never answers stays visible — e.g. a stale session cookie
  // hides the dollar balance while the bearer-authenticated legacy read
  // still answers.
  if (errors.length > 0) {
    log.warn("cursor: quota read degraded", { errors: errors.join("; ") });
  }
  return {
    source: "cursor",
    plan: summary?.plan ?? null,
    windows,
    accountLabel,
    error: null,
  };
}
