/**
 * `POST /providers/:providerId/accounts/:accountId/refresh-token` (area 04).
 *
 * The endpoint refreshes an OAuth token on demand — including for `disabled`
 * accounts — but never re-enables one: `statusAfter` comes from the server and
 * stays `"disabled"`. Static tokens conflict (409), non-OAuth accounts are
 * rejected (400), and unknown/wrong-owner accounts are 404.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Elysia } from "elysia";
import {
  applySqliteMigrations,
  buildSqliteHandle,
  createSqliteDatabase,
} from "../../src/persistence/db-sqlite";
import type { CartethyiaDatabase } from "../../src/persistence/db-handle";
import { adminAuditLog, healthEvents, providerAccounts, providerOauthStates, providers, tenants } from "../../src/persistence/schema";
import { and, eq } from "drizzle-orm";
import { encryptCredential } from "../../src/security/crypto";
import { DrizzleProviderCatalogStore } from "../../src/console/providers/catalog/store";
import { createProviderCatalogRoutes } from "../../src/console/providers/catalog/routes";
import { consoleErrorHandler } from "../../src/console/shared/errors";
import { AuditRecorder } from "../../src/console/auth/audit-recorder";
import { ProviderRegistry } from "../../src/providers/provider-registry";
import { refreshAccountStatus } from "../../src/providers/operations/account-refresh-status";
import { OAuthRefreshService, type OAuthTokenRefresher } from "../../src/providers/authentication/oauth-refresh-service";
import type { AccessDecision } from "../../src/security/access-control";

function healthyRefresher(): OAuthTokenRefresher {
  return {
    refresh: async () => ({
      access: "fresh-access-token",
      refresh: "fresh-refresh-token",
      expiresAt: new Date(Date.now() + 3_600_000),
    }),
  };
}

function removeDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Windows may hold the file briefly; the temp dir is disposable.
  }
}

interface AppFixture {
  readonly db: CartethyiaDatabase;
  readonly tenantId: string;
  readonly providerId: string;
  readonly app: Elysia;
  readonly cleanup: () => void;
}

async function fixture(): Promise<AppFixture> {
  const dir = mkdtempSync(join(tmpdir(), "carte-refresh-token-"));
  const sqlite = createSqliteDatabase(join(dir, "cartethyia.sqlite"));
  await applySqliteMigrations(sqlite);
  const handle = buildSqliteHandle(sqlite);
  const db = handle.db;
  const [tenant] = await db
    .insert(tenants)
    .values({ name: "refresh-token-tenant", status: "active" })
    .returning({ id: tenants.id });
  const tenantId = tenant!.id;
  await db.insert(providers).values({ id: "oauth-provider", tenantId, enabled: true });
  const store = new DrizzleProviderCatalogStore(db, {
    telemetryBuffer: { enqueue() {} } as never,
    bundledModelCatalog: { modelsByProvider: new Map() },
    providerRegistry: new ProviderRegistry(),
    outboundFetchFor: () => fetch as never,
    snapshotInvalidator: { invalidate() {} },
  });
  const access: AccessDecision = {
    id: "operator",
    tenantId,
    scopes: ["dashboard:write"],
    admissionIdentity: "operator",
  };
  const refreshService = new OAuthRefreshService(db);
  const config = {
    store,
    accessResolver: () => access,
    auditSink: new AuditRecorder(db),
    providerRegistry: new ProviderRegistry(),
    snapshotInvalidator: { invalidate: async () => 1 },
    refreshAccountStatus: (accountId: string, opts?: { readonly origin?: "ui" | "sweep" | "dispatch" }) =>
      refreshAccountStatus(
        {
          db,
          refreshService,
          resolveRefresher: async () => healthyRefresher(),
        },
        accountId,
        opts,
      ),
  };
  const app = new Elysia();
  app.error(consoleErrorHandler("Provider catalog operation failed"));
  app.use(createProviderCatalogRoutes(config));
  return {
    db,
    tenantId,
    providerId: "oauth-provider",
    app,
    cleanup: () => {
      try { sqlite.close(); } catch { /* closed */ }
      removeDir(dir);
    },
  };
}

