import { consoleErrorHandler } from "../../shared/errors";
import { literalUnion } from "../../shared/elysia-schema";
import { Elysia, t, type AnyElysia } from "elysia";
import { SERVICE_KINDS, WIRE_FAMILIES } from "../../../protocol/canonical-model";
import { PROBE_MODES, PROBE_REASONING_EFFORTS } from "../../../providers/discovery/discovery-types";
import {
  ACCOUNT_STATUSES,
  CREDENTIAL_KINDS,
  CREDENTIAL_MODES,
} from "./contracts";
import { createModelCatalogOperations } from "./model-operations";
import {
  createProviderCatalogOperations,
  type ProviderCatalogConfig,
} from "./provider-operations";
import { buddyDayKey } from "../../../workers/buddy-growth-tasks";
import type {
  ByokConnectionTestRequest,
  CreateProviderAccountRequest,
  CreateProviderRequest,
  DiscoverModelCommitRequest,
  ProbeModelRequest,
  RegisterModelsRequest,
  SetModelEnabledRequest,
  UpdateModelMetadataRequest,
  UpdateProviderAccountRequest,
  UpdateProviderRequest,
} from "./contracts";

const compatibilityProfileSchema = t.Object({
  cli_identity: t.Optional(t.Boolean()),
  gateway_user_agent: t.Optional(t.Boolean()),
  extra_headers: t.Optional(t.Record(t.String(), t.String())),
  extra_query_params: t.Optional(t.Record(t.String(), t.String())),
  endpoint_paths_by_wire_family: t.Optional(
    t.Record(literalUnion(WIRE_FAMILIES), t.String()),
  ),
  model_wire_families: t.Optional(
    t.Array(
      t.Object({
        pattern: t.String(),
        wire_family: literalUnion(WIRE_FAMILIES),
      }),
    ),
  ),
  service_kinds: t.Optional(t.Array(literalUnion(SERVICE_KINDS))),
  streaming_usage_mode: t.Optional(t.Union([t.Literal("include_usage"), t.Literal("none")])),
  structured_output: t.Optional(
    t.Object({
      mode: t.Union([t.Literal("json_object"), t.Literal("json_schema")]),
      enabled: t.Boolean(),
    }),
  ),
});
const createProviderBody = t.Object({
  providerId: t.String(),
  label: t.Optional(t.String()),
  enabled: t.Optional(t.Boolean()),
  capabilityProfile: t.Optional(t.Record(t.String(), t.Unknown())),
  wireFamily: t.Optional(t.String()),
  baseUrl: t.Optional(t.String()),
  compatibilityProfile: t.Optional(compatibilityProfileSchema),
  models: t.Optional(t.Array(t.String())),
});
const updateProviderBody = t.Partial(
  t.Object({
    label: t.String(),
    enabled: t.Boolean(),
    capabilityProfile: t.Record(t.String(), t.Unknown()),
    baseUrl: t.String(),
    compatibilityProfile: compatibilityProfileSchema,
  }),
);
const createAccountBody = t.Object({
  label: t.Optional(t.String()),
  credentialKind: literalUnion(CREDENTIAL_KINDS),
  credentialMode: t.Optional(literalUnion(CREDENTIAL_MODES)),
  secret: t.String(),
  authState: t.Optional(t.Record(t.String(), t.Unknown())),
});
/**
 * Batch create body.
 *
 * The cap is the same bound the proxy batch probe uses: a paste is bounded so
 * one request cannot open an unbounded transaction. It is a validation limit,
 * not a throughput one — the route stays a single round-trip either way.
 */
const MAX_BATCH_CREATE_ACCOUNTS = 100;
const createAccountBatchBody = t.Object({
  accounts: t.Array(createAccountBody, {
    minItems: 1,
    maxItems: MAX_BATCH_CREATE_ACCOUNTS,
  }),
});
const updateAccountBody = t.Object({
  label: t.Optional(t.String()),
  secret: t.Optional(t.String()),
  status: t.Optional(literalUnion(ACCOUNT_STATUSES)),
  staticToken: t.Optional(t.Boolean()),
});
/**
 * Operator-supplied limits/capabilities for a model the catalog cannot size.
 *
 * `passthrough` grants every capability at once and supersedes the per-flag
 * fields, so an operator who cannot know a model's capabilities does not have
 * to guess them one by one.
 */
