-- API-key ban state. Mirror of `full-postgres/0033_add_api_key_ban.sql`;
-- SQLite stores timestamps as text (ISO), and each `ALTER TABLE ... ADD COLUMN`
-- may carry exactly one column.
ALTER TABLE "api_keys"
  ADD COLUMN "banned_at" text;

ALTER TABLE "api_keys"
  ADD COLUMN "ban_reason" text;
