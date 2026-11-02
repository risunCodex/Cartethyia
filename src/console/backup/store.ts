/**
 * Drizzle-backed export/restore of the backup contract.
 *
 * Encoding rules are driven by the column's Drizzle `dataType` rather than a
 * hand-written per-column table, so a new column cannot be forgotten:
 * - `date` → `{ __date: ISO }`. JSON has no date; a bare string would come back
 *   as text and Postgres would have to guess.
 * - `custom` (our `bytea` columns: encrypted credentials) → `{ __bytes: base64 }`.
 *   Postgres returns a `Buffer`, and `JSON.stringify` renders that as
 *   `{"type":"Buffer","data":[…]}` — large, and it silently "works" on import
 *   while misrepresenting the type.
 * - everything else is already JSON-safe (string, number, boolean, json, null).
 *
 * **A restore only ever touches the restoring tenant's own rows.** Both the
 * export and the restore are scoped by {@link ownershipOf}: a tenant's backup
 * contains its own configuration plus the shared rows it depends on (the
 * built-in providers and catalog), and a restore replaces only the rows it
 * owns. Shared rows are re-ensured, never deleted and never overwritten. This
 * is not a nicety — `provider_accounts` is tenant-scoped, but `providers` and
 * `models` are shared, so a table-wide `DELETE` before insert would take every
 * other tenant's accounts and the entire built-in catalog with it.
 *
 * Restore modes differ by section and the difference is load-bearing:
 * - **config** is replaced (delete the tenant's rows, then insert) — that is
 *   what "restore my configuration" means.
 * - **telemetry** is merged, never deleted. Importing history must not remove
 *   rows already present, so existing `(tenant_id, request_id, created_at)`
 *   keys are read first and duplicates are skipped, making a re-import
 *   idempotent. There is no unique constraint to lean on: `telemetry_events`
 *   has a random PK, so the natural key is checked explicitly.
 */
import { and, eq, gt, isNotNull, or, sql } from "drizzle-orm";
import { gzipSync, gunzipSync, createGzip } from "node:zlib";
import { differsFrom } from "../../persistence/dialect";
import { TELEMETRY_EVENT_DIR, type TelemetryEventRecord } from "../../observability/event-log";
import { queryTelemetryEvents as querySqlEvents } from "../../observability/event-query";
import { appendFile, mkdir } from "node:fs/promises";
import { getTableColumns, type Column, type SQL, type Table } from "drizzle-orm";
import type { CartethyiaDatabase } from "../../persistence/db-handle";
import { decryptCredentialToString, encryptCredential } from "../../security/crypto";
import { asConsoleDb } from "../shared/transaction";
import {
  apiKeys,
  cliToolMappings,
  cliToolSettings,
  consoleSettings,
  consoleUsers,
  healthEvents,
  modelAliases,
  modelCombos,
  models,
  networkPools,
  poolRoutingSettings,
  providerAccounts,
  providerOauthStates,
  providerRoutingSettings,
  providers,
  shareLinks,
  sharePopups,
  tenantDisabledModels,
  telemetryEvents,
  telemetryUsageTotals,
} from "../../persistence/schema";
import {
  BACKUP_APP,
  BACKUP_VERSION,
  CONFIG_TABLES,
  MAX_ROWS_PER_TABLE,
  TELEMETRY_TABLES,
  TENANT_TABLE,
  columnNames,
  ownershipOf,
  replaceModeOf,
  payloadNameOf,
  sealedColumns,
  tableName,
  type BackupBytes,
  type BackupDate,
  type BackupExportResult,
  type BackupPayload,
  type BackupRow,
  type ValidatedRestore,
} from "./contracts";

/** The driver's `Buffer` view of a `bytea` cell, or null when it holds none. */
function toBuffer(value: unknown): Buffer | null {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  return null;
}

/**
 * A sealed column, as the payload carries it: the plaintext.
 *
 * The ciphertext is deliberately *not* what travels — see
 * {@link sealedColumns} for why. Ciphertext this install's key cannot open
 * (sealed before a key rotation, or copied in from another install's database)
 * exports as null rather than as its bytes: writing those bytes as text would
 * put an unopenable string in the file, which a restore would then re-seal as
 * though it were the secret itself.
 */
function decodeSealedForPayload(value: unknown): string | null {
  const bytes = toBuffer(value);
  if (bytes === null) return null;
  try {
    return decryptCredentialToString(bytes);
  } catch {
    return null;
  }
}

/** Encodes one cell into a JSON-safe value. */
function encodeCell(value: unknown, dataType: string): unknown {
  if (value === null || value === undefined) return null;
  if (dataType === "date") {
    const date = value instanceof Date ? value : new Date(String(value));
    return Number.isNaN(date.getTime())
      ? null
      : ({ __date: date.toISOString() } satisfies BackupDate);
  }
  if (dataType === "custom") {
    const bytes = toBuffer(value);
    if (bytes === null) return null;
    return { __bytes: bytes.toString("base64") } satisfies BackupBytes;
  }
  return value;
}
/**
 * Adds the `providerConnections` block a router export carries.
 *
 * The row tables above are the restore path; this block is the interchange
 * shape another Cartethyia install (or a router migration) reads accounts from,
 * so it keeps its own field names — `accessToken`, not
 * `credential_ciphertext`. Both are built from the same decrypted values, so
 * there is one decode and two projections of it rather than a second read.
 */
function attachOauthSecrets(
  config: Record<string, readonly BackupRow[]>,
): readonly Record<string, unknown>[] | undefined {
  const accounts = config.provider_accounts;
  const states = config.provider_oauth_states;
  if (!Array.isArray(accounts)) return undefined;
  const byAccount = new Map((states ?? []).map((state) => [String(state.provider_account_id), state]));
  return accounts.map((account) => {
    const state = byAccount.get(String(account.id));
    return {
      id: account.id,
      provider: account.provider_id,
      authType: account.credential_kind,
      name: account.label,
      accessToken: account.access_token ?? null,
      refreshToken: state?.refresh_token ?? null,
      clientSecret: state?.client_secret ?? null,
      expiresAt: dateText(state?.expires_at),
      isActive: account.status === "active",
      createdAt: dateText(account.created_at),
      providerSpecificData: account.auth_state ?? {},
    };
  });
}

