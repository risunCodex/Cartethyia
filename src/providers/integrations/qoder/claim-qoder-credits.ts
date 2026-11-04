/**
 * Manual Qoder daily-credits claim (operator-triggered).
 *
 * Mirrors the ZCode gift-claim flow: an explicit `POST /accounts/:id/claim-qoder-credits`
 * resolves the account's credential, ensures a native UMID identity, lists the
 * sash campaigns, and claims the CREDITS `CLAIM_BENEFIT` campaign by its
 * `campaignId` UUID. The CREDITS campaign only surfaces when the real UMID
 * headers are sent (generated identities keep it hidden — verified live
 * 2026-11-04, see research doc Part F).
 *
 * Credential kinds:
 * - `dt-…` (device token) — used directly as the Bearer.
 * - `pt-…` (personal access token) — exchanged first to a job token via
 *   `POST /api/v1/jobToken/exchange` (the sash surface rejects raw PATs with
 *   401; verified live 2026-11-04).
 */
import type { CartethyiaDatabase } from "../../../persistence/db-handle";
import type { ValidatedFetch } from "../../../network/outbound-fetch";
import { qoderRealmForProvider, QODER_REALMS } from "./qoder-realm";
import {
  buildCampaignHeaders,
} from "./qoder-checkin";
import { qoderMachineHeaders } from "./qoder-umid";
import {
  DrizzleQoderNativeIdentityStore,
  allocateQoderNativeIdentity,
} from "./qoder-native-identity-store";

/** Result shape mirrors the ZCode gift claim so the console can reuse one UI. */
export interface QoderCreditClaimResult {
  readonly state: "claimed" | "already_claimed" | "nothing" | "error";
  readonly amount: number;
  readonly detail: string | null;
}

export const QODER_CREDIT_PROVIDER_IDS = ["qoder", "qodercn"] as const;

const PAT_PREFIX = "pt-";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null) return null;
  return value as Record<string, unknown>;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function normalizeCampaign(raw: Record<string, unknown>): Record<string, unknown> {
  const benefit = asRecord(raw["benefit"]);
  return {
    campaign_id: String(raw["campaignId"] ?? raw["campaign_id"] ?? ""),
    campaign_key: String(raw["campaignKey"] ?? raw["campaign_key"] ?? ""),
    action_type: String(raw["actionType"] ?? raw["action_type"] ?? ""),
    claim_status: String(raw["claimStatus"] ?? raw["claim_status"] ?? ""),
    ...(benefit !== null ? { benefit } : {}),
  };
}

/**
 * Exchanges a PAT (`pt-…`) for a job token (`jt-…`) on the realm's openapi
 * host. Returns the job token, or `null` when the exchange fails.
 *
 * The real client binds the machine identity at exchange time
 * (`getMachineIdentityRequestFields`), so `machine_id` + `machine_token` are
 * sent when available — the job token is then bound to that machine.
 */
