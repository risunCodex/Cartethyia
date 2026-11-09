// Freebuff quota collector — TypeScript, Freebuff provider.
//
// Freebuff's quota surface is the session-admission response: `freebucks`
// (balance, daily limit/spent/reset) and per-model `rateLimit` (6/day limited
// pool). There is no separate billing endpoint — admission is the entitlement
// surface. The collector performs a minimal admission for the cheapest model
// (Solar Pro 4, price 0) to read the numbers, then releases the session.
//
// Session-active windows: Freebuff locks each purchased session to one model
// until `expiresAt` (desktopPurchases). The collector also does a live
// `GET /api/v1/freebuff/session` to read the current active purchases and emits
// one `session_active` window per purchase, so the provider-detail page can show
// a countdown pill ("Session · <model> · Expires in Nh Nm"). The GET /session
// read requires the device identity (auth_state.device); if it is absent the
// collector skips the session read and still returns the admission windows.

import type { QuotaFetcher, QuotaCollectionContext } from "../../quota/quota-support";
import type { ProviderQuotaResult, ProviderQuotaWindow } from "../../quota/quota-contracts";
import { isRecord } from "../../../protocol/codecs";
import {
  FREEBUFF_API_HOST,
  FREEBUFF_CATALOG_PROTOCOL_HEADER,
  FREEBUFF_CATALOG_PROTOCOL_VERSION,
  FREEBUFF_CLIENT_HEADER,
  FREEBUFF_CLIENT_HEADER_VALUE,
  FREEBUFF_CLIENT_VERSION_HEADER,
  FREEBUFF_DESKTOP_ATTEMPT_HEADER,
  FREEBUFF_DESKTOP_AGENT_VERSION,
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
  FREEBUFF_ACTING_USER_HEADER,
  freebuffSignRequest,
  type FreebuffAuthState,
} from "./freebuff";

/** Cheapest open model for the probe admission (price 0). */
const QUOTA_PROBE_MODEL = "m-9a7e098cc1"; // Solar Pro 4

function readAuthState(context: QuotaCollectionContext | undefined): FreebuffAuthState {
  const authState = context?.auth_state;
  if (!isRecord(authState)) return {};
  const accountId = typeof authState["accountId"] === "string" ? authState["accountId"] : undefined;
  const deviceRaw = authState["device"];
  if (!isRecord(deviceRaw)) return { accountId };
  const version = deviceRaw["version"];
  const publicKey = deviceRaw["publicKey"];
  const privateKey = deviceRaw["privateKey"];
  const keyId = deviceRaw["keyId"];
  const installId = deviceRaw["installId"];
  if (
    version === 1 &&
    typeof publicKey === "string" &&
    typeof privateKey === "string" &&
    typeof keyId === "string" &&
    typeof installId === "string"
  ) {
    return { accountId, device: { version: 1, publicKey, privateKey, keyId, installId } };
  }
  return { accountId };
}

/**
 * Live read of the current session state: `GET /api/v1/freebuff/session`.
 * Returns the parsed `desktopPurchases` array (with model / expiresAt), or null
 * when the device identity is missing or the read fails (caller falls back).
 */
async function freebuffReadSession(
  token: string,
  authState: FreebuffAuthState,
  fetchFn: typeof fetch,
): Promise<Array<{ model: string; expiresAt: string; holderInstanceId?: string }> | null> {
  const device = authState.device;
  if (!device) return null;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    [FREEBUFF_CATALOG_PROTOCOL_HEADER]: FREEBUFF_CATALOG_PROTOCOL_VERSION,
    [FREEBUFF_CLIENT_HEADER]: FREEBUFF_CLIENT_HEADER_VALUE,
    [FREEBUFF_CLIENT_VERSION_HEADER]: FREEBUFF_DESKTOP_AGENT_VERSION,
    [FREEBUFF_INSTALL_ID_HEADER]: device.installId,
    "user-agent": FREEBUFF_ADMISSION_USER_AGENT,
  };
  if (authState.accountId) headers[FREEBUFF_ACTING_USER_HEADER] = authState.accountId;
  Object.assign(
    headers,
    await freebuffSignRequest(device, { method: "GET", path: FREEBUFF_SESSION_PATH }),
  );
  let res: Response;
  try {
    res = await fetchFn(`${FREEBUFF_API_HOST}${FREEBUFF_SESSION_PATH}`, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const body: unknown = await res.json().catch(() => null);
  if (!isRecord(body)) return null;
  const purchases = body["desktopPurchases"];
  if (!Array.isArray(purchases)) return null;
  const result: Array<{ model: string; expiresAt: string; holderInstanceId?: string }> = [];
  for (const raw of purchases) {
    if (!isRecord(raw)) continue;
    const model = typeof raw["model"] === "string" ? raw["model"] : undefined;
    const expiresAt = typeof raw["expiresAt"] === "string" ? raw["expiresAt"] : undefined;
    if (!model || !expiresAt) continue;
    const holderInstanceId = typeof raw["holderInstanceId"] === "string" ? raw["holderInstanceId"] : undefined;
    result.push({ model, expiresAt, ...(holderInstanceId !== undefined ? { holderInstanceId } : {}) });
  }
  return result;
}

function buildSessionWindows(purchases: Array<{ model: string; expiresAt: string }>): ProviderQuotaWindow[] {
  const now = Date.now();
  const windows: ProviderQuotaWindow[] = [];
  for (const purchase of purchases) {
    const expiresMs = new Date(purchase.expiresAt).getTime();
    if (!Number.isFinite(expiresMs) || expiresMs <= now) continue;
    const remainingMs = expiresMs - now;
    const remainingMinutes = Math.max(1, Math.ceil(remainingMs / 60_000));
    const remainingPercent = Math.min(100, Math.max(0, Math.round((remainingMs / 3_600_000) * 100)));
    windows.push({
      kind: "session_active",
      label: "Session active",
      accounting: "independent",
      usedPercent: null,
      remainingPercent,
      modelIds: [purchase.model],
      resetsAt: purchase.expiresAt,
      remaining: remainingMinutes,
      recurring: false,
    });
  }
  return windows;
}

export const fetchFreebuffQuota: QuotaFetcher = async (credential, fetcher, context) => {
  const token = credential.trim();
  const fetchFn = fetcher ?? globalThis.fetch;
  const authState = readAuthState(context);
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
  // Live session-active windows (per purchase, countdown to expiresAt). The
  // read is graceful: missing device identity or a failed GET /session yields
  // no session windows — never fails the quota fetch.
  const purchases = await freebuffReadSession(token, authState, fetchFn);
  const sessionWindows = purchases === null ? [] : buildSessionWindows(purchases);
  const plan = typeof body["accessTier"] === "string" ? body["accessTier"] : null;
  const result: ProviderQuotaResult = {
    source: "freebuff",
    plan,
    windows: [...windows, ...sessionWindows],
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
