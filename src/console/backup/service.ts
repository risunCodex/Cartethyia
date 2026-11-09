/**
 * Backup and restore operations, plus the import path for a router export.
 *
 * Two things every entry point here has in common:
 *
 * 1. **Nothing is written before the whole payload validates.** Validation
 *    resolves every table and column against the live schema, so a stale or
 *    hostile file fails with the offending name and the database is untouched.
 * 2. **Everything happens in one transaction** (see `store.applyRestore`), so a
 *    mid-restore SQL error rolls back rather than leaving half a
 *    configuration — which is the state that makes an operator's day worse than
 *    a plain failure would.
 *
 * Export is a JSON object at the operator's explicit request, and it carries
 * provider credentials and API keys decrypted — the only form in which they can
 * be restored into an install with a different encryption key (see
 * {@link sealedColumns}). So the file is as sensitive as the database: the layer
 * doc and the dashboard copy say so, and export requires password
 * re-authentication.
 */
import type { CartethyiaDatabase } from "../../persistence/db-handle";
import type { Table } from "drizzle-orm";
import {
  models,
  providerAccounts,
  providerOauthStates,
  providerRoutingSettings,
  providers,
  tenantDisabledModels,
} from "../../persistence/schema";
import { ConsoleDomainError } from "../shared/errors";
import { tablesForSection, tableName } from "./contracts";
import type {
  BackupSection,
  RestoreWarning,
  ValidatedRestore,
  ValidatedTable,
} from "./contracts";
import {
  applyRestore,
  decompressBackup,
  deleteAll,
  exportBackupStream,
  type BackupExportStream,
  type DeleteAllResult,
  type DeleteAllScope,
} from "./store";
import { detectFormat, restoreOrder, validateRestorePayload } from "./validate";
import { convert9RouterBackup, type ImportReport } from "./nine-router";
import { isRecord } from "../../protocol/codecs";

interface BackupServiceOptions {
  readonly db: CartethyiaDatabase;
  /** Verifies the signed-in operator's console password; supplied by the router. */
  readonly verifyPassword: (password: string) => Promise<boolean>;
}

interface ExportOptions {
  readonly sections?: readonly BackupSection[];
  readonly password: string;
  /** The tenant whose rows are exported. Never another tenant's. */
  readonly tenantId: string;
  /** Gzips the file. Changes nothing about what the payload carries. */
  readonly compressed?: boolean;
}

/** One table as it appears in a backup file, and whether it can be restored. */
interface BackupInspectionRow {
  readonly section: string;
  readonly table: string;
  readonly count: number;
  /** False when the current schema has no such table: restore will skip it. */
  readonly supported: boolean;
}

/**
 * A backup's cover, read without writing.
 *
 * `warnings` carries what a real restore would leave out, so the operator sees
 * the loss before committing rather than after.
 */
export interface BackupInspection {
  readonly format: "native" | "nine_router";
  readonly version: number;
  readonly exportedAt: string;
  readonly rows: readonly BackupInspectionRow[];
  readonly total: number;
  readonly warnings: readonly RestoreWarning[];
}

export interface ImportResult {
  readonly restored: Record<string, number>;
  readonly skipped: Record<string, number>;
  /** Parts of the file that could not be restored. Empty means it all applied. */
  readonly warnings: readonly RestoreWarning[];
  readonly report?: ImportReport;
  readonly format: "native" | "nine_router";
}

/**
 * Which parts of a backup file a restore should actually write.
 *
 * Absent or empty means "everything", which is the historical behavior and
 * what the dashboard's checklist defaults to. A table named here but absent
 * from the file is simply not restored — it is not an error, because the
 * checklist is built from an inspection of *this* file and a selection never
 * invents a table.
 */
interface BackupRestoreSelection {
  /** Table names to restore; absent or empty restores every table present. */
  readonly tables?: readonly string[];
}

/**
 * Narrows a validated backup to the tables the operator selected.
 *
 * The tenant row is the one thing that is not independently selectable: it is
 * not a table in either section (`BACKUP_SECTIONS` are config and telemetry),
 * so it never appears on the checklist, and every tenant-scoped table
 * cascades from it. Dropping it because it was not named would make a partial
 * restore fail on a foreign key for a table the operator *did* ask for. So it
 * rides along with any config selection and is written only when one is made.
 *
 * A table named in the selection but missing from the file is a no-op rather
 * than an error: the checklist is built from an inspection of this file, but
 * the selection is validated as names only, and refusing to restore anything
 * over one stale name would be worse than ignoring it.
 */
