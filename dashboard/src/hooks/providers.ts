import { consoleRequest } from "../data/api";
import type { ApiErrorShape } from "../data/api";
// Console-owned device-poll DTO; token material remains provider-internal.
import type { AccountHealthEventRecord, ByokConnectionTestRequest, ByokConnectionTestResult, CreateProviderAccountBatchResult, CreateProviderAccountRequest, CreateProviderRequest, OAuthDevicePollResponse as OAuthDevicePollResult, ProbeAllAccountsResult, ProbeModelRequest, ProbeModelResult, ProviderAccountResponse, ProviderAccountsExportResponse, ProviderResponse, SetModelEnabledRequest, UpdateProviderAccountRequest, UpdateProviderRequest } from "../data/contracts";
import { queryKeys } from "../data/query-keys";
import { assertModels, assertProvider, assertProviders, querySignal } from "../data/assert";
import { DASHBOARD_QUERY_OPTIONS, POLL } from "../data/query-policy";
import { getErrorMessage } from "../data/api";
import { toast } from "../lib/toast";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";

/**
 * Operator-supplied limits/capabilities sent with a register or metadata update.
 *
 * `null` means "unknown" and is distinct from an absent field, which means
 * "leave the stored value alone" — an edit that only sets the context ceiling
 * must not reset the capability flags.
 */
export interface ModelMetadataPayload {
  readonly contextLimit?: number | null;
  readonly outputLimit?: number | null;
  readonly passthrough?: boolean;
  readonly image?: boolean;
  readonly reasoning?: boolean;
  readonly toolCall?: boolean;
}


/**
 * Loads the tenant provider catalog and observes background metadata refreshes.
 *
 * Lazy by design: the cached list renders instantly on revisit and revalidates
 * in the background (the default 60 s freshness + 60 s poll). Mutations
 * invalidate this key, so a longer stale window can never strand a
 * create/update/delete. `staleTime` is left at the shared default.
 */
export function useProviders() {
  return useQuery({
    queryKey: queryKeys.providers.all,
    queryFn: (context) =>
      consoleRequest<unknown>("/providers", { signal: querySignal(context) }).then(assertProviders),
    ...DASHBOARD_QUERY_OPTIONS,
    gcTime: 600_000,
    refetchInterval: POLL.catalog,
  });
}

/** Loads one provider's detail DTO, including the private-to-detail base URL. */
export function useProviderDetail(providerId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.providers.detail(providerId ?? ""),
    queryFn: (context) =>
      consoleRequest<unknown>(`/providers/${encodeURIComponent(providerId ?? "")}`, {
        signal: querySignal(context),
      }).then(assertProvider),
    enabled: Boolean(providerId),
    ...DASHBOARD_QUERY_OPTIONS,
  });
}

/**
 * Loads models for one provider; no request is made until a provider is selected.
 *
 * The catalog barely moves, so a 5-minute stale window stops every provider
 * card from flashing "Loading models…" on each visit. Registration and sync
 * mutations invalidate this key.
 */
export function useProviderModels(providerId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.providers.models(providerId),
    queryFn: (context) => {
      if (!providerId) throw { status: 400, code: "invalid_request", message: "Provider is required" } satisfies ApiErrorShape;
      return consoleRequest<unknown>(`/providers/${encodeURIComponent(providerId)}/models`, {
        signal: querySignal(context),
      }).then(assertModels);
    },
    ...DASHBOARD_QUERY_OPTIONS,
    staleTime: 300_000,
    gcTime: 600_000,
    enabled: Boolean(providerId),
  });
}

/** Manually registers additional models on an existing provider (no upstream call). */
export function useRegisterProviderModels() {
  const queryClient = useQueryClient();
  return useMutation<
    { registered: number },
    ApiErrorShape,
    {
      providerId: string;
      modelIds: readonly string[];
      wireFamily?: string;
      metadata?: ModelMetadataPayload;
    }
  >({
    mutationFn: ({ providerId, modelIds, wireFamily, metadata }) =>
      consoleRequest<{ registered: number }>(
        `/providers/${encodeURIComponent(providerId)}/models`,
        {
          method: "POST",
          body: JSON.stringify({
            modelIds,
            ...(wireFamily ? { wireFamily } : {}),
            ...(metadata ? { metadata } : {}),
          }),
        },
      ),
    onSuccess: async (_result, variables) => {
      await queryClient.invalidateQueries({
        queryKey: queryKeys.providers.models(variables.providerId),
      });
      toast.success("Models registered", `${variables.modelIds.length} model(s) added to ${variables.providerId}`);
    },
    onError: (error) => {
      toast.error("Failed to register models", getErrorMessage(error));
    },
  });
}

