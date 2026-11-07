/**
 * Qoder daily check-in (streak / 100 Credits per day), ported from the
 * reference bridge (`qoder_accounts.py` in the donor hub).
 *
 * Two upstream surfaces, tried in order:
 *
 * 1. Legacy sash: `GET /sash/api/v1/me/daily-check-in/status` then
 *    `POST /sash/api/v1/me/daily-check-in/claim`. The status exposes the
 *    streak (`currentStreakDays`) and the reward (`rewardCredits`, 100).
 * 2. Activity-platform campaign: when the legacy surface is absent (INTL often
 *    answers 404), `GET /sash/api/v1/me/campaigns` lists daily rewards and the
 *    CREDITS-kind claimable one is claimed via
 *    `POST /sash/api/v1/me/campaigns/{id}/claim`.
 *
 * The result shape is the same `DailyCheckinResult` the buddy family uses, so
 * the shared sweep slot ledger (`daily_checkin_ledger`), the log phrasing, and
 * the console surface treat Qoder like any other daily-grant provider.
 */
import { QODER_REALMS, qoderRealmForProvider } from "./qoder-realm";
import { getQoderVersion } from "../../operations/client-versions";
import {
  qoderMachineHeaders,
  type QoderNativeIdentity,
} from "./qoder-umid";
import {
  allocateQoderNativeIdentity,
  ensureQoderNativeIdentity,
  type QoderNativeIdentityStore,
} from "./qoder-native-identity-store";
import type { NativeIdentityRecord } from "../../../persistence/schema";
import { log } from "../../../observability/logger";

/** Structural fetch bound; Bun's own fetch type carries extra host props. */
type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
import type { DailyCheckinResult, DailyCheckinState } from "../buddy/buddy-checkin";

export const QODER_CHECKIN_PROVIDER_IDS: readonly string[] = ["qoder", "qodercn"];

/** True when this provider id runs the Qoder check-in surface. */
export function isQoderCheckinProvider(providerId: string): boolean {
  return (QODER_CHECKIN_PROVIDER_IDS as readonly string[]).includes(providerId);
}

/** Abort budget for one upstream check-in request. */
const TIMEOUT_MS = 15_000;

const CHECKIN_STATUS_PATH = "/sash/api/v1/me/daily-check-in/status";
const CHECKIN_CLAIM_PATH = "/sash/api/v1/me/daily-check-in/claim";
const CAMPAIGNS_PATH = "/sash/api/v1/me/campaigns";
const CAMPAIGN_CLAIM_PATH = "/sash/api/v1/me/campaigns/%s/claim";

/**
 * Headers the official desktop client sends to the `/sash` campaign surface.
 * Without these — notably `cosy-clienttype`, `cosy-version`, and the `Qoder`
 * user agent — the upstream hides the campaign list entirely
 * (`showCampaign:false`), so the daily grant never appears. Verified live:
 * the bare Authorization+Accept request returns an empty list, the desktop
 * header set returns `showCampaign:true` with the campaigns populated.
 *
 * `native` optionally carries the UMID machine headers (see `qoder-umid`);
 * when present they unlock the daily 100-credit campaign, which the server
 * otherwise silently filters out.
 */
export function buildCampaignHeaders(
  credential: string,
  native?: Record<string, string>,
): Record<string, string> {
  return {
    Authorization: `Bearer ${credential}`,
    Accept: "application/json",
    "User-Agent": "Qoder",
    "Cosy-ClientType": "10",
    "Cosy-Version": getQoderVersion(),
    ...(native ?? {}),
  };
}

function campaignHeaders(credential: string): Record<string, string> {
  return buildCampaignHeaders(credential);
}

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

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function baseOutcome(
  providerId: string,
  accountId: string,
): { providerId: string; accountId: string; credit: null; streakDays: null; error: null } {
  return { providerId, accountId, credit: null, streakDays: null, error: null };
}

function asState(state: string, today: string, lastClaimedAt: unknown): { active: boolean; todayCheckedIn: boolean } {
  const status = state.toUpperCase();
  const active = status === "CLAIMABLE" || status === "CLAIMED";
  let claimedToday = false;
  if (status === "CLAIMED") {
    const stamp = asNumber(lastClaimedAt);
    if (stamp !== null) {
      const day = new Date(stamp * 1000).toISOString().slice(0, 10);
      claimedToday = day === today;
    }
  }
  return { active, todayCheckedIn: claimedToday };
}

/**
 * Normalizes one upstream campaign row to the snake_case shape the claim loop
 * consumes. The API returns camelCase keys (`campaignId`, `actionType`,
 * `claimStatus`); the fixtures and the donor hub use snake_case — accept both.
 */
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

