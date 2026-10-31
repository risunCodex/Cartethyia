// Network-pool control-plane HTTP routes. The only module that touches Elysia.
import { Elysia, t, type AnyElysia } from "elysia";
import { consoleErrorHandler } from "../../shared/errors";
import { literalUnion } from "../../shared/elysia-schema";
import { RELAY_TARGETS, type RelayDeployRequest } from "./relay-deploy";
import { RELAY_REGIONS } from "./relay-regions";
import { SPEED_TEST_DEFAULT_BYTES } from "./speed-test-sizes";
import {
  MAX_BATCH_PROBE_TARGETS,
  POOL_KINDS,
  POOL_ROUTING_STRATEGIES,
  POOL_STATUSES,
  type CreateNetworkPoolRequest,
  type NetworkPoolConfig,
  type PoolStrategySetting,
} from "./contracts";
import { createNetworkPoolOperations } from "./operations";
import { parseProxyFile } from "./import-parse";

const poolKindSchema = literalUnion(POOL_KINDS);
const createPoolBody = t.Object({
  kind: poolKindSchema,
  label: t.Optional(t.String()),
  endpoint: t.String(),
  credential: t.Optional(t.String()),
  maxInflight: t.Optional(t.Number()),
  weight: t.Optional(t.Number()),
  status: t.Optional(literalUnion(POOL_STATUSES)),
  config: t.Optional(t.Record(t.String(), t.Unknown())),
  /** Egress allowance in bytes; `null` clears it back to unmetered. */
  quotaBytes: t.Optional(t.Union([t.Number({ minimum: 1 }), t.Null()])),
  /** Operator-set family/tag naming which family this node belongs to. */
  family: t.Optional(t.Union([t.String(), t.Null()])),
});
const deployRelayBody = t.Object({
  target: literalUnion(RELAY_TARGETS),
  token: t.String({ minLength: 1 }),
  accountId: t.Optional(t.String()),
  projectName: t.Optional(t.String()),
  /** Vercel function region; ignored for targets that have no region control. */
  region: t.Optional(literalUnion(RELAY_REGIONS)),
});
const testBatchBody = t.Object({
  targets: t.Array(createPoolBody, { minItems: 1, maxItems: MAX_BATCH_PROBE_TARGETS }),
});
const updatePoolBody = t.Partial(createPoolBody);
/**
 * A pasted proxy list. `content` is the file's text; the shapes accepted are
 * documented on {@link parseProxyFile}. `maxInflight` and `weight` apply to
 * every imported row, because a file carries no per-row tuning.
 */