function restrictToSelection(
  validation: ValidatedRestore,
  selection: BackupRestoreSelection | undefined,
): ValidatedRestore {
  const wanted = selection?.tables;
  if (wanted === undefined || wanted.length === 0) return validation;
  const selected = new Set(wanted);
  const tables = new Map<Table, ValidatedTable>();
  for (const [table, entry] of validation.tables) {
    if (selected.has(tableName(table))) tables.set(table, entry);
  }
  return {
    ...validation,
    tables,
    tenantRows: tables.size > 0 ? validation.tenantRows : [],
  };
}

function sectionsOrDefault(sections: readonly BackupSection[] | undefined): readonly BackupSection[] {
  if (sections === undefined || sections.length === 0) return ["config"];
  for (const section of sections) {
    if (section !== "config" && section !== "telemetry") {
      throw new ConsoleDomainError("invalid_request", 400, `unknown backup section "${String(section)}"`);
    }
  }
  return sections;
}

/** The bytes of an uploaded backup file, as carried by a string. */
function toBackupBytes(input: string): Uint8Array {
  // Base64 is the only way file bytes travel inside a JSON body. A string that
  // already is JSON is taken as the file's text; anything else is the encoded
  // file, and a malformed payload still fails at `JSON.parse` rather than here.
  if (input.trimStart().startsWith("{")) return Buffer.from(input, "utf8");
  return Buffer.from(input, "base64");
}

/**
 * Accepts a backup in any form the operator can hand it over, and parses it.
 *
 * The export offers a compressed download and names it `.json.gz`, so the file
 * on the operator's disk is gzip bytes. The restore path used to read its body
 * as JSON text, which meant their own backup was the one file it could not
 * import. The shapes handled here are the ways a file actually arrives: a JSON
 * object (the dashboard decodes the file in the browser), the export's own
 * `{ bytes }` envelope, the file's text, and its bytes — base64-encoded for a
 * JSON body, or raw.
 *
 * Whether it is compressed is decided by the bytes' magic, never by the
 * filename: a `.json` that is really gzip is restored, and a `.gz` that is not
 * is too.
 */
function normalizeBackupInput(input: unknown): unknown {
  if (input === null || input === undefined) return input;
  if (input instanceof Uint8Array) return parseBackupText(decompressBackup(input));
  if (input instanceof ArrayBuffer) return parseBackupText(decompressBackup(new Uint8Array(input)));
  if (typeof input === "string") return parseBackupText(decompressBackup(toBackupBytes(input)));
  // The export's own envelope, handed straight back.
  if (isRecord(input) && typeof input["bytes"] === "string" && Object.keys(input).length <= 3) {
    return parseBackupText(decompressBackup(toBackupBytes(input["bytes"])));
  }
  return input;
}

function parseBackupText(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ConsoleDomainError("invalid_request", 400, "that file is not a JSON backup");
  }
}

async function omitRowsForUnavailableProviders(
  db: CartethyiaDatabase,
  validation: ValidatedRestore,
  tenantId: string,
): Promise<ValidatedRestore> {
  const existingProviders = await db
    .select({ id: providers.id, tenantId: providers.tenantId })
    .from(providers);
  const importedProviders = validation.tables.get(providers)?.rows ?? [];
  const providerIds = new Set([
    ...existingProviders
      .filter((provider) => provider.tenantId === null || provider.tenantId === tenantId)
      .map((provider) => provider.id),
    ...importedProviders.map((provider) => String(provider["id"])),
  ]);
  const tables = new Map(validation.tables);
  const warnings = [...validation.warnings];
  const counts = { ...validation.counts };

  for (const table of [providerAccounts, models, tenantDisabledModels, providerRoutingSettings]) {
    const entry = tables.get(table);
    if (entry === undefined) continue;
    const rows = entry.rows.filter(
      (row) => typeof row["provider_id"] === "string" && providerIds.has(row["provider_id"]),
    );
    if (rows.length === entry.rows.length) continue;
    tables.set(table, { ...entry, rows });
    counts[tableName(table)] = rows.length;
    warnings.push({
      table: tableName(table),
      column: "provider_id",
      reason: "referenced a provider not available in this installation; those rows were skipped",
    });
  }

  const accountRows = tables.get(providerAccounts)?.rows ?? [];
  const replacesTenantAccounts = accountRows.length > 0;
  const existingAccounts = await db
    .select({ id: providerAccounts.id, tenantId: providerAccounts.tenantId })
    .from(providerAccounts);
  const accountIds = new Set(
    existingAccounts
      .filter((account) => !replacesTenantAccounts || account.tenantId !== tenantId)
      .map((account) => account.id),
  );
  for (const account of accountRows) {
    if (typeof account["id"] === "string") accountIds.add(account["id"]);
  }

  const oauthEntry = tables.get(providerOauthStates);
  if (oauthEntry !== undefined) {
    const rows = oauthEntry.rows.filter(
      (row) =>
        typeof row["provider_account_id"] === "string" && accountIds.has(row["provider_account_id"]),
    );
    if (rows.length !== oauthEntry.rows.length) {
      tables.set(providerOauthStates, { ...oauthEntry, rows });
      counts[tableName(providerOauthStates)] = rows.length;
      warnings.push({
        table: tableName(providerOauthStates),
        column: "provider_account_id",
        reason: "referenced an account not restored or available in this installation; those rows were skipped",
      });
    }
  }

  return { ...validation, tables, counts, warnings };
}

