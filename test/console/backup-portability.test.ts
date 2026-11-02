/**
 * A backup must survive a change of encryption key.
 *
 * These tests exist because of one measured defect: a restore wrote the file's
 * credential bytes into the receiving install verbatim, *after* deleting that
 * install's own working credentials. Every provider in the restored
 * configuration then held a secret sealed under a key that was not in the room,
 * so nothing could authenticate — and the operator could not tell, because the
 * restore reported success. The exported file was not at fault; the import was.
 *
 * The rule these tests hold: the payload carries a secret decrypted, and the
 * restore re-seals it under the key of the install it writes into. A payload
 * that still carries another install's ciphertext is refused rather than
 * written, because a credential nobody can open is worse than an absent one —
 * it looks configured.
 */
import { afterAll, afterEach, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import { sql } from "drizzle-orm";
import { getDb } from "../../src/persistence/boot";
import { decryptCredentialToString, setCredentialEncryptionKeyForTesting, snapshotCredentialEncryptionKeyForTesting } from "../../src/security/crypto";
import { BackupService } from "../../src/console/backup/service";
import { applyRestore, compressBackup, exportBackup } from "../../src/console/backup/store";
import { restoreOrder, validateRestorePayload } from "../../src/console/backup/validate";
import { tablesForSection, type BackupPayload } from "../../src/console/backup/contracts";
import { dbDescribe, getTestPool } from "../helpers/database";
import { createWorld, type GatewayWorld } from "../helpers/fixtures";

const SECRET = "sk-portability-secret";
const worlds: GatewayWorld[] = [];
const targetTenantIds: string[] = [];

afterEach(async () => {
  const db = getDb();
  for (const tenantId of targetTenantIds.splice(0)) {
    await db.execute(sql`delete from tenants where id = ${tenantId}`);
  }
  for (const world of worlds.splice(0)) await world.cleanup();
});

/** A second install's key: 32 random bytes, deliberately not this one. */
const otherKey = randomBytes(32);

/**
 * Drops the exporting tenant's own rows after a payload has been taken.
 *
 * Primary keys are global, not per-tenant, so a source row that still exists
 * collides with the payload's copy of itself the moment that payload lands in
 * another tenant of the *same* database. A real migration does not hit this —
 * the receiving install is a different database holding none of these ids — so
 * the test removes the collision rather than asserting around it.
 */
async function dropSourceRows(tenantId: string, providerId?: string): Promise<void> {
  const pool = await getTestPool();
  const client = await pool.connect();
  try {
    if (providerId) await client.query("delete from models where provider_id = $1", [providerId]);
    await client.query("delete from api_keys where tenant_id = $1", [tenantId]);
    await client.query("delete from provider_accounts where tenant_id = $1", [tenantId]);
  } finally {
    client.release();
  }
}

async function backupWorld(): Promise<GatewayWorld> {
  const world = await createWorld();
  await world.addAccount({ tenantId: world.tenantId, credential: SECRET, credentialKind: "api_key" });
  return world;
}

/** Authored rows from other parallel worlds are not this restore's fixture. */
function ownedProviderModels(payload: BackupPayload, providerId: string): void {
  const models = payload.sections.config?.["models"];
  if (models) {
    payload.sections.config!["models"] = models.filter((row) => row["provider_id"] === providerId);
  }
}

/**
 * The stored credential of one tenant's provider accounts, read straight from
 * Postgres: the assertion is about what a decrypting install sees, so it reads
 * bytes rather than anything the store shaped.
 */
async function sealedCredentialOf(tenantId: string): Promise<Buffer | null> {
  const pool = await getTestPool();
  const client = await pool.connect();
  try {
    const result = await client.query<{ credential_ciphertext: Buffer | null }>(
      "select credential_ciphertext from provider_accounts where tenant_id = $1",
      [tenantId],
    );
    return result.rows[0]?.credential_ciphertext ?? null;
  } finally {
    client.release();
  }
}

dbDescribe("backup credential portability", () => {
  const previousKey = snapshotCredentialEncryptionKeyForTesting();
  afterAll(() => {
    // Hand the cached key back to whatever was active before this suite, not
    // `undefined`: test files share this module's cached key within a worker,
    // so clearing it left the next suite deriving a key from a different
    // environment and its sealed fixtures failed to open.
    setCredentialEncryptionKeyForTesting(previousKey);
  });

  test("a restore re-seals provider credentials under the importing install's key", async () => {
    const db = getDb();
    const world = await backupWorld();
    worlds.push(world);
    // Install A exports.
    const { payload } = await exportBackup(db, tablesForSection("config"), world.tenantId);
    ownedProviderModels(payload, world.providerId);
    await dropSourceRows(world.tenantId, world.providerId);
    const accounts = (payload as unknown as { sections: { config: { provider_accounts: Array<Record<string, unknown>> } } })
      .sections.config.provider_accounts;
    const exported = accounts.find((row) => row.tenant_id === world.tenantId);
    expect(exported).toBeDefined();
    // The file carries the plaintext under the secret's own name, not the
    // column that seals it: that is what makes it restorable at all.
    expect(exported?.access_token).toBe(SECRET);
    expect(exported?.credential_ciphertext).toBeUndefined();

    // Install B, with a different key, restores into a tenant of its own.
    setCredentialEncryptionKeyForTesting(otherKey);
    const importingTenant = randomUUID();
    targetTenantIds.push(importingTenant);
    const service = new BackupService({ db, verifyPassword: async () => true });
    const result = await service.restore("pw", payload, importingTenant);
    expect(result.warnings).toEqual([]);

    const sealed = await sealedCredentialOf(importingTenant);
    expect(sealed).toBeDefined();
    // The assertion that fails without the fix: install A's bytes would still be
    // here, and install B's key would refuse them.
    expect(decryptCredentialToString(sealed as Buffer)).toBe(SECRET);
  });

  test("ciphertext from another install is refused, not written", async () => {
    const db = getDb();
    const world = await createWorld();
    worlds.push(world);
    const payload = {
      app: "cartethyia",
      version: 1,
      exportedAt: new Date().toISOString(),
      sections: {
        config: {
          // Every real export carries the tenant row; the restore forces its id
          // to the importing tenant and upserts it, which is what makes a
          // foreign key into `tenants` satisfiable at all.
          tenants: [
            {
              id: "00000000-0000-0000-0000-000000000000",
              name: "another install",
              status: "active",
              created_at: { __date: new Date().toISOString() },
            },
          ],
          provider_accounts: [
            {
              id: randomBytes(16).toString("hex"),
              provider_id: world.providerId,
              tenant_id: world.tenantId,
              label: "from-another-install",
              // The shape every export before the fix produced: bytes sealed
              // under the exporting install's key, renamed to nothing and
              // written straight through.
              credential_ciphertext: { __bytes: randomBytes(48).toString("base64") },
              credential_kind: "api_key",
              status: "active",
            },
          ],
        },
      },
    };
    const importingTenant = randomUUID();
    targetTenantIds.push(importingTenant);
    const service = new BackupService({ db, verifyPassword: async () => true });
    const result = await service.restore("pw", payload, importingTenant);

    // The account itself is worth keeping; its unopenable credential is not.
    expect(result.restored["provider_accounts"]).toBe(1);
    expect(result.warnings.map((warning) => warning.column)).toContain("credential_ciphertext");
    expect(await sealedCredentialOf(importingTenant)).toBeNull();
  });

  /**
   * One restore of `payload` into a fresh tenant.
   *
   * Split out from the two-restore test that used to cover both input formats:
   * `api_keys.key_hash` is unique *globally*, not per tenant, so a second
   * restore of the same payload — into any tenant — collides with the key the
   * first one inserted. The old test shared one payload across both restores
   * and passed only while the second write was masked: the table grew on every
   * run and the restore eventually exceeded the runner's 15 s hang detector,
   * which reports a timeout rather than the constraint violation underneath.
   */
  async function restoreInto(input: string | Uint8Array) {
    const db = getDb();
    const service = new BackupService({ db, verifyPassword: async () => true });
    return service.restore("pw", input, randomUUID());
  }

  test("a restore accepts the compressed file the export downloads", async () => {
    const db = getDb();
    const world = await backupWorld();
    worlds.push(world);
    const { payload } = await exportBackup(db, tablesForSection("config"), world.tenantId);
    ownedProviderModels(payload, world.providerId);
    await dropSourceRows(world.tenantId, world.providerId);

    // What the dashboard puts on disk: gzip bytes, base64-encoded to travel in
    // a JSON body.
    const fromEnvelope = await restoreInto(compressBackup(payload).toString("base64"));
    expect(fromEnvelope.format).toBe("native");
    expect(fromEnvelope.restored["provider_accounts"]).toBe(1);
  });

  test("a restore accepts the same bytes as a file, without the base64 step", async () => {
    const db = getDb();
    const world = await backupWorld();
    worlds.push(world);
    const { payload } = await exportBackup(db, tablesForSection("config"), world.tenantId);
    ownedProviderModels(payload, world.providerId);
    await dropSourceRows(world.tenantId, world.providerId);

    const gzBytes = gzipSync(Buffer.from(JSON.stringify(payload), "utf8"));
    const fromBytes = await restoreInto(new Uint8Array(gzBytes));
    expect(fromBytes.format).toBe("native");
    expect(fromBytes.restored["provider_accounts"]).toBeGreaterThan(0);
  });

  test("a tenant-less export restores into a tenant that does not exist yet", async () => {
    // Current exports deliberately omit the `tenants` section. The restore
    // must still ensure the receiving tenant exists before inserting child
    // rows, or `api_keys.tenant_id` violates its FK on a fresh install.
    const db = getDb();
    const world = await backupWorld();
    worlds.push(world);
    const { payload } = await exportBackup(db, tablesForSection("config"), world.tenantId);
    ownedProviderModels(payload, world.providerId);
    await dropSourceRows(world.tenantId, world.providerId);
    expect(
      (payload as unknown as { sections: { config: Record<string, unknown> } }).sections.config["tenants"],
    ).toBeUndefined();

    const importingTenant = randomUUID();
    targetTenantIds.push(importingTenant);
    const service = new BackupService({ db, verifyPassword: async () => true });
    const result = await service.restore("pw", payload, importingTenant);
    expect(result.warnings).toEqual([]);

    const pool = await getTestPool();
    const client = await pool.connect();
    try {
      const tenant = await client.query<{ id: string }>("select id from tenants where id = $1", [importingTenant]);
      expect(tenant.rows).toHaveLength(1);
      const keys = await client.query<{ id: string }>("select id from api_keys where tenant_id = $1", [importingTenant]);
      expect(keys.rows.length).toBeGreaterThan(0);
    } finally {
      client.release();
    }
  });

  test("a failed bulk restore keeps the bulk error when per-row diagnostics also fail", async () => {
    const db = getDb();
    const world = await backupWorld();
    worlds.push(world);
    const { payload: exported } = await exportBackup(db, tablesForSection("config"), world.tenantId);
    const config = (exported as unknown as { sections: { config: Record<string, unknown> } }).sections.config;
    // The export shares this test database with the importing tenants. Drop
    // the source key so the first restore inserts it rather than colliding
    // with the fixture's own globally unique primary key.
    await dropSourceRows(world.tenantId);
    // Isolate api_keys so the only collision is its globally unique key_hash.
    const payload = {
      app: "cartethyia",
      version: 1,
      exportedAt: new Date().toISOString(),
      sections: { config: { api_keys: config["api_keys"] } },
    };

    const firstTenant = randomUUID();
    targetTenantIds.push(firstTenant);
    const first = validateRestorePayload(payload, firstTenant);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    await applyRestore(db, first.value, restoreOrder(), firstTenant);

    const secondTenant = randomUUID();
    targetTenantIds.push(secondTenant);
    const second = validateRestorePayload(payload, secondTenant);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const failure = await applyRestore(db, second.value, restoreOrder(), secondTenant).then(
      () => {
        throw new Error("expected duplicate key_hash restore to fail");
      },
      (error: unknown) => error as Error & { cause?: unknown },
    );
    expect(failure.message).toContain("bulk insert into api_keys failed");
    expect(failure.message).toContain("per-row diagnostic also failed");
    expect(failure.cause instanceof Error).toBe(true);
  });

  test("a payload's secrets are named for what they are, and still restore", async () => {
    const db = getDb();
    const world = await createWorld();
    worlds.push(world);
    const importingTenant = randomUUID();
    targetTenantIds.push(importingTenant);
    // The shape every export writes: the sealed columns named for the secret
    // they hold. The compressed download an operator already has is this same
    // shape, which is why it still restores rather than being dropped as a
    // column the schema never had.
    const payload = {
      app: "cartethyia",
      version: 1,
      exportedAt: new Date().toISOString(),
      sections: {
        config: {
          tenants: [
            {
              id: "00000000-0000-0000-0000-000000000000",
              name: "old install",
              status: "active",
              created_at: { __date: new Date().toISOString() },
            },
          ],
          provider_accounts: [
            {
              id: randomUUID(),
              provider_id: world.providerId,
              tenant_id: importingTenant,
              label: "legacy",
              access_token: SECRET,
              credential_kind: "api_key",
              status: "active",
            },
          ],
        },
      },
    };
    const service = new BackupService({ db, verifyPassword: async () => true });
    const result = await service.restore("pw", payload, importingTenant);

    // Nothing to report: this is the current format, not an anomaly.
    expect(result.warnings).toEqual([]);
    expect(decryptCredentialToString((await sealedCredentialOf(importingTenant)) as Buffer)).toBe(SECRET);
  });

  test("an export names no column by its ciphertext name", async () => {
    const db = getDb();
    const world = await createWorld();
    worlds.push(world);
    await world.addAccount({ tenantId: world.tenantId, credential: SECRET, credentialKind: "api_key" });
    const { payload } = await exportBackup(db, tablesForSection("config"), world.tenantId);
    const config = (payload as unknown as { sections: { config: Record<string, Record<string, unknown>[]> } })
      .sections.config;
    // Every name that describes sealed storage rather than the secret itself.
    // A file that still says `credential_ciphertext` while holding plaintext
    // tells its reader the opposite of the truth.
    const forbidden = ["credential_ciphertext", "refresh_ciphertext", "client_secret_ciphertext", "key_encrypted", "token_encrypted"];
    const present: string[] = [];
    for (const [table, rows] of Object.entries(config)) {
      for (const row of rows) {
        for (const name of Object.keys(row)) {
          if (forbidden.includes(name)) present.push(`${table}.${name}`);
        }
      }
    }
    expect(present).toEqual([]);
  });

  test("an export never carries sign-in accounts", async () => {
    const db = getDb();
    const world = await createWorld();
    worlds.push(world);
    const { payload } = await exportBackup(db, tablesForSection("config"), world.tenantId);
    const config = (payload as { sections: { config: Record<string, unknown> } }).sections.config;
    expect(config.console_users).toBeUndefined();
  });
});
