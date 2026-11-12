import {
  decodeJwtPayload,
  expiryFromSeconds,
  nonEmptyTrimmedString,
  readJsonResponse,
  record,
} from "../../authentication/oauth-flow-store";
import type {
  OAuthDeviceFlowContext,
  OAuthDevicePollResult,
  OAuthDeviceStartResult,
  OAuthExchangeResult,
} from "../../authentication/oauth-flow-store";
import type { OAuthTokenRefreshResult } from "../../authentication/oauth-refresh-service";
import { OAuthDeviceFlow } from "../../authentication/oauth-device-flow";
import { asNumber as sharedAsNumber } from "../../../shared/coerce";
import type {
  FetchLike,
  ProviderQuotaResult,
  ProviderQuotaWindow,
} from "../../quota/quota-contracts";
import { cleanError, percentWindow, record as asRecord, text as asText } from "../../quota/quota-contracts";
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import type { CartethyiaDatabase } from "../../../persistence/db-handle";
import { buddyUsageSnapshots } from "../../../persistence/schema";

// ── buddy-oauth-shared ──────────────────────────────────────────

export interface BuddyTokenData {
  readonly accessToken?: unknown;
  readonly refreshToken?: unknown;
  readonly tokenType?: unknown;
  readonly expiresIn?: unknown;
}

export function buddyResponseData(payload: unknown): Record<string, unknown> | undefined {
  return record(record(payload)?.data);
}

export function parseBuddyTokenData(payload: unknown): BuddyTokenData {
  const data = buddyResponseData(payload) ?? {};
  return {
    accessToken: data.accessToken,
    refreshToken: data.refreshToken,
    tokenType: data.tokenType,
    expiresIn: data.expiresIn,
  };
}

export function strictResponseCode(payload: unknown): number | undefined {
  const root = record(payload);
  if (typeof root?.code === "number" && Number.isFinite(root.code)) return root.code;
  if (typeof root?.code === "string" && Number.isFinite(Number(root.code))) return Number(root.code);
  return undefined;
}

export function coercingResponseCode(payload: unknown): number | undefined {
  const n = Number(record(payload)?.code);
  return Number.isFinite(n) ? n : undefined;
}

export interface BuddyOAuthVariant {
  readonly providerId: string;
  /** Display name for error messages (`OAuthClient.providerLabel`). */
  readonly providerLabel: string;
  /** Stamped into the `x-domain` header of every auth request. */
  readonly domain: string;
  /** `platform` query parameter of the device-start request. */
  readonly platform: string;
  /** Resolves version metadata, then builds the `User-Agent` of one auth request. */
  readonly userAgent: () => Promise<string>;
  readonly deviceStartUrl: string;
  readonly devicePollUrl: string;
  readonly refreshUrl: string;
  /** Reads the envelope `code`; see `strictResponseCode` / `coercingResponseCode`. */
  readonly responseCode: (payload: unknown) => number | undefined;
}

const DEVICE_EXPIRY_SECONDS = 900;

const BUDDY_PENDING_CODE = 11217;

export function buddyAccountUid(accessToken: string): string | undefined {
  const claims = decodeJwtPayload(accessToken);
  if (!claims) return undefined;
  return nonEmptyTrimmedString(claims.sub) ?? nonEmptyTrimmedString(claims.uid);
}

function buddyAccountLabel(accessToken: string): string | undefined {
  const claims = decodeJwtPayload(accessToken);
  if (!claims) return undefined;
  const email = nonEmptyTrimmedString(claims.email) ?? nonEmptyTrimmedString(claims.preferred_username);
  const given = nonEmptyTrimmedString(claims.given_name);
  const family = nonEmptyTrimmedString(claims.family_name);
  const full =
    given && family ? `${given} ${family}` : nonEmptyTrimmedString(claims.name) ?? undefined;
  if (email && full) return `${full} <${email}>`;
  return email ?? full ?? nonEmptyTrimmedString(claims.sub);
}

