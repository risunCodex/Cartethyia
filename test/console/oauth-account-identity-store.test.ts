/**
 * OAuth login persistence boundary: a provider that reports no email or name
 * must still produce rows an operator can tell apart.
 */
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  applySqliteMigrations,
  buildSqliteHandle,
  createSqliteDatabase,
} from "../../src/persistence/db-sqlite";
import { providerAccounts, providers, tenants } from "../../src/persistence/schema";
import { DrizzleOAuthAccountStore } from "../../src/console/providers/oauth/routes";

function removeDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    if (code !== "EBUSY" && code !== "EPERM") throw error;
  }
}

function exchange(refresh: string): {
  readonly label: string;
  readonly access: string;
  readonly refresh: string;
  readonly expiresAt: Date;
} {
  return {
    label: "hermes",
    access: `access-${refresh}`,
    refresh,
    expiresAt: new Date(Date.now() + 60_000),
  };
}

test("nameless OAuth logins get unique generated labels and keep separate identities", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cartethyia-oauth-identity-"));
  const sqlite = createSqliteDatabase(join(dir, "cartethyia.sqlite"));
  try {
    await applySqliteMigrations(sqlite);
    const db = buildSqliteHandle(sqlite).db;
    const tenantId = randomUUID();
    await db.insert(tenants).values({ id: tenantId, name: "Operator", status: "active" });
    await db.insert(providers).values({ id: "hermes" });
    const store = new DrizzleOAuthAccountStore(db);

    await store.persistAccount(tenantId, "hermes", exchange("refresh-a"));
    await store.persistAccount(tenantId, "hermes", exchange("refresh-b"));

    const rows = await db
      .select({ label: providerAccounts.label })
      .from(providerAccounts)
      .where(eq(providerAccounts.providerId, "hermes"));
    expect(rows.map((row) => row.label).sort()).toEqual(["hermes-1", "hermes-2"]);
  } finally {
    try {
      sqlite.close();
    } finally {
      removeDir(dir);
    }
  }
});

test("WorkOS email/name learned at login is stored before the identity sweep", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cartethyia-oauth-identity-"));
  const sqlite = createSqliteDatabase(join(dir, "cartethyia.sqlite"));
  try {
    await applySqliteMigrations(sqlite);
    const db = buildSqliteHandle(sqlite).db;
    const tenantId = randomUUID();
    await db.insert(tenants).values({ id: tenantId, name: "Operator", status: "active" });
    await db.insert(providers).values({ id: "factory" });
    const store = new DrizzleOAuthAccountStore(db);

    await store.persistAccount(tenantId, "factory", {
      label: "factory",
      access: "factory-access",
      refresh: "factory-refresh",
      expiresAt: new Date(Date.now() + 60_000),
      accountEmail: "dev@example.com",
      accountName: "Dev User",
    });

    const row = (
      await db.select().from(providerAccounts).where(eq(providerAccounts.providerId, "factory")).limit(1)
    )[0];
    expect(row?.label).toBe("dev@example.com");
    expect(row?.accountEmail).toBe("dev@example.com");
    expect(row?.identityCheckedAt).not.toBeNull();
    expect((row?.authState as Record<string, unknown> | null)?.["accountName"]).toBe("Dev User");
  } finally {
    try {
      sqlite.close();
    } finally {
      removeDir(dir);
    }
  }
});
