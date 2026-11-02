-- Tenant system-prompt injection: presets + combo/alias scopes + scope refs.
--
-- Legacy shape: `providers` (followGlobal + optional inline setting), `models`
-- (providerId::modelId -> setting). New shape: every scope map stores a
-- reference, and a named preset collection is introduced. Legacy rows remain
-- readable (the store's defensive reader normalizes them); this migration only
-- adds the new columns so the new shapes can be written.
ALTER TABLE "tenant_system_prompts" ADD COLUMN "presets" jsonb NOT NULL DEFAULT '{}';
ALTER TABLE "tenant_system_prompts" ADD COLUMN "combos" jsonb NOT NULL DEFAULT '{}';
ALTER TABLE "tenant_system_prompts" ADD COLUMN "aliases" jsonb NOT NULL DEFAULT '{}';
