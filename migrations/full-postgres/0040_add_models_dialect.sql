-- Explicit wire dialect per model row (nullable; absent = resolver fallback).
-- See documentation/proposals/wire-dialects.md.
ALTER TABLE "models" ADD COLUMN "dialect" TEXT;
