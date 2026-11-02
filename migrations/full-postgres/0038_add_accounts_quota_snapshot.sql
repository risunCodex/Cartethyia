-- Last successful quota read, persisted as JSON so an account's balance
-- survives a process restart (the in-process quota cache does not).
--
-- Only a successful read is stored; a failed fetch leaves the previous
-- snapshot in place, mirroring `quota_plan`.
ALTER TABLE "provider_accounts"
  ADD COLUMN IF NOT EXISTS "quota_snapshot" jsonb;
