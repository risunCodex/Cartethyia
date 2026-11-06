/**
 * Provider-detail bulk actions (area 02).
 *
 * `disable-cooldowns` is one UPDATE whose predicate is the exact cooldown
 * definition the account badge uses: `status='cooldown' OR cooldown_until > now
 * OR model_cooldowns` carries a live entry. It preserves the deadline and the
 * per-model map as evidence. `delete-banned` is one DELETE strictly over
 * `status='disabled' AND last_error_category='policy_blocked_banned'`. Both
 * are tenant-scoped, idempotent, and never touch a pool-as-account row.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Elysia } from "elysia";
import { eq } from "drizzle-orm";
import {
  applySqliteMigrations,
  buildSqliteHandle,
  createSqliteDatabase,
} from "../../src/persistence/db-sqlite";
import {
  adminAuditLog,
  networkPools,
  providerAccounts,
  providerPoolAccounts,
  providers,
  tenants,
} from "../../src/persistence/schema";
import { DrizzleProviderCatalogStore } from "../../src/console/providers/catalog/store";
import { createProviderCatalogRoutes } from "../../src/console/providers/catalog/routes";
import { consoleErrorHandler } from "../../src/console/shared/errors";
import { registerAccountQuotaGlobalRoutes } from "../../src/console/quota/account-quota-global";
import { AuditRecorder } from "../../src/console/auth/audit-recorder";
import { ProviderRegistry } from "../../src/providers/provider-registry";
import type { AccessDecision } from "../../src/security/access-control";
import type { CartethyiaDatabase } from "../../src/persistence/db-handle";

const PROVIDER_ID = "bulk-provider";

function removeDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Windows may hold the temp file briefly; it is disposable.
  }
}

interface Fixture {
  readonly db: CartethyiaDatabase;
  readonly tenantId: string;
  readonly app: Elysia;
  readonly audit: AuditRecorder;
  readonly setAccess: (access: AccessDecision | undefined) => void;
  readonly invalidations: number[];
  readonly cleanup: () => void;
}

async function fixture(): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), "carte-bulk-actions-"));
  const sqlite = createSqliteDatabase(join(dir, "cartethyia.sqlite"));
  await applySqliteMigrations(sqlite);
  const db = buildSqliteHandle(sqlite).db;
  const [tenant] = await db
    .insert(tenants)
    .values({ name: "bulk-tenant", status: "active" })
    .returning({ id: tenants.id });
  const tenantId = tenant!.id;
  await db.insert(providers).values({ id: PROVIDER_ID, tenantId, enabled: true });
  const store = new DrizzleProviderCatalogStore(db, {
    telemetryBuffer: { enqueue() {} } as never,
    bundledModelCatalog: { modelsByProvider: new Map() },
    providerRegistry: new ProviderRegistry(),
    outboundFetchFor: () => fetch as never,
    snapshotInvalidator: { invalidate() {} },
  });
  let access: AccessDecision | undefined = {
    id: "operator",
    tenantId,
    scopes: ["providers:write"],
    admissionIdentity: "operator",
  };
  const audit = new AuditRecorder(db);
  const invalidations: number[] = [];
  const app = new Elysia();
  app.error(consoleErrorHandler("Provider catalog operation failed"));
  app.use(createProviderCatalogRoutes({
    store,
    accessResolver: () => access,
    auditSink: audit,
    providerRegistry: new ProviderRegistry(),
    snapshotInvalidator: { invalidate: async () => { invalidations.push(1); return 1; } },
  }));
  return {
    db,
    tenantId,
    app,
    audit,
    setAccess: (next) => { access = next; },
    invalidations,
    cleanup: () => {
      try { sqlite.close(); } catch { /* closed */ }
      removeDir(dir);
    },
  };
}

type AccountPatch = Partial<typeof providerAccounts.$inferInsert>;

async function addAccount(
  db: CartethyiaDatabase,
  tenantId: string | null,
  label: string,
  patch: AccountPatch = {},
): Promise<string> {
  const [row] = await db
    .insert(providerAccounts)
    .values({
      providerId: PROVIDER_ID,
      tenantId,
      label,
      credentialKind: "api_key",
      status: "active",
      ...patch,
    })
    .returning({ id: providerAccounts.id });
  return row!.id;
}

