// Vercel AI Gateway quota collector.
//
// Reads `GET /v1/credits` (Bearer) — the gateway's credit surface. It returns
// a remaining balance (`balance`, USD string), an optional `token_pass`, and
// the total spend (`total_used`, USD string). No ceiling is reported (balance
// is remaining, not a limit), so the window carries absolute remaining/used
// values and no percent — the pooled credit sum still works. Never throws: a
// failed read returns a null-result so the router treats it as unknown rather
// than dead.

import type {
  FetchLike,
  ProviderQuotaResult,
  ProviderQuotaWindow,
} from "../../quota/quota-contracts";
import {
  cleanError,
  number,
  unsupportedQuota,
} from "../../quota/quota-contracts";
import type { QuotaCollectionContext } from "../../quota/quota-support";

const VERCEL_CREDITS_URL = "https://ai-gateway.vercel.sh/v1/credits";

function readCredits(
  credential: string,
  fetcher: FetchLike,
): Promise<Record<string, unknown> | null> {
  return fetcher(VERCEL_CREDITS_URL, {
    method: "GET",
    headers: {
      authorization: `Bearer ${credential}`,
      accept: "application/json",
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

/** Reads the Vercel AI Gateway credit balance and returns a normalized result. */
export async function fetchVercelQuota(
  credential: string,
  fetcher: FetchLike,
  _context?: QuotaCollectionContext,
): Promise<ProviderQuotaResult> {
  try {
    const credits = await readCredits(credential, fetcher);
    if (!credits) {
      return unsupportedQuota("vercel");
    }
    const balance = number(credits["balance"]);
    const totalUsed = number(credits["total_used"]);
    if (balance === null && totalUsed === null) {
      return {
        source: "vercel",
        plan: null,
        windows: [],
        error: "Vercel AI Gateway /v1/credits returned no usable numbers",
      };
    }
    const windows: ProviderQuotaWindow[] = [
      {
        kind: "credits",
        label: "AI Gateway credits",
        accounting: "pooled",
        usedPercent: null,
        remainingPercent: null,
        resetsAt: null,
        used: totalUsed,
        limit: null,
        remaining: balance,
      },
    ];
    return {
      source: "vercel",
      plan: null,
      windows,
      error: null,
    };
  } catch (error) {
    return {
      source: "vercel",
      plan: null,
      windows: [],
      error: cleanError(error),
    };
  }
}