/** Probes a model's connectivity through the real provider adapter; records
 * the outcome into telemetry. Works for a not-yet-registered candidate id
 * (pass `wireFamily`) or an already-registered model (pass `route`). */
export function useProbeModel() {
  const queryClient = useQueryClient();
  return useMutation<
    ProbeModelResult,
    ApiErrorShape,
    { providerId: string; request: ProbeModelRequest }
  >({
    mutationFn: ({ providerId, request }) =>
      consoleRequest<ProbeModelResult>(
        `/providers/${encodeURIComponent(providerId)}/models/probe`,
        {
          method: "POST",
          body: JSON.stringify(request),
        },
      ),
    // A probe now writes account health (cooldown on quota failure, recover
    // on success), so the account list + health panels must refetch the
    // moment it settles — success AND failure — instead of waiting for a
    // manual page refresh.
    onSettled: async (_result, _error, variables) => {
      await invalidateProviderAccounts(queryClient, variables.providerId);
    },
  });
}
/**
 * Ad-hoc connectivity test for an operator-entered custom provider that has
 * not been saved yet. Probes `GET <base>/models` with the credential header
 * the chosen wire family reads, so the modal can validate the base URL and API
 * key before persisting anything. No cache invalidation: nothing is created.
 */
export function useTestByokConnection() {
  return useMutation<ByokConnectionTestResult, ApiErrorShape, ByokConnectionTestRequest>({
    mutationFn: (request) =>
      consoleRequest<ByokConnectionTestResult>("/providers/connection-test", {
        method: "POST",
        body: JSON.stringify(request),
      }),
  });
}

/** Probes one explicit model against every configured account for a provider. */
export function useProbeAllProviderAccounts() {
  const queryClient = useQueryClient();
  return useMutation<
    ProbeAllAccountsResult,
    ApiErrorShape,
    { providerId: string; request: ProbeModelRequest }
  >({
    mutationFn: ({ providerId, request }) =>
      consoleRequest<ProbeAllAccountsResult>(
        `/providers/${encodeURIComponent(providerId)}/accounts/probe`,
        { method: "POST", body: JSON.stringify(request) },
      ),
    onSettled: async (_result, _error, variables) => {
      await invalidateProviderAccounts(queryClient, variables.providerId);
    },
  });
}

/** Enables or disables one registered model — a hard routing invariant, not a display flag. */
export function useSetModelEnabled() {
  const queryClient = useQueryClient();
  return useMutation<
    { success: boolean },
    ApiErrorShape,
    { providerId: string; request: SetModelEnabledRequest }
  >({
    mutationFn: ({ providerId, request }) =>
      consoleRequest<{ success: boolean }>(`/providers/${encodeURIComponent(providerId)}/models`, {
        method: "PATCH",
        body: JSON.stringify(request),
      }),
    onSuccess: async (_result, variables) => {
      await queryClient.invalidateQueries({
        queryKey: queryKeys.providers.models(variables.providerId),
      });
    },
  });
}
/**
 * Edits one model's limits and capability flags.
 *
 * Rides the same PATCH as the enable toggle: a payload carrying `metadata` is an
 * edit, one without is the toggle. The caller must therefore always send
 * `metadata` here — an accidental omission would toggle the model's enabled
 * flag instead of editing it.
 */
