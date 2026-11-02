-- Explicit wire dialect per model row (nullable; absent = resolver fallback).
-- See documentation/features/09-wire-dialects.md.
ALTER TABLE "models" ADD COLUMN "dialect" TEXT;
