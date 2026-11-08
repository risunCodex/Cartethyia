import { consoleRequest } from "../data/api";
import type { ApiErrorShape } from "../data/api";
import type {
  PromptMode,
  PromptSetting,
  TenantSystemPrompts,
} from "../data/contracts";
import { queryKeys } from "../data/query-keys";
import { querySignal } from "../data/assert";
import { CACHE, DASHBOARD_QUERY_OPTIONS } from "../data/query-policy";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

/** Loads the tenant's system-prompt injection configuration. */
export function useSystemPrompt() {
  return useQuery<TenantSystemPrompts, ApiErrorShape>({
    queryKey: queryKeys.systemPrompt.config,
    queryFn: (context) =>
      consoleRequest<TenantSystemPrompts>("/system-prompt", { signal: querySignal(context) }),
    ...DASHBOARD_QUERY_OPTIONS,
    staleTime: CACHE.effectivelyImmutable,
  });
}

/** Replaces the tenant's system-prompt injection configuration. */
export function useUpdateSystemPrompt() {
  const queryClient = useQueryClient();
  return useMutation<TenantSystemPrompts, ApiErrorShape, TenantSystemPrompts>({
    mutationFn: (next) =>
      consoleRequest<TenantSystemPrompts>("/system-prompt", {
        method: "PUT",
        body: JSON.stringify(next),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.systemPrompt.config });
    },
  });
}

/** Clears the tenant's system-prompt injection configuration. */
export function useClearSystemPrompt() {
  const queryClient = useQueryClient();
  return useMutation<TenantSystemPrompts, ApiErrorShape, void>({
    mutationFn: () =>
      consoleRequest<TenantSystemPrompts>("/system-prompt", { method: "DELETE" }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.systemPrompt.config });
    },
  });
}

export type { PromptMode, PromptSetting, TenantSystemPrompts };