function dateText(value: unknown): string | null {
  if (typeof value !== "object" || value === null || !("__date" in value)) return null;
  const date = value.__date;
  return typeof date === "string" ? date : null;
}

/** Decodes one payload cell back to what the driver expects for that column. */
function decodeCell(value: unknown, dataType: string): unknown {
  if (value === null || value === undefined) return null;
  if (dataType === "date") {
    const raw =
      typeof value === "object" && value !== null && "__date" in value
        ? (value as BackupDate).__date
        : String(value);
    const date = new Date(raw);
    if (Number.isNaN(date.getTime())) throw new Error(`invalid date value: ${raw}`);
    return date;
  }
  if (dataType === "custom") {
    if (typeof value === "object" && value !== null && "__bytes" in value) {
      return Buffer.from((value as BackupBytes).__bytes, "base64");
    }
    if (typeof value === "string") return Buffer.from(value, "base64");
    throw new Error("a byte column must be a base64 string or a { __bytes } object");
  }
  return value;
}

/** Column name → the object key Drizzle uses for it, and its data type. */
const COLUMN_INDEX_CACHE = new WeakMap<Table, ReadonlyMap<string, { key: string; dataType: string }>>();
function columnIndex(table: Table): ReadonlyMap<string, { key: string; dataType: string }> {
  const cached = COLUMN_INDEX_CACHE.get(table);
  if (cached) return cached;
  const out = new Map<string, { key: string; dataType: string }>();
  for (const [key, column] of Object.entries(getTableColumns(table))) {
    out.set(column.name, { key, dataType: column.dataType });
  }
  COLUMN_INDEX_CACHE.set(table, out);
  return out;
}

/**
 * The predicate that selects exactly the rows `tenantId` owns in `table`.
 *
 * `viaParent` reads as a subquery on the parent's owner column, so a model row
 * is the tenant's exactly when its provider is. `authored` adds the second
 * arm: a row whose `source` is not the value the build stamps is the tenant's
 * own work even when it sits under a shared provider. A `NULL` owner — a
 * built-in provider, a pool-wide account — never satisfies `= tenantId`, which
 * is what keeps the shared catalog out of a tenant's restore.
 *
 * The second arm is scoped to a **shared** parent on purpose. "Not
 * reproducible from the build" alone is not evidence of authorship: another
 * tenant's provider can also carry a probed model, and reading it into this
 * tenant's backup would both leak that tenant's catalog and produce a restore
 * that inserts a `models` row whose `provider_id` this tenant does not own —
 * a foreign-key violation. Authorship therefore requires that the row hangs
 * off a provider nobody owns, or off this tenant's own provider.
 */
function ownedByFilter(table: Table, tenantId: string): SQL {
  const ownership = ownershipOf(table);
  if (ownership.kind === "viaParent") {
    const parentOwner = ownershipOwnerColumn(ownership.parent);
    return sql`${ownership.column} in (select ${ownership.parentColumn} from ${ownership.parent} where ${parentOwner} = ${tenantId})`;
  }
  if (ownership.kind === "authored") {
    const parentOwner = ownershipOwnerColumn(ownership.parent);
    const mine = sql`${ownership.column} in (select ${ownership.parentColumn} from ${ownership.parent} where ${parentOwner} = ${tenantId})`;
    const shared = sql`${ownership.column} in (select ${ownership.parentColumn} from ${ownership.parent} where ${parentOwner} is null)`;
    const unreproducible = differsFrom(sql`${ownership.authoredColumn}`, sql`${ownership.reproducibleValue}`);
    return sql`(${mine} or (${shared} and ${unreproducible}))`;
  }
  return eq(ownership.column, tenantId);
}

/** The column that carries a parent table's owner, for the `viaParent` subquery. */
function ownershipOwnerColumn(parent: Table): Column {
  const ownership = ownershipOf(parent);
  if (ownership.kind === "direct" || ownership.kind === "self") return ownership.column;
  // A parent that is itself owned through another parent would need a second
  // join level. No table in the contract has one; refuse rather than build a
  // filter that silently matches nothing (or everything).
  throw new Error(
    `${tableName(parent)} is not directly tenant-owned, so ownership cannot be resolved one level up`,
  );
}

/**
 * Reads every row of one table that `tenantId` owns, encoded for JSON.
 *
 * Exports stream: the backup of a tenant can carry hundreds of thousands of
 * rows (the dev deployment's `api_keys` held 331k minted share children), and
 * materializing the whole table to JSON it in one gulp was what OOM-killed the
 * process during a backup. Every reader is therefore paged.
 */
const EXPORT_PAGE_ROWS = 500;

/**
 * The composite keys of tables whose primary key is not declared column-wise.
 * Row tables stream through a keyset walk, so the sort key must uniquely
 * order rows — a truncated key would swallow tied rows at every page
 * boundary.
 */
const COMPOSITE_KEYSETS: Partial<Record<string, readonly string[]>> = {
  telemetry_usage_totals: ["tenantId", "identityType", "entityId"],
  cli_tool_settings: ["tenantId", "apiKeyId", "toolId"],
  provider_routing_settings: ["providerId", "tenantId"],
};

/**
 * The key a keyset walk of `table` pages by, or `null` for a table whose rows
 * are contract-bounded to a handful (per-tenant settings singletons) and are
 * read in one statement.
 */
function keysetKey(table: Table): readonly Column[] | null {
  const name = tableName(table);
  const columns = getTableColumns(table) as Record<string, Column>;
  const composite = COMPOSITE_KEYSETS[name];
  if (composite !== undefined) {
    return composite.map((key) => {
      const column = columns[key];
      if (column === undefined) throw new Error(`${name}: backup keyset names missing column ${key}`);
      return column;
    });
  }
  // Single keys: a uuid `id` first, then the per-table natural keys
  // (`provider_oauth_states` → its account, `share_popups` → its template).
  // `tenantId` is last: it is the primary key of nothing but the per-tenant
  // settings singletons, so single-column `id` always wins where one exists.
  for (const single of ["id", "providerAccountId", "apiKeyId", "tenantId"] as const) {
    const column = columns[single];
    if (column !== undefined) return [column];
  }
  return null;
}

/** Rows past the key of the previous page, in the key's own order. */
function keysetAfter(key: readonly Column[], last: readonly unknown[]): SQL {
  return or(
    ...key.map((column, index) =>
      and(...key.slice(0, index).map((prior, at) => eq(prior, last[at])), gt(column, last[index])),
    ),
  ) as SQL;
}

