/**
 * Real credit deductions for the Tencent "buddy" family (`cb`, `cbcn`). *
 * Every provider in the family reads the same usage-detail endpoint —
 * `POST {billingHost}/billing/meter/get-user-request-usage` — which answers the
 * actual per-request deductions the billing meter recorded: when the request
 * happened, which model served it, and how many credits it cost. That is the
 * figure the reference gateways show as *real usage*, and until now we had no
 * upstream usage-detail read at all: the console's usage view was built from
 * synthetic activity events we report ourselves.
 *
 * This module is read-only and never throws. A usage read is a display
 * concern, and a failure to read it must never take an account out of
 * rotation or fail a request — so an unreachable, malformed, or empty response
 * yields whatever was collected plus `partial: true`, and an account with no
 * usage at all yields empty rows rather than an error.
 */
import type { FetchLike } from "../../quota/quota-contracts";
import { record as asRecord, text as asText } from "../../quota/quota-contracts";
import { resolveBearerToken } from "./buddy-quota-shared";

/** One aggregated (day, model) credit deduction. */
export interface BuddyUsageRow {
  /** Calendar day the request was metered on, `YYYY-MM-DD`. */
  readonly day: string;
  /** The model id the upstream metered it against. */
  readonly model: string;
  /** Credits deducted for every request on that (day, model). */
  readonly credit: number;
}

export interface BuddyUsageResult {
  readonly rows: readonly BuddyUsageRow[];
  /** Sum of every row's credits. */
  readonly totalCredits: number;
  /**
   * True when the read stopped short: a page failed, the page cap was reached,
   * or the payload was not the expected shape. The rows are what was collected
   * and are still worth showing — they are just not guaranteed to be all of it.
   */
  readonly partial: boolean;
}

export interface BuddyUsageFetchOptions {
  /** `{billingHost}/billing/meter/get-user-request-usage` for this provider. */
  readonly url: string;
  /** Provider transport/identity headers; `Authorization` is added here. */
  readonly headers: Record<string, string>;
  readonly credential: string;
  readonly fetcher: FetchLike;
  /** Window width in days, clamped to the upstream's 30-day maximum. */
  readonly days: number;
  /** Account UID for the `X-User-Id` billing identity header. */
  readonly uid?: string | undefined;
}

/** The upstream answers empty totals beyond its own window. */
const USAGE_MAX_DAYS = 30;
const USAGE_PAGE_SIZE = 200;
const USAGE_MAX_PAGES = 30;
const TIMEOUT_MS = 15_000;

/** `YYYY-MM-DD HH:MM:SS` in local time, the stamp format the endpoint takes. */
function localStamp(at: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return (
    `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ` +
    `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`
  );
}

/**
 * Reads one provider's usage detail over the last `days` days.
 *
 * Paginated, because the endpoint answers at most {@link USAGE_PAGE_SIZE} rows
 * per call and an active account exceeds that quickly. The loop stops as soon
 * as a page comes back short or the upstream's own `total` is accounted for;
 * running into the page cap instead sets `partial`, so the console can say so
 * rather than presenting a truncated figure as the whole one.
 *
 * `days` is sent alongside the time window: the reference gateway sends
 * `startTime`/`endTime`, and the day count is what our own callers think in, so
 * both go on the wire rather than making one side convert.
 */
