/**
 * Provider-list overview (P-01/P-04): the `GET /providers` list items carry
 * `accountCount` / `activeAccountCount` / `modelCount` from two grouped reads,
 * and the list endpoint is served through the read-through cache with ETag/304
 * semantics that rotate when a snapshot-invalidating mutation lands.
 *
 * Backed by a real migrated SQLite database and the real Drizzle store, so the
 * grouped SQL is exercised exactly as it runs in production — including the
 * `tenant_disabled_models` join that keeps `modelCount` in step with what the
 * model listing would show.
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
import { eq } from "drizzle-orm";
import { models, providerAccounts, providers, tenants } from "../../src/persistence/schema";
import { DrizzleProviderCatalogStore } from "../../src/console/providers/catalog/store";
import {
  createProviderCatalogOperations,
} from "../../src/console/providers/catalog/provider-operations";
import { ProviderRegistry } from "../../src/providers/provider-registry";
import type { CartethyiaDatabase } from "../../src/persistence/db-handle";
import type { ProviderResponse } from "../../src/console/providers/catalog/contracts";

const PROVIDER_ID = "byok-acme";

function removeDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    if (code !== "EBUSY" && code !== "EPERM") throw error;
  }
}

async function withCatalog(
  run: (ctx: {
    readonly store: DrizzleProviderCatalogStore;
    readonly tenantId: string;
    readonly db: CartethyiaDatabase;
  }) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "carte-provider-overview-"));
  const sqlite = createSqliteDatabase(join(dir, "cartethyia.sqlite"));
  try {
    await applySqliteMigrations(sqlite);
    const db = buildSqliteHandle(sqlite).db;
    const tenantId = randomUUID();
    await db.insert(tenants).values({ id: tenantId, name: "Operator", status: "active" });
    await db.insert(providers).values({
      id: PROVIDER_ID,
      tenantId,
      enabled: true,
    });
    // Three enabled models plus one disabled row: the disabled row must not
    // count toward `modelCount`.
    await db.insert(models).values([
      { providerId: PROVIDER_ID, modelId: "m1", wireFamily: "chat", endpointPath: "/v1/chat/completions", enabled: true },
      { providerId: PROVIDER_ID, modelId: "m2", wireFamily: "chat", endpointPath: "/v1/chat/completions", enabled: true },
      { providerId: PROVIDER_ID, modelId: "m3", wireFamily: "chat", endpointPath: "/v1/chat/completions", enabled: true },
      { providerId: PROVIDER_ID, modelId: "m-disabled", wireFamily: "chat", endpointPath: "/v1/chat/completions", enabled: false },
    ]);
    // Two active, one cooldown (still a live connection), one disabled.
    await db.insert(providerAccounts).values([
      { providerId: PROVIDER_ID, tenantId, label: "a-active-1", credentialKind: "api_key", status: "active", sortIndex: 0 },
      { providerId: PROVIDER_ID, tenantId, label: "a-active-2", credentialKind: "api_key", status: "active", sortIndex: 1 },
      { providerId: PROVIDER_ID, tenantId, label: "a-cooling", credentialKind: "api_key", status: "cooldown", sortIndex: 2 },
      { providerId: PROVIDER_ID, tenantId, label: "a-disabled", credentialKind: "api_key", status: "disabled", sortIndex: 3 },
    ]);
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

/** A snapshot invalidator whose revision is the cache-key input (mirrors the route group wrap). */
function revisionInvalidator() {
  let revision = 0;
  return {
    invalidate: async () => {
      revision += 1;
      return revision;
    },
    currentRevision: () => revision,
  };
}

import type { AccessDecision } from "../../src/security/access-control";

function readAccess(
  tenantId: string,
  scopes: readonly AccessDecision["scopes"][number][] = ["providers:read"],
): AccessDecision {
  return {
    id: "operator",
    tenantId,
    scopes,
    admissionIdentity: "operator",
  };
}

function buildOperations(
  store: DrizzleProviderCatalogStore,
  tenantId: string,
  snapshotInvalidator: ReturnType<typeof revisionInvalidator>,
) {
  return createProviderCatalogOperations({
    store,
    accessResolver: { resolve: async () => readAccess(tenantId) } as never,
    providerRegistry: new ProviderRegistry(),
    snapshotInvalidator,
  });
}

describe("provider list overview counts", () => {
  test("store grouped reads report per-provider totals", async () => {
    await withCatalog(async ({ store, tenantId }) => {
      const accountCounts = await store.providerAccountCounts(tenantId);
      expect(accountCounts).toEqual([{ providerId: PROVIDER_ID, total: 4, active: 3 }]);
      const modelCounts = await store.providerModelCounts(tenantId);
      expect(modelCounts).toEqual([{ providerId: PROVIDER_ID, count: 3 }]);
    });
  });

  test("listProviders attaches account/model counts to each item", async () => {
    await withCatalog(async ({ store, tenantId }) => {
      const ops = buildOperations(store, tenantId, revisionInvalidator());
      const list = await ops.listProviders(readAccess(tenantId));
      const row = list.find((provider) => provider.providerId === PROVIDER_ID);
      expect(row).toBeDefined();
      expect(row?.accountCount).toBe(4);
      expect(row?.activeAccountCount).toBe(3);
      expect(row?.modelCount).toBe(3);
    });
  });
});

describe("provider list read-through cache (P-04)", () => {
  test("a repeated poll with a matching ETag answers 304", async () => {
    await withCatalog(async ({ store, tenantId }) => {
      const ops = buildOperations(store, tenantId, revisionInvalidator());
      const access = readAccess(tenantId);

      const first = await ops.listProvidersCached(access, null);
      expect(first.status).toBe(200);
      const etag = first.headers.get("etag");
      expect(etag).toBeTruthy();
      const body = (await first.json()) as ProviderResponse[];
      expect(body.find((p) => p.providerId === PROVIDER_ID)?.accountCount).toBe(4);

      const second = await ops.listProvidersCached(access, etag);
      expect(second.status).toBe(304);
      expect(second.headers.get("etag")).toBe(etag);
    });
  });

  test("an account mutation invalidates the cached overview", async () => {
    await withCatalog(async ({ store, tenantId, db }) => {
      const invalidator = revisionInvalidator();
      const ops = buildOperations(store, tenantId, invalidator);
      const access = readAccess(tenantId);

      const first = await ops.listProvidersCached(access, null);
      expect(first.status).toBe(200);
      const etag = first.headers.get("etag");

      // Disable the cooldown account through the real mutation path: it runs
      // the snapshot invalidator, which bumps the cache revision.
      const disabledId = (
        await db
          .select({ id: providerAccounts.id })
          .from(providerAccounts)
          .where(eq(providerAccounts.label, "a-cooling"))
      )[0]?.id;
      expect(disabledId).toBeDefined();
      await ops.updateAccount(
        readAccess(tenantId, ["providers:write"]),
        PROVIDER_ID,
        disabledId!,
        { status: "disabled" },
      );

      // The old ETag no longer matches: the revision in the cache key changed,
      // so the next read recomputes and returns fresh counts.
      const after = await ops.listProvidersCached(access, etag);
      expect(after.status).toBe(200);
      const body = (await after.json()) as ProviderResponse[];
      const row = body.find((p) => p.providerId === PROVIDER_ID);
      expect(row?.accountCount).toBe(4);
      expect(row?.activeAccountCount).toBe(2);
      expect(after.headers.get("etag")).not.toBe(etag);
    });
  });
});
