/**
 * Dev-only: mints a local administrator API key directly into the Lite SQLite
 * DB (scopes: platform:admin + providers/read + providers/write + models:read
 * + models:write + dashboard:read/write + search:invoke). Prints the secret
 * once; the operator uses it for console sync/model admin.
 */
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { generateApiKeySecret } from "../../../../src/console/api-keys/contracts";
import { encryptCredential } from "../../../../src/security/crypto";

const DB_PATH = process.argv[2] ?? "C:/Users/Aria/AppData/Roaming/cartethyia/cartethyia.sqlite";
const db = new Database(DB_PATH);

// Reuse an existing tenant id so the key belongs to the same tenant.
const existing = db.query("SELECT tenant_id FROM api_keys LIMIT 1").get() as { tenant_id: string } | null;
if (!existing) {
  console.error("no tenants in api_keys");
  process.exit(1);
}

const generated = generateApiKeySecret("pn-carte-");
const scopes = JSON.stringify([
  "platform:admin",
  "dashboard:read",
  "dashboard:write",
  "providers:read",
  "providers:write",
  "models:read",
  "models:write",
  "search:invoke",
]);

db.query(
  `INSERT INTO api_keys
     (id, tenant_id, key_hash, key_mode, label, scopes, enabled, key_prefix, key_encrypted,
      model_access_mode, created_at, sort_index)
   VALUES (?, ?, ?, 'personal', ?, ?, 1, ?, ?, 'whitelist', ?, 0)`,
).run(
  randomUUID(),
  existing.tenant_id,
  generated.hash,
  "local-admin",
  scopes,
  generated.prefix,
  encryptCredential(generated.secret),
  new Date().toISOString(),
);

console.log("SECRET=" + generated.secret);
console.log("PREFIX=" + generated.prefix);
console.log("SCOPES=" + scopes);
