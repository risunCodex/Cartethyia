/**
 * The paged share-child listing must not fetch the whole family.
 *
 * A template can hold hundreds of thousands of children; the list endpoint
 * now pages with server-side filtering/sorting and returns global family
 * counts, so the dashboard never loads more than one page at a time.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { DrizzleApiKeyStore } from "../../src/persistence/stores/api-key-store";
import { getDb } from "../../src/persistence/boot";
import { dbDescribe, getTestPool } from "../helpers/database";

const hash = (seed: string) => createHash("sha256").update(seed).digest("hex");

let tenantId = "";
let templateId = "";
const childIds: string[] = [];

beforeAll(async () => {
  const pool = await getTestPool();
  const tenant = await pool.query<{ id: string }>(
    "insert into tenants (name, status) values ($1, $2) returning id",
    [`api-key-shared-page-${randomUUID()}`, "active"],
  );
  tenantId = String(tenant.rows[0]!.id);
  templateId = randomUUID();
  await pool.query(
    `insert into api_keys
       (id, tenant_id, key_hash, key_mode, label, scopes, sort_index, enabled, is_default)
     values ($1, $2, NULL, 'share', 'Template', '["routing:invoke"]'::jsonb, 0, true, false)`,
    [templateId, tenantId],
  );
  // Three children with distinct labels/IPs/timestamps; one revoked.
  const rows = [
    { label: "zulu", ip: "203.0.113.1", at: "2026-10-01T00:00:00Z", revoked: false, consumed: 10 },
    { label: "alpha", ip: "203.0.113.2", at: "2026-10-02T00:00:00Z", revoked: true, consumed: 20 },
    { label: "mike", ip: "203.0.113.3", at: "2026-10-03T00:00:00Z", revoked: false, consumed: 30 },
  ];
  for (const row of rows) {
    const id = randomUUID();
    childIds.push(id);
    await pool.query(
      `insert into api_keys
         (id, tenant_id, key_hash, key_mode, label, scopes, parent_key_id,
          issued_client_ip, issued_client_ip_key, key_prefix, sort_index,
          enabled, is_default, created_at, lifetime_tokens_consumed, revoked_at)
       values ($1, $2, $3, 'share', $4, '["routing:invoke"]'::jsonb, $5,
               $6, $7, 'cty-' || $4, 0, true, false, $8, $9, $10)`,
      [id, tenantId, hash(`child-${id}`), row.label, templateId, row.ip, row.ip, row.at, row.consumed, row.revoked ? new Date().toISOString() : null],
    );
  }
});

afterAll(async () => {
  if (tenantId === "") return;
  const pool = await getTestPool();
  await pool.query("delete from tenants where id = $1", [tenantId]);
});

dbDescribe("api key shared page", () => {
  test("pages by createdAt desc with global counts and consumed sum", async () => {
    const store = new DrizzleApiKeyStore(getDb());
    const page = await store.listChildrenPage(tenantId, templateId, {
      limit: 2,
      offset: 0,
      sortBy: "createdAt",
      order: "desc",
      status: "all",
    });
    expect(page.total).toBe(3);
    expect(page.active).toBe(2);
    expect(page.revoked).toBe(1);
    // Cumulative spend = template counter + family telemetry; this fixture has
    // neither, so it is 0 (child columns are not part of the running total).
    expect(page.consumed).toBe(0);
    expect(page.rows.map((row) => row.label)).toEqual(["mike", "alpha"]);
  });

  test("lists active bans from share children, excluding expired and revoked keys", async () => {
    const pool = await getTestPool();
    const activeChildId = childIds[0]!;
    const expiredChildId = childIds[2]!;
    const revokedChildId = childIds[1]!;
    await pool.query(
      "UPDATE api_keys SET banned_at = now(), banned_until = NULL WHERE id = $1",
      [activeChildId],
    );
    await pool.query(
      "UPDATE api_keys SET banned_at = now(), banned_until = now() - interval '1 minute' WHERE id = $1",
      [expiredChildId],
    );
    await pool.query(
      "UPDATE api_keys SET banned_at = now(), banned_until = NULL WHERE id = $1",
      [revokedChildId],
    );

    const banned = await new DrizzleApiKeyStore(getDb()).listActiveBanned(tenantId);
    expect(banned.map((row) => row.id)).toEqual([activeChildId]);
    expect(banned[0]?.parentKeyId).toBe(templateId);
    expect(banned[0]?.bannedAt).toBeInstanceOf(Date);
  });

  test("consumed is cumulative: template counter plus family telemetry", async () => {
    const pool = await getTestPool();
    // Seed a manual template counter, then a family telemetry total row.
    await pool.query(
      `update api_keys set lifetime_tokens_consumed = 1000 where id = $1`,
      [templateId],
    );
    await pool.query(
      `insert into telemetry_usage_totals
         (tenant_id, identity_type, entity_id, family_template_key_id,
          requests, errors, input_tokens, output_tokens, last_used_at)
       values ($1, 'api_key', $2, $2, 5, 0, 2000, 500, now())`,
      [tenantId, templateId],
    );
    const store = new DrizzleApiKeyStore(getDb());
    const page = await store.listChildrenPage(tenantId, templateId, {
      limit: 50,
      offset: 0,
      sortBy: "createdAt",
      order: "asc",
      status: "all",
    });
    // 1000 (counter) + (2000 + 500) telemetry = 3500.
    expect(page.consumed).toBe(3500);
  });

  test("offset advances and status filter narrows", async () => {
    const store = new DrizzleApiKeyStore(getDb());
    const page = await store.listChildrenPage(tenantId, templateId, {
      limit: 2,
      offset: 2,
      sortBy: "createdAt",
      order: "desc",
      status: "all",
    });
    expect(page.rows.map((row) => row.label)).toEqual(["zulu"]);

    const active = await store.listChildrenPage(tenantId, templateId, {
      limit: 50,
      offset: 0,
      sortBy: "createdAt",
      order: "desc",
      status: "active",
    });
    expect(active.total).toBe(2);
    expect(active.rows.every((row) => row.revokedAt === undefined)).toBe(true);

    const revoked = await store.listChildrenPage(tenantId, templateId, {
      limit: 50,
      offset: 0,
      sortBy: "createdAt",
      order: "desc",
      status: "revoked",
    });
    expect(revoked.total).toBe(1);
    expect(revoked.rows[0]?.label).toBe("alpha");
  });

  test("sorts by label asc and revokedAt", async () => {
    const store = new DrizzleApiKeyStore(getDb());
    const byLabel = await store.listChildrenPage(tenantId, templateId, {
      limit: 50,
      offset: 0,
      sortBy: "label",
      order: "asc",
      status: "all",
    });
    expect(byLabel.rows.map((row) => row.label)).toEqual(["alpha", "mike", "zulu"]);

    const byRevoked = await store.listChildrenPage(tenantId, templateId, {
      limit: 50,
      offset: 0,
      sortBy: "revokedAt",
      order: "desc",
      status: "all",
    });
    // PostgreSQL sorts NULLs first in DESC: the active (revoked_at NULL) rows
    // come before the revoked one, oldest-created first via the tie-break.
    expect(byRevoked.rows[0]?.label).toBe("zulu");
    expect(byRevoked.rows.map((row) => row.label)).toContain("alpha");
  });
});
