// Cursor quota.
//
// Two surfaces, and the second exists because the first is not authoritative
// on its own:
//
// - `{baseUrl}/auth/usage` is Cursor's request-count API. Current plans answer
//   it with an uncapped, always-zero `gpt-4` bucket, so a naive read of it
//   reports "no usage" for an account that is in fact spending against a
//   dollar cap.
// - `cursor.com/api/usage-summary` is the current surface: `individualUsage`
//   with `overall`, `plan` and `onDemand` buckets, in **USD cents**.
//
// The donor therefore reads both and prefers the summary when it answers. That
// preference is kept here: the legacy response is still the only one an api-key
// account can get, so it cannot simply be dropped, but it must not be allowed
// to overwrite a real dollar balance with a zero.
//
// The summary is only reachable for an OAuth account on the default host, and
// it needs the user id out of the access token — which is why it is attempted
// conditionally rather than assumed.

import type {
  FetchLike,
  ProviderQuotaResult,
  ProviderQuotaWindow,
} from "../../quota/quota-contracts";
import {
  cleanError,
  isoDate,
  number,
  percentWindow,
  quotaRecord,
  record,
  text,
} from "../../quota/quota-contracts";
import type { QuotaCollectionContext } from "../../quota/quota-support";
import { cursorAccountIdentity } from "./cursor-auth";
import { fnv1a32 } from "../shared/hash";
import { CURSOR_API_HOST, CURSOR_WEBSITE_HOST } from "./cursor-shared";

/** Timestamp keys naming the end of the current window. */
const RESET_END_KEYS: readonly string[] = [
  "billingCycleEnd",
  "endOfMonth",
  "resetsAt",
  "nextReset",
];

/** Timestamp keys naming the start, which imply a window one month long. */
const RESET_START_KEYS: readonly string[] = [
  "startOfMonth",
  "billingCycleStart",
  "startOfBillingCycle",
];

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

/**
 * A Cursor cents bucket: `used`/`limit`/`remaining` in USD cents.
 *
 * An absent limit is a real shape, not a broken one — some plans carry no cap
 * and only report what has been spent. Those are emitted used-only rather than
 * dropped, which would collapse an account to "no usage data".
 */
function centsWindow(
  kind: string,
  label: string,
  source: Record<string, unknown>,
  reset: string | null,
): ProviderQuotaWindow | null {
  const limit = number(source["limit"] ?? source["maxRequestUsage"] ?? source["amountLimit"] ?? source["usdLimit"]);
  const used = number(source["used"] ?? source["numRequests"] ?? source["amountUsed"] ?? source["usdUsed"]);
  const remaining = number(source["remaining"]);
  if (used === null && remaining === null && limit === null) return null;
  const usedValue = used ?? (remaining !== null && limit !== null ? limit - remaining : null);
  return percentWindow(kind, label, null, reset, usedValue, limit, "independent");
}

/** The legacy `/auth/usage` shape: one object per request bucket. */
function parseLegacyUsage(payload: unknown): readonly ProviderQuotaWindow[] {
  const root = quotaRecord(payload);
  const reset = resetsAt(root);
  const windows: ProviderQuotaWindow[] = [];
  for (const [key, value] of Object.entries(root)) {
    const bucket = record(value);
    if (!bucket) continue;
    const window = centsWindow(`cursor:requests:${key.toLowerCase()}`, `${key} requests`, bucket, reset);
    if (!window) continue;
    // A bucket with no cap and nothing used is not a balance. Usage-based plans
    // answer this surface with `gpt-4: {numRequests: 0, maxRequestUsage: null}`
    // while their real spend sits on the summary — showing the empty row would
    // put a meaningless "gpt-4 requests" window above the number that matters,
    // on exactly the accounts denominated in dollars.
    if (window.limit === null && (window.used ?? 0) === 0) continue;
    windows.push(window);
  }
  return windows;
}

/**
 * The `usage-summary` shape.
 *
 * `overall` is the spend against the plan; `plan` carries the included rails;
 * `onDemand` is spend beyond them. All three are kept when present — dropping
 * on-demand because the plan bucket answered would hide the part of the bill
 * that is actually growing.
 */
