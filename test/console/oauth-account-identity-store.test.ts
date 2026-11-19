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

test("device accounts sharing one email but different userIds stay separate rows", async () => {
  // The clixad overwrite: its gateway reports one email for several accounts, so
  // a fingerprint on the email merged them — adding the second account replaced
  // the first. The provider's userId is the identity; the store must keep both.
  const dir = mkdtempSync(join(tmpdir(), "cartethyia-oauth-clixad-"));
  const sqlite = createSqliteDatabase(join(dir, "cartethyia.sqlite"));
  try {
    await applySqliteMigrations(sqlite);
    const db = buildSqliteHandle(sqlite).db;
    const tenantId = randomUUID();
    await db.insert(tenants).values({ id: tenantId, name: "Operator", status: "active" });
    await db.insert(providers).values({ id: "clixad" });
    const store = new DrizzleOAuthAccountStore(db);

    const login = (userId: string) => ({
      label: "shared@example.com",
      access: `adg_${userId}`,
      refresh: `adg_${userId}`,
      expiresAt: new Date(Date.now() + 60_000),
      accountLabel: "shared@example.com",
      accountName: userId,
    });
    const first = await store.persistAccount(tenantId, "clixad", login("u1"));
    const second = await store.persistAccount(tenantId, "clixad", login("u2"));
    expect(second.accountId).not.toBe(first.accountId);

    // A re-login of the same userId replaces its own row, not the sibling's.
    const again = await store.persistAccount(tenantId, "clixad", login("u1"));
    expect(again.accountId).toBe(first.accountId);

    const rows = await db
      .select({ label: providerAccounts.label })
      .from(providerAccounts)
      .where(eq(providerAccounts.providerId, "clixad"));
    expect(rows).toHaveLength(2);
  } finally {
    try {
      sqlite.close();
    } finally {
      removeDir(dir);
    }
  }
});

test("an OAuth flow that mints an API credential files the account as api_key", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cartethyia-oauth-kind-"));
  const sqlite = createSqliteDatabase(join(dir, "cartethyia.sqlite"));
  try {
    await applySqliteMigrations(sqlite);
    const db = buildSqliteHandle(sqlite).db;
    const tenantId = randomUUID();
    await db.insert(tenants).values({ id: tenantId, name: "Operator", status: "active" });
    await db.insert(providers).values({ id: "zcode-start" });
    const store = new DrizzleOAuthAccountStore(db);

    // The ZCode plan lane's login JWT IS the api credential the dispatch
    // contract asserts; the flow declares the storage kind explicitly.
    const { accountId } = await store.persistAccount(tenantId, "zcode-start", {
      label: "operator@example.com",
      access: "zcode-plan-jwt",
      refresh: "",
      expiresAt: new Date(Date.now() + 60_000),
      credentialKind: "api_key",
      auth_state: { credentialMode: "api_key", tokenKind: "zcode-plan-jwt" },
    });
    const row = await db
      .select({ kind: providerAccounts.credentialKind, staticToken: providerAccounts.staticToken })
      .from(providerAccounts)
      .where(eq(providerAccounts.id, accountId));
    expect(row[0]?.kind).toBe("api_key");

    // The default is unchanged: a plain OAuth login is still an oauth row.
    await store.persistAccount(tenantId, "zcode-start", {
      label: "plain@example.com",
      access: "plain-access",
      refresh: "plain-refresh",
      expiresAt: new Date(Date.now() + 60_000),
    });
    const rows = await db
      .select({ kind: providerAccounts.credentialKind, label: providerAccounts.label })
      .from(providerAccounts)
      .where(eq(providerAccounts.providerId, "zcode-start"));
    expect(rows.find((entry) => entry.label === "plain@example.com")?.kind).toBe("oauth");
  } finally {
    sqlite.close();
    removeDir(dir);
  }
});
