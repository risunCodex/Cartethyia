/**
 * Share-template concurrency scope: `family` (default) shares one admission
 * counter and cap across every recipient; `per_key` gives each recipient its
 * own cap (copied at issue) and its own admission identity.
 *
 * These tests exercise the two surfaces that implement the split:
 *  - `resolveApiKeyAuthorization` builds the snapshot children are admitted
 *    against — `admission_identity` and `max_concurrent` must switch on the
 *    parent's scope.
 *  - `IssueSharedApiKey` must copy the cap to the child in `per_key` mode and
 *    leave it NULL in `family` mode.
 */
import { expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { createSqliteDatabase, applySqliteMigrations, buildSqliteHandle } from "../../src/persistence/db-sqlite";
import { DrizzleApiKeyStore } from "../../src/persistence/stores/api-key-store";
import { DrizzleShareLinkStore } from "../../src/persistence/stores/share-store";
import { resolveApiKeyAuthorization } from "../../src/security/api-key-auth";
import { hashSecret } from "../../src/security/crypto";
import { apiKeys, tenants } from "../../src/persistence/schema";

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "carte-concurrency-scope-"));
}

async function setup() {
  const dir = freshDir();
  const sqlite = createSqliteDatabase(join(dir, "cartethyia.sqlite"));
  await applySqliteMigrations(sqlite);
  const handle = buildSqliteHandle(sqlite);
  const globals = globalThis as { __cartethyiaHandle?: typeof handle | undefined };
  const previous = globals.__cartethyiaHandle;
  globals.__cartethyiaHandle = handle;
  return {
    dir,
    handle,
    async cleanup() {
      globals.__cartethyiaHandle = previous;
      sqlite.close();
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Windows may keep the SQLite file briefly locked; the temp dir is
        // harmless if it lingers (same tolerance the backup-stream tests use).
      }
    },
  };
}

async function insertTenant(handle: Awaited<ReturnType<typeof setup>>["handle"]): Promise<string> {
  const [tenant] = await handle.db
    .insert(tenants)
    .values({ name: "auth", status: "active" })
    .returning({ id: tenants.id });
  if (!tenant) throw new Error("tenant insert returned no row");
  return tenant.id;
}

async function insertShareTemplate(
  handle: Awaited<ReturnType<typeof setup>>["handle"],
  tenantId: string,
  scope: "family" | "per_key",
  maxConcurrent: number | null,
): Promise<string> {
  const [parent] = await handle.db
    .insert(apiKeys)
    .values({
      tenantId,
      keyMode: "share",
      label: scope === "per_key" ? "template-per-key" : "template-family",
      scopes: ["routing:invoke"],
      concurrencyScope: scope,
      maxConcurrentRequests: maxConcurrent,
    })
    .returning({ id: apiKeys.id });
  if (!parent) throw new Error("parent insert returned no row");
  return parent.id;
}

test("family scope: child admits against the parent's identity and cap", async () => {
  const { handle, cleanup } = await setup();
  try {
    const tenantId = await insertTenant(handle);
    const parentId = await insertShareTemplate(handle, tenantId, "family", 20);
    const token = "child-family-token";
    await handle.db.insert(apiKeys).values({
      tenantId,
      keyMode: "share",
      parentKeyId: parentId,
      keyHash: hashSecret(token),
      issuedClientIp: "203.0.113.7",
      issuedClientIpKey: "ip-key-1",
      label: "child-family",
      scopes: ["routing:invoke"],
    });

    const resolved = await resolveApiKeyAuthorization(handle.db, token);
    expect(resolved).toBeDefined();
    expect(resolved!.snapshot.admission_identity).toBe(parentId);
    expect(resolved!.snapshot.max_concurrent).toBe(20);
  } finally {
    await cleanup();
  }
});

