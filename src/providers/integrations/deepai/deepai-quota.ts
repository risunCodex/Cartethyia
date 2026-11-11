// DeepAI quota collector.
//
// Reads the account's DeepAI allowance from `GET /deepai_code/theos`
// (`balance`/`granted`/`refresh_at`), which is the daily free-tier grant. The
// entitlement surface (`/get_usage_summary`, `is_pro`) is probed second to
// distinguish a free vs pro account. Both calls require the `Api-Key` header
// (not Bearer).
import type {
  FetchLike,
  ProviderQuotaResult,
  ProviderQuotaWindow,
} from "../../quota/quota-contracts";
import { cleanError, number, percentWindow, text } from "../../quota/quota-contracts";
import type { QuotaCollectionContext } from "../../quota/quota-support";
import {
  DEEPAI_API_ORIGIN,
  DEEPAI_THEOS_PATH,
  DEEPAI_USAGE_SUMMARY_PATH,
  deepAIBaseHeaders,
} from "./deepai-common";

const LABEL = "DeepAI";

async function readJson(
  url: string,
  headers: Record<string, string>,
  fetcher: FetchLike,
): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetcher(url, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const parsed = (await res.json()) as unknown;
    return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Reads the DeepAI allowance and returns a normalized result.
 *
 * The Daily Theos window is pooled (the balance funds model calls) with the
 * daily grant as the ceiling and the account's `refresh_at` as the reset. The
 * plan is `free` when the allowance is enabled, `pro` when `is_pro` reads
 * true from the usage summary.
 */
export async function fetchDeepAIQuota(
  credential: string,
  fetcher: FetchLike,
  _context?: QuotaCollectionContext,
): Promise<ProviderQuotaResult> {
  try {
    const apiKey = text(credential);
    if (!apiKey) {
      return { source: LABEL, plan: null, windows: [], error: "DeepAI credential missing" };
    }
    const headers = await deepAIBaseHeaders(apiKey);
    const theos = await readJson(`${DEEPAI_API_ORIGIN}${DEEPAI_THEOS_PATH}`, headers, fetcher);
    if (!theos) {
      return { source: LABEL, plan: null, windows: [], error: "DeepAI /theos endpoint unavailable" };
    }

    const windows: ProviderQuotaWindow[] = [];
    const enabled = theos.enabled === true;
    const granted = number(theos.granted);
    const balance = number(theos.balance);
    if (enabled && granted !== null && granted > 0) {
      const used = balance === null ? null : Math.max(0, granted - balance);
      const resetsAt =
        typeof theos.refresh_at === "string" && Number.isFinite(Date.parse(theos.refresh_at))
          ? new Date(theos.refresh_at).toISOString()
          : null;
      windows.push(
        percentWindow(
          "theos_daily",
          "Daily Theos",
          used === null ? null : (used / granted) * 100,
          resetsAt,
          used,
          granted,
          "pooled",
        ),
      );
    }

    const summary = await readJson(`${DEEPAI_API_ORIGIN}${DEEPAI_USAGE_SUMMARY_PATH}`, headers, fetcher);
    const isPro = summary?.is_pro === true;
    const plan = enabled ? (isPro ? "pro" : "free") : null;
    return { source: LABEL, plan, windows, error: null };
  } catch (error) {
    return { source: LABEL, plan: null, windows: [], error: cleanError(error) };
  }
}
