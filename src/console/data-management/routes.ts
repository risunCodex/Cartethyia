import { Elysia, type AnyElysia } from "elysia";
import { t } from "elysia";
import { errorResponse, requireAnyScope } from "../shared/errors";
import type { AccessDecision } from "../../security/access-control";
import { createDataManagementOperations, type DataManagementConfig } from "./operations";
import type { PurgeTarget, ReclaimAction, ReclaimResponse } from "./contracts";

const WRITE_SCOPES = ["dashboard:write"] as const;

const reclaimBody = t.Object({
  action: t.Union([
    t.Literal("payload_frames"),
    t.Literal("telemetry_retention"),
  ]),
});

const purgeBody = t.Object({
  target: t.Literal("health_events"),
});

/**
 * Console routes for disk housekeeping.
 *
 * Reclaim and flush both need `dashboard:write`. Reading is deliberately the
 * same scope as the rest of the console rather than something narrower: the
 * sizes are not sensitive, but splitting the two would mean a caller who can
 * already write could not see what they are about to affect.
 */
export function createDataManagementRoutes(
  config: DataManagementConfig & {
    readonly accessResolver: (request: Request) => AccessDecision | undefined;
    readonly auditSink?: {
      record(entry: {
        readonly access: AccessDecision;
        readonly action: string;
        readonly target: string | null;
        readonly detail?: Record<string, unknown>;
      }): Promise<void> | void;
    } | undefined;
    readonly flusher?: { flush(): Promise<void> } | undefined;
  },
): AnyElysia {
  const operations = createDataManagementOperations(config);

  return new Elysia({ prefix: "/data-management" })
    .get("/usage", async ({ request, set }) => {
      try {
        const access = requireAnyScope(config.accessResolver(request), WRITE_SCOPES);
        // The tenant decides the payload window, so the scan needs it: the
        // count of reclaimable frames is measured against that tenant's own
        // retention, not the deployment's.
        return await operations.usage(access.tenantId ?? null);
      } catch (error) {
        return errorResponse(error, set, "Could not read disk usage");
      }
    })
    .post("/reclaim", { body: reclaimBody }, async ({ request, body, set }) => {
      try {
        const access = requireAnyScope(config.accessResolver(request), WRITE_SCOPES);
        const action = body.action as ReclaimAction;
        const result: ReclaimResponse = await operations.reclaim(action);
        await config.auditSink?.record({
          access,
          action: `data_management.reclaim.${action}`,
          target: access.tenantId ?? null,
          detail: { deletedFiles: result.deletedFiles, reclaimedBytes: result.reclaimedBytes },
        });
        set.status = 200;
        return result;
      } catch (error) {
        return errorResponse(error, set, "Reclaim failed");
      }
    })
    .post("/flush", async ({ request, set }) => {
      try {
        const access = requireAnyScope(config.accessResolver(request), WRITE_SCOPES);
        await config.flusher?.flush();
        await config.auditSink?.record({
          access,
          action: "data_management.flush",
          target: access.tenantId ?? null,
        });
        set.status = 200;
        return { flushed: true };
      } catch (error) {
        return errorResponse(error, set, "Flush failed");
      }
    })
    .post("/purge", { body: purgeBody }, async ({ request, body, set }) => {
      try {
        const access = requireAnyScope(config.accessResolver(request), WRITE_SCOPES);
        const deleted: number = await operations.purge(body.target as PurgeTarget);
        await config.auditSink?.record({
          access,
          action: `data_management.purge.${body.target}`,
          target: access.tenantId ?? null,
          detail: { deleted },
        });
        set.status = 200;
        return { target: body.target, deleted } satisfies { target: PurgeTarget; deleted: number };
      } catch (error) {
        return errorResponse(error, set, "Purge failed");
      }
    });
}
