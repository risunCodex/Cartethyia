/**
 * One-off backfill: rebuild `telemetry_usage_totals` from raw telemetry
 * events using the same gateway-error definition the write path uses
 * (`isGatewayError`).
 *
 * This is only needed to reconcile a rollup that predates the durable-rollup
 * reads (or to repair one after a definition change). The production write
 * path charges the rollup at insert time, so under normal operation this
 * script is a no-op.
 */
import { Database, type SQLQueryBindings } from "bun:sqlite";

const DB_PATH = process.argv[2] ?? "/root/.local/share/Cartethyia/data/cartethyia.sqlite";
const db = new Database(DB_PATH);

const BATCH = 2000;

function num(v: unknown): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function isGatewayError(status: unknown, httpStatus: unknown): boolean {
  if (status !== "failed" && status !== "truncated") return false;
  if (httpStatus === null || httpStatus === undefined) return true;
  const h = Number(httpStatus);
  return h >= 500 && ![503, 504, 529].includes(h);
}

// Identity of one rollup row in the same shape the writer produces.
function key(tenantId: unknown, type: string, entityId: unknown): string {
  return `${String(tenantId)}\u0000${type}\u0000${String(entityId)}`;
}

const totals = new Map<string, {
  tenantId: unknown;
  type: string;
  entityId: unknown;
  familyTemplateKeyId: string | null;
  requests: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
}>();

let offset = 0;
let scanned = 0;
for (;;) {
  const rows = db
    .query(
      `select "tenant_id", "account_id", "api_key_id", "status", "http_status",
              "input_tokens", "output_tokens", "family_template_key_id"
         from "telemetry_events"
        order by "id"
        limit ? offset ?`,
    )
    .all(BATCH, offset) as Record<string, unknown>[];
  if (rows.length === 0) break;

  for (const row of rows) {
    const tenantId = row["tenant_id"];
    const status = row["status"];
    const httpStatus = row["http_status"];
    const inputTokens = num(row["input_tokens"]);
    const outputTokens = num(row["output_tokens"]);
    const error = isGatewayError(status, httpStatus) ? 1 : 0;

    const identities: Array<[string, unknown]> = [];
    if (row["account_id"] != null) identities.push(["account", row["account_id"]]);
    if (row["api_key_id"] != null) identities.push(["api_key", row["api_key_id"]]);

    for (const [type, entityId] of identities) {
      const k = key(tenantId, type, entityId);
      let entry = totals.get(k);
      if (entry === undefined) {
        entry = {
          tenantId,
          type,
          entityId,
          familyTemplateKeyId: null,
          requests: 0,
          errors: 0,
          inputTokens: 0,
          outputTokens: 0,
        };
        totals.set(k, entry);
      }
      entry.requests = num(entry.requests) + 1;
      entry.errors = num(entry.errors) + error;
      entry.inputTokens = num(entry.inputTokens) + inputTokens;
      entry.outputTokens = num(entry.outputTokens) + outputTokens;
    }
  }
  scanned += rows.length;
  offset += BATCH;
}

console.log(`scanned ${scanned} events, ${totals.size} rollup rows`);

// Resolve family template for api_key identities (parent ?? self), like the
// writer does.
const apiKeyIds = [...totals.values()]
  .filter((e) => e.type === "api_key")
  .map((e) => String(e.entityId));
const familyTemplates = new Map<string, string | null>();
for (let i = 0; i < apiKeyIds.length; i += BATCH) {
  const chunk = apiKeyIds.slice(i, i + BATCH);
  const placeholders = chunk.map(() => "?").join(", ");
  const rows = db
    .query(`select "id", "parent_key_id" from "api_keys" where "id" in (${placeholders})`)
    .all(...chunk) as Array<{ id: string; parent_key_id: string | null }>;
  for (const r of rows) familyTemplates.set(r.id, r.parent_key_id ?? r.id);
}
for (const entry of totals.values()) {
  if (entry.type === "api_key") {
    entry.familyTemplateKeyId = familyTemplates.get(String(entry.entityId)) ?? null;
  }
}

// Upsert all totals.
const upsert = db.prepare(`
  insert into "telemetry_usage_totals"
    ("tenant_id", "identity_type", "entity_id", "family_template_key_id",
     "requests", "errors", "input_tokens", "output_tokens", "last_used_at", "updated_at")
  values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  on conflict ("tenant_id", "identity_type", "entity_id") do update set
    "family_template_key_id" = excluded."family_template_key_id",
    "requests" = excluded."requests",
    "errors" = excluded."errors",
    "input_tokens" = excluded."input_tokens",
    "output_tokens" = excluded."output_tokens",
    "last_used_at" = excluded."last_used_at",
    "updated_at" = excluded."updated_at"
`);

const now = new Date().toISOString();
db.transaction(() => {
  for (const entry of totals.values()) {
    const bindings: SQLQueryBindings[] = [
      String(entry.tenantId),
      entry.type as string,
      String(entry.entityId),
      entry.familyTemplateKeyId ?? null,
      num(entry.requests),
      num(entry.errors),
      num(entry.inputTokens),
      num(entry.outputTokens),
      now,
      now,
    ];
    upsert.run(...bindings);
  }
})();

console.log("backfill complete");
db.close();
