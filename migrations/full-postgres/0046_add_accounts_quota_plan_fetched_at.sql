-- Freshness stamp for `quota_plan`: the plan column is a bare string, so
-- routing cannot tell a fresh read from a stale one. This timestamp is written
-- together with `quota_plan` on a successful quota fetch and lets the routing
-- engine downgrade a plan older than the freshness horizon to `unknown`
-- instead of trusting it blindly.
ALTER TABLE "provider_accounts"
  ADD COLUMN IF NOT EXISTS "quota_plan_fetched_at" timestamptz;
