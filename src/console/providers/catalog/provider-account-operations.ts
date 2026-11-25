/**
 * Account operations for the provider console domain: account lifecycle,
 * health events, bulk actions, token refresh, and the decrypted export.
 * Extracted from `provider-operations.ts`; the provider operations stay in
 * `provider-operations.ts` and the response projection in
 * `provider-operations-projection.ts`. Every operation validates access
 * through `requireTenantScope`/`requireGlobalAdmin` first and returns DTOs
 * from `./contracts`; the Elysia wiring lives in `routes.ts`.
 */
import {
  ConsoleDomainError,
  requireGlobalAdmin,
  requireTenantAnyScope,
  requireTenantScope,
} from "../../shared/errors";
import type { AccessDecision } from "../../../security/access-control";
import { healthEventBuffer } from "../../../persistence/health-event-flush";
import { CREDENTIAL_MODES, PROVIDER_READ_SCOPES, PROVIDER_WRITE_SCOPES, type BuddyGrowthTaskLedgerEntry, type ProviderAccountBulkActionResult, type RefreshAccountTokenResponse } from "./contracts";
import { enqueueCheckin } from "../../../workers/daily-checkin";
import type {
  CreateProviderAccountBatchResult,
  CreateProviderAccountRequest,
  ProviderAccountExport,
  ProviderAccountsExportResponse,
  ProviderAccountResponse,
  UpdateProviderAccountRequest,
} from "./contracts";
import type { AccountHealthEventRecord } from "../../../providers/operations/account-health-service";
import type { ProviderCatalogConfig } from "./provider-operations";
import { pickDefined } from "../../shared/object";

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

export function createProviderAccountOperations(config: ProviderCatalogConfig) {
  async function executeAccountTokenRefresh(
    access: AccessDecision,
    providerId: string,
    accountId: string,
    target: { readonly staticToken: boolean; readonly credentialKind: string },
  ): Promise<RefreshAccountTokenResponse> {
    // 409 for a static token (nothing to re-mint), 400 for non-OAuth —
    // before calling the refresher, so the row is never touched on a
    // rejectable request.
    if (target.staticToken)
      throw new ConsoleDomainError("static_token", 409, "Account carries a static token that cannot be refreshed");
    if (target.credentialKind !== "oauth")
      throw new ConsoleDomainError("not_oauth", 400, "Account is not OAuth; token refresh is not applicable");
    if (!config.refreshAccountStatus)
      throw new ConsoleDomainError("refresh_unavailable", 501, "Token refresh is not configured on this host");
    const outcome = await config.refreshAccountStatus(accountId, { origin: "ui" });
    await config.auditSink?.record({
      access,
      action: "provider_account.token_refreshed",
      target: accountId,
      detail: {
        providerId,
        ok: outcome.ok,
        statusAfter: outcome.statusAfter,
        ...pickDefined({ error: outcome.error }),
      },
    });
    await config.snapshotInvalidator?.invalidate();
    return {
      ok: outcome.ok,
      statusAfter: outcome.statusAfter,
      ...(outcome.tokenRefreshed ? { tokenRefreshed: true } : {}),
      ...pickDefined({ expiresAt: outcome.expiresAt }),
      ...pickDefined({ refreshedAt: outcome.refreshedAt }),
      ...pickDefined({ error: outcome.error }),
      ...pickDefined({ category: outcome.category }),
    };
  }
  const operations = {
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
        // Owned accounts belong to the caller's tenant; platform admins may
        // also refresh shared/global (`tenant_id IS NULL`) accounts.
        const target =
          (await config.store.getOwnedAccount(a.tenantId, providerId, accountId)) ??
          (a.scopes.includes("platform:admin")
            ? await config.store.getGlobalAccount(providerId, accountId)
            : undefined);
        if (!target)
          throw new ConsoleDomainError("account_not_found", 404, `Account ${accountId} not found`);
        return executeAccountTokenRefresh(a, providerId, accountId, target);
      },
    async refreshGlobalAccountToken(
        access: AccessDecision | undefined,
        providerId: string,
        accountId: string,
      ): Promise<RefreshAccountTokenResponse> {
        const a = requireGlobalAdmin(access);
        const target = await config.store.getGlobalAccount(providerId, accountId);
        if (!target)
          throw new ConsoleDomainError("account_not_found", 404, `Account ${accountId} not found`);
        return executeAccountTokenRefresh(a, providerId, accountId, target);
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
              ...pickDefined({ refreshToken }),
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
                    ? (await import("../../../providers/integrations/buddy/headers"))
                        .materializeBuddyDeviceBinding(account.id, authState)
                    : undefined;
                const effectiveAuthState = materialized ?? authState;
                return effectiveAuthState !== undefined && Object.keys(effectiveAuthState).length > 0
                  ? { authState: effectiveAuthState }
                  : {};
              })()),
              ...pickDefined({ inflight: account.inflight }),
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
