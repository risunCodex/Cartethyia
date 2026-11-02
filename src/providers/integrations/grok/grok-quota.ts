import type { FetchLike, ProviderQuotaResult, ProviderQuotaWindow } from "../../quota/quota-contracts";
import { isoDate, number, percentWindow, record, text } from "../../quota/quota-contracts";
import { buildGrokAuthUserAgent, getGrokVersion } from "../../operations/client-versions";
import { decodeGrokCreditsFrame } from "./grok-quota-frame";
import {
  grokAuthoritativeWindow,
  grokHeaderRequestsWindow,
  grokHeaderWindow,
  GROK_FREE_USAGE_EXHAUSTED,
  GROK_SPENDING_LIMIT_EXHAUSTED,
  parseGrokFreeUsageVerdict,
  readGrokRateLimitHeaders,
} from "./grok-ratelimit";
import type { GrokRateLimitProbe } from "./grok-ratelimit";
import { storedGrokRateLimit } from "./grok-ratelimit-store";
import type { QuotaCollectionContext } from "../../quota/quota-support";

const BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
const BILLING_SOURCE = "cli-chat-proxy.grok.com/v1/billing";
const USER_URL = "https://cli-chat-proxy.grok.com/v1/user?include=subscription";
const GRPC_CREDITS_URL = "https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig";
const GRPC_EMPTY_FRAME = new Uint8Array([0, 0, 0, 0, 0]);

/**
 * The cheapest request that still returns the rate-limit headers.
 *
 * There is no dedicated quota endpoint — `grok.com/rest/*` does not expose one
 * and `/v1/models` carries no rate-limit headers — so reading the bucket costs
 * one real request. At ~360-480 tokens against a 1M allowance that is a few
 * thousand readings per account, which is affordable; a larger cap would not
 * be.
 */
const PROBE_URL = "https://cli-chat-proxy.grok.com/v1/responses";
const PROBE_BODY = {
  model: "grok-4.7",
  stream: true,
  max_output_tokens: 256,
  input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Hi" }] }],
};

/**
 * Auth headers shared by every xAI billing/userinfo call: bearer token plus
 * the CLI client identity the gateway gates on.
 */
function xaiHeaders(accessToken: string): Record<string, string> {
  const version = getGrokVersion();
  return {
    authorization: `Bearer ${accessToken}`,
    "x-xai-token-auth": "xai-grok-cli",
    "x-grok-client-version": version,
    "user-agent": buildGrokAuthUserAgent(version),
  };
}
interface XaiBillingPayload {
  currentPeriod?: unknown;
  creditUsagePercent?: unknown;
  productUsage?: unknown;
  onDemandCap?: unknown;
  onDemandUsed?: unknown;
  billingPeriodStart?: unknown;
  billingPeriodEnd?: unknown;
  monthlyLimit?: unknown;
  used?: unknown;
  subscriptionTier?: unknown;
  user?: unknown;
}

function parsePayload(value: string): XaiBillingPayload {
  const payload: unknown = JSON.parse(value);
  // Live billing wraps usage in a `config` envelope (free-tier shape);
  // paid shapes may carry the fields top-level — read the envelope first.
  const parsed = record(payload);
  return ((parsed && record(parsed.config)) ?? parsed ?? {}) as XaiBillingPayload;
}

function billingNumber(value: unknown): number | null {
  const nested = record(value);
  return number(nested?.val ?? value);
}

function period(raw: unknown): { start: string; end: string } | undefined {
  const value = record(raw);
  const type = text(value?.type);
  if (type !== null && !type.toUpperCase().includes("WEEK")) return undefined;
  const start = isoDate(value?.start);
  const end = isoDate(value?.end);
  return start && end && Date.parse(end) > Date.parse(start) ? { start, end } : undefined;
}

