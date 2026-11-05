import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { consoleRequest } from "../data/api";
import { querySignal } from "../data/assert";
import { queryKeys } from "../data/query-keys";
import type { ApiErrorShape } from "../data/api";

/** One active IP ban as the console returns it. */
export interface IpBanResponse {
  readonly ip: string;
  readonly bannedUntil: string | null;
  readonly manual: boolean;
}

/** Loads the active IP bans. */
export function useIpBans() {
  return useQuery({
    queryKey: queryKeys.ipBans.all,
    queryFn: (context) =>
      consoleRequest<IpBanResponse[]>("/ip-bans", { signal: querySignal(context) }),
  });
}

/** Bans an IP address by hand. */
export function useBanIp() {
  const queryClient = useQueryClient();
  return useMutation<{ ip: string; bannedUntil: string | null }, ApiErrorShape, { ip: string; minutes?: number | null }>({
    mutationFn: ({ ip, minutes }) =>
      consoleRequest<{ ip: string; bannedUntil: string | null }>("/ip-bans", {
        method: "POST",
        body: JSON.stringify({
          ip,
          ...(minutes === undefined ? {} : { minutes }),
        }),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.ipBans.all });
    },
  });
}

/** Lifts an IP ban. */
export function useUnbanIp() {
  const queryClient = useQueryClient();
  return useMutation<{ success: true }, ApiErrorShape, { ip: string }>({
    mutationFn: ({ ip }) =>
      consoleRequest<{ success: true }>(`/ip-bans/${encodeURIComponent(ip)}`, {
        method: "DELETE",
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.ipBans.all });
    },
  });
}
