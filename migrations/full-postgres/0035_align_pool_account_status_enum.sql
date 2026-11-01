-- Align `provider_pool_accounts.status` with the shared `health_status` enum.
--
-- The table was created with a `text` column plus an inline CHECK (migration
-- 0032), while every other health-state column uses the `health_status` enum.
-- The Drizzle schema declares the enum, so the drift checker reported the text
-- column and its CHECK as "produced by migrations but not in schema". This
-- migration rewrites the column to the enum: same allowed values, one
-- canonical type.
--
-- The inline CHECK from 0032 must be dropped first: PostgreSQL rewrites
-- CHECK expressions during an ALTER TYPE, and the old `status IN ('active',
-- ...)` expression compares the new enum column against text literals, which
-- has no operator once the column becomes the enum.

ALTER TABLE "provider_pool_accounts" DROP CONSTRAINT "provider_pool_accounts_status_check";

ALTER TABLE "provider_pool_accounts"
  ALTER COLUMN "status" DROP DEFAULT,
  ALTER COLUMN "status" SET DATA TYPE "public"."health_status"
    USING "status"::"public"."health_status",
  ALTER COLUMN "status" SET DEFAULT 'active';
