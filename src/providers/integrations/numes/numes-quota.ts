// Numes quota collector.
//
// `GET /api/v1/key` (bearer `sk-numes-...`) reports the key's own accounting:
// `usage` totals plus `usage_daily` / `usage_weekly` / `usage_monthly`
// counters, an optional spend `limit` with `limit_remaining` / `limit_reset`,
// `billing_currency`, and `disabled`. Verified live 2026-11-18.
//
// The account balance itself (`GET /api/v1/credits`) requires a *management*
// key, which is a different credential than the inference key this provider
// stores — so balance is not collectible here; the windows below are the
// key-scoped counters and spend cap the API key can see.
//
// Reads are Bearer-authenticated; never throws — a failed read returns a
// null result so the router treats it as unknown rather than dead.

import type { FetchLike, ProviderQuotaResult, ProviderQuotaWindow } from "../../quota/quota-contracts";
import { cleanError, percentWindow, quotaRecord, text } from "../../quota/quota-contracts";
import type { QuotaCollectionContext } from "../../quota/quota-support";
import { quotaUnreadable, readJsonOk } from "../shared/cli-client-kit";
import { providerBaseUrl } from "../../provider-metadata";

function counter(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Absolute-usage window for a counter the upstream does not cap. */
function usageWindow(kind: string, label: string, used: number | null): ProviderQuotaWindow {
  return {
    kind,
    label,
    accounting: "independent",
    usedPercent: null,
    remainingPercent: null,
    resetsAt: null,
    used,
    limit: null,
  };
}

/** Reads the key's quota surface and returns a normalized result. */
export async function fetchNumesQuota(
  credential: string,
  fetcher: FetchLike,
  _context?: QuotaCollectionContext,
): Promise<ProviderQuotaResult> {
  try {
    const token = credential.trim();
    if (!token) {
      return quotaUnreadable("numes", "Numes key endpoint unavailable");
    }
    const payload = await readJsonOk(fetcher, `${providerBaseUrl("numes")}/key`, {
      accept: "application/json",
      authorization: `Bearer ${token}`,
    });
    if (!payload) {
      return quotaUnreadable("numes", "Numes key endpoint unavailable");
    }
    const data = quotaRecord(payload);

    if (data["disabled"] === true) {
      return {
        source: "numes",
        plan: null,
        windows: [],
        error: "Numes API key is disabled",
        authInvalidated: true,
      };
    }

    const windows: ProviderQuotaWindow[] = [];

    const limit = counter(data["limit"]);
    const limitRemaining = counter(data["limit_remaining"]);
    if (limit !== null && limit > 0) {
      const used = limitRemaining === null ? null : Math.max(0, limit - limitRemaining);
      const usedPercent =
        used === null ? null : Math.min(100, Math.max(0, (used / limit) * 100));
      const resetsAt =
        typeof data["limit_reset"] === "string" ? (data["limit_reset"] as string) : null;
      windows.push(
        percentWindow(
          "key_spend_limit",
          "Key spend limit",
          usedPercent,
          resetsAt,
          used,
          limit,
          "pooled",
        ),
      );
    }

    windows.push(usageWindow("usage_daily", "Daily usage", counter(data["usage_daily"])));
    windows.push(usageWindow("usage_weekly", "Weekly usage", counter(data["usage_weekly"])));
    windows.push(usageWindow("usage_monthly", "Monthly usage", counter(data["usage_monthly"])));

    const currency = typeof data["billing_currency"] === "string" ? text(data["billing_currency"]) : null;
    const label = typeof data["label"] === "string" ? text(data["label"]) : null;

    return {
      source: "numes",
      plan: currency,
      windows,
      error: null,
      ...(label ? { accountLabel: label } : {}),
    };
  } catch (error) {
    return quotaUnreadable("numes", cleanError(error));
  }
}
