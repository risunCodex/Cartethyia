import { useEffect, useState } from "react";
import { useProviderRouting, useUpdateProviderRouting } from "./routing";
import { useDebouncedSave } from "./use-debounced-save";
import type { ProviderRoutingResponse } from "../data/contracts";

export type RoutingStrategy = ProviderRoutingResponse["strategy"];

export const ROUTING_ACTIVE_LABEL = {
  fallback: "Failover",
  roundRobin: "Round robin",
} as const;

// Providers known to not reliably support plain HTTP/S proxying — routing
// for these defaults to skipProxy on the backend. Dashboard copy of the
// backend `DEFAULT_PROXY_SKIP_PROVIDER_IDS` (`src/providers/provider-metadata.ts`).
// Intentionally duplicated, not imported: importing the backend value would
// bundle the backend module graph (Elysia + `node:crypto`) into the browser
// build and break Vite dev with "Module node:crypto has been externalized".
// Same precedent as the dashboard `isRecord` copy in `lib/api.ts`.
// This set only decides whether the UI shows an explanatory tip; the backend
// constant is what actually enforces the default. Keep in sync.
export const PROXY_SKIP_HINT_PROVIDERS: ReadonlySet<string> = new Set([
  "inferhub",
  "cline",
]);

export interface RoutingStrategyState {
  readonly strategy: RoutingStrategy;
  readonly roundRobinEnabled: boolean;
  readonly setRoundRobinEnabled: (next: boolean) => void;
  readonly rotateCount: number;
  readonly setRotateCount: (next: number) => void;
  readonly maxInflight: number | null;
  /** Per-pool ceiling for this provider; `null` = unlimited. */
  readonly maxInflightPerProxy: number | null;
  readonly usageFloor: number | null;
  readonly usageFloorUnit: "credit" | "percent";
  readonly setUsageFloor: (floor: number | null, unit: "credit" | "percent") => void;
  readonly skipProxy: boolean;
  readonly setSkipProxy: (next: boolean) => void;
  /** Device-code OAuth egress: `random` (default) or `direct`. */
  readonly deviceFlowProxy: "random" | "direct";
  readonly setDeviceFlowProxy: (next: "random" | "direct") => void;
  readonly userAgent: string;
  readonly setUserAgent: (next: string) => void;
  /** Operator-set custom User-Agent override; `null` = no override (native identity). */
  readonly customUserAgent: string | null;
  readonly setCustomUserAgent: (next: string | null) => void;
  readonly isLoading: boolean;
  readonly isError: boolean;
  readonly isSaving: boolean;
  readonly saveFailed: boolean;
  readonly refetch: () => void;
  readonly setMaxInflight: (next: number | null) => void;
  readonly setMaxInflightPerProxy: (next: number | null) => void;
  readonly setSkipProxy: (next: boolean) => void;
  readonly setDeviceFlowProxy: (next: "random" | "direct") => void;
}

