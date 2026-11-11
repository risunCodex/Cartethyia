// Clixad quota collector.
//
// Reads the account's credit surface from the gateway's wallet endpoint
// (`GET /v1/wallet` with the stored bearer token). The wallet reports the
// billed balance, the daily free-tier allowance (`free_tier.daily_credits` /
// `credits_left` — resets at midnight UTC), turns left per free model, and
// the ad-reward earnings cap (`max_reward_usd_per_day`). Reads are
// Bearer-authenticated; never throws — a failed read returns a null result so
// the router treats it as unknown rather than dead.

import type { FetchLike, ProviderQuotaResult, ProviderQuotaWindow } from "../../quota/quota-contracts";
import { cleanError, number, percentWindow, text } from "../../quota/quota-contracts";
import type { QuotaCollectionContext } from "../../quota/quota-support";

async function readWallet(
  baseUrl: string,
  token: string,
  fetcher: FetchLike,
): Promise<Record<string, unknown> | null> {
  if (!token) return null;
  return fetcher(`${baseUrl}/v1/wallet`, {
    method: "GET",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${token}`,
    },
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

/** Next midnight UTC, for the free-tier reset window. */
function nextMidnightUtc(): string {
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  return next.toISOString();
}

/**
 * Reads the account quota and returns a normalized result.
 *
 * Pooled windows: the billed balance (no ceiling — absolute remaining only)
 * and the daily free-tier allowance (120k credits/day, resets at midnight
 * UTC). Independent window: the ad-reward earnings cap ($5/day).
 */
export async function fetchClixadQuota(
  credential: string,
  fetcher: FetchLike,
  _context?: QuotaCollectionContext,
): Promise<ProviderQuotaResult> {
  try {
    const token = text(credential) ?? "";
    const wallet = await readWallet("https://clixad.onrender.com", token, fetcher);
    if (!wallet) {
      return { source: "clixad", plan: null, windows: [], error: "Clixad wallet endpoint unavailable" };
    }
    const windows: ProviderQuotaWindow[] = [];

    const balance = number(wallet["balance"]);
    if (balance !== null) {
      // Billed balance: pooled, absolute remaining, no ceiling (a bonus pack
      // has no declared limit — it simply is what it is).
      windows.push({
        kind: "credits",
        label: "Account credits",
        accounting: "pooled",
        usedPercent: null,
        remainingPercent: null,
        resetsAt: null,
        remaining: Math.max(0, balance),
        recurring: false,
      });
    }

    const freeTier = wallet["free_tier"] as Record<string, unknown> | undefined;
    const dailyCredits = freeTier === undefined ? null : number(freeTier["daily_credits"]);
    if (dailyCredits !== null && dailyCredits > 0) {
      const creditsLeft = freeTier === undefined ? null : number(freeTier["credits_left"]);
      const used = creditsLeft === null ? null : Math.max(0, dailyCredits - creditsLeft);
      // Daily free tier: pooled (it is credit the account can spend), ceiling
      // = the daily allowance, resets at midnight UTC.
      windows.push(
        percentWindow(
          "free_daily",
          "Daily free tier",
          used === null ? null : (used / dailyCredits) * 100,
          nextMidnightUtc(),
          used,
          dailyCredits,
          "pooled",
        ),
      );
    }

    const maxRewardUsd = number(wallet["max_reward_usd_per_day"]);
    if (maxRewardUsd !== null && maxRewardUsd > 0) {
      const earnedUsd = number(wallet["earned_usd_today"]) ?? 0;
      const usedUsd = Math.min(maxRewardUsd, Math.max(0, earnedUsd));
      // Ad-reward earnings cap: independent (it does not fund model calls
      // directly — it caps how much *earning* can happen per day).
      windows.push(
        percentWindow(
          "earn_usd_daily",
          "Daily reward cap",
          (usedUsd / maxRewardUsd) * 100,
          nextMidnightUtc(),
          usedUsd,
          maxRewardUsd,
          "independent",
        ),
      );
    }

    const plan = number(wallet["balance"]) !== null ? "metered" : null;
    return {
      source: "clixad",
      plan,
      windows,
      error: null,
    };
  } catch (error) {
    return { source: "clixad", plan: null, windows: [], error: cleanError(error) };
  }
}
