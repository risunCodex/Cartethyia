-- API-key ban expiry.
--
-- A ban may now carry an optional `banned_until`: a timed ban lifts on its
-- own (auth checks `banned_at` against `banned_until`), while `null` keeps the
-- earlier permanent-ban behavior. Unban clears all three ban columns.
ALTER TABLE "api_keys"
  ADD COLUMN "banned_until" timestamptz;