/** Yields the owned rows of `table` in key order, one statement per page. */
async function* pagedRows(
  db: CartethyiaDatabase,
  table: Table,
  tenantId: string,
): AsyncGenerator<Record<string, unknown>, void, void> {
  const filter = ownedByFilter(table, tenantId);
  const key = keysetKey(table);
  if (key === null) {
    const rows = (await db
      .select()
      .from(table)
      .where(filter)
      .limit(MAX_ROWS_PER_TABLE)) as Array<Record<string, unknown>>;
    yield* rows;
    return;
  }
  const entries = Object.entries(getTableColumns(table));
  const keyNames = key.map((column) => {
    const entry = entries.find(([, candidate]) => candidate === column);
    if (entry === undefined) throw new Error(`${tableName(table)}: key column is not part of the table`);
    return entry[0];
  });
  let last: unknown[] = [];
  while (true) {
    const where = last.length === 0 ? filter : and(filter, keysetAfter(key, last));
    const rows = (await db
      .select()
      .from(table)
      .where(where)
      .orderBy(...key.map((column) => sql`${column} asc`))
      .limit(EXPORT_PAGE_ROWS)) as Array<Record<string, unknown>>;
    if (rows.length === 0) return;
    yield* rows;
    if (rows.length < EXPORT_PAGE_ROWS) return;
    const tail = rows[rows.length - 1] as Record<string, unknown>;
    last = keyNames.map((name) => tail[name]);
  }
}

/** Encodes one read row for the payload. */
function encodeRow(table: Table, row: Record<string, unknown>): BackupRow {
  const index = columnIndex(table);
  const sealed = sealedColumns(table);
  const out: BackupRow = {};
  for (const [name, { key, dataType }] of index) {
    // A sealed column is written decrypted, under the name of the secret it
    // holds — see `SEALED_COLUMNS` for why the column's own name would be a
    // lie in a file that no longer carries its ciphertext.
    out[payloadNameOf(table, name)] = sealed.has(name)
      ? decodeSealedForPayload(row[key])
      : encodeCell(row[key], dataType);
  }
  return out;
}

/** Encodes one telemetry event row the way `exportEventFile` used to. */
function telemetryRowOf(event: TelemetryEventRecord): BackupRow {
  const row: BackupRow = {};
  for (const [key, value] of Object.entries(event)) {
    if (value === null || value === undefined) continue;
    row[camelToSnake(key)] = key === "createdAt" ? { __date: String(value) } : value;
  }
  return row;
}

async function* pagedTelemetryEvents(
  db: CartethyiaDatabase,
  tenantId: string,
): AsyncGenerator<TelemetryEventRecord, void, void> {
  // The SQL table is the durable record now, and it is tenant-scoped and
  // retained by the same rule as the raw files — so the export walks it
  // newest-first through its own keyset cursor instead of scanning every raw
  // file and filtering by tenant afterwards.
  let cursor: string | undefined;
  while (true) {
    const page = await querySqlEvents(db, {
      tenantId,
      limit: EXPORT_PAGE_ROWS,
      ...(cursor === undefined ? {} : { cursor }),
    });
    yield* page.events;
    if (page.nextCursor === undefined) return;
    cursor = page.nextCursor;
  }
}

/**
 * Streams the payload document: the requested tables, grouped into their
 * sections, written incrementally so the process never holds a table — let
 * alone every table and a second JSON copy — in memory. Consumed chunks
 * concatenated are exactly the JSON the buffered variant used to stringify in
 * one piece.
 */
async function* backupJsonChunks(
  db: CartethyiaDatabase,
  tables: readonly Table[],
  tenantId: string,
  finishCounts: (counts: Record<string, number>) => void,
): AsyncGenerator<string, void, void> {
  const counts: Record<string, number> = {};

  const configSet = new Set<Table>([...CONFIG_TABLES]);
  const telemetrySet = new Set<Table>(TELEMETRY_TABLES);
  const configTables = tables.filter((table) => configSet.has(table));
  const telemetryTables = tables.filter((table) => telemetrySet.has(table));
  const outside = tables.filter((table) => !configSet.has(table) && !telemetrySet.has(table));

  // The OAuth projection is derived from the accounts block itself, so those
  // two tables materialize (both are operator-sized, dozens of rows) instead
  // of being read twice.
  const materialized = new Map<Table, readonly BackupRow[]>();
  const materializedRows = async (table: Table): Promise<readonly BackupRow[]> => {
    let rows: readonly BackupRow[] | undefined = materialized.get(table);
    if (rows === undefined) {
      const built: BackupRow[] = [];
      for await (const source of pagedRows(db, table, tenantId)) {
        built.push(encodeRow(table, source));
      }
      rows = built;
      materialized.set(table, rows);
    }
    return rows;
  };

  /** Writes one table's array into the document, tracking the exported count. */
  async function* writeTable(table: Table, sources?: readonly BackupRow[]): AsyncGenerator<string, void, void> {
    const name = tableName(table);
    let first = true;
    let written = 0;
    yield `"${name}":[`;
    if (sources === undefined) {
      for await (const source of pagedRows(db, table, tenantId)) {
        if (written >= MAX_ROWS_PER_TABLE) break;
        yield `${first ? "" : ","}${JSON.stringify(encodeRow(table, source))}`;
        first = false;
        written += 1;
      }
    } else {
      for (const row of sources) {
        yield `${first ? "" : ","}${JSON.stringify(row)}`;
        first = false;
        written += 1;
      }
    }
    yield "]";
    counts[name] = written;
  }

  try {
    yield `{"app":${JSON.stringify(BACKUP_APP)},"version":${BACKUP_VERSION},"exportedAt":${JSON.stringify(new Date().toISOString())},"sections":{`;
    if (configTables.length > 0) {
      yield `"config":{`;
      let configIndex = 0;
      for (const table of configTables) {
        const sources =
          table === providerAccounts || table === providerOauthStates ? await materializedRows(table) : undefined;
        yield configIndex > 0 ? "," : "";
        yield* writeTable(table, sources);
        configIndex += 1;
      }
      yield `}`;
    }
    if (telemetryTables.length > 0) {
      let telemetryIndex = 0;
      for (const table of telemetryTables) {
        if (telemetryIndex === 0) {
          yield `${configTables.length > 0 ? "," : ""}"telemetry":{`;
        } else {
          yield ",";
        }
        telemetryIndex += 1;
        if (table === telemetryEvents) {
          yield `"${tableName(table)}":[`;
          let first = true;
          let written = 0;
          for await (const event of pagedTelemetryEvents(db, tenantId)) {
            if (written >= MAX_ROWS_PER_TABLE) break;
            yield `${first ? "" : ","}${JSON.stringify(telemetryRowOf(event))}`;
            first = false;
            written += 1;
          }
          yield "]";
          counts[tableName(table)] = written;
        } else {
          yield* writeTable(table);
        }
      }
      yield `}`;
    }
    yield `}`;
    // Tables that belong to neither section (the tenant row) are counted but
    // do not enter the payload — the same rule the buffered assembly kept.
    for (const table of outside) {
      let written = 0;
      for await (const _source of pagedRows(db, table, tenantId)) {
        written += 1;
      }
      counts[tableName(table)] = written;
    }
    // Always built: the row tables above now always carry the credentials
    // decrypted, so the projection is always complete. It used to be
    // conditional on the export being "raw", which made a plain JSON export
    // carry a block of null tokens — a router migration from it produced
    // accounts with no credential at all.
    if (materialized.size > 0) {
      const inputs: Record<string, readonly BackupRow[]> = {};
      const accounts = materialized.get(providerAccounts);
      const states = materialized.get(providerOauthStates);
      if (accounts !== undefined) inputs["provider_accounts"] = accounts;
      if (states !== undefined) inputs["provider_oauth_states"] = states;
      const providerConnections = attachOauthSecrets(inputs);
      if (providerConnections !== undefined) {
        yield `,"providerConnections":${JSON.stringify(providerConnections)}`;
      }
    }
    yield `}`;
  } finally {
    finishCounts(counts);
  }
}

