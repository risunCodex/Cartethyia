import { consoleRequest } from "../data/api";
import { getErrorMessage } from "../data/api";
import { toast } from "../lib/toast";
import type { ApiErrorShape } from "../data/api";
import type {
  CreateNetworkPoolRequest,
  HealthCheckResult,
  PoolProviderProbeResult,
  PoolBatchProviderProbeResult,
  NetworkPoolResponse,
  PoolBatchProbeResult,
  PoolHealthEvent,
  PoolSpeedTestResult,
  PoolStrategySetting,
  RelayDeployRequest,
  RelayDeployResult,
} from "../data/contracts";
import { queryKeys } from "../data/query-keys";
import { assertNetworkPools, assertPoolStrategy, querySignal } from "../data/assert";
import { DASHBOARD_QUERY_OPTIONS, POLL } from "../data/query-policy";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";


/** Loads the list of network pools for the tenant. */
export function useNetworkPools() {
  return useQuery<NetworkPoolResponse[], ApiErrorShape>({
    queryKey: queryKeys.network.pools,
    queryFn: (context) =>
      consoleRequest<unknown>("/network/pools", { signal: querySignal(context) }).then(
        assertNetworkPools,
      ),
    staleTime: DASHBOARD_QUERY_OPTIONS.staleTime,
    gcTime: DASHBOARD_QUERY_OPTIONS.gcTime,
  });
}

/** Health/error history for one network pool (used by the pool-account view). */
export function usePoolHealthEvents(poolId: string | undefined) {
  return useQuery<PoolHealthEvent[], ApiErrorShape>({
    queryKey: queryKeys.network.poolHealthEvents(poolId ?? ""),
    queryFn: (context) =>
      consoleRequest<PoolHealthEvent[]>(
        `/routing/pools/${encodeURIComponent(poolId ?? "")}/health-events`,
        { signal: querySignal(context) },
      ),
    enabled: poolId !== undefined,
  });
}

/** Runs a provider probe against one pool (used by the pool-account Test action). */
export function usePoolProviderProbe() {
  return useMutation<
    PoolProviderProbeResult,
    ApiErrorShape,
    { poolId: string; providerId: string }
  >({
    mutationFn: ({ poolId, providerId }) =>
      consoleRequest<PoolProviderProbeResult>(
        `/routing/pools/${encodeURIComponent(poolId)}/provider-probe`,
        { method: "POST", body: JSON.stringify({ providerId }) },
      ),
  });
}

/** Creates a network pool and refreshes the pools list. */
export function useCreateNetworkPool() {
  const queryClient = useQueryClient();
  return useMutation<NetworkPoolResponse, ApiErrorShape, CreateNetworkPoolRequest>({
    mutationFn: (request) =>
      consoleRequest<NetworkPoolResponse>("/network/pools", {
        method: "POST",
        body: JSON.stringify(request),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.network.pools });
      toast.success("Proxy pool created");
    },
    onError: (error) => {
      toast.error("Could not create the proxy pool.", getErrorMessage(error));
    },
  });
}

/**
 * Deploys a hosted relay (Cloudflare/Vercel/Deno) and registers its URL as a
 * network pool. The provider API token is sent once and never persisted.
 */
export function useDeployRelay() {
  const queryClient = useQueryClient();
  return useMutation<RelayDeployResult, ApiErrorShape, RelayDeployRequest>({
    mutationFn: (request) =>
      consoleRequest<RelayDeployResult>("/network/pools/relay/deploy", {
        method: "POST",
        body: JSON.stringify(request),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.network.pools });
    },
  });
}
export function useProbeAdHocNetworkPool() {  return useMutation<HealthCheckResult, ApiErrorShape, CreateNetworkPoolRequest>({
    mutationFn: (request) =>
      consoleRequest<HealthCheckResult>("/network/pools/test", {
        method: "POST",
        body: JSON.stringify(request),
      }),
  });
}
/**
 * Probes many unsaved pool definitions in one request.
 *
 * The dashboard tests a pasted list before saving it; one request per proxy
 * made a long paste take minutes. Dialing still happens per target, server-side
 * with bounded concurrency — only the round-trips are batched.
 */
export function useProbeNetworkPoolBatch() {
  return useMutation<
    PoolBatchProbeResult[],
    ApiErrorShape,
    CreateNetworkPoolRequest[]
  >({
    mutationFn: (targets) =>
      consoleRequest<PoolBatchProbeResult[]>("/network/pools/test-batch", {
        method: "POST",
        body: JSON.stringify({ targets }),
      }),
  });
}

