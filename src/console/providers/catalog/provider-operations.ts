/**
 * Provider and account operations for the provider console domain: tenant and
 * global provider CRUD, account lifecycle, account health events, and the
 * decrypted account export.
 *
 * Split out of `routes.ts` so the provider/account operations and the model
 * operations (`model-operations.ts`) each stay a readable unit. Every operation
 * validates access through `requireTenantScope`/`requireGlobalAdmin` first and
 * returns DTOs from `./contracts`; the Elysia wiring for these handlers lives in
 * `routes.ts`.
 */
import type { ConsoleAccessResolver } from "../../auth/access";
import type { AuditSink } from "../../audit/contracts";
import {
  ConsoleDomainError,
  requireGlobalAdmin,
  requireTenantAnyScope,
  requireTenantScope,
} from "../../shared/errors";
import { cachedReadWithEtag, conditionalResponse } from "../../shared/read-through-cache";
import type { RedisClient } from "../../../persistence/redis";
import type { AccessDecision } from "../../../security/access-control";
import type { ProviderUsageDayRow } from "../../../observability/event-query";
import { isBundledProviderId } from "../../../providers/provider-contracts";
import type { ProviderRegistry } from "../../../providers/provider-registry";
import { getProviderClientVersion, getRouteIdentityVersions } from "../../../providers/operations/client-versions";
import type { OAuthLoginField } from "../../../providers/authentication/oauth-flow-store";
import { providerCredentialHint, providerCredentialUrl, providerDisplayName, providerHasAdapterUserAgent, providerOperatorNotice, providerServiceKinds, type CompatibilityProfile } from "../../../providers/provider-metadata";
import type { AccountHealthEventRecord } from "../../../providers/operations/account-health-service";
import { healthEventBuffer } from "../../../persistence/health-event-flush";
import { CREDENTIAL_MODES, PROVIDER_READ_SCOPES, PROVIDER_WRITE_SCOPES, type BuddyGrowthTaskLedgerEntry, type ProviderAccountBulkActionResult, type RefreshAccountTokenResponse } from "./contracts";
import type { RefreshAccountStatusOutcome } from "../../../providers/operations/account-refresh-status";
import { enqueueCheckin } from "../../../workers/daily-checkin";
import {
  isWireFamily,
  validateCompatibilityProfile,
  type CreateProviderAccountBatchResult,
  type CreateProviderAccountRequest,
  type CreateProviderRequest,
  type ProviderAccountExport,
  type ProviderAccountsExportResponse,
  type ProviderAccountResponse,
  type ProviderCatalogStore,
  type ProviderLoginField,
  type ProviderRecord,
  type ProviderResponse,
  type UpdateProviderAccountRequest,
  type UpdateProviderRequest,
} from "./contracts";
/**
 * Asks the quota sweep to claim the daily check-in credit for a just-created
 * account on its next pass.
 *
 * A no-op for every provider outside the buddy family, and it never touches
 * upstream: it records an id and returns, so an import of a hundred accounts
 * still answers as one local write. The sweep that drains this already has the
 * refreshed credential, the egress rotation, and the once-per-day marker, so
 * adding a timer here would only duplicate that work — which is the same
 * reason the check-in has no timer of its own.
 */
function queueNewAccountCheckin(
  providerId: string,
  account: { readonly id: string; readonly tenantId?: string | null },
): void {
  enqueueCheckin({
    accountId: account.id,
    providerId,
    tenantId: account.tenantId ?? null,
  });
}

