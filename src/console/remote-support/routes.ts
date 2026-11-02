/**
 * Remote-support HTTP surface.
 *
 * Three routes over one external launcher script: read the current tunnel,
 * start one, stop one. Every mutating route needs `dashboard:write` because it
 * runs a process on the host running the gateway.
 *
 * The start response never contains a secret and never performs an install; it
 * reports `not_installed` with guidance when the publisher is missing.
 */
import { Elysia, t } from "elysia";
import type { ConsoleAccessResolver } from "../auth/access";
import { consoleErrorHandler, requireTenantScope } from "../shared/errors";
import { REMOTE_SUPPORT_TOOLS } from "./contracts";
import type { RemoteSupportService } from "./service";

interface RemoteSupportRoutesConfig {
  readonly accessResolver: ConsoleAccessResolver;
  readonly service: RemoteSupportService;
}

const toolSchema = t.Union([
  t.Literal(REMOTE_SUPPORT_TOOLS[0]),
  t.Literal(REMOTE_SUPPORT_TOOLS[1]),
]);

const startBody = t.Object({
  tool: toolSchema,
  port: t.Optional(t.Number()),
});

const stopBody = t.Object({
  tool: t.Optional(toolSchema),
});

/**
 * The return type is inferred rather than annotated as `Elysia`: `.error()`
 * widens the instance type with its handler's response envelope, so the
 * annotated base type no longer matches the chained result.
 */
export function createRemoteSupportRoutes(config: RemoteSupportRoutesConfig) {
  return new Elysia()
    .error(consoleErrorHandler("Remote support failed"))
    .get("/remote-support/status", async ({ request }) => {
      requireTenantScope(config.accessResolver(request), "dashboard:read");
      return await config.service.status();
    })
    .post(
      "/remote-support/start",
      { body: startBody },
      async ({ request, body }) => {
        requireTenantScope(config.accessResolver(request), "dashboard:write");
        const status = await config.service.start(body.tool, body.port);
        return { started: status.active !== null, ...status };
      },
    )
    .post(
      "/remote-support/stop",
      { body: stopBody },
      async ({ request, body }) => {
        requireTenantScope(config.accessResolver(request), "dashboard:write");
        return await config.service.stop(body.tool);
      },
    );
}
