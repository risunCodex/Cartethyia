/**
 * Account batch-delete endpoints (`POST /accounts/batch-delete` tenant-scoped,
 * `POST /global/accounts/batch-delete` platform-admin).
 *
 * These are the server-side bulk delete the dashboard's bulk-action UI uses.
 * They replace the old N-request fan-out with one `DELETE ... WHERE id IN (...)`
 * statement, one credential-cache invalidation pass, one quota-cache
 * invalidation, one audit row, and one snapshot invalidation. Missing ids are
 * returned in `missing` rather than 404ing the whole batch — the caller wants
 * to know which rows were already gone, and a partial success is the useful
 * answer for a bulk UI.
 *
 * The tenant route is exercised through the deployed gateway (real auth via the
 * world's API key). The global route is exercised on a minimal mounted app with
 * an injected platform-admin decision, because a tenant API key can never hold
 * `platform:admin`.
 */
import { expect, test } from "bun:test";
import { Elysia } from "elysia";
import { and, eq } from "drizzle-orm";
import { createWorld } from "../helpers/fixtures";
import { createTestGateway } from "../helpers/gateway";
import { dbDescribe } from "../helpers/database";
import { adminAuditLog, providerAccounts } from "../../src/persistence/schema";
import { registerAccountQuotaGlobalRoutes } from "../../src/console/quota/account-quota-global";
import { consoleErrorHandler } from "../../src/console/shared/errors";
import { createDefaultProviderRegistry } from "../../src/providers/default-registry";

dbDescribe("account batch-delete", () => {
  test("tenant route deletes several accounts in one statement with one audit row", async () => {
    const world = await createWorld({
      apiKeyOptions: { scopes: ["dashboard:read", "dashboard:write"] },
    });
    const gateway = await createTestGateway();
    try {
      const accA = await world.addAccount({ tenantId: world.tenantId, label: "A" });
      const accB = await world.addAccount({ tenantId: world.tenantId, label: "B" });

      const response = await gateway.json("/console/api/accounts/batch-delete", {
        accountIds: [accA, accB],
      }, { token: world.token });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.ok).toBe(true);
      expect(new Set(body.deleted)).toEqual(new Set([accA, accB]));
      expect(body.missing).toEqual([]);

      // The rows are actually gone.
      const remaining = await gateway.db
        .select({ id: providerAccounts.id })
        .from(providerAccounts)
        .where(and(eq(providerAccounts.id, accA), eq(providerAccounts.id, accB)));
      expect(remaining).toHaveLength(0);

      // Exactly one audit row for the batch, not one per account.
      const audit = await gateway.db
        .select()
        .from(adminAuditLog)
        .where(
          and(
            eq(adminAuditLog.tenantId, world.tenantId),
            eq(adminAuditLog.action, "provider_account.batch_deleted"),
          ),
        );
      expect(audit).toHaveLength(1);
      expect(audit[0]!.target).toBe(world.tenantId);
    } finally {
      await gateway.close();
      await world.cleanup();
    }
  });

  test("tenant route reports missing ids without failing the batch", async () => {
    const world = await createWorld({
      apiKeyOptions: { scopes: ["dashboard:read", "dashboard:write"] },
    });
    const gateway = await createTestGateway();
    try {
      const accountId = await world.addAccount({ tenantId: world.tenantId, label: "keep" });
      const ghost = "00000000-0000-0000-0000-000000000000";

      const response = await gateway.json("/console/api/accounts/batch-delete", {
        accountIds: [accountId, ghost],
      }, { token: world.token });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.deleted).toEqual([accountId]);
      expect(body.missing).toEqual([ghost]);
    } finally {
      await gateway.close();
      await world.cleanup();
    }
  });

  test("tenant route never deletes a global account", async () => {
    const world = await createWorld({
      apiKeyOptions: { scopes: ["dashboard:read", "dashboard:write"] },
    });
    const gateway = await createTestGateway();
    try {
      // `world.accountId` is a shared (tenant_id NULL) account.
      const response = await gateway.json("/console/api/accounts/batch-delete", {
        accountIds: [world.accountId],
      }, { token: world.token });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.deleted).toEqual([]);
      expect(body.missing).toEqual([world.accountId]);
    } finally {
      await gateway.close();
      await world.cleanup();
    }
  });

  test("global route deletes shared accounts and reports missing", async () => {
    const world = await createWorld();
    const gateway = await createTestGateway();
    const adminIdentity = `admin-test-${Math.random().toString(16).slice(2)}`;
    const adminAccess = {
      id: adminIdentity,
      tenantId: null,
      scopes: ["platform:admin"],
      admissionIdentity: adminIdentity,
    } as never;
    const deps = {
      db: gateway.db,
      accessResolver: () => adminAccess,
      redis: undefined,
      snapshotInvalidator: { invalidate: async () => 1 },
      providerRegistry: createDefaultProviderRegistry(),
      resolveCredential: async () => "",
      auditRecorder: undefined,
    } as never;
    const app = new Elysia();
    app.error(consoleErrorHandler("Quota operation failed"));
    registerAccountQuotaGlobalRoutes(app, deps, deps);
    try {
      const accA = await world.addAccount({ tenantId: null, label: "shared-A" });
      const ghost = "00000000-0000-0000-0000-000000000000";

      const response = await app.handle(
        new Request("http://cartethyia.test/global/accounts/batch-delete", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ accountIds: [accA, ghost] }),
        }),
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.deleted).toEqual([accA]);
      expect(body.missing).toEqual([ghost]);

      const remaining = await gateway.db
        .select({ id: providerAccounts.id })
        .from(providerAccounts)
        .where(eq(providerAccounts.id, accA));
      expect(remaining).toHaveLength(0);

      const audit = await gateway.db
        .select()
        .from(adminAuditLog)
        .where(
          and(
            eq(adminAuditLog.action, "provider_account.global.batch_deleted"),
            eq(adminAuditLog.actor, adminIdentity),
          ),
        );
      expect(audit).toHaveLength(1);
    } finally {
      await gateway.close();
      await world.cleanup();
    }
  });
});
