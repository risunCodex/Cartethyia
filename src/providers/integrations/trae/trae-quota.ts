// Trae quota.
//
// Two surfaces, on two different hosts, and neither is optional if the account
// is to be read honestly:
//
// - `get_session_usage` on the **core** host is the running meter — what the
//   account has left of its advanced/premium request buckets and its dollar
//   balances.
// - `ide_user_ent_usage` on the **pay** host is the entitlement: which package
//   the account holds and when it lapses.
//
// Both are read and either may fail without the other: entitlement is a *pay*
// host, which is the first thing a region-blocked or unpaid account loses.
// Letting a dead pay host fail the whole read would report "no quota" for an
// account whose session meter is perfectly readable — and "no quota" is what
// the router parks on.
//
// Headers come from `buildTraeHeaders` rather than being rebuilt here: the
// device fingerprint is derived from the uid, and an account that reports one
// device here and another at dispatch is exactly the correlation this gateway
// exists to avoid.

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
  record,
  text,
} from "../../quota/quota-contracts";
import type { QuotaCollectionContext } from "../../quota/quota-support";
import { decodeJwtPayload } from "../../authentication/oauth-flow-store";
import { buildTraeHeaders } from "./trae-headers";
import { log } from "../../../observability/logger";
import {
  TRAE_ENT_USAGE_PATH,
  TRAE_ENT_USAGE_PATH_V2,
  TRAE_SESSION_USAGE_PATH,
  traeCoreForAccount,
  traePayHostForAccount,
  type TraeRealm,
} from "./trae-realm";

/**
 * The buckets `remain_usage` carries, in the order they are read.
 *
 * `advanced_model` and `premium_model_*` are request counts; `dollar_basic` and
 * `dollar_bonus` are spend balances. They are separate budgets and must never
 * be summed — a dollar balance is not a request count.
 */
const REQUEST_BUCKETS: readonly (readonly [string, string])[] = [
  ["advanced_model", "Advanced model requests"],
  ["premium_model_fast_request", "Premium fast requests"],
  ["premium_model_slow_request", "Premium slow requests"],
];

const DOLLAR_BUCKETS: readonly (readonly [string, string])[] = [
  ["dollar_basic", "Basic spend"],
  ["dollar_bonus", "Bonus spend"],
];

interface TraeQuotaAuth {
  readonly realm: TraeRealm;
  readonly uid: string;
  /** Provisioned region (`sg`, `us`), which selects the core host. */
  readonly region: string;
}

/**
 * Reads the account's realm and uid for the quota call.
 *
 * Both come from `auth_state`, the same place dispatch reads them: a Trae
 * token is realm-bound, so guessing `intl` for a CN account sends it to a host
 * that will not authenticate it.
 */
function quotaAuth(context: QuotaCollectionContext | undefined): TraeQuotaAuth {
  const raw = context?.auth_state ?? {};
  // `realm` is not persisted by the OAuth client — it is a property of which
  // provider id the account was registered under, so the CN wrapper forces it
  // rather than trusting an absent field.
  const realm = raw["realm"] === "cn" || raw["region"] === "CN" ? "cn" : "intl";
  // The OAuth client stores the account id as `userId`; `uid` is the name the
  // dispatch header builder uses. Reading only one of them left the device
  // fingerprint empty for every account.
  const uidRaw = raw["uid"] ?? raw["userId"] ?? raw["user_id"];
  const uid = typeof uidRaw === "string" && uidRaw.trim() ? uidRaw.trim() : "";
  // `region` is provisioned, not chosen: an intl account is created into one
  // and its token only authenticates against that region's core host. `us` and
  // `cn` are served by the realm's default host, but `sg` is a different host
  // entirely — sending it to the US core answers 401 code 1001.
  const region = typeof raw["region"] === "string" ? raw["region"].trim().toLowerCase() : "";
  return { realm, uid, region };
}

/**
 * The account id out of the access token itself.
 *
 * The device fingerprint is derived from the uid, so an empty one presents no
 * device at all — and this surface correlates the credential against its
 * device, answering `1001` for a token that is perfectly valid. The JWT carries
 * the id, so it is read there when the auth state does not have it.
 */
function uidFromToken(credential: string): string | undefined {
  const payload = decodeJwtPayload(credential);
  if (!payload) return undefined;
  // The id is nested: this token's payload is `{data:{id,type,tenant_id},exp,
  // iat}` — there is no `sub` and no top-level `userId`, so a flat read found
  // nothing and the request went out with no device identity at all.
  for (const source of [payload, record(payload["data"])]) {
    if (!source) continue;
    for (const key of ["userId", "user_id", "uid", "sub", "id"] as const) {
      const value = source[key];
      if (typeof value === "string" && value.trim()) return value.trim();
      if (typeof value === "number" && Number.isFinite(value)) return String(value);
    }
  }
  return undefined;
}

