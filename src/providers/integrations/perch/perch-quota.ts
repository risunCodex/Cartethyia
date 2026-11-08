// Perch quota collector.
//
// Reads the account's plan/allowance surface from the hosted API
// (`GET /api/perchai/account` with the stored access token). The account
// endpoint reports `planCode`, `planName`, `membershipRole`, usage meters
// (`usageMeter.monthlyUsd`, `roostRolling`), and `tierSelectionRequired`.
// Reads are Bearer-authenticated; never throws — a failed read returns a
// null result so the router treats it as unknown rather than dead.

import type { FetchLike, ProviderQuotaResult, ProviderQuotaWindow } from "../../quota/quota-contracts";
import { cleanError, percentWindow, text } from "../../quota/quota-contracts";
import type { QuotaCollectionContext } from "../../quota/quota-support";
import { PERCH_APP_URL } from "./perch-realm";

interface PerchSessionCredential {
  readonly accessToken?: string;
  readonly access_token?: string;
}

function credentialToken(credential: string): string {
  try {
    const parsed = JSON.parse(credential) as PerchSessionCredential;
    const found = parsed.accessToken ?? parsed.access_token;
    return typeof found === "string" ? found : "";
  } catch {
    return credential.trim();
  }
}

async function readAccount(
  baseUrl: string,
  token: string,
  fetcher: FetchLike,
): Promise<Record<string, unknown> | null> {
  if (!token) return null;
  return fetcher(`${baseUrl}/api/perchai/account`, {
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

const USD_WINDOW_KIND = "usd_monthly";

/** Reads the account quota and returns a normalized result. */
export async function fetchPerchQuota(
  credential: string,
  fetcher: FetchLike,
  _context?: QuotaCollectionContext,
): Promise<ProviderQuotaResult> {
  try {
    const token = credentialToken(credential);
    const account = await readAccount(PERCH_APP_URL, token, fetcher);
    if (!account) {
      return { source: "perch", plan: null, windows: [], error: "Perch account endpoint unavailable" };
    }
    const session = account["session"] as Record<string, unknown> | undefined;
    const plan = session && typeof session["planCode"] === "string" ? text(session["planCode"]) : null;
    const meter = account["usageMeter"] as Record<string, unknown> | undefined;
    const windows: ProviderQuotaWindow[] = [];

    const monthlyUsd = meter?.["monthlyUsd"];
    if (typeof monthlyUsd === "number") {
      // Starter includes $20/month of hosted usage; reset at month end.
      const used = monthlyUsd as number;
      const limit = 20;
      windows.push(
        percentWindow(
          USD_WINDOW_KIND,
          "Monthly USD usage",
          used > 0 ? (used / limit) * 100 : 0,
          null,
          used,
          limit,
          "pooled",
        ),
      );
    }

    const roost = meter?.["roostRolling"] as Record<string, unknown> | undefined;
    if (roost && typeof roost["window5hCapUsd"] === "number") {
      const cap = roost["window5hCapUsd"] as number;
      const used = typeof roost["window5hUsd"] === "number" ? (roost["window5hUsd"] as number) : 0;
      windows.push(
        percentWindow(
          "usd_5h",
          "Roost 5-hour rolling",
          cap > 0 ? (used / cap) * 100 : 0,
          null,
          used,
          cap,
          "independent",
        ),
      );
    }
    if (roost && typeof roost["window7dCapUsd"] === "number") {
      const cap = roost["window7dCapUsd"] as number;
      const used = typeof roost["window7dUsd"] === "number" ? (roost["window7dUsd"] as number) : 0;
      windows.push(
        percentWindow(
          "usd_weekly",
          "Roost weekly rolling",
          cap > 0 ? (used / cap) * 100 : 0,
          null,
          used,
          cap,
          "independent",
        ),
      );
    }

    const profile = account["profile"] as Record<string, unknown> | undefined;
    const email = profile && typeof profile["email"] === "string" ? text(profile["email"]) : undefined;

    return {
      source: "perch",
      plan,
      windows,
      error: null,
      ...(email ? { accountLabel: email } : {}),
    };
  } catch (error) {
    return { source: "perch", plan: null, windows: [], error: cleanError(error) };
  }
}