export function useUpdateModelMetadata() {
  const queryClient = useQueryClient();
  return useMutation<
    { success: boolean },
    ApiErrorShape,
    { providerId: string; modelId: string; route: string; metadata: ModelMetadataPayload }
  >({
    mutationFn: ({ providerId, modelId, route, metadata }) =>
      consoleRequest<{ success: boolean }>(`/providers/${encodeURIComponent(providerId)}/models`, {
        method: "PATCH",
        body: JSON.stringify({ modelId, route, enabled: true, metadata }),
      }),
    onSuccess: async (_result, variables) => {
      await queryClient.invalidateQueries({
        queryKey: queryKeys.providers.models(variables.providerId),
      });
      toast.success("Model updated", `${variables.modelId} limits and capabilities saved`);
    },
    onError: (error) => {
      toast.error("Failed to update model", getErrorMessage(error));
    },
  });
}
/** Deletes one registered model from a provider catalog. */
export function useDeleteProviderModel() {
  const queryClient = useQueryClient();
  return useMutation<
    { success: boolean },
    ApiErrorShape,
    { providerId: string; request: { modelId: string; route: string } }
  >({
    mutationFn: ({ providerId, request }) =>
      consoleRequest<{ success: boolean }>(`/providers/${encodeURIComponent(providerId)}/models`, {
        method: "DELETE",
        body: JSON.stringify(request),
      }),
    onSuccess: async (_result, variables) => {
      await queryClient.invalidateQueries({
        queryKey: queryKeys.providers.models(variables.providerId),
      });
    },
  });
}

/**
 * Loads accounts configured for one provider.
 *
 * Health and usage move faster than the catalog, so 30 s freshness — still
 * lazy (cached render first, background revalidate), with account mutations
 * invalidating this key on write.
 */
export function useProviderAccounts(providerId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.providers.accounts(providerId),
    queryFn: (context) =>
      consoleRequest<ProviderAccountResponse[]>(
        `/providers/${encodeURIComponent(providerId ?? "")}/accounts`,
        { signal: querySignal(context) },
      ),
    enabled: Boolean(providerId),
    ...DASHBOARD_QUERY_OPTIONS,
    staleTime: 30_000,
    gcTime: 600_000,
  });
}

/** One day × model usage cell from the provider usage matrix endpoint. */
export interface ProviderUsageDayRow {
  /** UTC day, `YYYY-MM-DD`. */
  readonly day: string;
  readonly model: string | null;
  readonly requests: number;
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
}

export interface ProviderUsageMatrixResponse {
  readonly days: number;
  readonly rows: readonly ProviderUsageDayRow[];
}

/**
 * Normalizes the matrix response defensively: the endpoint aggregates over SQL
 * values that can arrive as strings (`numeric`/bigint), and a hostile payload
 * must never reach the calendar as `NaN`.
 */
function assertUsageMatrix(raw: unknown): ProviderUsageMatrixResponse {
  const shape = raw as {
    days?: unknown;
    rows?: readonly {
      day?: unknown;
      model?: unknown;
      requests?: unknown;
      inputTokens?: unknown;
      cachedInputTokens?: unknown;
      outputTokens?: unknown;
      costUsd?: unknown;
    }[];
  };
  const rows = Array.isArray(shape.rows) ? shape.rows : [];
  const asNumber = (value: unknown): number => {
    const parsed = Number(value ?? 0);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  return {
    days: Math.max(1, Math.trunc(asNumber(shape.days)) || 30),
    rows: rows.map((row) => ({
      day: typeof row.day === "string" ? row.day : "",
      model: typeof row.model === "string" ? row.model : null,
      requests: asNumber(row.requests),
      inputTokens: asNumber(row.inputTokens),
      cachedInputTokens: asNumber(row.cachedInputTokens),
      outputTokens: asNumber(row.outputTokens),
      costUsd: asNumber(row.costUsd),
    })),
  };
}

/**
 * Day × model usage for the provider Activity Matrix.
 *
 * Deliberately lazy-friendly: pass `enabled: false` until the card is
 * expanded, so a provider the operator only brands on never costs an
 * aggregate scan. The matrix barely changes within a minute, so a 60 s
 * freshness window covers repeated expand/collapse toggles.
 */
export function useProviderUsageMatrix(
  providerId: string | undefined,
  enabled: boolean,
): ReturnType<typeof useQuery<ProviderUsageMatrixResponse>> {
  return useQuery({
    queryKey: queryKeys.providers.usageMatrix(providerId),
    queryFn: (context) => {
      if (!providerId) throw { status: 400, code: "invalid_request", message: "Provider is required" } satisfies ApiErrorShape;
      return consoleRequest<unknown>(
        `/providers/${encodeURIComponent(providerId)}/usage/matrix`,
        { signal: querySignal(context) },
      ).then(assertUsageMatrix);
    },
    ...DASHBOARD_QUERY_OPTIONS,
    enabled: Boolean(providerId) && enabled,
  });
}

/** Creates a provider account. */
export function useCreateProviderAccount() {
  const queryClient = useQueryClient();
  return useMutation<
    ProviderAccountResponse,
    ApiErrorShape,
    { providerId: string; request: CreateProviderAccountRequest }
  >({
    mutationFn: ({ providerId, request }) =>
      consoleRequest<ProviderAccountResponse>(
        `/providers/${encodeURIComponent(providerId)}/accounts`,
        { method: "POST", body: JSON.stringify(request) },
      ),
    onSuccess: async (_result, variables) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.providers.accounts(variables.providerId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.providers.all }),
      ]);
    },
  });
}

