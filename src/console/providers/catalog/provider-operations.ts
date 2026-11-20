/**
 * Provider operations for the provider console domain: tenant and global
 * provider CRUD, the cached provider-list overview, and the usage matrix.
 * The account operations live in `provider-account-operations.ts`; the
 * response projection in `provider-operations-projection.ts`; the model
 * operations in `model-operations.ts`. Every operation validates access
 * through `requireTenantScope`/`requireGlobalAdmin` first and returns DTOs
 * from `./contracts`; the Elysia wiring for these handlers lives in
 * `routes.ts`.
 */
import type { ConsoleAccessResolver } from "../../auth/access";
import type { AuditSink } from "../../audit/contracts";
import {
  ConsoleDomainError,
  requireGlobalAdmin,
  requireTenantAnyScope,
} from "../../shared/errors";
import { cachedReadWithEtag, conditionalResponse } from "../../shared/read-through-cache";
import type { RedisClient } from "../../../persistence/redis";
import type { AccessDecision } from "../../../security/access-control";
import type { ProviderUsageDayRow } from "../../../observability/event-query";
import type { RefreshAccountStatusOutcome } from "../../../providers/operations/account-refresh-status";
import { isBundledProviderId } from "../../../providers/provider-contracts";
import type { ProviderRegistry } from "../../../providers/provider-registry";
import { providerDisplayName } from "../../../providers/provider-metadata";
import {
  PROVIDER_LIST_CACHE_REVISION,
  PROVIDER_LIST_CACHE_SHAPE,
  PROVIDER_LIST_CACHE_TTL_SECONDS,
  attachProviderCapabilities,
  computeProviderList,
  sanitizeProviderResponse,
} from "./provider-operations-projection";
import { createProviderAccountOperations } from "./provider-account-operations";
import { pickDefined } from "../../shared/object";
import {
  PROVIDER_READ_SCOPES,
  PROVIDER_WRITE_SCOPES,
  isWireFamily,
  validateCompatibilityProfile,
  type CreateProviderRequest,
  type ProviderCatalogStore,
  type ProviderRecord,
  type ProviderResponse,
  type UpdateProviderRequest,
} from "./contracts";

export { sanitizeProviderResponse } from "./provider-operations-projection";

export interface ProviderCatalogConfig {
  readonly store: ProviderCatalogStore;
  readonly accessResolver: ConsoleAccessResolver;
  /** Records privileged mutations to `admin_audit_log`; a no-op when omitted (e.g. tests). */
  readonly auditSink?: AuditSink;
  /** Registry-backed OAuth login clients; used to compute `oauthFlows` on responses. */
  readonly providerRegistry: ProviderRegistry;
  /**
   * Shared Redis client for the provider-list read-through cache. Omitted in
   * lite mode / tests, where `cachedReadWithEtag` falls back to its bounded
   * in-process TTL store; the ETag/304 semantics are identical either way.
   */
  readonly redis?: RedisClient | undefined;
  /**
   * Drops the cached route snapshot after a catalog write. `currentRevision`
   * (when the host exposes it) is folded into the provider-list cache key, so
   * every mutation that already bumps the snapshot — provider, account, and
   * model writes — rotates the cached overview without a per-path delete.
   */
  readonly snapshotInvalidator?: {
    invalidate(): Promise<number>;
    currentRevision?(): number;
  };
  /**
   * Re-applies one provider's BYOK adapter registration after a create/update
   * so a custom provider is dispatchable without a restart. Optional: tests
   * and read-only hosts omit it and keep boot-time registrations only.
   */
  readonly syncByokProvider?: (providerId: string) => Promise<unknown>;
  /**
   * Operator-defined routing targets shown alongside `models` rows in the
   * flat picker catalog. Optional so hosts without a routing store (and
   * existing test doubles) keep returning model entries only.
   */
  readonly listRoutingTargets?: (tenantId: string) => Promise<{
    readonly aliases: readonly { readonly alias: string; readonly targetModel: string }[];
    readonly combos: readonly {
      readonly name: string;
      readonly members: readonly string[];
    }[];
  }>;
  /**
   * Day × model usage aggregate feeding the provider's Activity Matrix card.
   * Optional so hosts without telemetry reads (and existing test doubles) keep
   * the route returning an empty matrix instead of failing.
   */
  readonly providerUsageMatrix?: (
    tenantId: string,
    providerId: string,
    days: number,
  ) => Promise<readonly ProviderUsageDayRow[]>;
  /**
   * Resolves the stored credential and optional OAuth refresh token for export,
   * decrypting them without applying provider-specific dispatch codecs.
   */
  readonly resolveExportCredentials?: (
    providerId: string,
    accountId: string,
  ) => Promise<{ readonly accessToken: string; readonly refreshToken?: string }>;
  /**
   * One-shot manual OAuth token refresh (area 04). Provided by the composition
   * root; when absent the refresh-token route answers 501 rather than silently
   * reporting success.
   */
  readonly refreshAccountStatus?: (
    accountId: string,
    opts?: { readonly origin?: "ui" | "sweep" | "dispatch" },
  ) => Promise<RefreshAccountStatusOutcome>;
}