/**
 * Snapshots the requested tables, grouped into their sections, as an
 * incrementally-written JSON document.
 *
 * Only `tenantId`'s own rows are read. The shared rows a backup needs in order
 * to be restorable — the built-in providers and their catalog — are not carried
 * because the build already supplies them (see `seedBundledProviders` /
 * `seedBundledModels`), so a payload never contains another tenant's data.
 */
export interface BackupExportStream {
  /** Concatenated chunks are the payload document, one string at a row-page granularity. */
  readonly jsonChunks: AsyncGenerator<string, void, void>;
  /**
   * Row counts per table, resolved once the document has been consumed to
   * completion — a streamed export counts what it actually wrote.
   */
  readonly counts: Promise<Record<string, number>>;
}

export function exportBackupStream(
  db: CartethyiaDatabase,
  tables: readonly Table[],
  tenantId: string,
): BackupExportStream {
  let resolveCounts!: (counts: Record<string, number>) => void;
  const counts = new Promise<Record<string, number>>((resolve) => {
    resolveCounts = resolve;
  });
  return {
    jsonChunks: backupJsonChunks(db, tables, tenantId, resolveCounts),
    counts,
  };
}

/**
 * The buffered form of {@link exportBackupStream}: builds the whole payload
 * object in memory. Export callers stream; this remains for callers that need
 * the payload as data — the backup round-trip tests use it to feed restores.
 */
export async function exportBackup(
  db: CartethyiaDatabase,
  tables: readonly Table[],
  tenantId: string,
): Promise<BackupExportResult> {
  const stream = exportBackupStream(db, tables, tenantId);
  let document = "";
  for await (const chunk of stream.jsonChunks) document += chunk;
  return { counts: await stream.counts, payload: JSON.parse(document) as BackupPayload };
}

/**
 * Gzips a backup payload.
 *
 * `compressed` is a property of the *file*, and of nothing else: the payload is
 * the same object either way. It used to also mean "decrypt the credentials",
 * which coupled a transport choice to a security decision and left the plain
 * JSON export carrying ciphertext no other install could open.
 */
export function compressBackup(payload: unknown): Buffer {
  return gzipSync(Buffer.from(JSON.stringify(payload), "utf8"));
}

/**
 * Gzips a streamed payload assembly: one pass, no whole-document buffer of
 * the raw JSON (the compressed document itself still fits one buffer, since
 * the response contract wraps it as base64).
 */
export async function compressBackupStream(chunks: AsyncGenerator<string, void, void>): Promise<Buffer> {
  const gzip = createGzip();
  const parts: Buffer[] = [];
  const finished = new Promise<"done" | Error>((resolve) => {
    gzip.on("data", (chunk: Buffer) => parts.push(chunk));
    gzip.on("error", (error: Error) => resolve(error));
    gzip.on("end", () => resolve("done"));
  });
  for await (const chunk of chunks) {
    await new Promise<void>((resolve, reject) => {
      gzip.write(Buffer.from(chunk, "utf8"), (error) => (error === null ? resolve() : reject(error)));
    });
  }
  gzip.end();
  const outcome = await finished;
  if (outcome !== "done") throw outcome;
  return Buffer.concat(parts);
}

/** The gzip magic, so a file can be recognised without trusting its name. */
const GZIP_MAGIC = [0x1f, 0x8b] as const;

/** Whether `bytes` starts with the gzip magic. */
function isGzipBytes(bytes: Uint8Array): boolean {
  return GZIP_MAGIC.every((byte, index) => bytes[index] === byte);
}

/**
 * Undoes {@link compressBackup}.
 *
 * A restore has to accept the file the export actually produces. The dashboard
 * offers a compressed download and names it `.json.gz`, and until now that file
 * could not be restored at all: the import path read the body as JSON text and
 * `JSON.parse` of gzip bytes fails, so the operator's own backup — the only one
 * they had — was rejected as "not a JSON backup".
 *
 * A file that is not gzipped is returned unchanged rather than refused, because
 * a plain `.json` export is equally restorable and the bytes are the only thing
 * that distinguishes them.
 */
