-- API-key ban state.
--
-- A ban is distinct from revoke (terminal, tombstone-like) and disable
-- (operator toggle, reversible): it records *why* a key was banned
-- (`ban_reason`) for the console's "See reason" modal. Unban clears both
-- columns entirely — no tombstone, no leftover metadata.
ALTER TABLE "api_keys"
  ADD COLUMN "banned_at" timestamptz,
  ADD COLUMN "ban_reason" text;
