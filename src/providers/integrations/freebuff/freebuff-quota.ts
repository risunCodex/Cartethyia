// Freebuff quota collector — TypeScript, Freebuff provider.
//
// Freebuff's billing surface is session-scoped: freebucks (balance, daily
// limit/spent/reset) and per-model rate limits are reported by the session
// endpoint, not by a static billing API. The collector reads the current
// session read-only (`GET /api/v1/freebuff/session`) using the account's
// device identity — it never performs an admission, so a quota refresh cannot
// spend a session, lock a model purchase, or trip the upstream's gates.
//
// Session-active windows: Freebuff locks each purchased session to one model
// until `expiresAt` (desktopPurchases). The session read returns those
// purchases, so the collector emits one `session_active` window per purchase,
// giving the provider-detail page its countdown pill ("Session · <model> ·
// Expires in Nh Nm").
//
// When the account carries no device identity (auth_state), the session read
// cannot be signed and is skipped; the collector then returns an empty quota
// rather than manufacturing a probe.

import type { QuotaFetcher } from "../../quota/quota-support";
import type { ProviderQuotaResult, ProviderQuotaWindow } from "../../quota/quota-contracts";
import { isRecord } from "../../../protocol/codecs";
import {
  FREEBUFF_API_HOST,
  FREEBUFF_CLIENT_HEADER,
  FREEBUFF_CLIENT_HEADER_VALUE,
  FREEBUFF_INSTALL_ID_HEADER,
  FREEBUFF_SESSION_PATH,
  FREEBUFF_ACTING_USER_HEADER,
  FREEBUFF_ADMISSION_USER_AGENT,
  freebuffSignRequest,
} from "./freebuff";
import type { FreebuffAuthState, FreebuffDeviceIdentity } from "./freebuff";
import { freebuffVirtualIdFor } from "./freebuff-virtual";

/**
 * Parses `desktopPurchases` from the session body. Returns the active
 * purchases (model + expiresAt) carried by the entitlement surface.
 */
function parsePurchases(body: Record<string, unknown>): Array<{ model: string; expiresAt: string }> {
  const purchases = body["desktopPurchases"];
  if (!Array.isArray(purchases)) return [];
  const result: Array<{ model: string; expiresAt: string }> = [];
  for (const raw of purchases) {
    if (!isRecord(raw)) continue;
    const model = typeof raw["model"] === "string" ? raw["model"] : undefined;
    const expiresAt = typeof raw["expiresAt"] === "string" ? raw["expiresAt"] : undefined;
    if (!model || !expiresAt) continue;
    // The upstream reports the `m-<hex>` roster key; the catalog publishes the
    // caller-facing virtual name, so the window must carry the same id a route
    // candidate does (`filterCandidateQuotaWindows` matches modelIds).
    result.push({ model: freebuffVirtualIdFor(model) ?? model, expiresAt });
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

/** Normalizes the stored auth_state into a usable device identity. */
function resolveDeviceIdentity(authState: unknown): FreebuffDeviceIdentity | undefined {
  if (!isRecord(authState)) return undefined;
  const device = authState["device"];
  if (!isRecord(device)) return undefined;
  const identity = device as Record<string, unknown>;
  if (
    typeof identity["version"] !== "number" ||
    typeof identity["publicKey"] !== "string" ||
    typeof identity["privateKey"] !== "string" ||
    typeof identity["keyId"] !== "string" ||
    typeof identity["installId"] !== "string"
  ) {
    return undefined;
  }
  return {
    version: identity["version"] as 1,
    publicKey: identity["publicKey"] as string,
    privateKey: identity["privateKey"] as string,
    keyId: identity["keyId"] as string,
    installId: identity["installId"] as string,
  };
}

function buildSessionHeaders(
  token: string,
  device: FreebuffDeviceIdentity,
  accountId: string | undefined,
  fetchId: string,
): Promise<Record<string, string>> {
  // The session read takes the same device signature as every other desktop
  // request. The fetchId keeps the signature's payload unique per request.
  return freebuffSignRequest(device, {
    method: "GET",
    path: FREEBUFF_SESSION_PATH,
    fetchId,
  }).then((signed) => ({
    Authorization: `Bearer ${token}`,
    [FREEBUFF_CLIENT_HEADER]: FREEBUFF_CLIENT_HEADER_VALUE,
    [FREEBUFF_INSTALL_ID_HEADER]: device.installId,
    ...(accountId === undefined ? {} : { [FREEBUFF_ACTING_USER_HEADER]: accountId }),
    "user-agent": FREEBUFF_ADMISSION_USER_AGENT,
    ...signed,
  }));
}

export const fetchFreebuffQuota: QuotaFetcher = async (credential, fetcher, context) => {
  const token = credential.trim();
  const fetchFn = fetcher ?? globalThis.fetch;
  const authState: FreebuffAuthState | undefined = isRecord(context?.auth_state)
    ? (context.auth_state as FreebuffAuthState)
    : undefined;
  const device = resolveDeviceIdentity(authState);
  if (!device) {
    return {
      source: "freebuff",
      plan: null,
      windows: [],
      error: "Freebuff quota check requires the account's device identity (re-login to register one).",
    };
  }
  const accountId =
    authState !== undefined && typeof authState["accountId"] === "string"
      ? authState["accountId"]
      : context?.accountId;
  const fetchId = crypto.randomUUID();
  let headers: Record<string, string>;
  try {
    headers = await buildSessionHeaders(token, device, accountId, fetchId);
  } catch (error) {
    return {
      source: "freebuff",
      plan: null,
      windows: [],
      error: error instanceof Error ? error.message : "Failed to sign the Freebuff session request",
    };
  }
  let res: Response;
  try {
    res = await fetchFn(`${FREEBUFF_API_HOST}${FREEBUFF_SESSION_PATH}`, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(15_000),
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
  // The session surface carries the entitlement numbers and the active
  // purchases. A malformed body yields empty windows; never fail the fetch.
  const windows = buildQuotaWindows(body);
  const purchases = parsePurchases(body);
  const sessionWindows = buildSessionWindows(purchases);
  const plan = typeof body["accessTier"] === "string" ? body["accessTier"] : null;
  return {
    source: "freebuff",
    plan,
    windows: [...windows, ...sessionWindows],
    error: null,
  };
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
  // Rate limits are reported per model in `rateLimitsByModel` (a map keyed by
  // model id).
  const rateLimitsByModel = body["rateLimitsByModel"];
  if (isRecord(rateLimitsByModel)) {
    for (const [modelId, raw] of Object.entries(rateLimitsByModel)) {
      if (!isRecord(raw)) continue;
      const limit = typeof raw["limit"] === "number" ? raw["limit"] : null;
      const recentCount = typeof raw["recentCount"] === "number" ? raw["recentCount"] : null;
      const resetAt = typeof raw["resetAt"] === "string" ? raw["resetAt"] : null;
      if (limit === null) continue;
      windows.push({
        kind: "rate_limit",
        label: "Daily session rate limit",
        accounting: "independent",
        // Publish the caller-facing virtual name, matching the catalog and the
        // routing candidate id (`filterCandidateQuotaWindows`).
        modelIds: [freebuffVirtualIdFor(modelId) ?? modelId],
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