const importPoolsBody = t.Object({
  content: t.String({ minLength: 1 }),
  maxInflight: t.Optional(t.Number()),
  weight: t.Optional(t.Number()),
  family: t.Optional(t.Union([t.String(), t.Null()])),
  labelPrefix: t.Optional(t.String()),
});
export function createNetworkPoolRoutes(config: NetworkPoolConfig): AnyElysia {
  const factory = createNetworkPoolOperations(config);
  return new Elysia({ prefix: "/network/pools" })
    .error(consoleErrorHandler("Network pool operation failed"))
    .get("/", async ({ request }) => {
      return await factory.listPools(config.accessResolver(request));
})
    .get("/:poolId", async ({ request, params }) => {
      return await factory.getPoolDetail(config.accessResolver(request), params.poolId);
})
    .post("/", { body: createPoolBody }, async ({ request, body, set }) => {
      set.status = 201;
      return await factory.createPool(
        config.accessResolver(request),
        body as CreateNetworkPoolRequest,
      );
})
    .post("/import", { body: importPoolsBody }, async ({ request, body, set }) => {
      set.status = 200;
      return await factory.importPools(config.accessResolver(request), body);
    })
    .patch("/:poolId", { body: updatePoolBody }, async ({ request, params, body }) => {
      return await factory.updatePool(
        config.accessResolver(request),
        params.poolId,
        body as Partial<CreateNetworkPoolRequest>,
      );
})
    .delete("/:poolId", async ({ request, params }) => {
      return await factory.deletePool(config.accessResolver(request), params.poolId);
})
    .post(
      "/bulk/create",
      { body: t.Object({ targets: t.Array(createPoolBody, { minItems: 1, maxItems: MAX_BATCH_PROBE_TARGETS }) }) },
      async ({ request, body, set }) => {
        set.status = 200;
        return await factory.createPoolBatch(
          config.accessResolver(request),
          body.targets as CreateNetworkPoolRequest[],
        );
      },
    )
    .post(
      "/bulk/delete",
      { body: t.Object({ ids: t.Array(t.String(), { minItems: 1 }) }) },
      async ({ request, body }) => {
        return await factory.deletePoolBatch(config.accessResolver(request), body.ids);
      },
    )
    .post(
      "/bulk/status",
      {
        body: t.Object({
          ids: t.Array(t.String(), { minItems: 1 }),
          status: literalUnion(POOL_STATUSES),
        }),
      },
      async ({ request, body }) => {
        return await factory.setPoolStatusBatch(config.accessResolver(request), body.ids, body.status);
      },
    )
    .get("/:poolId/health-events", async ({ request, params }) => {
      return await factory.listPoolHealthEvents(config.accessResolver(request), params.poolId);
})
    .post("/:poolId/recover", async ({ request, params }) => {
      return await factory.recoverPool(config.accessResolver(request), params.poolId);
})
    .post(
      "/:poolId/provider-probe",
      { body: t.Object({ providerId: t.String() }) },
      async ({ request, params, body }) => {
        return await factory.providerProbe(
          config.accessResolver(request),
          params.poolId,
          body.providerId,
        );
      },
    )
    .post("/:poolId/health-check", async ({ request, params }) => {
      return await factory.healthCheck(config.accessResolver(request), params.poolId);
})
    .post(
      "/:poolId/speed-test",
      { body: t.Optional(t.Object({ bytes: t.Optional(t.Number()) })) },
      async ({ request, params, body }) => {
        return await factory.speedTest(
          config.accessResolver(request),
          params.poolId,
          body?.bytes ?? SPEED_TEST_DEFAULT_BYTES,
        );
      },
    )
    .post("/test", { body: createPoolBody }, async ({ request, body }) => {
      return await factory.probeAdHocPool(
        config.accessResolver(request),
        body as CreateNetworkPoolRequest,
      );
})
    .post("/test-batch", { body: testBatchBody }, async ({ request, body }) => {
      return await factory.probeAdHocPoolBatch(
        config.accessResolver(request),
        body.targets as CreateNetworkPoolRequest[],
      );
})
    .post(
      "/test-batch/provider",
      {
        body: t.Object({
          providerId: t.String(),
          targets: t.Array(createPoolBody, { minItems: 1, maxItems: MAX_BATCH_PROBE_TARGETS }),
        }),
      },
      async ({ request, body }) => {
        return await factory.probeAdHocProviderBatch(
          config.accessResolver(request),
          body.targets as CreateNetworkPoolRequest[],
          body.providerId,
        );
      },
    )
    .post(
      "/:poolId/cooldowns/clear",
      { body: t.Optional(t.Object({ providerId: t.Optional(t.String()) })) },
      async ({ request, params, body }) => {
        return await factory.clearPoolCooldown(
          config.accessResolver(request),
          params.poolId,
          body?.providerId,
        );
},
    )
    .post("/relay/deploy", { body: deployRelayBody }, async ({ request, body }) => {
      return await factory.deployRelay(config.accessResolver(request), body as RelayDeployRequest);
    })
    .get("/strategy", async ({ request }) => {
      return await factory.getStrategy(config.accessResolver(request));
})
    .patch(
      "/strategy",
      {
        body: t.Object({
          strategy: t.Optional(literalUnion(POOL_ROUTING_STRATEGIES)),
          rotateCount: t.Optional(t.Number()),
        }),
      },
      async ({ request, body }) => {
        return await factory.updateStrategy(
          config.accessResolver(request),
          body as Partial<PoolStrategySetting>,
        );
},
    );
}