/** Updates a network pool through the existing partial-update contract. */
export function useUpdateNetworkPool() {
  const queryClient = useQueryClient();
  return useMutation<
    NetworkPoolResponse,
    ApiErrorShape,
    { poolId: string; request: Partial<CreateNetworkPoolRequest> }
  >({
    mutationFn: ({ poolId, request }) =>
      consoleRequest<NetworkPoolResponse>(`/network/pools/${encodeURIComponent(poolId)}`, {
        method: "PATCH",
        body: JSON.stringify(request),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.network.pools });
      toast.success("Proxy updated");
    },
    onError: (error) => {
      toast.error("Could not update the proxy pool.", getErrorMessage(error));
    },
  });
}

/** Creates the whole paste in one request; the backend inserts every row in a
 * single statement. Returns the created rows in paste order so verdicts can be
 * mapped onto them without a re-test. */
export function useCreateNetworkPoolBatch() {
  const queryClient = useQueryClient();
  return useMutation<
    { created: NetworkPoolResponse[]; failed: number },
    ApiErrorShape,
    CreateNetworkPoolRequest[]
  >({
    mutationFn: (targets) =>
      consoleRequest<{ created: NetworkPoolResponse[]; failed: number }>("/network/pools/bulk/create", {
        method: "POST",
        body: JSON.stringify({ targets }),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.network.pools });
    },
    onError: (error) => {
      toast.error("Could not create the proxy pools.", getErrorMessage(error));
    },
  });
}

/** Deletes many pools in one request. */
export function useDeleteNetworkPoolBatch() {
  const queryClient = useQueryClient();
  return useMutation<{ deleted: number; failed: number }, ApiErrorShape, readonly string[]>({
    mutationFn: (ids) =>
      consoleRequest<{ deleted: number; failed: number }>("/network/pools/bulk/delete", {
        method: "POST",
        body: JSON.stringify({ ids }),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.network.pools });
    },
    onError: (error) => {
      toast.error("Could not delete the proxy pools.", getErrorMessage(error));
    },
  });
}

/** Enables/disables many pools in one request. */
export function useSetNetworkPoolStatusBatch() {
  const queryClient = useQueryClient();
  return useMutation<
    { updated: number },
    ApiErrorShape,
    { ids: readonly string[]; status: "active" | "disabled" }
  >({
    mutationFn: ({ ids, status }) =>
      consoleRequest<{ updated: number }>("/network/pools/bulk/status", {
        method: "POST",
        body: JSON.stringify({ ids, status }),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.network.pools });
    },
    onError: (error) => {
      toast.error("Could not update the proxy pools.", getErrorMessage(error));
    },
  });
}

/** Loads recent health and recovery activity for a pool. */
export function useNetworkPoolHealthEvents(poolId: string | undefined) {
  return useQuery<readonly PoolHealthEvent[], ApiErrorShape>({
    queryKey: [...queryKeys.network.pools, poolId, "health-events"],
    queryFn: (context) =>
      consoleRequest<readonly PoolHealthEvent[]>(
        `/network/pools/${encodeURIComponent(poolId ?? "")}/health-events`,
        { signal: querySignal(context) },
      ),
    enabled: Boolean(poolId),
    ...DASHBOARD_QUERY_OPTIONS,
    refetchInterval: POLL.status,
  });
}

/** Recovers an automatically flagged proxy pool. */
export function useRecoverNetworkPool() {
  const queryClient = useQueryClient();
  return useMutation<{ success: true }, ApiErrorShape, string>({
    mutationFn: (poolId) =>
      consoleRequest<{ success: true }>(`/network/pools/${encodeURIComponent(poolId)}/recover`, {
        method: "POST",
        body: "{}",
      }),
    onSuccess: async (_result, poolId) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.network.pools }),
        queryClient.invalidateQueries({
          queryKey: [...queryKeys.network.pools, poolId, "health-events"],
        }),
      ]);
      toast.success("Proxy pool recovered");
    },
    onError: (error) => {
      toast.error("Could not recover the proxy pool.", getErrorMessage(error));
    },
  });
}

/** Deletes a network pool and refreshes the pools list. */
export function useDeleteNetworkPool() {
  const queryClient = useQueryClient();
  return useMutation<{ success: boolean }, ApiErrorShape, string>({
    mutationFn: (poolId) =>
      consoleRequest<{ success: boolean }>(`/network/pools/${encodeURIComponent(poolId)}`, {
        method: "DELETE",
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.network.pools });
      toast.success("Proxy pool deleted");
    },
    onError: (error) => {
      toast.error("Could not delete the proxy pool.", getErrorMessage(error));
    },
  });
}



/**
 * Asks one provider whether it will serve traffic from a pool.
 *
 * Separate from the health check because the two answer different questions:
 * a health check proves the proxy carries traffic at all, while this proves
 * one provider accepts *this* egress. OpenCode refuses a flagged address on
 * its dispatch route while still serving its public catalog from it, so only
 * this probe can tell an operator the pool is blocked before a user request
 * spends itself finding out.
 */
