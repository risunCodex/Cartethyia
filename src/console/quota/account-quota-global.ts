import { t } from "elysia";
import type { Elysia } from "elysia";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { liveModelCooldownExistsSql } from "../../persistence/dialect";
import { adminAuditLog, providerAccounts } from "../../persistence/schema";
import { requireGlobalAdmin } from "../shared/errors";
import {
  GLOBAL_QUOTA_LENS,
  invalidateQuotaCache,
  invalidateQuotaCaches,
} from "../../providers/quota/cache";
import {
  invalidateCredentialCache,
  invalidateCredentialCaches,
} from "../../providers/operations/provider-credential-service";
import {
  QUOTA_REFRESH_TIMEOUT_MS,
  loadQuotaTarget,
  refreshAccountQuota,
  signalFetch,
  timeoutSignal,
  type QuotaRefreshDeps,
} from "../../providers/quota/refresh";
import { sanitizeGlobalAccount } from "./quota-view";
import {
  resolveNextAccountStatus,
  type AccountQuotaRoutesDeps,
} from "./account-quota-shared";
import type { ProviderAccountBulkActionResult } from "../providers/catalog/contracts";

/**
 * The same live-cooldown predicate as the tenant-scoped store, evaluated in
 * SQL so one statement covers the whole shared-account set. `status='cooldown'`
 * counts even when its deadline elapsed; a live `model_cooldowns` entry counts
 * even while `status` is still `active` (D07). A row already `disabled` does
 * not: disable keeps the deadline columns as evidence, and counting them would
 * make a second pass look like it still has work. Scoped strictly to shared
 * rows (`tenant_id IS NULL`); the shared JSON subquery lives in the dialect
 * module.
 */
function globalLiveCooldownPredicate(database: unknown): ReturnType<typeof and> {
  const nowIso = new Date().toISOString();
  return and(
    isNull(providerAccounts.tenantId),
    sql`${providerAccounts.status} <> 'disabled'`,
    sql`${providerAccounts.status} = 'cooldown' OR ${providerAccounts.cooldownUntil} > ${nowIso} OR ${liveModelCooldownExistsSql(database, nowIso)}`,
  )!;
}

/**
 * Registers the platform-admin account/quota routes onto `app`. Every route here
 * authorises through `requireGlobalAdmin` and operates on shared accounts
 * (`tenant_id IS NULL`).
 */
