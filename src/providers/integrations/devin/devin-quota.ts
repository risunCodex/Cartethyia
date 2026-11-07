/**
 * Devin usage/quota collector via `GetUserStatus` (SeatManagementService).
 *
 * Ported from oh-my-pi (`usage/devin.ts`, MIT) onto Cartethyia's
 * `QuotaFetcher` contract. Never throws — a failed read returns a null
 * error result so the usage pipeline stays best-effort.
 */

import type { ProviderQuotaResult, ProviderQuotaWindow, FetchLike } from "../../quota/quota-contracts";
import { callDevinUnary } from "./devin-http";
import { identityFromDevinUserStatus } from "./devin-auth";
import {
  DEVIN_DEFAULT_BASE_URL,
  DEVIN_GET_USER_STATUS_PATH,
  devinCliMetadata,
} from "./devin-shared";
import { DevinEnums, DevinMessageTypes, fromEnum } from "./protocol/devin-proto";

const MICROS_PER_USD = 1_000_000;

interface RawUserStatusResponse {
  userStatus?: {
    teamId?: string;
    email?: string;
    teamsTier?: number;
    userId?: string;
    planStatus?: RawPlanStatus;
  };
  planInfo?: RawPlanInfo;
}

interface RawPlanInfo {
  teamsTier?: number;
  planName?: string;
  monthlyPromptCredits?: string | number;
  monthlyFlowCredits?: string | number;
  monthlyFlexCreditPurchaseAmount?: string | number;
  devinInfo?: { orgId?: string; accountDisplayName?: string };
  billingStrategy?: number;
  hideDailyQuota?: boolean;
  hideWeeklyQuota?: boolean;
}

interface RawPlanStatus {
  planInfo?: RawPlanInfo;
  planStart?: string | number;
  planEnd?: string | number;
  availablePromptCredits?: string | number;
  availableFlowCredits?: string | number;
  availableFlexCredits?: string | number;
  usedPromptCredits?: string | number;
  usedFlowCredits?: string | number;
  usedFlexCredits?: string | number;
  overageBalanceMicros?: string | number;
  dailyQuotaRemainingPercent?: number;
  weeklyQuotaRemainingPercent?: number;
  dailyQuotaResetAtUnix?: string | number;
  weeklyQuotaResetAtUnix?: string | number;
}

/** protobufjs returns a Long-like object for int64 fields; never coerce it via String(). */
function toNum(v: unknown): number {
  if (v === undefined || v === null) return 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  if (typeof v === "object" && "low" in v && "high" in v) {
    const low = Number((v as { low: unknown }).low);
    const high = Number((v as { high: unknown }).high);
    if (!Number.isFinite(low) || !Number.isFinite(high)) return 0;
    // Signed low/high pair → JS number (values here are small credits/timestamps).
    return high * 0x1_0000_0000 + (low >>> 0);
  }
  return 0;
}

function tierLabel(tier: number | undefined): string {
  const name = fromEnum(DevinEnums.TeamsTier, tier);
  return name === "UNSPECIFIED" ? "" : name.replace(/_/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase());
}

function creditWindow(
  id: string,
  label: string,
  limit: number,
  used: number,
  available: number,
): ProviderQuotaWindow | undefined {
  if (limit === 0 && used === 0 && available === 0) return undefined;
  return {
    kind: id,
    label,
    accounting: "pooled",
    usedPercent: limit > 0 ? Math.min(100, (used / limit) * 100) : null,
    remainingPercent: limit > 0 ? Math.min(100, Math.max(0, (available / limit) * 100)) : null,
    resetsAt: null,
    used,
    limit,
    remaining: available,
    recurring: true,
  };
}

function quotaWindow(
  id: string,
  label: string,
  remainingPercent: number | undefined,
  resetAtUnix: unknown,
): ProviderQuotaWindow | undefined {
  if (remainingPercent === undefined) return undefined;
  const used = Math.max(0, 100 - remainingPercent);
  const resetSeconds = toNum(resetAtUnix);
  const resetsAt = resetSeconds > 0 ? new Date(resetSeconds * 1000).toISOString() : null;
  return {
    kind: id,
    label,
    accounting: "independent",
    usedPercent: used,
    remainingPercent,
    resetsAt,
    recurring: true,
  };
}

