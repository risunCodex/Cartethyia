// Dependency readiness guard: refuses `/v1/*` and `/console/api/*` traffic
// while dependencies are unhealthy or the process is draining.
import { Elysia } from "elysia";
import { GatewayError } from "../../protocol/gateway-error";
import { fastPathname } from "../pathname";
import { shutdownNotice } from "../shutdown-notice";
import type { ReadinessMiddlewareDeps } from "../contracts";

export function createDependencyReadinessMiddleware(deps: ReadinessMiddlewareDeps): Elysia {
  return new Elysia()
    .beforeHandle(async ({ request }) => {
      const path = fastPathname(request.url);
      if (
        path === "/health" ||
        path === "/health/ready" ||
        (!path.startsWith("/v1/") && !path.startsWith("/console/api/"))
      )
        return;
      if (deps.shutdownCoordinator?.isDraining()) {
        const notice = shutdownNotice(deps.shutdownCoordinator.shutdownReason?.());
        throw new GatewayError(notice.code, 503, notice.message);
      }
      const readiness = await deps.readiness();
      if (readiness.status !== "ready") {
        // A probe that timed out under load says nothing about the dependencies —
        // it could not get a backend in time, usually because the process is
        // saturated. Surface that as overload, not as a broken dependency. A
        // hard failure (connection refused, migrations missing) keeps the
        // dependency message, which tells the operator what to actually fix.
        if (readiness.reason?.endsWith("timed out")) {
          throw new GatewayError(
            "overloaded",
            503,
            "The gateway is overloaded (request {requestId}); retry shortly. It's not you, it's us — back in a moment ☕️",
            { retryAfterMs: 1_000 },
          );
        }
        throw new GatewayError("platform_unavailable", 503, "The gateway's dependencies are not ready, so no request can be served (request {requestId}). Retry shortly; if it persists, check the database and coordination backend. Warming up — back in a moment ☕️");
      }
    })
    .as("plugin");
}