export class BackupService {
  constructor(private readonly options: BackupServiceOptions) {}

  async export(options: ExportOptions): Promise<BackupExportStream> {
    if (!(await this.options.verifyPassword(options.password))) {
      throw new ConsoleDomainError("unauthorized", 401, "password is incorrect");
    }
    const sections = sectionsOrDefault(options.sections);
    return exportBackupStream(
      this.options.db,
      sections.flatMap((section) => tablesForSection(section)),
      options.tenantId,
    );
  }

  /**
   * Restores a payload, detecting its format first.
   *
   * A native payload is validated as-is. A router export is converted first —
   * and conversion is itself validation, because it refuses provider ids it
   * cannot map rather than guessing — then the converted payload goes through
   * the identical validation and transaction as a native one. There is one
   * write path, not two.
   *
   * `tenantId` is the restoring tenant, and it is the *only* tenant any write
   * can reach: the payload cannot name a different one, because every table is
   * filtered by ownership and the tenant row is forced to this id.
   */
  async restore(
    password: unknown,
    payload: unknown,
    tenantId: string,
    selection?: BackupRestoreSelection,
  ): Promise<ImportResult> {
    if (typeof password !== "string" || !(await this.options.verifyPassword(password))) {
      throw new ConsoleDomainError("unauthorized", 401, "password is incorrect");
    }

    const detected = detectFormat(normalizeBackupInput(payload));
    if (detected.kind === "unknown") {
      throw new ConsoleDomainError("invalid_request", 400, detected.reason);
    }

    if (detected.kind === "nine_router") {
      // Provider-specific import helpers stay lazy: pulling an OAuth client graph
      // into the console boot graph would make every console route pay for it.
      const { bindImportedGithubCredential } = await import(
        "../../providers/integrations/github/github-oauth"
      );
      const { payload: converted, report } = convert9RouterBackup(detected.payload, tenantId, {
        github: bindImportedGithubCredential,
      });
      const result = await this.apply(converted, tenantId, selection);
      return { ...result, report, format: "nine_router" };
    }

    const result = await this.apply(detected.payload, tenantId, selection);
    return { ...result, format: "native" };
  }

  /**
   * Restores a native backup onto a brand-new tenant during first boot.
   *
   * There is no operator to re-authenticate, and no tenant to scope the write
   * to. The caller has already proven that no console user exists and holds
   * the setup lock.
   *
   * The configuration is restored; the sign-in accounts are not, because a
   * backup does not carry them (see {@link CONFIG_TABLES}). The caller creates
   * the administrator for the install it just recovered into.
   */
  async restoreFirstBoot(payload: unknown, tenantId: string): Promise<ImportResult> {
    const detected = detectFormat(normalizeBackupInput(payload));
    if (detected.kind !== "native") {
      throw new ConsoleDomainError(
        "invalid_request",
        400,
        detected.kind === "unknown" ? detected.reason : "first-boot restore accepts a Cartethyia backup only",
      );
    }
    const result = await this.apply(detected.payload, tenantId);
    return { ...result, format: "native" };
  }

