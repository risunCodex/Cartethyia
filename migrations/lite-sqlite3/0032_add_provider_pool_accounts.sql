-- Pool-as-account routing entities for ip-scoped, credential-less providers.
--
-- Mirror of `full-postgres/0032_add_provider_pool_accounts.sql`; see that file
-- for the rationale. SQLite representation: `id`/`tenant_id`/`network_pool_id`
-- are text (uuid), `status` is text with a CHECK, timestamps are text.
CREATE TABLE IF NOT EXISTS "provider_pool_accounts" (
  "id"            text PRIMARY KEY,
  "tenant_id"     text NOT NULL REFERENCES "tenants" ("id") ON DELETE CASCADE,
  "network_pool_id" text NOT NULL REFERENCES "network_pools" ("id") ON DELETE CASCADE,
  "provider_id"    text NOT NULL,
  "label"          text NOT NULL,
  "status"         text NOT NULL DEFAULT 'active'
                  CHECK ("status" IN ('active', 'cooldown', 'disabled')),
  "consecutive_failures" integer NOT NULL DEFAULT 0,
  "last_success_at" text,
  "last_error"      text,
  "last_error_category" text,
  "last_error_at"    text,
  "cooldown_until"  text,
  "last_recovered_at" text,
  "created_at"      text NOT NULL DEFAULT (datetime('now')),
  "updated_at"      text NOT NULL DEFAULT (datetime('now')),
  CONSTRAINT provider_pool_accounts_pool_provider_uidx
    UNIQUE ("network_pool_id", "provider_id", "tenant_id")
);

CREATE INDEX IF NOT EXISTS provider_pool_accounts_tenant_status_idx
  ON "provider_pool_accounts" ("tenant_id", "status");
CREATE INDEX IF NOT EXISTS provider_pool_accounts_provider_status_idx
  ON "provider_pool_accounts" ("provider_id", "status");

-- Backfill: every existing pool × ip-scoped provider gets its row. The
-- ip-scoped set is OpenCode Free today; the provider id is spelled here so the
-- rule stays a data fact, not a code constant. SQLite's bun driver rejects the
-- newer `ON CONFLICT DO NOTHING` on an INSERT…SELECT, so the equivalent
-- `INSERT OR IGNORE` form is used here (Postgres version keeps the standard one).
INSERT OR IGNORE INTO "provider_pool_accounts"
  ("tenant_id", "network_pool_id", "provider_id", "label")
SELECT
  p."tenant_id",
  p."id",
  'opencode',
  'Pool ' || substr(p."id", 1, 8)
FROM "network_pools" p;
