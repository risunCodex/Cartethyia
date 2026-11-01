/**
 * The SQLite baseline is derived, not written.
 *
 * `migrations/lite-sqlite3/0000_baseline.sql` must be exactly what
 * `scripts/tools/generate-sqlite.ts` produces from the PostgreSQL baseline, and
 * the result must build a database whose constraints do the job the PostgreSQL
 * types were doing: enums, booleans, foreign keys, the partial unique index
 * that keeps one live default key per tenant, and cascading deletes.
 *
 * A schema change that is not regenerated fails the first assertion. A rewrite
 * that produces SQL SQLite rejects, or that drops a constraint, fails the rest.
 */
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { deriveSqliteBaseline } from "../../scripts/tools/generate-sqlite";
import { DrizzleModelRoutingStore } from "../../src/console/routing/model/store";
import { applySqliteMigrations, buildSqliteHandle, createSqliteDatabase } from "../../src/persistence/db-sqlite";
import {
  acceptedBaselineSchemaMarkers,
  baselineSchemaMarker,
  MIGRATION_LEDGER_TABLE,
} from "../../src/persistence/migrate";
import { tenants } from "../../src/persistence/schema";

const committed = readFileSync(resolve(process.cwd(), "migrations", "lite-sqlite3", "0000_baseline.sql"), "utf8");

function migratedDatabase(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const part of committed.split(/--> statement-breakpoint/g)) {
    const statement = part.trim();
    if (statement.length === 0 || statement.startsWith("--")) continue;
    db.exec(statement);
  }
  return db;
}

test("each backend has matching baseline and incremental migrations", () => {
  const postgres = readdirSync(resolve(process.cwd(), "migrations", "full-postgres")).filter((name) => name.endsWith(".sql")).sort();
  const sqlite = readdirSync(resolve(process.cwd(), "migrations", "lite-sqlite3")).filter((name) => name.endsWith(".sql")).sort();
  // Both backends must carry the same numbered migrations. The list is pinned
  // (rather than derived) so adding a migration to only one backend fails here
  // instead of silently diverging at startup.
  const expected = [
    "0000_baseline.sql",
    "0001_allow_multiple_shared_keys_per_ip.sql",
    "0002_add_gemini_wire_family.sql",
    "0003_add_models_model_id_index.sql",
    "0004_add_model_block_hits.sql",
    "0005_add_buddy_usage_snapshots.sql",
    "0006_add_buddy_task_ledger.sql",
    "0007_add_telemetry_payload_capture_state.sql",
    "0008_add_models_route_unique_index.sql",
    "0009_rename_opencode_provider_ids.sql",
    "0010_add_provider_max_inflight_per_proxy.sql",
    "0011_add_pool_provider_probe.sql",
    "0012_add_reported_model.sql",
    "0013_add_providers_tenant_id_index.sql",
    "0014_add_provider_accounts_tenant_id_index.sql",
    "0015_add_payload_stages.sql",
    "0016_add_share_link_slug.sql",
    "0017_add_models_pro_only.sql",
    "0018_add_accounts_quota_plan.sql",
    "0019_add_models_free_tier.sql",
    "0020_add_telemetry_event_analytics.sql",
    "0021_add_api_key_concurrency_tolerance.sql",
    "0022_add_inferhub_config_key.sql",
    "0023_drop_api_key_concurrency_tolerance.sql",
    "0024_add_pool_provider_cooldowns.sql",
    "0025_add_pool_random_strategy.sql",
    "0026_add_qoder_native_identity.sql",
    "0027_qoder_identity_genuine_seed.sql",
    "0028_add_family_template_key_telemetry.sql",
    "0029_null_share_child_policy_columns.sql",
    "0030_add_api_key_max_children.sql",
    "0031_tenant_system_prompts.sql",
    "0032_add_provider_pool_accounts.sql",
    "0033_add_api_key_ban.sql",
    "0034_add_api_key_ban_until.sql",
    "0035_align_pool_account_status_enum.sql",
  ];
  expect(postgres).toEqual(expected);
  expect(sqlite).toEqual(expected);
});

