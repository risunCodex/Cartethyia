-- Migrate WorkBuddy provider data onto the CodeBuddy providers, then drop
-- the WorkBuddy providers entirely.
--
--   workbuddy   -> cb    (CodeBuddy intl)
--   workbuddycn -> cbcn  (CodeBuddy CN)
--
-- This mirrors the opencode rename pattern: the parent `providers` row is
-- copied under the new id, every dependent table is repointed, and the old
-- row is dropped last. Inside the migration transaction this is atomic.
--
-- A database that never had the WorkBuddy ids is unaffected — every statement
-- matches zero rows. If a deployment somehow carries both spellings, the
-- repoint merges them onto the new id, which is the correct outcome for one
-- provider with two names.

-- ── workbuddy -> cb ────────────────────────────────────────────────────────

INSERT INTO "providers" (
  "id", "tenant_id", "wire_family_default", "capability_profile", "base_url",
  "compatibility_profile", "enabled", "requires_account"
)
SELECT
  'cb', "tenant_id", "wire_family_default", "capability_profile", "base_url",
  "compatibility_profile", "enabled", "requires_account"
FROM "providers"
WHERE "id" = 'workbuddy'
ON CONFLICT ("id") DO NOTHING;

-- Drop rows the repoint would collide with on a unique index.
DELETE FROM "models"
  WHERE "provider_id" = 'workbuddy'
    AND EXISTS (SELECT 1 FROM "providers" WHERE "id" = 'cb')
    AND EXISTS (
      SELECT 1 FROM "models" AS keep
      WHERE keep."provider_id" = 'cb'
        AND keep."model_id" = "models"."model_id"
        AND keep."endpoint_path" = "models"."endpoint_path"
    );
DELETE FROM "tenant_disabled_models"
  WHERE "provider_id" = 'workbuddy'
    AND EXISTS (SELECT 1 FROM "providers" WHERE "id" = 'cb')
    AND EXISTS (
      SELECT 1 FROM "tenant_disabled_models" AS keep
      WHERE keep."provider_id" = 'cb'
        AND keep."tenant_id" = "tenant_disabled_models"."tenant_id"
        AND keep."model_id" = "tenant_disabled_models"."model_id"
        AND keep."endpoint_path" = "tenant_disabled_models"."endpoint_path"
    );
DELETE FROM "provider_accounts"
  WHERE "provider_id" = 'workbuddy'
    AND EXISTS (SELECT 1 FROM "providers" WHERE "id" = 'cb')
    AND EXISTS (
      SELECT 1 FROM "provider_accounts" AS keep
      WHERE keep."provider_id" = 'cb'
        AND keep."tenant_id" IS NOT DISTINCT FROM "provider_accounts"."tenant_id"
        AND keep."credential_fingerprint" IS NOT DISTINCT FROM "provider_accounts"."credential_fingerprint"
    );
DELETE FROM "provider_routing_settings"
  WHERE "provider_id" = 'workbuddy'
    AND EXISTS (SELECT 1 FROM "providers" WHERE "id" = 'cb')
    AND EXISTS (
      SELECT 1 FROM "provider_routing_settings" AS keep
      WHERE keep."provider_id" = 'cb'
        AND keep."tenant_id" IS NOT DISTINCT FROM "provider_routing_settings"."tenant_id"
    );

UPDATE "provider_accounts" SET "provider_id" = 'cb'
  WHERE "provider_id" = 'workbuddy'
    AND EXISTS (SELECT 1 FROM "providers" WHERE "id" = 'cb');
UPDATE "models" SET "provider_id" = 'cb'
  WHERE "provider_id" = 'workbuddy'
    AND EXISTS (SELECT 1 FROM "providers" WHERE "id" = 'cb');
UPDATE "tenant_disabled_models" SET "provider_id" = 'cb'
  WHERE "provider_id" = 'workbuddy'
    AND EXISTS (SELECT 1 FROM "providers" WHERE "id" = 'cb');
UPDATE "provider_routing_settings" SET "provider_id" = 'cb'
  WHERE "provider_id" = 'workbuddy'
    AND EXISTS (SELECT 1 FROM "providers" WHERE "id" = 'cb');
