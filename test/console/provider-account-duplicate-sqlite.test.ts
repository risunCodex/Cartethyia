/**
 * SQLite duplicate-account guard.
 *
 * The account identity unique index (`provider_accounts_identity_uidx`) spans
 * `(provider_id, tenant_id, credential_fingerprint)`. In Postgres the driver
 * reports a unique violation as SQLSTATE 23505 and the store maps it to a
 * friendly `provider_account_duplicate` 409. SQLite reports it differently
 * (`UNIQUE constraint failed: …`), so `isUniqueViolation` must recognise that
 * shape too — otherwise a duplicate paste on a Lite install leaks the raw
 * driver error to the console instead of the friendly message.
 */
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  applySqliteMigrations,
  buildSqliteHandle,
  createSqliteDatabase,
} from "../../src/persistence/db-sqlite";
import { providers, tenants } from "../../src/persistence/schema";
import { DrizzleProviderCatalogStore } from "../../src/console/providers/catalog/store";
import { ProviderRegistry } from "../../src/providers/provider-registry";
import { ConsoleDomainError } from "../../src/console/shared/errors";

function removeDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    if (code !== "EBUSY" && code !== "EPERM") throw error;
  }
}

function buildStore(db: ReturnType<typeof buildSqliteHandle>["db"]): DrizzleProviderCatalogStore {
  return new DrizzleProviderCatalogStore(db, {
    telemetryBuffer: { enqueue() {} } as never,
    bundledModelCatalog: { modelsByProvider: new Map() },
    providerRegistry: new ProviderRegistry(),
    outboundFetchFor: () => fetch,
    snapshotInvalidator: { invalidate() {} },
  });
}

async function withFixture(
  run: (ctx: {
    readonly store: DrizzleProviderCatalogStore;
    readonly db: ReturnType<typeof buildSqliteHandle>["db"];
    readonly tenantId: string;
  }) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "cartethyia-dup-account-"));
  const sqlite = createSqliteDatabase(join(dir, "cartethyia.sqlite"));
  try {
    await applySqliteMigrations(sqlite);
    const db = buildSqliteHandle(sqlite).db;
    const tenantId = randomUUID();
    await db.insert(tenants).values({ id: tenantId, name: "Operator", status: "active" });
    await db.insert(providers).values({ id: "opencode" });
    const store = buildStore(db);
    await run({ store, db, tenantId });
  } finally {
    removeDir(dir);
  }
}

test("a duplicate credential on SQLite maps to provider_account_duplicate, not a raw UNIQUE error", async () => {
  await withFixture(async ({ store, tenantId }) => {
    const secret = "sk-dup-test-1234567890abcdef";

    const first = await store.createAccount(tenantId, "opencode", {
      label: "first",
      credentialKind: "api_key",
      secret,
    });
    expect(first).toBeDefined();

    // The second create with the same credential must be the friendly domain
    // error — never the raw driver `UNIQUE constraint failed` message.
    let caught: unknown;
    try {
      await store.createAccount(tenantId, "opencode", {
        label: "second",
        credentialKind: "api_key",
        secret,
      });
      throw new Error("expected createAccount to reject for a duplicate credential");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConsoleDomainError);
    const domain = caught as ConsoleDomainError;
    expect(domain.code).toBe("provider_account_duplicate");
    expect(domain.status).toBe(409);
    expect(domain.message).toContain("already exists");
    expect(domain.message).not.toContain("UNIQUE constraint failed");
  });
});

test("the same credential under a different tenant is allowed on SQLite", async () => {
  await withFixture(async ({ store, db, tenantId }) => {
    const secret = "sk-dup-test-tenant-scoped";
    const tenantB = randomUUID();
    await db.insert(tenants).values({ id: tenantB, name: "Operator B", status: "active" });
    await store.createAccount(tenantId, "opencode", { label: "a", credentialKind: "api_key", secret });
    const second = await store.createAccount(tenantB, "opencode", { label: "b", credentialKind: "api_key", secret });
    expect(second).toBeDefined();
  });
});

test("two different credentials with the same label are allowed on SQLite", async () => {
  await withFixture(async ({ store, tenantId }) => {
    await store.createAccount(tenantId, "opencode", {
      label: "same-label",
      credentialKind: "api_key",
      secret: "sk-dup-test-label-1",
    });
    const second = await store.createAccount(tenantId, "opencode", {
      label: "same-label",
      credentialKind: "api_key",
      secret: "sk-dup-test-label-2",
    });
    expect(second).toBeDefined();
  });
});
