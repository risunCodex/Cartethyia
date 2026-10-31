// Performance domain: process-wide adapter/catalog load timings, outbound
// latency, and sampled memory, read from the in-process metrics registry.
//
// These figures are process-global rather than tenant-scoped (they describe
// this instance's own module graph and egress), so the route is guarded by
// `platform:admin` like the other instance-level operations.

import { Elysia, type AnyElysia } from "elysia";
import { errorResponse, requireGlobalAdmin } from "../shared/errors";
import { performanceMetricsSnapshot } from "../../observability/performance-metrics";
import type { PerformanceConfig } from "./performance-contracts";

export function createPerformanceRoutes(config: PerformanceConfig): AnyElysia {
  return new Elysia()
    .get("/system/performance", ({ request, set }) => {
      try {
        requireGlobalAdmin(config.accessResolver(request));
        return performanceMetricsSnapshot();
      } catch (e) {
        return errorResponse(e, set, "Performance operation failed");
      }
    });
}
