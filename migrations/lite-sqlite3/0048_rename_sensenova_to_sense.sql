-- Rename the SenseNova provider ids. The two deployments are separate
-- providers with separate hosts and catalogs (their keys reject each other
-- with 401 "Forbidden"), and the ids now say which realm they serve:
--
--   sensenova      -> sensecn    (SenseNova China, token.sensenova.cn)
--   sensenova-intl -> senseintl  (SenseNova Intl, token.sensenova.ai)
--
-- Same pattern as 0045 (workbuddy -> cb): the parent `providers` row is
-- copied under the new id, every dependent table is repointed, and the old
-- row is dropped last, all inside the migration transaction. A database that
-- never had the old ids is unaffected — every statement matches zero rows.

-- ── sensenova -> sensecn ────────────────────────────────────────────────────────

INSERT INTO "providers" (
  "id", "tenant_id", "wire_family_default", "capability_profile", "base_url",
  "compatibility_profile", "enabled", "requires_account"
)
SELECT
  'sensecn', "tenant_id", "wire_family_default", "capability_profile", "base_url",
  "compatibility_profile", "enabled", "requires_account"
FROM "providers"
WHERE "id" = 'sensenova'
ON CONFLICT ("id") DO NOTHING;

-- Drop rows the repoint would collide with on a unique index.
DELETE FROM "models"
  WHERE "provider_id" = 'sensenova'
    AND EXISTS (SELECT 1 FROM "providers" WHERE "id" = 'sensecn')
    AND EXISTS (
      SELECT 1 FROM "models" AS keep
      WHERE keep."provider_id" = 'sensecn'
        AND keep."model_id" = "models"."model_id"
        AND keep."endpoint_path" = "models"."endpoint_path"
    );
DELETE FROM "tenant_disabled_models"
  WHERE "provider_id" = 'sensenova'
    AND EXISTS (SELECT 1 FROM "providers" WHERE "id" = 'sensecn')
    AND EXISTS (
      SELECT 1 FROM "tenant_disabled_models" AS keep
      WHERE keep."provider_id" = 'sensecn'
        AND keep."tenant_id" = "tenant_disabled_models"."tenant_id"
        AND keep."model_id" = "tenant_disabled_models"."model_id"
        AND keep."endpoint_path" = "tenant_disabled_models"."endpoint_path"
    );
DELETE FROM "provider_accounts"
  WHERE "provider_id" = 'sensenova'
    AND EXISTS (SELECT 1 FROM "providers" WHERE "id" = 'sensecn')
    AND EXISTS (
      SELECT 1 FROM "provider_accounts" AS keep
      WHERE keep."provider_id" = 'sensecn'
        AND keep."tenant_id" IS NOT DISTINCT FROM "provider_accounts"."tenant_id"
        AND keep."credential_fingerprint" IS NOT DISTINCT FROM "provider_accounts"."credential_fingerprint"
    );
DELETE FROM "provider_routing_settings"
  WHERE "provider_id" = 'sensenova'
    AND EXISTS (SELECT 1 FROM "providers" WHERE "id" = 'sensecn')
    AND EXISTS (
      SELECT 1 FROM "provider_routing_settings" AS keep
      WHERE keep."provider_id" = 'sensecn'
        AND keep."tenant_id" IS NOT DISTINCT FROM "provider_routing_settings"."tenant_id"
    );
DELETE FROM "provider_pool_accounts"
  WHERE "provider_id" = 'sensenova'
    AND EXISTS (SELECT 1 FROM "providers" WHERE "id" = 'sensecn')
    AND EXISTS (
      SELECT 1 FROM "provider_pool_accounts" AS keep
      WHERE keep."provider_id" = 'sensecn'
        AND keep."network_pool_id" = "provider_pool_accounts"."network_pool_id"
        AND keep."tenant_id" IS NOT DISTINCT FROM "provider_pool_accounts"."tenant_id"
    );

UPDATE "provider_accounts" SET "provider_id" = 'sensecn'
  WHERE "provider_id" = 'sensenova'
    AND EXISTS (SELECT 1 FROM "providers" WHERE "id" = 'sensecn');
UPDATE "models" SET "provider_id" = 'sensecn'
  WHERE "provider_id" = 'sensenova'
    AND EXISTS (SELECT 1 FROM "providers" WHERE "id" = 'sensecn');
UPDATE "tenant_disabled_models" SET "provider_id" = 'sensecn'
  WHERE "provider_id" = 'sensenova'
    AND EXISTS (SELECT 1 FROM "providers" WHERE "id" = 'sensecn');
UPDATE "provider_routing_settings" SET "provider_id" = 'sensecn'
  WHERE "provider_id" = 'sensenova'
    AND EXISTS (SELECT 1 FROM "providers" WHERE "id" = 'sensecn');
UPDATE "provider_pool_accounts" SET "provider_id" = 'sensecn'
  WHERE "provider_id" = 'sensenova'
    AND EXISTS (SELECT 1 FROM "providers" WHERE "id" = 'sensecn');
UPDATE "network_pools" SET "provider_probe_provider_id" = 'sensecn'
  WHERE "provider_probe_provider_id" = 'sensenova';
