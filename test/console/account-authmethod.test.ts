/**
 * `ProviderAccountResponse.authMethod` mirror.
 *
 * The provider's `auth_state.authMethod` is what the console reads to badge an
 * account by how it signed in (Social vs OIDC vs API key). This test proves the
 * store maps that field onto the public account shape — the dashboard never
 * receives the whole auth state.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  applySqliteMigrations,
  buildSqliteHandle,
  createSqliteDatabase,
} from "../../src/persistence/db-sqlite";
import { providerAccounts, providers, tenants } from "../../src/persistence/schema";
import { DrizzleProviderCatalogStore } from "../../src/console/providers/catalog/store";
import { ProviderRegistry } from "../../src/providers/provider-registry";
import type { CartethyiaDatabase } from "../../src/persistence/db-handle";

function removeDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    if (code !== "EBUSY" && code !== "EPERM") throw error;
  }
}

async function withStore(
  run: (ctx: { readonly store: DrizzleProviderCatalogStore; readonly tenantId: string; readonly db: CartethyiaDatabase }) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "cartethyia-authmethod-"));
  const sqlite = createSqliteDatabase(join(dir, "cartethyia.sqlite"));
  try {
    await applySqliteMigrations(sqlite);
    const db = buildSqliteHandle(sqlite).db;
    const tenantId = randomUUID();
    await db.insert(tenants).values({ id: tenantId, name: "Operator", status: "active" });
    await db.insert(providers).values({
      id: "kiro",
      tenantId: null,
      requiresAccount: true,
      enabled: true,
    });
    const store = new DrizzleProviderCatalogStore(db, {
      telemetryBuffer: { enqueue() {} } as never,
      bundledModelCatalog: { modelsByProvider: new Map() },
      providerRegistry: new ProviderRegistry(),
      outboundFetchFor: () => fetch,
      snapshotInvalidator: { invalidate() {} },
    });
    await run({ store, tenantId, db });
  } finally {
    sqlite.close();
    removeDir(dir);
  }
}

describe("ProviderAccountResponse.authMethod", () => {
  test("surfaces the stored authMethod for a social account", async () => {
    await withStore(async ({ store, tenantId, db }) => {
      const [row] = await db
        .insert(providerAccounts)
        .values({
          providerId: "kiro",
          tenantId,
          label: "Google account",
          credentialKind: "oauth",
          authState: { authMethod: "google", region: "us-east-1" },
          status: "active",
        })
        .returning({ id: providerAccounts.id });
      expect(row).toBeDefined();
      const accounts = await store.listAccounts(tenantId, "kiro");
      const account = accounts.find((a) => a.id === row!.id);
      expect(account?.authMethod).toBe("google");
    });
  });

  test("surfaces the stored authMethod for an OIDC account", async () => {
    await withStore(async ({ store, tenantId, db }) => {
      const [row] = await db
        .insert(providerAccounts)
        .values({
          providerId: "kiro",
          tenantId,
          label: "AWS Builder ID",
          credentialKind: "oauth",
          authState: { authMethod: "builder-id", region: "us-east-1" },
          status: "active",
        })
        .returning({ id: providerAccounts.id });
      expect(row).toBeDefined();
      const accounts = await store.listAccounts(tenantId, "kiro");
      const account = accounts.find((a) => a.id === row!.id);
      expect(account?.authMethod).toBe("builder-id");
    });
  });

  test("omits authMethod when the account carries no auth state", async () => {
    await withStore(async ({ store, tenantId, db }) => {
      const [row] = await db
        .insert(providerAccounts)
        .values({
          providerId: "kiro",
          tenantId,
          label: "plain",
          credentialKind: "api_key",
          status: "active",
        })
        .returning({ id: providerAccounts.id });
      expect(row).toBeDefined();
      const accounts = await store.listAccounts(tenantId, "kiro");
      const account = accounts.find((a) => a.id === row!.id);
      expect(account?.authMethod).toBeUndefined();
    });
  });

  test("listAccounts returns rows without leaking auth state", async () => {
    await withStore(async ({ store, tenantId, db }) => {
      await db
        .insert(providerAccounts)
        .values({
          providerId: "kiro",
          tenantId,
          label: "Google account",
          credentialKind: "oauth",
          authState: { authMethod: "google", region: "us-east-1", machineId: "secretish" },
          status: "active",
        });
      const accounts = await store.listAccounts(tenantId, "kiro");
      const account = accounts[0];
      expect(account?.authMethod).toBe("google");
      // The dashboard never receives the auth state itself.
      expect(account).not.toHaveProperty("authState");
      expect(account).not.toHaveProperty("auth_state");
    });
  });
});
