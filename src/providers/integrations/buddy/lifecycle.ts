import { asCoercedNumber as sharedAsNumber, asRecord as sharedAsRecord } from "../../../shared/coerce";
import { providerBaseUrl, BUDDY_PROVIDER_IDS } from "../../provider-metadata";
import { sleep } from "../../../shared/sleep";
import { QODER_CHECKIN_PROVIDER_IDS } from "../qoder/qoder-checkin";
import { buildCodeBuddyUserAgent } from "../../operations/client-versions";
import { codebuddyDomain, type CodeBuddyVariant } from "./codebuddy/shared";
import { randomUUID } from "node:crypto";
import type { FetchLike } from "../../quota/quota-contracts";
import { text as asText } from "../../quota/quota-contracts";
import type { ToolDefinition } from "../../../protocol/canonical-model";

// ── buddy-checkin ──────────────────────────────────────────

export const DAILY_CHECKIN_PROVIDER_IDS: readonly string[] = [
  ...BUDDY_PROVIDER_IDS,
  ...QODER_CHECKIN_PROVIDER_IDS,
];

const TIMEOUT_MS = 15_000;

export const CHECKIN_STATUS_PATH = "/billing/meter/checkin-activity-status";

export const CHECKIN_CLAIM_PATH = "/billing/meter/daily-checkin";

export type DailyCheckinState =
  | "claimed"
  | "already_claimed"
  | "not_eligible"
  | "event_ended"
  | "unavailable"
  | "error";

export interface DailyCheckinResult {
  readonly providerId: string;
  readonly accountId: string;
  readonly state: DailyCheckinState;
  /** Credits granted by this claim; `null` when nothing was granted. */
  readonly credit: number | null;
  readonly streakDays: number | null;
  /** Provider-facing detail for the audit log; `null` on success. */
  readonly error: string | null;
}

export interface BuddyActivityReportEvent {
  readonly eventCode: "chat_request_send";
  readonly timestamp: number;
  readonly reportDelay: number;
  readonly mode: string;
  readonly conversationId: string;
  readonly requestId: string;
  readonly inputLength: number;
  readonly requestModelId: string;
  readonly requestModelName: string;
  readonly isPlan: boolean;
  readonly isAutoExecuteTerminal: boolean;
  readonly isAutoModify: boolean;
  readonly codebaseEnable: boolean;
  readonly maxToken: number;
  readonly maxSteps: number;
  readonly temperature: number;
  readonly maxRetries: number;
  readonly mentionContexts: readonly unknown[];
  readonly knowledgeId: readonly unknown[];
  readonly knowledgeName: readonly unknown[];
  readonly codebaseId: string;
  readonly mentionContextCount: number;
  readonly command: string;
  readonly recommendId: string;
  readonly skillId: string;
  readonly skillCount: number;
  readonly totalCount: number;
  readonly presentAt: number;
  readonly rootRequestId: string;
  readonly parentConversationId: string;
  readonly agentName: string;
  readonly agentType: string;
  readonly product: string;
  readonly userId: string;
}

export const ACTIVITY_REPORT_PATH = "/report";

export type BuddyActivityReportState = "reported" | "unavailable" | "error";

export interface BuddyActivityReportResult {
  readonly providerId: string;
  readonly accountId: string;
  readonly state: BuddyActivityReportState;
  /** Provider-facing detail for the audit log; `null` on success. */
  readonly error: string | null;
}

export function buildActivityReportEvent(args: {
  readonly conversationId: string;
  readonly userId: string;
  readonly requestId?: string;
  readonly now?: number;
}): BuddyActivityReportEvent {
  const now = args.now ?? Date.now();
  const requestId = args.requestId ?? args.conversationId;
  return {
    eventCode: "chat_request_send",
    timestamp: now,
    reportDelay: 0,
    mode: "unknown",
    conversationId: args.conversationId,
    requestId,
    inputLength: 0,
    requestModelId: "auto",
    requestModelName: "Auto",
    isPlan: false,
    isAutoExecuteTerminal: false,
    isAutoModify: false,
    codebaseEnable: false,
    maxToken: 0,
    maxSteps: 0,
    temperature: 0,
    maxRetries: 0,
    mentionContexts: [],
    knowledgeId: [],
    knowledgeName: [],
    codebaseId: "",
    mentionContextCount: 0,
    command: "",
    recommendId: "",
    skillId: "",
    skillCount: 0,
    totalCount: 0,
    presentAt: now,
    rootRequestId: args.conversationId,
    parentConversationId: args.conversationId,
    agentName: "default",
    agentType: "main",
    product: "SaaS",
    userId: args.userId,
  };
}