/** One bucket of `remain_usage`, paired with its cap from the sibling object. */
function bucketWindow(
  label: string,
  remaining: number | null,
  limit: number | null,
  resetsAt: string | null,
): ProviderQuotaWindow | null {
  if (remaining === null && limit === null) return null;
  const used = remaining !== null && limit !== null ? limit - remaining : null;
  return percentWindow(
    `trae:${label}`,
    label,
    null,
    resetsAt,
    used,
    limit,
    // Independent: each bucket is its own budget. Summing a request count into
    // a dollar balance would produce a number that means nothing.
    "independent",
  );
}

/**
 * Pulls `remaining`/`limit` for one key out of either usage object.
 *
 * `remain_usage` carries a **bare number** per bucket (`advanced_model: 40`),
 * not a nested object — the caps live in the sibling `usage` object. Reading a
 * nested `remaining` here is what dropped every balance and left a limit with
 * no remaining, i.e. a window that cannot say how much is left.
 */
function bucketValues(
  source: Record<string, unknown>,
  key: string,
): { readonly remaining: number | null; readonly limit: number | null } {
  const direct = record(source[key]);
  if (direct) {
    return {
      remaining: number(direct["remaining"] ?? direct["remain"] ?? direct["remain_usage"]),
      limit: number(direct["limit"] ?? direct["total"] ?? direct["cap"]),
    };
  }
  return {
    remaining: number(source[key] ?? source[`${key}_remaining`]),
    limit: number(source[`${key}_limit`] ?? source[`${key}_total`]),
  };
}

/**
 * The session-usage meter: `remain_usage` holds the remaining balance per
 * bucket, with the caps alongside it on the same object.
 */
function parseSessionUsage(payload: unknown): {
  readonly windows: readonly ProviderQuotaWindow[];
  readonly plan: string | null;
} {
  // Deliberately *not* `quotaRecord`: it unwraps a `usage` envelope, and on
  // this surface `usage` is the sibling object holding the caps — unwrapping it
  // discards `remain_usage` entirely and leaves a limit with no remaining.
  const root = record(payload) ?? {};
  const windows: ProviderQuotaWindow[] = [];
  // The meter is nested under `data` on some realms and at the root on others;
  // both shapes are live, so look in each rather than picking one.
  const candidates = [root, record(root["data"]), record(root["quota"])].filter(
    (value): value is Record<string, unknown> => value !== null,
  );
  const resetsAt = candidates
    .map((value) => isoDate(value["reset_time"] ?? value["resetTime"] ?? value["next_reset_time"]))
    .find((value) => value !== null) ?? null;

  for (const source of candidates) {
    const remain = record(source["remain_usage"]) ?? source;
    const usage = record(source["usage"]) ?? {};
    for (const [key, label] of [...REQUEST_BUCKETS, ...DOLLAR_BUCKETS]) {
      // Remaining is the bare number under `remain_usage`; the cap is the
      // sibling object under `usage`. Two objects, one per side of the same
      // budget, so both are read before a window is built.
      const remaining = bucketValues(remain, key).remaining ?? number(usage[key]);
      const limit = bucketValues(usage, key).limit ?? bucketValues(remain, key).limit;
      const window = bucketWindow(label, remaining, limit, resetsAt);
      if (window) windows.push(window);
    }
    if (windows.length > 0) break;
  }
  const plan = candidates
    .map((value) => text(value["plan_name"] ?? value["planName"] ?? value["user_type"]))
    .find((value) => value !== null) ?? null;
  return { windows, plan };
}

/**
 * The entitlement payload, from the pay host.
 *
 * Shape verified live (2026-11-06, intl Free plan):
 *
 *   {
 *     "billing_version": 3,
 *     "is_dollar_usage_billing": true,
 *     "user_entitlement_pack_list": [{
 *       "display_desc": "Free plan",
 *       "entitlement_base_info": {
 *         "end_time": 1796083199,
 *         "quota": { "advanced_model_request_limit": 1000, ... }
 *       },
 *       "quota": { "advanced_model_request_limit": 1000, ... },
 *       "usage": { "basic_usage_amount": 0, ... },
 *       "status": 1,
 *       "expire_time": 0
 *     }]
 *   }
 *
 * The v2 surface (CN realm) instead carries a `usage_summary` block:
 *
 *   { "total_amount": 900, "consumed_amount": 0.39, ... }
 *
 * Limits live in `entitlement_base_info.quota` (or the sibling `quota`)
 * as `<bucket>_limit` fields. There is no consumed/remaining count in the
 * v1 shape — `used` stays null, and the window reports just the cap.
 */
