import { consoleRequest } from "../data/api";
import type { ApiErrorShape } from "../data/api";
import { queryKeys } from "../data/query-keys";
import { querySignal } from "../data/assert";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";


export interface QuotaProviderSummary {
  readonly id: string;
  readonly name: string;
  readonly icon?: string;
}

export interface QuotaWindow {
  readonly kind?: string;
  readonly label: string;
  readonly accounting: "pooled" | "independent";
  readonly remainingPercent: number | null;
  readonly usedPercent?: number | null;
  readonly resetsAt: string | null;
  readonly modelIds?: readonly string[];
  readonly startsAt?: string | null;
  readonly used?: number | null;
  readonly limit?: number | null;
  /** Absolute remaining credits/value when the source does not report a percentage. */
  readonly remaining?: number | null;
  readonly recurring?: boolean;
}

export interface QuotaData {
  readonly source: string | null;
  readonly status: "unknown" | "refreshing" | "ready" | "error";
  readonly plan: string | null;
  readonly windows: QuotaWindow[];
  readonly fetchedAt: string | null;
  readonly lastAttemptAt: string | null;
  readonly lastSuccessAt: string | null;
  readonly error: string | null;
  readonly refreshError?: string | null;
}


export interface QuotaAccountHealth {
  readonly status: string;
  readonly statusCode?: number | null;
  readonly sanitizedMessage?: string | null;
  readonly lastErrorCategory?: string | null;
  /** Account-wide cooldown deadline; null for a model-scoped throttle. */
  readonly cooldownUntil?: string | null;
  /** Per-model backoffs still in force, keyed by model id. */
  readonly modelCooldowns?: Readonly<Record<string, string>>;
}

export interface QuotaEntry {
  readonly id: string;
  readonly provider: string;
  readonly name: string;
  readonly credentialHint: string;
  readonly active: boolean;
  readonly quota: QuotaData | null;
  /** True while the gateway is filling this account's cache in the background. */
  readonly pending?: boolean;
  readonly health: QuotaAccountHealth | null;
  readonly providerName: string;
  readonly providerIcon: string;
  /**
   * Present only on buddy-family accounts (`workbuddy`, `workbuddycn`, `cb`, `cbcn`).
   * `attemptedToday` is the sweep's day marker: true means the sweep already
   * tried this account today (no upstream cost to read). False means unknown —
   * the sweep may simply not have reached it yet, never "not claimed".
   */
  readonly checkin?: {
    readonly attemptedToday: boolean;
  };
}

export interface QuotaOverview {
  readonly providers: QuotaProviderSummary[];
  readonly accounts: QuotaEntry[];
  /** Accounts the gateway is currently refreshing; drives the fast poll cadence. */
  readonly refreshing?: number;
}

/** Loads the server-joined provider/account quota projection. */
export async function fetchQuotaOverview(signal?: AbortSignal): Promise<QuotaOverview> {
  return consoleRequest<QuotaOverview>("/quota/overview", signal ? { signal } : undefined);
}

/**
 * Loads the tenant's providers/accounts joined with quota + health.
 *
 * Loads once and then only on an explicit refresh. Polling is off because
 * every read re-enters the server's quota path, which is what made opening the
 * page update every account at once. A periodic worker already keeps quota warm
 * server-side; the page is a viewer, not a second scheduler.
 *
 * `placeholderData` keeps the previous accounts on screen while a manual
 * refresh is in flight, so the list does not flash empty.
 */
export function useQuotaOverview() {
  return useQuery<QuotaOverview>({
    queryKey: queryKeys.quota.all,
    queryFn: (context) => fetchQuotaOverview(querySignal(context)),
    // No `refetchInterval`, no `refetchOnWindowFocus`, no `refetchOnMount`:
    // each of those re-reads the quota surface, and the worker owns freshness.
    staleTime: Infinity,
    refetchInterval: false,
    refetchIntervalInBackground: false,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    placeholderData: (previous) => previous,
  });
}


/** Result of a single-account test (`POST /accounts/:id/quota/refresh`). */
export interface AccountTestResult {
  readonly ok: boolean;
  readonly message?: string;
}

/** Tests one account against its upstream provider and refreshes its views. */
export function useRefreshAccountQuota(accountId: string) {
  const queryClient = useQueryClient();
  const queryKey = queryKeys.quota.account(accountId);
  return useMutation<AccountTestResult, ApiErrorShape, void>({
    mutationFn: async () => {
      return consoleRequest<AccountTestResult>(
        `/accounts/${encodeURIComponent(accountId)}/quota/refresh`,
        {
          method: "POST",
        },
      );
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey, exact: true }),
        queryClient.invalidateQueries({ queryKey: queryKeys.quota.all }),
        // The test stamps lastSuccessAt/lastError on the account row, so the
        // account list (Last check) must refetch too — otherwise the test
        // looks like it did nothing.
        queryClient.invalidateQueries({ queryKey: queryKeys.providers.all }),
      ]);
    },
  });
}