/**
 * Creates many accounts in one request.
 *
 * The server returns a per-item outcome, so a partial paste still lands the
 * accounts that were fine. Invalidation happens once, after the whole batch —
 * invalidating per account would re-fetch the account list once per row in a
 * large paste.
 */
export function useCreateProviderAccountsBatch() {
  const queryClient = useQueryClient();
  return useMutation<
    CreateProviderAccountBatchResult,
    ApiErrorShape,
    { providerId: string; accounts: readonly CreateProviderAccountRequest[] }
  >({
    mutationFn: ({ providerId, accounts }) =>
      consoleRequest<CreateProviderAccountBatchResult>(
        `/providers/${encodeURIComponent(providerId)}/accounts/batch`,
        { method: "POST", body: JSON.stringify({ accounts }) },
      ),
    onSuccess: async (_result, variables) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.providers.accounts(variables.providerId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.providers.all }),
      ]);
    },
  });
}

/** Updates a provider account. */
export function useUpdateProviderAccount() {
  const queryClient = useQueryClient();
  return useMutation<
    ProviderAccountResponse,
    ApiErrorShape,
    { providerId: string; accountId: string; request: UpdateProviderAccountRequest }
  >({
    mutationFn: ({ providerId, accountId, request }) =>
      consoleRequest<ProviderAccountResponse>(
        `/providers/${encodeURIComponent(providerId)}/accounts/${encodeURIComponent(accountId)}`,
        { method: "PATCH", body: JSON.stringify(request) },
      ),
    onSuccess: async (_result, variables) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.providers.accounts(variables.providerId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.providers.all }),
      ]);
    },
  });
}

/** Loads health transition event history for one account. */
export function useAccountHealthEvents(
  providerId: string | undefined,
  accountId: string | undefined,
) {
  return useQuery({
    queryKey: queryKeys.providers.healthEvents(providerId, accountId),
    queryFn: (context) =>
      consoleRequest<AccountHealthEventRecord[]>(
        `/providers/${encodeURIComponent(providerId ?? "")}/accounts/${encodeURIComponent(accountId ?? "")}/health-events`,
        { signal: querySignal(context) },
      ),
    enabled: Boolean(providerId) && Boolean(accountId),
    ...DASHBOARD_QUERY_OPTIONS,
    refetchInterval: POLL.status,
  });
}

/**
 * Invalidates every cached account health-event query for one provider.
 * OAuth completion and device-poll success mint or revive accounts outside
 * the account list, so the health-event family must refresh alongside it.
 */
async function invalidateAccountHealthFamily(
  queryClient: QueryClient,
  providerId: string,
): Promise<void> {
  await queryClient.invalidateQueries({
    predicate: (query) => {
      const key = query.queryKey;
      return (
        key[0] === "console" &&
        key[1] === "providers" &&
        key[2] === providerId &&
        key[3] === "accounts" &&
        key[5] === "health-events"
      );
    },
  });
}

/**
 * Invalidates every cached query a provider-account mutation can stale: the
 * account list, the health-event family, and the provider list itself. Every
 * account mutation goes through this one helper, so none can silently forget
 * one of the three and leave a stale list on screen.
 */
async function invalidateProviderAccounts(
  queryClient: QueryClient,
  providerId: string,
): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: queryKeys.providers.accounts(providerId) }),
    invalidateAccountHealthFamily(queryClient, providerId),
    queryClient.invalidateQueries({ queryKey: queryKeys.providers.all }),
  ]);
}