export function sanitizeProviderResponse(
  provider: unknown,
  includeSecrets = false,
): ProviderResponse {
  if (!provider || typeof provider !== "object")
    throw new ConsoleDomainError("invalid_provider", 400, "Provider must be an object");
  const p = provider as Record<string, unknown>;
  if (typeof p.providerId !== "string" || p.providerId.length === 0)
    throw new ConsoleDomainError("invalid_provider", 400, "Provider providerId is required");
  for (const field of ["enabled", "isBuiltIn", "requiresAccount"] as const) {
    if (p[field] !== undefined && typeof p[field] !== "boolean")
      throw new ConsoleDomainError("invalid_provider", 400, `Provider ${field} must be a boolean`);
  }
  // Both are derived from bundled metadata rather than the persisted record, so
  // a BYOK provider (or a stale row for a provider that gained a page later)
  // always reports the current canonical values.
  const credentialUrl = providerCredentialUrl(p.providerId);
  const credentialHint = providerCredentialHint(p.providerId);
  const operatorNotice = providerOperatorNotice(p.providerId);
  const clientVersion = getProviderClientVersion(p.providerId);
  const response: ProviderResponse = {
    providerId: p.providerId,
    serviceKinds: providerServiceKinds(p.providerId),
    displayName: providerDisplayName(p.providerId),
    enabled: (p.enabled as boolean | undefined) ?? true,
    isBuiltIn: (p.isBuiltIn as boolean | undefined) ?? false,
    requiresAccount: (p.requiresAccount as boolean | undefined) ?? true,
    hasAdapterUserAgent: providerHasAdapterUserAgent(p.providerId),
    // No model advertises search; see the note in provider-metadata.ts.
    supportsWebSearch: false,
    ...(credentialUrl === undefined ? {} : { credentialUrl }),
    ...(credentialHint === undefined ? {} : { credentialHint }),
    ...(operatorNotice === undefined ? {} : { operatorNotice }),
    ...(clientVersion === undefined ? {} : { clientVersion }),
    routeIdentityVersions: getRouteIdentityVersions(),
    supportsModelDiscovery: (p.supportsModelDiscovery as boolean | undefined) ?? !p.isBuiltIn,
    ...(typeof p.createdAt === "string" ? { createdAt: p.createdAt } : {}),
    ...(typeof p.updatedAt === "string" ? { updatedAt: p.updatedAt } : {}),
  };
  if (includeSecrets && p.capabilityProfile)
    response.capabilityProfile = p.capabilityProfile as Record<string, unknown>;
  if (includeSecrets && typeof p.baseUrl === "string") response.baseUrl = p.baseUrl;
  if (includeSecrets && p.compatibilityProfile)
    response.compatibilityProfile = p.compatibilityProfile as CompatibilityProfile;
  if (isWireFamily(p.wireFamilyDefault)) response.wireFamilyDefault = p.wireFamilyDefault;
  // Derived policy, not a secret: always projected. Entries are re-validated so
  // a malformed record narrows to the families the vocabulary admits instead of
  // emitting a value dispatch would reject.
  if (Array.isArray(p.supportedWireFamilies)) {
    const families = p.supportedWireFamilies.filter(isWireFamily);
    if (families.length > 0) response.supportedWireFamilies = families;
  }
  return response;
}


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
async function attachProviderCapabilities(
  response: ProviderResponse,
  registry: ProviderRegistry,
): Promise<ProviderResponse> {
  const supportsDiscovery =
    !response.isBuiltIn || (await registry.resolveModelDiscovery(response.providerId)) !== undefined;
  const client = await registry.resolveLoginClient(response.providerId);
  if (!client) return { ...response, supportsModelDiscovery: supportsDiscovery };
  // Capability is a static property of the client's methods, never of one URL
  // build: a client whose `buildAuthorizeUrl` can throw must still report the
  // browser flow it genuinely supports, otherwise the Login with browser button
  // disappears for a provider that has one.
  //
  // `supportsBrowserCode` is authoritative when the client states it. The base
  // `OAuthClient` always defines `buildAuthorizeUrl` and `exchangeCode` — the
  // device-only clients override the latter to throw — so testing only for the
  // methods reports browser support for every device-only provider (Cline,
  // Grok, Kimi, Muse, Buddy, GitHub, Kilo, xAI). The dashboard then offered "Login with
  // browser" on those rows and the click failed server-side with
  // `browser_code_not_supported`. An explicit `false` suppresses the flow; an
  // omitted flag keeps the method-shape test, since a client that does not
  // state the capability is judged by what it can do.
  const hasBrowserFlow =
    client.supportsBrowserCode === false
      ? false
      : typeof client.buildAuthorizeUrl === "function" &&
        typeof client.exchangeCode === "function";
  return {
    ...response,
    supportsModelDiscovery: supportsDiscovery,
    oauthFlows: {
      browser: hasBrowserFlow,
      device: client.supportsDeviceCode === true && typeof client.startDeviceAuth === "function",
      // The import path is offered only when the client can actually complete
      // one, so the dashboard never renders a form whose submit the server
      // would refuse.
      import: typeof client.importCredential === "function",
      // Both halves are required: an import-only client that cannot refresh
      // (Alibaba Coding Plan, Cloudflare AI) stores a durable static key, while
      // one that can (Trae) stores a token pair that expires and renews. The
      // refresher comes from the registry rather than the login client because
      // that is where `loadAuthentication` registers it.
      refreshable:
        typeof client.importCredential === "function" &&
        (await registry.resolveRefresher(response.providerId)) !== undefined,
      browserLoginFields: (client.browserLoginFields ?? []).map(toProviderLoginField),
      deviceLoginFields: (client.deviceLoginFields ?? []).map(toProviderLoginField),
      importFields: (client.importFields ?? []).map(toProviderLoginField),
    },
  };
}