UPDATE "telemetry_events" SET "provider_id" = 'sensecn'
  WHERE "provider_id" = 'sensenova'
    AND EXISTS (SELECT 1 FROM "providers" WHERE "id" = 'sensecn');

DELETE FROM "providers"
  WHERE "id" = 'sensenova'
    AND EXISTS (SELECT 1 FROM "providers" WHERE "id" = 'sensecn');

-- ── sensenova-intl -> senseintl ────────────────────────────────────────────────────────

INSERT INTO "providers" (
  "id", "tenant_id", "wire_family_default", "capability_profile", "base_url",
  "compatibility_profile", "enabled", "requires_account"
)
SELECT
  'senseintl', "tenant_id", "wire_family_default", "capability_profile", "base_url",
  "compatibility_profile", "enabled", "requires_account"
FROM "providers"
WHERE "id" = 'sensenova-intl'
ON CONFLICT ("id") DO NOTHING;

-- Drop rows the repoint would collide with on a unique index.
DELETE FROM "models"
  WHERE "provider_id" = 'sensenova-intl'
    AND EXISTS (SELECT 1 FROM "providers" WHERE "id" = 'senseintl')
    AND EXISTS (
      SELECT 1 FROM "models" AS keep
      WHERE keep."provider_id" = 'senseintl'
        AND keep."model_id" = "models"."model_id"
        AND keep."endpoint_path" = "models"."endpoint_path"
    );
DELETE FROM "tenant_disabled_models"
  WHERE "provider_id" = 'sensenova-intl'
    AND EXISTS (SELECT 1 FROM "providers" WHERE "id" = 'senseintl')
    AND EXISTS (
      SELECT 1 FROM "tenant_disabled_models" AS keep
      WHERE keep."provider_id" = 'senseintl'
        AND keep."tenant_id" = "tenant_disabled_models"."tenant_id"
        AND keep."model_id" = "tenant_disabled_models"."model_id"
        AND keep."endpoint_path" = "tenant_disabled_models"."endpoint_path"
    );
DELETE FROM "provider_accounts"
  WHERE "provider_id" = 'sensenova-intl'
    AND EXISTS (SELECT 1 FROM "providers" WHERE "id" = 'senseintl')
    AND EXISTS (
      SELECT 1 FROM "provider_accounts" AS keep
      WHERE keep."provider_id" = 'senseintl'
        AND keep."tenant_id" IS NOT DISTINCT FROM "provider_accounts"."tenant_id"
        AND keep."credential_fingerprint" IS NOT DISTINCT FROM "provider_accounts"."credential_fingerprint"
    );
DELETE FROM "provider_routing_settings"
  WHERE "provider_id" = 'sensenova-intl'
    AND EXISTS (SELECT 1 FROM "providers" WHERE "id" = 'senseintl')
    AND EXISTS (
      SELECT 1 FROM "provider_routing_settings" AS keep
      WHERE keep."provider_id" = 'senseintl'
        AND keep."tenant_id" IS NOT DISTINCT FROM "provider_routing_settings"."tenant_id"
    );
DELETE FROM "provider_pool_accounts"
  WHERE "provider_id" = 'sensenova-intl'
    AND EXISTS (SELECT 1 FROM "providers" WHERE "id" = 'senseintl')
    AND EXISTS (
      SELECT 1 FROM "provider_pool_accounts" AS keep
      WHERE keep."provider_id" = 'senseintl'
        AND keep."network_pool_id" = "provider_pool_accounts"."network_pool_id"
        AND keep."tenant_id" IS NOT DISTINCT FROM "provider_pool_accounts"."tenant_id"
    );

UPDATE "provider_accounts" SET "provider_id" = 'senseintl'
  WHERE "provider_id" = 'sensenova-intl'
    AND EXISTS (SELECT 1 FROM "providers" WHERE "id" = 'senseintl');
UPDATE "models" SET "provider_id" = 'senseintl'
  WHERE "provider_id" = 'sensenova-intl'
    AND EXISTS (SELECT 1 FROM "providers" WHERE "id" = 'senseintl');
UPDATE "tenant_disabled_models" SET "provider_id" = 'senseintl'
  WHERE "provider_id" = 'sensenova-intl'
    AND EXISTS (SELECT 1 FROM "providers" WHERE "id" = 'senseintl');
UPDATE "provider_routing_settings" SET "provider_id" = 'senseintl'
  WHERE "provider_id" = 'sensenova-intl'
    AND EXISTS (SELECT 1 FROM "providers" WHERE "id" = 'senseintl');
UPDATE "provider_pool_accounts" SET "provider_id" = 'senseintl'
  WHERE "provider_id" = 'sensenova-intl'
    AND EXISTS (SELECT 1 FROM "providers" WHERE "id" = 'senseintl');
UPDATE "network_pools" SET "provider_probe_provider_id" = 'senseintl'
  WHERE "provider_probe_provider_id" = 'sensenova-intl';
UPDATE "telemetry_events" SET "provider_id" = 'senseintl'
  WHERE "provider_id" = 'sensenova-intl'
    AND EXISTS (SELECT 1 FROM "providers" WHERE "id" = 'senseintl');

DELETE FROM "providers"
  WHERE "id" = 'sensenova-intl'
    AND EXISTS (SELECT 1 FROM "providers" WHERE "id" = 'senseintl');
