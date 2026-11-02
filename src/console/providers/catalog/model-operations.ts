/**
 * Model-catalog operations for the provider console domain: model listing,
 * manual registration, connectivity probing (single, batch, and per-account),
 * enable/disable, sync, and deletion.
 *
 * Split out of `routes.ts` so the provider/account operations and the model
 * operations each stay a readable unit. Every operation validates access
 * through `requireTenantScope` first and returns DTOs from `./contracts`; the
 * Elysia wiring for these handlers lives in `routes.ts`.
 */
import type { AccessDecision } from "../../../security/access-control";
import { ConsoleDomainError, requireScope, requireTenantAnyScope } from "../../shared/errors";
import { GatewayError } from "../../../protocol/gateway-error";
import { MODEL_READ_SCOPES, MODEL_WRITE_SCOPES } from "./contracts";
import type {
  ByokConnectionTestRequest,
  ByokConnectionTestResult,
  FlatModelCatalogEntry,
  ModelCatalogEntry,
  ModelMetadataOverride,
  ProbeAllAccountsResult,
  ProbeAllModelsResult,
  ProbeModelRequest,
  ProbeModelResult,
  SetModelEnabledRequest,
  UpdateModelMetadataRequest,
} from "./contracts";
import type { ProviderCatalogConfig } from "./provider-operations";

/**
 * Rejects an operator metadata override that would poison routing.
 *
 * A context ceiling of zero or a negative one is worse than an unknown limit:
 * the router would refuse or truncate every request against this model, and the
 * failure reads as the model being broken rather than the number being wrong.
 * `null` is the honest "unknown" and stays allowed.
 */
function validateModelMetadata(metadata: ModelMetadataOverride | undefined): void {
  if (metadata === undefined) return;
  for (const field of ["contextLimit", "outputLimit"] as const) {
    const value = metadata[field];
    if (value === undefined || value === null) continue;
    if (!Number.isInteger(value) || value <= 0)
      throw new ConsoleDomainError(
        "invalid_request",
        400,
        `${field} must be a positive integer, or null for unknown`,
      );
  }
}