export interface GiftClaimResult {
  readonly state: "claimed" | "already_claimed" | "nothing" | "captcha" | "error" | "partial";
  readonly claimed: readonly string[];
  readonly detail: string | null;
}

/** Explicit operator action; new entitlements invalidate the cached quota views. */
export function useClaimAccountGifts(accountId: string) {
  const queryClient = useQueryClient();
  return useMutation<GiftClaimResult, ApiErrorShape, void>({
    mutationFn: async () => {
      const result = await consoleRequest<{ readonly data: GiftClaimResult }>(
        `/accounts/${encodeURIComponent(accountId)}/claim-gifts`,
        { method: "POST" },
      );
      return result.data;
    },
    onSuccess: async (result) => {
      if (result.claimed.length === 0) return;
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.quota.account(accountId), exact: true }),
        queryClient.invalidateQueries({ queryKey: queryKeys.quota.all }),
        queryClient.invalidateQueries({ queryKey: queryKeys.providers.all }),
      ]);
    },
  });
}

/** Result of a manual Qoder daily-credits claim. */
export interface QoderCreditClaimResult {
  readonly state: "claimed" | "already_claimed" | "nothing" | "error";
  readonly amount: number;
  readonly detail: string | null;
}

/** Explicit operator action; grant invalidation mirrors `useClaimAccountGifts`. */
export function useClaimQoderCredits(accountId: string) {
  const queryClient = useQueryClient();
  return useMutation<QoderCreditClaimResult, ApiErrorShape, void>({
    mutationFn: async () => {
      const result = await consoleRequest<{ readonly data: QoderCreditClaimResult }>(
        `/accounts/${encodeURIComponent(accountId)}/claim-qoder-credits`,
        { method: "POST" },
      );
      return result.data;
    },
    onSuccess: async (result) => {
      if (result.state !== "claimed") return;
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.quota.account(accountId), exact: true }),
        queryClient.invalidateQueries({ queryKey: queryKeys.quota.all }),
        queryClient.invalidateQueries({ queryKey: queryKeys.providers.all }),
      ]);
    },
  });
}


/** Aggregated result of one or more `/quota/refresh` batches. */
export interface QuotaRefreshResult {
  readonly ok: boolean;
  readonly queued: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly failures: ReadonlyArray<{ accountId: string; code: string; message: string }>;
}

/**
 * Queues a quota refresh for every account passed and invalidates the overview
 * once queued.
 *
 * Sent as one request at any size. It used to be split into batches of 100 to
 * mirror a backend cap that no longer exists: the server drains the work
 * through a bounded pool, so batching only added round-trips and left the
 * caller with no way to know how far the run had got.
 *
 * `onProgress` reports checked-of-total while the run is in flight, which is
 * what makes a refresh of several hundred accounts feel like progress instead
 * of a hung button.
 */
export function useRefreshAllQuotas() {
  const queryClient = useQueryClient();
  return useMutation<
    QuotaRefreshResult,
    ApiErrorShape,
    { accountIds: string[]; onProgress?: (done: number, total: number) => void }
  >({
    mutationFn: async ({ accountIds, onProgress }): Promise<QuotaRefreshResult> => {
      const total = accountIds.length;
      let done = 0;
      // Server-sent progress when the deployment streams it; the counter is
      // advanced per accepted account so a plain JSON response still reports
      // the full run on completion rather than nothing.
      const result = await consoleRequest<QuotaRefreshResult>("/quota/refresh", {
        method: "POST",
        body: JSON.stringify({ accountIds }),
      });
      done = result.queued;
      onProgress?.(done, total);
      return result;
    },
    onSuccess: async (result, variables) => {
      const accountIds = variables.accountIds;
      const failed = new Set(result.failures.map((failure) => failure.accountId));
      const refreshed = accountIds.filter((accountId) => !failed.has(accountId));
      await Promise.all([
        ...refreshed.map((accountId) =>
          queryClient.invalidateQueries({
            queryKey: queryKeys.quota.account(accountId),
            exact: true,
          }),
        ),
        queryClient.invalidateQueries({ queryKey: queryKeys.quota.all }),
      ]);
    },
  });
}