async function exchangePatToJobToken(
  base: string,
  pat: string,
  fetcher: ValidatedFetch,
  machine?: { readonly id?: string; readonly token?: string },
): Promise<string | null> {
  try {
    const body: Record<string, unknown> = { personal_token: pat };
    if (machine?.id) body.machine_id = machine.id;
    if (machine?.token) body.machine_token = machine.token;
    const res = await fetcher(`${base}/api/v1/jobToken/exchange`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "qoder/1.1.59",
        "Cosy-ClientType": "5",
        "Cosy-Version": "1.1.59",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(25_000),
    });
    if (!res.ok) return null;
    const payload: unknown = await res.json().catch(() => null);
    const rec = asRecord(payload);
    const token = String(rec?.["token"] ?? rec?.["device_token"] ?? rec?.["access_token"] ?? "");
    return token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

/**
 * Reads the platform machine id from the real client's cache when present
 * (`%APPDATA%/Qoder/cache/machine_token.json` → `id`). Returns `undefined`
 * when unavailable; callers fall back to the machine token.
 */
function readPlatformMachineId(): string | undefined {
  try {
    const { existsSync, readFileSync } = require("node:fs") as typeof import("node:fs");
    const root = process.env.APPDATA ?? "";
    const path = root ? `${root}/Qoder/cache/machine_token.json` : "";
    if (!path || !existsSync(path)) return undefined;
    const rec = JSON.parse(readFileSync(path, "utf8")) as { id?: string };
    return typeof rec.id === "string" && rec.id.length > 0 ? rec.id : undefined;
  } catch {
    return undefined;
  }
}

export async function claimQoderCredits(args: {
  readonly db: CartethyiaDatabase;
  readonly providerId: string;
  readonly accountId: string;
  readonly credential: string;
  readonly fetcher: ValidatedFetch;
}): Promise<QoderCreditClaimResult> {
  const { db, providerId, accountId, credential, fetcher } = args;
  if (!credential) return { state: "error", amount: 0, detail: "Account has no stored credential." };

  const realm = qoderRealmForProvider(providerId);
  const base = QODER_REALMS[realm].openapi;

  // Ensure a native UMID identity exists and is bound to this account.
  const store = new DrizzleQoderNativeIdentityStore(db);
  let bound = await store.get(providerId, accountId);
  if (!bound) {
    const minted = await allocateQoderNativeIdentity(store, providerId, accountId);
    if (!minted) return { state: "error", amount: 0, detail: "Could not mint a UMID identity for this account." };
    bound = minted;
  }
  const identity = {
    machineToken: bound.machineToken,
    machineType: bound.machineType,
    machineCode: bound.machineCode,
    isVm: false,
    source: bound.source ?? "runtime-info",
  } as const;
  // The upstream binds COSY signatures to the platform machine id (UUID on
  // Windows, serial-hex elsewhere). Use the real client's cached id when
  // present; fall back to the machine token.
  const machineId = readPlatformMachineId();
  const umidHeaders = qoderMachineHeaders(identity, machineId);

  // PATs must be exchanged to a job token before they are accepted by the sash
  // surface (raw `pt-…` → 401). Device tokens (`dt-…`) are used directly.
  // Exchange binds the machine identity like the real client.
  let bearer = credential;
  if (credential.startsWith(PAT_PREFIX)) {
    const jt = await exchangePatToJobToken(base, credential, fetcher, {
      ...(machineId !== undefined ? { id: machineId } : {}),
      token: identity.machineToken,
    });
    if (!jt) return { state: "error", amount: 0, detail: "Could not exchange PAT for a job token." };
    bearer = jt;
  }

  const headers = {
    ...buildCampaignHeaders(bearer),
    ...umidHeaders,
  };

  // 1. List campaigns.
  let campaigns: Array<Record<string, unknown>> = [];
  try {
    const res = await fetcher(`${base}/sash/api/v1/me/campaigns`, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(25_000),
    });
    if (!res.ok) {
      return { state: "error", amount: 0, detail: `Campaign list failed (HTTP ${res.status}).` };
    }
    const payload: unknown = await res.json().catch(() => null);
    const rec = asRecord(payload);
    const list = Array.isArray(rec?.["campaigns"])
      ? rec!["campaigns"]
      : Array.isArray(payload)
        ? payload
        : null;
    if (Array.isArray(list)) campaigns = (list as Array<Record<string, unknown>>).map(normalizeCampaign);
  } catch {
    return { state: "error", amount: 0, detail: "Campaign list request failed." };
  }

  // 2. Pick the CREDITS CLAIM_BENEFIT campaign that is not already claimed.
  const target = campaigns.find((c) => {
    if (String(c["claim_status"] ?? "").toUpperCase() === "CLAIMED") return false;
    const action = String(c["action_type"] ?? "").toUpperCase();
    const kind = String(asRecord(c["benefit"])?.["kind"] ?? "").toUpperCase();
    return action === "CLAIM_BENEFIT" && kind === "CREDITS";
  });
  if (!target) {
    const anyClaimed = campaigns.some((c) => {
      const action = String(c["action_type"] ?? "").toUpperCase();
      const kind = String(asRecord(c["benefit"])?.["kind"] ?? "").toUpperCase();
      return action === "CLAIM_BENEFIT" && kind === "CREDITS" && String(c["claim_status"] ?? "").toUpperCase() === "CLAIMED";
    });
    return anyClaimed
      ? { state: "already_claimed", amount: 0, detail: null }
      : { state: "nothing", amount: 0, detail: null };
  }

  const campaignId = String(target["campaign_id"] ?? "");
  if (!campaignId) return { state: "error", amount: 0, detail: "Campaign has no id." };

  // 3. Claim.
  try {
    const res = await fetcher(`${base}/sash/api/v1/me/campaigns/${encodeURIComponent(campaignId)}/claim`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(25_000),
    });
    const raw = await res.text().catch(() => "");
    const payload: unknown = raw ? safeParse(raw) : null;
    const rec = asRecord(payload);
    const status = String(rec?.["status"] ?? "").toUpperCase();
    const failure = String(rec?.["failureCode"] ?? "").toUpperCase();
    const success = rec?.["success"] !== false;
    const benefit = asRecord(rec?.["benefit"]);
    const amount = asNumber(rec?.["amount"] ?? benefit?.["amount"]) ?? 100;
    if (res.status === 409 || failure === "ALREADY_CLAIMED" || (status === "CLAIMED" && failure === "REPLAYED")) {
      return { state: "already_claimed", amount: 0, detail: null };
    }
    if (failure === "SAME_PERSON_ALREADY_CLAIMED" || status === "BLOCKED") {
      return { state: "already_claimed", amount: 0, detail: "Same-person claim already used for this campaign." };
    }
    if (res.ok && success && (status === "CLAIMED" || status === "GRANTED" || status === "SUCCESS")) {
      return { state: "claimed", amount, detail: null };
    }
    return { state: "error", amount: 0, detail: `Claim failed (${res.status})` };
  } catch {
    return { state: "error", amount: 0, detail: "Claim request failed." };
  }
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