function tokenResult(
  variant: BuddyOAuthVariant,
  payload: unknown,
  fallbackRefresh?: string,
): OAuthExchangeResult {
  const data = parseBuddyTokenData(payload);
  const access = nonEmptyTrimmedString(data.accessToken);
  if (!access) throw new Error(`${variant.providerId} token response omitted accessToken`);
  const refresh = nonEmptyTrimmedString(data.refreshToken) ?? fallbackRefresh ?? "";
  const accountLabel = buddyAccountLabel(access);
  return {
    access,
    refresh,
    expiresAt: expiryFromSeconds(data.expiresIn, 86_400),
    ...(accountLabel === undefined ? {} : { accountLabel }),
  };
}

async function authIdentityHeaders(variant: BuddyOAuthVariant): Promise<Record<string, string>> {
  return {
    accept: "application/json",
    "user-agent": await variant.userAgent(),
    "x-requested-with": "XMLHttpRequest",
    "x-domain": variant.domain,
    "x-product": "SaaS",
  };
}

async function deviceStartHeaders(variant: BuddyOAuthVariant): Promise<Record<string, string>> {
  return {
    "content-type": "application/json",
    ...(await authIdentityHeaders(variant)),
    "x-no-authorization": "true",
    "x-no-user-id": "true",
  };
}

async function devicePollHeaders(variant: BuddyOAuthVariant): Promise<Record<string, string>> {
  return {
    ...(await authIdentityHeaders(variant)),
    "x-no-authorization": "true",
    "x-no-user-id": "true",
    "x-no-enterprise-id": "true",
    "x-no-department-info": "true",
  };
}

async function refreshHeaders(
  variant: BuddyOAuthVariant,
  refreshToken: string,
): Promise<Record<string, string>> {
  return {
    "content-type": "application/json",
    ...(await authIdentityHeaders(variant)),
    "x-refresh-token": refreshToken,
    "x-auth-refresh-source": "plugin",
  };
}

export class BuddyOAuthClient extends OAuthDeviceFlow {
  override readonly supportsDeviceCode = true;
  override readonly supportsBrowserCode = false;

  protected override readonly providerLabel: string;
  protected override readonly clientId = "";
  protected override readonly tokenUrl = "";
  protected override readonly scopes = "";

  readonly #variant: BuddyOAuthVariant;

  constructor(variant: BuddyOAuthVariant, fetchFn: FetchLike = globalThis.fetch) {
    super(fetchFn);
    this.#variant = variant;
    this.providerLabel = variant.providerLabel;
  }

