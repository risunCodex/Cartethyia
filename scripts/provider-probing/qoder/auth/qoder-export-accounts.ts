/**
 * Extracts Qoder accounts from the local Cartethyia SQLite store into the
 * probe accounts JSON format.
 *
 * Usage (from repo root, with CARTETHYIA_ENCRYPTION_KEY set):
 *
 *   bun run scripts/provider-probing/qoder/auth/qoder-export-accounts.ts \
 *     "C:\Users\...\AppData\Roaming\cartethyia\cartethyia.sqlite" \
 *     "D:\tmp\scratch\qoder-accounts-probe.json"
 *
 * The SQLite path and output path are positional args; the encryption key must
 * be in the environment (normally from `.env`). The output file is meant for
 * probe scripts only — never commit it.
 */
import { exportProviderAccounts } from "../../lib/export-accounts";

const dbPath = process.argv[2];
const outPath = process.argv[3];
if (!dbPath || !outPath) {
  console.error("usage: bun qoder-export-accounts.ts <sqlite> <out.json>");
  process.exit(1);
}

exportProviderAccounts(dbPath, outPath, "qoder");