export async function fetchDevinQuota(
  credential: string,
  fetcher: FetchLike,
): Promise<ProviderQuotaResult> {
  const result: ProviderQuotaResult = { source: "devin", plan: null, windows: [], error: null };
  try {
    const response = await callDevinUnary<RawUserStatusResponse>(
      DEVIN_GET_USER_STATUS_PATH,
      DevinMessageTypes.GetUserStatusRequest,
      DevinMessageTypes.GetUserStatusResponse,
      { metadata: devinCliMetadata(credential) },
      { baseUrl: DEVIN_DEFAULT_BASE_URL, fetchImpl: fetcher as unknown as typeof fetch, signal: AbortSignal.timeout(15_000) },
    );

    const plan = response.planInfo ?? response.userStatus?.planStatus?.planInfo ?? undefined;
    const planStatus = response.userStatus?.planStatus;
    if (!plan || !planStatus) return { ...result, error: "Devin returned no plan data" };

    const planName = plan.planName?.trim() || tierLabel(plan.teamsTier ?? response.userStatus?.teamsTier);
    // Prefer the upstream email/display name over the opaque team tag; fall
    // back to the team id only when the upstream reports nothing friendlier.
    const accountLabel =
      identityFromDevinUserStatus(response) ??
      (plan.devinInfo?.orgId?.trim() || response.userStatus?.teamId?.trim() || undefined);

    const billingStrategy = toNum(plan.billingStrategy);
    const quotaBilled = billingStrategy === DevinEnums.BillingStrategy.QUOTA;

    const windows: ProviderQuotaWindow[] = [];
    if (!quotaBilled) {
      // Legacy credit buckets. QUOTA-billed plans (DEVIN_FREE) still report
      // them for backwards compatibility but they do not gate anything —
      // showing "0 / 2,500 Credits" next to the real quota is misleading.
      const prompt = creditWindow("prompt", "Prompt Credits", toNum(plan.monthlyPromptCredits), toNum(planStatus.usedPromptCredits), toNum(planStatus.availablePromptCredits));
      const flow = creditWindow("flow", "Flow Credits", toNum(plan.monthlyFlowCredits), toNum(planStatus.usedFlowCredits), toNum(planStatus.availableFlowCredits));
      const flex = creditWindow("flex", "Flex Credits", toNum(plan.monthlyFlexCreditPurchaseAmount), toNum(planStatus.usedFlexCredits), toNum(planStatus.availableFlexCredits));
      if (prompt) windows.push(prompt);
      if (flow) windows.push(flow);
      if (flex) windows.push(flex);
    }

    // Quota windows: only on QUOTA-billed plans, and never when hidden.
    // Credit-billed accounts leave the percent at proto default (100) with a
    // zero reset, which would render a fake "100% quota" row.
    const quotaApplicable = (hidden: boolean | undefined, resetAt: unknown): boolean =>
      quotaBilled && !hidden && !(toNum(resetAt) === 0);

    if (quotaApplicable(plan.hideDailyQuota, planStatus.dailyQuotaResetAtUnix)) {
      const w = quotaWindow("1d", "Daily Quota", planStatus.dailyQuotaRemainingPercent, planStatus.dailyQuotaResetAtUnix);
      if (w) windows.push(w);
    }
    if (quotaApplicable(plan.hideWeeklyQuota, planStatus.weeklyQuotaResetAtUnix)) {
      const w = quotaWindow("7d", "Weekly Quota", planStatus.weeklyQuotaRemainingPercent, planStatus.weeklyQuotaResetAtUnix);
      if (w) windows.push(w);
    }

    // Monthly plan window belongs to credit-billed plans only.
    if (!quotaBilled) {
      const start = toNum(planStatus.planStart);
      const end = toNum(planStatus.planEnd);
      if (end > start) {
        windows.push({
          kind: "monthly",
          label: "Plan Period",
          accounting: "independent",
          usedPercent: null,
          remainingPercent: null,
          resetsAt: new Date(end * 1000).toISOString(),
          recurring: true,
        });
      }
    }

    const overageMicros = toNum(planStatus.overageBalanceMicros);
    const overageUsd = overageMicros / MICROS_PER_USD;

    return {
      source: "devin",
      plan: planName || null,
      windows,
      error: null,
      ...(accountLabel ? { accountLabel } : {}),
      ...(overageUsd !== 0 ? { plan: `${planName} (overage $${overageUsd.toFixed(2)})` } : {}),
    };
  } catch {
    return { ...result, error: "Devin quota fetch failed" };
  }
}