/** Enables or disables a single quota-tracked account. */
export function useUpdateAccountActive() {
  const queryClient = useQueryClient();
  return useMutation<{ ok: boolean }, ApiErrorShape, { id: string; active: boolean }>({
    mutationFn: ({ id, active }) =>
      consoleRequest<{ ok: boolean }>(`/accounts/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify({ active }),
      }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.quota.all }),
        queryClient.invalidateQueries({ queryKey: queryKeys.providers.all }),
      ]);
    },
  });
}

/** Enables or disables a batch of quota-tracked accounts in one request. */
export function useSetAccountsActiveBatch() {
  const queryClient = useQueryClient();
  return useMutation<void, ApiErrorShape, { ids: string[]; active: boolean }>({
    mutationFn: async ({ ids, active }) => {
      if (ids.length === 0) return;
      await consoleRequest("/accounts/batch", {
        method: "PATCH",
        body: JSON.stringify({ ids, active }),
      });
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.quota.all }),
        queryClient.invalidateQueries({ queryKey: queryKeys.providers.all }),
      ]);
    },
  });
}

/** Deletes a quota-tracked account. */
export function useDeleteQuotaAccount() {
  const queryClient = useQueryClient();
  return useMutation<void, ApiErrorShape, string>({
    mutationFn: async (accountId) => {
      await consoleRequest(`/accounts/${encodeURIComponent(accountId)}`, {
        method: "DELETE",
      });
    },
    onSuccess: async (_result, accountId) => {
      queryClient.removeQueries({ queryKey: queryKeys.quota.account(accountId), exact: true });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.quota.all }),
        queryClient.invalidateQueries({ queryKey: queryKeys.providers.all }),
      ]);
    },
  });
}

/** Result of one manual daily check-in trigger (`POST /accounts/:id/checkin`). */
export interface AccountCheckinResult {
  readonly ok: boolean;
  readonly message?: string;
  readonly data?: {
    readonly id: string;
    readonly state: string;
    readonly credit: number | null;
    readonly streakDays: number | null;
  };
}

/** Provider ids whose billing facade exposes the daily check-in routes. */
const CHECKIN_PROVIDER_IDS = new Set(["workbuddy", "workbuddycn", "cb", "cbcn"]);

/** True when the account can show a daily check-in action on its card. */
export function supportsAccountCheckin(providerId: string): boolean {
  return CHECKIN_PROVIDER_IDS.has(providerId.trim().toLowerCase());
}

/** Triggers one account's daily check-in against its upstream provider. */
export function useTriggerAccountCheckin(accountId: string) {
  const queryClient = useQueryClient();
  return useMutation<AccountCheckinResult, ApiErrorShape, void>({
    mutationFn: async () => {
      return consoleRequest<AccountCheckinResult>(
        `/accounts/${encodeURIComponent(accountId)}/checkin`,
        {
          method: "POST",
        },
      );
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.quota.all }),
        queryClient.invalidateQueries({ queryKey: queryKeys.providers.all }),
      ]);
    },
  });
}

/**
 * Triggers one account's growth-activity report on its own.
 *
 * The report is the leg that actually lands on a free plan — the check-in is
 * often simply not open — so an operator needs to be able to run it without
 * also attempting a claim.
 */
export function useTriggerAccountReport(accountId: string) {
  const queryClient = useQueryClient();
  return useMutation<AccountActivityReportResult, ApiErrorShape, void>({
    mutationFn: async () => {
      return consoleRequest<AccountActivityReportResult>(
        `/accounts/${encodeURIComponent(accountId)}/activity-report`,
        {
          method: "POST",
        },
      );
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.quota.all }),
        queryClient.invalidateQueries({ queryKey: queryKeys.providers.all }),
      ]);
    },
  });
}

/** One account's outcome inside a provider-wide daily growth batch. */
export interface ProviderDailyGrowthEntry {
  readonly accountId: string;
  readonly label: string;
  readonly report: { readonly ok: boolean; readonly message: string };
  readonly checkin: { readonly ok: boolean; readonly message: string };
}

/** Result of `POST /quota/daily-growth`. */
export interface ProviderDailyGrowthResult {
  readonly ok: boolean;
  readonly status: number;
  readonly providerId: string;
  readonly data: readonly ProviderDailyGrowthEntry[];
  readonly message: string;
}

/**
 * Runs the daily growth pass over every account of one provider.
 *
 * Report first, then claim — the order the sweep uses — batched with per-account
 * egress rotation, so a batch leaves from more than one address instead of
 * hammering the upstream from one. Per-account outcomes come back individually:
 * one account's closed check-in must not hide the others' streaks.
 */
export function useTriggerProviderDailyGrowth(providerId: string) {
  const queryClient = useQueryClient();
  return useMutation<ProviderDailyGrowthResult, ApiErrorShape, void>({
    mutationFn: async (): Promise<ProviderDailyGrowthResult> => {
      if (providerId.length === 0) throw new Error("Select a provider first");
      return consoleRequest<ProviderDailyGrowthResult>("/quota/daily-growth", {
        method: "POST",
        body: JSON.stringify({ providerId }),
      });
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.quota.all }),
        queryClient.invalidateQueries({ queryKey: queryKeys.providers.all }),
      ]);
    },
  });
}

/** Result of one manual growth-activity report (`POST /accounts/:id/activity-report`). */
export interface AccountActivityReportResult {
  readonly ok: boolean;
  readonly message?: string;
  readonly data?: {
    readonly id: string;
    readonly state: string;
    readonly alreadyToday: boolean;
  };
}

/** Result of one manual growth pass: activity report + check-in claim. */
export interface AccountGrowthPassResult {
  /** Human summary covering both steps, e.g. what happened per step. */
  readonly message: string;
  /**
   * True when the report leg landed. The report is the reliable one — the
   * check-in is often simply not open on a free plan — so a pass is a success
   * when the account got its streak, whether or not a credit was claimable.
   */
  readonly ok: boolean;
  readonly checkin: AccountCheckinResult;
  readonly report: AccountActivityReportResult;
}

/**
 * Runs the daily growth pass for one account: the growth-activity report first,
 * then the check-in claim — the order the sweep uses, so both surfaces agree.
 *
 * Report first because it is the leg that lands on a free plan. The check-in
 * activity is often not running at all, and running the claim first meant its
 * outcome decided whether the report fired, so those accounts got neither.
 * Both legs now always run, and one toast tells the whole story.
 */
export function useTriggerGrowthPass(accountId: string) {
  const queryClient = useQueryClient();
  return useMutation<AccountGrowthPassResult, ApiErrorShape, void>({
    mutationFn: async (): Promise<AccountGrowthPassResult> => {
      const report = await consoleRequest<AccountActivityReportResult>(
        `/accounts/${encodeURIComponent(accountId)}/activity-report`,
        { method: "POST" },
      );
      const reportMsg = report.message ?? "Activity reported";
      const checkin = await consoleRequest<AccountCheckinResult>(
        `/accounts/${encodeURIComponent(accountId)}/checkin`,
        { method: "POST" },
      );
      const checkinMsg = checkin.message ?? "Daily check-in done";
      // Report is the reliable leg, so the pass succeeds when it landed. A
      // check-in that is merely unavailable is the normal case on a free plan,
      // not a failure — so it reads as a status, not an error, and says when
      // the credit arrives.
      return {
        ok: report.ok,
        message: report.ok
          ? `Report success · Check-in ${checkinMsg}`
          : `Report failed: ${reportMsg} · Check-in ${checkinMsg}`,
        checkin,
        report,
      };
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.quota.all }),
        queryClient.invalidateQueries({ queryKey: queryKeys.providers.all }),
      ]);
    },
  });
}

export interface AccountResetCredit {
  readonly id: string;
  readonly status?: string;
  readonly title?: string;
  readonly grantedAt?: string;
  readonly expiresAt?: string;
}

/** Result of `GET /accounts/:id/resets` — the live saved-reset inventory. */
export interface AccountResetList {
  readonly availableCount: number;
  readonly credits: readonly AccountResetCredit[];
}

/** Result of `POST /accounts/:id/reset`. */
export interface AccountResetResult {
  readonly ok: boolean;
  readonly code: string;
  readonly message?: string;
  readonly creditId?: string;
}

const RESET_PROVIDER_IDS = new Set(["codex", "claude", "anthropic"]);

/** True when the account supports rate-limit reset redemption (Codex & Claude). */
export function supportsAccountReset(providerId: string): boolean {
  return RESET_PROVIDER_IDS.has(providerId.trim().toLowerCase());
}

/**
 * Reads the account's live saved-reset inventory. Deliberately a separate query
 * from the quota overview: the credit objects live on dedicated provider routes
 * (Codex `/wham/rate-limit-reset-credits`, Claude's probed `cedar_ember` block),
 * and Claude's usage payload leaves that block `null` until asked for it, so a
 * count mirrored onto the quota payload would silently read zero.
 */
export function useAccountResets(accountId: string, enabled: boolean) {
  return useQuery<AccountResetList>({
    queryKey: queryKeys.quota.resets(accountId),
    queryFn: ({ signal }) =>
      consoleRequest<AccountResetList>(
        `/accounts/${encodeURIComponent(accountId)}/resets`,
        signal ? { signal } : undefined,
      ),
    enabled,
    staleTime: 30_000,
  });
}

/** Redeems a saved rate-limit reset for the target account, logged to health_events. */
export function useTriggerAccountReset(accountId: string) {
  const queryClient = useQueryClient();
  return useMutation<AccountResetResult, ApiErrorShape, { creditId?: string } | void>({
    mutationFn: async (vars) => {
      return consoleRequest<AccountResetResult>(
        `/accounts/${encodeURIComponent(accountId)}/reset`,
        {
          method: "POST",
          body: JSON.stringify(vars ?? {}),
        },
      );
    },
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.quota.all }),
        queryClient.invalidateQueries({ queryKey: queryKeys.providers.all }),
      ]);
    },
  });
}