function parseEntitlement(payload: unknown): {
  readonly windows: readonly ProviderQuotaWindow[];
  readonly plan: string | null;
} {
  const root = record(payload) ?? {};
  const data = record(root["data"]) ?? root;
  const packs = Array.isArray(data["user_entitlement_pack_list"])
    ? data["user_entitlement_pack_list"]
    : Array.isArray(data["entitlement_list"])
      ? data["entitlement_list"]
      : [];
  const windows: ProviderQuotaWindow[] = [];
  let plan: string | null = null;

  // The pack's `quota` block names its fields `<bucket>_limit` — with the
  // word `request` inside for the model buckets (`advanced_model_request_limit`),
  // and `usage_limit` for the dollar buckets (`basic_usage_limit`). Mapping
  // them explicitly beats string-concatenating the bucket id.
  const LIMIT_FIELDS: Readonly<Record<string, string>> = {
    advanced_model: "advanced_model_request_limit",
    premium_model_fast_request: "premium_model_fast_request_limit",
    premium_model_slow_request: "premium_model_slow_request_limit",
    dollar_basic: "basic_usage_limit",
    dollar_bonus: "bonus_usage_limit",
  };
  const LABELS = new Map<string, string>([...REQUEST_BUCKETS, ...DOLLAR_BUCKETS]);

  for (const entry of packs) {
    const pack = record(entry);
    if (!pack) continue;
    const base = record(pack["entitlement_base_info"]) ?? {};
    const quota = record(base["quota"]) ?? record(pack["quota"]) ?? {};
    const name = text(pack["display_desc"]) ?? text(pack["name"]) ?? text(pack["title"]);
    if (!plan && name) plan = name;
    const resetsAt = isoDate(
      number(base["end_time"]) ?? number(pack["end_time"]) ?? number(pack["expire_time"]),
    );

    // v2 surface (CN realm): the summary carries the total and consumed
    // amounts; use it as a single window when present.
    const summary = record(record(data["usage_summary"]) ?? record(pack["usage_summary"]));
    if (summary) {
      const window = bucketWindow(
        name ?? "Plan",
        number(summary["consumed_amount"]),
        number(summary["total_amount"]),
        resetsAt,
      );
      if (window) windows.push(window);
      continue;
    }

    // v1 surface: `<bucket>_limit` fields, no consumption count — the cap
    // is all this shape can report.
    for (const [key, limitField] of Object.entries(LIMIT_FIELDS)) {
      const limit = number(quota[limitField]);
      if (limit === null) continue;
      const label = LABELS.get(key) ?? key;
      const window = percentWindow(`trae:${key}`, label, null, resetsAt, null, limit, "independent");
      if (window) windows.push(window);
    }
  }
  return { windows, plan };
}

/**
 * Records a quiet surface where an operator can act on it.
 *
 * Deliberately not the returned `error`: that field is what flags the account
 * `quota_fetch_failed` and cools it. A 403 from the wrong realm, or a pay host
 * that is unreachable, says nothing about whether the account can serve.
 */
function logTraeQuotaMiss(errors: readonly string[]): void {
  if (errors.length === 0) return;
  log.warn(`[quota] trae surfaces unavailable: ${errors.join("; ")}`);
}

/**
 * Reads one Trae account's quota.
 *
 * The session meter and the entitlement are fetched independently: whichever
 * answers contributes, and a failure is only fatal if *both* fail. An account
 * whose pay host is unreachable still has a readable meter, and reporting
 * "no quota" for it would park an account that can still serve.
 */
