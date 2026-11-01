/**
 * Pool-as-account rows surface in the provider's account list (the Accounts
 * card): for an ip-scoped, credential-less provider, `listAccounts` appends
 * one synthetic row per pool-account, marked `kind: "pool"` and carrying the
 * owning `networkPoolId`, so the operator sees egresses in the same list that
 * already explains account health.
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
import { networkPools, providerPoolAccounts, providers, tenants } from "../../src/persistence/schema";
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
  const dir = mkdtempSync(join(tmpdir(), "cartethyia-poolaccount-"));
  const sqlite = createSqliteDatabase(join(dir, "cartethyia.sqlite"));
  try {
    await applySqliteMigrations(sqlite);
    const db = buildSqliteHandle(sqlite).db;
    const tenantId = randomUUID();
    await db.insert(tenants).values({ id: tenantId, name: "Operator", status: "active" });
    await db.insert(providers).values({
      id: "opencode",
      tenantId: null,
      requiresAccount: false,
      enabled: true,
    });
    const store = new DrizzleProviderCatalogStore(db, {
      telemetryBuffer: { enqueue() {} } as never,
      bundledModelCatalog: { modelsByProvider: new Map() },
      providerRegistry: new ProviderRegistry(),
      outboundFetchFor: () => fetch,
      snapshotInvalidator: { invalidate() {} },
    });

    const poolId = randomUUID();
    await db.insert(networkPools).values({
      id: poolId,
      kind: "https",
      endpointConfig: { endpoint: "http://pool.example:8080" },
      tenantId,
      status: "active",
      createdAt: new Date(),
    });
    await db.insert(providerPoolAccounts).values({
      id: randomUUID(),
      tenantId,
      networkPoolId: poolId,
      providerId: "opencode",
      label: `Pool ${poolId.slice(0, 8)}`,
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await run({ store, tenantId, db });
  } finally {
    sqlite.close();
    removeDir(dir);
  }
}

describe("pool-as-account list", () => {
  test("listAccounts includes pool-account rows with kind=pool and networkPoolId", async () => {
    await withStore(async ({ store, tenantId }) => {
      const accounts = await store.listAccounts(tenantId, "opencode");
      const poolAccounts = accounts.filter((account) => account.kind === "pool");
      expect(poolAccounts.length).toBe(1);
      expect(poolAccounts[0]?.providerId).toBe("opencode");
      expect(poolAccounts[0]?.networkPoolId).toBeTypeOf("string");
      expect(poolAccounts[0]?.credentialKind).toBe("none");
      expect(poolAccounts[0]?.status).toBe("active");
    });
  });

  test("non-ip-scoped providers return no pool-account rows", async () => {
    await withStore(async ({ store, tenantId }) => {
      const accounts = await store.listAccounts(tenantId, "anthropic");
      expect(accounts.filter((account) => account.kind === "pool")).toHaveLength(0);
    });
  });

  test("pool-account rows surface active provider cooldown markers", async () => {
    await withStore(async ({ store, tenantId, db }) => {
      const future = Date.now() + 60 * 60 * 1000;
      await db.update(networkPools).set({
        providerCooldowns: {
          opencode: { until: future, reason: "Provider opencode rate limit" },
          anthropic: { until: Date.now() - 1000, reason: "expired" },
        },
      });
      const accounts = await store.listAccounts(tenantId, "opencode");
      const pool = accounts.find((account) => account.kind === "pool");
      expect(pool?.providerCooldowns).toEqual([
        { providerId: "opencode", until: new Date(future).toISOString(), reason: "Provider opencode rate limit", blocked: false },
      ]);
    });
  });
});
