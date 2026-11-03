-- `daily_checkin_ledger.account_id` referenced `provider_accounts.id` only by
-- convention; deleting an account left orphan ledger rows behind. This adds the
-- missing FK with `ON DELETE CASCADE` so a deleted account's daily check-in
-- markers go with it.
ALTER TABLE "daily_checkin_ledger"
  ADD CONSTRAINT "daily_checkin_ledger_account_id_provider_accounts_id_fk"
  FOREIGN KEY ("account_id") REFERENCES "provider_accounts" ("id") ON DELETE CASCADE;