test("per_key scope: child keeps its own cap but shares the family budget identity", async () => {
  const { handle, cleanup } = await setup();
  try {
    const tenantId = await insertTenant(handle);
    const parentId = await insertShareTemplate(handle, tenantId, "per_key", 5);
    const token = "child-perkey-token";
    await handle.db.insert(apiKeys).values({
      tenantId,
      keyMode: "share",
      parentKeyId: parentId,
      keyHash: hashSecret(token),
      issuedClientIp: "203.0.113.8",
      issuedClientIpKey: "ip-key-2",
      label: "child-perkey",
      scopes: ["routing:invoke"],
      concurrencyScope: "per_key",
      maxConcurrentRequests: 5,
    });

    const resolved = await resolveApiKeyAuthorization(handle.db, token);
    expect(resolved).toBeDefined();
    // Token budgets (daily/monthly/lifetime) stay family-wide: the child admits
    // against the parent's identity so 33 recipients cannot each burn a full
    // 1B daily budget. Only concurrency is per-key.
    expect(resolved!.snapshot.admission_identity).toBe(parentId);
    expect(resolved!.snapshot.max_concurrent).toBe(5);
  } finally {
    await cleanup();
  }
});

test("per_key child with no cap copies nothing (unlimited concurrency, family budget)", async () => {
  const { handle, cleanup } = await setup();
  try {
    const tenantId = await insertTenant(handle);
    const parentId = await insertShareTemplate(handle, tenantId, "per_key", null);
    const token = "child-perkey-null-token";
    await handle.db.insert(apiKeys).values({
      tenantId,
      keyMode: "share",
      parentKeyId: parentId,
      keyHash: hashSecret(token),
      issuedClientIp: "203.0.113.9",
      issuedClientIpKey: "ip-key-3",
      label: "child-perkey-null",
      scopes: ["routing:invoke"],
      concurrencyScope: "per_key",
      maxConcurrentRequests: null,
    });

    const resolved = await resolveApiKeyAuthorization(handle.db, token);
    expect(resolved).toBeDefined();
    expect(resolved!.snapshot.admission_identity).toBe(parentId);
    expect(resolved!.snapshot.max_concurrent).toBeNull();
  } finally {
    await cleanup();
  }
});

test("issueSharedApiKey copies the cap in per_key mode and leaves family NULL", async () => {
  const { handle, cleanup } = await setup();
  try {
    const tenantId = await insertTenant(handle);
    const store = new DrizzleApiKeyStore(handle.db);
    const shareStore = new DrizzleShareLinkStore(handle.db);

    const parentPerKey = await insertShareTemplate(handle, tenantId, "per_key", 7);
    const parentFamily = await insertShareTemplate(handle, tenantId, "family", 9);

    await shareStore.create({
      apiKeyId: parentPerKey,
      tokenHash: hashSecret("link-perkey"),
      tokenEncrypted: Buffer.from("link-perkey"),
      slug: "perkey-slug",
      kind: "enroll",
      expiresAt: null,
      rotate: false,
    });
    await shareStore.create({
      apiKeyId: parentFamily,
      tokenHash: hashSecret("link-family"),
      tokenEncrypted: Buffer.from("link-family"),
      slug: "family-slug",
      kind: "enroll",
      expiresAt: null,
      rotate: false,
    });

    const perKeyChild = await shareStore.issueSharedApiKey("perkey-slug", {
      keyHash: hashSecret("perkey-child-token"),
      keyPrefix: "cty-child",
      clientIp: "203.0.113.10",
      clientIpKey: "ip-key-4",
      nameHint: "pk",
    });
    const familyChild = await shareStore.issueSharedApiKey("family-slug", {
      keyHash: hashSecret("family-child-token"),
      keyPrefix: "cty-child",
      clientIp: "203.0.113.11",
      clientIpKey: "ip-key-5",
      nameHint: "fam",
    });

    expect(perKeyChild.kind).toBe("issued");
    expect(familyChild.kind).toBe("issued");
    if (perKeyChild.kind !== "issued" || familyChild.kind !== "issued") return;

    const perKeyRow = await store.get(tenantId, perKeyChild.apiKeyId);
    const familyRow = await store.get(tenantId, familyChild.apiKeyId);
    expect(perKeyRow?.concurrencyScope).toBe("per_key");
    expect(perKeyRow?.maxConcurrentRequests).toBe(7);
    expect(familyRow?.concurrencyScope).toBe("family");
    expect(familyRow?.maxConcurrentRequests).toBeUndefined();
  } finally {
    await cleanup();
  }
});
