-- Pool-as-account routing entities for ip-scoped, credential-less providers.
--
-- For providers whose rate limit follows the egress address (OpenCode Free),
-- the pool is the resource that runs out — but it was invisible to account-level
-- health and routing because the provider owns no `provider_accounts` rows.
-- This table materializes one row per (pool × ip-scoped provider), carrying the
-- same health state machine (`status`, `cooldown_until`, …) so a spent egress
-- is excluded from routing plans exactly like a cooling account, and shows in
-- the provider's Accounts card with a "Pool" badge.
--
-- The row is an account-equivalent, not an account: it resolves no credential,
-- is skipped by quota-refresh and identity sweeps (they filter on real
-- credential kinds), and is owned by its pool — deleting the pool cascades the
-- row. Rows are backfilled here for every existing pool × ip-scoped provider so
-- no operator action is needed to adopt the feature.
CREATE TABLE IF NOT EXISTS "provider_pool_accounts" (
  "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"     uuid NOT NULL REFERENCES "tenants" ("id") ON DELETE CASCADE,
  "network_pool_id" uuid NOT NULL REFERENCES "network_pools" ("id") ON DELETE CASCADE,
  "provider_id"    text NOT NULL,
  "label"          text NOT NULL,
  "status"         text NOT NULL DEFAULT 'active'
                  CHECK ("status" IN ('active', 'cooldown', 'disabled')),
  "consecutive_failures" integer NOT NULL DEFAULT 0,
  "last_success_at" timestamptz,
  "last_error"      text,
  "last_error_category" text,
  "last_error_at"    timestamptz,
  "cooldown_until"  timestamptz,
  "last_recovered_at" timestamptz,
  "created_at"      timestamptz NOT NULL DEFAULT now(),
  "updated_at"      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT provider_pool_accounts_pool_provider_uidx
    UNIQUE ("network_pool_id", "provider_id", "tenant_id")
);

CREATE INDEX IF NOT EXISTS provider_pool_accounts_tenant_status_idx
  ON "provider_pool_accounts" ("tenant_id", "status");
CREATE INDEX IF NOT EXISTS provider_pool_accounts_provider_status_idx
  ON "provider_pool_accounts" ("provider_id", "status");

-- Backfill: every existing pool × ip-scoped provider gets its row. The
-- ip-scoped set is OpenCode Free today; the provider id is spelled here so the
-- rule stays a data fact, not a code constant.
INSERT INTO "provider_pool_accounts"
  ("tenant_id", "network_pool_id", "provider_id", "label")
SELECT
  p."tenant_id",
  p."id",
  'opencode',
  'Pool ' || left(p."id"::text, 8)
FROM "network_pools" p
ON CONFLICT ("network_pool_id", "provider_id", "tenant_id") DO NOTHING;
