-- SQLite mirror of `full-postgres/0038_add_accounts_quota_snapshot.sql`:
-- the column is `text` (the SQLite representation of jsonb).
ALTER TABLE "provider_accounts"
  ADD COLUMN "quota_snapshot" text;
