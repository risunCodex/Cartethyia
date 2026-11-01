-- API-key ban expiry. Mirror of `full-postgres/0034_add_api_key_ban_until.sql`;
-- SQLite stores timestamps as text (ISO), and each `ALTER TABLE ... ADD COLUMN`
-- may carry exactly one column.
ALTER TABLE "api_keys"
  ADD COLUMN "banned_until" text;