/** Copies a registry login-field descriptor into the browser-facing contract. */
function toProviderLoginField(field: OAuthLoginField): ProviderLoginField {
  return {
    key: field.key,
    label: field.label,
    ...(field.placeholder === undefined ? {} : { placeholder: field.placeholder }),
    ...(field.secret === undefined ? {} : { secret: field.secret }),
    ...(field.required === undefined ? {} : { required: field.required }),
    ...(field.defaultValue === undefined ? {} : { defaultValue: field.defaultValue }),
    ...(field.options === undefined
      ? {}
      : { options: field.options.map((option) => ({ value: option.value, label: option.label })) }),
  };
}
/** Provider-list cache TTL: short enough that a 60s poll re-checks the DB
 * occasionally, long enough that a warm page does zero per-card work. */
const PROVIDER_LIST_CACHE_TTL_SECONDS = 20;

/** Cache key namespace + shape version for the provider-list overview. */
const PROVIDER_LIST_CACHE_SHAPE = "providers:v1:list";

/** Version of the read-through cache backend, so a bump is a key rotation. */
const PROVIDER_LIST_CACHE_REVISION = 1;

/** The list projection shared by `listProviders` and its cached wrapper. */
async function computeProviderList(
  config: ProviderCatalogConfig,
  tenantId: string,
): Promise<ProviderResponse[]> {
  const [records, accountCounts, modelCounts] = await Promise.all([
    config.store.list(tenantId),
    config.store.providerAccountCounts(tenantId),
    config.store.providerModelCounts(tenantId),
  ]);
  const accountsByProvider = new Map(accountCounts.map((row) => [row.providerId, row]));
  const modelsByProvider = new Map(modelCounts.map((row) => [row.providerId, row.count]));
  return Promise.all(
    records.map((r) => {
      const counts = accountsByProvider.get(r.providerId);
      return attachProviderCapabilities(
        {
          ...sanitizeProviderResponse(r),
          // A provider with no persisted accounts is not "configured"; the
          // count fields are still present (zero) so the card renders the
          // empty state instead of a loading placeholder.
          configured: counts !== undefined,
          accountCount: counts?.total ?? 0,
          activeAccountCount: counts?.active ?? 0,
          modelCount: modelsByProvider.get(r.providerId) ?? 0,
        },
        config.providerRegistry,
      );
    }),
  );
}