function parseUsageSummary(payload: unknown): {
  readonly windows: readonly ProviderQuotaWindow[];
  readonly plan: string | null;
} {
  const root = record(payload) ?? {};
  const individual = record(root["individualUsage"]);
  if (!individual) return { windows: [], plan: null };
  const reset = resetsAt(root);
  const windows: ProviderQuotaWindow[] = [];

  // The plan bucket is denominated two ways and the reference reads the
  // percentages, not the dollar figures: an included plan carries `limit: 0`
  // because there is no dollar cap to spend against, so reading `used`/`limit`
  // reports every such account as `0 / 0` — a balance that looks empty and
  // means nothing.
  const plan = record(individual["plan"]);
  const limitCents = number(plan?.["limit"]);
  const limitUsd = limitCents !== null && limitCents > 0 ? limitCents / 100 : null;

  const percentWindowFor = (
    kind: string,
    label: string,
    percent: number | null,
    withLimit: boolean,
  ): ProviderQuotaWindow | null => {
    if (percent === null) return null;
    const fraction = Math.max(0, percent) / 100;
    if (withLimit && limitUsd !== null) {
      return percentWindow(kind, label, percent, reset, limitUsd * fraction, limitUsd, "independent");
    }
    // No dollar cap, so the percentage is the whole reading: reported against a
    // 100-point scale rather than as a dollar figure the plan does not have.
    return percentWindow(kind, label, percent, reset, percent, 100, "independent");
  };

  const auto = percentWindowFor(
    "cursor:usd:individual-auto",
    "Cursor Models",
    number(plan?.["autoPercentUsed"]),
    false,
  );
  if (auto) windows.push(auto);
  const api = percentWindowFor(
    "cursor:usd:individual-api",
    "Other Models",
    number(plan?.["apiPercentUsed"]),
    true,
  );
  if (api) windows.push(api);
  if (!auto && !api) {
    const fallback =
      percentWindowFor(
        "cursor:usd:individual-plan",
        "Personal Usage",
        number(plan?.["totalPercentUsed"]),
        true,
      ) ?? centsWindow("cursor:usd:individual-plan", "Personal Usage", plan ?? {}, reset);
    if (fallback) windows.push(fallback);
  }

  // On-demand is spend beyond the included rails. Kept even when the plan
  // bucket answered, because it is the part of the bill that grows.
  const onDemand = record(individual["onDemand"]);
  if (onDemand && onDemand["enabled"] !== false) {
    const window = centsWindow("cursor:usd:individual-on-demand", "On-demand usage", onDemand, reset);
    if (window) windows.push(window);
  }

  return { windows, plan: text(individual["planName"] ?? root["membershipType"]) };
}

/**
 * Reads one Cursor account's quota.
 *
 * The summary is preferred when it answers, because the legacy surface reports
 * a permanently-zero bucket on exactly the plans that have a dollar cap. The
 * legacy read is still attempted: it is the only surface an api-key account
 * can reach.
 */
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
 * (`google-oauth2|user_01K3...`), which is an identity, not a name. It is
 * reduced to a short opaque tag here so the console can tell two Cursor
 * accounts apart without publishing either one's subject.
 *
 * Derived rather than random, so the same account keeps the same tag across
 * refreshes; a tag that changed every read would be worse than showing the
 * subject it replaces.
 */
function cursorAccountTag(credential: string): string {
  return `cursor-${fnv1a32(credential).toString(36).padStart(7, "0").slice(0, 7)}`;
}

export async function fetchCursorQuota(
  credential: string,
  fetcher: FetchLike,
  context?: QuotaCollectionContext,
): Promise<ProviderQuotaResult> {
  const raw = context?.auth_state ?? {};
  const baseUrl =
    typeof raw["apiEndpoint"] === "string" && raw["apiEndpoint"].trim()
      ? raw["apiEndpoint"].trim().replace(/\/+$/, "")
      : `https://${CURSOR_API_HOST}`;
  const errors: string[] = [];

  const call = async (url: string, headers: Record<string, string>): Promise<unknown> => {
    const response = await fetcher(url, { method: "GET", headers });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  };

  const legacy = await call(`${baseUrl}/auth/usage`, {
    accept: "application/json",
    authorization: `Bearer ${credential}`,
  }).then(
    (payload) => parseLegacyUsage(payload),
    (error: unknown) => {
      errors.push(`auth/usage: ${cleanError(error)}`);
      return null;
    },
  );

  // Attempted for every credential kind, not just OAuth. The legacy surface is
  // the only one an api-key account is *guaranteed*, but gating the summary on
  // `credential_kind` leaves api-key accounts showing only `gpt-4 requests` — a
  // bucket that reads zero on exactly the plans that have a dollar cap. If the
  // summary answers, it is the better reading whatever kind the row claims.
  const userId = cursorAccountIdentity(credential) ?? authStateUserId(context);
  let summary: { readonly windows: readonly ProviderQuotaWindow[]; readonly plan: string | null } | null = null;
  if (userId && baseUrl === `https://${CURSOR_API_HOST}`) {
    // This surface authenticates by session cookie, not bearer: it answers 401
    // `not_authenticated` for every Authorization header, including a valid
    // one. The cookie is the user id and the token joined by `::`.
    summary = await call(`https://${CURSOR_WEBSITE_HOST}/api/usage-summary`, {
      accept: "application/json",
      cookie: `WorkosCursorSessionToken=${encodeURIComponent(`${userId}::${credential}`)}`,
    }).then(
      (payload) => parseUsageSummary(payload),
      (error: unknown) => {
        errors.push(`usage-summary: ${cleanError(error)}`);
        return null;
      },
    );
  }

  const summaryWindows = summary?.windows ?? [];
  const windows = summaryWindows.length > 0 ? summaryWindows : (legacy ?? []);
  if (windows.length === 0) {
    return {
      source: "cursor",
      plan: summary?.plan ?? null,
      windows: [],
      accountLabel: cursorAccountTag(credential),
      error: errors.join("; ") || "Cursor quota endpoints did not answer.",
    };
  }
  return {
    source: "cursor",
    plan: summary?.plan ?? null,
    windows,
    accountLabel: cursorAccountTag(credential),
    // Partial reads keep the error so the console can name the quiet surface,
    // but a summary that answered is enough to report a balance.
    error: summaryWindows.length > 0 && errors.length > 0 ? errors.join("; ") : null,
  };
}