export function createModelCatalogOperations(config: ProviderCatalogConfig) {
  const operations = {
    async listModels(
        access: AccessDecision | undefined,
        providerId: string,
      ): Promise<readonly ModelCatalogEntry[]> {
        const a = requireTenantAnyScope(access, MODEL_READ_SCOPES);
        return config.store.listModels(a.tenantId, providerId);
      },
    async listFlatModels(access: AccessDecision | undefined): Promise<readonly FlatModelCatalogEntry[]> {
      const a = requireTenantAnyScope(access, MODEL_READ_SCOPES);
      const [providers, allAccounts] = await Promise.all([
        config.store.list(a.tenantId),
        config.store.listAllAccountSummaries(a.tenantId),
      ]);
      const accountsByProvider = new Map<string, number>();
      for (const account of allAccounts) {
        if (account.status === "active")
          accountsByProvider.set(account.providerId, (accountsByProvider.get(account.providerId) ?? 0) + 1);
      }
      /** Synthetic catalog entry for an alias/combo: they are routing targets,
       * not `models` rows, so they have no enriched capability metadata. */
      const syntheticEntry = (id: string, source: string): ModelCatalogEntry => ({
        modelId: id,
        route: "",
        provider: "",
        wireFamily: "chat",
        serviceKind: "llm",
        enabled: true,
        contextLimit: null,
        outputLimit: null,
        reasoning: false,
        toolCall: false,
        vision: false,
        document: false,
        audio: false,
        mediaGeneration: false,
        cost: null,
        source,
        sourceUpdatedAt: null,
      });
      const entriesByQualified = new Map<string, ModelCatalogEntry>();
      const rank = (entry: ModelCatalogEntry): number =>
        (entry.source === "builtin" ? 2 : 0) + (entry.contextLimit ?? 0);
      // One bulk read for every provider the tenant can see, instead of a pair
      // of queries per provider inside the loop below.
      const modelsByProvider = await config.store.listModelsForTenant(a.tenantId);
      for (const provider of providers) {
        if (provider.requiresAccount !== false && (accountsByProvider.get(provider.providerId) ?? 0) === 0)
          continue;
        for (const entry of modelsByProvider.get(provider.providerId) ?? []) {
          if (entry.enabled === false) continue;
          const qualified = `${provider.providerId}/${entry.modelId}`;
          const existing = entriesByQualified.get(qualified);
          if (!existing || rank(entry) > rank(existing)) entriesByQualified.set(qualified, entry);
        }
      }

      const seen = new Map<string, FlatModelCatalogEntry>();
      for (const [qualified, entry] of entriesByQualified) {
        const [providerId, ...rest] = qualified.split("/");
        seen.set(qualified, {
          providerId: providerId ?? "",
          providerLabel: providerId ?? qualified,
          modelId: rest.join("/"),
          qualified,
          entry,
          kind: "model",
        });
      }

      // Aliases and combos are routing targets an operator configures by name;
      // a picker that only listed `models` rows made them unselectable.
      const targets = await config.listRoutingTargets?.(a.tenantId);
      for (const alias of targets?.aliases ?? []) {
        const qualified = alias.alias;
        // Prefer the real model row so the picker shows real capability
        // metadata; fall back to a synthetic entry when the target is not an
        // enabled `models` row (e.g. it points at another alias).
        const entry = entriesByQualified.get(alias.targetModel) ?? syntheticEntry(qualified, "alias");
        if (seen.has(qualified)) continue;
        seen.set(qualified, {
          providerId: "",
          providerLabel: `alias → ${alias.targetModel}`,
          modelId: qualified,
          qualified,
          entry,
          kind: "alias",
        });
      }
      for (const combo of targets?.combos ?? []) {
        const qualified = combo.name;
        if (seen.has(qualified)) continue;
        seen.set(qualified, {
          providerId: "",
          providerLabel: `combo · ${combo.members.length} members`,
          modelId: qualified,
          qualified,
          entry: syntheticEntry(qualified, "combo"),
          kind: "combo",
        });
      }
      return [...seen.values()].sort((left, right) => left.qualified.localeCompare(right.qualified));
    },
    async syncModels(
        access: AccessDecision | undefined,
        providerId: string,
      ): Promise<{ synced: number }> {
        requireScope(access, "platform:admin");
        const a = requireTenantAnyScope(access, MODEL_READ_SCOPES);
        try {
          const result = await config.store.syncModels(a.tenantId, providerId);
          await config.snapshotInvalidator?.invalidate();
          return result;
        } catch (error) {
          // Discovery runs in the provider layer and raises `GatewayError`; the
          // console speaks `ConsoleDomainError`. Translating here keeps the
          // upstream-vs-operator distinction and the status code intact, so the
          // dashboard toast names the real reason instead of a generic failure.
          if (error instanceof GatewayError) {
            throw new ConsoleDomainError(error.code, error.status, error.message);
          }
          throw error;
        }
      }
      /** Manually registers additional model ids on an existing provider (tenant-bound, no upstream call). */,
    async registerModels(
        access: AccessDecision | undefined,
        providerId: string,
        modelIds: readonly string[],
        wireFamily?: string,
        metadata?: ModelMetadataOverride,
      ): Promise<{ registered: number }> {
        const a = requireTenantAnyScope(access, MODEL_WRITE_SCOPES);
        if (modelIds.length === 0)
          throw new ConsoleDomainError("invalid_request", 400, "modelIds must be non-empty");
        validateModelMetadata(metadata);
        await config.store.registerModels(a.tenantId, providerId, modelIds, wireFamily, metadata);
        await config.auditSink?.record({
          access: a,
          action: "provider.models.registered",
          target: providerId,
          detail: { modelIds, ...(metadata ? { metadata } : {}) },
        });
        await config.snapshotInvalidator?.invalidate();
        return { registered: modelIds.length };
      }
      /** Edits one owned model's limits and capability flags. */,
    async updateModelMetadata(
        access: AccessDecision | undefined,
        providerId: string,
        request: UpdateModelMetadataRequest,
      ): Promise<{ success: boolean }> {
        const a = requireTenantAnyScope(access, MODEL_WRITE_SCOPES);
        validateModelMetadata(request.metadata);
        const ok = await config.store.updateModelMetadata(a.tenantId, providerId, request);
        if (!ok)
          throw new ConsoleDomainError(
            "model_not_found",
            404,
            `Model ${request.modelId} not found`,
          );
        await config.auditSink?.record({
          access: a,
          action: "provider.model.metadata_updated",
          target: providerId,
          detail: { modelId: request.modelId, route: request.route, metadata: request.metadata },
        });
        await config.snapshotInvalidator?.invalidate();
        return { success: true };
      }
      /** One-shot connectivity test dispatched through the real provider adapter and
       * recorded into telemetry — never a hardcoded chat-completions shape; it reads
       * the model's own wire family/endpoint (or the caller's override for a
       * not-yet-registered candidate). */,
    async testByokConnection(
        access: AccessDecision | undefined,
        request: ByokConnectionTestRequest,
      ): Promise<ByokConnectionTestResult> {
        const a = requireTenantAnyScope(access, MODEL_READ_SCOPES);
        return config.store.testByokConnection(a.tenantId, request);
      },
    async probeModel(
        access: AccessDecision | undefined,
        providerId: string,
        request: ProbeModelRequest,
      ): Promise<ProbeModelResult> {
        const a = requireTenantAnyScope(access, MODEL_WRITE_SCOPES);
        if (!request.modelId || request.modelId.trim().length === 0)
          throw new ConsoleDomainError("invalid_request", 400, "modelId is required");
        return config.store.probeModel(a.tenantId, providerId, request);
      }
      /** Probes every registered model of a provider: the first model runs
       * sequentially (warms OAuth / connection pools), the rest run concurrently
       * bounded to 5. Read-only against upstreams; results are per-model. */,
    async probeAllModels(
        access: AccessDecision | undefined,
        providerId: string,
      ): Promise<ProbeAllModelsResult> {
        const a = requireTenantAnyScope(access, MODEL_WRITE_SCOPES);
        return config.store.probeAllModels(a.tenantId, providerId);
      },
      async probeAllAccounts(
        access: AccessDecision | undefined,
        providerId: string,
        request: ProbeModelRequest,
      ): Promise<ProbeAllAccountsResult> {
        const a = requireTenantAnyScope(access, MODEL_WRITE_SCOPES);
        if (!request.modelId || request.modelId.trim().length === 0)
          throw new ConsoleDomainError("invalid_request", 400, "modelId is required");
        return config.store.probeAllAccounts(a.tenantId, providerId, request);
      }
      /** Toggles a specific registered model's `enabled` flag — the hard routing
       * invariant `route-catalog.ts` filters on, not a display-only flag. */,
    async setModelEnabled(
        access: AccessDecision | undefined,
        providerId: string,
        request: SetModelEnabledRequest,
      ): Promise<{ success: boolean }> {
        const a = requireTenantAnyScope(access, MODEL_WRITE_SCOPES);
        const ok = await config.store.setModelEnabled(a.tenantId, providerId, request);
        if (!ok)
          throw new ConsoleDomainError("model_not_found", 404, `Model ${request.modelId} not found`);
        await config.auditSink?.record({
          access: a,
          action: request.enabled ? "provider.model.enabled" : "provider.model.disabled",
          target: providerId,
          detail: { modelId: request.modelId, route: request.route },
        });
        await config.snapshotInvalidator?.invalidate();
        return { success: true };
      },
    async deleteModel(
        access: AccessDecision | undefined,
        providerId: string,
        request: SetModelEnabledRequest,
      ): Promise<{ success: boolean }> {
        const a = requireTenantAnyScope(access, MODEL_WRITE_SCOPES);
        const ok = await config.store.deleteModel(a.tenantId, providerId, request);
        if (!ok)
          throw new ConsoleDomainError("model_not_found", 404, `Model ${request.modelId} not found`);
        await config.auditSink?.record({
          access: a,
          action: "provider.model.deleted",
          target: providerId,
          detail: { modelId: request.modelId, route: request.route },
        });
        await config.snapshotInvalidator?.invalidate();
        return { success: true };
      },
    async deleteModelsBulk(
        access: AccessDecision | undefined,
        providerId: string,
        items: readonly SetModelEnabledRequest[],
      ): Promise<{
        deleted: number;
        total: number;
        failures: { modelId: string; route: string; code: string; message: string }[];
      }> {
        const a = requireTenantAnyScope(access, MODEL_WRITE_SCOPES);
        if (items.length === 0 || items.length > 1000)
          throw new ConsoleDomainError("invalid_request", 422, "items must be a non-empty array up to 1000 entries");
        let deleted = 0;
        const failures: { modelId: string; route: string; code: string; message: string }[] = [];
        for (const item of items) {
          try {
            const ok = await config.store.deleteModel(a.tenantId, providerId, item);
            if (!ok) {
              failures.push({ modelId: item.modelId, route: item.route, code: "model_not_found", message: `Model ${item.modelId} not found` });
              continue;
            }
            deleted += 1;
          } catch (error) {
            if (error instanceof ConsoleDomainError) {
              failures.push({ modelId: item.modelId, route: item.route, code: error.code, message: error.message });
              continue;
            }
            throw error;
          }
        }
        if (deleted > 0) {
          await config.auditSink?.record({
            access: a,
            action: "provider.models.bulk_deleted",
            target: providerId,
            detail: { deleted, total: items.length },
          });
          await config.snapshotInvalidator?.invalidate();
        }
        return { deleted, total: items.length, failures };
      },
  };
  return operations;
}