export const ACTIVITY_REPORT_EVENTS_PER_BATCH = 4;

export const ACTIVITY_REPORT_ROUNDS = 2;

export const ACTIVITY_REPORT_ROUND_DELAY_MS = 1_500;

export async function fetchBuddyActivityReport(args: {
  readonly providerId: string;
  readonly accountId: string;
  readonly credential: string;
  readonly userId: string;
  readonly fetcher: typeof fetch;
  readonly conversationId?: string;
  /** Pause between rounds. Injectable so a test does not wait on the real delay. */
  readonly roundDelayMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}): Promise<BuddyActivityReportResult> {
  const { providerId, accountId, credential, userId, fetcher } = args;
  const base = { providerId, accountId, error: null };
  if (!credential) {
    return { ...base, state: "error", error: "Account has no stored credential." };
  }
  if (!userId) {
    return { ...base, state: "error", error: "Account uid is unavailable; cannot report activity." };
  }
  const headers = {
    ...(await checkinHeaders(providerId)),
    Authorization: `Bearer ${credential}`,
    "X-User-Id": userId,
  };
  const url = `${providerBaseUrl(providerId)}${VERSION_SEGMENT[providerId] ?? ""}${ACTIVITY_REPORT_PATH}`;
  const delayMs = args.roundDelayMs ?? ACTIVITY_REPORT_ROUND_DELAY_MS;
  const sleep = args.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const conversationId = args.conversationId ?? `activity-${Date.now()}`;

  for (let round = 0; round < ACTIVITY_REPORT_ROUNDS; round += 1) {
    if (round > 0 && delayMs > 0) await sleep(delayMs);
    const events = Array.from({ length: ACTIVITY_REPORT_EVENTS_PER_BATCH }, (_, index) => {
      const sequence = round * ACTIVITY_REPORT_EVENTS_PER_BATCH + index;
      return buildActivityReportEvent({
        conversationId: `${conversationId}-${sequence}`,
        requestId: `${conversationId}-req-${sequence}`,
        userId,
      });
    });
    let payload: unknown;
    try {
      const response = await fetcher(url, {
        method: "POST",
        headers,
        body: JSON.stringify(events),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (response.status === 401 || response.status === 403) {
        return { ...base, state: "error", error: "Credential invalid or expired." };
      }
      if (!response.ok) {
        return { ...base, state: "error", error: `Activity report API error (${response.status}).` };
      }
      payload = await response.text().then((text) => (text ? JSON.parse(text) : null));
    } catch (error) {
      if (error instanceof SyntaxError) {
        return { ...base, state: "error", error: "Activity report response returned invalid JSON." };
      }
      return {
        ...base,
        state: "error",
        error: error instanceof Error ? error.message : "Activity report request failed.",
      };
    }
    const code = envelopeCode(payload);
    if (code !== null && code !== 0) {
      return { ...base, state: "error", error: `Activity report error (code ${code}).` };
    }
  }
  return { ...base, state: "reported" };
}

const ALREADY_CLAIMED_CODE = 1001;

const NOT_ELIGIBLE_CODE = 1002;

const EVENT_ENDED_CODE = 1003;

const CLAIM_RETRY_DELAYS_MS = [1_000, 2_000] as const;

const VERSION_SEGMENT: Readonly<Record<string, string>> = {
  cb: "",
  cbcn: "",
};

function statusUrl(providerId: string): string {
  return `${providerBaseUrl(providerId)}${VERSION_SEGMENT[providerId] ?? ""}${CHECKIN_STATUS_PATH}`;
}

function claimUrl(providerId: string): string {
  return `${providerBaseUrl(providerId)}${VERSION_SEGMENT[providerId] ?? ""}${CHECKIN_CLAIM_PATH}`;
}

async function checkinHeaders(providerId: string): Promise<Record<string, string>> {
  const common = {
    "X-Product": "SaaS",
    "X-Requested-With": "XMLHttpRequest",
    "X-CodeBuddy-Request": "1",
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  const variant: CodeBuddyVariant = providerId === "cb" ? "IDE" : "CLI";
  return {
    ...common,
    "User-Agent": buildCodeBuddyUserAgent(variant),
    "X-IDE-Type": variant,
    "X-IDE-Name": variant,
    "X-Domain": codebuddyDomain(variant),
  };
}

function alreadyClaimedMessage(payload: unknown, rawBody: string): string | null {
  const message = asTextField(payload) || rawBody.trim();
  if (!message) return null;
  if (message.includes("已签到")) return message;
  const lower = message.toLowerCase();
  if (lower.includes("already") && lower.includes("check")) return message;
  return null;
}

function asTextField(payload: unknown): string | null {
  const data = asRecord(payload);
  if (!data) return null;
  const direct = data["msg"] ?? data["message"];
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  return null;
}

function isRetryableClaim(error: unknown, status: number | null): boolean {
  if (status !== null) return status >= 500;
  return !(error instanceof DOMException && error.name === "AbortError");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return sharedAsRecord(value) ?? null;
}

function asNumber(value: unknown): number | null {
  return sharedAsNumber(value) ?? null;
}

function envelopeCode(payload: unknown): number | null {
  const envelope = asRecord(payload);
  if (!envelope || !("code" in envelope)) return null;
  return asNumber(envelope["code"]);
}

function envelopeData(payload: unknown): Record<string, unknown> | null {
  const data = asRecord(asRecord(payload)?.["data"]);
  if (!data) return null;
  if ("today_checked_in" in data || "active" in data || "streak_days" in data) return data;
  return asRecord(asRecord(data["Response"])?.["Data"]);
}

export async function fetchDailyCheckin(args: {
  readonly providerId: string;
  readonly accountId: string;
  readonly credential: string;
  readonly fetcher: typeof fetch;
  /** Overrides the status probe when the caller already knows the state. */
  readonly forceClaim?: boolean;
}): Promise<DailyCheckinResult> {
  const { providerId, accountId, credential, fetcher } = args;
  const base = { providerId, accountId, credit: null, streakDays: null, error: null };

  if (!credential) {
    return { ...base, state: "error", error: "Account has no stored credential." };
  }

  // `checkinHeaders()` already carries Content-Type/Accept; only auth is
  // layered on here so the per-provider identity stays in one place.
  const headers = {
    ...(await checkinHeaders(providerId)),
    Authorization: `Bearer ${credential}`,
  };

  let status: unknown;
  try {
    const response = await fetcher(statusUrl(providerId), {
      method: "POST",
      headers,
      body: "{}",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (response.status === 401 || response.status === 403) {
      return { ...base, state: "error", error: "Credential invalid or expired." };
    }
    if (!response.ok) {
      return { ...base, state: "error", error: `Check-in status API error (${response.status}).` };
    }
    status = await response.json().catch(() => null);
  } catch (error) {
    return {
      ...base,
      state: "error",
      error: error instanceof Error ? error.message : "Check-in status request failed.",
    };
  }

  const statusCode = envelopeCode(status);
  if (statusCode !== null && statusCode !== 0) {
    return { ...base, state: "error", error: `Check-in status error (code ${statusCode}).` };
  }

  const data = envelopeData(status);
  if (!data) return { ...base, state: "unavailable", error: "Check-in activity unavailable." };
  if (data["active"] === false) {
    return { ...base, state: "unavailable", error: "No check-in activity running." };
  }
  const streak = asNumber(data["streak_days"]);
  if (!args.forceClaim && data["today_checked_in"] === true) {
    return { ...base, state: "already_claimed", streakDays: streak };
  }

  let claim: unknown;
  let claimRaw = "";
  let attempt = 0;
  for (;;) {
    try {
      const response = await fetcher(claimUrl(providerId), {
        method: "POST",
        headers,
        body: "{}",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (response.status === 401 || response.status === 403) {
        return { ...base, state: "error", error: "Credential invalid or expired." };
      }
      if (response.status >= 500 && attempt < CLAIM_RETRY_DELAYS_MS.length) {
        await sleep(CLAIM_RETRY_DELAYS_MS[attempt] as number);
        attempt += 1;
        continue;
      }
      if (!response.ok) {
        return { ...base, state: "error", error: `Daily check-in API error (${response.status}).` };
      }
      claimRaw = await response.text().catch(() => "");
      claim = claimRaw ? JSON.parse(claimRaw) : null;
      break;
    } catch (error) {
      if (error instanceof SyntaxError) {
        return { ...base, state: "error", error: "Daily check-in response returned invalid JSON." };
      }
      if (isRetryableClaim(error, null) && attempt < CLAIM_RETRY_DELAYS_MS.length) {
        await sleep(CLAIM_RETRY_DELAYS_MS[attempt] as number);
        attempt += 1;
        continue;
      }
      return {
        ...base,
        state: "error",
        error: error instanceof Error ? error.message : "Daily check-in request failed.",
      };
    }
  }

  const claimCode = envelopeCode(claim);
  if (claimCode !== null && claimCode !== 0) {
    const alreadyText = alreadyClaimedMessage(claim, claimRaw);
    if (claimCode === ALREADY_CLAIMED_CODE || alreadyText) {
      return { ...base, state: "already_claimed", streakDays: streak };
    }
    if (claimCode === NOT_ELIGIBLE_CODE) return { ...base, state: "not_eligible" };
    if (claimCode === EVENT_ENDED_CODE) return { ...base, state: "event_ended" };
    return { ...base, state: "error", error: `Daily check-in error (code ${claimCode}).` };
  }
  // Some gateway variants answer the duplicate-claim state as prose with a
  // success envelope; catch that before reporting a fresh claim.
  if (claimCode === 0) {
    const alreadyText = alreadyClaimedMessage(claim, claimRaw);
    if (alreadyText) return { ...base, state: "already_claimed", streakDays: streak };
  }

  const claimData = envelopeData(claim);
  return {
    ...base,
    state: "claimed",
    credit: asNumber(claimData?.["credit"]) ?? asNumber(claimData?.["today_credit"]) ?? null,
    streakDays: asNumber(claimData?.["streak_days"]) ?? streak,
  };
}

export function checkinDayKey(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

// ── buddy-growth-shared ──────────────────────────────────────────

// (TIMEOUT_MS declared once above)

function growthBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "").replace(/\/v2$/, "");
}

export type BuddyGrowthState = "claimed" | "already" | "not_eligible" | "skipped" | "error";

export interface BuddyGrowthResult {
  readonly state: BuddyGrowthState;
  /** Provider-facing detail for the log; `null` on success. */
  readonly error: string | null;
  /** Credits granted, when the upstream reported them. */
  readonly credit: number | null;
}

export interface BuddyGrowthCall {
  readonly baseUrl: string;
  readonly headers: Record<string, string>;
  readonly credential: string;
  readonly fetcher: FetchLike;
  /** Account UID for the `X-User-Id` identity header. */
  readonly uid?: string | undefined;
  /** Which account and provider the call belongs to — needed by the activity report. */
  readonly accountId: string;
  readonly providerId: string;
  /** Injectable idempotency token generator (tests). */
  readonly token?: (prefix: string) => string;
}

function clientToken(call: BuddyGrowthCall, prefix: string): string {
  return (call.token ?? ((name: string) => `${name}-${randomUUID()}`))(prefix);
}

interface Reply {
  readonly status: number;
  readonly payload: Record<string, unknown> | null;
  readonly data: Record<string, unknown> | null;
  readonly code: number | null;
  readonly message: string;
  readonly ok: boolean;
  readonly transport: string | null;
}

async function call(
  options: BuddyGrowthCall,
  method: "GET" | "POST",
  path: string,
  body?: Record<string, unknown>,
): Promise<Reply> {
  const url = `${growthBase(options.baseUrl)}${path}`;
  let response: Response;
  try {
    response = await options.fetcher(url, {
      method,
      headers: {
        ...options.headers,
        ...(options.uid === undefined || options.uid.length === 0
          ? {}
          : { "X-User-Id": options.uid }),
        Authorization: `Bearer ${options.credential}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    return {
      status: 0,
      payload: null,
      data: null,
      code: null,
      message: error instanceof Error ? error.message : "request failed",
      ok: false,
      transport: error instanceof Error ? error.message : "request failed",
    };
  }
  let payload: Record<string, unknown> | null = null;
  let text = "";
  try {
    text = await response.text();
    payload = text.length > 0 ? asRecord(JSON.parse(text)) : null;
  } catch {
    payload = null;
  }
  const code = payload === null || !("code" in payload) ? null : Number(payload["code"]);
  const message = asText(payload?.["msg"]) ?? asText(payload?.["message"]) ?? text.slice(0, 200);
  const data = asRecord(payload?.["data"]) ?? (payload !== null && !("code" in payload) ? payload : null);
  if (!response.ok) {
    return {
      status: response.status,
      payload,
      data,
      code: Number.isFinite(code) ? code : null,
      message,
      ok: false,
      // A 409/403/400 here is the upstream's own answer, not a transport fault.
      transport: null,
    };
  }
  if (Number.isFinite(code) && code !== 0) {
    return { status: response.status, payload, data, code, message, ok: false, transport: null };
  }
  return { status: response.status, payload, data, code, message, ok: true, transport: null };
}

function refused(reply: Reply, status: number, markers: readonly string[]): boolean {
  if (reply.ok || reply.status !== status) return false;
  const lower = reply.message.toLowerCase();
  return markers.some((marker) => lower.includes(marker));
}

function coded(reply: Reply, code: number): boolean {
  return !reply.ok && reply.code === code;
}

function done(reply: Reply, credit?: number | null): BuddyGrowthResult {
  if (reply.ok) {
    return { state: "claimed", error: null, credit: credit ?? creditOf(reply) };
  }
  return { state: "error", error: reply.message || `HTTP ${reply.status}`, credit: null };
}

function creditOf(reply: Reply): number | null {
  if (reply.data === null) return null;
  const raw = reply.data["credit"] ?? reply.data["credit_granted"] ?? reply.data["reward_credit"];
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

const STREAK_PATH = "/activity/growth/streak";

const HEATMAP_PATH = "/activity/growth/heatmap";

const MAKEUP_PATH = "/activity/growth/makeup-cards/use";

export interface BuddyStreakState {
  readonly days: number;
  readonly makeupCards: number;
}

export async function readBuddyStreak(
  options: BuddyGrowthCall,
): Promise<BuddyStreakState | null> {
  const reply = await call(options, "GET", STREAK_PATH);
  if (!reply.ok) return null;
  const streak = asRecord(reply.data?.["streak"]);
  const cards = asRecord(reply.data?.["makeup_cards"]);
  return {
    days: Number(streak?.["days"] ?? 0) || 0,
    makeupCards: Number(cards?.["balance"] ?? 0) || 0,
  };
}

export interface BuddyHeatmapCell {
  readonly date: string;
  readonly score: number;
}

export async function readBuddyHeatmap(
  options: BuddyGrowthCall,
): Promise<readonly BuddyHeatmapCell[] | null> {
  const reply = await call(options, "GET", HEATMAP_PATH);
  if (!reply.ok || reply.data === null) return null;
  const list = reply.data["cells"];
  if (!Array.isArray(list)) return null;
  return list.flatMap((entry) => {
    const row = asRecord(entry);
    const date = asText(row?.["date"])?.slice(0, 10);
    if (date === undefined || date.length === 0) return [];
    return [{ date, score: Number(row?.["score"] ?? 0) || 0 }];
  });
}

export function cstYesterday(now: Date = new Date()): string {
  const shifted = new Date(now.getTime() + 8 * 3600_000);
  return new Date(shifted.getTime() - 86_400_000).toISOString().slice(0, 10);
}

export async function useBuddyMakeupCard(
  options: BuddyGrowthCall,
  targetDate: string = cstYesterday(),
): Promise<BuddyGrowthResult> {
  const [heatmap, streak] = await Promise.all([
    readBuddyHeatmap(options),
    readBuddyStreak(options),
  ]);
  if (heatmap === null) return { state: "skipped", error: "heatmap unavailable", credit: null };
  const cell = heatmap.find((entry) => entry.date === targetDate);
  // No cell for the day means the heatmap does not cover it — no evidence of a
  // miss, so nothing is spent.
  if (cell === undefined || cell.score !== 0) {
    return { state: "skipped", error: null, credit: null };
  }
  if (streak === null || streak.makeupCards <= 0) {
    return { state: "skipped", error: null, credit: null };
  }
  const reply = await call(options, "POST", MAKEUP_PATH, { target_date: targetDate });
  // No card, no miss, or already made up — all normal.
  if (refused(reply, 400, ["no card", "insufficient", "already", "无卡", "已补"])) {
    return { state: "already", error: null, credit: null };
  }
  return done(reply);
}

const REDEEM_PATH = "/activity/growth/redeem";

export const BUDDY_REDEEM_TIERS = ["7d", "14d", "28d"] as const;

export type BuddyRedeemTier = (typeof BUDDY_REDEEM_TIERS)[number];

export type BuddyTierStatus = "available" | "claimed" | "locked" | "unknown";

export interface BuddyRedemptionStatus {
  readonly tiers: Readonly<Record<BuddyRedeemTier, BuddyTierStatus>>;
  readonly remainingDays: number | null;
}

const TIER_FIELDS: Readonly<Record<BuddyRedeemTier, string>> = {
  "7d": "tier_7d_status",
  "14d": "tier_14d_status",
  "28d": "tier_28d_status",
};

export async function readBuddyRedemption(
  options: BuddyGrowthCall,
): Promise<BuddyRedemptionStatus | null> {
  const reply = await call(options, "GET", STREAK_PATH);
  if (!reply.ok || reply.data === null) return null;
  const status = asRecord(reply.data["redemption_status"]) ?? {};
  const tiers = {} as Record<BuddyRedeemTier, BuddyTierStatus>;
  for (const tier of BUDDY_REDEEM_TIERS) {
    const value = asText(status[TIER_FIELDS[tier]])?.toLowerCase();
    tiers[tier] =
      value === "available" || value === "claimed" || value === "locked" ? value : "unknown";
  }
  const remaining = Number(status["remaining_days"]);
  return { tiers, remainingDays: Number.isFinite(remaining) ? remaining : null };
}

export async function redeemBuddyStreakTier(
  options: BuddyGrowthCall,
  tier: BuddyRedeemTier,
): Promise<BuddyGrowthResult> {
  const reply = await call(options, "POST", REDEEM_PATH, {
    tier,
    client_token: clientToken(options, `redeem-${tier}`),
  });
  if (coded(reply, 409) || refused(reply, 409, ["duplicate", "已领取"])) {
    return { state: "already", error: null, credit: null };
  }
  if (refused(reply, 403, ["not enough", "insufficient", "未达标", "天数不足"])) {
    return { state: "not_eligible", error: null, credit: null };
  }
  return done(reply);
}

const TRAVEL_STATUS_PATH = "/activity/growth/buddy/travel/status";

const TRAVEL_CONFIG_PATH = "/activity/growth/buddy/travel/config";

const TRAVEL_DEPART_PATH = "/activity/growth/buddy/travel/depart";

const TRAVEL_CLAIM_PATH = "/activity/growth/buddy/travel/claim";

const TRAVEL_LOCATION_ID = 4;

export type BuddyTravelState = "idle" | "traveling" | "arrived" | "unknown";

export interface BuddyTravelStatus {
  readonly state: BuddyTravelState;
  readonly dailyLimitReached: boolean;
  readonly recordId: number | null;
  readonly rewardCredit: number | null;
}

export async function readBuddyTravelStatus(
  options: BuddyGrowthCall,
): Promise<BuddyTravelStatus | null> {
  const reply = await call(options, "GET", TRAVEL_STATUS_PATH);
  if (!reply.ok || reply.data === null) return null;
  const raw = asText(reply.data["state"])?.toLowerCase();
  const state: BuddyTravelState =
    raw === "idle" || raw === "traveling" || raw === "arrived" ? raw : "unknown";
  const record = Number(reply.data["record_id"]);
  const reward = Number(reply.data["reward_credit"]);
  return {
    state,
    dailyLimitReached: reply.data["daily_limit_reached"] === true,
    recordId: Number.isFinite(record) ? record : null,
    rewardCredit: Number.isFinite(reward) ? reward : null,
  };
}

export async function readBuddyTravelConfig(
  options: BuddyGrowthCall,
): Promise<Record<string, unknown> | null> {
  const reply = await call(options, "GET", TRAVEL_CONFIG_PATH);
  return reply.ok ? reply.data : null;
}

export async function departBuddyTravel(
  options: BuddyGrowthCall,
  locationId: number = TRAVEL_LOCATION_ID,
): Promise<BuddyGrowthResult> {
  const reply = await call(options, "POST", TRAVEL_DEPART_PATH, { location_id: locationId });
  if (refused(reply, 400, ["already traveling", "location not available", "limit"])) {
    return { state: "already", error: null, credit: null };
  }
  return done(reply);
}

export async function claimBuddyTravel(
  options: BuddyGrowthCall,
  recordId: number,
): Promise<BuddyGrowthResult> {
  const reply = await call(options, "POST", TRAVEL_CLAIM_PATH, { record_id: recordId });
  return done(reply);
}

const BUDDY_INFO_PATH = "/activity/growth/buddy/info";

const BUDDY_TASKS_PATH = "/v2/activity/growth/tasks";

const BUDDY_AGREEMENT_PATH = "/activity/growth/buddy/agreement";

const BUDDY_FIRST_PATH = "/activity/growth/buddy/first";

const FIRST_BUDDY_TASK = "first_buddy";

const ACCEPTED_STATUSES: readonly string[] = [
  "not_accepted",
  "accepted",
  "in_progress",
  "completed",
];

export async function readBuddyInfo(
  options: BuddyGrowthCall,
): Promise<{ readonly hasBuddy: boolean } | null> {
  const reply = await call(options, "GET", BUDDY_INFO_PATH);
  if (!reply.ok || reply.data === null || !("buddy" in reply.data)) return null;
  const buddy = reply.data["buddy"];
  return { hasBuddy: buddy !== null && typeof buddy === "object" };
}

export async function readBuddyFirstTask(
  options: BuddyGrowthCall,
): Promise<Record<string, unknown> | null> {
  const reply = await call(options, "GET", BUDDY_TASKS_PATH);
  if (!reply.ok || reply.data === null) return null;
  const rows = reply.data["tasks"];
  if (!Array.isArray(rows)) return null;
  const matches = rows.filter(
    (row) => asRecord(row)?.["task_code"] === FIRST_BUDDY_TASK,
  );
  if (matches.length !== 1) return null;
  const task = asRecord(matches[0]);
  if (task === null) return null;
  if (task["locked"] !== false || task["reward_buddy"] !== true) return null;
  const status = asText(task["accept_status"])?.toLowerCase();
  if (status === undefined || !ACCEPTED_STATUSES.includes(status)) return null;
  return task;
}

export async function readBuddyAgreement(
  options: BuddyGrowthCall,
): Promise<Record<string, unknown> | null> {
  const reply = await call(options, "GET", BUDDY_AGREEMENT_PATH);
  return reply.ok ? reply.data : null;
}

export async function agreeBuddyAgreement(
  options: BuddyGrowthCall,
): Promise<BuddyGrowthResult> {
  const reply = await call(options, "POST", BUDDY_AGREEMENT_PATH, { agree: true });
  return done(reply);
}

export async function adoptFirstBuddy(
  options: BuddyGrowthCall,
): Promise<BuddyGrowthResult> {
  const reply = await call(options, "POST", BUDDY_FIRST_PATH, {});
  if (refused(reply, 400, ["first_buddy task not completed", "task not completed"])) {
    return { state: "not_eligible", error: null, credit: null };
  }
  return done(reply);
}

// ── buddy-server-tools ──────────────────────────────────────────

export type ServerToolKind = "web_search" | "web_fetch";

export interface ServerToolDeclaration {
  readonly kind: ServerToolKind;
  readonly name: string;
}

export interface ServerToolInvocation {
  readonly id: string;
  readonly kind: ServerToolKind;
  readonly rawArguments: string;
}

export interface ServerToolRunResult {
  /** Text handed back upstream as the tool's result message. */
  readonly content: string;
  readonly toolCallId: string;
}

export interface ServerToolExecutor {
  /** Runs one web fetch; `null` means the backend is unavailable. */
  readonly fetch?: ((input: { url: string }) => Promise<string>) | undefined;
  /** Runs one web search; `null` means the backend is unavailable. */
  readonly search?: ((input: { query: string }) => Promise<string>) | undefined;
}

const SEARCH_TYPE_PREFIX = "web_search_";

const FETCH_TYPE_PREFIX = "web_fetch_";

function normalizeTypeName(value: string): string {
  return value.trim().toLowerCase().replace(/[_-]+/g, " ");
}

function classifyByType(type: string): ServerToolKind | null {
  const normalized = normalizeTypeName(type);
  if (normalized.startsWith(normalizeTypeName(SEARCH_TYPE_PREFIX))) return "web_search";
  if (normalized.startsWith(normalizeTypeName(FETCH_TYPE_PREFIX))) return "web_fetch";
  return null;
}

export function classifyServerToolDeclaration(tool: ToolDefinition): ServerToolKind | null {
  const raw = tool.native_type?.trim();
  if (raw !== undefined && raw.length > 0) {
    const byRaw = classifyByType(raw);
    if (byRaw !== null) return byRaw;
  }
  if (tool.tool_type === "web_search") return "web_search";
  if (tool.tool_type !== undefined && tool.tool_type !== "function") {
    const byType = classifyByType(tool.tool_type);
    if (byType !== null) return byType;
  }
  return null;
}

export function findServerToolDeclarations(
  tools: readonly ToolDefinition[] | undefined,
): Map<string, ServerToolKind> {
  const out = new Map<string, ServerToolKind>();
  for (const tool of tools ?? []) {
    const kind = classifyServerToolDeclaration(tool);
    if (kind !== null) out.set(tool.name, kind);
  }
  return out;
}

export function isServerToolCall(
  name: string,
  declared: ReadonlyMap<string, ServerToolKind>,
): boolean {
  return declared.has(name);
}

function parseJsonArguments(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through
  }
  return {};
}

export function buildServerToolInvocation(
  callId: string,
  name: string,
  kind: ServerToolKind,
  rawArguments: string,
): ServerToolInvocation {
  return { id: callId || `server_tool_${name}`, kind, rawArguments };
}

function textOf(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function safeFetchUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  return parsed.toString();
}

async function runOne(
  executor: ServerToolExecutor,
  invocation: ServerToolInvocation,
): Promise<ServerToolRunResult> {
  const args = parseJsonArguments(invocation.rawArguments);
  if (invocation.kind === "web_fetch") {
    const url = safeFetchUrl(textOf(args["url"] ?? args["target"]));
    if (url === null) {
      return {
        toolCallId: invocation.id,
        content: "web_fetch failed: the model supplied an invalid or unsupported URL and nothing was fetched.",
      };
    }
    if (executor.fetch === undefined) {
      return {
        toolCallId: invocation.id,
        content: "web_fetch unavailable: the gateway has no fetch backend configured.",
      };
    }
    try {
      const content = await executor.fetch({ url });
      return { toolCallId: invocation.id, content };
    } catch (error) {
      return {
        toolCallId: invocation.id,
        content: `web_fetch failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
  const query = textOf(args["query"]);
  if (query.length === 0) {
    return {
      toolCallId: invocation.id,
      content: "web_search failed: the model supplied an empty query and nothing was searched.",
    };
  }
  if (executor.search === undefined) {
    return {
      toolCallId: invocation.id,
      content: "web_search unavailable: the gateway has no search backend configured.",
    };
  }
  try {
    const content = await executor.search({ query });
    return { toolCallId: invocation.id, content };
  } catch (error) {
    return {
      toolCallId: invocation.id,
      content: `web_search failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export async function executeServerToolInvocations(
  executor: ServerToolExecutor,
  invocations: readonly ServerToolInvocation[],
): Promise<readonly ServerToolRunResult[]> {
  return Promise.all(invocations.map((invocation) => runOne(executor, invocation)));
}

export function buildServerToolFollowUpMessages(
  assistantToolCalls: Array<{ id: string; name: string; arguments: string }>,
  results: readonly ServerToolRunResult[],
): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = [];
  if (assistantToolCalls.length > 0) {
    messages.push({
      role: "assistant",
      content: "",
      tool_calls: assistantToolCalls.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: call.arguments },
      })),
    });
  }
  for (const result of results) {
    messages.push({
      role: "tool",
      tool_call_id: result.toolCallId,
      content: result.content,
    });
  }
  return messages;
}
