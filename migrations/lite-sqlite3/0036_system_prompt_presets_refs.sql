-- Tenant system-prompt injection: presets + combo/alias scopes + scope refs.
--
-- Legacy shape: `providers` (followGlobal + optional inline setting), `models`
-- (providerId::modelId -> setting). New shape: every scope map stores a
-- reference, and a named preset collection is introduced. Legacy rows remain
-- readable (the store's defensive reader normalizes them); this migration only
-- adds the new columns so the new shapes can be written.
--
-- SQLite stores JSON as TEXT, so the new maps are TEXT columns with an
-- empty-object default, mirroring the existing `providers`/`models` TEXT
-- columns.
ALTER TABLE "tenant_system_prompts" ADD COLUMN "presets" TEXT NOT NULL DEFAULT '{}';
ALTER TABLE "tenant_system_prompts" ADD COLUMN "combos" TEXT NOT NULL DEFAULT '{}';
ALTER TABLE "tenant_system_prompts" ADD COLUMN "aliases" TEXT NOT NULL DEFAULT '{}';