function buildWeeklyWindows(payload: XaiBillingPayload): ProviderQuotaWindow[] {
  const current = period(payload.currentPeriod);
  const creditPercent = billingNumber(payload.creditUsagePercent);
  if (!current) return [];
  if (creditPercent === null || creditPercent < 0 || creditPercent > 100) {
    // Free-tier billing states the period but no usage percent: emit the
    // window with the reset date and null percents (the dashboard renders
    // the countdown without inventing a number) instead of empty windows.
    return [percentWindow("1w", "SuperGrok Weekly Credits", null, current.end, null, null, "independent")];
  }
  const windows: ProviderQuotaWindow[] = [
    percentWindow("1w", "SuperGrok Weekly Credits", creditPercent, current.end, creditPercent, 100, "independent"),
  ];
  if (Array.isArray(payload.productUsage)) {
    for (const entry of payload.productUsage) {
      const value = record(entry);
      const product = text(value?.product);
      const percent = billingNumber(value?.usagePercent);
      windows.push(percentWindow(`product:${product}:1w`, `${product} (Weekly)`, percent, current.end, percent, 100, "independent"));
    }
  }
  return windows;
}

function buildMonthlyWindows(payload: XaiBillingPayload): ProviderQuotaWindow[] {
  const start = isoDate(payload.billingPeriodStart);
  const end = isoDate(payload.billingPeriodEnd);
  const limit = billingNumber(payload.monthlyLimit);
  const used = billingNumber(payload.used);
  if (!start || !end || limit === null || limit <= 0 || used === null || used < 0) return [];
  const usedPercent = Math.min(100, (used / limit) * 100);
  return [percentWindow("1mo", "SuperGrok Monthly Included", usedPercent, end, used, limit, "independent")];
}

function addOnDemandWindow(windows: ProviderQuotaWindow[], payload: XaiBillingPayload): void {
  const cap = billingNumber(payload.onDemandCap);
  const used = billingNumber(payload.onDemandUsed);
  if (cap === null || cap <= 0 || used === null || used < 0) return;
  windows.push(percentWindow("on-demand", "On-demand", Math.min(100, (used / cap) * 100), null, used, cap, "independent"));
}

