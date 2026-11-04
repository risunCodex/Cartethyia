/**
 * Exports provider accounts (antigravity/codex/…) from Lite SQLite into the
 * probe accounts JSON format. Not for production; scratch helper.
 */
import { Database } from "bun:sqlite";
import { writeFileSync } from "node:fs";
import { decryptCredentialToString } from "../../src/security/crypto";

const DB_PATH = process.argv[2] ?? "C:/Users/Aria/AppData/Roaming/cartethyia/cartethyia.sqlite";
const OUT_PATH = process.argv[3] ?? "C:/Users/Aria/AppData/Local/Temp/opencode/ag-accounts.json";
const PROVIDER = process.argv[4] ?? "antigravity";

const db = new Database(DB_PATH, { readonly: true });
const rows = db.query(
  `SELECT id, provider_id, label, credential_kind, status, credential_ciphertext, auth_state, created_at
   FROM provider_accounts WHERE provider_id = ? ORDER BY created_at`,
).all(PROVIDER) as Array<{
  id: string;
  provider_id: string;
  label: string | null;
  credential_kind: string;
  status: string;
  credential_ciphertext: Uint8Array | null;
  auth_state: unknown;
  created_at: string;
}>;

const accounts = rows.map((row) => {
  const secret = row.credential_ciphertext
    ? decryptCredentialToString(row.credential_ciphertext)
    : "";
  const authState = typeof row.auth_state === "string" ? JSON.parse(row.auth_state) : row.auth_state;
  return {
    id: row.id,
    providerId: row.provider_id,
    label: row.label ?? "",
    credentialKind: row.credential_kind,
    status: row.status,
    accessToken: secret,
    refreshToken: secret,
    authState,
    createdAt: row.created_at,
  };
});

writeFileSync(OUT_PATH, JSON.stringify({ exportedAt: new Date().toISOString(), accounts }, null, 2));
console.log(`exported ${accounts.length} ${PROVIDER} accounts -> ${OUT_PATH}`);
for (const a of accounts) console.log(" -", a.label, "|", a.status);
