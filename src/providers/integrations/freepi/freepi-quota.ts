// Free-pi quota collector.
//
// Reads `GET /me` (Bearer) — the backend's account/allowance surface. The
// response carries the USD budget (`cap_usd_today`, `remaining_usd_today`),
// credit counts (`allowance_credits`, `remaining_credits_today`,
// `bonus_wallet_credits`, `premium_credits`, …), a `refill_at` reset time, and
// a usage lane (`standard`/`fallback`/`wait`). Never throws: a failed read
// returns a null-result so the router treats it as unknown rather than dead.

import type { FetchLike, ProviderQuotaResult, ProviderQuotaWindow } from "../../quota/quota-contracts";
import { cleanError, percentWindow, text } from "../../quota/quota-contracts";
import type { QuotaCollectionContext } from "../../quota/quota-support";
import { buildFreepiHeaders } from "./freepi-headers";
import { FREEPI_BASE_URL } from "./freepi-realm";

function readMe(baseUrl: string, credential: string, fetcher: FetchLike): Promise<Record<string, unknown> | null> {
  return fetcher(new URL("/me", baseUrl), {
    method: "GET",
    headers: buildFreepiHeaders(credential),
    signal: AbortSignal.timeout(15_000),
  })
    .then(async (res) => {
      if (!res.ok) return null;
      try {
        return (await res.json()) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .catch(() => null);
}

/** Reads the account quota and returns a normalized result. */
export async function fetchFreepiQuota(
  credential: string,
  fetcher: FetchLike,
  _context?: QuotaCollectionContext,
): Promise<ProviderQuotaResult> {
  try {
    const me = await readMe(FREEPI_BASE_URL, credential, fetcher);
    if (!me) {
      return {
        source: "freepi",
        plan: null,
        windows: [],
        error: "free-pi /me unavailable",
      };
    }
    const plan = me["tier"] === undefined ? null : text(me["tier"]);
    const windows: ProviderQuotaWindow[] = [];

    const capUsd = me["cap_usd_today"];
    const remainingUsd = me["remaining_usd_today"];
    const refillAt = me["refill_at"];
    if (typeof capUsd === "number" && typeof remainingUsd === "number") {
      const limit = capUsd as number;
      const remaining = remainingUsd as number;
      windows.push(
        percentWindow(
          "usd_daily",
          "Daily USD budget",
          remaining,
          refillAt === undefined ? null : text(refillAt),
          limit - remaining,
          limit,
          "pooled",
        ),
      );
    }

    const allowance = me["allowance_credits"];
    const remainingCredits = me["remaining_credits_today"];
    if (typeof allowance === "number" && typeof remainingCredits === "number") {
      const limit = allowance as number;
      const remaining = remainingCredits as number;
      windows.push(
        percentWindow(
          "credits_daily",
          "Daily credits",
          remaining,
          refillAt === undefined ? null : text(refillAt),
          limit - remaining,
          limit,
          "pooled",
        ),
      );
    }

    const bonus = me["bonus_wallet_credits"];
    if (typeof bonus === "number") {
      windows.push({
        kind: "bonus_credits",
        label: "Bonus credits",
        accounting: "pooled",
        usedPercent: null,
        remainingPercent: null,
        resetsAt: null,
        remaining: bonus as number,
      });
    }

    const premium = me["premium_credits"];
    if (typeof premium === "number") {
      windows.push({
        kind: "premium_credits",
        label: "Premium credits",
        accounting: "pooled",
        usedPercent: null,
        remainingPercent: null,
        resetsAt: null,
        remaining: premium as number,
      });
    }

    const handle = me["handle"];
    return {
      source: "freepi",
      plan,
      windows,
      error: null,
      ...(typeof handle === "string" && handle.trim() ? { accountLabel: handle } : {}),
    };
  } catch (error) {
    return { source: "freepi", plan: null, windows: [], error: cleanError(error) };
  }
}
