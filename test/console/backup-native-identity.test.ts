/**
 * A provider's native identity must survive backup export/restore: it is the
 * account's durable device binding, and moving it to another install is the
 * entire point of export. The backup contract treats jsonb columns
 * generically, so this pins that the column actually rides along.
 */
import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { applySqliteMigrations, buildSqliteHandle, createSqliteDatabase } from "../../src/persistence/db-sqlite";
import { BackupService } from "../../src/console/backup/service";
import { providerAccounts, providers, tenants } from "../../src/persistence/schema";
import type { NativeIdentityRecord } from "../../src/persistence/schema";

const RECORD: NativeIdentityRecord = {
  machineToken: "rt-token",
  machineType: "x86_64_linux",
  machineCode: "rt-code",
};

test("native_identity travels through export and restore verbatim", async () => {
  const sqlite = createSqliteDatabase(":memory:");
  try {
    await applySqliteMigrations(sqlite);
    const { db } = buildSqliteHandle(sqlite);
    await db.insert(providers).values({ id: "testprov" });
    const tenantId = randomUUID();
    await db.insert(tenants).values({ id: tenantId, name: "source", status: "active" });
    const accountId = randomUUID();
    // Seed the account with a bound native identity, then export.
    await db.insert(providerAccounts).values({
      id: accountId,
      providerId: "testprov",
      tenantId,
      label: "a",
      credentialKind: "api_key",
      credentialFingerprint: randomUUID(),
      nativeIdentity: RECORD,
    });

    const service = new BackupService({ db, verifyPassword: async () => true });
    const exportStream = await service.export({ tenantId, password: "pw" });
    let document = "";
    for await (const chunk of exportStream.jsonChunks) document += chunk;
    const payload = JSON.parse(document) as unknown;

    // The exported row carries the identity object under the column's own name.
    const config = (payload as { sections: { config: Record<string, readonly unknown[]> } }).sections.config;
    const rows = config["provider_accounts"] as Array<Record<string, unknown>>;
    const row = rows.find((r) => r["id"] === accountId);
    expect(row).toBeDefined();
    expect(row!["native_identity"]).toEqual(RECORD);

    // Drop the source row so the restore can re-insert it under the target
    // tenant (primary keys + the slot index are global across tenants).
    await db.delete(providerAccounts).where(eq(providerAccounts.id, accountId));

    // Restore into a fresh tenant: the identity must come back intact.
    const targetTenantId = randomUUID();
    const restored = await service.restore("pw", payload, targetTenantId);
    expect(restored.restored["provider_accounts"]).toBe(1);

    const after = (await db.select().from(providerAccounts)).find((r) => r.id === accountId);
    expect(after?.tenantId).toBe(targetTenantId);
    expect(after?.nativeIdentity).toEqual(RECORD);
  } finally {
    sqlite.close();
  }
});
