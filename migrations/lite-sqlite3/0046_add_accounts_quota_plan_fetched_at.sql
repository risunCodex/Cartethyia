-- SQLite mirror of `full-postgres/0046_add_accounts_quota_plan_fetched_at.sql`:
-- the timestamp column is stored as an ISO-8601 text string.
ALTER TABLE "provider_accounts"
  ADD COLUMN "quota_plan_fetched_at" text;
