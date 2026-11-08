/**
 * InferHub market data hooks.
 *
 * On demand by design: there is **no** `refetchInterval` here, and none should
 * be added. InferHub price and availability are fetched when an operator opens
 * the Providers page or the InferHub detail page, and a manual Refresh button
 * calls `refetch()`. A page nobody opens issues no upstream requests.
 *
 * InferHub is the only provider with a pricing surface: it is the only upstream
 * here that publishes per-ask prices that actually move.
 */
import { useQuery } from "@tanstack/react-query";
import { consoleRequest } from "../data/api";
import type {
  InferhubError,
  InferhubMeta,
  InferhubModel,
  InferhubModelsResponse,
  InferhubSummary,
} from "../data/contracts";
import { queryKeys } from "../data/query-keys";
import { DASHBOARD_QUERY_OPTIONS } from "../data/query-policy";
import { querySignal } from "../data/assert";

function assertSummary(value: unknown): InferhubSummary {
  if (typeof value !== "object" || value === null)
    throw { status: 500, code: "invalid_response", message: "Invalid InferHub summary" };
  const record = value as Record<string, unknown>;
  return {
    models: Array.isArray(record.models) ? (record.models as InferhubModel[]) : [],
    providers: Array.isArray(record.providers) ? (record.providers as InferhubSummary["providers"]) : [],
    pricingConfig: (record.pricingConfig as InferhubSummary["pricingConfig"]) ?? null,
    meta: (record.meta as InferhubMeta) ?? { fetchedAt: 0, ageSeconds: 0, stale: true },
    error: (record.error as InferhubError) ?? null,
  };
}

/**
 * Everything the InferHub card and detail page need, in one request.
 *
 * Mounted once at the Providers page level so a page load costs exactly one
 * call rather than one per card.
 */
export function useInferhubSummary(enabled = true) {
  return useQuery({
    queryKey: queryKeys.inferhub.summary,
    queryFn: (context) =>
      consoleRequest<unknown>("/inferhub/summary", { signal: querySignal(context) }).then(
        assertSummary,
      ),
    enabled,
    ...DASHBOARD_QUERY_OPTIONS,
    // 60 s: a remount or tab focus must not re-fetch data that has not moved.
    staleTime: 60_000,
  });
}

/** One prefix's models, for the detail page table. */
export function useInferhubModels(prefix: string | undefined) {
  return useQuery({
    queryKey: queryKeys.inferhub.models(prefix),
    queryFn: (context) =>
      consoleRequest<unknown>(
        `/inferhub/models${prefix === undefined ? "" : `?prefix=${encodeURIComponent(prefix)}`}`,
        { signal: querySignal(context) },
      ).then((value) => {
        const record = value as Partial<InferhubModelsResponse>;
        return {
          models: Array.isArray(record.models) ? record.models : [],
          meta: record.meta ?? { fetchedAt: 0, ageSeconds: 0, stale: true },
        } satisfies InferhubModelsResponse;
      }),
    enabled: prefix !== undefined,
    ...DASHBOARD_QUERY_OPTIONS,
    staleTime: 60_000,
  });
}