export function decompressBackup(bytes: Uint8Array): string {
  if (!isGzipBytes(bytes)) return Buffer.from(bytes).toString("utf8");
  try {
    return gunzipSync(bytes).toString("utf8");
  } catch (error) {
    throw new Error(
      `that file is named or marked as gzip but could not be decompressed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function camelToSnake(name: string): string {
  return name.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`);
}

/**
 * Re-seals one secret column under **this** install's key.
 *
 * The payload carries the plaintext (see {@link sealedColumns}), so every
 * restore writes ciphertext the importing install can actually open. This is
 * the step whose absence destroyed the receiving install's credentials: the
 * file's bytes were inserted verbatim after the install's own rows had been
 * deleted, so the restored configuration held secrets sealed under a key that
 * was not in the room.
 *
 * A null cell is null again — every sealed column is nullable, and "this
 * account has no stored credential" is a state the schema has to represent.
 * Validation drops any other non-string cell before it gets here, so a
 * non-string is a contract break rather than a case to coerce.
 */
function sealSecret(value: unknown, table: string, column: string): Buffer | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    throw new Error(`${table}.${column} must be restored as a plaintext string, got ${typeof value}`);
  }
  return encryptCredential(value);
}

/** Builds a Drizzle row object from a payload row, coercing each cell. */
function toValues(table: Table, row: BackupRow): Record<string, unknown> {
  const index = columnIndex(table);
  const allowed = columnNames(table);
  const sealed = sealedColumns(table);
  const name = tableName(table);
  const values: Record<string, unknown> = {};
  for (const [column, cell] of Object.entries(row)) {
    if (!allowed.has(column)) throw new Error(`${name}.${column} is not a known column`);
    const entry = index.get(column);
    if (entry === undefined) continue;
    values[entry.key] = sealed.has(column)
      ? sealSecret(cell, name, column)
      : decodeCell(cell, entry.dataType);
  }
  return values;
}

/**
 * Natural key used to detect telemetry rows that are already stored.
 *
 * Built from the payload row only. The comparison against stored rows happens
 * in SQL (see {@link existingTelemetryKeys}) rather than by formatting both
 * sides in JS: the driver returns `timestamptz` through `db.execute` as a
 * string with microsecond precision and a numeric offset, which never equals
 * the ISO spelling the export wrote, so a JS-side comparison would silently
 * match nothing and every re-import would duplicate history.
 */
function telemetryKey(row: BackupRow): string {
  return `${String(row.tenant_id)}\u0000${String(row.request_id)}\u0000${createdAtIso(row.created_at)}`;
}

/** The ISO instant of an encoded date cell. */
function createdAtIso(value: unknown): string {
  if (typeof value === "object" && value !== null && "__date" in value) {
    return String((value as BackupDate).__date);
  }
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

/**
 * Reads the natural keys of telemetry rows already present for the tenants in
 * the payload, so a re-import can skip them instead of double-counting history.
 *
 * The existing rows are matched by `(tenant_id, request_id)` and their
 * timestamps are normalised in SQL to the same ISO spelling the payload uses,
 * so the two sides are comparable regardless of how the driver types them.
 */
async function existingEventFileKeys(db: CartethyiaDatabase, tenantId: string, rows: readonly BackupRow[]): Promise<Set<string>> {
  const wanted = new Set(rows.map((row) => row.request_id).filter((id): id is string => typeof id === "string"));
  if (wanted.size === 0) return new Set();
  // One indexed query for the ids being restored, instead of reading every
  // raw file to test membership. `id = request_id`, so the unique index serves
  // this directly.
  const page = await querySqlEvents(db, { tenantId, requestIds: [...wanted] });
  return new Set(
    page.events
      .map((event) => `${event.tenantId ?? ""}\u0000${event.requestId}\u0000${event.createdAt}`),
  );
}

/** Appends restored events to the file log, in the shape the writer uses. */
async function appendRestoredEvents(rows: readonly BackupRow[]): Promise<void> {
  if (rows.length === 0) return;
  await mkdir(TELEMETRY_EVENT_DIR, { recursive: true });
  const lines = rows.map((row) => JSON.stringify(snakeToCamelRecord(row)));
  await appendFile(`${TELEMETRY_EVENT_DIR}/restored.jsonl`, `${lines.join("\n")}\n`, "utf8");
}

function snakeToCamelRecord(row: BackupRow): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    const camel = key.replace(/_([a-z])/g, (_match, char: string) => char.toUpperCase());
    out[camel] = isDateCell(value) ? value.__date : value;
  }
  return out;
}

function isDateCell(value: unknown): value is BackupDate {
  return typeof value === "object" && value !== null && "__date" in value;
}

/**
 * Inserts a payload-shaped row into an arbitrary table.
 *
 * The values are validated against the table's real columns by {@link toValues}
 * before they get here, but Drizzle's insert builder is typed per table while
 * this module works over a `Table` chosen at runtime, so one cast is
 * unavoidable. It is confined to this helper rather than scattered across the
 * restore path.
 */
function insertRow(tx: CartethyiaDatabase, table: Table, values: Record<string, unknown>) {
  return tx.insert(table).values(values as never);
}

/**
 * Deletes the tenant's own rows from a table inside the transaction.
 *
 * Scoped by {@link ownedByFilter}, never table-wide. A table-wide delete here
 * is the bug this function exists to prevent: `providers` and `models` hold the
 * shared built-in catalog, and `provider_accounts` holds every tenant's
 * accounts, so clearing any of them would reach far outside the restoring
 * tenant.
 */
async function clearOwnedRows(
  tx: CartethyiaDatabase,
  table: Table,
  tenantId: string,
): Promise<void> {
  await tx.delete(table).where(ownedByFilter(table, tenantId));
}

/**
 * Inserts rows in bulk with a per-row fallback for diagnostics.
 *
 * `conflictTarget` is supplied for tables a restore may not delete from: the
 * payload's rows are upserted by the table's unique key, so re-importing a
 * backup updates what is already there instead of failing on the first
 * duplicate.
 *
 * Historically rows went in one statement at a time so a single bad row could
 * name its own failure. On a real backup — thousands of telemetry events, a
 * tenant's models and accounts — that cost one DB round-trip per row and the
 * restore stalled on network latency rather than the server's write path. The
 * fast path collapses those statements into one `INSERT ... VALUES (...), ...`
 * per chunk; if a chunk fails for any reason (bad row, constraint, oversized
 * parameter list) the chunk is re-run one row at a time so the diagnostic
 * surface is unchanged. The slow path is only reached on real errors, so a
 * clean restore pays zero penalty for the diagnostic.
 */