async function post(app: Elysia, action: "disable-cooldowns" | "delete-banned"): Promise<Response> {
  return app.handle(new Request(`http://localhost/providers/${PROVIDER_ID}/accounts/actions/${action}`, {
    method: "POST",
  }));
}

async function statusOf(db: CartethyiaDatabase, id: string) {
  const [row] = await db.select().from(providerAccounts).where(eq(providerAccounts.id, id));
  return row;
}

describe("provider detail bulk actions", () => {
  test("disable-cooldowns touches only cooling accounts and preserves evidence", async () => {
    const fx = await fixture();
    try {
      const cooling = await addAccount(fx.db, fx.tenantId, "status-cooldown", {
        status: "cooldown",
        cooldownUntil: new Date(Date.now() + 60_000),
      });
      const futureDeadline = await addAccount(fx.db, fx.tenantId, "deadline", {
        status: "active",
        cooldownUntil: new Date(Date.now() + 60_000),
      });
      const modelCooling = await addAccount(fx.db, fx.tenantId, "model-cooldown", {
        modelCooldowns: { "some-model": new Date(Date.now() + 60_000).toISOString() },
      });
      const expiredModel = await addAccount(fx.db, fx.tenantId, "expired-model", {
        modelCooldowns: { "some-model": new Date(Date.now() - 60_000).toISOString() },
      });
      const healthy = await addAccount(fx.db, fx.tenantId, "healthy");
      const alreadyDisabled = await addAccount(fx.db, fx.tenantId, "disabled", {
        status: "disabled",
      });
      const shared = await addAccount(fx.db, null, "shared", { status: "cooldown" });
      // A pool-as-account row with the same provider is a different table and
      // must never be mutated by either action.
      const [pool] = await fx.db.insert(networkPools).values({
        tenantId: fx.tenantId,
        kind: "http",
        endpointConfig: { host: "127.0.0.1", port: 8080 },
      }).returning({ id: networkPools.id });
      await fx.db.insert(providerPoolAccounts).values({
        providerId: PROVIDER_ID,
        tenantId: fx.tenantId,
        networkPoolId: pool!.id,
        label: "pool-as-account",
        status: "cooldown",
      });

      const response = await post(fx.app, "disable-cooldowns");
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.ok).toBe(true);
      expect(body.updated).toBe(3);
      expect(body.globalSkipped).toBe(1);

      for (const id of [cooling, futureDeadline, modelCooling]) {
        expect((await statusOf(fx.db, id))?.status).toBe("disabled");
      }
      for (const id of [expiredModel, healthy]) {
        expect((await statusOf(fx.db, id))?.status).toBe("active");
      }
      expect((await statusOf(fx.db, alreadyDisabled))?.status).toBe("disabled");
      // A shared row is visible in the tenant's account list but is not
      // writable from the tenant-scoped route; the global pair owns it.
      expect((await statusOf(fx.db, shared))?.status).toBe("cooldown");
      const evidence = await statusOf(fx.db, modelCooling);
      expect(evidence?.cooldownUntil).toBeNull();
      expect(Object.keys(evidence?.modelCooldowns as Record<string, string>)).toContain("some-model");
      expect((await statusOf(fx.db, futureDeadline))?.cooldownUntil).not.toBeNull();
      expect((await fx.db.select().from(providerPoolAccounts))).toHaveLength(1);

      const audit = await fx.db.select().from(adminAuditLog).where(eq(adminAuditLog.action, "provider_account.bulk_disabled_cooldowns"));
      expect(audit).toHaveLength(1);
      expect(fx.invalidations).toHaveLength(1);
    } finally {
      fx.cleanup();
    }
  });

  test("disable-cooldowns is idempotent", async () => {
    const fx = await fixture();
    try {
      await addAccount(fx.db, fx.tenantId, "cooldown", { status: "cooldown" });
      const first = await post(fx.app, "disable-cooldowns");
      expect((await first.json()).updated).toBe(1);
      const second = await post(fx.app, "disable-cooldowns");
      expect(second.status).toBe(200);
      expect((await second.json()).updated).toBe(0);
    } finally {
      fx.cleanup();
    }
  });

  test("delete-banned removes only disabled policy_blocked_banned rows", async () => {
    const fx = await fixture();
    try {
      const banned = await addAccount(fx.db, fx.tenantId, "banned", {
        status: "disabled",
        lastErrorCategory: "policy_blocked_banned",
      });
      const authInvalidated = await addAccount(fx.db, fx.tenantId, "auth", {
        status: "disabled",
        lastErrorCategory: "auth_invalidated",
      });
      const activeBanned = await addAccount(fx.db, fx.tenantId, "active-banned", {
        status: "active",
        lastErrorCategory: "policy_blocked_banned",
      });
      const sharedBanned = await addAccount(fx.db, null, "shared-banned", {
        status: "disabled",
        lastErrorCategory: "policy_blocked_banned",
      });

      const response = await post(fx.app, "delete-banned");
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.deleted).toEqual([banned]);
      expect(body.missing).toEqual([]);
      expect(body.globalSkipped).toBe(1);
      expect(await statusOf(fx.db, banned)).toBeUndefined();
      expect(await statusOf(fx.db, authInvalidated)).toBeDefined();
      expect(await statusOf(fx.db, activeBanned)).toBeDefined();
      expect(await statusOf(fx.db, sharedBanned)).toBeDefined();

      const audit = await fx.db.select().from(adminAuditLog).where(eq(adminAuditLog.action, "provider_account.bulk_deleted_banned"));
      expect(audit).toHaveLength(1);
      expect(fx.invalidations).toHaveLength(1);

      // Second call: no matching row, still a successful no-op.
      const again = await post(fx.app, "delete-banned");
      expect((await again.json()).deleted).toEqual([]);
    } finally {
      fx.cleanup();
    }
  });

  test("global pair updates and deletes shared rows with platform:admin", async () => {
    const fx = await fixture();
    try {
      const admin = {
        id: "platform-admin",
        tenantId: null,
        scopes: ["platform:admin"],
        admissionIdentity: "platform-admin",
      } as AccessDecision;
      const deps = {
        db: fx.db,
        accessResolver: () => admin,
        redis: undefined,
        snapshotInvalidator: { invalidate: async () => 1 },
        providerRegistry: new ProviderRegistry(),
        resolveCredential: async () => "",
        auditRecorder: undefined,
      } as never;
      const globalApp = new Elysia();
      globalApp.error(consoleErrorHandler("Quota operation failed"));
      registerAccountQuotaGlobalRoutes(globalApp, deps, deps);
      const call = (action: string) => globalApp.handle(
        new Request(`http://localhost/global/accounts/actions/${action}`, { method: "POST" }),
      );
      const sharedCooling = await addAccount(fx.db, null, "shared-cooling", { status: "cooldown" });
      const sharedBanned = await addAccount(fx.db, null, "shared-banned", {
        status: "disabled",
        lastErrorCategory: "policy_blocked_banned",
      });

      const disabled = await call("disable-cooldowns");
      expect(disabled.status).toBe(200);
      expect((await disabled.json()).updated).toBe(1);
      expect((await statusOf(fx.db, sharedCooling))?.status).toBe("disabled");

      const deleted = await call("delete-banned");
      expect(deleted.status).toBe(200);
      expect((await deleted.json()).deleted).toEqual([sharedBanned]);
      expect(await statusOf(fx.db, sharedBanned)).toBeUndefined();
    } finally {
      fx.cleanup();
    }
  });

  test("both actions require providers:write", async () => {
    const fx = await fixture();
    try {
      fx.setAccess({
        id: "reader",
        tenantId: fx.tenantId,
        scopes: ["providers:read"],
        admissionIdentity: "reader",
      });
      expect((await post(fx.app, "disable-cooldowns")).status).toBe(403);
      expect((await post(fx.app, "delete-banned")).status).toBe(403);
      fx.setAccess(undefined);
      expect((await post(fx.app, "disable-cooldowns")).status).toBe(401);
      expect((await post(fx.app, "delete-banned")).status).toBe(401);
    } finally {
      fx.cleanup();
    }
  });
});