async function addOauthAccount(
  db: CartethyiaDatabase,
  providerId: string,
  tenantId: string,
  options: { status?: "active" | "disabled"; staticToken?: boolean; refreshToken?: string | null } = {},
): Promise<string> {
  const [row] = await db
    .insert(providerAccounts)
    .values({
      providerId,
      tenantId,
      label: "oauth-account",
      credentialKind: "oauth",
      credentialCiphertext: encryptCredential("access-token"),
      status: options.status ?? "active",
      staticToken: options.staticToken ?? false,
    })
    .returning({ id: providerAccounts.id });
  const accountId = row!.id;
  await db.insert(providerOauthStates).values({
    providerAccountId: accountId,
    refreshCiphertext:
      options.refreshToken === null || options.refreshToken === undefined
        ? null
        : encryptCredential(options.refreshToken),
    expiresAt: new Date(Date.now() + 3_600_000),
  });
  return accountId;
}

async function postRefresh(app: Elysia, providerId: string, accountId: string): Promise<Response> {
  return app.handle(
    new Request(`http://localhost/providers/${providerId}/accounts/${accountId}/refresh-token`, {
      method: "POST",
    }),
  );
}

describe("POST /providers/:providerId/accounts/:accountId/refresh-token", () => {
  test("200 for a disabled OAuth account; statusAfter stays disabled; audit + health event written", async () => {
    const fx = await fixture();
    try {
      const accountId = await addOauthAccount(fx.db, fx.providerId, fx.tenantId, {
        status: "disabled",
        refreshToken: "rt",
      });
      const response = await postRefresh(fx.app, fx.providerId, accountId);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.ok).toBe(true);
      expect(body.statusAfter).toBe("disabled");
      expect(body.tokenRefreshed).toBe(true);

      // Row still disabled.
      const [dbRow] = await fx.db
        .select({ status: providerAccounts.status })
        .from(providerAccounts)
        .where(eq(providerAccounts.id, accountId));
      expect(dbRow?.status).toBe("disabled");

      // Audit row.
      const audit = await fx.db
        .select()
        .from(adminAuditLog)
        .where(
          and(
            eq(adminAuditLog.target, accountId),
            eq(adminAuditLog.action, "provider_account.token_refreshed"),
          ),
        );
      expect(audit).toHaveLength(1);
      expect(audit[0]!.action).toBe("provider_account.token_refreshed");

      // Non-mutating health event (from == to == disabled).
      const events = await fx.db
        .select()
        .from(healthEvents)
        .where(eq(healthEvents.accountId, accountId));
      expect(events).toHaveLength(1);
      expect(events[0]!.fromStatus).toBe("disabled");
      expect(events[0]!.toStatus).toBe("disabled");
    } finally {
      fx.cleanup();
    }
  });

  test("409 for a static token", async () => {
    const fx = await fixture();
    try {
      const accountId = await addOauthAccount(fx.db, fx.providerId, fx.tenantId, {
        status: "active",
        staticToken: true,
        refreshToken: "rt",
      });
      const response = await postRefresh(fx.app, fx.providerId, accountId);
      expect(response.status).toBe(409);
      const body = await response.json();
      expect(body.code).toBe("static_token");
    } finally {
      fx.cleanup();
    }
  });

  test("400 for a non-OAuth account", async () => {
    const fx = await fixture();
    try {
      const [row] = await fx.db
        .insert(providerAccounts)
        .values({
          providerId: fx.providerId,
          tenantId: fx.tenantId,
          label: "key-account",
          credentialKind: "api_key",
          credentialCiphertext: encryptCredential("sk-test"),
          status: "active",
        })
        .returning({ id: providerAccounts.id });
      const response = await postRefresh(fx.app, fx.providerId, row!.id);
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.code).toBe("not_oauth");
    } finally {
      fx.cleanup();
    }
  });

  test("404 for an unknown account", async () => {
    const fx = await fixture();
    try {
      const ghost = "00000000-0000-0000-0000-000000000000";
      const response = await postRefresh(fx.app, fx.providerId, ghost);
      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body.code).toBe("account_not_found");
    } finally {
      fx.cleanup();
    }
  });

  test("404 for an account owned by another provider", async () => {
    const fx = await fixture();
    try {
      await fx.db.insert(providers).values({ id: "other-provider", tenantId: fx.tenantId, enabled: true });
      const accountId = await addOauthAccount(fx.db, "other-provider", fx.tenantId, {
        status: "active",
        refreshToken: "rt",
      });
      const response = await postRefresh(fx.app, fx.providerId, accountId);
      expect(response.status).toBe(404);
    } finally {
      fx.cleanup();
    }
  });
});