export function useProviderProbeNetworkPool() {
  const queryClient = useQueryClient();
  return useMutation<
    PoolProviderProbeResult,
    ApiErrorShape,
    { poolId: string; providerId: string }
  >({
    mutationFn: ({ poolId, providerId }) =>
      consoleRequest<PoolProviderProbeResult>(
        `/network/pools/${encodeURIComponent(poolId)}/provider-probe`,
        {
          method: "POST",
          body: JSON.stringify({ providerId }),
        },
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.network.pools });
    },
  });
}

/**
 * Asks one provider about many unsaved proxy endpoints in one call.
 *
 * The add form tests a pasted list before it exists as rows, so there is no
 * pool id to probe. Same bounds as the batch health probe; the dials still run
 * individually with bounded concurrency.
 */
export function useProbeAdHocProviderBatch() {
  return useMutation<
    readonly PoolBatchProviderProbeResult[],
    ApiErrorShape,
    { providerId: string; targets: readonly CreateNetworkPoolRequest[] }
  >({
    mutationFn: ({ providerId, targets }) =>
      consoleRequest<readonly PoolBatchProviderProbeResult[]>(
        "/network/pools/test-batch/provider",
        { method: "POST", body: JSON.stringify({ providerId, targets }) },
      ),
  });
}

/** Triggers a health check for a network pool. */
export function useHealthCheckNetworkPool() {
  const queryClient = useQueryClient();
  return useMutation<HealthCheckResult, ApiErrorShape, string>({
    mutationFn: (poolId) =>
      consoleRequest<HealthCheckResult>(
        `/network/pools/${encodeURIComponent(poolId)}/health-check`,
        { method: "POST", body: "{}" },
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.network.pools });
      toast.success("Health check complete");
    },
    onError: (error) => {
      toast.error("Health check failed.", getErrorMessage(error));
    },
  });
}

/**
 * Measures download throughput through a network pool.
 *
 * Invalidates the pools list on success so the egress address the measurement
 * read reaches the Proxy page's address column. No toast here: the page runs
 * this per selected pool and reports one outcome for the batch, so a toast in
 * the hook would fire once per pool.
 */
export function useSpeedTestNetworkPool() {
  const queryClient = useQueryClient();
  return useMutation<
    PoolSpeedTestResult,
    ApiErrorShape,
    { poolId: string; bytes: number }
  >({
    mutationFn: ({ poolId, bytes }) =>
      consoleRequest<PoolSpeedTestResult>(
        `/network/pools/${encodeURIComponent(poolId)}/speed-test`,
        { method: "POST", body: JSON.stringify({ bytes }) },
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.network.pools });
    },
  });
}

/** Clears provider cooldowns for a network pool (optionally a single provider). */
export function useClearNetworkPoolCooldown() {
  const queryClient = useQueryClient();
  return useMutation<
    { success: boolean },
    ApiErrorShape,
    { poolId: string; providerId?: string }
  >({
    mutationFn: ({ poolId, providerId }) =>
      consoleRequest<{ success: boolean }>(
        `/network/pools/${encodeURIComponent(poolId)}/cooldowns/clear`,
        {
          method: "POST",
          body: JSON.stringify(providerId ? { providerId } : {}),
        },
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.network.pools });
      toast.success("Provider cooldowns cleared");
    },
    onError: (error) => {
      toast.error("Could not clear provider cooldowns.", getErrorMessage(error));
    },
  });
}

/** Loads the tenant's pool-group selection strategy (least_loaded / round_robin). */
export function usePoolStrategy() {
  return useQuery<PoolStrategySetting, ApiErrorShape>({
    queryKey: queryKeys.network.poolStrategy,
    queryFn: (context) =>
      consoleRequest<unknown>("/network/pools/strategy", {
        signal: querySignal(context),
      }).then(assertPoolStrategy),
    staleTime: DASHBOARD_QUERY_OPTIONS.staleTime,
    gcTime: DASHBOARD_QUERY_OPTIONS.gcTime,
  });
}

/** Updates the pool-group selection strategy and refreshes it. */
export function useUpdatePoolStrategy() {
  const queryClient = useQueryClient();
  return useMutation<PoolStrategySetting, ApiErrorShape, Partial<PoolStrategySetting>>({
    mutationFn: (request) =>
      consoleRequest<PoolStrategySetting>("/network/pools/strategy", {
        method: "PATCH",
        body: JSON.stringify(request),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.network.poolStrategy });
    },
    onError: (error) => {
      toast.error("Could not update pool routing", getErrorMessage(error));
    },
  });
}
