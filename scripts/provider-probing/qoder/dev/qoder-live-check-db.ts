/**
 * Dev-only: inspects the local Lite SQLite for (a) an API key carrying the
 * routing:invoke scope and (b) active Qoder accounts. Never prints secrets —
 * only masked ids/labels.
 */
import { Database } from "bun:sqlite";

const DB_PATH = process.argv[2] ?? "C:/Users/Aria/AppData/Roaming/cartethyia/cartethyia.sqlite";
const db = new Database(DB_PATH, { readonly: true });

console.log("=== API KEYS with routing:invoke ===");
const keys = db
  .query(
    `SELECT id, label, key_prefix, scopes, enabled, revoked_at, model_access_mode, model_list
       FROM api_keys
      ORDER BY created_at DESC`,
  )
  .all() as Array<Record<string, unknown>>;

let routingKeys = 0;
for (const k of keys) {
  let scopes: unknown = k.scopes;
  try {
    scopes = typeof k.scopes === "string" ? JSON.parse(k.scopes as string) : k.scopes;
  } catch {
    // keep raw
  }
  const list = Array.isArray(scopes) ? (scopes as string[]) : [];
  const hasRouting = list.includes("routing:invoke");
  if (hasRouting) routingKeys += 1;
  console.log(
    `${hasRouting ? "[ROUTING]" : "         "} ${String(k.id).slice(0, 8)} ${String(k.label).slice(0, 40)} prefix=${k.key_prefix ?? "-"} enabled=${k.enabled} revoked=${k.revoked_at ?? "-"} mode=${k.model_access_mode ?? "-"}`,
  );
}
console.log(`total keys=${keys.length} routing-capable=${routingKeys}`);

console.log("\n=== QODER ACCOUNTS ===");
const accounts = db
  .query(
    `SELECT id, provider_id, label, enabled, status, plan_tier, account_state
       FROM provider_accounts
      WHERE provider_id IN ('qoder','qodercn')
      ORDER BY enabled DESC`,
  )
  .all() as Array<Record<string, unknown>>;

for (const a of accounts) {
  console.log(
    `${a.provider_id as string} ${String(a.label).slice(0, 40)} enabled=${a.enabled} status=${a.status ?? "-"} tier=${a.plan_tier ?? "-"} state=${String(a.account_state ?? "").slice(0, 60)}`,
  );
}
console.log(`qoder accounts=${accounts.length}`);