/** Manually recovers an account from cooldown back to active. */
export function useRecoverAccount() {
  const queryClient = useQueryClient();
  return useMutation<
    { success: boolean },
    ApiErrorShape,
    { providerId: string; accountId: string }
  >({
    mutationFn: ({ providerId, accountId }) =>
      consoleRequest<{ success: boolean }>(
        `/providers/${encodeURIComponent(providerId)}/accounts/${encodeURIComponent(accountId)}/recover`,
        { method: "POST", body: "{}" },
      ),
    onSuccess: async (_result, variables) => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: queryKeys.providers.accounts(variables.providerId),
        }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.providers.healthEvents(variables.providerId, variables.accountId),
        }),
        queryClient.invalidateQueries({ queryKey: queryKeys.providers.all }),
      ]);
      toast.success("Account recovered");
    },
    onError: (error) => {
      toast.error("Could not recover the account.", getErrorMessage(error));
    },
  });
}

/**
 * Deletes one account's health & error log, from its own modal.
 *
 * The modal refetches on completion rather than waiting for the poll: rows the
 * operator just told to leave must not survive one visible cycle. The settings
 * disk-usage count invalidates too, so the management row stays honest about
 * how many rows the global purge still holds.
 */
export function usePurgeAccountHealthEvents() {
  const queryClient = useQueryClient();
  return useMutation<
    { deleted: number },
    ApiErrorShape,
    { providerId: string; accountId: string; title?: string }
  >({
    mutationFn: ({ providerId, accountId }) =>
      consoleRequest<{ deleted: number }>(
        `/providers/${encodeURIComponent(providerId)}/accounts/${encodeURIComponent(accountId)}/health-events`,
        { method: "DELETE" },
      ),
    onSuccess: async (result, variables) => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: queryKeys.providers.healthEvents(variables.providerId, variables.accountId),
        }),
        queryClient.invalidateQueries({ queryKey: queryKeys.settings.diskUsage }),
      ]);
      toast.success(
        result.deleted === 0 ? "Health log was already empty" : `Purged ${result.deleted} health events`,
        variables.title,
      );
    },
    onError: (error) => {
      toast.error("Could not purge the health log.", getErrorMessage(error));
    },
  });
}

/**
 * Exports the selected accounts (with decrypted credentials) for one provider.
 * Returns the raw export body so the caller owns the download step; a mutation
 * (not a query) because the payload carries plaintext secrets and must never be
 * cached or auto-refetched.
 */
export function useExportProviderAccounts() {
  return useMutation<
    ProviderAccountsExportResponse,
    ApiErrorShape,
    { providerId: string; accountIds: string[] }
  >({
    mutationFn: ({ providerId, accountIds }) =>
      consoleRequest<ProviderAccountsExportResponse>(
        `/providers/${encodeURIComponent(providerId)}/accounts/export`,
        { method: "POST", body: JSON.stringify({ accountIds }) },
      ),
  });
}


export interface OAuthAuthorizeResult {
  readonly authorizeUrl: string;
  readonly state: string;
}

/** Begins the browser OAuth login flow for a provider account; caller opens `authorizeUrl` in a popup. */
export function useStartOAuthAuthorize() {
  return useMutation<
    OAuthAuthorizeResult,
    ApiErrorShape,
    { providerId: string; accountLabel?: string; parameters?: Record<string, string> }
  >({
    mutationFn: ({ providerId, accountLabel, parameters }) =>
      consoleRequest<OAuthAuthorizeResult>(
        `/providers/${encodeURIComponent(providerId)}/oauth/authorize`,
        {
          method: "POST",
          body: JSON.stringify({
            ...(accountLabel ? { accountLabel } : {}),
            ...(parameters && Object.keys(parameters).length > 0 ? { parameters } : {}),
          }),
        },
      ),
  });
}