function createProviderOperations(config: ProviderCatalogConfig) {
  const operations = {
    async listProviders(access: AccessDecision | undefined): Promise<ProviderResponse[]> {
      const a = requireTenantAnyScope(access, PROVIDER_READ_SCOPES);
      return computeProviderList(config, a.tenantId);
    },
    /**
     * The full provider list with overview counts, served through the
     * read-through cache (P-04). A repeated poll answers `304` with the ETag
     * instead of recomputing the two grouped count queries.
     *
     * Returning a `Response` rather than a plain array is what makes the ETag
     * conditional branch possible: a `304` has no body to serialize. The cache
     * key is tenant-scoped and carries the routing revision, so a provider /
     * account / model mutation that bumps the snapshot rotates the key and the
     * next read recomputes fresh counts.
     */
    async listProvidersCached(
      access: AccessDecision | undefined,
      ifNoneMatch: string | null,
    ): Promise<Response> {
      const a = requireTenantAnyScope(access, PROVIDER_READ_SCOPES);
      const revision = config.snapshotInvalidator?.currentRevision?.() ?? 0;
      const key =
        `cartethyia:${PROVIDER_LIST_CACHE_SHAPE}:v${PROVIDER_LIST_CACHE_REVISION}:` +
        `${a.tenantId}:${revision}`;
      const result = await cachedReadWithEtag(
        config.redis,
        key,
        () => computeProviderList(config, a.tenantId),
        PROVIDER_LIST_CACHE_TTL_SECONDS,
      );
      return conditionalResponse(ifNoneMatch, result, result.value);
    },
    async getProviderDetail(
        access: AccessDecision | undefined,
        providerId: string,
      ): Promise<ProviderResponse> {
        const a = requireTenantAnyScope(access, PROVIDER_READ_SCOPES);
        const rec = await config.store.get(a.tenantId, providerId);
        if (!rec)
          throw new ConsoleDomainError("provider_not_found", 404, `Provider ${providerId} not found`);
        return attachProviderCapabilities(sanitizeProviderResponse(rec, true), config.providerRegistry);
      },
    async getUsageMatrix(
      access: AccessDecision | undefined,
      providerId: string,
      days: number,
    ): Promise<{ readonly days: number; readonly rows: readonly ProviderUsageDayRow[] }> {
      const a = requireTenantAnyScope(access, PROVIDER_READ_SCOPES);
      // Bounded window even on a hostile query string: the card reads a
      // calendar, not history, and the aggregate scan cost grows with `days`.
      const bounded = Math.min(Math.max(Math.trunc(days) || 1, 1), 366);
      if (!config.providerUsageMatrix) return { days: bounded, rows: [] };
      const rows = await config.providerUsageMatrix(a.tenantId, providerId, bounded);
      return { days: bounded, rows };
    },
    async createProvider(
        access: AccessDecision | undefined,
        request: CreateProviderRequest,
      ): Promise<ProviderResponse> {
        const a = requireTenantAnyScope(access, PROVIDER_WRITE_SCOPES);
        if (!/^[a-z][a-z0-9-]{0,63}$/.test(request.providerId.toLowerCase()))
          throw new ConsoleDomainError(
            "invalid_provider_id",
            400,
            "Provider ID must be a lowercase slug",
          );
        if (isBundledProviderId(request.providerId))
          throw new ConsoleDomainError("slug_reserved", 409, "Provider ID is reserved", {
            providerId: request.providerId,
          });
        if (request.compatibilityProfile !== undefined) {
          try {
            validateCompatibilityProfile(request.compatibilityProfile);
          } catch (error) {
            throw new ConsoleDomainError(
              "invalid_compatibility_profile",
              400,
              error instanceof Error ? error.message : "Invalid compatibility profile",
            );
          }
        }
        if (request.wireFamily !== undefined && !isWireFamily(request.wireFamily)) {
          throw new ConsoleDomainError(
            "invalid_wire_family",
            400,
            `wireFamily must be one of chat, responses, messages`,
          );
        }
        const record: ProviderRecord = {
          providerId: request.providerId,
          displayName: providerDisplayName(request.providerId),
          serviceKinds: ["llm"],
          // No model advertises search; see the note in provider-metadata.ts.
          supportsWebSearch: false,
          tenantId: a.tenantId,
          enabled: request.enabled ?? true,
          isBuiltIn: false,
          supportsModelDiscovery: true,
          // the two builtin credential-less routes get `false`, set at seed time.
          // A custom provider may also be credential-less: the operator enables
          // the modal's "Public Key" switch when the upstream answers without
          // any key. `false` alone is not enough to serve it — the routing
          // catalog emits the public no-key candidate only when the provider
          // has no account rows, so this same request registers a
          // credential-less "Public Key" account to route through (see
          // `registerPublicKeyAccount` below), unless the operator supplied a
          // real key.
          requiresAccount: request.requiresAccount ?? true,
          ...pickDefined({ label: request.label }),
          ...(request.capabilityProfile === undefined
            ? {}
            : { capabilityProfile: request.capabilityProfile }),
          ...pickDefined({ baseUrl: request.baseUrl }),
          // The operator's chosen wire family is what the BYOK adapter derives
          // its supported families and credential header shape from; dropping
          // it here silently made every custom provider an OpenAI-compatible one.
          ...(request.wireFamily === undefined || !isWireFamily(request.wireFamily)
            ? {}
            : { wireFamilyDefault: request.wireFamily }),
          ...(request.compatibilityProfile === undefined
            ? {}
            : { compatibilityProfile: request.compatibilityProfile }),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        await config.store.create(record);
        if (request.models && request.models.length > 0) {
          await config.store.registerModels(
            a.tenantId,
            record.providerId,
            request.models,
            request.wireFamily,
          );
        }
        await config.auditSink?.record({
          access: a,
          action: "provider.created",
          target: record.providerId,
          detail: { wireFamily: request.wireFamily, modelCount: request.models?.length ?? 0 },
        });
        await config.snapshotInvalidator?.invalidate();
        await config.syncByokProvider?.(record.providerId);
        return attachProviderCapabilities(sanitizeProviderResponse(record, true), config.providerRegistry);
      },
    async updateProvider(
        access: AccessDecision | undefined,
        providerId: string,
        request: UpdateProviderRequest,
      ): Promise<ProviderResponse> {
        const a = requireTenantAnyScope(access, PROVIDER_WRITE_SCOPES);
        if (request.compatibilityProfile !== undefined) {
          try {
            validateCompatibilityProfile(request.compatibilityProfile);
          } catch (error) {
            throw new ConsoleDomainError(
              "invalid_compatibility_profile",
              400,
              error instanceof Error ? error.message : "Invalid compatibility profile",
            );
          }
        }
        const updated = await config.store.update(a.tenantId, providerId, request);
        if (!updated)
          throw new ConsoleDomainError("provider_not_found", 404, `Provider ${providerId} not found`);
        await config.auditSink?.record({
          access: a,
          action: "provider.updated",
          target: providerId,
          detail: { fields: Object.keys(request) },
        });
        await config.snapshotInvalidator?.invalidate();
        await config.syncByokProvider?.(providerId);
        return attachProviderCapabilities(sanitizeProviderResponse(updated, true), config.providerRegistry);
      },
    async deleteProvider(
        access: AccessDecision | undefined,
        providerId: string,
      ): Promise<{ success: boolean }> {
        const a = requireTenantAnyScope(access, PROVIDER_WRITE_SCOPES);
        const owned = await config.store.delete(a.tenantId, providerId);
        const retired = owned || await config.store.deleteGlobal(providerId);
        if (!retired)
          throw new ConsoleDomainError("provider_not_found", 404, `Provider ${providerId} not found`);
        await config.auditSink?.record({
          access: a,
          action: "provider.deleted",
          target: providerId,
        });
        await config.snapshotInvalidator?.invalidate();
        return { success: true };
      },
    async updateGlobalProvider(
        access: AccessDecision | undefined,
        providerId: string,
        request: UpdateProviderRequest,
      ): Promise<ProviderResponse> {
        const a = requireGlobalAdmin(access);
        const updated = await config.store.updateGlobal(providerId, request);
        if (!updated) {
          throw new ConsoleDomainError("provider_not_found", 404, `Provider ${providerId} not found`);
        }
        await config.auditSink?.record({
          access: a,
          action: "provider.global.updated",
          target: providerId,
          detail: { fields: Object.keys(request) },
        });
        await config.snapshotInvalidator?.invalidate();
        await config.syncByokProvider?.(providerId);
        return sanitizeProviderResponse(updated, true);
      },
    async deleteGlobalProvider(
        access: AccessDecision | undefined,
        providerId: string,
      ): Promise<{ success: boolean }> {
        const a = requireGlobalAdmin(access);
        const deleted = await config.store.deleteGlobal(providerId);
        if (!deleted) {
          throw new ConsoleDomainError("provider_not_found", 404, `Provider ${providerId} not found`);
        }
        await config.auditSink?.record({
          access: a,
          action: "provider.global.deleted",
          target: providerId,
        });
        await config.snapshotInvalidator?.invalidate();
        return { success: true };
      },
  };
  return operations;
}

export function createProviderCatalogOperations(config: ProviderCatalogConfig) {
  return {
    ...createProviderAccountOperations(config),
    ...createProviderOperations(config),
  };
}