async function fetchGrpcCredits(
  accessToken: string,
  fetcher: FetchLike,
): Promise<{ percentUsed: number; resetAt: string | null } | null> {
  try {
    const response = await fetcher(GRPC_CREDITS_URL, {
      method: "POST",
      headers: {
        ...xaiHeaders(accessToken),
        "content-type": "application/grpc-web+proto",
        "x-grpc-web": "1",
      },
      body: GRPC_EMPTY_FRAME,
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) return null;
    const arrayBuffer = await response.arrayBuffer();
    return decodeGrokCreditsFrame(new Uint8Array(arrayBuffer));
  } catch {
    return null;
  }
}

async function fetchUser(
  accessToken: string,
  fetcher: FetchLike,
): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetcher(USER_URL, {
      headers: { ...xaiHeaders(accessToken), accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return null;
    return record((await response.json()) as unknown);
  } catch {
    return null;
  }
}

/**
 * One cheap request, read for its rate-limit headers — and, when the account is
 * being refused, for the authoritative allowance in the 429 body.
 *
 * A refusal is not a failure of the probe: it is the only moment upstream
 * states the real free allowance, so the body is parsed before anything is
 * discarded. A transport failure is the opposite — it says nothing about the
 * account, so it yields no reading rather than a zero.
 */
async function probeRateLimit(
  accessToken: string,
  fetcher: FetchLike,
): Promise<GrokRateLimitProbe> {
  try {
    const response = await fetcher(PROBE_URL, {
      method: "POST",
      headers: { ...xaiHeaders(accessToken), "content-type": "application/json" },
      body: JSON.stringify(PROBE_BODY),
      signal: AbortSignal.timeout(30_000),
    });
    const reading = readGrokRateLimitHeaders(response.headers);
    let authoritative = null;
    let note: string | null = null;
    if (response.status === 429) {
      const body = await response.text();
      const verdict = parseGrokFreeUsageVerdict(parsePayload(body), body);
      authoritative = verdict ? grokAuthoritativeWindow(verdict) : null;
      note = GROK_FREE_USAGE_EXHAUSTED;
    } else if (response.status === 402) {
      // A 402 names a spend/entitlement wall (e.g.
      // `personal-team-blocked:spending-limit`), not a reading failure. The
      // account cannot serve, so it is a refusal — but there is no token
      // allowance to display, so we carry the note without a window.
      await response.text();
      note = GROK_SPENDING_LIMIT_EXHAUSTED;
    } else if (!response.ok) {
      // Drain so the connection is reusable, then report nothing: an unrelated
      // failure must not read as an exhausted allowance.
      await response.text();
    } else {
      // A 2xx stream is read for its headers only; cancel the body so the
      // connection is released without waiting for the full completion.
      await response.body?.cancel?.();
    }
    return {
      header: grokHeaderWindow(reading),
      requests: grokHeaderRequestsWindow(reading),
      authoritative,
      refusal: response.status === 429,
      note,
    };
  } catch {
    return { header: null, requests: null, authoritative: null, refusal: false, note: null };
  }
}

/** Fetches Grok Build subscription billing, including weekly and unified-monthly fallbacks. */
export async function fetchGrokQuota(
  credential: string,
  fetcher: FetchLike,
  context?: QuotaCollectionContext,
): Promise<ProviderQuotaResult> {
  const accessToken = credential.trim();
  if (!accessToken) throw new Error("grok quota requires an OAuth access token");
  const response = await fetcher(BILLING_URL, {
    headers: { ...xaiHeaders(accessToken), accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(`Grok Build billing request failed (${response.status}): ${raw.slice(0, 500)}`);
  const payload = parsePayload(raw);
  const windows = buildWeeklyWindows(payload);
  if (windows.length === 0 || windows.every((w) => w.usedPercent === null)) {
    const grpc = await fetchGrpcCredits(accessToken, fetcher);
    if (grpc) {
      const idx = windows.findIndex((w) => w.label.includes("Weekly"));
      const grpcWindow = percentWindow("1w", "SuperGrok Weekly Credits", grpc.percentUsed, grpc.resetAt, grpc.percentUsed, 100, "independent");
      if (idx >= 0) windows[idx] = grpcWindow;
      else windows.unshift(grpcWindow);
    }
  }
  if (windows.length === 0) windows.push(...buildMonthlyWindows(payload));
  addOnDemandWindow(windows, payload);
  const user = await fetchUser(accessToken, fetcher);
  const userRecord = record(user?.user);
  const plan =
    text(user?.subscriptionTier) ??
    text(payload.subscriptionTier) ??
    text(userRecord?.subscriptionTier) ??
    "SuperGrok";
  // The billing windows are the subscription's own accounting; the two CLI
  // readings say something different — what this account can still *serve* —
  // so they are prepended and appended around it rather than merged in.
  //
  // Header first: it is what a caller sees every day and it never goes stale
  // into "unknown". Authoritative last: it only exists once upstream has
  // refused, and it is the number that decides the account, so it sits beneath
  // the indicator it overrides.
  // A reading captured from real traffic costs nothing, so it is preferred
  // whenever one is fresh. The probe is the fallback for the first read after a
  // start — never the routine path, or every console refresh would spend a
  // request.
  const stored = context?.accountId === undefined
    ? null
    : storedGrokRateLimit(context.accountId);
  const probe = stored ? null : await probeRateLimit(accessToken, fetcher);
  const ordered: ProviderQuotaWindow[] = [];
  if (stored) ordered.push(...stored);
  else if (probe) {
    if (probe.header) ordered.push(probe.header);
    if (probe.requests) ordered.push(probe.requests);
  }
  ordered.push(...windows);
  if (probe?.authoritative) ordered.push(probe.authoritative);
  // Deliberately not `probe.note` in `error`: a refusal here is the probe's own
  // doing and says the account is out of free usage, which is *account state*,
  // not a read failure. Reporting it as an error would make a healthy read look
  // broken; the authoritative window below is what carries the verdict.
  return { source: "grok", plan, windows: ordered, error: null };
}

export { BILLING_SOURCE as GROK_BILLING_SOURCE };