export async function fetchTraeQuota(
  credential: string,
  fetcher: FetchLike,
  context?: QuotaCollectionContext,
): Promise<ProviderQuotaResult> {
  const { realm, uid, region } = quotaAuth(context);
  const resolvedUid = uid || uidFromToken(credential) || "";
  const errors: string[] = [];

  const call = async (
    realm: TraeRealm,
    url: string,
    surface: string,
  ): Promise<unknown> => {
    const response = await fetcher(url, {
      // POST with an empty JSON body, not GET: this is the commercial surface
      // the desktop client calls, and it answers a GET with an error rather
      // than a meter — which read as "no quota" for every account.
      method: "POST",
      headers: {
        // The commercial surface authenticates with `Cloud-IDE-JWT` on both
        // realms.
        ...buildTraeHeaders({ realm, token: credential, uid: resolvedUid }),
        // Applied after the builder, which switches intl to `Bearer` for raw
        // chat: a Bearer here is answered 401 code 1001, so the account shows
        // no windows while its token is perfectly valid.
        authorization: `Cloud-IDE-JWT ${credential}`,
        "content-type": "application/json",
        // The builder pins `us` for every intl account. An `sg` account sent
        // with a US country code is refused with 401 code 1001 — the country
        // code is part of the identity this surface checks, not a hint.
        // `sg` rather than `us` for an account with no recorded region: the
        // default core is SG now, and this header is part of the identity the
        // commercial surface checks, so it has to agree with the host it is
        // sent to. An account that *has* a region still sends its own.
        "store-country-code": region || "sg",
      },
      body: "{}",
    });
    if (!response.ok) {
      // 403 here is a verdict about *how we asked*, not about the balance: the
      // commercial surface correlates the credential against its realm and its
      // device fingerprint, and a CN token sent to an intl host — or one sent
      // with no device id — is refused outright. Reporting that as a failed
      // read parks the account, so it is reported as unreadable-for-now and
      // left alone by the cooldown path.
      const body = await response.text().catch(() => "");
      throw new Error(
        response.status === 403
          ? `${surface}: HTTP 403 (realm or device mismatch, not a balance)`
          : `${surface}: HTTP ${response.status}${body ? ` ${body.slice(0, 80)}` : ""}`,
      );
    }
    return await response.json();
  };

  /**
   * Tries the realm we believe, then the other one.
   *
   * A Trae token is realm-bound and the auth state does not record which — the
   * provider id does, and a collector cannot see it. The wrong host answers 401
   * code 1001, which is indistinguishable from a dead token unless the other
   * realm is tried: one of them accepts, and that is the answer.
   */
  const tryRealms = async (
    path: (realm: TraeRealm) => string,
    surface: string,
    parse: (payload: unknown) => { readonly windows: readonly ProviderQuotaWindow[]; readonly plan: string | null },
  ): Promise<{ readonly windows: readonly ProviderQuotaWindow[]; readonly plan: string | null } | null> => {
    for (const candidate of realm === "cn" ? (["cn", "intl"] as const) : (["intl", "cn"] as const)) {
      try {
        const payload = await call(candidate, path(candidate), surface);
        return parse(payload);
      } catch (error) {
        errors.push(`${candidate} ${surface}: ${cleanError(error)}`);
      }
    }
    return null;
  };

  const session = await tryRealms((r) => traeCoreForAccount(r, region) + TRAE_SESSION_USAGE_PATH, "session usage", parseSessionUsage);
  // The entitlement path differs by realm: the CN realm answers v2 (v1 lacks
  // `usage_summary` there), the intl realm answers v1 (v2 is a 404).
  const entPath = realm === "cn" ? TRAE_ENT_USAGE_PATH_V2 : TRAE_ENT_USAGE_PATH;
  const entitlement = await tryRealms((r) => traePayHostForAccount(r, region) + entPath, "entitlement", parseEntitlement);

  const windows = [...(session?.windows ?? []), ...(entitlement?.windows ?? [])];
  if (!session && !entitlement) {
    // No window and *no error*: a quota read that could not reach upstream is
    // not evidence about the account, and `error` here is what flags the
    // account `quota_fetch_failed` and cools it down. An unreachable or
    // refusing surface must leave the account alone — otherwise an account is
    // parked by its own monitor, for a reason that has nothing to do with it.
    // The detail is kept for the log instead, where it cannot be read as a
    // balance.
    logTraeQuotaMiss(errors);
    return { source: "trae", plan: null, windows: [], error: null };
  }
  return {
    source: "trae",
    plan: session?.plan ?? entitlement?.plan ?? null,
    windows,
    // A partial read is still a read, and the quiet surface is a diagnostic —
    // never a reason to park the account.
    error: null,
  };
}

/**
 * The `traecn` provider's quota.
 *
 * Same collector, realm forced to `cn`: a CN token is refused by the intl
 * hosts, and the provider id is not something the collector can see — the
 * context carries no provider, only auth state.
 */
export function fetchTraeCnQuota(
  credential: string,
  fetcher: FetchLike,
  context?: QuotaCollectionContext,
): Promise<ProviderQuotaResult> {
  return fetchTraeQuota(credential, fetcher, { ...context, auth_state: { ...(context?.auth_state ?? {}), realm: "cn" } });
}