/**
 * Completes a browser OAuth login using a `code` copied by hand from the
 * provider's redirect URL.
 *
 * The fallback, not the normal path: the server binds the loopback port the
 * redirect names, so the callback usually completes on its own and the dialog
 * detects it by polling the account list. This exists for the redirects the
 * server cannot bind — a custom scheme handed to an installed app, or a
 * provider that sends the code to a remote host — where the operator pastes the
 * URL back. The code/state pair round-trips through the same server-side
 * callback route the automatic redirect uses.
 */
export function useCompleteOAuthBrowserLogin() {
  const queryClient = useQueryClient();
  return useMutation<
    { message?: string },
    ApiErrorShape,
    { providerId: string; code: string; state: string }
  >({
    mutationFn: ({ providerId, code, state }) =>
      consoleRequest<{ message?: string; providerId?: string }>(
        `/providers/${encodeURIComponent(providerId)}/oauth/callback?${new URLSearchParams({ code, state }).toString()}`,
      ),
    onSuccess: async (_result, variables) => {
      await invalidateProviderAccounts(queryClient, variables.providerId);
    },
  });
}

export interface OAuthDeviceStartResult {
  readonly verificationUri: string;
  readonly userCode: string;
  readonly deviceAuthId: string;
  readonly intervalSeconds: number;
  readonly expiresInSeconds: number;
}

/** Begins the device-code OAuth login flow for providers that support it. */
export function useStartOAuthDevice() {
  return useMutation<
    OAuthDeviceStartResult,
    ApiErrorShape,
    { providerId: string; accountLabel?: string; parameters?: Record<string, string> }
  >({
    mutationFn: ({ providerId, accountLabel, parameters }) =>
      consoleRequest<OAuthDeviceStartResult>(
        `/providers/${encodeURIComponent(providerId)}/oauth/device/start`,
        {
          method: "POST",
          body: JSON.stringify({
            ...(accountLabel ? { accountLabel } : {}),
            ...(parameters && Object.keys(parameters).length > 0 ? { parameters } : {}),
          }),
        },
      ),
  });
}

/**
 * Completes a login from credential material the operator already holds.
 *
 * The server validates the material against the provider before persisting it,
 * so a failed import surfaces the upstream's own reason and leaves no account
 * behind — there is nothing to roll back in the dashboard.
 */
export function useImportOAuthCredential() {
  const queryClient = useQueryClient();
  return useMutation<
    { accountId: string },
    ApiErrorShape,
    { providerId: string; credential: string; fields?: Record<string, string>; accountLabel?: string }
  >({
    mutationFn: ({ providerId, credential, fields, accountLabel }) =>
      consoleRequest<{ accountId: string }>(
        `/providers/${encodeURIComponent(providerId)}/oauth/import`,
        {
          method: "POST",
          body: JSON.stringify({
            credential,
            ...(fields && Object.keys(fields).length > 0 ? { fields } : {}),
            ...(accountLabel ? { accountLabel } : {}),
          }),
        },
      ),
    onSuccess: async (_result, variables) => {
      await invalidateProviderAccounts(queryClient, variables.providerId);
      await queryClient.invalidateQueries({ queryKey: queryKeys.quota.all });
    },
  });
}

export type { OAuthDevicePollResult };

/** Polls one device-code authorization attempt; invalidates accounts once complete. */
export function usePollOAuthDevice() {
  const queryClient = useQueryClient();
  return useMutation<
    OAuthDevicePollResult,
    ApiErrorShape,
    { providerId: string; deviceAuthId: string }
  >({
    mutationFn: ({ providerId, deviceAuthId }) =>
      consoleRequest<OAuthDevicePollResult>(
        `/providers/${encodeURIComponent(providerId)}/oauth/device/poll`,
        { method: "POST", body: JSON.stringify({ deviceAuthId }) },
      ),
    onSuccess: async (result, variables) => {
      if (result.status === "complete") {
        await Promise.all([
          queryClient.invalidateQueries({
            queryKey: queryKeys.providers.accounts(variables.providerId),
          }),
          queryClient.invalidateQueries({
            queryKey: queryKeys.providers.healthEvents(variables.providerId, result.accountId),
          }),
          // A new OAuth account changes the provider row (accountCount) and
          // gains quota rows immediately; keep both trees fresh so the
          // Providers table and Quota panel reflect the completed exchange.
          queryClient.invalidateQueries({ queryKey: queryKeys.quota.all }),
          // Shares the cluster's three keys with every other account mutation,
          // plus the one extra tree this path needs (the quota panel).
          invalidateProviderAccounts(queryClient, variables.providerId),
        ]);
      }
    },
  });
}