/** GET campaign list once with given headers; `null` when unreachable/unauthorized. */
async function getCampaigns(
  base: string,
  headers: Record<string, string>,
  fetcher: Fetcher,
): Promise<Record<string, unknown>[] | null> {
  try {
    const response = await fetcher(`${base}${CAMPAIGNS_PATH}`, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (response.status === 401 || response.status === 403) return null;
    if (!response.ok) return null;
    const payload: unknown = await response.json().catch(() => null);
    const rec = asRecord(payload);
    const list = Array.isArray(rec?.["campaigns"]) ? rec!["campaigns"] : Array.isArray(payload) ? payload : null;
    if (!Array.isArray(list)) return null;
    return (list as Record<string, unknown>[]).map(normalizeCampaign);
  } catch {
    return null;
  }
}

/**
 * One attempted claim across a header set, returning the same result shape as
 * `claimCampaign` (already-claimed grants resolve to `already_claimed`).
 */
async function tryClaimDaily(
  base: string,
  headers: Record<string, string>,
  fetcher: Fetcher,
): Promise<{ state: DailyCheckinState; amount: number; error: string | null }> {
  const campaigns = await getCampaigns(base, headers, fetcher);
  if (campaigns === null) {
    return { state: "error", amount: 0, error: "Campaign list unavailable." };
  }
  // Claim a `CLAIMABLE` CREDITS-kind campaign. Promo rows (`VIEW_DETAILS`,
  // no benefit) are not credit grants and must not be claimed — claiming one
  // spends the account's daily slot for nothing and makes the sweep report a
  // misleading `claimed` with 0 credits.
  const claimable = campaigns.filter((c) => {
    if (String(c["claim_status"] ?? "").toUpperCase() !== "CLAIMABLE") return false;
    const kind = String(asRecord(c["benefit"])?.["kind"] ?? "").toUpperCase();
    const action = String(c["action_type"] ?? "").toUpperCase();
    return kind === "CREDITS" || action === "CLAIM_BENEFIT";
  });
  for (const campaign of claimable) {
    const benefit = asRecord(campaign["benefit"]);
    const campaignId = String(campaign["campaign_id"] ?? "");
    if (!campaignId) continue;
    const claim = await claimWithHeaders(base, campaignId, headers, fetcher);
    if (claim.state === "claimed") {
      const amount = asNumber(benefit?.["amount"]) ?? claim.amount;
      return { state: "claimed", amount, error: null };
    }
    if (claim.state === "already_claimed") return { state: "already_claimed", amount: 0, error: null };
    if (claim.state === "not_eligible") return { state: "not_eligible", amount: 0, error: null };
    return { state: "error", amount: 0, error: "Campaign claim failed." };
  }
  // Nothing claimable. Only a CREDITS-kind campaign that is `CLAIMED` proves
  // today's credit was already taken; a claimed promo (`VIEW_DETAILS`, no
  // benefit) says nothing about the daily grant, so it must not be reported
  // as already_claimed. When the CREDITS campaign is absent entirely, the
  // daily grant is simply not present (or hidden) for this account.
  const anyCreditsClaimed = campaigns.some((c) => {
    if (String(c["claim_status"] ?? "").toUpperCase() !== "CLAIMED") return false;
    const kind = String(asRecord(c["benefit"])?.["kind"] ?? "").toUpperCase();
    const action = String(c["action_type"] ?? "").toUpperCase();
    return kind === "CREDITS" || action === "CLAIM_BENEFIT";
  });
  if (anyCreditsClaimed) return { state: "already_claimed", amount: 0, error: null };
  return { state: "unavailable", amount: 0, error: "No daily CREDITS campaign claimable." };
}

/**
 * Probes the daily CREDITS grant under a native device identity.
 *
 * The server binds the grant to the device identity and hides it once a
 * device claimed today, so an account claims under its own persisted device
 * (minted seed). A bound identity that resolves to `claimed`/`already_claimed`
 * is terminal; one that resolves to `unavailable`/`not_eligible` is honest
 * (the device is spent for the day or the person is blocked) and is also
 * terminal — the account must not move to a different device, because that is
 * how devices are re-spun. Only an *error* (stored identity stopped working)
 * falls back to a freshly minted identity.
 *
 * Returns `{ result, identity }` where `identity` is the device that produced
 * a terminal `claimed`/`already_claimed` outcome (or `null`).
 */
async function probeDailyClaim(
  base: string,
  credential: string,
  fetcher: Fetcher,
  options: {
    readonly bound?: QoderNativeIdentity | null;
    readonly alt?: QoderNativeIdentity | null;
  } = {},
): Promise<{ result: { state: DailyCheckinState; amount: number; error: string | null }; identity: QoderNativeIdentity | null }> {
  const basic = await tryClaimDaily(base, campaignHeaders(credential), fetcher);
  if (basic.state === "claimed" || basic.state === "already_claimed") {
    // `tryClaimDaily` only claims CREDITS-kind campaigns, so a `claimed` or
    // `already_claimed` basic result is already about the daily credit grant —
    // terminal, no identity probe needed.
    return { result: basic, identity: null };
  }
  if (basic.state === "unavailable") {
    const identities = [options.bound, options.alt].filter((i): i is QoderNativeIdentity => i !== null && i !== undefined);
    for (const identity of identities) {
      const headers = { ...campaignHeaders(credential), ...qoderMachineHeaders(identity) };
      const result = await tryClaimDaily(base, headers, fetcher);
      if (result.state === "claimed" || result.state === "already_claimed") {
        return { result, identity };
      }
      // Only an error falls through to the next identity (e.g. the bound one
      // stopped working). Any honest outcome (unavailable/not_eligible) is
      // terminal.
      if (result.state !== "error") return { result, identity };
    }
  }
  return { result: basic, identity: null };
}

/**
 * Claims one campaign and returns the resulting state. Mirrors the donor's
 * `claim_campaign` idempotence handling: a 409 or `ALREADY_CLAIMED` body is
 * an already-claimed grant, `SAME_PERSON_ALREADY_CLAIMED`/`BLOCKED` is a
 * same-person block (not a failure of this account's day), and anything else
 * is an error.
 */
async function claimWithHeaders(
  base: string,
  campaignId: string,
  headers: Record<string, string>,
  fetcher: Fetcher,
): Promise<{ state: DailyCheckinState; amount: number }> {
  const url = base + CAMPAIGN_CLAIM_PATH.replace("%s", encodeURIComponent(campaignId));
  let response: Response;
  try {
    response = await fetcher(url, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return { state: "error", amount: 0 };
  }
  const raw = await response.text().catch(() => "");
  const payload: unknown = raw ? safeParse(raw) : null;
  const rec = asRecord(payload);
  const status = String(rec?.["status"] ?? "").toUpperCase();
  const failure = String(rec?.["failureCode"] ?? "").toUpperCase();
  const success = rec?.["success"] !== false;
  const benefit = asRecord(rec?.["benefit"]);
  const amount = asNumber(rec?.["amount"] ?? benefit?.["amount"]) ?? 0;
  if (response.status === 409 || failure === "ALREADY_CLAIMED" || status === "CLAIMED" && failure === "REPLAYED") {
    return { state: "already_claimed", amount };
  }
  if (failure === "SAME_PERSON_ALREADY_CLAIMED" || status === "BLOCKED") {
    return { state: "not_eligible", amount: 0 };
  }
  if (response.ok && success && (status === "CLAIMED" || status === "GRANTED" || status === "SUCCESS")) {
    return { state: "claimed", amount };
  }
  return { state: "error", amount: 0 };
}

/** Legacy sash status + claim. Returns `null` when the surface is absent (404/405/410). */
async function legacySashCheckin(args: {
  readonly base: string;
  readonly credential: string;
  readonly fetcher: Fetcher;
  readonly now?: () => Date;
}): Promise<{ state: DailyCheckinState; credit: number; streakDays: number } | null> {
  const { base, credential, fetcher } = args;
  const today = (args.now?.() ?? new Date()).toISOString().slice(0, 10);
  let statusResponse: Response;
  try {
    statusResponse = await fetcher(`${base}${CHECKIN_STATUS_PATH}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${credential}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return { state: "error", credit: 0, streakDays: 0 };
  }
  if (statusResponse.status === 401 || statusResponse.status === 403) {
    return { state: "error", credit: 0, streakDays: 0 };
  }
  if (statusResponse.status === 404 || statusResponse.status === 405 || statusResponse.status === 410) {
    return null; // surface absent — caller falls back to campaign
  }
  if (!statusResponse.ok) {
    return { state: "error", credit: 0, streakDays: 0 };
  }
  const payload: unknown = await statusResponse.json().catch(() => null);
  const rec = asRecord(payload);
  if (!rec) return { state: "error", credit: 0, streakDays: 0 };
  const { active, todayCheckedIn } = asState(String(rec["status"] ?? ""), today, rec["lastClaimedAt"]);
  const streakDays = asNumber(rec["currentStreakDays"]) ?? 0;
  const credit = asNumber(rec["rewardCredits"]) ?? 100;
  if (todayCheckedIn) return { state: "already_claimed", credit: 0, streakDays };
  if (!active) return { state: "not_eligible", credit: 0, streakDays };
  // Claim.
  let claimResponse: Response;
  try {
    claimResponse = await fetcher(`${base}${CHECKIN_CLAIM_PATH}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${credential}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: "{}",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return { state: "error", credit: 0, streakDays };
  }
  const raw = await claimResponse.text().catch(() => "");
  const lower = raw.toLowerCase();
  if (claimResponse.status === 409 || lower.includes("already_claimed") || lower.includes("已签到")) {
    return { state: "already_claimed", credit: 0, streakDays };
  }
  const body: unknown = raw ? safeParse(raw) : null;
  const bodyRec = asRecord(body);
  const ok = claimResponse.ok && bodyRec?.["success"] !== false;
  if (!ok) return { state: "error", credit: 0, streakDays };
  return { state: "claimed", credit, streakDays };
}

/**
 * Performs one account's Qoder daily check-in: legacy sash first, campaign
 * fallback when the sash surface is absent. Returns the same
 * `DailyCheckinResult` shape the shared sweep consumes.
 */
export async function fetchQoderDailyCheckin(args: {
  readonly providerId: string;
  readonly accountId: string;
  readonly credential: string;
  readonly fetcher: Fetcher;
  readonly now?: () => Date;
  /**
   * The account's persisted native device identity. When absent and
   * `nativeIdentityStore` is provided, the first check-in mints one and
   * persists it (see `allocateQoderNativeIdentity`). When the store is absent
   * too (tests), `identities` supplies the identities to probe.
   */
  readonly nativeIdentity?: NativeIdentityRecord | null;
  readonly nativeIdentityStore?: QoderNativeIdentityStore;
  /** Test-only: override the identity list (defaults to bridge-minted). */
  readonly identities?: readonly QoderNativeIdentity[];
}): Promise<DailyCheckinResult> {
  const { providerId, accountId, credential, fetcher } = args;
  const baseResult = baseOutcome(providerId, accountId);
  if (!credential) {
    return { ...baseResult, state: "error", error: "Account has no stored credential." };
  }
  const realm = qoderRealmForProvider(providerId);
  const base = QODER_REALMS[realm].openapi;

  const sash = await legacySashCheckin({
    base,
    credential,
    fetcher,
    ...(args.now === undefined ? {} : { now: args.now }),
  });
  if (sash !== null) {
    return {
      ...baseResult,
      state: sash.state,
      credit: sash.state === "claimed" ? sash.credit : null,
      streakDays: sash.streakDays,
      ...(sash.state === "error" ? { error: "Upstream daily check-in failed." } : {}),
    };
  }

  // Legacy surface absent: campaign fallback. Prefer the account's persisted
  // device (loaded from the store); on first check-in with no stored device,
  // mint one before probing so the account claims under the same identity
  // every day.
  const store = args.nativeIdentityStore;
  let bound: QoderNativeIdentity | null = null;
  let boundRecord: NativeIdentityRecord | null = args.nativeIdentity ?? null;
  if (store) {
    boundRecord = (await store.get(providerId, accountId)) ?? boundRecord;
  }
  if (boundRecord) {
    // Ensure the stored device is active on this host (replay its seed).
    const active = store ? await ensureQoderNativeIdentity(store, providerId, accountId) : true;
    if (active) {
      bound = {
        machineToken: boundRecord.machineToken,
        machineType: boundRecord.machineType,
        machineCode: boundRecord.machineCode,
        isVm: false,
        source: "runtime-info",
      };
    }
  }
  if (!bound && store) {
    const minted = await allocateQoderNativeIdentity(store, providerId, accountId, { realm });
    if (minted) {
      boundRecord = minted;
      bound = {
        machineToken: minted.machineToken,
        machineType: minted.machineType,
        machineCode: minted.machineCode,
        isVm: false,
        source: "runtime-info",
      };
    }
  }

  const alt = args.identities?.[0] ?? null;
  const probe = await probeDailyClaim(base, credential, fetcher, {
    bound,
    alt,
  });
  const probed = probe.result;

  // If a non-bound identity won (the bound one errored), persist it as the
  // account's device — but only when its token is actually free, so the
  // one-device-per-account invariant holds.
  if (store && probe.identity !== null && probe.identity.machineToken !== bound?.machineToken) {
    const occupied = await store.occupied(accountId);
    if (!occupied.has(probe.identity.machineToken)) {
      try {
        await store.bind(providerId, accountId, {
          machineToken: probe.identity.machineToken,
          machineType: probe.identity.machineType,
          machineCode: probe.identity.machineCode,
        });
      } catch (error) {
        log.warn(`[qoder] could not bind native identity for account=${accountId}`, error as Error);
      }
    }
  }

  if (probed.state === "claimed") {
    return { ...baseResult, state: "claimed", credit: probed.amount, streakDays: null };
  }
  if (probed.state === "already_claimed") {
    return { ...baseResult, state: "already_claimed", streakDays: null };
  }
  if (probed.state === "not_eligible") {
    return { ...baseResult, state: "not_eligible", error: "Same-person claim already used today." };
  }
  return { ...baseResult, state: probed.state, error: probed.error };
}