  override async startDeviceAuth(context?: OAuthDeviceFlowContext): Promise<OAuthDeviceStartResult> {
    const url = `${this.#variant.deviceStartUrl}?platform=${encodeURIComponent(this.#variant.platform)}`;
    const response = await this.fetchFor(context)(url, {
      method: "POST",
      headers: await deviceStartHeaders(this.#variant),
      body: "{}",
    });
    const payload = await readJsonResponse(response, `${this.#variant.providerId} device authorization`);
    if (this.#variant.responseCode(payload) !== 0) {
      throw new Error(
        `${this.#variant.providerId} state error: ${nonEmptyTrimmedString(record(payload)?.msg) ?? "missing state/authUrl"}`,
      );
    }
    const data = buddyResponseData(payload);
    const deviceAuthId = nonEmptyTrimmedString(data?.state);
    const verificationUri = nonEmptyTrimmedString(data?.authUrl);
    if (!deviceAuthId || !verificationUri) {
      throw new Error(`${this.#variant.providerId} device authorization returned an invalid response`);
    }
    return {
      verificationUri,
      userCode: "",
      deviceAuthId,
      intervalSeconds: 5,
      expiresInSeconds: DEVICE_EXPIRY_SECONDS,
    };
  }

  override async pollDeviceAuth(
    deviceAuthId: string,
    context?: OAuthDeviceFlowContext,
  ): Promise<OAuthDevicePollResult> {
    const url = `${this.#variant.devicePollUrl}?state=${encodeURIComponent(deviceAuthId)}`;
    const response = await this.fetchFor(context)(url, {
      method: "GET",
      headers: await devicePollHeaders(this.#variant),
    });
    const textBody = await response.text();
    let payload: unknown;
    try {
      payload = JSON.parse(textBody) as unknown;
    } catch {
      return {
        status: "failed",
        reason: `${this.#variant.providerId} token endpoint returned invalid JSON`,
      };
    }
    if (!response.ok) {
      return {
        status: "failed",
        reason: `${this.#variant.providerId} token polling failed (${response.status})`,
      };
    }
    const code = this.#variant.responseCode(payload);
    if (code === BUDDY_PENDING_CODE) return { status: "pending" };
    if (code !== 0) {
      return {
        status: "failed",
        reason:
          nonEmptyTrimmedString(record(payload)?.msg) ?? `${this.#variant.providerId} token polling failed`,
      };
    }
    const data = buddyResponseData(payload);
    const access = nonEmptyTrimmedString(data?.accessToken);
    if (!access) {
      return {
        status: "failed",
        reason: `${this.#variant.providerId} token response omitted accessToken`,
      };
    }
    // The profile nickname is a second, authorized request the reference makes
    // once the token lands — the JWT carries the email but not always a
    // display name. Best-effort by design: a login must not fail because the
    // profile endpoint was unreachable, so every miss falls back to the label
    // the token itself yields.
    const nickname = await this.fetchAccountNickname(deviceAuthId, access);
    if (nickname === undefined) return { status: "complete", result: tokenResult(this.#variant, payload) };
    const result = tokenResult(this.#variant, payload);
    return {
      status: "complete",
      result: { ...result, accountLabel: result.accountLabel ?? nickname },
    };
  }

  /** Reads the account profile nickname, or `undefined` on any miss. */
  private async fetchAccountNickname(
    deviceAuthId: string,
    accessToken: string,
  ): Promise<string | undefined> {
    try {
      // Both references call `/v2/plugin/login/account` with the token after
      // the poll succeeds; the poll URL is the same versioned plugin root, so
      // the profile path is derived from it rather than declared per variant.
      const url = `${this.#variant.devicePollUrl.replace("/plugin/auth/token", "/plugin/login/account")}?state=${encodeURIComponent(deviceAuthId)}`;
      const response = await this.fetchFn(url, {
        method: "GET",
        headers: {
          ...(await devicePollHeaders(this.#variant)),
          authorization: `Bearer ${accessToken}`,
        },
      });
      if (!response.ok) return undefined;
      const profile = buddyResponseData((await response.json()) as unknown);
      return nonEmptyTrimmedString(profile?.nickname);
    } catch {
      return undefined;
    }
  }

  override async refresh(refreshToken: string, signal?: AbortSignal): Promise<OAuthTokenRefreshResult> {
    const response = await this.fetchFn(this.#variant.refreshUrl, {
      method: "POST",
      headers: await refreshHeaders(this.#variant, refreshToken),
      body: "{}",
      ...(signal === undefined ? {} : { signal }),
    });
    const payload = await readJsonResponse(response, `${this.#variant.providerId} token refresh`);
    if (this.#variant.responseCode(payload) !== 0) {
      const detail = nonEmptyTrimmedString(record(payload)?.msg);
      throw new Error(`${this.#variant.providerId} token refresh failed${detail ? `: ${detail}` : ""}`);
    }
    const result = tokenResult(this.#variant, payload, refreshToken);
    return {
      access: result.access,
      ...(result.refresh ? { refresh: result.refresh } : {}),
      expiresAt: result.expiresAt,
    };
  }
}

// ── buddy-quota-shared ──────────────────────────────────────────

export interface TencentBillingAccount {
  readonly PackageName?: string | null;
  readonly SubProductName?: string | null;
  // Refill cycle live numbers.
  readonly CycleCapacityUsedPrecise?: string | number | null;
  readonly CycleCapacityUsed?: number | null;
  readonly CycleCapacitySizePrecise?: string | number | null;
  readonly CycleCapacitySize?: number | null;
  // Bonus lifetime numbers.
  readonly CapacityUsedPrecise?: string | number | null;
  readonly CapacityUsed?: number | null;
  readonly CapacitySizePrecise?: string | number | null;
  readonly CapacitySize?: number | null;
  // Cadence + expiry.
  readonly CycleStartTime?: string | number | null;
  readonly CycleEndTime?: string | number | null;
  readonly DeductionEndTime?: string | number | null;
  readonly [key: string]: unknown;
}

const REFILL_GAP_MS = 2 * 24 * 60 * 60 * 1000;

const TIMEOUT_MS = 15_000;

export function parseBillingResetTime(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  try {
    if (value instanceof Date) return value.toISOString();
    if (typeof value === "number") {
      if (!Number.isFinite(value)) return null;
      return new Date(value < 1e12 ? value * 1000 : value).toISOString();
    }
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (!trimmed) return null;
      if (/^\d+$/.test(trimmed)) {
        const timestamp = Number(trimmed);
        if (!Number.isFinite(timestamp)) return null;
        return new Date(timestamp < 1e12 ? timestamp * 1000 : timestamp).toISOString();
      }
      const d = new Date(trimmed);
      return Number.isFinite(d.getTime()) ? d.toISOString() : null;
    }
    return null;
  } catch {
    return null;
  }
}

export function billingNum(precise: unknown, plain: unknown): number {
  const n = Number(precise ?? plain);
  return Number.isFinite(n) ? n : 0;
}

function refillCadence(acc: TencentBillingAccount): string {
  const start = parseBillingResetTime(acc.CycleStartTime);
  const end = parseBillingResetTime(acc.CycleEndTime);
  if (start && end) {
    const days = (new Date(end).getTime() - new Date(start).getTime()) / 86_400_000;
    if (days <= 1.5) return "Daily";
    if (days <= 10) return "Weekly";
  }
  return "Monthly";
}

export function resolveBearerToken(credential: string): string | null {
  const trimmed = credential.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const rec = asRecord(parsed);
      if (rec) {
        const candidate =
          asText(rec.accessToken) ??
          asText(rec.access_token) ??
          asText(rec.apiKey) ??
          asText(rec.api_key) ??
          asText(rec.token);
        if (candidate) return candidate;
      }
    } catch {
      // fall through to raw credential
    }
  }
  return trimmed;
}

function extractBillingAccounts(parsed: unknown): TencentBillingAccount[] {
  const root = asRecord(parsed) ?? {};
  const outerData = asRecord(root.data) ?? root;
  const responseRecord =
    asRecord(outerData["Response"]) ?? asRecord(outerData["response"]) ?? outerData;
  const innerData =
    asRecord(responseRecord["Data"]) ?? asRecord(responseRecord["data"]) ?? responseRecord;
  const rawAccounts = innerData["Accounts"] ?? innerData["accounts"] ?? [];
  if (!Array.isArray(rawAccounts)) return [];
  return rawAccounts
    .map((item) => asRecord(item) as TencentBillingAccount | null)
    .filter((v): v is TencentBillingAccount => v !== null);
}

function usedPercent(used: number, total: number): number | null {
  if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) return null;
  const pct = (used / total) * 100;
  if (!Number.isFinite(pct)) return null;
  return Math.min(100, Math.max(0, pct));
}

function buildBillingWindows(
  accounts: readonly TencentBillingAccount[],
  defaultPlan: string,
): { plan: string; windows: ProviderQuotaWindow[] } {
  const cycleEndMs = (acc: TencentBillingAccount): number => {
    const r = parseBillingResetTime(acc.CycleEndTime);
    return r ? new Date(r).getTime() : Number.POSITIVE_INFINITY;
  };
  const isRefill = (acc: TencentBillingAccount): boolean => {
    const ce = cycleEndMs(acc);
    const parsedDeductionEnd = parseBillingResetTime(acc.DeductionEndTime);
    const de = parsedDeductionEnd ? new Date(parsedDeductionEnd).getTime() : Number.NaN;
    return Number.isFinite(ce) && Number.isFinite(de) && de - ce > REFILL_GAP_MS;
  };
  const byExpiry = (a: TencentBillingAccount, b: TencentBillingAccount): number =>
    cycleEndMs(a) - cycleEndMs(b);

  const refills = [...accounts].filter(isRefill).sort(byExpiry);
  const bonuses = [...accounts].filter((a) => !isRefill(a)).sort(byExpiry);

  const windows: ProviderQuotaWindow[] = [];
  const seenRefill: Record<string, number> = {};

  for (const acc of refills) {
    const base = refillCadence(acc);
    seenRefill[base] = (seenRefill[base] || 0) + 1;
    const label = seenRefill[base] > 1 ? `${base} ${seenRefill[base]}` : base;
    const used = billingNum(acc.CycleCapacityUsedPrecise, acc.CycleCapacityUsed);
    const total = billingNum(acc.CycleCapacitySizePrecise, acc.CycleCapacitySize);
    const resetAt = parseBillingResetTime(acc.CycleEndTime);
    const pct = usedPercent(used, total);
    // Kind encodes recurring semantics + cadence for Contract consumers that
    // do not read the optional `recurring` field. Keep label human-readable.
    const kind = `quota:${base.toLowerCase()}${seenRefill[base] > 1 ? `_${seenRefill[base]}` : ""}`;
    const w = percentWindow(kind, label, pct, resetAt, used, total, "pooled");
    windows.push({ ...w, kind, label, recurring: true });
  }

  bonuses.forEach((acc, idx) => {
    const label = `Bonus Pack ${idx + 1}`;
    const kind = `bonus:${idx + 1}`;
    const used = billingNum(acc.CapacityUsedPrecise, acc.CapacityUsed);
    const total = billingNum(acc.CapacitySizePrecise, acc.CapacitySize);
    const resetAt = parseBillingResetTime(acc.CycleEndTime);
    const pct = usedPercent(used, total);
    const w = percentWindow(kind, label, pct, resetAt, used, total, "pooled");
    windows.push({ ...w, kind, label, recurring: false });
  });

  const basePkg = (refills[0] ?? accounts[0] ?? {}) as TencentBillingAccount;
  const plan = asText(basePkg.PackageName) ?? asText(basePkg.SubProductName) ?? defaultPlan;

  return { plan, windows };
}

export interface TencentBillingFetchOptions {
  /** Canonical source id reported in the result. */
  readonly source: string;
  /** Operator-facing provider name used in every message. */
  readonly display: string;
  /** `{base}/v2/billing/meter/get-user-resource` for this provider. */
  readonly url: string;
  /** Provider transport/identity headers; `Authorization` is added here. */
  readonly headers: Record<string, string>;
  readonly credential: string;
  readonly fetcher: FetchLike;
  /** Plan name used when the payload carries neither package field. */
  readonly defaultPlan: string;
  /** Account UID for the `X-User-Id` billing identity header. */
  readonly uid?: string | undefined;
}

export async function fetchTencentBillingQuota(
  options: TencentBillingFetchOptions,
): Promise<ProviderQuotaResult> {
  const { source, display, url, headers, credential, fetcher, defaultPlan, uid } = options;
  const bearer = resolveBearerToken(credential);
  if (!bearer) {
    return { source, plan: null, windows: [], error: `${display} credential not available.` };
  }

  let response: Response;
  const now = new Date();
  const end = new Date(now.getTime() + 365 * 101 * 24 * 3600 * 1000);
  const stamp = (value: Date): string => value.toISOString().slice(0, 19).replace("T", " ");
  try {
    response = await fetcher(url, {
      method: "POST",
      headers: {
        ...headers,
        ...(uid === undefined || uid.length === 0 ? {} : { "X-User-Id": uid }),
        Authorization: `Bearer ${bearer}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        PageNumber: 1,
        PageSize: 100,
        ProductCode: "p_tcaca",
        Status: [0, 3],
        PackageEndTimeRangeBegin: stamp(now),
        PackageEndTimeRangeEnd: stamp(end),
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    return { source, plan: null, windows: [], error: cleanError(error) };
  }

  if (response.status === 401 || response.status === 403) {
    return { source, plan: null, windows: [], error: `${display} credential invalid or expired.` };
  }
  if (!response.ok) {
    return {
      source,
      plan: null,
      windows: [],
      error: `${display} quota API error (${response.status}).`,
    };
  }

  let textBody: string;
  try {
    textBody = await response.text();
  } catch (error) {
    return { source, plan: null, windows: [], error: cleanError(error) };
  }

  let json: unknown = null;
  try {
    json = textBody.length > 0 ? JSON.parse(textBody) : null;
  } catch {
    return {
      source,
      plan: null,
      windows: [],
      error: cleanError(new Error(`${display} quota response returned invalid JSON`)),
    };
  }

  const envelope = asRecord(json);
  // A non-zero `code` is a provider-side error even on HTTP 200.
  if (envelope !== null && "code" in envelope) {
    const code = Number(envelope["code"]);
    if (Number.isFinite(code) && code !== 0) {
      const msgText = asText(envelope["msg"]) ?? "unknown";
      return { source, plan: null, windows: [], error: `${display} quota error: ${msgText}` };
    }
  }

  const accounts = extractBillingAccounts(json);
  if (accounts.length === 0) {
    const enterprise = await fetchEnterpriseUsage(options, bearer);
    if (enterprise !== undefined) return enterprise;
    return { source, plan: null, windows: [], error: `${display} connected. No credit package found.` };
  }

  try {
    const { plan, windows } = buildBillingWindows(accounts, defaultPlan);
    return { source, plan, windows, error: null };
  } catch (error) {
    return {
      source,
      plan: null,
      windows: [],
      error: cleanError(error) || `${display} error: ${String(error)}`,
    };
  }
}

const ENTERPRISE_USAGE_PATH = "/v2/billing/meter/get-enterprise-user-usage";

function enterpriseUsageUrl(resourceUrl: string): string {
  return resourceUrl.replace(/\/(?:v2\/)?billing\/meter\/get-user-resource$/, ENTERPRISE_USAGE_PATH);
}

function finiteNumber(value: unknown): number | undefined {
  return sharedAsNumber(value);
}

async function fetchEnterpriseUsage(
  options: TencentBillingFetchOptions,
  bearer: string,
): Promise<ProviderQuotaResult | undefined> {
  const enterpriseId = options.headers["X-Enterprise-Id"] ?? options.headers["x-enterprise-id"];
  if (enterpriseId === undefined || enterpriseId.length === 0) return undefined;
  let response: Response;
  try {
    response = await options.fetcher(enterpriseUsageUrl(options.url), {
      method: "POST",
      headers: {
        ...options.headers,
        ...(options.uid === undefined || options.uid.length === 0 ? {} : { "X-User-Id": options.uid }),
        Authorization: `Bearer ${bearer}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: "{}",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return undefined;
  }
  if (!response.ok) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(await response.text());
  } catch {
    return undefined;
  }
  const envelope = asRecord(parsed);
  const data = asRecord(envelope?.["data"]) ?? envelope;
  if (data === null) return undefined;
  const limit = finiteNumber(data["limitNum"]) ?? finiteNumber(data["limit_num"]);
  const used = finiteNumber(data["credit"]) ?? finiteNumber(data["used_num"]) ?? 0;
  if (limit === undefined) return undefined;
  if (limit < 0) {
    return {
      source: options.source,
      plan: "Enterprise",
      windows: [percentWindow("quota:enterprise", "Enterprise", null, null, null, null, "independent")],
      error: null,
    };
  }
  const remaining = Math.max(0, limit - used);
  const usedPercent = limit === 0 ? 100 : Math.min(100, (used / limit) * 100);
  const resetsAt = typeof data["cycleEndTime"] === "string" ? data["cycleEndTime"] : null;
  return {
    source: options.source,
    plan: "Enterprise",
    windows: [{
    ...percentWindow("quota:enterprise", "Enterprise", usedPercent, resetsAt, used, limit, "pooled"),
      remaining,
    }],
    error: null,
  };
}

// ── buddy-usage-shared ──────────────────────────────────────────

export interface BuddyUsageRow {
  /** Calendar day the request was metered on, `YYYY-MM-DD`. */
  readonly day: string;
  /** The model id the upstream metered it against. */
  readonly model: string;
  /** Credits deducted for every request on that (day, model). */
  readonly credit: number;
}

export interface BuddyUsageResult {
  readonly rows: readonly BuddyUsageRow[];
  /** Sum of every row's credits. */
  readonly totalCredits: number;
  /**
   * True when the read stopped short: a page failed, the page cap was reached,
   * or the payload was not the expected shape. The rows are what was collected
   * and are still worth showing — they are just not guaranteed to be all of it.
   */
  readonly partial: boolean;
}

export interface BuddyUsageFetchOptions {
  /** `{billingHost}/billing/meter/get-user-request-usage` for this provider. */
  readonly url: string;
  /** Provider transport/identity headers; `Authorization` is added here. */
  readonly headers: Record<string, string>;
  readonly credential: string;
  readonly fetcher: FetchLike;
  /** Window width in days, clamped to the upstream's 30-day maximum. */
  readonly days: number;
  /** Account UID for the `X-User-Id` billing identity header. */
  readonly uid?: string | undefined;
}

const USAGE_MAX_DAYS = 30;

const USAGE_PAGE_SIZE = 200;

const USAGE_MAX_PAGES = 30;

// (TIMEOUT_MS declared once above)

function localStamp(at: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return (
    `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ` +
    `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`
  );
}

export async function fetchBuddyRequestUsage(
  options: BuddyUsageFetchOptions,
): Promise<BuddyUsageResult> {
  const { url, headers, credential, fetcher, uid } = options;
  const bearer = resolveBearerToken(credential);
  if (bearer === null) return { rows: [], totalCredits: 0, partial: true };

  const days = Math.max(1, Math.min(Math.floor(options.days) || USAGE_MAX_DAYS, USAGE_MAX_DAYS));
  const now = Date.now();
  const window = {
    days,
    startTime: localStamp(new Date(now - days * 86_400_000)),
    endTime: localStamp(new Date(now)),
  };

  const rows: BuddyUsageRow[] = [];
  // (day, model) → index into `rows`, so a model seen on two pages aggregates
  // into one row instead of being listed twice.
  const index = new Map<string, number>();
  let totalCredits = 0;
  let partial = false;
  // Raw request rows seen, which is what the upstream's `total` counts — not
  // the aggregated (day, model) rows above.
  let requests = 0;

  for (let page = 1; page <= USAGE_MAX_PAGES; page += 1) {
    const pageResult = await fetchUsagePage({
      url,
      headers,
      bearer,
      fetcher,
      uid,
      body: { ...window, pageNum: page, pageSize: USAGE_PAGE_SIZE },
    });
    // A page that could not be read ends the walk with what is already
    // collected: the rows are real, there are just fewer of them.
    if (pageResult === null) {
      partial = true;
      break;
    }
    const { pageRows, total } = pageResult;
    for (const row of pageRows) {
      const key = `${row.day}\u0000${row.model}`;
      const at = index.get(key);
      if (at === undefined) {
        index.set(key, rows.length);
        rows.push(row);
      } else {
        rows[at] = { ...row, credit: round6(rows[at]!.credit + row.credit) };
      }
      totalCredits += row.credit;
    }
    // An empty page means the end of the data, however many the upstream said
    // it had; carrying on would only re-request it.
    if (pageRows.length === 0) break;
    requests += pageRows.length;
    if (total !== undefined && requests >= total) break;
    // A short page has no more to give, and the upstream's `total` is not
    // always present: stopping here avoids one pointless round trip per read.
    if (pageRows.length < USAGE_PAGE_SIZE) break;
    // Only reaching the page cap means more may exist than we collected.
    if (page === USAGE_MAX_PAGES) partial = true;
  }

  return { rows, totalCredits: Math.round(totalCredits * 100) / 100, partial };
}

interface UsagePage {
  readonly pageRows: readonly BuddyUsageRow[];
  /** The upstream's stated request total, when it stated one. */
  readonly total: number | undefined;
}

async function fetchUsagePage(args: {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly bearer: string;
  readonly fetcher: FetchLike;
  readonly uid: string | undefined;
  readonly body: Record<string, unknown>;
}): Promise<UsagePage | null> {
  let response: Response;
  try {
    response = await args.fetcher(args.url, {
      method: "POST",
      headers: {
        ...args.headers,
        ...(args.uid === undefined || args.uid.length === 0 ? {} : { "X-User-Id": args.uid }),
        Authorization: `Bearer ${args.bearer}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(args.body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(await response.text());
  } catch {
    return null;
  }
  const envelope = asRecord(parsed);
  // A non-zero `code` is a provider-side error even on HTTP 200.
  if (envelope !== null && "code" in envelope) {
    const code = Number(envelope["code"]);
    if (Number.isFinite(code) && code !== 0) return null;
  }
  const data = asRecord(envelope?.["data"]) ?? envelope;
  const list = data?.["data"];
  // Missing business data must not read as "zero usage": an account that has
  // spent nothing and an account whose payload we could not parse must not
  // look the same.
  if (!Array.isArray(list)) return null;

  const pageRows: BuddyUsageRow[] = [];
  for (const entry of list) {
    const row = asRecord(entry);
    if (row === null) continue;
    const day = (asText(row["requestTime"]) ?? "").slice(0, 10);
    if (day.length === 0) continue;
    const model = asText(row["model"]) ?? "unknown";
    const credit = Number(row["credit"] ?? 0);
    pageRows.push({ day, model, credit: Number.isFinite(credit) ? round6(credit) : 0 });
  }
  const rawTotal = data?.["total"];
  const total = typeof rawTotal === "number" && Number.isFinite(rawTotal) ? rawTotal : undefined;
  return { pageRows, total };
}

function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

// ── buddy-usage-store ──────────────────────────────────────────

export interface BuddyUsageSnapshotRow extends BuddyUsageRow {
  readonly syncedAt: string | null;
}

const RETENTION_DAYS = 30;

function retentionCutoff(now: Date = new Date()): string {
  return new Date(now.getTime() - RETENTION_DAYS * 86_400_000).toISOString().slice(0, 10);
}

export async function saveBuddyUsageSnapshots(
  db: CartethyiaDatabase,
  accountId: string,
  rows: readonly BuddyUsageRow[],
): Promise<number> {
  if (rows.length === 0) return 0;
  const now = new Date();
  try {
    await db
      .insert(buddyUsageSnapshots)
      .values(
        rows.map((row) => ({
          accountId,
          dayKey: row.day,
          model: row.model,
          credit: String(row.credit),
          syncedAt: now,
        })),
      )
      .onConflictDoUpdate({
        target: [
          buddyUsageSnapshots.accountId,
          buddyUsageSnapshots.dayKey,
          buddyUsageSnapshots.model,
        ],
        set: {
          credit: sql`excluded."credit"`,
          syncedAt: sql`excluded."synced_at"`,
        },
      });
    return rows.length;
  } catch {
    return 0;
  }
}

const MODELS_PER_DAY_CEILING = 64;

const DEFAULT_LIMIT_PER_ACCOUNT = 30;

export async function readBuddyUsageSnapshots(
  db: CartethyiaDatabase,
  accountIds: readonly string[],
  limitPerAccount = DEFAULT_LIMIT_PER_ACCOUNT,
): Promise<Map<string, readonly BuddyUsageSnapshotRow[]>> {
  const result = new Map<string, BuddyUsageSnapshotRow[]>();
  if (accountIds.length === 0) return result;
  let rows: {
    accountId: string;
    dayKey: string;
    model: string;
    credit: string | number | null;
    syncedAt: Date | string | null;
  }[];
  try {
    rows = await db
      .select({
        accountId: buddyUsageSnapshots.accountId,
        dayKey: buddyUsageSnapshots.dayKey,
        model: buddyUsageSnapshots.model,
        credit: buddyUsageSnapshots.credit,
        syncedAt: buddyUsageSnapshots.syncedAt,
      })
      .from(buddyUsageSnapshots)
      .where(
        and(
          inArray(buddyUsageSnapshots.accountId, [...accountIds]),
          gte(buddyUsageSnapshots.dayKey, retentionCutoff()),
        ),
      )
      .orderBy(desc(buddyUsageSnapshots.dayKey))
      .limit(accountIds.length * limitPerAccount * MODELS_PER_DAY_CEILING);
  } catch {
    return result;
  }
  for (const row of rows) {
    const bucket = result.get(row.accountId) ?? [];
    // Ordered by day, so the first `limitPerAccount` distinct days win and a
    // model that ran every day does not crowd out the rest of the window.
    if (bucket.length >= limitPerAccount && bucket[bucket.length - 1]?.day !== row.dayKey) continue;
    bucket.push({
      day: row.dayKey,
      model: row.model,
      credit: Number(row.credit ?? 0) || 0,
      syncedAt: row.syncedAt instanceof Date ? row.syncedAt.toISOString() : (row.syncedAt ?? null),
    });
    result.set(row.accountId, bucket);
  }
  return result;
}

export async function pruneBuddyUsageSnapshots(
  db: CartethyiaDatabase,
  now: Date = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * 86_400_000)
    .toISOString()
    .slice(0, 10);
  try {
    const deleted = await db
      .delete(buddyUsageSnapshots)
      .where(and(eq(buddyUsageSnapshots.dayKey, cutoff)))
      .returning({ accountId: buddyUsageSnapshots.accountId });
    // Days strictly older than the cutoff, which a single equality cannot reach.
    await db
      .delete(buddyUsageSnapshots)
      .where(sql`${buddyUsageSnapshots.dayKey} < ${cutoff}`);
    return deleted.length;
  } catch {
    return 0;
  }
}