const modelMetadataOverrideBody = t.Object({
  contextLimit: t.Optional(t.Union([t.Integer({ minimum: 1 }), t.Null()])),
  outputLimit: t.Optional(t.Union([t.Integer({ minimum: 1 }), t.Null()])),
  passthrough: t.Optional(t.Boolean()),
  image: t.Optional(t.Boolean()),
  reasoning: t.Optional(t.Boolean()),
  toolCall: t.Optional(t.Boolean()),
  warnings: t.Optional(
    t.Union([
      t.Null(),
      t.Array(
        t.Object({
          kind: t.String(),
          message: t.String(),
          severity: t.Optional(literalUnion(["info", "warn", "critical"])),
          updatedAt: t.Optional(t.String()),
        }),
      ),
    ]),
  ),
});
const registerModelsBody = t.Object({
  modelIds: t.Array(t.String()),
  wireFamily: t.Optional(t.String()),
  metadata: t.Optional(modelMetadataOverrideBody),
});
const discoverCommitBody = t.Object({
  modelIds: t.Array(t.String(), { minItems: 1 }),
});
const probeModelBody = t.Object({
  modelId: t.String(),
  serviceKind: t.Optional(literalUnion(SERVICE_KINDS)),
  route: t.Optional(t.String()),
  wireFamily: t.Optional(t.String()),
  accountId: t.Optional(t.String()),
  accountIds: t.Optional(t.Array(t.String(), { maxItems: 100 })),
  prompt: t.Optional(t.String()),
  reasoningEffort: t.Optional(literalUnion(PROBE_REASONING_EFFORTS)),
  maxOutputTokens: t.Optional(t.Integer({ minimum: 1, maximum: 131072 })),
  stream: t.Optional(t.Boolean()),
  surface: t.Optional(literalUnion(["default", "cosy", "grpc", "ide"])),
  mode: t.Optional(literalUnion(PROBE_MODES)),
});
const byokConnectionTestBody = t.Object({
  baseUrl: t.String(),
  apiKey: t.String(),
  wireFamily: t.String(),
  cliIdentity: t.Optional(t.Boolean()),
  extraHeaders: t.Optional(t.Record(t.String(), t.String())),
});
const setModelEnabledBody = t.Object({
  modelId: t.String(),
  route: t.String(),
  enabled: t.Boolean(),
  metadata: t.Optional(modelMetadataOverrideBody),
});
const deleteModelBody = t.Object({
  modelId: t.String(),
  route: t.String(),
});
const bulkDeleteModelsBody = t.Object({
  items: t.Array(deleteModelBody, { minItems: 1, maxItems: 1000 }),
});
const usageMatrixQuery = t.Object({
  days: t.Optional(t.Integer({ minimum: 1, maximum: 366 })),
});
export function createProviderCatalogRoutes(config: ProviderCatalogConfig): AnyElysia {
  // One provider-list cache revision shared by both operation factories. Every
  // provider/account/model mutation already funnels through the snapshot
  // invalidator; wrapping it here means any of those writes bumps the revision
  // folded into the provider-list cache key, so the cached overview (P-04)
  // recomputes on the next read without a per-path cache delete. The revision
  // stays per route-group, so a mutation handled by a peer process still
  // converges when its own entry's TTL lapses.
  const underlyingInvalidator = config.snapshotInvalidator;
  let providerListCacheRevision = 0;
  const catalogSnapshotInvalidator = underlyingInvalidator
    ? {
        invalidate: async () => {
          providerListCacheRevision += 1;
          return underlyingInvalidator.invalidate();
        },
        currentRevision: () => providerListCacheRevision,
      }
    : undefined;
  const effectiveConfig = catalogSnapshotInvalidator
    ? { ...config, snapshotInvalidator: catalogSnapshotInvalidator }
    : config;
  const factory = createProviderCatalogOperations(effectiveConfig);
  const modelFactory = createModelCatalogOperations(effectiveConfig);
  return new Elysia({ prefix: "/providers" })
    .error(consoleErrorHandler("Provider catalog operation failed"))
    .get("/", async ({ request }) => {
      return await factory.listProvidersCached(
        config.accessResolver(request),
        request.headers.get("if-none-match"),
      );
})
    .patch(
      "/platform/global/:providerId",
      { body: updateProviderBody },
      async ({ request, params, body }) => {
        return await factory.updateGlobalProvider(
          config.accessResolver(request),
          params.providerId,
          body as UpdateProviderRequest,
        );
},
    )
    .delete("/platform/global/:providerId", async ({ request, params }) => {
      return await factory.deleteGlobalProvider(
        config.accessResolver(request),
        params.providerId,
      );
})
    .get("/models/flat", async ({ request }) => {
      return await modelFactory.listFlatModels(config.accessResolver(request));
})
    // Ad-hoc connectivity test for a provider the operator has not saved yet:
    // declared before the `/:providerId` routes so "connection-test" is never
    // captured as a provider id.
    .post(
      "/connection-test",
      { body: byokConnectionTestBody },
      async ({ request, body }) => {
        return await modelFactory.testByokConnection(
          config.accessResolver(request),
          body as ByokConnectionTestRequest,
        );
},
    )
    .get("/:providerId", async ({ request, params }) => {
      return await factory.getProviderDetail(config.accessResolver(request), params.providerId);
})
    .get(
      "/:providerId/usage/matrix",
      { query: usageMatrixQuery },
      async ({ request, params, query }) => {
        return await factory.getUsageMatrix(
          config.accessResolver(request),
          params.providerId,
          query.days ?? 30,
        );
      },
    )
    .post("/", { body: createProviderBody }, async ({ request, body, set }) => {
      set.status = 201;
      return await factory.createProvider(
        config.accessResolver(request),
        body as CreateProviderRequest,
      );
})
    .patch("/:providerId", { body: updateProviderBody }, async ({ request, params, body }) => {
      return await factory.updateProvider(
        config.accessResolver(request),
        params.providerId,
        body as UpdateProviderRequest,
      );
})
    .delete("/:providerId", async ({ request, params }) => {
      return await factory.deleteProvider(config.accessResolver(request), params.providerId);
})
    .get("/:providerId/models", async ({ request, params }) => {
      return await modelFactory.listModels(config.accessResolver(request), params.providerId);
})
    .post(
      "/:providerId/models",
      { body: registerModelsBody },
      async ({ request, params, body }) => {
        const b = body as RegisterModelsRequest;
        return await modelFactory.registerModels(
          config.accessResolver(request),
          params.providerId,
          b.modelIds,
          b.wireFamily,
          b.metadata,
        );
},
    )
    .post(
      "/:providerId/models/probe",
      { body: probeModelBody },
      async ({ request, params, body }) => {
        return await modelFactory.probeModel(
          config.accessResolver(request),
          params.providerId,
          body as ProbeModelRequest,
        );
},
    )
    .post(
      "/:providerId/models/test-models",
      { body: t.Optional(t.Object({ mode: t.Optional(literalUnion(PROBE_MODES)) })) },
      async ({ request, params, body }) => {
        return await modelFactory.probeAllModels(
          config.accessResolver(request),
          params.providerId,
          body?.mode,
        );
      },
    )
    // Discovery must be declared before `/:providerId/models/discover/commit`
    // would be shadowed by a dynamic segment; Elysia resolves both here.
    .get("/:providerId/models/discover", async ({ request, params }) => {
      return await modelFactory.listDiscoveryCandidates(
        config.accessResolver(request),
        params.providerId,
      );
    })
    .post(
      "/:providerId/models/discover/commit",
      { body: discoverCommitBody },
      async ({ request, params, body }) => {
        return await modelFactory.commitDiscoveredModels(
          config.accessResolver(request),
          params.providerId,
          (body as DiscoverModelCommitRequest).modelIds,
        );
      },
    )
    .post("/:providerId/accounts/actions/disable-cooldowns", async ({ request, params }) => {
      return await factory.disableCooldowns(config.accessResolver(request), params.providerId);
    })
    .post("/:providerId/accounts/actions/delete-banned", async ({ request, params }) => {
      return await factory.deleteBanned(config.accessResolver(request), params.providerId);
    })
    .post(
      "/:providerId/accounts/probe",
      { body: probeModelBody },
      async ({ request, params, body }) => {
        return await modelFactory.probeAllAccounts(
          config.accessResolver(request),
          params.providerId,
          body as ProbeModelRequest,
        );
},
    )
    .patch(
      "/:providerId/models",
      { body: setModelEnabledBody },
      async ({ request, params, body }) => {
        const b = body as UpdateModelMetadataRequest;
        // One PATCH, two operations. A payload carrying `metadata` is an edit;
        // one without it is the enable/disable toggle this route has always
        // served. A separate path would split one row's mutation surface across
        // two endpoints for no gain.
        if (b.metadata !== undefined) {
          return await modelFactory.updateModelMetadata(
            config.accessResolver(request),
            params.providerId,
            b,
          );
        }
        return await modelFactory.setModelEnabled(
          config.accessResolver(request),
          params.providerId,
          body as SetModelEnabledRequest,
        );
},
    )
    .delete(
      "/:providerId/models",
      { body: deleteModelBody },
      async ({ request, params, body }) => {
        return await modelFactory.deleteModel(
          config.accessResolver(request),
          params.providerId,
          body as SetModelEnabledRequest,
        );
},
    )
    .delete(
      "/:providerId/models/bulk",
      { body: bulkDeleteModelsBody },
      async ({ request, params, body }) => {
        const items = (body as { items: SetModelEnabledRequest[] }).items;
        return await modelFactory.deleteModelsBulk(
          config.accessResolver(request),
          params.providerId,
          items,
        );
},
    )
    .post("/:providerId/models/sync", async ({ request, params }) => {
      return await modelFactory.syncModels(config.accessResolver(request), params.providerId);
})
    .get("/:providerId/accounts", async ({ request, params }) => {
      return await factory.listAccounts(config.accessResolver(request), params.providerId);
})
    .post(
      "/:providerId/accounts",
      { body: createAccountBody },
      async ({ request, params, body, set }) => {
        set.status = 201;
        const created = await factory.createAccount(
          config.accessResolver(request),
          params.providerId,
          body as CreateProviderAccountRequest,
        );
        return created;
},
    )
    .post(
      "/:providerId/accounts/batch",
      { body: createAccountBatchBody },
      async ({ request, params, body }) => {
        return await factory.createAccountBatch(
          config.accessResolver(request),
          params.providerId,
          body.accounts as CreateProviderAccountRequest[],
        );
      },
    )
    .patch(
      "/:providerId/accounts/:accountId",
      { body: updateAccountBody },
      async ({ request, params, body }) => {
        const updated = await factory.updateAccount(
          config.accessResolver(request),
          params.providerId,
          params.accountId,
          body as UpdateProviderAccountRequest,
        );
        return updated;
},
    )
    .get("/:providerId/accounts/:accountId/health-events", async ({ request, params }) => {
      return await factory.listAccountHealthEvents(
        config.accessResolver(request),
        params.providerId,
        params.accountId,
      );
})
    .delete("/:providerId/accounts/:accountId/health-events", async ({ request, params }) => {
      return await factory.purgeAccountHealthEvents(
        config.accessResolver(request),
        params.providerId,
        params.accountId,
      );
    })
    .get("/:providerId/accounts/:accountId/growth-tasks", async ({ request, params }) => {
      const dayKey = buddyDayKey();
      return await factory.listBuddyGrowthTasks(
        config.accessResolver(request),
        params.providerId,
        params.accountId,
        dayKey,
      );
})
    .post("/:providerId/accounts/:accountId/recover", async ({ request, params }) => {
      const recovered = await factory.recoverAccount(
        config.accessResolver(request),
        params.providerId,
        params.accountId,
      );
      return recovered;
})
    .post("/:providerId/accounts/:accountId/refresh-token", async ({ request, params }) => {
      const refreshed = await factory.refreshAccountToken(
        config.accessResolver(request),
        params.providerId,
        params.accountId,
      );
      return refreshed;
})
    .post(
      "/:providerId/accounts/export",
      { body: t.Object({ accountIds: t.Array(t.String()) }) },
      async ({ request, params, body }) => {
        return await factory.exportAccounts(
          config.accessResolver(request),
          params.providerId,
          body.accountIds,
        );
},
    );
}