async function insertRows(
  tx: CartethyiaDatabase,
  table: Table,
  rows: readonly BackupRow[],
  options: {
    readonly skipKeys?: ReadonlySet<string>;
    readonly keyOf?: (row: BackupRow) => string;
    readonly conflictTarget?: readonly Column[];
    readonly ignoreConflicts?: boolean;
    readonly tenantId?: string;
  } = {},
): Promise<number> {
  // Normalise rows up front: filter skips, drop empty-value rows (no
  // insertable columns), and project to Drizzle values. Doing it once keeps
  // the two paths from diverging in what counts as insertable.
  const prepared: Record<string, unknown>[] = [];
  for (const row of rows) {
    if (options.skipKeys !== undefined && options.keyOf !== undefined && options.skipKeys.has(options.keyOf(row))) {
      continue;
    }
    const values = toValues(table, row);
    if (options.tenantId !== undefined && "tenantId" in values) values.tenantId = options.tenantId;
    if (Object.keys(values).length === 0) continue;
    prepared.push(values);
  }
  if (prepared.length === 0) return 0;

  // The `set` clause for upserts: every column the payload carries is written,
  // so a re-import restores the file's state rather than leaving stale values
  // behind. `excluded` is the row that failed to insert, and column names come
  // from the schema rather than the JS key — guessing the database spelling
  // from a camelCase key breaks the moment the two differ.
  const columnNameMap = new Map(
    Object.entries(getTableColumns(table)).map(([key, column]) => [key, column.name]),
  );
  const buildUpsertSet = (values: Record<string, unknown>): Record<string, unknown> =>
    Object.fromEntries(
      Object.keys(values).map((key) => {
        const name = columnNameMap.get(key);
        if (name === undefined) throw new Error(`${tableName(table)} has no column ${key}`);
        return [key, sql.raw(`excluded."${name}"`)];
      }),
    );

  // One row's path, kept as its own function so the bulk fallback can reuse it
  // without duplicating the control flow.
  const insertOne = async (values: Record<string, unknown>): Promise<number> => {
    const statement = insertRow(tx, table, values);
    if (options.ignoreConflicts) {
      if (options.conflictTarget === undefined) {
        throw new Error(`ignoreConflicts requires a target for ${tableName(table)}`);
      }
      const insertedRows = await statement
        .onConflictDoNothing({ target: options.conflictTarget as never })
        .returning();
      return insertedRows.length;
    }
    if (options.conflictTarget === undefined) {
      await statement;
      return 1;
    }
    await statement.onConflictDoUpdate({
      target: options.conflictTarget as never,
      set: buildUpsertSet(values) as never,
    });
    return 1;
  };

  // Bulk chunk size: keeps each statement's parameter count comfortably under
  // Postgres's 65535 limit even for the widest table. 500 rows × ~60 columns
  // leaves plenty of headroom; a narrower table just means a faster chunk.
  const BULK_CHUNK = 500;

  // Attempts one chunk in a single statement. Returns the inserted count on
  // success, or `null` to signal "fall back to per-row for this chunk". The
  // chunk is wrapped in a savepoint so a bulk failure can be rolled back
  // *inside* the outer restore transaction — without this, Postgres marks the
  // outer transaction as aborted on the first error and the per-row diagnostic
  // fallback would itself fail with "current transaction is aborted".
  const insertChunk = async (
    chunk: readonly Record<string, unknown>[],
  ): Promise<{ count: number } | { error: unknown }> => {
    try {
      // `tx.transaction(...)` nests as a `SAVEPOINT ... ROLLBACK TO SAVEPOINT`
      // on both Postgres and SQLite drivers Drizzle supports here, which is
      // exactly what the fallback needs: on failure the outer transaction
      // stays writable and the per-row path can isolate the offending row.
      const count = await tx.transaction(async (innerTx) => {
        // Drizzle types the nested transaction callback with the dialect's
        // own transaction handle; normalize once via the shared helper.
        const inner = asConsoleDb(innerTx);
        const statement = inner.insert(table).values(chunk as never);
        if (options.ignoreConflicts) {
          if (options.conflictTarget === undefined) {
            throw new Error(`ignoreConflicts requires a target for ${tableName(table)}`);
          }
          const insertedRows = await statement
            .onConflictDoNothing({ target: options.conflictTarget as never })
            .returning();
          return insertedRows.length;
        }
        if (options.conflictTarget === undefined) {
          await statement;
          return chunk.length;
        }
        // For a bulk upsert `excluded.*` references the row the driver tried
        // to insert, so each column mapping is the same regardless of which
        // row in the chunk conflicts. Build the set clause from the first
        // row's keys — every prepared row for one table carries the same key
        // set because `toValues` is deterministic for a given schema.
        const firstRow = chunk[0];
        if (firstRow === undefined) return 0;
        await statement.onConflictDoUpdate({
          target: options.conflictTarget as never,
          set: buildUpsertSet(firstRow) as never,
        });
        return chunk.length;
      });
      return { count };
    } catch (error) {
      // Signal "re-run row by row": a bulk failure must not swallow the
      // specific row's error, because the per-row path is what names the
      // offending row to the operator. Keep the bulk error too: when the
      // per-row fallback also fails (connection drop, aborted transaction,
      // oversized statement), the derived row error would otherwise hide the
      // real cause from the operator.
      return { error };
    }
  };

  let inserted = 0;
  // Group adjacent rows that share the same column key set. Different rows in
  // one table can carry different keys (an optional column omitted when the
  // payload cell is absent; `parent_key_id` present on child api_keys but not
  // parents), and Drizzle's bulk `.values([...])` compiles one SQL statement
  // with a column list taken from the first row — so a bulk of mixed shapes
  // produces malformed SQL. Grouping by signature keeps each bulk statement
  // uniform while preserving row order within the group.
  //
  // Signature is a stable `|`-joined list of sorted keys; empty columns were
  // already dropped by the `toValues` → `Object.keys(values).length === 0`
  // check above, so empty signatures never occur here.
  const signatureOf = (values: Record<string, unknown>): string =>
    Object.keys(values).sort().join("|");
  let groupStart = 0;
  while (groupStart < prepared.length) {
    const groupSignature = signatureOf(prepared[groupStart]!);
    let groupEnd = groupStart + 1;
    while (
      groupEnd < prepared.length &&
      signatureOf(prepared[groupEnd]!) === groupSignature &&
      groupEnd - groupStart < BULK_CHUNK
    ) {
      groupEnd += 1;
    }
    const chunk = prepared.slice(groupStart, groupEnd);
    const bulk = await insertChunk(chunk);
    if ("count" in bulk) {
      inserted += bulk.count;
    } else {
      // Diagnostic fallback: let the single statement that actually errors
      // reach the caller with the row that caused it. If the fallback itself
      // fails, the row-level error is derived — chain the original bulk error
      // so a connection-level fault is not reported as a bad row.
      try {
        for (const values of chunk) {
          inserted += await insertOne(values);
        }
      } catch (perRowError) {
        const bulkMessage = bulk.error instanceof Error ? bulk.error.message : String(bulk.error);
        throw new Error(
          `bulk insert into ${tableName(table)} failed (${bulkMessage}); per-row diagnostic also failed`,
          { cause: perRowError },
        );
      }
    }
    groupStart = groupEnd;
  }
  return inserted;
}

