// Qoder quota.
//
// `GET /api/v2/quota/usage` on the **openapi** host, with a bearer token — no
// COSY signature on this surface, which is the one place the business API
// differs from inference. Device tokens (`dt-…`) are used directly; a PAT
// (`pt-…`) is exchanged for a job token (`jt-…`) first, because the business
// API rejects a raw PAT with 401 `TOKEN_EXPIRE`.
//
// The response carries two quota objects and they are not interchangeable:
//
// - `userQuota` is the plan allowance — what the account bought.
// - `addOnQuota` is granted credits (daily check-in, promotions) — what it was
//   given on top.
//
// The donor sums them into one balance, and that is right for a credit balance:
// both are credits in the same unit and either can be spent. It would be wrong
// for two *rate limits*, which is why these windows are marked `pooled` here
// and the Trae request buckets are not.
//
// Teams add a third object (`orgResourcePackage`), a shared pool that sits
// outside the account's own allowance. It is only real when it is available,
// and an account whose plan is exhausted but whose shared pool still has
// credit is *not* exhausted.

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
} from "../../quota/quota-contracts";
import type { QuotaCollectionContext } from "../../quota/quota-support";
import { log } from "../../../observability/logger";
import { QODER_REALMS, type QoderRealm } from "./qoder-realm";
import { isQoderPat, resolveQoderAuth } from "./qoder-auth";

/** Paths on the realm's openapi host. */
const QUOTA_PATH = "/api/v2/quota/usage";

/** Shared-pool keys, in the order the donor tries them. */
const SHARED_KEYS: readonly string[] = [
  "orgResourcePackage",
  "sharedQuota",
  "teamQuota",
  "poolQuota",
  "sharedCredits",
  "sharedCredit",
];

/**
 * Whether a shared pool is usable.
 *
 * Absent means "not declared unavailable", which is usable. Only an explicit
 * false/null/0 rules it out — reading absence as unavailable is what made a
 * team account with a live pool look exhausted.
 */
function sharedAvailable(source: Record<string, unknown>): boolean {
  const value = source["available"];
  if (value === undefined || value === null) return true;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") return value.trim().toLowerCase() !== "false";
  return true;
}

function creditWindow(
  kind: string,
  label: string,
  remaining: number | null,
  limit: number | null,
  resetsAt: string | null,
): ProviderQuotaWindow | null {
  if (remaining === null && limit === null) return null;
  const used = remaining !== null && limit !== null ? limit - remaining : null;
  // Give pooled windows a percentage so the console can render a real bar and
  // tone instead of an uncolored "quota-only" row (which is what a null
  // percent produced: every Qoder account was grey, and "enable available
  // accounts" could never match a window). A ceiling of 0 with nothing left is
  // a spent balance — report 0% remaining rather than a null percent.
  let usedPercent: number | null = null;
  if (remaining !== null && limit !== null) {
    if (limit > 0) usedPercent = ((limit - remaining) / limit) * 100;
    else if (remaining <= 0) usedPercent = 100;
  }
  return percentWindow(kind, label, usedPercent, resetsAt, used, limit, "pooled");
}

/**
 * The business API answers "never resets" with a far-future sentinel
 * (`9999-12-31T00:00:00.000Z`). Keeping it on the wire makes the console show
 * a 7978-year countdown. Any date at or beyond year 9999 means no reset.
 */
function normalizeQoderReset(resetsAt: string | null): string | null {
  if (resetsAt === null) return null;
  const date = new Date(resetsAt);
  if (!Number.isFinite(date.getTime())) return null;
  return date.getUTCFullYear() >= 9999 ? null : resetsAt;
}

/**
 * Reads one Qoder account's quota.
 *
 * A degenerate body — both quota objects missing, or `isQuotaExceeded` with a
 * zero remaining *and* a zero total — is reported as an error rather than as a
 * zero balance. "No quota" parks the account; "could not read the quota" does
 * not, and those two are not the same claim.
 */
/** Records an unreadable body where an operator can act on it, not as an error. */
function logQoderQuotaMiss(detail: string): void {
  log.warn(`[quota] qoder quota unreadable: ${detail}`);
}