UPDATE "telemetry_events" SET "provider_id" = 'cb'
  WHERE "provider_id" = 'workbuddy'
    AND EXISTS (SELECT 1 FROM "providers" WHERE "id" = 'cb');

DELETE FROM "providers"
  WHERE "id" = 'workbuddy'
    AND EXISTS (SELECT 1 FROM "providers" WHERE "id" = 'cb');

-- ── workbuddycn -> cbcn ──────────────────────────────────────────────────────

INSERT INTO "providers" (
  "id", "tenant_id", "wire_family_default", "capability_profile", "base_url",
  "compatibility_profile", "enabled", "requires_account"
)
SELECT
  'cbcn', "tenant_id", "wire_family_default", "capability_profile", "base_url",
  "compatibility_profile", "enabled", "requires_account"
FROM "providers"
WHERE "id" = 'workbuddycn'
ON CONFLICT ("id") DO NOTHING;

-- Drop rows the repoint would collide with on a unique index.
DELETE FROM "models"
  WHERE "provider_id" = 'workbuddycn'
    AND EXISTS (SELECT 1 FROM "providers" WHERE "id" = 'cbcn')
    AND EXISTS (
      SELECT 1 FROM "models" AS keep
      WHERE keep."provider_id" = 'cbcn'
        AND keep."model_id" = "models"."model_id"
        AND keep."endpoint_path" = "models"."endpoint_path"
    );
DELETE FROM "tenant_disabled_models"
  WHERE "provider_id" = 'workbuddycn'
    AND EXISTS (SELECT 1 FROM "providers" WHERE "id" = 'cbcn')
    AND EXISTS (
      SELECT 1 FROM "tenant_disabled_models" AS keep
      WHERE keep."provider_id" = 'cbcn'
        AND keep."tenant_id" = "tenant_disabled_models"."tenant_id"
        AND keep."model_id" = "tenant_disabled_models"."model_id"
        AND keep."endpoint_path" = "tenant_disabled_models"."endpoint_path"
    );
DELETE FROM "provider_accounts"
  WHERE "provider_id" = 'workbuddycn'
    AND EXISTS (SELECT 1 FROM "providers" WHERE "id" = 'cbcn')
    AND EXISTS (
      SELECT 1 FROM "provider_accounts" AS keep
      WHERE keep."provider_id" = 'cbcn'
        AND keep."tenant_id" IS NOT DISTINCT FROM "provider_accounts"."tenant_id"
        AND keep."credential_fingerprint" IS NOT DISTINCT FROM "provider_accounts"."credential_fingerprint"
    );
DELETE FROM "provider_routing_settings"
  WHERE "provider_id" = 'workbuddycn'
    AND EXISTS (SELECT 1 FROM "providers" WHERE "id" = 'cbcn')
    AND EXISTS (
      SELECT 1 FROM "provider_routing_settings" AS keep
      WHERE keep."provider_id" = 'cbcn'
        AND keep."tenant_id" IS NOT DISTINCT FROM "provider_routing_settings"."tenant_id"
    );

UPDATE "provider_accounts" SET "provider_id" = 'cbcn'
  WHERE "provider_id" = 'workbuddycn'
    AND EXISTS (SELECT 1 FROM "providers" WHERE "id" = 'cbcn');
UPDATE "models" SET "provider_id" = 'cbcn'
  WHERE "provider_id" = 'workbuddycn'
    AND EXISTS (SELECT 1 FROM "providers" WHERE "id" = 'cbcn');
UPDATE "tenant_disabled_models" SET "provider_id" = 'cbcn'
  WHERE "provider_id" = 'workbuddycn'
    AND EXISTS (SELECT 1 FROM "providers" WHERE "id" = 'cbcn');
UPDATE "provider_routing_settings" SET "provider_id" = 'cbcn'
  WHERE "provider_id" = 'workbuddycn'
    AND EXISTS (SELECT 1 FROM "providers" WHERE "id" = 'cbcn');
UPDATE "telemetry_events" SET "provider_id" = 'cbcn'
  WHERE "provider_id" = 'workbuddycn'
    AND EXISTS (SELECT 1 FROM "providers" WHERE "id" = 'cbcn');

DELETE FROM "providers"
  WHERE "id" = 'workbuddycn'
    AND EXISTS (SELECT 1 FROM "providers" WHERE "id" = 'cbcn');