  /**
   * Describes a backup without writing any of it.
   *
   * The dashboard's restore wizard peeks at a file before committing to it, and
   * "which of these tables does the current build actually have" is a question
   * only the live schema can answer — a hand-maintained list of table names in
   * the browser would drift the moment a migration landed. So the answer comes
   * from the same validation a restore runs, and writes nothing.
   */
  inspect(payload: unknown): BackupInspection {
    const detected = detectFormat(normalizeBackupInput(payload));
    if (detected.kind === "unknown") {
      throw new ConsoleDomainError("invalid_request", 400, detected.reason);
    }
    const candidate = detected.kind === "native" ? detected.payload : null;
    if (candidate === null) {
      // A router export has no sections to list; it is converted at restore
      // time, so all that can be said here is what it is.
      return {
        format: "nine_router",
        version: 0,
        exportedAt: "",
        rows: [],
        total: 0,
        warnings: [],
      };
    }
    const validation = validateRestorePayload(candidate, "");
    const warnings = validation.ok ? validation.value.warnings : [];
    const supported = new Set(validation.ok ? [...validation.value.tables.keys()].map(tableName) : []);
    // `tenants` is diverted to `validation.value.tenantRows` during validate —
    // not included in `tables` — so it would show as "unsupported" in the
    // preview for any backup that carries it. Mark it supported explicitly.
    if (validation.ok) supported.add("tenants");

    const rows: BackupInspectionRow[] = [];
    let total = 0;
    const sections = isRecord(candidate.sections) ? candidate.sections : {};
    for (const [section, value] of Object.entries(sections)) {
      if (!isRecord(value)) continue;
      for (const [table, list] of Object.entries(value)) {
        if (!Array.isArray(list)) continue;
        rows.push({ section, table, count: list.length, supported: supported.has(table) });
        total += list.length;
      }
    }
    rows.sort((left, right) => right.count - left.count || left.table.localeCompare(right.table));

    return {
      format: "native",
      version: typeof candidate.version === "number" ? candidate.version : 0,
      exportedAt: typeof candidate.exportedAt === "string" ? candidate.exportedAt : "",
      rows,
      total,
      warnings,
    };
  }

  /** Validates and applies a native payload. Shared by both formats. */
  private async apply(
    payload: unknown,
    tenantId: string,
    selection?: BackupRestoreSelection,
  ): Promise<{ restored: Record<string, number>; skipped: Record<string, number>; warnings: readonly RestoreWarning[] }> {
    const validation = validateRestorePayload(payload, tenantId);
    if (!validation.ok) {
      throw new ConsoleDomainError("invalid_request", 400, validation.error);
    }
    try {
      const scoped = restrictToSelection(validation.value, selection);
      const compatible = await omitRowsForUnavailableProviders(this.options.db, scoped, tenantId);
      const applied = await applyRestore(this.options.db, compatible, restoreOrder(), tenantId);
      return { ...applied, warnings: compatible.warnings };
    } catch (error) {
      // The message carries table and column names only — the store never
      // interpolates a cell value — so a failed restore cannot leak credentials
      // into a log or an HTTP response.
      throw new ConsoleDomainError(
        "restore_failed",
        500,
        `restore failed and was rolled back: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    }
  }

  /** Permanently deletes selected tenant configuration after re-authentication. */
  async deleteAll(password: unknown, scopes: readonly DeleteAllScope[], tenantId: string): Promise<DeleteAllResult> {
    if (typeof password !== "string" || !(await this.options.verifyPassword(password))) {
      throw new ConsoleDomainError("unauthorized", 401, "password is incorrect");
    }
    if (scopes.length === 0) {
      throw new ConsoleDomainError("invalid_request", 400, "select at least one delete scope");
    }
    try {
      return await deleteAll(this.options.db, scopes, tenantId);
    } catch (error) {
      throw new ConsoleDomainError(
        "delete_failed",
        500,
        `delete failed and was rolled back: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    }
  }

  /** Counts a section without building its payload. */
  async preview(
    sections: readonly BackupSection[] | undefined,
    tenantId: string,
  ): Promise<Record<string, number>> {
    const stream = exportBackupStream(
      this.options.db,
      sectionsOrDefault(sections).flatMap((section) => tablesForSection(section)),
      tenantId,
    );
    // Walk the stream so the tally settles, discarding the bytes: a preview
    // must not hold the payload either.
    for await (const _chunk of stream.jsonChunks) {
      // discard
    }
    return stream.counts;
  }
}