/**
 * Nulls the 11 nullable policy columns on share children owned by `tenantId`.
 *
 * Auth resolves policy from the parent (`policy = parent ?? row`), so child
 * copies of notes/limits/model_list/denylist are pure bloat. Migration 0029
 * clears them once at boot; restore does not re-run numbered migrations, so
 * an old backup that still carries populated children would reintroduce the
 * bloat unless this runs inside the same restore transaction. Keep the SET
 * list identical to migration 0029
 * (`0029_null_share_child_policy_columns.sql` in both backends) and the write
 * path in `issueSharedApiKey` (which no longer copies them).
 */
export async function normalizeShareChildPolicy(
  db: CartethyiaDatabase,
  tenantId: string,
): Promise<void> {
  // Template policy columns are nulled on every child so auth reads the full
  // policy from the parent (`policy = parent ?? row`). The exception is a
  // `per_key` concurrency child: it carries its own cap (copied at issue) and
  // its own admission identity, so `concurrency_scope` and
  // `max_concurrent_requests` are preserved for those rows.
  const policyNulls = {
    notesTitle: null,
    notesSubtitle: null,
    notesBody: null,
    requestsPerMinute: null,
    dailyTokenLimit: null,
    monthlyTokenLimit: null,
    lifetimeTokenBudget: null,
    modelPrefix: null,
    modelList: null,
    clientRouterDenylist: null,
  };
  await db
    .update(apiKeys)
    .set({
      ...policyNulls,
      maxConcurrentRequests: null,
    })
    .where(
      and(
        eq(apiKeys.tenantId, tenantId),
        isNotNull(apiKeys.parentKeyId),
        sql`${apiKeys.concurrencyScope} <> 'per_key'`,
      ),
    );
  await db
    .update(apiKeys)
    .set(policyNulls)
    .where(
      and(
        eq(apiKeys.tenantId, tenantId),
        isNotNull(apiKeys.parentKeyId),
        eq(apiKeys.concurrencyScope, "per_key"),
      ),
    );
}

/**
 * Applies a pre-validated restore inside one transaction.
 *
 * `order` is children-before-parents for the config tables. The tenant row is
 * upserted first and never deleted — every tenant-scoped table cascades from
 * `tenants`, including `telemetry_events`, `telemetry_usage_totals`,
 * `console_users`, and `console_sessions`, so replacing it would destroy the
 * usage history this feature preserves and log out every console user.
 *
 * Every write is scoped to `tenantId`. A table the payload does not mention is
 * left completely alone — not cleared — so a partial import (a router export
 * carries accounts but no built-in provider rows) cannot empty the tables it
 * happens to omit. The rule is "replace what the file describes", and even then
 * only the rows this tenant owns.
 */
export async function applyRestore(
  db: CartethyiaDatabase,
  validation: ValidatedRestore,
  order: readonly Table[],
  tenantId: string,
): Promise<{ restored: Record<string, number>; skipped: Record<string, number> }> {
  const restored: Record<string, number> = {};
  const skipped: Record<string, number> = {};

  await db.transaction(async (tx) => {
    const scoped = asConsoleDb(tx);

    // The tenant row is ensured, never replaced: it almost always exists, and
    // its PK is `id`, so a conflict means "already there" rather than an error.
    // The payload's tenant is forced to the restoring tenant — a payload naming
    // someone else's tenant id must not create or claim that tenant.
    //
    // Current exports deliberately omit the `tenants` section, so
    // `tenantRows` is normally empty. Child rows still carry
    // `tenant_id = tenantId`, which means a restore into a tenant that does
    // not exist yet would fail the `api_keys` (and other) foreign keys unless
    // we ensure the receiving tenant here. The minimal placeholder row is
    // written only for a tenant that did not already exist; on conflict it is
    // a no-op and the existing tenant's name/status are left untouched.
    if (validation.tenantRows.length > 0) {
      let inserted = 0;
      for (const row of validation.tenantRows) {
        const values = toValues(TENANT_TABLE, row);
        if (Object.keys(values).length === 0) continue;
        const result = await insertRow(scoped, TENANT_TABLE, { ...values, id: tenantId })
          .onConflictDoNothing()
          .returning({ id: sql<number>`1` });
        inserted += result.length;
      }
      restored["tenants"] = inserted;
    } else {
      const result = await insertRow(scoped, TENANT_TABLE, {
        id: tenantId,
        name: "restored",
        status: "active",
      })
        .onConflictDoNothing()
        .returning({ id: sql<number>`1` });
      restored["tenants"] = result.length;
    }

    const replaceTables = order.filter(
      (table) => validation.tables.get(table)?.mode === "replace" && table !== TENANT_TABLE,
    );
    const appendTables = order.filter(
      (table) => validation.tables.get(table)?.mode === "append",
    );

    // An empty array describes nothing, so there is nothing to replace. Clearing
    // a table because the payload mentions it with zero rows is how a restore
    // deletes data the file never spoke about: a config-only file that carries
    // `provider_accounts: []` — a router export with no connections, an export
    // taken before any account existed — would empty the tenant's accounts. The
    // file's silence is not an instruction to delete. A non-empty array still
    // replaces the tenant's rows, which is what "restore my configuration" means.
    for (const table of replaceTables) {
      const entry = validation.tables.get(table);
      if (entry === undefined || entry.rows.length === 0) continue;
      if (replaceModeOf(table) === "delete") await clearOwnedRows(scoped, table, tenantId);
    }

    // Insert parents before children.
    for (const table of [...replaceTables].reverse()) {
      const entry = validation.tables.get(table);
      if (entry === undefined) continue;
      const ownership = ownershipOf(table);
      const rows =
        table === apiKeys
          ? [...entry.rows].sort((left, right) => {
              const leftParent = left["parent_key_id"];
              const rightParent = right["parent_key_id"];
              const leftIsChild = leftParent !== null && leftParent !== undefined;
              const rightIsChild = rightParent !== null && rightParent !== undefined;
              return Number(leftIsChild) - Number(rightIsChild);
            })
          : entry.rows;
      restored[tableName(table)] = await insertRows(scoped, table, rows, {
        ...(ownership.kind === "authored" ? { conflictTarget: ownership.keyColumns } : {}),
        tenantId,
      });
    }

    // Event rows use a natural idempotency key; lifetime totals insert once per
    // identity so re-importing an older backup cannot reduce newer counters.
    for (const table of appendTables) {
      const entry = validation.tables.get(table);
      if (entry === undefined) continue;
      if (table === telemetryEvents) {
        // The payload rows are remapped to the restoring tenant before the
        // idempotency filter runs, so the dedupe keys and the appended file
        // rows are owned by the receiving tenant, not the backup's tenant.
        const remapped = entry.rows.map((row) => ({ ...row, tenant_id: tenantId }));
        const existing = await existingEventFileKeys(db, tenantId, entry.rows);
        const fresh = remapped.filter((row) => !existing.has(telemetryKey(row)));
        await appendRestoredEvents(fresh);
        restored[tableName(table)] = fresh.length;
        skipped[tableName(table)] = entry.rows.length - fresh.length;
      } else if (table === telemetryUsageTotals) {
        const restoredCount = await insertRows(scoped, table, entry.rows, {
          conflictTarget: [
            telemetryUsageTotals.tenantId,
            telemetryUsageTotals.identityType,
            telemetryUsageTotals.entityId,
          ],
          ignoreConflicts: true,
          tenantId,
        });
        restored[tableName(table)] = restoredCount;
        skipped[tableName(table)] = entry.rows.length - restoredCount;
      } else {
        restored[tableName(table)] = await insertRows(scoped, table, entry.rows, { tenantId });
      }
    }

    // Restore writes api_keys rows verbatim and does not re-run migration
    // 0029. An old backup can therefore reintroduce populated child policy
    // columns; re-apply the null-out for this tenant before committing.
    if (replaceTables.includes(apiKeys)) {
      await normalizeShareChildPolicy(scoped, tenantId);
    }
  });

  return { restored, skipped };
}

