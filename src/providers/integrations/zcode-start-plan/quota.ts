import { createHash } from "node:crypto";
import { asCoercedNumber, asRecord, asTrimmedString } from "../../../shared/coerce";
import type { FetchLike, ProviderQuotaResult, ProviderQuotaWindow } from "../../quota/quota-contracts";

const BALANCE_URL = "https://zcode.z.ai/api/v1/zcode-plan/billing/balance?app_version=3.16.3";
const APP_VERSION = "3.16.3";
const PLATFORM = "linux-x64";

/**
 * Stable per-account device mid. The gateway validates `X-Device-Mid` as a
 * UUID (billing answers `3001 parameter error` without it) and attributes
 * usage to it; a hardcoded shared UUID would lump every account into one
 * billing identity. Derivation matches the gift-claim device id, so quota and
 * claim present the same device per account.
 */
function deviceMid(accountId: string): string {
  const hash = createHash("sha256").update(`zcode-device\0${accountId}`).digest("hex");
  const variant = ((parseInt(hash[16] as string, 16) & 3) | 8).toString(16);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-${variant}${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

function instant(value: unknown): string | null {
  const seconds = asCoercedNumber(value);
  if (seconds === undefined || seconds <= 0) return null;
  const date = new Date(seconds * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function boundary(values: readonly unknown[], latest: boolean): string | null {
  const instants = values.map(instant).filter((value): value is string => value !== null);
  if (instants.length === 0) return null;
  return instants.reduce((a, b) => (latest ? a > b : a < b) ? a : b);
}

// The upstream capabilities, not the display name, declare which models a grant serves.
function modelIds(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.flatMap((entry: unknown) => {
    const capability = asTrimmedString(entry);
    if (capability === undefined || (capability.includes(":") && !capability.startsWith("model:"))) return [];
    const model = capability.replace(/^model:/, "").trim().toLowerCase();
    return model ? [model] : [];
  }))];
}

function periodLabel(period: string | undefined): string {
  if (period === "daily_night") return "nightly";
  if (period === "one_time") return "one-time";
  return period ?? "grant";
}

function grantLabel(name: string): string {
  return /^(?:zcode\s+)?start plan$/i.test(name) ? "Start" : name;
}

function percent(value: number | null, limit: number | null): number | null {
  return value !== null && limit !== null && limit > 0
    ? Math.min(100, Math.max(0, value / limit * 100))
    : null;
}

function samePlan(bucket: Record<string, unknown>, plan: Record<string, unknown>): boolean {
  const userPlan = asTrimmedString(bucket["user_plan_id"]);
  const owner = asTrimmedString(plan["user_plan_id"]);
  if (userPlan !== undefined && owner !== undefined) return userPlan === owner;
  const id = asTrimmedString(bucket["plan_id"]);
  return id !== undefined && id === asTrimmedString(plan["plan_id"]);
}

/** Billing shape verified against opencode-zcode-auth 0.1.42; see the provider guide. */
export async function fetchZcodeStartPlanQuota(
  credential: string,
  fetcher: FetchLike,
  context?: { accountId?: string },
): Promise<ProviderQuotaResult> {
  const source = "zcode-start";
  try {
    const accountId = context?.accountId ?? credential.trim();
    const response = await fetcher(BALANCE_URL, {
      headers: {
        authorization: `Bearer ${credential}`,
        accept: "application/json",
        "x-device-mid": deviceMid(accountId),
        "x-zcode-app-version": APP_VERSION,
        "x-client-language": "en-US",
        "x-platform": PLATFORM,
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return { source, plan: null, windows: [], error: `plan billing answered ${response.status}` };
    const payload = asRecord(await response.json());
    const code = payload?.["code"];
    if (!payload || payload["success"] === false ||
      (code !== undefined && ![0, 200, "0", "200"].includes(code as string | number))) {
      return { source, plan: null, windows: [], error: "plan billing rejected request" };
    }
    const data = asRecord(payload["data"]);
    if (!data || !Array.isArray(data["balances"]) || !Array.isArray(data["plans"])) {
      return { source, plan: null, windows: [], error: "plan billing returned an unreadable balance" };
    }
    const plans = data["plans"].flatMap((value: unknown) => {
      const plan = asRecord(value);
      return plan ? [plan] : [];
    });
    const windows: ProviderQuotaWindow[] = [];
    const names = new Set<string>();
    const represented = new Set<Record<string, unknown>>();
    for (const raw of data["balances"]) {
      const bucket = asRecord(raw);
      if (!bucket) continue;
      const owner = plans.find((plan) => samePlan(bucket, plan));
      if (owner) represented.add(owner);
      const name = asTrimmedString(owner?.["name"]) ?? "Start Plan";
      names.add(name);
      const entitlement = (Array.isArray(owner?.["entitlements"]) ? owner["entitlements"] : [])
        .map(asRecord).find((entry) => entry?.["entitlement_id"] === bucket["entitlement_id"]);
      const period = asTrimmedString(entitlement?.["period"]);
      const limit = asCoercedNumber(bucket["total_units"]) ?? null;
      const reportedUsed = asCoercedNumber(bucket["used_units"]);
      const reportedRemaining = asCoercedNumber(bucket["remaining_units"]);
      const used = reportedUsed ?? (limit !== null && reportedRemaining !== undefined ? Math.max(0, limit - reportedRemaining) : null);
      const remaining = reportedRemaining ?? (limit !== null && used !== null ? Math.max(0, limit - used) : null);
      const models = modelIds(bucket["capabilities"] ?? entitlement?.["capabilities"]);
      const expired = asTrimmedString(owner?.["status"])?.toLowerCase() === "expired";
      windows.push({
        kind: period ?? "grant",
        label: `${asTrimmedString(bucket["show_name"]) ?? (models.join(", ") || "GLM")} · ${grantLabel(name)} · ${periodLabel(period)}`,
        accounting: "independent",
        modelIds: models,
        startsAt: boundary([owner?.["starts_at"], bucket["period_start"]], true),
        resetsAt: boundary([bucket["expires_at"], bucket["period_end"], owner?.["ends_at"]], false),
        usedPercent: expired ? 100 : percent(used, limit),
        remainingPercent: expired ? 0 : percent(remaining, limit),
        used,
        limit,
        remaining,
        recurring: !expired && (period === "daily" || period === "daily_night"),
      });
    }
    // The balance may list a future plan before it has materialized any buckets.
    for (const plan of plans) {
      const startsAt = instant(plan["starts_at"]);
      if (represented.has(plan) || !startsAt || Date.parse(startsAt) <= Date.now() || plan["status"] === "expired") continue;
      const name = asTrimmedString(plan["name"]) ?? "Start Plan";
      names.add(name);
      const entitlements = Array.isArray(plan["entitlements"]) ? plan["entitlements"] : [];
      const pending = entitlements.length > 0 ? entitlements : [{}];
      for (const raw of pending) {
        const entitlement = asRecord(raw);
        windows.push({
          kind: "grant", label: `${grantLabel(name)} · ${asTrimmedString(entitlement?.["show_name"]) ?? "not started yet"}`,
          accounting: "independent", modelIds: modelIds(entitlement?.["capabilities"]), startsAt,
          resetsAt: instant(plan["ends_at"]), usedPercent: null, remainingPercent: null,
          remaining: null, used: null, limit: asCoercedNumber(entitlement?.["grant_units"]) ?? null,
          recurring: false,
        });
      }
    }
    return { source, plan: [...names].join(", ") || null, windows, error: null };
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    const message = name === "TimeoutError" || name === "AbortError"
      ? "plan billing operation timed out or was aborted"
      : name === "SyntaxError"
        ? "plan billing returned unreadable JSON"
        : "plan billing network request failed";
    return { source, plan: null, windows: [], error: message };
  }
}
