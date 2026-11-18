// Runcrate quota collector.
//
// Reads the workspace balance from the billing surface
// (`GET https://www.runcrate.ai/api/v1/billing/balance` with the API key —
// verified live 200 on 2026-11-18): `creditsBalance`, `activeUsageCost`,
// `floating_balance_usd`, `burn_usd_per_hour`, `runway_hours`.
//
// The balance lives on the infrastructure host (`www.runcrate.ai`), not the
// inference base (`api.runcrate.ai`) — dispatch and discovery use the
// manifest's inference base; this collector pins its own. The free-model
// allowance (weekly, workspace-wide) is dashboard-only — no key-scoped
// endpoint publishes it, so the balance is what the API can honestly report.
//
// Reads are Bearer-authenticated; never throws — a failed read returns a
// null result so the router treats it as unknown rather than dead.
import type { FetchLike, ProviderQuotaResult, ProviderQuotaWindow } from "../../quota/quota-contracts";
import { cleanError, quotaRecord } from "../../quota/quota-contracts";
import type { QuotaCollectionContext } from "../../quota/quota-support";
import { quotaUnreadable, readJsonOk } from "../shared/cli-client-kit";

/** Infrastructure host for billing routes (distinct from the inference base). */
const RUNCRATE_BILLING_BASE = "https://www.runcrate.ai/api/v1";

/** Reads the workspace balance and returns a normalized result. */
export async function fetchRuncrateQuota(
  credential: string,
  fetcher: FetchLike,
  _context?: QuotaCollectionContext,
): Promise<ProviderQuotaResult> {
  try {
    const token = credential.trim();
    if (!token) {
      return quotaUnreadable("runcrate", "Runcrate billing endpoint unavailable");
    }
    const payload = await readJsonOk(fetcher, `${RUNCRATE_BILLING_BASE}/billing/balance`, {
      accept: "application/json",
      authorization: `Bearer ${token}`,
    });
    if (!payload) {
      return quotaUnreadable("runcrate", "Runcrate billing endpoint unavailable");
    }
    const balance = quotaRecord(payload);

    const windows: ProviderQuotaWindow[] = [
      {
        // Credits are pooled workspace money; `remaining` with no ceiling is
        // the shape `creditWindowBalance` accepts (Command Code reports the
        // same way). Free-model allowance never draws from it.
        kind: "credit_balance",
        label: "Workspace credit balance",
        accounting: "pooled",
        usedPercent: null,
        remainingPercent: null,
        resetsAt: null,
        used: null,
        limit: null,
        remaining: typeof balance["creditsBalance"] === "number" ? balance["creditsBalance"] : null,
      },
    ];

    return {
      source: "runcrate",
      plan: null,
      windows,
      error: null,
    };
  } catch (error) {
    return quotaUnreadable("runcrate", cleanError(error));
  }
}