export function useRoutingStrategy(providerId: string, allowUserAgent: boolean): RoutingStrategyState {
  const query = useProviderRouting(providerId);
  const mutation = useUpdateProviderRouting();
  const [strategy, setStrategyState] = useState<RoutingStrategy>("fallback");
  const [rotateCount, setRotateCountState] = useState(1);
  const [maxInflight, setMaxInflightState] = useState<number | null>(null);
  const [maxInflightPerProxy, setMaxInflightPerProxyState] = useState<number | null>(null);
  const [usageFloor, setUsageFloorState] = useState<number | null>(null);
  const [usageFloorUnit, setUsageFloorUnitState] = useState<"credit" | "percent">("percent");
  const [skipProxy, setSkipProxyState] = useState(false);
  const [deviceFlowProxy, setDeviceFlowProxyState] = useState<"random" | "direct">("random");
  // Placeholder until the fetched row lands; the backend default is the Claude
  // Code CLI identity (see `buildClaudeCliUserAgent`). Hard-coding it here
  // would make the card show one identity and save another if the server ever
  // answered with a different one.
  const [userAgent, setUserAgentState] = useState("");
  // Operator-set custom User-Agent override; `null` = native identity.
  const [customUserAgent, setCustomUserAgentState] = useState<string | null>(null);

  useEffect(() => {
    if (!query.data) return;
    setStrategyState(query.data.strategy);
    setRotateCountState(query.data.rotateCount);
    setMaxInflightState(query.data.maxInflight);
    setMaxInflightPerProxyState(query.data.maxInflightPerProxy ?? null);
    setUsageFloorState(query.data.usageFloor);
    setUsageFloorUnitState(query.data.usageFloorUnit);
    setSkipProxyState(query.data.skipProxy);
    setDeviceFlowProxyState(query.data.deviceFlowProxy ?? "random");
    setUserAgentState(query.data.userAgent);
    setCustomUserAgentState(query.data.customUserAgent ?? null);
  }, [query.data]);

  const save = (next: {
    strategy: RoutingStrategy;
    rotateCount: number;
    maxInflight: number | null;
    maxInflightPerProxy: number | null;
    usageFloor: number | null;
    usageFloorUnit: "credit" | "percent";
    skipProxy: boolean;
    deviceFlowProxy: "random" | "direct";
    userAgent: string;
    customUserAgent: string | null;
  }) => {
    mutation.mutate(
      {
        providerId,
        request: {
          enabled: true,
          strategy: next.strategy,
          rotateCount: next.rotateCount,
          maxInflight: next.maxInflight,
          maxInflightPerProxy: next.maxInflightPerProxy,
          usageFloor: next.usageFloor,
          usageFloorUnit: next.usageFloorUnit,
          skipProxy: next.skipProxy,
          deviceFlowProxy: next.deviceFlowProxy,
          ...(allowUserAgent ? { userAgent: next.userAgent } : {}),
          customUserAgent: next.customUserAgent,
        },
      },
      {
        onError: () => {
          if (!query.data) return;
          setStrategyState(query.data.strategy);
          setRotateCountState(query.data.rotateCount);
          setMaxInflightState(query.data.maxInflight);
          setMaxInflightPerProxyState(query.data.maxInflightPerProxy ?? null);
          setUsageFloorState(query.data.usageFloor);
          setUsageFloorUnitState(query.data.usageFloorUnit);
          setSkipProxyState(query.data.skipProxy);
          setDeviceFlowProxyState(query.data.deviceFlowProxy ?? "random");
          setUserAgentState(query.data.userAgent);
          setCustomUserAgentState(query.data.customUserAgent ?? null);
        },
      },
    );
  };
  const scheduleMaxInflightSave = useDebouncedSave((next: number | null) =>
    save({
      strategy,
      rotateCount,
      maxInflight: next,
      maxInflightPerProxy,
      usageFloor,
      usageFloorUnit,
      skipProxy,
      deviceFlowProxy,
      userAgent,
      customUserAgent,
    }),
  );
  const scheduleMaxInflightPerProxySave = useDebouncedSave((next: number | null) =>
    save({
      strategy,
      rotateCount,
      maxInflight,
      maxInflightPerProxy: next,
      usageFloor,
      usageFloorUnit,
      skipProxy,
      deviceFlowProxy,
      userAgent,
      customUserAgent,
    }),
  );
  const scheduleRotateCountSave = useDebouncedSave((next: number) =>
    save({
      strategy,
      rotateCount: next,
      maxInflight,
      maxInflightPerProxy,
      usageFloor,
      usageFloorUnit,
      skipProxy,
      deviceFlowProxy,
      userAgent,
      customUserAgent,
    }),
  );
  const scheduleUserAgentSave = useDebouncedSave((next: string) =>
    save({
      strategy,
      rotateCount,
      maxInflight,
      maxInflightPerProxy,
      usageFloor,
      usageFloorUnit,
      skipProxy,
      userAgent: next,
      customUserAgent,
    }),
  );
  const scheduleCustomUserAgentSave = useDebouncedSave((next: string | null) =>
    save({
      strategy,
      rotateCount,
      maxInflight,
      maxInflightPerProxy,
      usageFloor,
      usageFloorUnit,
      skipProxy,
      deviceFlowProxy,
      userAgent,
      customUserAgent: next,
    }),
  );

  return {
    strategy,
    maxInflight,
    maxInflightPerProxy,
    usageFloor,
    usageFloorUnit,
    setUsageFloor: (floor, unit) => {
      setUsageFloorState(floor);
      setUsageFloorUnitState(unit);
      save({ strategy, rotateCount, maxInflight, maxInflightPerProxy, usageFloor: floor, usageFloorUnit: unit, skipProxy, deviceFlowProxy, userAgent, customUserAgent });
    },
    skipProxy,
    deviceFlowProxy,
    setDeviceFlowProxy: (next) => {
      setDeviceFlowProxyState(next);
      save({
        strategy,
        rotateCount,
        maxInflight,
        maxInflightPerProxy,
        usageFloor,
        usageFloorUnit,
        skipProxy,
        deviceFlowProxy: next,
        userAgent,
        customUserAgent,
      });
    },
    userAgent,
    customUserAgent,
    isLoading: query.isPending,
    isError: query.isError,
    isSaving: mutation.isPending,
    saveFailed: mutation.isError,
    refetch: () => query.refetch(),
    setMaxInflight: (next) => {
      setMaxInflightState(next);
      scheduleMaxInflightSave(next);
    },
    setMaxInflightPerProxy: (next) => {
      setMaxInflightPerProxyState(next);
      scheduleMaxInflightPerProxySave(next);
    },
    setUserAgent: (next) => {
      setUserAgentState(next);
      scheduleUserAgentSave(next);
    },
    setCustomUserAgent: (next) => {
      setCustomUserAgentState(next);
      scheduleCustomUserAgentSave(next);
    },
    setSkipProxy: (next) => {
      setSkipProxyState(next);
      save({
        strategy,
        rotateCount,
        maxInflight,
        maxInflightPerProxy,
        usageFloor,
        usageFloorUnit,
        skipProxy: next,
        deviceFlowProxy,
        userAgent,
        customUserAgent,
      });
    },
    roundRobinEnabled: strategy === "round_robin",
    setRoundRobinEnabled: (next) => {
      const resolved: RoutingStrategy = next ? "round_robin" : "fallback";
      setStrategyState(resolved);
      save({
        strategy: resolved,
        rotateCount,
        maxInflight,
        maxInflightPerProxy,
        usageFloor,
        usageFloorUnit,
        skipProxy,
        deviceFlowProxy,
        userAgent,
        customUserAgent,
      });
    },
    rotateCount,
    setRotateCount: (next) => {
      setRotateCountState(next);
      scheduleRotateCountSave(next);
    },
  };
}
