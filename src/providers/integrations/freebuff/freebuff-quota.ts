// Freebuff quota collector — TypeScript, Freebuff provider.
//
// Freebuff's quota surface is the session-admission response: `freebucks`
// (balance, daily limit/spent/reset) and per-model `rateLimit` (6/day limited
// pool). There is no separate billing endpoint — admission is the entitlement
// surface. The collector performs a minimal admission for the cheapest model
// (Solar Pro 4, price 0) to read the numbers, then releases the session.

import type { QuotaFetcher } from "../../quota/quota-support";
import type { ProviderQuotaResult, ProviderQuotaWindow } from "../../quota/quota-contracts";
import { isRecord } from "../../../protocol/codecs";
import {
  FREEBUFF_API_HOST,
  FREEBUFF_CATALOG_PROTOCOL_HEADER,
  FREEBUFF_CATALOG_PROTOCOL_VERSION,
  FREEBUFF_CLIENT_HEADER,
  FREEBUFF_CLIENT_HEADER_VALUE,
  FREEBUFF_DESKTOP_ATTEMPT_HEADER,
  FREEBUFF_FIRST_TAB_DISCOUNT_HEADER,
  FREEBUFF_INSTALL_ID_HEADER,
  FREEBUFF_INSTANCE_HEADER,
  FREEBUFF_MODEL_HEADER,
  FREEBUFF_MULTI_SESSION_HEADER,
  FREEBUFF_PURCHASE_CONTINUITY_HEADER,
  FREEBUFF_SESSION_ADMISSION_PATH,
  FREEBUFF_SESSION_PATH,
  FREEBUFF_TIMEZONE_HEADER,
  FREEBUFF_WALLET_SPEND_LIMIT_HEADER,
  FREEBUFF_ADMISSION_USER_AGENT,
} from "./freebuff";

/** Cheapest open model for the probe admission (price 0). */
const QUOTA_PROBE_MODEL = "m-9a7e098cc1"; // Solar Pro 4

export const fetchFreebuffQuota: QuotaFetcher = async (credential, fetcher) => {
  const token = credential.trim();
  const fetchFn = fetcher ?? globalThis.fetch;
  const instanceId = crypto.randomUUID();
  const attemptId = crypto.randomUUID();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    [FREEBUFF_CATALOG_PROTOCOL_HEADER]: FREEBUFF_CATALOG_PROTOCOL_VERSION,
    [FREEBUFF_CLIENT_HEADER]: FREEBUFF_CLIENT_HEADER_VALUE,
    [FREEBUFF_TIMEZONE_HEADER]: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    [FREEBUFF_FIRST_TAB_DISCOUNT_HEADER]: "0",
    [FREEBUFF_MODEL_HEADER]: QUOTA_PROBE_MODEL,
    [FREEBUFF_WALLET_SPEND_LIMIT_HEADER]: "0",
    [FREEBUFF_INSTANCE_HEADER]: instanceId,
    [FREEBUFF_MULTI_SESSION_HEADER]: "1",
    [FREEBUFF_PURCHASE_CONTINUITY_HEADER]: "1",
    [FREEBUFF_DESKTOP_ATTEMPT_HEADER]: attemptId,
    [FREEBUFF_INSTALL_ID_HEADER]: crypto.randomUUID(),
    "user-agent": FREEBUFF_ADMISSION_USER_AGENT,
  };
  let res: Response;
  try {
    res = await fetchFn(`${FREEBUFF_API_HOST}${FREEBUFF_SESSION_ADMISSION_PATH}`, {
      method: "POST",
      headers,
      body: null,
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    return {
      source: "freebuff",
      plan: null,
      windows: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok || !isRecord(body)) {
    return {
      source: "freebuff",
      plan: null,
      windows: [],
      error: `Freebuff quota check failed (HTTP ${res.status})`,
    };
  }
  // Best-effort release.
  try {
    await fetchFn(`${FREEBUFF_API_HOST}${FREEBUFF_SESSION_PATH}`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${token}`,
        [FREEBUFF_CLIENT_HEADER]: FREEBUFF_CLIENT_HEADER_VALUE,
        [FREEBUFF_INSTANCE_HEADER]: instanceId,
        [FREEBUFF_MULTI_SESSION_HEADER]: "1",
        "user-agent": FREEBUFF_ADMISSION_USER_AGENT,
      },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    // ignore teardown failure
  }

  const windows = buildQuotaWindows(body);
  const plan = typeof body["accessTier"] === "string" ? body["accessTier"] : null;
  const result: ProviderQuotaResult = {
    source: "freebuff",
    plan,
    windows,
    error: null,
  };
  return result;
};

function buildQuotaWindows(body: Record<string, unknown>): ProviderQuotaResult["windows"] {
  const windows: ProviderQuotaWindow[] = [];
  const freebucks = body["freebucks"];
  if (isRecord(freebucks)) {
    const balance = typeof freebucks["balance"] === "number" ? freebucks["balance"] : null;
    const daily = freebucks["daily"];
    if (isRecord(daily)) {
      const limit = typeof daily["limit"] === "number" ? daily["limit"] : null;
      const spent = typeof daily["spent"] === "number" ? daily["spent"] : null;
      const remaining = typeof daily["remaining"] === "number" ? daily["remaining"] : null;
      const resetAt = typeof daily["resetAt"] === "string" ? daily["resetAt"] : null;
      windows.push({
        kind: "freebucks_daily",
        label: "Freebucks daily",
        accounting: "pooled",
        usedPercent: limit && spent !== null ? Math.round((spent / limit) * 100) : null,
        remainingPercent: limit && remaining !== null ? Math.round((remaining / limit) * 100) : null,
        resetsAt: resetAt,
        used: spent,
        limit,
        remaining,
        recurring: true,
      });
    }
    if (balance !== null) {
      windows.push({
        kind: "freebucks_balance",
        label: "Freebucks balance",
        accounting: "pooled",
        usedPercent: null,
        remainingPercent: null,
        resetsAt: null,
        remaining: balance,
      });
    }
  }
  const rateLimit = body["rateLimit"];
  if (isRecord(rateLimit)) {
    const limit = typeof rateLimit["limit"] === "number" ? rateLimit["limit"] : null;
    const recentCount = typeof rateLimit["recentCount"] === "number" ? rateLimit["recentCount"] : null;
    const resetAt = typeof rateLimit["resetAt"] === "string" ? rateLimit["resetAt"] : null;
    if (limit !== null) {
      windows.push({
        kind: "rate_limit",
        label: "Daily session rate limit",
        accounting: "independent",
        usedPercent: recentCount !== null && limit > 0 ? Math.round((recentCount / limit) * 100) : null,
        remainingPercent: recentCount !== null && limit > 0 ? Math.round(((limit - recentCount) / limit) * 100) : null,
        resetsAt: resetAt,
        used: recentCount,
        limit,
        remaining: recentCount !== null ? limit - recentCount : null,
        recurring: true,
      });
    }
  }
  return windows;
}
