/**
 * Public Key: a custom provider created without any credential.
 *
 * The "Public Key" switch in the Add Compatible Provider modal means the
 * upstream answers without a credential. The provider is persisted with
 * `requiresAccount: false`, the console response is stamped `publicKey`, and a
 * credential-less account row is registered so routing has a unit to dial —
 * the account path (not the synthetic credential-less route, which only emits
 * when the provider has no rows). These pin the backend halves of that flow.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import type { Database as SqliteDatabase } from "bun:sqlite";
import { applySqliteMigrations, buildSqliteHandle, createSqliteDatabase } from "../../src/persistence/db-sqlite";
import type { CartethyiaDatabase } from "../../src/persistence/db-handle";
import { providerAccounts, providers, tenants } from "../../src/persistence/schema";
import { DrizzleProviderCatalogStore } from "../../src/console/providers/catalog/store";
import { createProviderCatalogOperations } from "../../src/console/providers/catalog/provider-operations";
import { createProviderAccountOperations } from "../../src/console/providers/catalog/provider-account-operations";
import { ProviderRegistry } from "../../src/providers/provider-registry";
import type { AccessDecision } from "../../src/security/access-control";
import type { ProviderResponse } from "../../src/console/providers/catalog/contracts";

function removeDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    if (code !== "EBUSY" && code !== "EPERM") throw error;
  }
}

function writeAccess(tenantId: string): AccessDecision {
  return { id: "operator", tenantId, scopes: ["providers:write"], admissionIdentity: "operator" };
}

let dir: string | undefined;
let sqlite: SqliteDatabase | undefined;
let db: CartethyiaDatabase | undefined;
let tenantId: string;
let providerOps: ReturnType<typeof createProviderCatalogOperations>;
let accountOps: ReturnType<typeof createProviderAccountOperations>;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "carte-public-key-"));
  sqlite = createSqliteDatabase(join(dir, "cartethyia.sqlite"));
  await applySqliteMigrations(sqlite);
  db = buildSqliteHandle(sqlite).db;
  tenantId = "t-public-key";
  await db.insert(tenants).values({ id: tenantId, name: "Operator", status: "active" });
  const store = new DrizzleProviderCatalogStore(db, {
    telemetryBuffer: { enqueue() {} } as never,
    bundledModelCatalog: { modelsByProvider: new Map() },
    providerRegistry: new ProviderRegistry(),
    outboundFetchFor: () => fetch,
    snapshotInvalidator: { invalidate() {} },
  });
  const invalidator = {
    invalidate: async () => 1,
    currentRevision: () => 1,
  };
  providerOps = createProviderCatalogOperations({
    store,
    accessResolver: { resolve: async () => writeAccess(tenantId) } as never,
    providerRegistry: new ProviderRegistry(),
    snapshotInvalidator: invalidator,
  });
  accountOps = createProviderAccountOperations({
    store,
    accessResolver: { resolve: async () => writeAccess(tenantId) } as never,
    providerRegistry: new ProviderRegistry(),
    snapshotInvalidator: invalidator,
  });
});

afterEach(() => {
  sqlite?.close();
  if (dir !== undefined) removeDir(dir);
  sqlite = undefined;
  db = undefined;
  dir = undefined;
});

describe("public-key custom provider", () => {
  test("createProvider persists requiresAccount: false and the response is stamped publicKey", async () => {
    const created = await providerOps.createProvider(writeAccess(tenantId), {
      providerId: "acme-public",
      label: "Acme Public",
      baseUrl: "https://srv1.howtofix.id/v1",
      wireFamily: "chat",
      requiresAccount: false,
    });
    const row = await db!
      .select({ requiresAccount: providers.requiresAccount })
      .from(providers)
      .where(eq(providers.id, "acme-public"))
      .limit(1);
    expect(row[0]?.requiresAccount).toBe(false);
    // The dashboard reads `publicKey` to keep the account card and the
    // credential-less account row reachable.
    expect((created as ProviderResponse).publicKey).toBe(true);
  });

  test("createProvider without the switch keeps the account-requiring default", async () => {
    const created = await providerOps.createProvider(writeAccess(tenantId), {
      providerId: "acme-keyed",
      label: "Acme Keyed",
      baseUrl: "https://api.example.com/v1",
      wireFamily: "chat",
    });
    const row = await db!
      .select({ requiresAccount: providers.requiresAccount })
      .from(providers)
      .where(eq(providers.id, "acme-keyed"))
      .limit(1);
    expect(row[0]?.requiresAccount).toBe(true);
    expect((created as ProviderResponse).publicKey).toBeUndefined();
  });

  test("the credential-less account is stored as kind none with the Public Key label", async () => {
    await providerOps.createProvider(writeAccess(tenantId), {
      providerId: "acme-public",
      label: "Acme Public",
      baseUrl: "https://srv1.howtofix.id/v1",
      wireFamily: "chat",
      requiresAccount: false,
    });
    const account = await accountOps.createAccount(writeAccess(tenantId), "acme-public", {
      credentialKind: "none",
      label: "Public Key",
    });
    expect(account.credentialKind).toBe("none");
    expect(account.label).toBe("Public Key");
    const row = await db!
      .select({ kind: providerAccounts.credentialKind, cipher: providerAccounts.credentialCiphertext })
      .from(providerAccounts)
      .where(eq(providerAccounts.id, account.id))
      .limit(1);
    // A credential-less account stores no ciphertext: the adapter reads the
    // `none` kind and sends no auth header at all.
    expect(row[0]?.kind).toBe("none");
    expect(row[0]?.cipher ?? null).toBeNull();
  });
});
