-- Share-template concurrency scope: family (one cap for all recipients, the
-- default) vs per_key (each recipient key carries its own cap and counter).
ALTER TABLE "api_keys" ADD COLUMN "concurrency_scope" TEXT NOT NULL DEFAULT 'family';