export const DELETE_ALL_SCOPES = ["providers", "proxies", "configuration"] as const;
export type DeleteAllScope = (typeof DELETE_ALL_SCOPES)[number];

export interface DeleteAllResult {
  readonly deleted: Record<string, number>;
  readonly apiKeyIds: readonly string[];
}

/**
 * Deletes selected tenant configuration scopes in one transaction. The lists
 * are explicit and ordered child-first; no table-wide delete is permitted.
 */
export async function deleteAll(
  db: CartethyiaDatabase,
  scopes: readonly DeleteAllScope[],
  tenantId: string,
): Promise<DeleteAllResult> {
  const selected = new Set(scopes);
  if (selected.size === 0) throw new Error("at least one delete scope is required");
  for (const scope of selected) {
    if (scope !== "providers" && scope !== "proxies" && scope !== "configuration") {
      throw new Error(`unknown delete scope ${scope}`);
    }
  }
  const all = selected.has("configuration");
  // `configuration` is the destructive superset: it includes provider and proxy
  // routing because those are configuration, not runtime history.
  const providersSelected = all || selected.has("providers");
  const proxiesSelected = all || selected.has("proxies");
  const deleted: Record<string, number> = {};
  const apiKeyIds: string[] = [];

  await db.transaction(async (tx) => {
    const scoped = asConsoleDb(tx);
    const remove = async (table: Table, filter: SQL, name = tableName(table)): Promise<void> => {
      const rows = await scoped.delete(table).where(filter).returning();
      if (rows.length > 0) deleted[name] = (deleted[name] ?? 0) + rows.length;
    };
    const direct = (table: Table): SQL => ownedByFilter(table, tenantId);

    if (proxiesSelected) {
      await remove(healthEvents, sql`${healthEvents.networkPoolId} in (select ${networkPools.id} from ${networkPools} where ${networkPools.tenantId} = ${tenantId})`);
      await remove(networkPools, direct(networkPools));
      await remove(poolRoutingSettings, direct(poolRoutingSettings));
    }

    if (providersSelected) {
      await remove(healthEvents, sql`${healthEvents.accountId} in (select ${providerAccounts.id} from ${providerAccounts} where ${providerAccounts.tenantId} = ${tenantId})`);
      await remove(providerOauthStates, sql`${providerOauthStates.providerAccountId} in (select ${providerAccounts.id} from ${providerAccounts} where ${providerAccounts.tenantId} = ${tenantId})`);
      await remove(providerAccounts, direct(providerAccounts));
      await remove(tenantDisabledModels, direct(tenantDisabledModels));
      await remove(models, sql`${models.providerId} in (select ${providers.id} from ${providers} where ${providers.tenantId} = ${tenantId})`);
      await remove(providerRoutingSettings, direct(providerRoutingSettings));
      await remove(providers, direct(providers));
    }

    if (all || selected.has("configuration")) {
      await remove(cliToolMappings, direct(cliToolMappings));
      await remove(cliToolSettings, direct(cliToolSettings));
      await remove(sharePopups, sql`${sharePopups.apiKeyId} in (select ${apiKeys.id} from ${apiKeys} where ${apiKeys.tenantId} = ${tenantId})`);
      await remove(shareLinks, sql`${shareLinks.apiKeyId} in (select ${apiKeys.id} from ${apiKeys} where ${apiKeys.tenantId} = ${tenantId})`);
      const keys = await scoped.delete(apiKeys).where(direct(apiKeys)).returning({ id: apiKeys.id });
      if (keys.length > 0) {
        apiKeyIds.push(...keys.map((row) => row.id));
        deleted["api_keys"] = (deleted["api_keys"] ?? 0) + keys.length;
      }
      await remove(modelAliases, direct(modelAliases));
      await remove(modelCombos, direct(modelCombos));
      await remove(consoleUsers, direct(consoleUsers));
      await remove(consoleSettings, direct(consoleSettings));
    }
  });

  return { deleted, apiKeyIds };
}
