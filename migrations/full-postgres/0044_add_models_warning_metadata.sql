-- Adds `models.warning_metadata` (jsonb, nullable) — display-only warning
-- metadata for a model row, carried as `{ warnings: [{ kind, message,
-- severity?, updatedAt? }] }`. NULL means "no warnings"; the column is not
-- read by routing. Part of the provider-account model-update proposal §3.4
-- (area 06).
--
-- Idempotency comes from the migration ledger plus `ADD COLUMN IF NOT EXISTS`:
-- a database built from a newer baseline that already carries the column must
-- not fail startup.
ALTER TABLE "models" ADD COLUMN IF NOT EXISTS "warning_metadata" jsonb;
