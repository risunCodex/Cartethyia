-- Adds `provider_routing_settings.custom_user_agent` (text, nullable) — an
-- operator-set custom User-Agent stored separately from the provider's native
-- client identity (`user_agent`). SQLite stores text as-is; NULL = no custom
-- override (native identity is used).
--
-- Idempotency comes from the migration ledger, not from the statement: the
-- runner records the file inside the same transaction, so a file that has
-- already run is never re-executed. The baseline is generated from
-- `0000_baseline.sql` alone and does not carry this column.
ALTER TABLE "provider_routing_settings" ADD COLUMN "custom_user_agent" text;