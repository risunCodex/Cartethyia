/**
 * Memory-headroom shed guard.
 *
 * The per-key, per-tenant, and process concurrency caps bound how many
 * requests run at once, but not how much memory a hundred large contexts
 * together hold. When the box runs out, the kernel OOM-kills the process — and
 * because the SPA is served by the same process, the dashboard dies with it,
 * leaving the operator with no console to see what happened.
 *
 * This refuses a *gateway* request with 503 before it can push the process into
 * the danger zone, so the console and static surfaces keep being served while
 * gateway load is shed. It reuses the concurrency guard's shape: fail with a
 * short retry hint rather than queue, because queueing would convert an
 * overload into unbounded latency.
 *
 * Only `/v1/*` requests are shed. `/`, `/console/*`, `/share/*`, health and
 * metrics are exempt so an operator can always reach the console that explains
 * the shedding.
 */
import { Elysia } from "elysia";
import { GatewayError } from "../../protocol/gateway-error";
import type { RedisClient } from "../../persistence/redis";
import { deriveMemoryHeadroomBytes } from "../../config/resources";
import type { RuntimeMemorySnapshot } from "../../observability/runtime-metrics";
import type { ProxyRequestStateStore } from "../request/state";
import { isProxyRequest } from "./body-policy";

/** How long the shared shed marker outlives the last shed, so peers can see it. */
const SHED_MARKER_TTL_SECONDS = 5;
/** Fleet-visible marker: set on the first shed so every instance reports the same state. */
const SHED_MARKER_KEY = "gateway:shed:v1";
const SHED_RETRY_MS = 1_000;

interface HeadroomGuardDeps {
  readonly store: ProxyRequestStateStore;
  /**
  * The last sampled memory state, published once per sample by
  * `RuntimeMetricsSampler`.
  *
  * Taken from the sampler rather than measured here: this runs on EVERY
  * request, and `process.memoryUsage()` on the request path is a cost paid
  * per request to answer a question that changes over seconds. When absent
  * (before the first sample) the guard falls back to measuring once — an
  * unsampled process is still a process that can be OOM-killed.
  */
  readonly memorySnapshot?: () => RuntimeMemorySnapshot | undefined;
  /**
   * Free bytes to keep below the resolved limit. Defaults to
   * `MEMORY_HEADROOM_FRACTION` of it, so a 512 MiB container keeps ~102 MiB
   * free rather than the flat 64 MiB a 2 GiB one would keep.
   */
  readonly minFreeBytes?: number;
  /**
   * Optional shared client. Used only to publish a shed marker for visibility;
   * the shed decision is local and Redis is never awaited on the request path,
   * so a slow or down Redis cannot add latency or fail a request here.
   */
  readonly redis?: RedisClient | undefined;
}

export function createHeadroomGuard(deps: HeadroomGuardDeps): Elysia {
  const fixedHeadroom = deps.minFreeBytes;
  return new Elysia()
    .beforeHandle(({ request }) => {
      if (!isProxyRequest(request)) return;
      // Shed when RSS plus the headroom would exceed this process's LIMIT —
      // not the host's total memory. A container capped at 512 MiB on a 16 GiB
      // host never approached the old `os.totalmem()` threshold, so the guard
      // never fired and the process was OOM-killed instead of shedding.
      //
      // The snapshot is up to one sample interval old. That is deliberate:
      // this is the hottest path in the process, and the condition it guards
      // develops over seconds.
      const snapshot = deps.memorySnapshot?.();
      const limit = snapshot?.limitBytes;
      if (limit === undefined) {
        // No limit discoverable and no sample yet: nothing to shed against.
        return;
      }
      const rss = snapshot?.rssBytes ?? process.memoryUsage().rss;
      const headroom = fixedHeadroom ?? deriveMemoryHeadroomBytes(limit);
      if (rss + headroom <= limit) return;
      if (deps.redis) {
        // Fire-and-forget: a failed marker write must not change this request's
        // outcome, and awaiting it would put Redis on the shed path.
        void deps.redis
          .set(SHED_MARKER_KEY, String(Date.now()), "EX", SHED_MARKER_TTL_SECONDS, "NX")
          .catch(() => undefined);
      }
      throw new GatewayError(
        "overloaded",
        503,
        "The gateway is at capacity (request {requestId}); retry shortly. It's not you, it's us — come back in a few minutes ☕️",
        {
          retryAfterMs: SHED_RETRY_MS,
          minFreeBytes: headroom,
          activeRequests: deps.store.activeCount(),
        },
      );
    })
    .as("plugin");
}
