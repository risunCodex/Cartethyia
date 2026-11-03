-- `daily_checkin_ledger.account_id` referenced `provider_accounts.id` only by
-- convention; deleting an account left orphan ledger rows behind. This adds the
-- missing FK with `ON DELETE CASCADE` so a deleted account's daily check-in
-- markers go with it.
--
-- SQLite cannot add a FK to an existing table in place, so the ledger is
-- rebuilt with the constraint. The runner wraps the file in a transaction, so
-- `PRAGMA foreign_keys = OFF` is unusable (a no-op inside a transaction);
-- `defer_foreign_keys` postpones enforcement to commit time instead, letting
-- the drop/rename complete mid-rebuild.

PRAGMA defer_foreign_keys = ON;

CREATE TABLE "daily_checkin_ledger__new" (
  "day_key" text NOT NULL,
  "account_id" text NOT NULL,
  "claimed_at" text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
  CONSTRAINT "daily_checkin_ledger_day_key_account_id_pk" PRIMARY KEY("day_key", "account_id"),
  CONSTRAINT "daily_checkin_ledger_account_id_provider_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "provider_accounts"("id") ON DELETE cascade
);
INSERT INTO "daily_checkin_ledger__new" ("day_key", "account_id", "claimed_at")
  SELECT "day_key", "account_id", "claimed_at" FROM "daily_checkin_ledger";
DROP TABLE "daily_checkin_ledger";
ALTER TABLE "daily_checkin_ledger__new" RENAME TO "daily_checkin_ledger";

PRAGMA defer_foreign_keys = OFF;