export function registerAccountQuotaGlobalRoutes(
  app: Elysia,
  deps: AccountQuotaRoutesDeps,
  refreshDeps: QuotaRefreshDeps,
): void {
  const { db, accessResolver, redis, snapshotInvalidator } = deps;
  /**
   * The two bulk actions are one statement each, scoped strictly to shared
   * rows. Neither action takes a provider filter: the global-admin surface
   * lists shared accounts across providers, and the same health predicate
   * defines the target set everywhere.
   */
  const runGlobalBulk = async (
    kind: "disable" | "delete",
  ): Promise<ProviderAccountBulkActionResult> => {
    if (kind === "disable") {
      const updated = await db
        .update(providerAccounts)
        .set({ status: "disabled" })
        .where(globalLiveCooldownPredicate(db))
        .returning({ id: providerAccounts.id });
      invalidateCredentialCaches(updated.map((row) => row.id));
      await snapshotInvalidator?.invalidate();
      return { ok: true, updated: updated.length, globalSkipped: 0 };
    }
    const deleted = await db
      .delete(providerAccounts)
      .where(
        and(
          isNull(providerAccounts.tenantId),
          eq(providerAccounts.status, "disabled"),
          eq(providerAccounts.lastErrorCategory, "policy_blocked_banned"),
        ),
      )
      .returning({ id: providerAccounts.id });
    const deletedIds = deleted.map((row) => row.id);
    invalidateCredentialCaches(deletedIds);
    await invalidateQuotaCaches(GLOBAL_QUOTA_LENS, deletedIds, redis);
    await snapshotInvalidator?.invalidate();
    return {
      ok: true,
      updated: 0,
      deleted: deletedIds,
      missing: [],
      globalSkipped: 0,
    };
  };
  app
    .get("/global/accounts", async ({ request }) => {
      requireGlobalAdmin(accessResolver(request));
      const rows = await db
        .select()
        .from(providerAccounts)
        .where(isNull(providerAccounts.tenantId));
      return { accounts: rows.map(sanitizeGlobalAccount) };
    })
    .patch(
      "/global/accounts/:id",
      {
        body: t.Object({
          active: t.Optional(t.Boolean()),
          status: t.Optional(t.String()),
        }),
      },
      async ({ request, params, body, set }) => {
        const access = requireGlobalAdmin(accessResolver(request));
        const resolved = resolveNextAccountStatus(body);
        if (!resolved.ok) {
          set.status = resolved.status;
          return resolved.body;
        }
        const nextStatus = resolved.nextStatus;
        const updated = await db
          .update(providerAccounts)
          .set({ status: nextStatus })
          .where(
            and(
              eq(providerAccounts.id, params.id),
              isNull(providerAccounts.tenantId),
            ),
          )
          .returning({ id: providerAccounts.id });
        if (updated.length === 0) {
          set.status = 404;
          return { error: `Global account ${params.id} not found`, code: "not_found" };
        }
        await snapshotInvalidator?.invalidate();
        await db.insert(adminAuditLog).values({
          actor: access.admissionIdentity,
          action: "provider_account.global.updated",
          target: params.id,
          detail: { status: nextStatus },
        });
        return { ok: true, status: 200 };
      },
    )
    .delete("/global/accounts/:id", async ({ request, params, set }) => {
      const access = requireGlobalAdmin(accessResolver(request));
      const accountId = params.id;
      // Global accounts carry `tenant_id IS NULL`, so the tenant-scoped
      // `DELETE /accounts/:id` can never match them (`NULL = <uuid>` is never
      // true) — the console's delete button 404'd on every shared account.
      // This route is the global-admin counterpart, scoped by `isNull` instead
      // of a tenant id.
      const deleted = await db
        .delete(providerAccounts)
        .where(and(eq(providerAccounts.id, accountId), isNull(providerAccounts.tenantId)))
        .returning({ id: providerAccounts.id });
      if (deleted.length === 0) {
        set.status = 404;
        return { error: `Global account ${accountId} not found`, code: "not_found" };
      }
      invalidateCredentialCache(accountId);
      // Global accounts cache their quota under the shared lens, so that is the
      // entry to drop — nothing can make the value meaningful again.
      await invalidateQuotaCache(GLOBAL_QUOTA_LENS, accountId, redis);
      await snapshotInvalidator?.invalidate();
      await db.insert(adminAuditLog).values({
        actor: access.admissionIdentity,
        action: "provider_account.global.deleted",
        target: accountId,
      });
      return { success: true };
    })
    .post("/global/accounts/batch-delete", {
      body: t.Object({
        accountIds: t.Array(t.String()),
      }),
    }, async ({ request, body }) => {
      const access = requireGlobalAdmin(accessResolver(request));
      const accountIds = [...new Set(body.accountIds)];
      if (accountIds.length === 0) {
        return { ok: true, deleted: [], missing: [] };
      }
      // One DELETE statement scoped to shared accounts only: a tenant-owned row
      // (`tenant_id IS NOT NULL`) is never matchable by a global admin, so it
      // lands in `missing`.
      const deleted = await db
        .delete(providerAccounts)
        .where(and(inArray(providerAccounts.id, accountIds), isNull(providerAccounts.tenantId)))
        .returning({ id: providerAccounts.id });
      const deletedIds = deleted.map((row) => row.id);
      const deletedSet = new Set(deletedIds);
      const missing = accountIds.filter((id) => !deletedSet.has(id));
      invalidateCredentialCaches(deletedIds);
      await invalidateQuotaCaches(GLOBAL_QUOTA_LENS, deletedIds, redis);
      await snapshotInvalidator?.invalidate();
      await db.insert(adminAuditLog).values({
        actor: access.admissionIdentity,
        action: "provider_account.global.batch_deleted",
        target: "global",
        detail: { deleted: deletedIds, missing },
      });
      return { ok: true, deleted: deletedIds, missing };
    })
    /**
     * Global counterparts of the provider-detail bulk actions (D10): shared
     * accounts carry `tenant_id IS NULL`, so the tenant-scoped pair can never
     * match them. Both are one statement, one audit row, one snapshot
     * invalidation, and authorize through `requireGlobalAdmin`.
     */
    .post("/global/accounts/actions/disable-cooldowns", async ({ request }) => {
      const access = requireGlobalAdmin(accessResolver(request));
      const { ok, updated, globalSkipped } = await runGlobalBulk("disable");
      await db.insert(adminAuditLog).values({
        actor: access.admissionIdentity,
        action: "provider_account.bulk_disabled_cooldowns",
        target: "global",
        detail: { updated, globalSkipped },
      });
      return { ok, updated, globalSkipped };
    })
    .post("/global/accounts/actions/delete-banned", async ({ request }) => {
      const access = requireGlobalAdmin(accessResolver(request));
      const { ok, updated, deleted, missing, globalSkipped } = await runGlobalBulk("delete");
      await db.insert(adminAuditLog).values({
        actor: access.admissionIdentity,
        action: "provider_account.bulk_deleted_banned",
        target: "global",
        detail: { deleted: deleted ?? [], missing: missing ?? [], globalSkipped },
      });
      return { ok, updated, deleted: deleted ?? [], missing: missing ?? [], globalSkipped };
    })
    .post("/global/accounts/:id/quota/refresh", async ({ request, params, set }) => {
      const access = requireGlobalAdmin(accessResolver(request));
      const target = await loadQuotaTarget(db, params.id, null);
      if (!target) {
        set.status = 404;
        return { error: `Global account ${params.id} not found`, code: "not_found" };
      }
      const outcome = await refreshAccountQuota(
        refreshDeps,
        target,
        signalFetch(timeoutSignal(request.signal, QUOTA_REFRESH_TIMEOUT_MS)),
      );
      if (outcome.failure === "missing_credential") {
        set.status = 400;
        return { error: "Global account has no stored credential", code: "missing_credential" };
      }
      if (outcome.quota.error !== null) {
        set.status = 502;
        return {
          ok: false,
          error: outcome.quota.error,
          code: "quota_fetch_failed",
        };
      }
      await db.insert(adminAuditLog).values({
        actor: access.admissionIdentity,
        action: "provider_account.global.refreshed",
        target: target.accountId,
        detail: { providerId: target.providerId },
      });
      return { ok: true, status: 200, accountId: target.accountId };
    });
}