export function createProviderCatalogOperations(config: ProviderCatalogConfig) {
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
          requiresAccount: true,
          ...(request.label === undefined ? {} : { label: request.label }),
          ...(request.capabilityProfile === undefined
            ? {}
            : { capabilityProfile: request.capabilityProfile }),
          ...(request.baseUrl === undefined ? {} : { baseUrl: request.baseUrl }),
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
    async listAccounts(
        access: AccessDecision | undefined,
        providerId: string,
      ): Promise<readonly ProviderAccountResponse[]> {
        const a = requireTenantAnyScope(access, PROVIDER_READ_SCOPES);
        return config.store.listAccounts(a.tenantId, providerId);
      },
    async createAccount(
        access: AccessDecision | undefined,
        providerId: string,
        request: CreateProviderAccountRequest,
      ): Promise<ProviderAccountResponse> {
        const a = requireTenantAnyScope(access, PROVIDER_WRITE_SCOPES);
        if (
          request.credentialKind !== "api_key" &&
          request.credentialKind !== "oauth" &&
          request.credentialKind !== "none"
        ) {
          throw new ConsoleDomainError(
            "invalid_request",
            400,
            "credentialKind must be api_key, oauth, or none",
          );
        }
        if (
          request.credentialMode !== undefined &&
          !(CREDENTIAL_MODES as readonly string[]).includes(request.credentialMode)
        ) {
          throw new ConsoleDomainError(
            "invalid_request",
            400,
            "credentialMode must be auto, jwt, or api_key",
          );
        }
        const created = await config.store.createAccount(
          a.tenantId,
          providerId,
          request,
        );
        queueNewAccountCheckin(providerId, created);
        await config.auditSink?.record({
          access: a,
          action: "provider_account.created",
          target: created.id,
          detail: { providerId, credentialKind: request.credentialKind },
        });
        await config.snapshotInvalidator?.invalidate();
        return created;
      },
    /**
     * Creates many accounts in one round-trip.
     *
     * The per-item validation is the same `createAccount` path the single route
     * uses, so a batch cannot accept a shape the single create rejects. The
     * expensive per-account bookkeeping — the audit row and the routing snapshot
     * invalidation that forces a 10-table catalog rebuild — is done ONCE for the
     * whole batch instead of once per account, so cost does not scale linearly
     * with paste size the way a client-side loop over single creates would.
     *
     * Email/label enrichment is deliberately NOT done here. Persisting the
     * credential is local work (encrypt + hash + insert) and needs no upstream;
     * parsing identity out of a JWT or probing the provider is what made an
     * import feel slow, so it happens in the background sweep instead.
     */
    async createAccountBatch(
      access: AccessDecision | undefined,
      providerId: string,
      requests: readonly CreateProviderAccountRequest[],
    ): Promise<CreateProviderAccountBatchResult> {
      const a = requireTenantAnyScope(access, PROVIDER_WRITE_SCOPES);
      if (requests.length === 0) {
        return { created: 0, failed: 0, results: [] };
      }
      for (const request of requests) {
        if (
          request.credentialKind !== "api_key" &&
          request.credentialKind !== "oauth" &&
          request.credentialKind !== "none"
        ) {
          throw new ConsoleDomainError(
            "invalid_request",
            400,
            "credentialKind must be api_key, oauth, or none",
          );
        }
        if (
          request.credentialMode !== undefined &&
          !(CREDENTIAL_MODES as readonly string[]).includes(request.credentialMode)
        ) {
          throw new ConsoleDomainError(
            "invalid_request",
            400,
            "credentialMode must be auto, jwt, or api_key",
          );
        }
      }

      const result = await config.store.createAccountBatch(a.tenantId, providerId, requests);
      for (const created of result.results) {
        if (created.account !== undefined) queueNewAccountCheckin(providerId, created.account);
      }

      // One audit row per batch, written after the batch lands rather than
      // awaited per account inside the request path.
      if (result.created > 0) {
        await config.auditSink?.record({
          access: a,
          action: "provider_account.batch_created",
          target: providerId,
          detail: {
            providerId,
            created: result.created,
            failed: result.failed,
          },
        });
      }
      // A single invalidation for the whole batch: this drops the cached route
      // snapshot, so the next dispatch rebuilds the catalog once.
      if (result.created > 0) {
        await config.snapshotInvalidator?.invalidate();
      }
      return result;
    },
    async updateAccount(
        access: AccessDecision | undefined,
        providerId: string,
        accountId: string,
        request: UpdateProviderAccountRequest,
      ): Promise<ProviderAccountResponse> {
        const a = requireTenantAnyScope(access, PROVIDER_WRITE_SCOPES);
        const updated = await config.store.updateAccount(
          a.tenantId,
          providerId,
          accountId,
          request,
        );
        if (!updated)
          throw new ConsoleDomainError("account_not_found", 404, `Account ${accountId} not found`);
        await config.auditSink?.record({
          access: a,
          action:
            request.status === "disabled" ? "provider_account.revoked" : "provider_account.updated",
          target: accountId,
          detail: { providerId, fields: Object.keys(request) },
        });
        await config.snapshotInvalidator?.invalidate();
        return updated;
      },
    async listAccountHealthEvents(
        access: AccessDecision | undefined,
        providerId: string,
        accountId: string,
      ): Promise<readonly AccountHealthEventRecord[]> {
        const a = requireTenantAnyScope(access, PROVIDER_READ_SCOPES);
        return config.store.listAccountHealthEvents(a.tenantId, providerId, accountId);
      },
    async purgeAccountHealthEvents(
        access: AccessDecision | undefined,
        providerId: string,
        accountId: string,
      ): Promise<{ deleted: number }> {
        const a = requireTenantAnyScope(access, PROVIDER_WRITE_SCOPES);
        // Barrier before the delete: buffered rows for this account must not
        // land after the purge counted them gone, or the modal refetch shows
        // ghost history the operator just purged.
        await healthEventBuffer()?.drain(accountId);
        const deleted = await config.store.purgeAccountHealthEvents(a.tenantId, providerId, accountId);
        await config.auditSink?.record({
          access: a,
          action: "provider_account.health_events_purged",
          target: accountId,
          detail: { providerId, deleted },
        });
        return { deleted };
      },
    async listBuddyGrowthTasks(
      access: AccessDecision | undefined,
      providerId: string,
      accountId: string,
      dayKey: string,
    ): Promise<readonly BuddyGrowthTaskLedgerEntry[]> {
      const a = requireTenantAnyScope(access, PROVIDER_READ_SCOPES);
      return config.store.listBuddyGrowthTasks(a.tenantId, providerId, accountId, dayKey);
    },
    async recoverAccount(
        access: AccessDecision | undefined,
        providerId: string,
        accountId: string,
      ): Promise<{ success: boolean }> {
        const a = requireTenantAnyScope(access, PROVIDER_WRITE_SCOPES);
        const ok = await config.store.recoverAccount(a.tenantId, providerId, accountId);
        if (!ok)
          throw new ConsoleDomainError("account_not_found", 404, `Account ${accountId} not found`);
        await config.auditSink?.record({
          access: a,
          action: "provider_account.recovered",
          target: accountId,
          detail: { providerId },
        });
        await config.snapshotInvalidator?.invalidate();
        return { success: true };
      },
    /**
     * One UPDATE over the tenant's cooling accounts, with `cooldownUntil` and
     * `modelCooldowns` preserved as evidence (D07/D08). Shared rows are not
     * writable here: the platform-admin pair of routes owns them (D10).
     */
    async disableCooldowns(
      access: AccessDecision | undefined,
      providerId: string,
    ): Promise<ProviderAccountBulkActionResult> {
      const a = requireTenantAnyScope(access, PROVIDER_WRITE_SCOPES);
      const result = await config.store.disableCooldowns(a.tenantId, providerId);
      await config.auditSink?.record({
        access: a,
        action: "provider_account.bulk_disabled_cooldowns",
        target: providerId,
        detail: { providerId, updated: result.updated, globalSkipped: result.globalSkipped },
      });
      await config.snapshotInvalidator?.invalidate();
      return { ok: true, updated: result.updated, globalSkipped: result.globalSkipped };
    },
    /**
     * One DELETE over the tenant's strictly banned accounts (D12). Empty
     * matches are a successful no-op, so a second click is idempotent.
     */
    async deleteBanned(
      access: AccessDecision | undefined,
      providerId: string,
    ): Promise<ProviderAccountBulkActionResult> {
      const a = requireTenantAnyScope(access, PROVIDER_WRITE_SCOPES);
      const result = await config.store.deleteBanned(a.tenantId, providerId);
      await config.auditSink?.record({
        access: a,
        action: "provider_account.bulk_deleted_banned",
        target: providerId,
        detail: {
          providerId,
          deleted: result.deleted ?? [],
          missing: result.missing ?? [],
          globalSkipped: result.globalSkipped,
        },
      });
      await config.snapshotInvalidator?.invalidate();
      return {
        ok: true,
        updated: 0,
        deleted: result.deleted ?? [],
        missing: result.missing ?? [],
        globalSkipped: result.globalSkipped,
      };
    },
    async refreshAccountToken(
        access: AccessDecision | undefined,
        providerId: string,
        accountId: string,
      ): Promise<RefreshAccountTokenResponse> {
        // The refresh changes no routing state and is a per-account operator
        // action, so the browser session's own write scope is sufficient.
        const a = requireTenantScope(access, "dashboard:write");
        // 404 unless the account exists and belongs to this provider/tenant.
        const accounts = await config.store.listAccounts(a.tenantId, providerId);
        const owned = accounts.find((account) => account.id === accountId && account.tenantId === a.tenantId);
        if (!owned)
          throw new ConsoleDomainError("account_not_found", 404, `Account ${accountId} not found`);
        // 409 for a static token (nothing to re-mint), 400 for non-OAuth —
        // before calling the refresher, so the row is never touched on a
        // rejectable request.
        if (owned.staticToken === true)
          throw new ConsoleDomainError("static_token", 409, "Account carries a static token that cannot be refreshed");
        if (owned.credentialKind !== "oauth")
          throw new ConsoleDomainError("not_oauth", 400, "Account is not OAuth; token refresh is not applicable");
        if (!config.refreshAccountStatus)
          throw new ConsoleDomainError("refresh_unavailable", 501, "Token refresh is not configured on this host");
        const outcome = await config.refreshAccountStatus(accountId, { origin: "ui" });
        await config.auditSink?.record({
          access: a,
          action: "provider_account.token_refreshed",
          target: accountId,
          detail: {
            providerId,
            ok: outcome.ok,
            statusAfter: outcome.statusAfter,
            ...(outcome.error === undefined ? {} : { error: outcome.error }),
          },
        });
        await config.snapshotInvalidator?.invalidate();
        return {
          ok: outcome.ok,
          statusAfter: outcome.statusAfter,
          ...(outcome.tokenRefreshed ? { tokenRefreshed: true } : {}),
          ...(outcome.expiresAt === undefined ? {} : { expiresAt: outcome.expiresAt }),
          ...(outcome.refreshedAt === undefined ? {} : { refreshedAt: outcome.refreshedAt }),
          ...(outcome.error === undefined ? {} : { error: outcome.error }),
          ...(outcome.category === undefined ? {} : { category: outcome.category }),
        };
      },
    /**
     * Exports the requested accounts with their decrypted credentials.
     *
     * Secret material leaves the process here, so the audit entry records the
     * account ids but never the returned values. `accountIds` is required and
     * scoped to the caller's tenant; ids that do not belong to the provider
     * (or the tenant) are silently skipped.
     *
     * Only tenant-owned accounts are eligible: `listAccounts` also returns
     * pool-wide global accounts (tenantId null), and a tenant must never be
     * able to decrypt another deployment's shared credentials.
     */
    async exportAccounts(
        access: AccessDecision | undefined,
        providerId: string,
        accountIds: readonly string[],
      ): Promise<ProviderAccountsExportResponse> {
        const a = requireTenantAnyScope(access, PROVIDER_WRITE_SCOPES);
        const owned = await config.store.listAccounts(a.tenantId, providerId);
        const wanted = new Set(accountIds);
        const selected = owned.filter(
          (account) => wanted.has(account.id) && account.tenantId === a.tenantId,
        );
        const authStates = await config.store.listAccountAuthStates(
          a.tenantId,
          providerId,
          selected.map((account) => account.id),
        );
        const accounts = await Promise.all(
          selected.map(async (account): Promise<ProviderAccountExport> => {
            let accessToken = "";
            let refreshToken: string | undefined;
            if (config.resolveExportCredentials) {
              try {
                const credentials = await config.resolveExportCredentials(providerId, account.id);
                accessToken = credentials.accessToken;
                refreshToken = credentials.refreshToken;
              } catch {
                // A refresh failure must not abort the whole export; the
                // account still exports its metadata with empty credentials.
              }
            }
            return {
              id: account.id,
              providerId: account.providerId,
              label: account.label,
              credentialKind: account.credentialKind,
              status: account.status,
              accessToken,
              ...(refreshToken === undefined ? {} : { refreshToken }),
              // Non-secret auth state is part of the credential export: without
              // it a re-import loses the upstream user id and region that Trae
              // refresh and dispatch are addressed by.
              ...(await (async () => {
                const authState = authStates[account.id];
                // Buddy providers bind a per-account device identity
                // (qimei36) that is normally derived from the INTERNAL account
                // id. Export must materialize that raw binding into the
                // exported auth state — otherwise a re-import mints a new
                // account id, the derived binding changes, and the upstream
                // channel check (11128) rejects the imported account.
                const materialized =
                  account.providerId === "cb" ||
                  account.providerId === "cbcn"
                    // dynamic-import: B-02 lazy graph — buddy device-binding materializer, buddy-family only.
                    // The buddy-identity graph is lazy-loaded: the device-binding
                    // materializer only runs for buddy-family accounts (B-02).
                    ? (await import("../../../providers/integrations/buddy/buddy-identity"))
                        .materializeBuddyDeviceBinding(account.id, authState)
                    : undefined;
                const effectiveAuthState = materialized ?? authState;
                return effectiveAuthState !== undefined && Object.keys(effectiveAuthState).length > 0
                  ? { authState: effectiveAuthState }
                  : {};
              })()),
              ...(account.inflight === undefined ? {} : { inflight: account.inflight }),
              createdAt: account.createdAt,
              ...(account.cooldownUntil ? { cooldownUntil: account.cooldownUntil } : {}),
              ...(account.lastErrorCategory
                ? { lastErrorCategory: account.lastErrorCategory }
                : {}),
            };
          }),
        );
        await config.auditSink?.record({
          access: a,
          action: "provider_account.exported",
          target: providerId,
          detail: { providerId, accountIds: accounts.map((account) => account.id) },
        });
        return { exportedAt: new Date().toISOString(), accounts };
      },
  };
  return operations;
}