/** Creates a custom provider and refreshes all provider-derived views. */
export function useCreateProvider() {
  const queryClient = useQueryClient();
  return useMutation<ProviderResponse, ApiErrorShape, CreateProviderRequest>({
    mutationFn: (request) =>
      consoleRequest<ProviderResponse>("/providers", {
        method: "POST",
        body: JSON.stringify(request),
      }),
    onSuccess: async (result) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.providers.all }),
        queryClient.invalidateQueries({ queryKey: queryKeys.modelRouting.all }),
      ]);
      toast.success("Provider created", result.label ?? result.providerId);
    },
    onError: (error) => {
      toast.error("Failed to create provider", getErrorMessage(error));
    },
  });
}

export function useUpdateProvider() {
  const queryClient = useQueryClient();
  return useMutation<
    ProviderResponse,
    ApiErrorShape,
    { providerId: string; request: UpdateProviderRequest }
  >({
    mutationFn: ({ providerId, request }) =>
      consoleRequest<ProviderResponse>(`/providers/${encodeURIComponent(providerId)}`, {
        method: "PATCH",
        body: JSON.stringify(request),
      }),
    onSuccess: async (_result, { providerId }) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.providers.all }),
        queryClient.invalidateQueries({ queryKey: queryKeys.providers.detail(providerId) }),
      ]);
      toast.success("Provider updated", providerId);
    },
    onError: (error) => {
      toast.error("Failed to update provider", getErrorMessage(error));
    },
  });
}

/** Enables or disables a global builtin provider for platform administrators. */
export function useUpdateGlobalProvider() {
  const queryClient = useQueryClient();
  return useMutation<
    ProviderResponse,
    ApiErrorShape,
    { providerId: string; enabled: boolean }
  >({
    mutationFn: ({ providerId, enabled }) =>
      consoleRequest<ProviderResponse>(
        `/providers/platform/global/${encodeURIComponent(providerId)}`,
        {
          method: "PATCH",
          body: JSON.stringify({ enabled }),
        },
      ),
    onSuccess: async (_result, { providerId }) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.providers.all }),
        queryClient.invalidateQueries({ queryKey: queryKeys.providers.detail(providerId) }),
      ]);
    },
  });
}

/** Synchronizes one provider's model catalog when the session has platform admin scope. */
export function useSyncProviderModels(options: { readonly silent?: boolean } = {}) {
  const queryClient = useQueryClient();
  return useMutation<{ synced: number }, ApiErrorShape, string>({
    mutationFn: (providerId) =>
      consoleRequest<{ synced: number }>(
        `/providers/${encodeURIComponent(providerId)}/models/sync`,
        { method: "POST", body: "{}" },
      ),
    // The request resolves only once the fetch has finished, so this toast
    // reports the real outcome. Automatic free-tier syncs suppress the toast
    // but still invalidate the model query with the same result.
    onSuccess: async (result, providerId) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.providers.models(providerId) });
      if (!options.silent) {
        toast.success(
          "Models fetched",
          result.synced > 0
            ? `${result.synced} new model${result.synced === 1 ? "" : "s"} added`
            : "No new models found",
        );
      }
    },
    onError: (error) => {
      if (!options.silent) toast.error("Failed to fetch models", getErrorMessage(error));
    },
  });
}

/** Deletes a provider (custom only). */
export function useDeleteProvider() {
  const queryClient = useQueryClient();
  return useMutation<{ success: boolean }, ApiErrorShape, string>({
    mutationFn: (providerId) =>
      consoleRequest<{ success: boolean }>(`/providers/${encodeURIComponent(providerId)}`, {
        method: "DELETE",
      }),
    onSuccess: async (_result, providerId) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.providers.all }),
        queryClient.invalidateQueries({ queryKey: queryKeys.quota.all }),
        queryClient.invalidateQueries({ queryKey: queryKeys.modelRouting.all }),
      ]);
      toast.success("Provider deleted", providerId);
    },
    onError: (error) => {
      toast.error("Failed to delete provider", getErrorMessage(error));
    },
  });
}