export async function fetchQoderQuota(
  credential: string,
  fetcher: FetchLike,
  context?: QuotaCollectionContext,
): Promise<ProviderQuotaResult> {
  const raw = context?.auth_state ?? {};
  const realm: QoderRealm = raw["realm"] === "cn" || raw["region"] === "CN" ? "cn" : "intl";
  const config = QODER_REALMS[realm];
  const url = `${config.openapi}${QUOTA_PATH}`;

  let payload: unknown;
  try {
    // A PAT (`pt-…`) is not an active bearer on the business API: it is a
    // minted credential that must be exchanged for a short-lived job token
    // (`jt-…`) first. Verified live 2026-11-02: a raw `pt-…` bearer answers
    // 401 `TOKEN_EXPIRE` while the exchanged `jt-…` answers 200. Device
    // tokens (`dt-…`) are used directly. A failed exchange — expired/revoked
    // PAT — is an unreadable balance, not an error that cools the account.
    let bearer = credential;
    if (isQoderPat(credential)) {
      const auth = await resolveQoderAuth({
        secret: credential,
        authState: raw,
        signal: AbortSignal.timeout(15_000),
        fetcher,
        realm,
      });
      bearer = auth.securityOauthToken;
    }
    const response = await fetcher(url, {
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${bearer}`,
        "user-agent": config.userAgent,
      },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    payload = await response.json();
  } catch (error) {
    // Unreachable is not a balance. See the note on the degenerate branch.
    logQoderQuotaMiss(cleanError(error));
    return { source: "qoder", plan: null, windows: [], error: null };
  }

  const root = quotaRecord(payload);
  const userQuota = record(root["userQuota"]);
  const addOnQuota = record(root["addOnQuota"]);
  const owned = [userQuota, addOnQuota].filter(
    (value): value is Record<string, unknown> => value !== null,
  );

  const bothMissing = owned.length === 0;
  // A live account on the free tier really does answer `userQuota` all zeroes
  // with `isQuotaExceeded: true` — verified against a real credential:
  // `{"isQuotaExceeded":true,"userQuota":{"total":0,"used":0,"remaining":0},
  // "totalUsagePercentage":0.0,...}`. That is a balance of zero, not an
  // unreadable body. Only a response with *both* quota objects absent is
  // unreadable, and it is logged rather than returned — never as an error,
  // which would cool the account.
  const degenerate = bothMissing;
  if (degenerate) {
    // A body we cannot trust is not a zero balance, and it is not a failed
    // read either: `error` is what flags the account `quota_fetch_failed` and
    // cools it, so a shape we simply do not recognise would park a working
    // account. Logged instead of returned.
    logQoderQuotaMiss(
      bothMissing
        ? "Qoder quota response carried no quota objects."
        : "Qoder reported quota exceeded with a zero total; not read as a balance.",
    );
    return { source: "qoder", plan: null, windows: [], error: null };
  }

  const resetsAt = normalizeQoderReset(isoDate(root["expiresAt"] ?? root["expireAt"] ?? root["expires_at"]));
  const windows: ProviderQuotaWindow[] = [];
  const plan = creditWindow("qoder:plan", "Plan credits", number(userQuota?.["remaining"]), number(userQuota?.["total"]), resetsAt);
  if (plan) windows.push(plan);
  const addOn = creditWindow("qoder:addon", "Granted credits", number(addOnQuota?.["remaining"]), number(addOnQuota?.["total"]), resetsAt);
  if (addOn) windows.push(addOn);

  for (const key of SHARED_KEYS) {
    const shared = record(root[key]);
    if (!shared) continue;
    if (!sharedAvailable(shared)) continue;
    const window = creditWindow(
      "qoder:shared",
      "Shared pool",
      number(shared["remaining"]),
      number(shared["cap"] ?? shared["total"]),
      null,
    );
    if (window) windows.push(window);
    break;
  }

  if (windows.length === 0) {
    logQoderQuotaMiss("Qoder quota response carried no readable balance.");
    return { source: "qoder", plan: null, windows: [], error: null };
  }
  return { source: "qoder", plan: null, windows, error: null };
}

/**
 * The `qodercn` provider's quota.
 *
 * Same collector, realm forced to `cn`: a CN account is refused by
 * `openapi.qoder.sh`, and the collector cannot see the provider id — the
 * context carries auth state only.
 */
export function fetchQoderCnQuota(
  credential: string,
  fetcher: FetchLike,
  context?: QuotaCollectionContext,
): Promise<ProviderQuotaResult> {
  return fetchQoderQuota(credential, fetcher, { ...context, auth_state: { ...(context?.auth_state ?? {}), realm: "cn" } });
}
