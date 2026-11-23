import { consoleRequest } from "../data/api";
import type { ApiErrorShape } from "../data/api";
import type { TrayStatusResponse, TrayVisibilityAction } from "../data/contracts";
import { queryKeys } from "../data/query-keys";
import { querySignal } from "../data/assert";
import { DASHBOARD_QUERY_OPTIONS, POLL } from "../data/query-policy";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

/**
 * The tray icon's visibility on this machine.
 *
 * Tray state changes outside this panel — the tray menu's own `Hide icon` row,
 * `carte tray hide`, or the tray exiting — so this re-reads on the status
 * cadence instead of trusting a cache. It is one small file read behind the
 * route, so the poll costs nothing worth saving.
 */
export function useTrayStatus() {
  return useQuery<TrayStatusResponse, ApiErrorShape>({
    queryKey: queryKeys.tray.status,
    queryFn: (context) =>
      consoleRequest<TrayStatusResponse>("/tray/status", {
        signal: querySignal(context),
      }),
    ...DASHBOARD_QUERY_OPTIONS,
    staleTime: POLL.status,
  });
}

/**
 * Hides or restores the icon.
 *
 * The route answers only after the tray confirmed the change, so a resolved
 * mutation means the icon really moved — which is what makes the toast honest.
 * On success the status is refetched rather than patched, because the tray's
 * own record is the authority on what it is showing.
 */
export function useSetTrayVisibility() {
  const queryClient = useQueryClient();
  return useMutation<TrayStatusResponse, ApiErrorShape, TrayVisibilityAction>({
    mutationFn: (action) =>
      consoleRequest<TrayStatusResponse>("/tray/visibility", {
        method: "POST",
        body: JSON.stringify({ action }),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.tray.status });
    },
  });
}