test("the committed SQLite baseline matches the generator output", () => {
  const source = readFileSync(resolve(process.cwd(), "migrations", "full-postgres", "0000_baseline.sql"), "utf8");
  expect(committed).toBe(deriveSqliteBaseline(source));
});

test("the derived baseline builds and enforces the PostgreSQL constraints", () => {
  const db = migratedDatabase();
  const tables = db.prepare("SELECT count(*) AS c FROM sqlite_master WHERE type = 'table'").get() as { c: number };
  expect(tables.c).toBe(26);
  expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'studio_sessions'").get()).toBeNull();
  const accountColumns = db.prepare("PRAGMA table_info('provider_accounts')").all() as Array<{ name: string }>;
  expect(accountColumns.map((column) => column.name)).toEqual(
    expect.arrayContaining(["identity_checked_at", "account_email"]),
  );
  const comboColumns = db.prepare("PRAGMA table_info('model_combos')").all() as Array<{ name: string }>;
  expect(comboColumns.map((column) => column.name)).toContain("sort_index");
  const aliasColumns = db.prepare("PRAGMA table_info('model_aliases')").all() as Array<{ name: string }>;
  expect(aliasColumns.map((column) => column.name)).toContain("sort_index");

  db.exec("INSERT INTO tenants (id, name, status) VALUES ('t1', 'A', 'active')");
  expect(() => db.exec("INSERT INTO tenants (id, name, status) VALUES ('t2', 'A', 'nope')")).toThrow();

  db.exec("INSERT INTO providers (id, enabled) VALUES ('openai', 1)");
  expect(() => db.exec("INSERT INTO providers (id, enabled) VALUES ('x', 2)")).toThrow();
  expect(() => db.exec("INSERT INTO providers (id, wire_family_default) VALUES ('y', 'grpc')")).toThrow();
  db.exec("INSERT INTO providers (id, wire_family_default) VALUES ('z', 'chat')");

  const key = (id: string, extra = ""): string =>
    `INSERT INTO api_keys (id, tenant_id, label, scopes, key_mode, key_hash${extra ? ", is_default" : ""}) ` +
    `VALUES ('${id}', 't1', 'L', '[]', 'personal', 'h-${id}'${extra})`;
  expect(() => db.exec(key("missing-tenant").replace("'t1'", "'no-such-tenant'"))).toThrow();
  db.exec(key("k1"));
  // A personal key without a hash violates the mode-shape check.
  expect(() =>
    db.exec("INSERT INTO api_keys (id, tenant_id, label, scopes, key_mode) VALUES ('k2', 't1', 'L', '[]', 'personal')"),
  ).toThrow();

  db.exec(key("k3", ", 1"));
  // One live default key per tenant: the partial unique index rejects a second.
  expect(() => db.exec(key("k4", ", 1"))).toThrow();

  db.exec("DELETE FROM tenants WHERE id = 't1'");
  const remaining = db.prepare("SELECT count(*) AS c FROM api_keys").get() as { c: number };
  expect(remaining.c).toBe(0);

  const stamped = db.prepare("SELECT created_at FROM tenants WHERE id = 'z' OR status = 'active'").all();
  expect(stamped).toHaveLength(0);
  db.exec("INSERT INTO tenants (id, name, status) VALUES ('t3', 'B', 'active')");
  const created = db.prepare("SELECT created_at FROM tenants WHERE id = 't3'").get() as { created_at: string };
  expect(created.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});

test("a new SQLite tenant can load an empty model-alias list", async () => {
  const sqlite = createSqliteDatabase(":memory:");
  try {
    await applySqliteMigrations(sqlite);
    const { db } = buildSqliteHandle(sqlite);
    const tenantId = randomUUID();
    await db.insert(tenants).values({ id: tenantId, name: "first boot", status: "active" });
    const store = new DrizzleModelRoutingStore(db);

    expect(await store.listAliases(tenantId)).toEqual([]);
  } finally {
    sqlite.close();
  }
});

test("SQLite migration upgrades existing databases to allow multiple shared keys per IP", async () => {
  const sqlite = migratedDatabase();
  try {
    sqlite.exec(
      `CREATE TABLE ${MIGRATION_LEDGER_TABLE} (` +
        "migration_id text PRIMARY KEY, applied_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))",
    );
    const marker = baselineSchemaMarker(committed);
    sqlite
      .prepare(`INSERT INTO ${MIGRATION_LEDGER_TABLE} (migration_id) VALUES (?)`)
      .run("0000_baseline.sql");
    sqlite
      .prepare(`INSERT INTO ${MIGRATION_LEDGER_TABLE} (migration_id) VALUES (?)`)
      .run(marker);
    sqlite.exec("INSERT INTO tenants (id, name, status) VALUES ('tenant', 'Test', 'active')");
    sqlite.exec(
      "INSERT INTO api_keys (id, tenant_id, key_mode, label, scopes) VALUES ('template', 'tenant', 'share', 'Template', '[]')",
    );
    sqlite.exec(
      "INSERT INTO api_keys (id, tenant_id, key_mode, parent_key_id, issued_client_ip, issued_client_ip_key, key_hash, label, scopes) " +
        "VALUES ('child-1', 'tenant', 'share', 'template', '192.0.2.1', '192.0.2.1', 'hash-child-1', 'child-1', '[]')",
    );

    await applySqliteMigrations(sqlite);
    sqlite.exec(
      "INSERT INTO api_keys (id, tenant_id, key_mode, parent_key_id, issued_client_ip, issued_client_ip_key, key_hash, label, scopes) " +
        "VALUES ('child-2', 'tenant', 'share', 'template', '192.0.2.1', '192.0.2.1', 'hash-child-2', 'child-2', '[]')",
    );
    const children = sqlite
      .query("SELECT count(*) AS count FROM api_keys WHERE parent_key_id = 'template' AND revoked_at IS NULL")
      .get() as { count: number };
    expect(children.count).toBe(2);
  } finally {
    sqlite.close();
  }
});

/**
 * A comment-only edit to the baseline must not lock out existing databases.
 *
 * This is the 2.4.6 regression, reproduced: the marker was the sha256 of the raw
 * file text, so changing a comment in the header changed the marker, and every
 * database created by 2.4.5 refused to boot with "different baseline schema".
 * The schema had not changed at all.
 *
 * The marker now hashes the statements with comments stripped, and the markers
 * older releases recorded are accepted for the same schema.
 */
const withExtraComment = `${committed}\n-- an added comment must not change the schema identity\n`;

test("a comment-only edit leaves the baseline marker unchanged", () => {
  expect(baselineSchemaMarker(withExtraComment)).toBe(baselineSchemaMarker(committed));
});

test("the baseline markers recorded by 2.4.x are accepted for this schema", () => {
  const accepted = acceptedBaselineSchemaMarkers(committed);
  expect(accepted).toContain(baselineSchemaMarker(committed));
  // Frozen history: databases created by v2.4.0-v2.4.5 carry this one.
  expect(accepted).toContain(
    "baseline-schema:438c5e014c5f86f483a84e8a106b0e62143d4eb0b0daad728a300bcc683d8c02",
  );
});

test("a genuinely different baseline schema is still rejected", () => {
  // Any real schema change must produce a different identity. Appending a column
  // is the smallest such change and does not depend on exact baseline wording.
  const different = `${committed}\nCREATE TABLE "added_later" ("id" text PRIMARY KEY);\n`;
  expect(different).not.toBe(committed);
  // The *current* marker must move, so a database built from the changed schema
  // is not accepted under the identity of the old one.
  expect(baselineSchemaMarker(different)).not.toBe(baselineSchemaMarker(committed));
});
