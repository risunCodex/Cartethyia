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
import { Database } from "bun:sqlite";
import { writeFileSync } from "node:fs";
import { decryptCredentialToString } from "../../../../src/security/crypto";

const dbPath = process.argv[2];
const outPath = process.argv[3];
if (!dbPath || !outPath) {
  console.error("usage: bun qoder-export-accounts.ts <sqlite> <out.json>");
  process.exit(1);
}

const db = new Database(dbPath, { readonly: true });
const rows = db
  .query(
    `SELECT id, provider_id, label, credential_kind, status, credential_ciphertext, auth_state, created_at
     FROM provider_accounts
     WHERE provider_id IN ('qoder','qodercn')
     ORDER BY created_at`,
  )
  .all() as Array<{
    id: string;
    provider_id: string;
    label: string | null;
    credential_kind: string;
    status: string;
    credential_ciphertext: Uint8Array | null;
    auth_state: string | null;
    created_at: string | null;
  }>;

const accounts = rows.map((r) => {
  let accessToken = "";
  try {
    if (r.credential_ciphertext) {
      accessToken = decryptCredentialToString(r.credential_ciphertext);
    }
  } catch (e) {
    console.error(`decrypt failed for ${r.id}: ${e instanceof Error ? e.message : String(e)}`);
  }
  let authState = null;
  try {
    authState = r.auth_state ? JSON.parse(r.auth_state) : null;
  } catch {
    authState = null;
  }
  return {
    id: r.id,
    providerId: r.provider_id,
    label: r.label,
    credentialKind: r.credential_kind,
    status: r.status,
    accessToken,
    authState,
    createdAt: r.created_at,
  };
});

writeFileSync(outPath, JSON.stringify({ exportedAt: new Date().toISOString(), accounts }, null, 2));
console.log(`exported ${accounts.length} qoder accounts -> ${outPath}`);
db.close();