export async function fetchBuddyRequestUsage(
  options: BuddyUsageFetchOptions,
): Promise<BuddyUsageResult> {
  const { url, headers, credential, fetcher, uid } = options;
  const bearer = resolveBearerToken(credential);
  if (bearer === null) return { rows: [], totalCredits: 0, partial: true };

  const days = Math.max(1, Math.min(Math.floor(options.days) || USAGE_MAX_DAYS, USAGE_MAX_DAYS));
  const now = Date.now();
  const window = {
    days,
    startTime: localStamp(new Date(now - days * 86_400_000)),
    endTime: localStamp(new Date(now)),
  };

  const rows: BuddyUsageRow[] = [];
  // (day, model) → index into `rows`, so a model seen on two pages aggregates
  // into one row instead of being listed twice.
  const index = new Map<string, number>();
  let totalCredits = 0;
  let partial = false;
  // Raw request rows seen, which is what the upstream's `total` counts — not
  // the aggregated (day, model) rows above.
  let requests = 0;

  for (let page = 1; page <= USAGE_MAX_PAGES; page += 1) {
    const pageResult = await fetchUsagePage({
      url,
      headers,
      bearer,
      fetcher,
      uid,
      body: { ...window, pageNum: page, pageSize: USAGE_PAGE_SIZE },
    });
    // A page that could not be read ends the walk with what is already
    // collected: the rows are real, there are just fewer of them.
    if (pageResult === null) {
      partial = true;
      break;
    }
    const { pageRows, total } = pageResult;
    for (const row of pageRows) {
      const key = `${row.day}\u0000${row.model}`;
      const at = index.get(key);
      if (at === undefined) {
        index.set(key, rows.length);
        rows.push(row);
      } else {
        rows[at] = { ...row, credit: round6(rows[at]!.credit + row.credit) };
      }
      totalCredits += row.credit;
    }
    // An empty page means the end of the data, however many the upstream said
    // it had; carrying on would only re-request it.
    if (pageRows.length === 0) break;
    requests += pageRows.length;
    if (total !== undefined && requests >= total) break;
    // A short page has no more to give, and the upstream's `total` is not
    // always present: stopping here avoids one pointless round trip per read.
    if (pageRows.length < USAGE_PAGE_SIZE) break;
    // Only reaching the page cap means more may exist than we collected.
    if (page === USAGE_MAX_PAGES) partial = true;
  }

  return { rows, totalCredits: Math.round(totalCredits * 100) / 100, partial };
}

interface UsagePage {
  readonly pageRows: readonly BuddyUsageRow[];
  /** The upstream's stated request total, when it stated one. */
  readonly total: number | undefined;
}

/** One page of the usage-detail endpoint, or `null` when it could not be read. */
async function fetchUsagePage(args: {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly bearer: string;
  readonly fetcher: FetchLike;
  readonly uid: string | undefined;
  readonly body: Record<string, unknown>;
}): Promise<UsagePage | null> {
  let response: Response;
  try {
    response = await args.fetcher(args.url, {
      method: "POST",
      headers: {
        ...args.headers,
        ...(args.uid === undefined || args.uid.length === 0 ? {} : { "X-User-Id": args.uid }),
        Authorization: `Bearer ${args.bearer}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(args.body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(await response.text());
  } catch {
    return null;
  }
  const envelope = asRecord(parsed);
  // A non-zero `code` is a provider-side error even on HTTP 200.
  if (envelope !== null && "code" in envelope) {
    const code = Number(envelope["code"]);
    if (Number.isFinite(code) && code !== 0) return null;
  }
  const data = asRecord(envelope?.["data"]) ?? envelope;
  const list = data?.["data"];
  // Missing business data must not read as "zero usage": an account that has
  // spent nothing and an account whose payload we could not parse must not
  // look the same.
  if (!Array.isArray(list)) return null;

  const pageRows: BuddyUsageRow[] = [];
  for (const entry of list) {
    const row = asRecord(entry);
    if (row === null) continue;
    const day = (asText(row["requestTime"]) ?? "").slice(0, 10);
    if (day.length === 0) continue;
    const model = asText(row["model"]) ?? "unknown";
    const credit = Number(row["credit"] ?? 0);
    pageRows.push({ day, model, credit: Number.isFinite(credit) ? round6(credit) : 0 });
  }
  const rawTotal = data?.["total"];
  const total = typeof rawTotal === "number" && Number.isFinite(rawTotal) ? rawTotal : undefined;
  return { pageRows, total };
}

function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}
